// Hivemind v2 orchestrator. Replaces v1's fixed-chain `chain.ts`. Per brief:
//
//   1. Read state, check budget circuit breaker, bail if tripped.
//   2. Classify if Category is unset (Phase 4: Category is informational
//      metadata only — drives the project icon and kanban filters, never
//      execution routing).
//   3. Provision the project subtree (idempotent, unified layout).
//   4. Build pacer / token budget / scope guard.
//   5. Run the Architect agent. The Architect picks writeAnswer vs
//      createDraft at runtime and can delegate to Scout / Librarian /
//      Oracle sub-agents.
//   6. Run the Sentinel agent as a fixed post-step. Sentinel reviews the
//      Architect's output (drafts OR inline answer), posts a Review, and
//      calls setVerdict — this drives the Status transition (approve →
//      Needs Review; needs-revision → leaves Status In Progress for retry).
//   7. Failure modes: BudgetExceeded → trip circuit + Failed; ScopeViolation
//      → comment + Failed; anything else → reportChainFailure.

import type { Client } from "@notionhq/client";

import { invokeAgent, type BriefMetadata, type AgentSpec } from "./agents";
import { getArchitectSpec } from "./architect";
import { BudgetExceeded, TokenBudget } from "./budget";
import { ALL_CATEGORIES, classifyBrief, type Category } from "./classify";
import {
	appendBlocks,
	bullet,
	callout,
	divider,
	heading3,
	paragraph,
	toggle,
	type BriefContext,
	postComment,
	reportChainFailure,
	setBriefProperties,
} from "./notion";
import { Pacer } from "./pacer";
import { provisionProject, type ProjectIds } from "./provision";
import { failRun, finishRun, startRun, type RunAgent } from "./runs";
import { ScopeGuard, ScopeViolation } from "./scope";
import { mergeHivemindState, readHivemindState } from "./state";
import { getSentinelSpec } from "./subagents";
import { getWorkspaceHomeIdsFromEnv } from "./workspaceHome";

function briefUrlFor(briefId: string): string {
	return `https://www.notion.so/${briefId.replace(/-/g, "")}`;
}

const APPROVAL_COMMENT = "✅ Hivemind approved. The swarm is at rest.";

const PACER_CONFIG = { rps: 2.5, burst: 5 } as const;
const TOKEN_BUDGET_LIMIT = 400_000;

type ActivityAgent = "Architect" | "Sentinel" | "Orchestrator";

const AGENT_EMOJI: Record<ActivityAgent, string> = {
	Architect: "🧠",
	Sentinel: "🛡️",
	Orchestrator: "🎼",
};

function timestamp(): string {
	return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	return `${(n / 1000).toFixed(1)}k`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

async function readBriefCategory(
	notion: Client,
	pageId: string,
): Promise<Category | null> {
	const page = await notion.pages.retrieve({ page_id: pageId });
	const props = (page as { properties?: Record<string, unknown> }).properties;
	if (!props) return null;
	const cat = props.Category;
	if (!cat || typeof cat !== "object") return null;
	const typed = cat as { type?: string; select?: { name?: string } | null };
	if (typed.type !== "select" || !typed.select) return null;
	const name = typed.select.name;
	if (typeof name !== "string") return null;
	return ALL_CATEGORIES.includes(name as Category) ? (name as Category) : null;
}

async function writeBriefCategory(
	notion: Client,
	pageId: string,
	category: Category,
): Promise<void> {
	await notion.pages.update({
		page_id: pageId,
		properties: { Category: { select: { name: category } } },
	});
}

async function logAgentStart(
	notion: Client,
	pacer: Pacer,
	activityPageId: string,
	agent: ActivityAgent,
): Promise<void> {
	try {
		await pacer.acquire();
		await appendBlocks(notion, activityPageId, [
			callout(
				`${agent} started — ${timestamp()}`,
				AGENT_EMOJI[agent],
				"blue_background",
			),
		]);
	} catch (err) {
		console.warn(`[orchestrator] logAgentStart(${agent}) failed:`, err);
	}
}

interface AgentFinishArgs {
	activityPageId: string;
	agent: ActivityAgent;
	stepCount: number;
	durationMs: number;
	tokensDelta: number;
	cacheCreate: number;
	cacheRead: number;
	doneSummary?: string;
	verdict?: { verdict: "approve" | "needs-revision"; summary: string };
}

async function logAgentFinish(
	notion: Client,
	pacer: Pacer,
	args: AgentFinishArgs,
): Promise<void> {
	try {
		const { agent, stepCount, durationMs, tokensDelta, cacheCreate, cacheRead } = args;
		const emoji = AGENT_EMOJI[agent];
		const headline = `${emoji} ${agent} · ${timestamp()} · ${stepCount} tools · ${formatDuration(durationMs)} · ${formatTokens(tokensDelta)} tokens`;

		const children: BlockObjectRequestLike[] = [];

		const metrics: string[] = [
			`${stepCount} tool calls`,
			formatDuration(durationMs),
			`${formatTokens(tokensDelta)} tokens`,
		];
		if (cacheRead > 0) metrics.push(`${formatTokens(cacheRead)} cache read`);
		if (cacheCreate > 0) metrics.push(`${formatTokens(cacheCreate)} cache create`);
		children.push(paragraph(`📊 ${metrics.join(" · ")}`));

		if (args.doneSummary) {
			children.push(heading3("Summary"));
			children.push(paragraph(args.doneSummary));
		}

		if (args.verdict) {
			children.push(heading3("Verdict"));
			const v = args.verdict.verdict;
			const icon = v === "approve" ? "✅" : "🔁";
			children.push(callout(`${icon} ${v}`, undefined, v === "approve" ? "green_background" : "yellow_background"));
			children.push(paragraph(args.verdict.summary));
		}

		await pacer.acquire();
		await appendBlocks(notion, args.activityPageId, [toggle(headline, children)]);
	} catch (err) {
		console.warn(`[orchestrator] logAgentFinish(${args.agent}) failed:`, err);
	}
}

async function logAgentError(
	notion: Client,
	pacer: Pacer,
	activityPageId: string,
	agent: ActivityAgent,
	err: unknown,
): Promise<void> {
	try {
		const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		await pacer.acquire();
		await appendBlocks(notion, activityPageId, [
			callout(
				`${AGENT_EMOJI[agent]} ${agent} errored — ${timestamp()}\n${msg}`,
				"❌",
				"red_background",
			),
		]);
	} catch (logErr) {
		console.warn(`[orchestrator] logAgentError(${agent}) failed:`, logErr);
	}
}

async function logOrchestratorEnd(
	notion: Client,
	pacer: Pacer,
	activityPageId: string,
	approved: boolean,
): Promise<void> {
	try {
		await pacer.acquire();
		const text = approved
			? `Hivemind chain complete — approved ${timestamp()}`
			: `Hivemind chain finished — ${timestamp()}`;
		await appendBlocks(notion, activityPageId, [
			divider(),
			callout(text, "🎼", approved ? "green_background" : "default"),
		]);
	} catch (err) {
		console.warn("[orchestrator] logOrchestratorEnd failed:", err);
	}
}

type BlockObjectRequestLike = ReturnType<typeof bullet>;

async function runAgentStage(args: {
	notion: Client;
	pacer: Pacer;
	tokenBudget: TokenBudget;
	scopeGuard: ScopeGuard;
	briefMetadata: BriefMetadata;
	projectIds: ProjectIds;
	spec: AgentSpec;
	activityPageId: string;
	agentLabel: ActivityAgent;
	owner: ActivityAgent;
}): Promise<Awaited<ReturnType<typeof invokeAgent>>> {
	const {
		notion,
		pacer,
		tokenBudget,
		scopeGuard,
		briefMetadata,
		projectIds,
		spec,
		activityPageId,
		agentLabel,
		owner,
	} = args;

	await setBriefProperties(notion, briefMetadata.id, {
		status: "In Progress",
		owner: owner as "Architect" | "Sentinel",
	});
	await logAgentStart(notion, pacer, activityPageId, agentLabel);

	const runsDsId = projectIds.dbs.runs?.dsId;
	const runAgentName = agentLabel as RunAgent;
	const workspaceIds = getWorkspaceHomeIdsFromEnv();
	const tStart = Date.now();
	const tokensBefore = tokenBudget.usage;
	const runIds = runsDsId
		? await startRun({
				notion,
				pacer,
				dsId: runsDsId,
				agent: runAgentName,
				label: `${AGENT_EMOJI[agentLabel]} ${agentLabel} turn`,
				mirror: workspaceIds
					? {
							activityDsId: workspaceIds.activityDsId,
							briefUrl: briefUrlFor(briefMetadata.id),
							briefTitle: briefMetadata.title,
						}
					: undefined,
			}).catch((err: unknown) => {
				console.warn("[orchestrator] startRun failed:", err);
				return undefined;
			})
		: undefined;

	try {
		const invocation = await invokeAgent({
			spec,
			notion,
			briefMetadata,
			projectIds,
			scopeGuard,
			pacer,
			tokenBudget,
		});
		const durationMs = Date.now() - tStart;
		const tokensDelta = tokenBudget.usage - tokensBefore;

		if (runIds) {
			await finishRun({
				notion,
				pacer,
				runRowId: runIds.runRowId,
				activityRowId: runIds.activityRowId,
				durationMs,
				tokens: tokensDelta,
				toolCalls: invocation.result.toolCallsConsumed,
				summary: invocation.doneSummary,
				verdict: invocation.verdict?.verdict,
			});
		}

		await logAgentFinish(notion, pacer, {
			activityPageId,
			agent: agentLabel,
			stepCount: invocation.result.toolCallsConsumed,
			durationMs,
			tokensDelta,
			cacheCreate: invocation.result.cacheStats.cacheCreationInputTokens,
			cacheRead: invocation.result.cacheStats.cacheReadInputTokens,
			doneSummary: invocation.doneSummary,
			verdict: invocation.verdict,
		});

		return invocation;
	} catch (err) {
		const durationMs = Date.now() - tStart;
		const tokensDelta = tokenBudget.usage - tokensBefore;
		if (runIds) {
			await failRun({
				notion,
				pacer,
				runRowId: runIds.runRowId,
				activityRowId: runIds.activityRowId,
				durationMs,
				tokens: tokensDelta,
				errorMsg: err instanceof Error ? err.message : String(err),
			});
		}
		throw err;
	}
}

export async function runOrchestratorForBrief(args: {
	notion: Client;
	brief: BriefContext;
	botUserId: string | undefined;
}): Promise<void> {
	const { notion, brief } = args;
	const pageId = brief.pageId;
	let stage = "start";

	try {
		const state = await readHivemindState(notion, pageId);

		if (state.budgetCircuitTripped) {
			await postComment(
				notion,
				pageId,
				"Budget circuit-breaker tripped on a previous run. To retry, expand the '🔒 Hivemind internal state' toggle on this brief and clear the JSON.",
			);
			return;
		}

		stage = "classify";
		let category = await readBriefCategory(notion, pageId);
		if (!category) {
			category = await classifyBrief({
				title: brief.title,
				body: brief.body,
			});
			await writeBriefCategory(notion, pageId, category);
		}

		stage = "provision";
		const projectIds: ProjectIds = await provisionProject(
			notion,
			pageId,
			brief.title,
			category,
		);

		const pacer = new Pacer(PACER_CONFIG);
		const tokenBudget = new TokenBudget(TOKEN_BUDGET_LIMIT);
		const scopeGuard = new ScopeGuard(notion, projectIds.projectRootId);
		const briefMetadata: BriefMetadata = {
			id: pageId,
			title: brief.title,
			body: brief.body,
			status: brief.status,
			category,
		};
		const activityPageId = projectIds.activityPageId;

		console.log(
			"[orchestrator]",
			pageId,
			"category=",
			category,
			"(informational)",
			"sequence=Architect→Sentinel",
		);

		stage = "agent:Architect";
		try {
			await runAgentStage({
				notion,
				pacer,
				tokenBudget,
				scopeGuard,
				briefMetadata,
				projectIds,
				spec: getArchitectSpec(),
				activityPageId,
				agentLabel: "Architect",
				owner: "Architect",
			});
		} catch (err) {
			await logAgentError(notion, pacer, activityPageId, "Architect", err);
			await handleAgentError(notion, pageId, "Architect", tokenBudget, err);
			return;
		}

		stage = "agent:Sentinel";
		let sentinelInvocation: Awaited<ReturnType<typeof invokeAgent>>;
		try {
			sentinelInvocation = await runAgentStage({
				notion,
				pacer,
				tokenBudget,
				scopeGuard,
				briefMetadata,
				projectIds,
				spec: getSentinelSpec(),
				activityPageId,
				agentLabel: "Sentinel",
				owner: "Sentinel",
			});
		} catch (err) {
			await logAgentError(notion, pacer, activityPageId, "Sentinel", err);
			await handleAgentError(notion, pageId, "Sentinel", tokenBudget, err);
			return;
		}

		stage = "sentinel-verdict";
		if (sentinelInvocation.verdict) {
			if (sentinelInvocation.verdict.verdict === "needs-revision") {
				await setBriefProperties(notion, pageId, {
					status: "Needs Review",
					owner: null,
				});
			} else {
				await setBriefProperties(notion, pageId, { owner: null });
			}
		} else {
			await postComment(
				notion,
				pageId,
				"Sentinel completed without calling setVerdict. Marking Needs Review for manual triage.",
			);
			await setBriefProperties(notion, pageId, {
				status: "Needs Review",
				owner: null,
			});
		}

		stage = "persist-stats";
		await mergeHivemindState(notion, pageId, {
			tokensUsed: tokenBudget.usage,
		});
	} catch (err) {
		console.error("[orchestrator] failed at stage", stage, err);
		await reportChainFailure(notion, pageId, stage, err);
	}
}

async function handleAgentError(
	notion: Client,
	pageId: string,
	agentLabel: string,
	tokenBudget: TokenBudget,
	err: unknown,
): Promise<void> {
	if (err instanceof BudgetExceeded) {
		await mergeHivemindState(notion, pageId, {
			budgetCircuitTripped: true,
			tokensUsed: tokenBudget.usage,
		});
		await postComment(
			notion,
			pageId,
			`Token safety net tripped at ${agentLabel} (used ${tokenBudget.usage} > limit ${TOKEN_BUDGET_LIMIT}). To retry, expand the '🔒 Hivemind internal state' toggle on this brief and clear the JSON.`,
		);
		await setBriefProperties(notion, pageId, {
			status: "Failed",
			owner: null,
		});
		return;
	}

	if (err instanceof ScopeViolation) {
		await postComment(
			notion,
			pageId,
			`Scope violation in ${agentLabel}: ${err.message}. Halting.`,
		);
		await setBriefProperties(notion, pageId, {
			status: "Failed",
			owner: null,
		});
		return;
	}

	throw err;
}

export async function handleBriefApproved(
	notion: Client,
	pageId: string,
): Promise<void> {
	const existing = await notion.comments.list({
		block_id: pageId,
		page_size: 100,
	});
	const alreadyApproved = existing.results.some((c) =>
		c.rich_text.some((rt) => rt.plain_text.includes(APPROVAL_COMMENT)),
	);
	if (alreadyApproved) {
		console.log("[orchestrator] approval comment already present, skipping");
		return;
	}
	await postComment(notion, pageId, APPROVAL_COMMENT);

	try {
		const state = await readHivemindState(notion, pageId);
		const activityPageId = state.activityPageId;
		if (!activityPageId) return;
		const pacer = new Pacer(PACER_CONFIG);
		await logOrchestratorEnd(notion, pacer, activityPageId, true);
	} catch (err) {
		console.warn(
			"[orchestrator] handleBriefApproved: Activity log write skipped:",
			err,
		);
	}
}
