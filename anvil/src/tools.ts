import path from "node:path";

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { execInVm, readFile, writeFile } from "./vm-runtime.js";
import { log } from "./log.js";
import {
	consoleErrors as mcpConsoleErrors,
	failedNetworkRequests as mcpFailedNetworkRequests,
	navigate as mcpNavigate,
	screenshot as mcpScreenshot,
	waitForReady as mcpWaitForReady,
} from "./playwright-mcp.js";
import type { McpHandle, VmHandle } from "./types.js";

export interface ToolContext {
	vm: VmHandle;
	mcp: McpHandle;
	briefId: string;
	workdir: string;
	baseBranch: string;
	owner: string;
	repo: string;
	branch: string;
	finalProof?: { devUrl: string; summary: string };
}

const bashInputSchema = z
	.object({
		command: z.string().min(1),
		restart: z.boolean().optional(),
	})
	.strict();

const textEditorInputSchema = z
	.object({
		command: z.enum(["view", "create", "str_replace", "insert"]),
		path: z.string().min(1),
		file_text: z.string().optional(),
		old_str: z.string().optional(),
		new_str: z.string().optional(),
		insert_line: z.number().int().positive().optional(),
		view_range: z.tuple([z.number().int(), z.number().int()]).optional(),
	})
	.strict();

const navigateInputSchema = z.object({ url: z.string().url() }).strict();

const screenshotInputSchema = z
	.object({
		fullPage: z.boolean().optional(),
		saveTo: z.string().min(1),
	})
	.strict();

const emptyInputSchema = z.object({}).strict();

const waitForInputSchema = z
	.object({
		text: z.string().optional(),
		time: z.number().positive().optional(),
	})
	.strict();

const gitCommitPushInputSchema = z
	.object({
		message: z.string().min(1),
		branch: z.string().min(1).optional(),
	})
	.strict();

const reportProofInputSchema = z
	.object({
		devUrl: z.string().url(),
		summary: z.string().min(1),
	})
	.strict();

const customTools: Anthropic.Tool[] = [
	{
		name: "playwright_navigate",
		description:
			"Navigate the host-side Playwright browser to a URL, usually the public dev URL exposed by the VM.",
		input_schema: {
			type: "object",
			properties: {
				url: { type: "string", description: "URL to navigate to." },
			},
			required: ["url"],
			additionalProperties: false,
		},
	},
	{
		name: "playwright_screenshot",
		description:
			"Capture a screenshot with host-side Playwright and save it to a host path supplied by the runtime.",
		input_schema: {
			type: "object",
			properties: {
				fullPage: { type: "boolean" },
				saveTo: {
					type: "string",
					description:
						"Host-side output path, e.g. /tmp/anvil-screenshots/<briefId>.png.",
				},
			},
			required: ["saveTo"],
			additionalProperties: false,
		},
	},
	{
		name: "playwright_console_errors",
		description:
			"Return browser console errors captured by the Playwright MCP, one per line.",
		input_schema: {
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		},
	},
	{
		name: "playwright_failed_requests",
		description:
			"Return failed browser network requests captured by the Playwright MCP, one per line.",
		input_schema: {
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		},
	},
	{
		name: "playwright_wait_for",
		description:
			"Wait for text to appear in the page or for a fixed number of milliseconds before checking proof.",
		input_schema: {
			type: "object",
			properties: {
				text: { type: "string", description: "Optional text to wait for." },
				time: {
					type: "number",
					description: "Optional wait duration in milliseconds.",
				},
			},
			required: [],
			additionalProperties: false,
		},
	},
	{
		name: "git_commit_push",
		description:
			"Commit all changes in the VM worktree and push the current branch to origin.",
		input_schema: {
			type: "object",
			properties: {
				message: { type: "string", description: "Git commit message." },
				branch: {
					type: "string",
					description: "Optional branch name to check out before pushing.",
				},
			},
			required: ["message"],
			additionalProperties: false,
		},
	},
	{
		name: "report_proof",
		description:
			"Terminal tool. Call when the app is working, committed, and pushed. Includes the dev URL and concise proof summary.",
		input_schema: {
			type: "object",
			properties: {
				devUrl: { type: "string", description: "Public dev URL that proves the work." },
				summary: { type: "string", description: "Short proof summary." },
			},
			required: ["devUrl", "summary"],
			additionalProperties: false,
		},
	},
];

export function buildToolDeclarations(): Anthropic.Tool[] {
	const bashTool = { type: "bash_20250124", name: "bash" } as unknown as Anthropic.Tool;
	const textEditorTool = {
		type: "text_editor_20250728",
		name: "str_replace_based_edit_tool",
	} as unknown as Anthropic.Tool;
	return [bashTool, textEditorTool, ...customTools];
}

export async function executeTool(
	name: string,
	input: unknown,
	ctx: ToolContext,
): Promise<string> {
	switch (name) {
		case "bash":
			return executeBash(input, ctx);
		case "str_replace_based_edit_tool":
			return executeTextEditor(input, ctx);
		case "playwright_navigate":
			return executePlaywrightNavigate(input, ctx);
		case "playwright_screenshot":
			return executePlaywrightScreenshot(input, ctx);
		case "playwright_console_errors":
			return executePlaywrightConsoleErrors(input, ctx);
		case "playwright_failed_requests":
			return executePlaywrightFailedRequests(input, ctx);
		case "playwright_wait_for":
			return executePlaywrightWaitFor(input, ctx);
		case "git_commit_push":
			return executeGitCommitPush(input, ctx);
		case "report_proof":
			return executeReportProof(input, ctx);
		default:
			throw new Error(`Unknown Forge-Local tool: ${name}`);
	}
}

async function executeBash(input: unknown, ctx: ToolContext): Promise<string> {
	const parsed = bashInputSchema.parse(input);
	if (parsed.restart === true) {
		log.info("[forge-local] bash restart requested; restart is a no-op");
	}
	const output = await execInVm(ctx.vm, parsed.command, { cwd: ctx.workdir });
	return formatVmOutput(output);
}

async function executeTextEditor(
	input: unknown,
	ctx: ToolContext,
): Promise<string> {
	const parsed = textEditorInputSchema.parse(input);
	const targetPath = resolvePathInWorkdir(ctx.workdir, parsed.path);

	switch (parsed.command) {
		case "view":
			return viewPath(ctx, targetPath, parsed.view_range);
		case "create":
			return createFile(ctx, targetPath, parsed.file_text);
		case "str_replace":
			return replaceInFile(ctx, targetPath, parsed.old_str, parsed.new_str);
		case "insert":
			return insertInFile(ctx, targetPath, parsed.insert_line, parsed.file_text);
		default: {
			const exhaustive: never = parsed.command;
			throw new Error(`Unsupported text editor command: ${exhaustive}`);
		}
	}
}

async function executePlaywrightNavigate(
	input: unknown,
	ctx: ToolContext,
): Promise<string> {
	const parsed = navigateInputSchema.parse(input);
	await mcpNavigate(ctx.mcp.client, parsed.url);
	return `navigated to ${parsed.url}`;
}

async function executePlaywrightScreenshot(
	input: unknown,
	ctx: ToolContext,
): Promise<string> {
	const parsed = screenshotInputSchema.parse(input);
	const result = await mcpScreenshot(ctx.mcp.client, {
		fullPage: parsed.fullPage ?? false,
		saveTo: parsed.saveTo,
	});
	return `screenshot saved to ${parsed.saveTo} (${result.pngBytes} bytes)`;
}

async function executePlaywrightConsoleErrors(
	input: unknown,
	ctx: ToolContext,
): Promise<string> {
	emptyInputSchema.parse(input ?? {});
	const errors = await mcpConsoleErrors(ctx.mcp.client);
	return normalizeStringList(errors).join("\n");
}

async function executePlaywrightFailedRequests(
	input: unknown,
	ctx: ToolContext,
): Promise<string> {
	emptyInputSchema.parse(input ?? {});
	const failures = await mcpFailedNetworkRequests(ctx.mcp.client);
	return normalizeStringList(failures).join("\n");
}

async function executePlaywrightWaitFor(
	input: unknown,
	ctx: ToolContext,
): Promise<string> {
	const parsed = waitForInputSchema.parse(input);
	await mcpWaitForReady(ctx.mcp.client, {
		text: parsed.text,
		timeoutMs: parsed.time,
	});
	return parsed.text ? `waited for text ${parsed.text}` : `waited ${parsed.time ?? 2000}ms`;
}

async function executeGitCommitPush(
	input: unknown,
	ctx: ToolContext,
): Promise<string> {
	const parsed = gitCommitPushInputSchema.parse(input);
	const checkout = parsed.branch
		? `git checkout -B ${shellQuote(parsed.branch)} && `
		: "";
	const command = `${checkout}git add -A && if git diff --cached --quiet; then echo "No changes to commit"; else git commit -m ${shellQuote(parsed.message)}; fi && git push -u origin HEAD`;
	const output = await execInVm(ctx.vm, command, { cwd: ctx.workdir });
	return formatVmOutput(output);
}

async function executeReportProof(
	input: unknown,
	ctx: ToolContext,
): Promise<string> {
	const parsed = reportProofInputSchema.parse(input);
	ctx.finalProof = { devUrl: parsed.devUrl, summary: parsed.summary };
	return "ok";
}

function resolvePathInWorkdir(workdir: string, requestedPath: string): string {
	if (requestedPath.includes("\0")) {
		throw new Error("Path contains a NUL byte and is not allowed");
	}

	const normalizedWorkdir = path.posix.resolve(workdir);
	const resolved = path.posix.isAbsolute(requestedPath)
		? path.posix.resolve(requestedPath)
		: path.posix.resolve(normalizedWorkdir, requestedPath);
	const relative = path.posix.relative(normalizedWorkdir, resolved);

	if (
		relative === "" ||
		(!relative.startsWith("..") && !path.posix.isAbsolute(relative))
	) {
		return resolved;
	}

	throw new Error(
		`Path ${requestedPath} escapes workdir ${normalizedWorkdir}; Forge-Local may only edit files under ${normalizedWorkdir}`,
	);
}

async function viewPath(
	ctx: ToolContext,
	targetPath: string,
	viewRange: [number, number] | undefined,
): Promise<string> {
	const kindOutput = await execInVm(
		ctx.vm,
		`if [ -d ${shellQuote(targetPath)} ]; then printf directory; elif [ -f ${shellQuote(targetPath)} ]; then printf file; else printf missing; fi`,
		{ cwd: ctx.workdir },
	);
	const kind = stdoutFromVmOutput(kindOutput).trim();
	if (kind === "directory") {
		const listing = await execInVm(ctx.vm, `ls -la ${shellQuote(targetPath)}`, {
			cwd: ctx.workdir,
		});
		return formatVmOutput(listing);
	}
	if (kind === "missing") {
		throw new Error(`view: ${targetPath} does not exist`);
	}

	const text = await readFile(ctx.vm, targetPath);
	return formatFileView(text, viewRange);
}

async function createFile(
	ctx: ToolContext,
	targetPath: string,
	fileText: string | undefined,
): Promise<string> {
	if (fileText === undefined) {
		throw new Error("create: file_text is required");
	}
	await ensureParentDirectory(ctx, targetPath);
	await writeFile(ctx.vm, targetPath, fileText);
	return `created ${targetPath}`;
}

async function replaceInFile(
	ctx: ToolContext,
	targetPath: string,
	oldStr: string | undefined,
	newStr: string | undefined,
): Promise<string> {
	if (oldStr === undefined || oldStr.length === 0) {
		throw new Error("str_replace: old_str is required and cannot be empty");
	}
	const text = await readFile(ctx.vm, targetPath);
	const count = countOccurrences(text, oldStr);
	if (count === 0) {
		throw new Error(`str_replace: old_str not found in ${targetPath}`);
	}
	if (count > 1) {
		throw new Error(
			`str_replace: old_str matched ${count} times in ${targetPath}; provide a unique string`,
		);
	}
	await writeFile(ctx.vm, targetPath, text.replace(oldStr, newStr ?? ""));
	return `replaced 1 occurrence in ${targetPath}`;
}

async function insertInFile(
	ctx: ToolContext,
	targetPath: string,
	insertLine: number | undefined,
	fileText: string | undefined,
): Promise<string> {
	if (insertLine === undefined) {
		throw new Error("insert: insert_line is required");
	}
	if (fileText === undefined) {
		throw new Error("insert: file_text is required");
	}
	const text = await readFile(ctx.vm, targetPath);
	const lines = text.split("\n");
	if (insertLine > lines.length + 1) {
		throw new Error(
			`insert: insert_line ${insertLine} is beyond end of file (${lines.length} lines)`,
		);
	}
	const insertAt = insertLine - 1;
	lines.splice(insertAt, 0, ...fileText.split("\n"));
	await writeFile(ctx.vm, targetPath, lines.join("\n"));
	return `inserted text at line ${insertLine} in ${targetPath}`;
}

async function ensureParentDirectory(
	ctx: ToolContext,
	targetPath: string,
): Promise<void> {
	const parent = path.posix.dirname(targetPath);
	await execInVm(ctx.vm, `mkdir -p ${shellQuote(parent)}`, { cwd: ctx.workdir });
}

function formatFileView(
	text: string,
	viewRange: [number, number] | undefined,
): string {
	const lines = text.split("\n");
	const startLine = viewRange ? viewRange[0] : 1;
	const rawEndLine = viewRange ? viewRange[1] : lines.length;
	const endLine = rawEndLine === -1 ? lines.length : rawEndLine;
	if (startLine < 1 || endLine < startLine) {
		throw new Error("view: view_range must be [start, end] with 1-indexed positive lines");
	}
	return lines
		.slice(startLine - 1, endLine)
		.map((line, index) => `${startLine + index}: ${line}`)
		.join("\n");
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let index = text.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = text.indexOf(needle, index + needle.length);
	}
	return count;
}

function formatVmOutput(output: unknown): string {
	if (typeof output === "string") return output;
	if (!output || typeof output !== "object") return String(output);
	const record = output as Record<string, unknown>;
	const stdout = typeof record.stdout === "string" ? record.stdout : "";
	const stderr = typeof record.stderr === "string" ? record.stderr : "";
	const exitCode =
		typeof record.exitCode === "number"
			? record.exitCode
			: typeof record.code === "number"
				? record.code
				: undefined;
	const pieces: string[] = [];
	if (exitCode !== undefined) pieces.push(`exitCode=${exitCode}`);
	if (stdout.length > 0) pieces.push(stdout.trimEnd());
	if (stderr.length > 0) pieces.push(stderr.trimEnd());
	if (pieces.length > 0) return pieces.join("\n");
	return stringifyResult(output);
}

function stdoutFromVmOutput(output: unknown): string {
	if (typeof output === "string") return output;
	if (!output || typeof output !== "object") return "";
	const record = output as Record<string, unknown>;
	return typeof record.stdout === "string" ? record.stdout : "";
}

function stringifyResult(output: unknown): string {
	if (typeof output === "string") return output;
	const serialized = JSON.stringify(output);
	return serialized ?? "null";
}

function normalizeStringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((item) =>
			typeof item === "string" ? item : stringifyResult(item),
		);
	}
	if (typeof value === "string") {
		return value.length > 0 ? [value] : [];
	}
	if (value === undefined || value === null) return [];
	return [stringifyResult(value)];
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
