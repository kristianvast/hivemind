// Anvil — local execution primitives for the Anvil sub-agent.
//
// The Anvil sub-agent is the only Hivemind agent that touches the local
// filesystem, spins up a local HTTP server, and drives a real headless
// browser. It runs ONLY in `--local` mode (e.g. `ntn workers exec
// runOrchestrator --local`) — the deployed Worker runtime has no
// filesystem / no Playwright / no localhost.
//
// Design:
//   * Per-brief session: every Anvil delegation gets its own AnvilSession
//     keyed by briefId. Sessions own a temp dir + an http.Server +
//     a Playwright BrowserContext. They survive past the agent's `done`
//     call so the user can visit the localhost URL after the orchestrator
//     returns. The Node process keeps them open until shutdown.
//   * Sessions are tracked in a module-level Map; subsequent calls to
//     `getOrCreateAnvilSession(briefId)` reuse the existing session.
//   * Servers bind to 127.0.0.1 on auto-allocated ports (port=0 → kernel
//     picks one). The session records the chosen URL.
//   * Screenshots are written as PNG Buffers, never to disk — they go
//     straight to Notion via the two-step `file_uploads` API.

import { createServer, type Server as HttpServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { mkdir, readFile, rm, stat, writeFile as fsWriteFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";

import type { Client } from "@notionhq/client";

export interface AnvilSession {
	briefId: string;
	rootDir: string;
	server?: HttpServer;
	serverUrl?: string;
	createdAt: number;
	files: Set<string>;
}

const SESSIONS = new Map<string, AnvilSession>();

const ROOT_TMPDIR_PREFIX = "hivemind-anvil-";

function sanitizeBriefId(briefId: string): string {
	return briefId.replace(/[^a-zA-Z0-9_-]/g, "");
}

/**
 * Resolve (or lazily create) the AnvilSession for a brief. Sessions are
 * scoped per-brief so multiple briefs running concurrently in the same
 * process don't trample each other's files / servers.
 */
export async function getOrCreateAnvilSession(
	briefId: string,
): Promise<AnvilSession> {
	const existing = SESSIONS.get(briefId);
	if (existing) return existing;

	const sanitized = sanitizeBriefId(briefId);
	const rootDir = join(tmpdir(), `${ROOT_TMPDIR_PREFIX}${sanitized}-${Date.now()}`);
	await mkdir(rootDir, { recursive: true });

	const session: AnvilSession = {
		briefId,
		rootDir,
		createdAt: Date.now(),
		files: new Set<string>(),
	};
	SESSIONS.set(briefId, session);
	console.log("[anvil] session created for brief", briefId, "rootDir=", rootDir);
	return session;
}

/**
 * Look up an existing session without creating one. Used by handlers
 * that need a session to already exist (e.g. anvilServe).
 */
export function getAnvilSession(briefId: string): AnvilSession | undefined {
	return SESSIONS.get(briefId);
}

/**
 * Write a file to the session's rootDir. Returns the absolute path.
 *
 * Path safety: `relPath` is resolved against `session.rootDir` and the
 * result must remain inside `rootDir`. Path-traversal attempts (`../`,
 * absolute paths) throw.
 */
export async function anvilWriteFileToSession(
	session: AnvilSession,
	relPath: string,
	content: string,
): Promise<{ absPath: string; size: number }> {
	const normalized = normalize(relPath);
	if (normalized.startsWith("..") || normalized.startsWith(sep)) {
		throw new Error(
			`anvilWriteFile: relative path "${relPath}" escapes session root`,
		);
	}
	const absPath = resolve(session.rootDir, normalized);
	if (!absPath.startsWith(session.rootDir + sep) && absPath !== session.rootDir) {
		throw new Error(
			`anvilWriteFile: resolved path "${absPath}" escapes session root "${session.rootDir}"`,
		);
	}
	const parentDir = absPath.slice(0, absPath.lastIndexOf(sep));
	if (parentDir.length > 0 && !existsSync(parentDir)) {
		await mkdir(parentDir, { recursive: true });
	}
	await fsWriteFile(absPath, content, "utf8");
	session.files.add(normalized);
	return { absPath, size: Buffer.byteLength(content, "utf8") };
}

/**
 * Start a tiny static HTTP server on 127.0.0.1, rooted at the session's
 * rootDir. Idempotent — if the session already has a server, returns the
 * existing URL.
 *
 * Server stays alive for the lifetime of the Node process so the user can
 * verify the site visually.
 */
export async function anvilStartServer(
	session: AnvilSession,
	preferredPort?: number,
): Promise<{ url: string; port: number; reused: boolean }> {
	if (session.server && session.serverUrl) {
		const addr = session.server.address() as AddressInfo | string | null;
		const port = typeof addr === "object" && addr ? addr.port : preferredPort ?? 0;
		return { url: session.serverUrl, port, reused: true };
	}

	const server = createServer((req, res) => {
		try {
			const url = req.url ?? "/";
			const pathname = url.split("?")[0] ?? "/";
			let relPath = decodeURIComponent(pathname).replace(/^\/+/, "");
			if (relPath === "" || relPath.endsWith("/")) {
				relPath = (relPath + "index.html").replace(/^\/+/, "");
			}
			const normalized = normalize(relPath);
			if (normalized.startsWith("..") || normalized.startsWith(sep)) {
				res.statusCode = 403;
				res.end("Forbidden");
				return;
			}
			const filePath = resolve(session.rootDir, normalized);
			if (
				!filePath.startsWith(session.rootDir + sep) &&
				filePath !== session.rootDir
			) {
				res.statusCode = 403;
				res.end("Forbidden");
				return;
			}
			stat(filePath)
				.then(async (s) => {
					if (s.isDirectory()) {
						const indexPath = join(filePath, "index.html");
						const buf = await readFile(indexPath);
						res.statusCode = 200;
						res.setHeader("Content-Type", "text/html; charset=utf-8");
						res.end(buf);
						return;
					}
					const buf = await readFile(filePath);
					res.statusCode = 200;
					res.setHeader("Content-Type", contentTypeFor(filePath));
					res.end(buf);
				})
				.catch(() => {
					res.statusCode = 404;
					res.setHeader("Content-Type", "text/plain; charset=utf-8");
					res.end(`Not Found: ${relPath}`);
				});
		} catch (err) {
			res.statusCode = 500;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end(`Server error: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	const port = await new Promise<number>((resolveFn, rejectFn) => {
		server.once("error", rejectFn);
		server.listen(preferredPort ?? 0, "127.0.0.1", () => {
			const addr = server.address() as AddressInfo | string | null;
			if (typeof addr === "object" && addr) {
				resolveFn(addr.port);
			} else {
				rejectFn(new Error("anvilStartServer: failed to resolve listening port"));
			}
		});
	});

	session.server = server;
	session.serverUrl = `http://localhost:${port}`;
	console.log(
		"[anvil] server started for",
		session.briefId,
		"→",
		session.serverUrl,
		"(server stays alive until process exits — Ctrl+C when done verifying)",
	);
	return { url: session.serverUrl, port, reused: false };
}

function contentTypeFor(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	switch (ext) {
		case ".html":
		case ".htm":
			return "text/html; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".js":
		case ".mjs":
			return "application/javascript; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".ico":
			return "image/x-icon";
		case ".txt":
		case ".md":
			return "text/plain; charset=utf-8";
		default:
			return "application/octet-stream";
	}
}

export interface ScreenshotOptions {
	fullPage?: boolean;
	width?: number;
	height?: number;
	waitUntil?: "load" | "domcontentloaded" | "networkidle";
	timeoutMs?: number;
}

/**
 * Launch a headless Chromium, navigate to `url`, screenshot to PNG Buffer,
 * close the browser. One-shot — no persistent browser.
 */
export async function anvilScreenshotUrl(
	url: string,
	opts: ScreenshotOptions = {},
): Promise<{ buffer: Buffer; width: number; height: number }> {
	// Dynamic import so the type-checker doesn't blow up if Playwright is
	// somehow missing at build time (it's a runtime dep for Anvil). The
	// actual install lives in package.json `dependencies`.
	const { chromium } = await import("playwright");
	const width = opts.width ?? 1280;
	const height = opts.height ?? 800;
	const browser = await chromium.launch({
		headless: true,
		args: ["--no-sandbox", "--disable-setuid-sandbox"],
	});
	try {
		const ctx = await browser.newContext({ viewport: { width, height } });
		const page = await ctx.newPage();
		await page.goto(url, {
			waitUntil: opts.waitUntil ?? "networkidle",
			timeout: opts.timeoutMs ?? 15_000,
		});
		const buffer = await page.screenshot({
			type: "png",
			fullPage: opts.fullPage ?? false,
		});
		return { buffer: Buffer.from(buffer), width, height };
	} finally {
		await browser.close();
	}
}

/**
 * Upload a PNG buffer to Notion-hosted storage via the two-step fileUploads
 * API. Returns the file_upload_id usable in image blocks.
 */
export async function anvilUploadImageToNotion(
	notion: Client,
	buffer: Buffer,
	opts: { filename?: string; contentType?: string } = {},
): Promise<string> {
	const filename = opts.filename ?? "anvil-screenshot.png";
	const contentType = opts.contentType ?? "image/png";

	// Step 1: create the upload slot.
	const upload = (await (
		notion.fileUploads.create as unknown as (a: unknown) => Promise<{ id: string }>
	)({
		mode: "single_part",
		filename,
		content_type: contentType,
	})) as { id: string };

	// Step 2: send the bytes. The Notion SDK accepts a Blob in
	// `file.data`. Constructing it from a Buffer requires going through
	// Uint8Array.
	const blob = new Blob([new Uint8Array(buffer)], { type: contentType });
	await (notion.fileUploads.send as unknown as (a: unknown) => Promise<unknown>)({
		file_upload_id: upload.id,
		file: { filename, data: blob },
	});

	return upload.id;
}

/**
 * Best-effort cleanup of a session. Closes the http.Server (if any) and
 * removes the rootDir. Not called automatically — sessions outlive the
 * agent on purpose. Callers can invoke this when they're sure they no
 * longer need the URL alive (e.g. on process shutdown).
 */
export async function destroyAnvilSession(briefId: string): Promise<void> {
	const session = SESSIONS.get(briefId);
	if (!session) return;
	SESSIONS.delete(briefId);
	if (session.server) {
		await new Promise<void>((resolveFn) =>
			session.server!.close(() => resolveFn()),
		);
	}
	try {
		await rm(session.rootDir, { recursive: true, force: true });
	} catch {
		// Best-effort.
	}
}

/**
 * Diagnostic dump of all live sessions in the current process.
 */
export function listAnvilSessions(): Array<{
	briefId: string;
	rootDir: string;
	serverUrl?: string;
	fileCount: number;
	ageMs: number;
}> {
	const now = Date.now();
	const out: Array<{
		briefId: string;
		rootDir: string;
		serverUrl?: string;
		fileCount: number;
		ageMs: number;
	}> = [];
	for (const session of SESSIONS.values()) {
		out.push({
			briefId: session.briefId,
			rootDir: session.rootDir,
			serverUrl: session.serverUrl,
			fileCount: session.files.size,
			ageMs: now - session.createdAt,
		});
	}
	return out;
}
