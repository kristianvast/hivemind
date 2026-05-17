import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import type AnthropicTypes from "@anthropic-ai/sdk";

import { appendAudit } from "./audit.js";
import { getConfig } from "./config.js";
import { log } from "./log.js";
import {
	buildToolDeclarations,
	executeTool,
	type ToolContext,
} from "./tools.js";
import type { Brief } from "./types.js";

const MAX_STEPS = 40;
const MAX_TOKENS = 4096;
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

export interface ForgeLocalInput {
	briefId: string;
	brief: Brief;
	ctx: ToolContext;
	publicDevUrl: string;
}

export interface ForgeLocalOutput {
	finalProof: { devUrl: string; summary: string };
	transcriptPath: string;
}

interface TranscriptEntry {
	role: "user" | "assistant" | "tool" | "system";
	content: unknown;
	stopReason?: AnthropicTypes.Message["stop_reason"];
	usage?: AnthropicTypes.Usage;
}

export async function runForgeLocal(
	input: ForgeLocalInput,
): Promise<ForgeLocalOutput> {
	const config = getConfig();
	const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
	const model = config.FORGE_LOCAL_MODEL ?? DEFAULT_MODEL;
	const system = buildSystemPrompt(input.ctx);
	const initialUserMessage = buildInitialUserMessage(input);
	const tools = buildToolDeclarations();
	const messages: AnthropicTypes.MessageParam[] = [
		{ role: "user", content: initialUserMessage },
	];
	const transcript: TranscriptEntry[] = [
		{ role: "system", content: system },
		{ role: "user", content: initialUserMessage },
	];

	let toolCallsConsumed = 0;
	let finalPass = false;

	while (true) {
		const requestSystem = finalPass
			? `${system}\n\nYou have hit max iterations. Stop now and report the best proof available. Do not call any tool except report_proof.`
			: system;
		const response = await client.messages.create({
			model,
			max_tokens: MAX_TOKENS,
			system: requestSystem,
			tools,
			messages,
		});

		messages.push({
			role: "assistant",
			content: toMessageContent(response.content),
		});
		transcript.push({
			role: "assistant",
			content: response.content,
			stopReason: response.stop_reason,
			usage: response.usage,
		});
		await appendAudit(input.briefId, "llm_message", {
			content: response.content,
			stopReason: response.stop_reason,
		});

		if (input.ctx.finalProof) {
			return finishRun(input, transcript);
		}

		if (response.stop_reason === "end_turn") {
			return finishRun(input, transcript, extractText(response.content));
		}

		if (response.stop_reason === "max_tokens") {
			throw new Error("Forge-Local hit max_tokens before finishing a turn");
		}

		if (response.stop_reason !== "tool_use") {
			throw new Error(`Forge-Local unexpected stop_reason=${response.stop_reason}`);
		}

		const toolUses = response.content.filter(isToolUseBlock);
		if (toolUses.length === 0) {
			throw new Error("stop_reason=tool_use but response contained no tool_use blocks");
		}

		if (finalPass && toolUses.some((toolUse) => toolUse.name !== "report_proof")) {
			throw new Error(
				"Forge-Local exhausted its step budget and still requested non-terminal tools",
			);
		}

		if (!finalPass && toolCallsConsumed + toolUses.length > MAX_STEPS) {
			const budgetResults = toolUses.map((toolUse) =>
				maxBudgetToolResult(toolUse),
			);
			messages.push({ role: "user", content: budgetResults });
			messages.push({
				role: "user",
				content:
					"SYSTEM: You've hit max iterations. Stop and report the best available proof now.",
			});
			transcript.push({
				role: "user",
				content:
					"SYSTEM: You've hit max iterations. Stop and report the best available proof now.",
			});
			finalPass = true;
			continue;
		}

		toolCallsConsumed += toolUses.length;
		const toolResults: AnthropicTypes.ToolResultBlockParam[] = [];
		for (const toolUse of toolUses) {
			const result = await dispatchToolUse(toolUse, input.ctx, input.briefId);
			toolResults.push(result);
			transcript.push({ role: "tool", content: result });
		}

		messages.push({ role: "user", content: toolResults });

		if (input.ctx.finalProof) {
			return finishRun(input, transcript);
		}

		if (!finalPass && toolCallsConsumed >= MAX_STEPS) {
			messages.push({
				role: "user",
				content:
					"SYSTEM: You've hit max iterations. Stop and report the best available proof now.",
			});
			transcript.push({
				role: "user",
				content:
					"SYSTEM: You've hit max iterations. Stop and report the best available proof now.",
			});
			finalPass = true;
		}
	}
}

function buildSystemPrompt(ctx: ToolContext): string {
	return `You are Forge-Local, a senior full-stack engineer with bash + file editing + browser proof tools, working inside an ephemeral Linux microVM at /workspace.

GOAL: Build the project described by the brief, run it, capture proof that it works, then call report_proof.

CONTEXT:
- You have a clean Debian-based Linux VM. Node, npm, git, curl, common build tools are pre-installed.
- The git repo for this brief is already cloned at /workspace. A feature branch is checked out. Default branch is "${ctx.baseBranch}".
- All your bash commands run inside this VM. The host CANNOT see your files unless you use git push.
- Use text_editor (str_replace_based_edit_tool) for ALL file writes — NOT echo/heredoc/cat. text_editor is faster and more reliable.
- When you start a long-running dev server, run it in background with \`&\` and capture pid. Wait for it to be ready before screenshotting (poll the URL with curl until 200 or use playwright_wait_for).
- Public URL for port 3000 is provided by the runtime — pass it to playwright_navigate.
- When done: commit + push your branch via git_commit_push, then call report_proof with the dev URL + a short summary. The orchestrator opens the PR.

RULES:
- SCOPE: stay inside /workspace. Do NOT modify /etc, /home, /root, /tmp.
- NO secrets in code. Use env vars; the user supplies them later.
- ONE iteration. If something fails, try a different approach. Do NOT loop forever.
- When you call report_proof, your work is DONE. The orchestrator handles screenshot + PR + Notion writeback.`;
}

function buildInitialUserMessage(input: ForgeLocalInput): string {
	return [
		`Brief ID: ${input.briefId}`,
		`Title: ${input.brief.title}`,
		"",
		"Body:",
		input.brief.body ?? "(no body)",
		"",
		`Workdir inside VM: ${input.ctx.workdir}`,
		"Dev server port: 3000",
		`Public dev URL: ${input.publicDevUrl}`,
		`Repository: ${input.ctx.owner}/${input.ctx.repo}`,
		`Branch: ${input.ctx.branch}`,
		`Base branch: ${input.ctx.baseBranch}`,
		"",
		"Acceptance criteria:",
		"- Implement the requested project changes in the checked-out repo.",
		"- Run the app on port 3000 bound to 0.0.0.0.",
		"- Use Playwright tools to verify the public dev URL renders correctly.",
		"- Commit and push the branch.",
		"- Call report_proof with the dev URL and a concise summary.",
	].join("\n");
}

async function dispatchToolUse(
	toolUse: AnthropicTypes.ToolUseBlock,
	ctx: ToolContext,
	briefId: string,
): Promise<AnthropicTypes.ToolResultBlockParam> {
	let output: string;
	let isError = false;
	try {
		output = await executeTool(toolUse.name, toolUse.input, ctx);
	} catch (err) {
		isError = true;
		output = `Error: ${errorMessage(err)}`;
	}

	await appendAudit(briefId, "tool_call", {
		name: toolUse.name,
		input: toolUse.input,
		output,
		isError,
	});

	return {
		type: "tool_result",
		tool_use_id: toolUse.id,
		content: output,
		is_error: isError ? true : undefined,
	};
}

function maxBudgetToolResult(
	toolUse: AnthropicTypes.ToolUseBlock,
): AnthropicTypes.ToolResultBlockParam {
	return {
		type: "tool_result",
		tool_use_id: toolUse.id,
		content:
			"Error: Forge-Local step budget exhausted. Stop now and call report_proof with the best available proof.",
		is_error: true,
	};
}

async function finishRun(
	input: ForgeLocalInput,
	transcript: TranscriptEntry[],
	finalText?: string,
): Promise<ForgeLocalOutput> {
	const finalProof =
		input.ctx.finalProof ??
		fallbackProof(input.publicDevUrl, finalText ?? "Forge-Local ended without report_proof.");
	const transcriptPath = await writeTranscript(input.briefId, transcript);
	log.info("[forge-local] complete", {
		briefId: input.briefId,
		transcriptPath,
	});
	return { finalProof, transcriptPath };
}

function fallbackProof(
	devUrl: string,
	text: string,
): { devUrl: string; summary: string } {
	const summary = text.trim().length > 0 ? text.trim().slice(0, 1000) : "Done";
	return { devUrl, summary };
}

async function writeTranscript(
	briefId: string,
	entries: TranscriptEntry[],
): Promise<string> {
	const config = getConfig();
	const safeBriefId = briefId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const dir = path.join(config.ANVIL_WORKDIR_ROOT, "transcripts");
	await mkdir(dir, { recursive: true });
	const transcriptPath = path.join(dir, `${safeBriefId}.json`);
	await writeFile(transcriptPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
	return transcriptPath;
}

function isToolUseBlock(
	block: AnthropicTypes.ContentBlock,
): block is AnthropicTypes.ToolUseBlock {
	return block.type === "tool_use";
}

function isTextBlock(
	block: AnthropicTypes.ContentBlock,
): block is AnthropicTypes.TextBlock {
	return block.type === "text";
}

function extractText(blocks: AnthropicTypes.ContentBlock[]): string {
	return blocks.filter(isTextBlock).map((block) => block.text).join("");
}

function toMessageContent(
	blocks: AnthropicTypes.ContentBlock[],
): AnthropicTypes.ContentBlockParam[] {
	return blocks.map((block) => {
		if (block.type === "text") {
			return { type: "text", text: block.text };
		}
		if (block.type === "tool_use") {
			return {
				type: "tool_use",
				id: block.id,
				name: block.name,
				input: block.input,
			};
		}
		if (block.type === "thinking") {
			return {
				type: "thinking",
				thinking: block.thinking,
				signature: block.signature,
			};
		}
		if (block.type === "redacted_thinking") {
			return { type: "redacted_thinking", data: block.data };
		}
		throw new Error(`Forge-Local unsupported content block type: ${block.type}`);
	});
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
