// Orchestrator: drives a brief through the OMO chain.
//
// Flow per webhook trigger (status → Triaged):
//   1. Read Hivemind State → if budget circuit tripped, bail with comment.
//   2. Classify if Category is unset → write back to the Briefs DB.
//   3. provisionProject (idempotent: rehydrates from state on repeat).
//   4. Build per-chain pacer / token budget / scope guard.
//   5. Decide chain order via Drafts DB query:
//      - latest draft status = needs-revision → retry mode → [primaryDrafter, Sentinel]
//      - otherwise → full CHAINS[category]
//   6. For each agent: status/owner update → Activity "start" → invokeAgent → Activity "finish".
//   7. After Sentinel: read ctx.verdict, drive status transition, break.
//
// Failure modes:
//   - BudgetExceeded: persist tripped flag + comment + Status=Failed.
//   - ScopeViolation: comment + Status=Failed.
//   - Anything else: rethrow → reportChainFailure (stage-tagged error block + Status=Failed).

import type { Client } from "@notionhq/client";

import { invokeAgent, type BriefMetadata } from "./agents";
import { BudgetExceeded, TokenBudget } from "./budget";
import { ALL_CATEGORIES, classifyBrief, type Category } from "./classify";
import { CHAINS, type AgentName } from "./chains";
import {
	appendBlocks,
	bullet,
	type BriefContext,
	postComment,
	reportChainFailure,
	setBriefProperties,
} from "./notion";
import { Pacer } from "./pacer";
import { provisionProject, type ProjectIds } from "./provision";
import { ScopeGuard, ScopeViolation } from "./scope";
import { mergeHivemindState, readHivemindState } from "./state";

const APPROVAL_COMMENT = "✅ Hivemind approved. The swarm is at rest.";

const PACER_CONFIG = { rps: 2.5, burst: 5 } as const;
const TOKEN_BUDGET_LIMIT = 200_000;

type ActivityAgent =
	| "Scout"
	| "Forge"
	| "Scribe"
	| "Sentinel"
	| "Orchestrator";

type ActivityAction = "start" | "finish" | "error" | "verdict";

interface ActivityArgs {
	activityPageId: string;
	agent: ActivityAgent;
	action: ActivityAction;
	stepCount?: number;
	tokensIn?: number;
	tokensOut?: number;
	durationMs?: number;
	cacheCreate?: number;
	cacheRead?: number;
	contextEditsApplied?: number;
}

function getPrimaryDrafter(category: Category): "Forge" | "Scribe" {
	return category === "writing" ? "Scribe" : "Forge";
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

/**
 * Determine whether this is a retry of a previously-bounced brief.
 *
 * Primary signal (Drafts DB path): latest draft has Status="needs-revision".
 * Inline-category path (writing/quick): we always run the full chain on retry.
 * Scout re-running refreshes Plan; writeAnswer is idempotent (replaces prior
 * content). The extra Scout pass is a small cost relative to keeping the
 * orchestrator simple — no separate retry signal to maintain for inline.
 * Fallback (v0 brief migration): "## Forge" heading on the brief body.
 */
async function detectRetryMode(
	notion: Client,
	draftsDsId: string | undefined,
	briefBody: string,
): Promise<boolean> {
	if (!draftsDsId) {
		return /^##\s+.*Forge/im.test(briefBody);
	}
	try {
		const res = await notion.dataSources.query({
			data_source_id: draftsDsId,
			sorts: [{ property: "Iteration", direction: "descending" }],
			page_size: 1,
		});
		const latest = res.results[0];
		if (latest && "properties" in latest) {
			const statusProp = latest.properties.Status as
				| { type?: string; select?: { name?: string } | null }
				| undefined;
			if (statusProp?.type === "select" && statusProp.select) {
				return statusProp.select.name === "needs-revision";
			}
			return false;
		}
	} catch (err) {
		console.warn("[chain] detectRetryMode: drafts query failed", err);
	}

	return /^##\s+.*Forge/im.test(briefBody);
}

/**
 * Append a single bullet to the project Activity page. Best-effort: a logging
 * failure must not break the chain, so we swallow errors here.
 */
async function logActivity(
	notion: Client,
	pacer: Pacer,
	args: ActivityArgs,
): Promise<void> {
	try {
		await pacer.acquire();
		const when = new Date().toISOString();
		const parts = [`${when} — ${args.agent} ${args.action}`];
		if (typeof args.stepCount === "number") parts.push(`steps=${args.stepCount}`);
		if (typeof args.tokensIn === "number") parts.push(`tokens_in=${args.tokensIn}`);
		if (typeof args.tokensOut === "number") parts.push(`tokens_out=${args.tokensOut}`);
		if (typeof args.durationMs === "number") parts.push(`duration_ms=${args.durationMs}`);
		if (typeof args.cacheCreate === "number" && args.cacheCreate > 0) parts.push(`cache_create=${args.cacheCreate}`);
		if (typeof args.cacheRead === "number" && args.cacheRead > 0) parts.push(`cache_read=${args.cacheRead}`);
		if (typeof args.contextEditsApplied === "number" && args.contextEditsApplied > 0) parts.push(`ctx_edits=${args.contextEditsApplied}`);
		await appendBlocks(notion, args.activityPageId, [bullet(parts.join(" · "))]);
	} catch (err) {
		console.warn(
			`[chain] logActivity(${args.agent}/${args.action}) failed:`,
			err,
		);
	}
}

export async function runChainForBrief(args: {
	notion: Client;
	brief: BriefContext;
	botUserId: string | undefined;
}): Promise<void> {
	const { notion, brief } = args;
	// args.botUserId is preserved on the public signature for index.ts compat;
	// retry detection now reads structured state from the Drafts DB instead of
	// scanning comments, so the bot id is no longer required here.

	const pageId = brief.pageId;
	let stage = "start";

	try {
		const state = await readHivemindState(notion, pageId);

		if (state.budgetCircuitTripped) {
			await postComment(
				notion,
				pageId,
				"Budget circuit-breaker tripped on a previous run. Manually reset Hivemind State (clear the JSON or unset budgetCircuitTripped) to retry.",
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

		stage = "retry-detect";
		const retryMode = await detectRetryMode(
			notion,
			projectIds.dbs.drafts?.dsId,
			brief.body,
		);

		const agents: readonly AgentName[] = retryMode
			? [getPrimaryDrafter(category), "Sentinel"]
			: CHAINS[category];

		console.log(
			"[chain]",
			pageId,
			"category=",
			category,
			"retry=",
			retryMode,
			"agents=",
			agents.join("→"),
		);

		for (const agentName of agents) {
			stage = `agent:${agentName}`;
			await setBriefProperties(notion, pageId, {
				status: "In Progress",
				owner: agentName,
			});
			await logActivity(notion, pacer, {
				activityPageId,
				agent: agentName,
				action: "start",
			});

			const tStart = Date.now();
			const tokensBefore = tokenBudget.usage;
			let result: Awaited<ReturnType<typeof invokeAgent>>["result"];
			let verdict: Awaited<ReturnType<typeof invokeAgent>>["verdict"];

			try {
				const invocation = await invokeAgent({
					agent: agentName,
					category,
					notion,
					briefMetadata,
					projectIds,
					scopeGuard,
					pacer,
					tokenBudget,
				});
				result = invocation.result;
				verdict = invocation.verdict;
			} catch (err) {
				const durationMs = Date.now() - tStart;
				const tokensDelta = tokenBudget.usage - tokensBefore;
				await logActivity(notion, pacer, {
					activityPageId,
					agent: agentName,
					action: "error",
					durationMs,
					tokensOut: tokensDelta,
				});

				if (err instanceof BudgetExceeded) {
					await mergeHivemindState(notion, pageId, {
						budgetCircuitTripped: true,
						tokensUsed: tokenBudget.usage,
					});
					await postComment(
						notion,
						pageId,
						`Token budget exceeded (used ${tokenBudget.usage} > limit ${TOKEN_BUDGET_LIMIT}). Halting chain. Reset Hivemind State to retry.`,
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
						`Scope violation: ${err.message}. Halting chain.`,
					);
					await setBriefProperties(notion, pageId, {
						status: "Failed",
						owner: null,
					});
					return;
				}

				throw err;
			}

			const durationMs = Date.now() - tStart;
			const tokensDelta = tokenBudget.usage - tokensBefore;
			await logActivity(notion, pacer, {
				activityPageId,
				agent: agentName,
				action: "finish",
				stepCount: result.toolCallsConsumed,
				durationMs,
				tokensOut: tokensDelta,
				cacheCreate: result.cacheStats.cacheCreationInputTokens,
				cacheRead: result.cacheStats.cacheReadInputTokens,
				contextEditsApplied: result.contextEditsApplied,
			});

			if (agentName === "Sentinel") {
				stage = "sentinel-verdict";
				if (verdict) {
					await logActivity(notion, pacer, {
						activityPageId,
						agent: agentName,
						action: "verdict",
					});
					// setVerdict already drove the Status transition based on
					// verdict + category (Done for inline-approve, Needs Review
					// for drafts-approve, untouched for needs-revision). We
					// just clear the owner here so the kanban no longer shows
					// "Sentinel" against the brief.
					if (verdict.verdict === "needs-revision") {
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
				break;
			}
		}

		stage = "persist-stats";
		await mergeHivemindState(notion, pageId, {
			tokensUsed: tokenBudget.usage,
		});
	} catch (err) {
		console.error("[chain] failed at stage", stage, err);
		await reportChainFailure(notion, pageId, stage, err);
	}
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
		console.log("[chain] approval comment already present, skipping");
		return;
	}
	await postComment(notion, pageId, APPROVAL_COMMENT);

	// Best-effort: append an Orchestrator "finish" row to the Activity DB so
	// the brief's history shows the human-approved terminal transition. We
	// don't fail the approval flow if the activity log is unavailable (e.g.
	// v0 briefs that never provisioned a project subtree).
	try {
		const state = await readHivemindState(notion, pageId);
		const activityPageId = state.activityPageId;
		if (!activityPageId) return;
		const pacer = new Pacer(PACER_CONFIG);
		await logActivity(notion, pacer, {
			activityPageId,
			agent: "Orchestrator",
			action: "finish",
		});
	} catch (err) {
		console.warn(
			"[chain] handleBriefApproved: Activity log write skipped:",
			err,
		);
	}
}
