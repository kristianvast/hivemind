import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

import { appendAudit } from "./audit.js";
import {
	claimBriefBusy,
	findStaleBusyBriefs,
	loadBrief,
	releaseBrief,
} from "./brief.js";
import { getConfig } from "./config.js";
import { runForgeLocal } from "./forge-local.js";
import {
	ensureLocalToolchain,
	execInVm,
	getPublicUrl,
	killSandboxById,
	listAnvilSandboxes,
	spawnVm,
	teardownVm,
	writeFile as vmWriteFile,
} from "./vm-runtime.js";
import {
	cloneRepoForBranch,
	openPullRequest,
	parseRepoUrl,
	scaffoldNewRepo,
} from "./github.js";
import { log } from "./log.js";
import {
	consoleErrors as mcpConsoleErrors,
	failedNetworkRequests as mcpFailedNetworkRequests,
	screenshot as mcpScreenshot,
	spawnMcp,
} from "./playwright-mcp.js";
import { writeProofToNotion } from "./proof.js";
import { startPusherSubscriber } from "./pusher-subscriber.js";
import type { Brief, McpHandle, Proof, VmHandle } from "./types.js";

const WORKDIR = "/workspace";
const DEV_PORT = 3000;
const STALE_BUSY_THRESHOLD_MS = 30 * 60 * 1000;

interface BriefRecord {
	id?: string;
	title?: string;
	body?: string | null;
	status?: string | null;
	owner?: string | null;
	repoUrl?: string | null;
	prUrl?: string | null;
	projectRootPageId?: string | null;
}

interface RepoInfo {
	repoUrl: string;
	owner: string;
	repo: string;
	baseBranch: string;
	branch: string;
}

let activeBriefId: string | null = null;

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];
	switch (command) {
		case "start":
			await startDaemon();
			return;
		case "status":
			await status();
			return;
		case "nuke":
			await nuke(args.includes("--yes"));
			return;
		case "setup":
			await setup();
			return;
		case "run-local":
			await runLocal(args);
			return;
		default:
			printUsage();
			process.exitCode = 1;
	}
}

async function startDaemon(): Promise<void> {
	const config = getConfig();
	const mockMode = String(config.MOCK_MODE) === "true";
	if (!mockMode) {
		await ensureLocalToolchain();
	}
	await sweepStaleBusy(mockMode);
	const subscriber = await startPusherSubscriber(async (briefId) => {
		await dispatchBrief(briefId, { forceMock: false });
	});

	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info("[anvil] shutting down", { signal, activeBriefId });
		await subscriber.stop();
		process.exitCode = 0;
	};
	process.once("SIGINT", () => {
		void shutdown("SIGINT");
	});
	process.once("SIGTERM", () => {
		void shutdown("SIGTERM");
	});

	log.info("[anvil] ready, awaiting briefs");
	await new Promise<void>((resolve) => {
		process.once("beforeExit", () => resolve());
	});
}

async function status(): Promise<void> {
	const sandboxes = await listAnvilSandboxes({ purpose: "anvil" });
	console.log(JSON.stringify(sandboxes, null, 2));
}

async function nuke(confirmed: boolean): Promise<void> {
	if (!confirmed) {
		throw new Error("Refusing to nuke Anvil sandboxes without --yes");
	}
	const sandboxes = await listAnvilSandboxes({ purpose: "anvil" });
	let killed = 0;
	for (const sandbox of sandboxes) {
		try {
			await killSandboxById(sandbox.sandboxId);
			killed += 1;
		} catch (err) {
			log.warn("[anvil] failed to kill sandbox", {
				sandboxId: sandbox.sandboxId,
				error: errorMessage(err),
			});
		}
	}
	log.info("[anvil] nuked sandboxes", { found: sandboxes.length, killed });
}

async function setup(): Promise<void> {
	let config;
	try {
		config = getConfig();
		log.info("[setup] all required env vars are present");
	} catch (err) {
		log.warn("[setup] config incomplete; prompting for missing .env entries", {
			error: errorMessage(err),
		});
	}

	if (config?.SANDBOX_DRIVER === "lima") {
		try {
			await ensureLocalToolchain();
			log.info("[setup] lima VM bootstrap complete");
			return;
		} catch (err) {
			log.error("[setup] lima bootstrap failed", { error: errorMessage(err) });
			process.exitCode = 1;
			return;
		}
	}
	if (config) {
		return;
	}

	const envPath = path.resolve(".env");
	const existing = await readEnvFile(envPath);
	const required = [
		"ANVIL_WORKDIR_ROOT",
		"ANTHROPIC_API_KEY",
		"NOTION_API_TOKEN",
		"HIVEMIND_BRIEFS_DATABASE_ID",
		"E2B_API_KEY",
		"PUSHER_KEY",
		"PUSHER_CLUSTER",
		"PUSHER_CHANNEL",
		"GITHUB_PAT",
		"GITHUB_DEFAULT_ORG",
	];
	const missing = required.filter((key) => !existing.has(key));
	if (missing.length === 0) {
		log.info("[setup] .env already has all Anvil keys");
		return;
	}

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const additions: string[] = [];
	try {
		for (const key of missing) {
			const answer = await rl.question(`${key}: `);
			if (answer.trim().length > 0) {
				additions.push(`${key}=${answer.trim()}`);
			}
		}
	} finally {
		rl.close();
	}

	if (additions.length === 0) {
		log.warn("[setup] no values entered; .env unchanged");
		return;
	}
	await writeFile(envPath, `${await existingEnvText(envPath)}${additions.join("\n")}\n`, "utf8");
	log.info("[setup] wrote .env entries", { count: additions.length, envPath });
}

async function runLocal(args: string[]): Promise<void> {
	const briefId = args[1];
	if (!briefId || briefId.startsWith("--")) {
		throw new Error("Usage: anvil run-local <briefId> [--mock]");
	}
	await dispatchBrief(briefId, { forceMock: args.includes("--mock") });
}

async function sweepStaleBusy(mockMode: boolean): Promise<void> {
	if (mockMode) {
		log.info("[MOCK] would sweep stale Forge-Local-Busy briefs");
		return;
	}
	const stale = await findStaleBusyBriefs(STALE_BUSY_THRESHOLD_MS);
	for (const item of stale) {
		await releaseBrief(item.briefId, { status: "Triaged", owner: "" });
		await appendAudit(item.briefId, "stale_release", {
			thresholdMs: STALE_BUSY_THRESHOLD_MS,
		});
	}
	if (stale.length > 0) {
		log.info("[anvil] released stale busy briefs", { count: stale.length });
	}
}

async function dispatchBrief(
	briefId: string,
	opts: { forceMock: boolean },
): Promise<void> {
	if (activeBriefId) {
		log.warn("[anvil] busy; dispatch skipped", { activeBriefId, briefId });
		return;
	}
	activeBriefId = briefId;
	await appendAudit(briefId, "system", { event: "dispatch_start" });

	const config = getConfig();
	const mockMode = opts.forceMock || String(config.MOCK_MODE) === "true";
	let vm: VmHandle | null = null;
	let mcp: McpHandle | null = null;
	let completed = false;
	let claimed = false;

	try {
		if (mockMode) {
			await runMockDispatch(briefId);
			completed = true;
			return;
		}

		const brief = await loadBrief(briefId);
		const briefRecord = brief as Brief & BriefRecord;
		const title = briefRecord.title ?? `Brief ${briefId}`;
		const status = briefRecord.status ?? "Triaged";
		claimed = await claimBriefBusy(briefId, status);
		if (!claimed) {
			log.info("[brief] claim failed; skipping dispatch", { briefId });
			return;
		}

		vm = await spawnVm({ metadata: { purpose: "anvil", briefId } });
		const repoInfo = await prepareRepositoryInVm({
			briefId,
			brief,
			title,
			vm,
			githubOrg: config.GITHUB_DEFAULT_ORG,
			githubPat: config.GITHUB_PAT,
		});
		const publicDevUrl = getPublicUrl(vm, DEV_PORT, "https");
		const screenshotDir = path.join(config.ANVIL_WORKDIR_ROOT, "screenshots");
		await mkdir(screenshotDir, { recursive: true });
		const mcpOutputDir = path.join("/tmp", "anvil-screenshots", briefId);
		mcp = await spawnAnvilMcp(mcpOutputDir);

		const forgeOutput = await runForgeLocal({
			briefId,
			brief,
			publicDevUrl,
			ctx: {
				vm,
				mcp,
				briefId,
				workdir: WORKDIR,
				baseBranch: repoInfo.baseBranch,
				owner: repoInfo.owner,
				repo: repoInfo.repo,
				branch: repoInfo.branch,
			},
		});

		const screenshotPath = path.join(screenshotDir, `${safeFileName(briefId)}.png`);
		await mcpScreenshot(mcp.client, {
			fullPage: true,
			saveTo: screenshotPath,
		});
		const consoleErrors = await mcpConsoleErrors(mcp.client);
		const failedRequests = await mcpFailedNetworkRequests(mcp.client);
		const commitSha = await readCommitSha(vm);
		const pr = await openPullRequest({
			owner: repoInfo.owner,
			repo: repoInfo.repo,
			branch: repoInfo.branch,
			baseBranch: repoInfo.baseBranch,
			title,
			body: [
				forgeOutput.finalProof.summary,
				"",
				`Proof: ${forgeOutput.finalProof.devUrl}`,
				`Brief: ${briefId}`,
			].join("\n"),
		});
		const prUrl = pr.prUrl;
		const proof = {
			devUrl: forgeOutput.finalProof.devUrl,
			summary: forgeOutput.finalProof.summary,
			screenshotPath,
			consoleErrors,
			failedRequests,
			commitSha,
			prUrl,
			repoUrl: repoInfo.repoUrl,
			branch: repoInfo.branch,
		} as Proof;

		await writeProofToNotion({
			briefId,
			projectRootPageId: briefRecord.projectRootPageId ?? null,
			proof,
			summary: forgeOutput.finalProof.summary,
		});
		await releaseBrief(briefId, { status: "Done", owner: "Forge-Local" });
		completed = true;
	} catch (err) {
		await appendAudit(briefId, "error", { message: errorMessage(err) });
		if (!mockMode && claimed) {
			try {
				await releaseBrief(briefId, { status: "Failed", owner: "Forge-Local" });
			} catch (releaseErr) {
				log.error("[brief] failed to mark brief failed", {
					briefId,
					error: errorMessage(releaseErr),
				});
			}
		}
		throw err;
	} finally {
		if (mcp) {
			await shutdownMcp(mcp);
		}
		if (vm) {
			await teardownVm(vm);
		}
		if (completed) {
			await appendAudit(briefId, "system", { event: "dispatch_complete" });
		}
		activeBriefId = null;
	}
}

async function runMockDispatch(briefId: string): Promise<void> {
	log.info("[MOCK] would load brief", { briefId });
	log.info("[MOCK] would claim brief busy", { briefId });
	log.info("[MOCK] would spawn VM", { metadata: { purpose: "anvil", briefId } });
	log.info("[MOCK] would prepare GitHub repo and clone in VM", { briefId });
	log.info("[MOCK] would spawn Playwright MCP", { briefId });
	log.info("[MOCK] would run Forge-Local", { briefId });
	log.info("[MOCK] would capture proof, open PR, write Notion proof", { briefId });
}

async function prepareRepositoryInVm(args: {
	briefId: string;
	brief: Brief;
	title: string;
	vm: VmHandle;
	githubOrg: string | null;
	githubPat: string;
}): Promise<RepoInfo> {
	const briefRecord = args.brief as Brief & BriefRecord;
	const repoUrl = briefRecord.repoUrl;
	const branch = `hivemind/brief-${safeFileName(args.briefId)}`;
	let repoInfo: RepoInfo;
	let isNewRepo = false;

	if (!repoUrl) {
		const repoName = repoNameFromTitle(args.title, args.briefId);
		const created = await scaffoldNewRepo({
			name: repoName,
			org: args.githubOrg,
			files: { "README.md": `# ${args.title}\n` },
			commitMessage: `Initial commit for brief ${args.briefId}`,
		});
		const parsed = parseRepoUrl(created.repoUrl);
		repoInfo = {
			repoUrl: created.repoUrl,
			owner: parsed.owner,
			repo: parsed.repo,
			baseBranch: created.defaultBranch,
			branch,
		};
		isNewRepo = true;
	} else {
		const existing = await cloneRepoForBranch({ repoUrl, branchName: branch });
		const parsed = parseRepoUrl(repoUrl);
		repoInfo = {
			repoUrl,
			owner: parsed.owner,
			repo: parsed.repo,
			baseBranch: existing.baseBranch,
			branch,
		};
	}

	const authedUrl = authenticatedCloneUrl(repoInfo.repoUrl);
	await execInVm(args.vm, `rm -rf ${shellQuote(WORKDIR)} && mkdir -p ${shellQuote(WORKDIR)}`, {
		envs: { GITHUB_PAT: args.githubPat },
	});
	await execInVm(
		args.vm,
		`git clone --branch ${shellQuote(repoInfo.baseBranch)} "${authedUrl}" ${shellQuote(WORKDIR)} && cd ${shellQuote(WORKDIR)} && git checkout -B ${shellQuote(repoInfo.branch)}`,
		{ envs: { GITHUB_PAT: args.githubPat } },
	);

	if (isNewRepo) {
		await writeMinimalExpressScaffold(args.vm, args.title);
		await execInVm(args.vm, "npm install", { cwd: WORKDIR });
		await startDevServer(args.vm);
	}

	return repoInfo;
}

function repoNameFromTitle(title: string, briefId: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	const suffix = briefId.replace(/-/g, "").slice(0, 8);
	return slug.length > 0 ? `${slug}-${suffix}` : `anvil-brief-${suffix}`;
}

async function writeMinimalExpressScaffold(
	vm: VmHandle,
	title: string,
): Promise<void> {
	await execInVm(vm, "mkdir -p public", { cwd: WORKDIR });
	await vmWriteFile(
		vm,
		`${WORKDIR}/package.json`,
		JSON.stringify(
			{
				scripts: { start: "node server.js" },
				dependencies: { express: "^4.18.3" },
				devDependencies: {},
			},
			null,
			2,
		),
	);
	await vmWriteFile(
		vm,
		`${WORKDIR}/server.js`,
		[
			"const express = require('express');",
			"const app = express();",
			"const port = Number(process.env.PORT || 3000);",
			"app.use(express.static('public'));",
			"app.listen(port, '0.0.0.0', () => console.log(`Anvil scaffold listening on ${port}`));",
			"",
		].join("\n"),
	);
	await vmWriteFile(
		vm,
		`${WORKDIR}/public/index.html`,
		[
			"<!doctype html>",
			"<html>",
			"<head>",
			"<meta charset=\"utf-8\">",
			"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
			`<title>${escapeHtml(title)}</title>`,
			"<style>body{font-family:system-ui,sans-serif;margin:4rem;line-height:1.5}</style>",
			"</head>",
			"<body>",
			`<h1>${escapeHtml(title)}</h1>`,
			"<p>Forge-Local scaffold is ready.</p>",
			"</body>",
			"</html>",
			"",
		].join("\n"),
	);
}

async function startDevServer(vm: VmHandle): Promise<void> {
	await execInVm(
		vm,
		"PORT=3000 nohup npm start > .anvil-dev.log 2>&1 & echo $! > .anvil-dev.pid; disown",
		{ cwd: WORKDIR },
	);
	await execInVm(
		vm,
		"for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3000 >/dev/null && exit 0; sleep 1; done; cat .anvil-dev.log; exit 1",
		{ cwd: WORKDIR },
	);
}

async function readCommitSha(vm: VmHandle): Promise<string> {
	const output = await execInVm(vm, "git rev-parse HEAD", { cwd: WORKDIR });
	return output.stdout.trim();
}

async function spawnAnvilMcp(outputDir: string): Promise<McpHandle> {
	await mkdir(outputDir, { recursive: true });
	return spawnMcp({ headless: true, isolated: true, outputDir });
}

async function shutdownMcp(mcp: McpHandle): Promise<void> {
	await mcp.shutdown();
}

function authenticatedCloneUrl(repoUrl: string): string {
	const parsed = parseRepoUrl(repoUrl);
	return `https://x-access-token:\${GITHUB_PAT}@github.com/${parsed.owner}/${parsed.repo}.git`;
}

function safeFileName(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

async function readEnvFile(envPath: string): Promise<Set<string>> {
	const keys = new Set<string>();
	try {
		const text = await readFile(envPath, "utf8");
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq > 0) keys.add(trimmed.slice(0, eq));
		}
	} catch {
		return keys;
	}
	return keys;
}

async function existingEnvText(envPath: string): Promise<string> {
	try {
		const text = await readFile(envPath, "utf8");
		return text.endsWith("\n") ? text : `${text}\n`;
	} catch {
		return "";
	}
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	try {
		const serialized = JSON.stringify(err);
		return serialized ?? String(err);
	} catch {
		return String(err);
	}
}

function printUsage(): void {
	console.log("Usage: anvil <start|status|nuke|setup|run-local>");
}

void main().catch((err) => {
	log.error("[anvil] fatal", { error: errorMessage(err) });
	process.exitCode = 1;
});
