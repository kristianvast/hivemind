import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { log } from "./log.js";

export interface McpHandle {
	client: Client;
	shutdown: () => Promise<void>;
}

type McpContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType?: string }
	| { type: "audio"; data: string; mimeType?: string }
	| { type: "resource"; resource: unknown };

interface McpCallResult {
	isError?: boolean;
	content?: McpContentBlock[];
}

function isMcpCallResult(value: unknown): value is McpCallResult {
	return typeof value === "object" && value !== null;
}

function asCallResult(value: unknown): McpCallResult {
	if (isMcpCallResult(value)) return value;
	return {};
}

function textLines(result: McpCallResult): string[] {
	return (result.content ?? [])
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.flatMap((block) => block.text.split("\n"))
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function findImage(result: McpCallResult): { type: "image"; data: string; mimeType?: string } | undefined {
	return (result.content ?? []).find(
		(block): block is { type: "image"; data: string; mimeType?: string } => block.type === "image",
	);
}

function transportPid(transport: StdioClientTransport): number | undefined {
	const candidate = transport as unknown as { pid?: unknown; process?: { pid?: unknown } };
	if (typeof candidate.pid === "number") return candidate.pid;
	if (typeof candidate.process?.pid === "number") return candidate.process.pid;
	return undefined;
}

export async function spawnMcp(opts?: {
	headless?: boolean;
	isolated?: boolean;
	outputDir?: string;
}): Promise<McpHandle> {
	const args = ["@playwright/mcp@0.0.75"];
	if (opts?.headless ?? true) args.push("--headless");
	if (opts?.isolated ?? true) args.push("--isolated");
	if (opts?.outputDir) args.push("--output-dir", opts.outputDir);
	if (process.env.CI) args.push("--no-sandbox");

	const transport = new StdioClientTransport({ command: "npx", args, stderr: "pipe" });
	transport.onerror = (err) => log.error("[playwright-mcp] transport", { err: String(err) });
	transport.onclose = () => log.warn("[playwright-mcp] server exited");

	const pidOnExit = (): void => {
		const pid = transportPid(transport);
		if (pid !== undefined) process.kill(pid, "SIGKILL");
	};
	process.once("exit", pidOnExit);

	const client = new Client({ name: "anvil", version: "0.1.0" });
	await client.connect(transport);

	return {
		client,
		shutdown: async () => {
			process.off("exit", pidOnExit);
			await client.close();
		},
	};
}

export async function navigate(client: Client, url: string): Promise<void> {
	const result = asCallResult(await client.callTool({ name: "browser_navigate", arguments: { url } }));
	if (result.isError) throw new Error(`Playwright MCP navigate failed: ${textLines(result).join("\n")}`);
}

export async function screenshot(
	client: Client,
	opts: { fullPage?: boolean; saveTo: string },
): Promise<{ pngBytes: number }> {
	const result = asCallResult(
		await client.callTool({
			name: "browser_take_screenshot",
			arguments: { fullPage: opts.fullPage, type: "png" },
		}),
	);
	if (result.isError) throw new Error(`Playwright MCP screenshot failed: ${textLines(result).join("\n")}`);
	const image = findImage(result);
	if (!image) throw new Error("Playwright MCP screenshot did not return an inline image");
	const png = Buffer.from(image.data, "base64");
	await mkdir(path.dirname(opts.saveTo), { recursive: true });
	await writeFile(opts.saveTo, png);
	return { pngBytes: png.byteLength };
}

export async function consoleErrors(client: Client): Promise<string[]> {
	const result = asCallResult(
		await client.callTool({
			name: "browser_console_messages",
			arguments: { level: "error", all: false },
		}),
	);
	if (result.isError) throw new Error(`Playwright MCP console read failed: ${textLines(result).join("\n")}`);
	return textLines(result);
}

export async function failedNetworkRequests(client: Client): Promise<string[]> {
	const result = asCallResult(
		await client.callTool({
			name: "browser_network_requests",
			arguments: { static: false },
		}),
	);
	if (result.isError) throw new Error(`Playwright MCP network read failed: ${textLines(result).join("\n")}`);
	return textLines(result).filter((line) => /\s[45]\d{2}\s/.test(line));
}

export async function waitForReady(
	client: Client,
	opts?: { text?: string; timeoutMs?: number },
): Promise<void> {
	const result = asCallResult(
		await client.callTool({
			name: "browser_wait_for",
			arguments: opts?.text ? { text: opts.text, time: opts.timeoutMs } : { time: opts?.timeoutMs ?? 2000 },
		}),
	);
	if (result.isError) throw new Error(`Playwright MCP wait failed: ${textLines(result).join("\n")}`);
}
