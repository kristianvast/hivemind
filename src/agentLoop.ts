import AnthropicClient from "@anthropic-ai/sdk";
import type Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MAX_TOKENS = 4096;
const DONE_TOOL_NAME = "done";

const TOOL_RESULT_CHAR_CAP = 8000;
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
const TASK_BUDGETS_BETA = "task-budgets-2026-03-13";

const CONTEXT_MGMT_DEFAULTS = {
	clearTriggerInputTokens: 30_000,
	keepRecentToolUses: 3,
	clearAtLeastInputTokens: 3_000,
	alwaysPreserveTools: ["getBriefMetadata", "getProjectIds"] as const,
};

const TASK_BUDGET_MIN = 20_000;

function modelSupportsTaskBudget(model: string): boolean {
	return /opus-4-(7|[89]|[1-9][0-9])/.test(model);
}

type BetaTextBlockParam = Anthropic.Beta.Messages.BetaTextBlockParam;
type BetaToolUnion = Anthropic.Beta.Messages.BetaToolUnion;
type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
type BetaTextBlock = Anthropic.Beta.Messages.BetaTextBlock;
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaStopReason = Anthropic.Beta.Messages.BetaStopReason;
type BetaContextManagementConfig =
	Anthropic.Beta.Messages.BetaContextManagementConfig;
type BetaCreateParams =
	Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

export interface AgentContext {
	notion: import("@notionhq/client").Client;
	briefId: string;
	projectRootId: string;
	agentName: "Architect" | "Scout" | "Librarian" | "Oracle" | "Forge" | "Scribe" | "Sentinel";
	scopeGuard: {
		assertAllowed(pageId: string): Promise<unknown>;
		registerCreated(pageId: string): void;
	};
	tokenBudget: {
		record(inTokens: number, outTokens: number): void;
		assertWithin(): void;
	};
	[key: string]: unknown;
}

export interface ToolDispatcher {
	dispatch(name: string, input: unknown, ctx: AgentContext): Promise<unknown>;
}

export interface RunAgentOptions {
	systemPrompt: string;
	initialUserMessage: string;
	tools: BetaToolUnion[];
	dispatcher: ToolDispatcher;
	ctx: AgentContext;
	model: string;
	stepBudget: number;
	maxTokens?: number;
	thinking?: { type: "enabled"; budget_tokens: number };
	apiKey?: string;
	/**
	 * Per-agent token budget passed to Anthropic's server-side `task_budget`.
	 * Claude sees this as a countdown and self-regulates the agent's exit
	 * timing. The API requires a minimum of 20,000 — values below are
	 * silently clamped.
	 */
	taskBudgetTokens?: number;
}

export interface AgentResult {
	finalText: string;
	toolCallsConsumed: number;
	turns: number;
	stopReason: BetaStopReason | null;
	cacheStats: {
		cacheCreationInputTokens: number;
		cacheReadInputTokens: number;
	};
	contextEditsApplied: number;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
	const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		throw new Error(
			"ANTHROPIC_API_KEY is not set. Add it to .env locally and run `ntn workers env push`.",
		);
	}

	const client = new AnthropicClient({ apiKey });
	const messages: BetaMessageParam[] = [
		{ role: "user", content: opts.initialUserMessage },
	];

	const cachedSystem = buildCachedSystem(opts.systemPrompt);
	const cachedTools = buildCachedTools(opts.tools);
	const contextManagement = buildContextManagement(opts.tools);
	const taskBudget = modelSupportsTaskBudget(opts.model)
		? buildTaskBudget(opts.taskBudgetTokens)
		: undefined;
	const betas: string[] = [CONTEXT_MANAGEMENT_BETA];
	if (taskBudget) betas.push(TASK_BUDGETS_BETA);

	let toolCallsConsumed = 0;
	let turns = 0;
	let cacheCreationInputTokens = 0;
	let cacheReadInputTokens = 0;
	let contextEditsApplied = 0;

	while (true) {
		turns++;

		const request: BetaCreateParams = {
			model: opts.model,
			max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
			system: cachedSystem,
			tools: cachedTools,
			messages,
			betas,
			context_management: contextManagement,
		};
		if (opts.thinking) {
			request.thinking = opts.thinking;
		}
		if (taskBudget) {
			request.output_config = { task_budget: taskBudget };
		}

		const response = await client.beta.messages.create(request);
		const usage = response.usage;
		opts.ctx.tokenBudget.record(usage.input_tokens, usage.output_tokens);
		opts.ctx.tokenBudget.assertWithin();

		const cacheCreate =
			typeof usage.cache_creation_input_tokens === "number"
				? usage.cache_creation_input_tokens
				: 0;
		const cacheRead =
			typeof usage.cache_read_input_tokens === "number"
				? usage.cache_read_input_tokens
				: 0;
		cacheCreationInputTokens += cacheCreate;
		cacheReadInputTokens += cacheRead;

		if (response.context_management?.applied_edits) {
			contextEditsApplied += response.context_management.applied_edits.length;
		}

		messages.push({
			role: "assistant",
			content: toMessageContent(response.content),
		});

		const stopReason = response.stop_reason;
		if (stopReason === undefined || stopReason === null) {
			throw new Error("Anthropic response missing stop_reason");
		}

		if (stopReason === "end_turn") {
			return {
				finalText: extractText(response.content),
				toolCallsConsumed,
				turns,
				stopReason,
				cacheStats: { cacheCreationInputTokens, cacheReadInputTokens },
				contextEditsApplied,
			};
		}

		if (stopReason === "max_tokens") {
			throw new Error(
				"max_tokens hit — agent may have produced truncated tool_use",
			);
		}

		if (stopReason === "pause_turn") {
			// Long server-tool sequence (web_search / web_fetch) interrupted by
			// the API's per-turn output cap. Resend the same conversation —
			// the assistant message is already pushed — and let Claude continue
			// where it left off. No client tool_use to dispatch this turn.
			continue;
		}

		if (stopReason !== "tool_use") {
			if (stopReason === "model_context_window_exceeded") {
				throw new Error(
					"model context window exceeded — context_management did not clear enough",
				);
			}
			throw new Error(`unexpected stop_reason=${stopReason}`);
		}

		const toolUses = response.content.filter(isToolUseBlock);
		if (toolUses.length === 0) {
			throw new Error(
				"stop_reason=tool_use but response contained no tool_use blocks",
			);
		}

		toolCallsConsumed += toolUses.length;
		if (toolCallsConsumed > opts.stepBudget) {
			throw new Error(
				`step budget exceeded: ${toolCallsConsumed}/${opts.stepBudget}`,
			);
		}

		const toolResults = await Promise.all(
			toolUses.map((toolUse) =>
				dispatchToolUse(toolUse, opts.dispatcher, opts.ctx),
			),
		);

		messages.push({ role: "user", content: toolResults });
	}
}

function buildCachedSystem(systemPrompt: string): BetaTextBlockParam[] {
	return [
		{
			type: "text",
			text: systemPrompt,
			cache_control: { type: "ephemeral" },
		},
	];
}

function buildCachedTools(tools: BetaToolUnion[]): BetaToolUnion[] {
	if (tools.length === 0) return [];
	const last = tools.length - 1;
	return tools.map((tool, i) =>
		i === last
			? ({ ...tool, cache_control: { type: "ephemeral" } } as BetaToolUnion)
			: tool,
	);
}

function buildContextManagement(
	tools: BetaToolUnion[],
): BetaContextManagementConfig {
	const toolNames = new Set(
		tools.map((t) => ("name" in t ? t.name : undefined)).filter(
			(n): n is string => typeof n === "string",
		),
	);
	const exclude = CONTEXT_MGMT_DEFAULTS.alwaysPreserveTools.filter((n) =>
		toolNames.has(n),
	);
	return {
		edits: [
			{
				type: "clear_tool_uses_20250919",
				trigger: {
					type: "input_tokens",
					value: CONTEXT_MGMT_DEFAULTS.clearTriggerInputTokens,
				},
				keep: {
					type: "tool_uses",
					value: CONTEXT_MGMT_DEFAULTS.keepRecentToolUses,
				},
				clear_at_least: {
					type: "input_tokens",
					value: CONTEXT_MGMT_DEFAULTS.clearAtLeastInputTokens,
				},
				exclude_tools: exclude.length > 0 ? [...exclude] : undefined,
			},
		],
	};
}

function buildTaskBudget(
	requested: number | undefined,
): { type: "tokens"; total: number } | undefined {
	if (typeof requested !== "number") return undefined;
	const total = Math.max(requested, TASK_BUDGET_MIN);
	return { type: "tokens", total };
}

async function dispatchToolUse(
	toolUse: BetaToolUseBlock,
	dispatcher: ToolDispatcher,
	ctx: AgentContext,
): Promise<BetaToolResultBlockParam> {
	try {
		const output =
			toolUse.name === DONE_TOOL_NAME
				? doneToolOutput(toolUse.input)
				: await dispatcher.dispatch(toolUse.name, toolUse.input, ctx);

		return {
			type: "tool_result",
			tool_use_id: toolUse.id,
			content: capToolOutput(stringifyToolOutput(output)),
		};
	} catch (err) {
		return {
			type: "tool_result",
			tool_use_id: toolUse.id,
			content: `Error: ${errorMessage(err)}`,
			is_error: true,
		};
	}
}

function doneToolOutput(input: unknown): { ok: true; summary: unknown } {
	return {
		ok: true,
		summary: isRecord(input) ? input.summary : undefined,
	};
}

function isToolUseBlock(block: BetaContentBlock): block is BetaToolUseBlock {
	return block.type === "tool_use";
}

function isTextBlock(block: BetaContentBlock): block is BetaTextBlock {
	return block.type === "text";
}

function extractText(blocks: BetaContentBlock[]): string {
	return blocks
		.filter(isTextBlock)
		.map((block) => block.text)
		.join("");
}

function toMessageContent(blocks: BetaContentBlock[]): BetaContentBlockParam[] {
	const out: BetaContentBlockParam[] = [];
	for (const block of blocks) {
		if (block.type === "text") {
			out.push({ type: "text", text: block.text });
			continue;
		}
		if (block.type === "tool_use") {
			out.push({
				type: "tool_use",
				id: block.id,
				name: block.name,
				input: block.input,
			});
			continue;
		}
		if (block.type === "thinking") {
			out.push({
				type: "thinking",
				thinking: block.thinking,
				signature: block.signature,
			});
			continue;
		}
		if (block.type === "redacted_thinking") {
			out.push({ type: "redacted_thinking", data: block.data });
			continue;
		}
		if (block.type === "server_tool_use") {
			out.push({
				type: "server_tool_use",
				id: block.id,
				name: block.name,
				input: block.input,
			});
			continue;
		}
		if (block.type === "web_search_tool_result") {
			out.push({
				type: "web_search_tool_result",
				tool_use_id: block.tool_use_id,
				content: block.content,
			});
			continue;
		}
		if (block.type === "web_fetch_tool_result") {
			out.push({
				type: "web_fetch_tool_result",
				tool_use_id: block.tool_use_id,
				content: block.content,
			});
			continue;
		}
	}
	return out;
}

function stringifyToolOutput(output: unknown): string {
	const serialized = JSON.stringify(output);
	return serialized ?? "null";
}

function capToolOutput(serialized: string): string {
	if (serialized.length <= TOOL_RESULT_CHAR_CAP) return serialized;
	const head = serialized.slice(0, TOOL_RESULT_CHAR_CAP);
	const omitted = serialized.length - TOOL_RESULT_CHAR_CAP;
	return `${head}\n…[truncated ${omitted} chars to bound prompt size]`;
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	if (typeof err === "string") {
		return err;
	}

	try {
		const serialized = JSON.stringify(err);
		return serialized ?? String(err);
	} catch {
		return String(err);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
