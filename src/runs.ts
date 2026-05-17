// Per-brief Runs database — one row per agent invocation. Provisioned
// alongside the rest of the project subtree by `provisionProject`. Written
// to by the orchestrator (Architect/Sentinel turn boundaries) and by the
// `runDelegation` helper in tools/handlers.ts (sub-agent invocations).
//
// Schema (Phase 6 — see .sisyphus/plans/hivemind-v3-notion-power-user.md §2.3):
//   Name         title       e.g. "🧠 Architect — turn 1"
//   Agent        select      Architect | Scout | Librarian | Oracle | Sentinel | Orchestrator
//   Status       select      queued | running | done | failed
//   Started      date        ISO8601 with time
//   Finished     date        ISO8601 with time; empty while running
//   Duration ms  number      milliseconds (filled on finish/fail)
//   Tokens       number      delta against TokenBudget
//   Tool Calls   number      tool calls consumed
//   Summary      rich_text   1-line summary from done({summary}) or error
//   Verdict      select      approve | needs-revision   (Sentinel only)
//
// Status uses Notion's `select` type, not `status` type, because `status`
// options can't be modified via API after creation (same constraint as the
// Briefs DB Status — see notion.ts).
//
// Views provisioned on creation (best-effort; never blocks):
//   📋 Kanban by Status
//   🤖 Kanban by Agent
//   🕐 Timeline
//   📊 Tokens by agent (chart)
//   📊 Duration by agent (chart)

import type { Client } from "@notionhq/client";
import { isFullDatabase } from "@notionhq/client";
import type { CreateDatabaseParameters } from "@notionhq/client";

import type { Pacer } from "./pacer";
import type { DbIds } from "./state";
import { createView, type ViewType } from "./views";

export const RUNS_DB_TITLE = "📊 Runs";

export type RunAgent =
	| "Architect"
	| "Scout"
	| "Librarian"
	| "Oracle"
	| "Sentinel"
	| "Orchestrator";

export type RunStatus = "queued" | "running" | "done" | "failed";
export type RunVerdict = "approve" | "needs-revision";

type DbPropertiesRequest = NonNullable<
	NonNullable<CreateDatabaseParameters["initial_data_source"]>["properties"]
>;

export const RUNS_DB_PROPERTIES: DbPropertiesRequest = {
	Name: { type: "title", title: {} },
	Agent: {
		type: "select",
		select: {
			options: [
				{ name: "Architect", color: "blue" },
				{ name: "Scout", color: "blue" },
				{ name: "Librarian", color: "purple" },
				{ name: "Oracle", color: "pink" },
				{ name: "Sentinel", color: "green" },
				{ name: "Orchestrator", color: "gray" },
			],
		},
	},
	Status: {
		type: "select",
		select: {
			options: [
				{ name: "queued", color: "default" },
				{ name: "running", color: "yellow" },
				{ name: "done", color: "green" },
				{ name: "failed", color: "red" },
			],
		},
	},
	Started: { type: "date", date: {} },
	Finished: { type: "date", date: {} },
	"Duration ms": { type: "number", number: { format: "number" } },
	Tokens: { type: "number", number: { format: "number" } },
	"Tool Calls": { type: "number", number: { format: "number" } },
	Summary: { type: "rich_text", rich_text: {} },
	Verdict: {
		type: "select",
		select: {
			options: [
				{ name: "approve", color: "green" },
				{ name: "needs-revision", color: "orange" },
			],
		},
	},
};

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

async function createRunsDatabase(
	notion: Client,
	projectRootId: string,
): Promise<DbIds> {
	const res = await notion.databases.create({
		parent: { type: "page_id", page_id: projectRootId },
		title: [{ type: "text", text: { content: RUNS_DB_TITLE } }],
		initial_data_source: { properties: RUNS_DB_PROPERTIES },
	});
	if (!isFullDatabase(res)) {
		throw new Error(
			"provisionRunsDb: databases.create returned partial response",
		);
	}
	const primary = res.data_sources[0];
	if (!primary) {
		throw new Error("provisionRunsDb: created Runs database has no data source");
	}
	return { dbId: res.id, dsId: primary.id };
}

/**
 * Ensure the Runs database exists for a brief's project subtree. Idempotent:
 * if `existing` is provided (from HivemindState), it's reused as-is; otherwise
 * we look for a child_database titled `📊 Runs` under the project root, and
 * fall back to creating a new one.
 *
 * Provisioning is rare (once per brief) and the SDK's built-in 429 retry
 * handles transient overload, so no Pacer is required at this layer. The
 * Pacer IS required for the hot-path write helpers below.
 */
export async function ensureRunsDatabase(args: {
	notion: Client;
	projectRootId: string;
	existing?: DbIds;
	existingChildDbId?: string;
}): Promise<DbIds> {
	const { notion, projectRootId, existing, existingChildDbId } = args;
	if (existing) return existing;
	if (existingChildDbId) {
		const db = await notion.databases.retrieve({
			database_id: existingChildDbId,
		});
		if (!isFullDatabase(db)) {
			throw new Error(
				`ensureRunsDatabase: databases.retrieve returned partial response for ${existingChildDbId}`,
			);
		}
		const primary = db.data_sources[0];
		if (!primary) {
			throw new Error(
				`ensureRunsDatabase: database ${existingChildDbId} has no data sources`,
			);
		}
		return { dbId: db.id, dsId: primary.id };
	}
	return createRunsDatabase(notion, projectRootId);
}

interface RunsPropertyIds {
	agent: string;
	status: string;
	started: string;
	finished: string;
	tokens: string;
	duration: string;
}

async function getRunsPropertyIds(
	notion: Client,
	dsId: string,
): Promise<RunsPropertyIds | null> {
	try {
		const ds = await notion.dataSources.retrieve({ data_source_id: dsId });
		const props = (ds as unknown as {
			properties: Record<string, { id: string; type: string }>;
		}).properties;
		const lookup = (name: string): string | undefined => props[name]?.id;
		const agent = lookup("Agent");
		const status = lookup("Status");
		const started = lookup("Started");
		const finished = lookup("Finished");
		const tokens = lookup("Tokens");
		const duration = lookup("Duration ms");
		if (
			!agent ||
			!status ||
			!started ||
			!finished ||
			!tokens ||
			!duration
		) {
			return null;
		}
		return { agent, status, started, finished, tokens, duration };
	} catch (err) {
		console.warn("[runs] getRunsPropertyIds failed:", err);
		return null;
	}
}

/**
 * Best-effort: ensure the Runs DB has the headline observability views. If
 * a view of the same name already exists, the Notion API rejects the create
 * with a duplicate-name error which we swallow. View configuration shapes
 * are documented in
 *   https://developers.notion.com/guides/data-apis/working-with-views
 */
export async function ensureRunsViews(args: {
	notion: Client;
	runs: DbIds;
}): Promise<void> {
	const { notion, runs } = args;
	const propIds = await getRunsPropertyIds(notion, runs.dsId);
	if (!propIds) {
		console.warn(
			"[runs] skipping view enrichment — could not resolve property IDs",
		);
		return;
	}
	const views: Array<{ name: string; type: ViewType; configuration: Record<string, unknown> }> = [
		{
			name: "📋 Kanban by Status",
			type: "board",
			configuration: {
				type: "board",
				group_by: {
					type: "select",
					property_id: propIds.status,
					group_by: "value",
				},
			},
		},
		{
			name: "🤖 Kanban by Agent",
			type: "board",
			configuration: {
				type: "board",
				group_by: {
					type: "select",
					property_id: propIds.agent,
					group_by: "value",
				},
			},
		},
		{
			name: "🕐 Timeline",
			type: "timeline",
			configuration: {
				type: "timeline",
				start_property_id: propIds.started,
				end_property_id: propIds.finished,
			},
		},
		{
			name: "📊 Tokens by agent",
			type: "chart",
			configuration: {
				type: "chart",
				chart_type: "column",
				x_axis: { property_id: propIds.agent },
				y_axis: {
					aggregation: "sum",
					property_id: propIds.tokens,
				},
			},
		},
		{
			name: "📊 Duration by agent",
			type: "chart",
			configuration: {
				type: "chart",
				chart_type: "column",
				x_axis: { property_id: propIds.agent },
				y_axis: {
					aggregation: "average",
					property_id: propIds.duration,
				},
			},
		},
	];

	for (const view of views) {
		try {
			await createView(notion, {
				database_id: runs.dbId,
				data_source_id: runs.dsId,
				name: view.name,
				type: view.type,
				configuration: view.configuration,
			});
		} catch (err) {
			// Duplicate-name failures are expected on re-provision.
			const msg = err instanceof Error ? err.message : String(err);
			if (!/already exists|duplicate/i.test(msg)) {
				console.warn(`[runs] view "${view.name}" create failed:`, err);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

function truncateRich(text: string, max = 1900): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

function richText(content: string): { type: "text"; text: { content: string } }[] {
	return [{ type: "text", text: { content: truncateRich(content) } }];
}

/**
 * Insert a `running` row in the Runs DB. Returns the new page id, which the
 * caller must hand back to `finishRun` / `failRun` so the row can be updated
 * in place when the agent completes.
 */
export interface RunRowIds {
	runRowId: string;
	activityRowId?: string;
}

export async function startRun(args: {
	notion: Client;
	pacer: Pacer;
	dsId: string;
	agent: RunAgent;
	label: string;
	mirror?: {
		activityDsId: string;
		briefUrl: string;
		briefTitle: string;
	};
}): Promise<RunRowIds> {
	const { notion, pacer, dsId, agent, label, mirror } = args;
	const startedIso = new Date().toISOString();
	await pacer.acquire();
	const res = await notion.pages.create({
		parent: { type: "data_source_id", data_source_id: dsId },
		properties: {
			Name: { title: richText(label) },
			Agent: { select: { name: agent } },
			Status: { select: { name: "running" } },
			Started: { date: { start: startedIso } },
		},
	});

	let activityRowId: string | undefined;
	if (mirror) {
		try {
			await pacer.acquire();
			const mirrorRes = await notion.pages.create({
				parent: {
					type: "data_source_id",
					data_source_id: mirror.activityDsId,
				},
				properties: {
					Name: { title: richText(`${label} · ${mirror.briefTitle}`) },
					Agent: { select: { name: agent } },
					Status: { select: { name: "running" } },
					Started: { date: { start: startedIso } },
					"Brief URL": { url: mirror.briefUrl },
					"Brief Title": { rich_text: richText(mirror.briefTitle) },
				},
			});
			activityRowId = mirrorRes.id;
		} catch (err) {
			console.warn("[runs] activity mirror startRun failed:", err);
		}
	}

	return { runRowId: res.id, activityRowId };
}

export async function finishRun(args: {
	notion: Client;
	pacer: Pacer;
	runRowId: string;
	activityRowId?: string;
	durationMs: number;
	tokens: number;
	toolCalls: number;
	summary?: string;
	verdict?: RunVerdict;
}): Promise<void> {
	const {
		notion,
		pacer,
		runRowId,
		activityRowId,
		durationMs,
		tokens,
		toolCalls,
		summary,
		verdict,
	} = args;
	const finishedIso = new Date().toISOString();
	const properties: Parameters<typeof notion.pages.update>[0]["properties"] = {
		Status: { select: { name: "done" } },
		Finished: { date: { start: finishedIso } },
		"Duration ms": { number: durationMs },
		Tokens: { number: tokens },
		"Tool Calls": { number: toolCalls },
	};
	if (summary) {
		properties.Summary = { rich_text: richText(summary) };
	}
	if (verdict) {
		properties.Verdict = { select: { name: verdict } };
	}
	try {
		await pacer.acquire();
		await notion.pages.update({ page_id: runRowId, properties });
	} catch (err) {
		console.warn("[runs] finishRun failed for", runRowId, err);
	}

	if (activityRowId) {
		try {
			await pacer.acquire();
			await notion.pages.update({
				page_id: activityRowId,
				properties: {
					Status: { select: { name: "done" } },
					Finished: { date: { start: finishedIso } },
					Tokens: { number: tokens },
				},
			});
		} catch (err) {
			console.warn(
				"[runs] activity mirror finishRun failed for",
				activityRowId,
				err,
			);
		}
	}
}

export async function failRun(args: {
	notion: Client;
	pacer: Pacer;
	runRowId: string;
	activityRowId?: string;
	durationMs: number;
	tokens: number;
	errorMsg: string;
}): Promise<void> {
	const { notion, pacer, runRowId, activityRowId, durationMs, tokens, errorMsg } =
		args;
	const finishedIso = new Date().toISOString();
	try {
		await pacer.acquire();
		await notion.pages.update({
			page_id: runRowId,
			properties: {
				Status: { select: { name: "failed" } },
				Finished: { date: { start: finishedIso } },
				"Duration ms": { number: durationMs },
				Tokens: { number: tokens },
				Summary: { rich_text: richText(`❌ ${errorMsg}`) },
			},
		});
	} catch (err) {
		console.warn("[runs] failRun failed for", runRowId, err);
	}

	if (activityRowId) {
		try {
			await pacer.acquire();
			await notion.pages.update({
				page_id: activityRowId,
				properties: {
					Status: { select: { name: "failed" } },
					Finished: { date: { start: finishedIso } },
					Tokens: { number: tokens },
				},
			});
		} catch (err) {
			console.warn(
				"[runs] activity mirror failRun failed for",
				activityRowId,
				err,
			);
		}
	}
}
