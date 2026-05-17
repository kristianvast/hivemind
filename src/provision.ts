// Per-brief project subtree provisioner.
//
// Unified layout (Phase 4 — single shape for every brief, regardless of
// Category):
//
//   📁 {briefTitle}              (root page)
//   ├── 📄 Answer                (heading_2 — anchor for writeAnswer)
//   ├── …answer content…         (only present if the Architect chose writeAnswer)
//   ├── Plan                     (child page — Context/Approach/Decisions/Sources/Open Questions/Status)
//   ├── Drafts                   (database — iterating artifacts; empty if Architect chose writeAnswer)
//   ├── Sources                  (database — captured external references)
//   ├── Decisions                (database — recorded architectural choices)
//   ├── Open Questions           (database — blockers / human-input requests)
//   └── Activity                 (child page — chronological agent run log)
//
// The Architect picks writeAnswer (inline prose) vs createDraft (iterative
// artifact) at runtime. Both shapes are provisioned eagerly so the choice
// is purely a tool call away. Whichever shape isn't used stays empty.
//
// Ordering trick: the Answer heading is created BEFORE the Plan / Drafts /
// Activity child blocks so it sits at the top of the root. writeAnswer
// then uses Notion's `after` insert parameter to slot content between the
// anchor heading and the child_page navigation blocks below.
//
// Idempotency: walk-by-name on every step; state persisted after root
// creation and after every step, so partial failures recover cleanly. The
// `category` parameter is informational metadata only — it drives the
// project icon and dashboard caption, never the layout.

import type { Client } from "@notionhq/client";
import { isFullDatabase, isFullPage } from "@notionhq/client";
import type {
	CreateDatabaseParameters,
	CreatePageParameters,
} from "@notionhq/client";

import type { Category } from "./classify";
import {
	appendBlocks,
	callout,
	columnList,
	divider,
	heading1,
	heading2,
	heading3,
	paragraph,
	tableOfContents,
	todoBlock,
	toggle,
} from "./notion";
import {
	ensureRunsDatabase,
	ensureRunsViews,
	RUNS_DB_TITLE,
} from "./runs";
import { readHivemindState, writeHivemindState } from "./state";
import type { DbIds, HivemindState } from "./state";

export type { DbIds } from "./state";

const PROJECT_URL_PROP = "📁 Project";

const ANSWER_ANCHOR_TEXT = "📄 Answer";

/**
 * Post-provision shape. Every field is non-nullable because the unified
 * Phase 4 layout always provisions every artifact. Old briefs that were
 * provisioned under the v1/v2-pre-Phase-4 shape are healed on the next
 * provisionProject() call (idempotent), filling in any missing pieces.
 *
 * Phase 6 adds `runs` — the per-brief Runs database that captures one row
 * per agent invocation for observability. Optional in `ProjectIds` while
 * Phase 6 rolls out so existing briefs without a Runs DB don't 500; once
 * baked the field becomes required.
 */
export interface ProjectIds {
	projectRootId: string;
	planPageId: string;
	activityPageId: string;
	answerAnchorBlockId: string;
	dbs: {
		drafts: DbIds;
		sources: DbIds;
		decisions: DbIds;
		openQuestions: DbIds;
		runs?: DbIds;
	};
}

type DbPropertiesRequest = NonNullable<
	NonNullable<CreateDatabaseParameters["initial_data_source"]>["properties"]
>;

const PLAN_PAGE_TITLE = "Plan";
const ACTIVITY_PAGE_TITLE = "Activity";
const DRAFTS_DB_TITLE = "Drafts";
const SOURCES_DB_TITLE = "Sources";
const DECISIONS_DB_TITLE = "Decisions";
const OPEN_QUESTIONS_DB_TITLE = "Open Questions";

const ROOT_APPROVED_VIEW_TITLE = "✅ Approved output";
const ROOT_LATEST_VIEW_TITLE = "🕓 Latest iteration";
const ROOT_NEEDS_REVIEW_VIEW_TITLE = "👀 Needs review";
const ROOT_OPEN_QUESTIONS_VIEW_TITLE = "❓ Open questions";
const ROOT_LATEST_DECISIONS_VIEW_TITLE = "✅ Latest decisions";
const ROOT_SOURCES_VIEW_TITLE = "🔎 Sources";

function projectIcon(
	category: Category | undefined,
): NonNullable<CreatePageParameters["icon"]> {
	const emoji =
		category === "visual-engineering"
			? "🎨"
			: category === "ultrabrain" || category === "deep"
				? "🧠"
				: category === "writing"
					? "✍️"
					: "🐝";
	return { type: "emoji", emoji };
}

const PROJECT_COVER: NonNullable<CreatePageParameters["cover"]> = {
	type: "external",
	external: {
		url: "https://images.unsplash.com/photo-1495107334309-fcf20504a5ab?auto=format&fit=crop&w=2400&q=80",
	},
};

export const PLAN_SECTIONS = [
	"Context",
	"Approach",
	"Decisions",
	"Sources",
	"Open Questions",
	"Status",
] as const;
export type PlanSection = (typeof PLAN_SECTIONS)[number];

const PLAN_PAGE_CHILDREN: NonNullable<CreatePageParameters["children"]> = [
	callout(
		"How to read this plan",
		"🧭",
		"blue_background",
		[
			paragraph(
				"The top-level sections stay short and decision-oriented. Expand the toggles for detailed evidence, assumptions, rejected paths, and handoff notes.",
			),
		],
	),
	tableOfContents(),
	divider(),
	heading2("Context"),
	callout("What matters about the brief, audience, constraints, and success criteria.", "🎯", "gray_background"),
	toggle("Research details", [paragraph("_Pending research_")]),
	heading2("Approach"),
	callout("Recommended path through the work, kept concise enough for a human reviewer to scan.", "🛠️", "gray_background"),
	toggle("Assumptions and rejected paths", [paragraph("_Pending Architect_")]),
	heading2("Decisions"),
	callout("Significant choices made by the swarm, with rationale.", "✅", "green_background"),
	paragraph("_Pending Architect_"),
	heading2("Sources"),
	callout("Evidence and references the agents relied on.", "🔎", "yellow_background"),
	paragraph("_Pending research_"),
	heading2("Open Questions"),
	callout("Human input needed, unresolved risks, or follow-up opportunities.", "❓", "orange_background"),
	paragraph("_Pending agents_"),
	heading2("Status"),
	callout("Current chain state, latest verdict, and next action.", "📍", "purple_background"),
	todoBlock("Context captured", false),
	todoBlock("Deliverable produced", false),
	todoBlock("Sentinel review complete", false),
];

function rootDashboardChildren(
	category: Category | undefined,
): NonNullable<CreatePageParameters["children"]> {
	const categoryLine = category ? `Category: ${category}` : "Category: (unset)";
	return [
		heading1("Hivemind workspace"),
		callout(
			"This page is the command center for the brief: read the overview, open the deliverable, then inspect Plan and Activity if you want the trail.",
			"🐝",
			"yellow_background",
		),
		columnList([
			{
				widthRatio: 0.34,
				children: [
					heading3("Status"),
					paragraph("Provisioned"),
					paragraph(categoryLine),
				],
			},
			{
				widthRatio: 0.33,
				children: [
					heading3("Deliverable"),
					paragraph(
						"Either inline under the 📄 Answer section above, or as a row in the Drafts database — whichever shape the Architect picks at runtime.",
					),
				],
			},
			{
				widthRatio: 0.33,
				children: [
					heading3("Next action"),
					paragraph("Watch the Status section and Activity page for progress."),
				],
			},
		]),
		tableOfContents(),
		divider(),
	];
}

const ACTIVITY_PAGE_CHILDREN: NonNullable<CreatePageParameters["children"]> = [
	paragraph("_Chronological log of agent runs. Newest entries at the bottom._"),
];

const DRAFTS_DB_PROPERTIES: DbPropertiesRequest = {
	Name: { type: "title", title: {} },
	Iteration: { type: "number", number: {} },
	Status: {
		type: "select",
		select: {
			options: [
				{ name: "draft", color: "default" },
				{ name: "in-review", color: "yellow" },
				{ name: "needs-revision", color: "orange" },
				{ name: "approved", color: "green" },
			],
		},
	},
	"Author Agent": {
		type: "select",
		select: {
			options: [
				{ name: "Architect", color: "blue" },
				{ name: "Forge", color: "orange" },
				{ name: "Scribe", color: "purple" },
			],
		},
	},
	"Last Verdict": {
		type: "select",
		select: {
			options: [
				{ name: "approve", color: "green" },
				{ name: "needs-revision", color: "orange" },
			],
		},
	},
	Summary: { type: "rich_text", rich_text: {} },
	Sources: { type: "url", url: {} },
	"Risk Level": {
		type: "select",
		select: {
			options: [
				{ name: "low", color: "green" },
				{ name: "medium", color: "yellow" },
				{ name: "high", color: "red" },
			],
		},
	},
	"Quality Score": { type: "number", number: { format: "number" } },
	"Review Count": { type: "number", number: { format: "number" } },
	"Approved At": { type: "date", date: {} },
	"Output Type": {
		type: "select",
		select: {
			options: [
				{ name: "analysis", color: "blue" },
				{ name: "implementation", color: "orange" },
				{ name: "writing", color: "purple" },
				{ name: "design", color: "pink" },
				{ name: "research", color: "gray" },
			],
		},
	},
	Proof: { type: "files", files: {} },
};

const DRAFTS_DB_ENRICHMENT_PROPERTIES: DbPropertiesRequest = {
	"Risk Level": DRAFTS_DB_PROPERTIES["Risk Level"],
	"Quality Score": DRAFTS_DB_PROPERTIES["Quality Score"],
	"Review Count": DRAFTS_DB_PROPERTIES["Review Count"],
	"Approved At": DRAFTS_DB_PROPERTIES["Approved At"],
	"Output Type": DRAFTS_DB_PROPERTIES["Output Type"],
	Proof: DRAFTS_DB_PROPERTIES.Proof,
};

const SOURCES_DB_PROPERTIES: DbPropertiesRequest = {
	Name: { type: "title", title: {} },
	URL: { type: "url", url: {} },
	Summary: { type: "rich_text", rich_text: {} },
	"Captured By": {
		type: "select",
		select: {
			options: [
				{ name: "Architect", color: "blue" },
				{ name: "Scout", color: "blue" },
				{ name: "Librarian", color: "purple" },
				{ name: "Oracle", color: "pink" },
				{ name: "Sentinel", color: "green" },
			],
		},
	},
	"Captured At": { type: "date", date: {} },
};

const DECISIONS_DB_PROPERTIES: DbPropertiesRequest = {
	Name: { type: "title", title: {} },
	Choice: { type: "rich_text", rich_text: {} },
	Rationale: { type: "rich_text", rich_text: {} },
	"Alternatives Considered": { type: "rich_text", rich_text: {} },
	"Made By": {
		type: "select",
		select: {
			options: [
				{ name: "Architect", color: "blue" },
				{ name: "Scout", color: "blue" },
				{ name: "Librarian", color: "purple" },
				{ name: "Oracle", color: "pink" },
				{ name: "Sentinel", color: "green" },
				{ name: "Human", color: "gray" },
			],
		},
	},
	"Made At": { type: "date", date: {} },
};

const OPEN_QUESTIONS_DB_PROPERTIES: DbPropertiesRequest = {
	Name: { type: "title", title: {} },
	"Why It Matters": { type: "rich_text", rich_text: {} },
	Status: {
		type: "select",
		select: {
			options: [
				{ name: "open", color: "orange" },
				{ name: "answered", color: "green" },
			],
		},
	},
	Answer: { type: "rich_text", rich_text: {} },
	"Asked By": {
		type: "select",
		select: {
			options: [
				{ name: "Architect", color: "blue" },
				{ name: "Scout", color: "blue" },
				{ name: "Librarian", color: "purple" },
				{ name: "Oracle", color: "pink" },
				{ name: "Sentinel", color: "green" },
			],
		},
	},
	"Asked At": { type: "date", date: {} },
};

interface RootScan {
	childPagesByTitle: Map<string, string>;
	childDbsByTitle: Map<string, string>;
}

async function scanRootChildren(
	notion: Client,
	rootId: string,
): Promise<RootScan> {
	const childPagesByTitle = new Map<string, string>();
	const childDbsByTitle = new Map<string, string>();
	let cursor: string | undefined;
	do {
		const res = await notion.blocks.children.list({
			block_id: rootId,
			start_cursor: cursor,
			page_size: 100,
		});
		for (const block of res.results) {
			if (!("type" in block)) continue;
			if (block.type === "child_page") {
				childPagesByTitle.set(block.child_page.title, block.id);
			} else if (block.type === "child_database") {
				childDbsByTitle.set(block.child_database.title, block.id);
			}
		}
		cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	} while (cursor);
	return { childPagesByTitle, childDbsByTitle };
}

async function resolveDsId(
	notion: Client,
	databaseId: string,
): Promise<string> {
	const db = await notion.databases.retrieve({ database_id: databaseId });
	if (!isFullDatabase(db)) {
		throw new Error(
			`provisionProject: databases.retrieve returned partial response for ${databaseId}`,
		);
	}
	const primary = db.data_sources[0];
	if (!primary) {
		throw new Error(
			`provisionProject: database ${databaseId} has no data sources`,
		);
	}
	return primary.id;
}

async function createDraftsDatabase(
	notion: Client,
	rootId: string,
): Promise<DbIds> {
	const res = await notion.databases.create({
		parent: { type: "page_id", page_id: rootId },
		title: [{ type: "text", text: { content: DRAFTS_DB_TITLE } }],
		initial_data_source: { properties: DRAFTS_DB_PROPERTIES },
	});
	if (!isFullDatabase(res)) {
		throw new Error(
			"provisionProject: databases.create returned partial response for Drafts",
		);
	}
	const primary = res.data_sources[0];
	if (!primary) {
		throw new Error(
			"provisionProject: created Drafts database has no data sources",
		);
	}
	return { dbId: res.id, dsId: primary.id };
}

async function createProjectDatabase(
	notion: Client,
	rootId: string,
	title: string,
	properties: DbPropertiesRequest,
): Promise<DbIds> {
	const res = await notion.databases.create({
		parent: { type: "page_id", page_id: rootId },
		title: [{ type: "text", text: { content: title } }],
		initial_data_source: { properties },
	});
	if (!isFullDatabase(res)) {
		throw new Error(
			`provisionProject: databases.create returned partial response for ${title}`,
		);
	}
	const primary = res.data_sources[0];
	if (!primary) {
		throw new Error(
			`provisionProject: created ${title} database has no data sources`,
		);
	}
	return { dbId: res.id, dsId: primary.id };
}

async function findOrCreateProjectDatabase(
	notion: Client,
	rootId: string,
	scan: RootScan,
	title: string,
	properties: DbPropertiesRequest,
): Promise<DbIds> {
	const existingDbId = scan.childDbsByTitle.get(title);
	if (existingDbId) {
		return { dbId: existingDbId, dsId: await resolveDsId(notion, existingDbId) };
	}
	return createProjectDatabase(notion, rootId, title, properties);
}

interface NotionViews {
	list(args: { database_id?: string; data_source_id?: string }): Promise<{ results: { id: string }[] }>;
	retrieve(args: { view_id: string }): Promise<{ id: string; name?: string }>;
	create(args: Record<string, unknown>): Promise<unknown>;
}

function notionViews(notion: Client): NotionViews | undefined {
	return (notion as unknown as { views?: NotionViews }).views;
}

async function viewNames(notion: Client, dbId: string): Promise<Set<string>> {
	const views = notionViews(notion);
	if (!views) return new Set();
	const listed = await views.list({ database_id: dbId });
	const names = new Set<string>();
	for (const ref of listed.results) {
		const view = await views.retrieve({ view_id: ref.id });
		if (typeof view.name === "string") names.add(view.name);
	}
	return names;
}

async function ensureView(
	notion: Client,
	databaseId: string,
	dataSourceId: string,
	name: string,
	type: string,
	extra: Record<string, unknown> = {},
): Promise<void> {
	const views = notionViews(notion);
	if (!views) return;
	const existing = await viewNames(notion, databaseId);
	if (existing.has(name)) return;
	await views.create({
		database_id: databaseId,
		data_source_id: dataSourceId,
		name,
		type,
		...extra,
	});
}

async function ensureLinkedView(
	notion: Client,
	rootId: string,
	scan: RootScan,
	dataSourceId: string,
	name: string,
	type: string,
	extra: Record<string, unknown> = {},
): Promise<void> {
	const views = notionViews(notion);
	if (!views || scan.childDbsByTitle.has(name)) return;
	await views.create({
		create_database: { parent: { type: "page_id", page_id: rootId } },
		data_source_id: dataSourceId,
		name,
		type,
		...extra,
	});
}

async function enrichDraftViews(notion: Client, drafts: DbIds): Promise<void> {
	await ensureView(notion, drafts.dbId, drafts.dsId, "Approved", "table", {
		filter: { property: "Status", select: { equals: "approved" } },
		sorts: [{ property: "Approved At", direction: "descending" }],
	});
	await ensureView(notion, drafts.dbId, drafts.dsId, "Latest", "table", {
		sorts: [{ property: "Iteration", direction: "descending" }],
	});
	await ensureView(notion, drafts.dbId, drafts.dsId, "Needs review", "table", {
		filter: { property: "Status", select: { equals: ["in-review", "needs-revision"] } },
		sorts: [{ property: "Iteration", direction: "descending" }],
	});
	await ensureView(notion, drafts.dbId, drafts.dsId, "Risk review", "table", {
		sorts: [
			{ property: "Risk Level", direction: "descending" },
			{ property: "Iteration", direction: "descending" },
		],
	});
	await ensureView(notion, drafts.dbId, drafts.dsId, "Proof gallery", "gallery", {
		filter: { property: "Proof", files: { is_not_empty: true } },
	});
}

async function enrichProjectDashboard(
	notion: Client,
	rootId: string,
	dbs: {
		drafts: DbIds;
		sources: DbIds;
		decisions: DbIds;
		openQuestions: DbIds;
	},
): Promise<void> {
	try {
		const scan = await scanRootChildren(notion, rootId);
		await enrichDraftViews(notion, dbs.drafts);
		await ensureLinkedView(notion, rootId, scan, dbs.drafts.dsId, ROOT_APPROVED_VIEW_TITLE, "table", {
			filter: { property: "Status", select: { equals: "approved" } },
			sorts: [{ property: "Approved At", direction: "descending" }],
		});
		await ensureLinkedView(notion, rootId, scan, dbs.drafts.dsId, ROOT_LATEST_VIEW_TITLE, "table", {
			sorts: [{ property: "Iteration", direction: "descending" }],
		});
		await ensureLinkedView(notion, rootId, scan, dbs.drafts.dsId, ROOT_NEEDS_REVIEW_VIEW_TITLE, "table", {
			filter: { property: "Status", select: { equals: ["in-review", "needs-revision"] } },
			sorts: [{ property: "Iteration", direction: "descending" }],
		});
		await ensureLinkedView(notion, rootId, scan, dbs.openQuestions.dsId, ROOT_OPEN_QUESTIONS_VIEW_TITLE, "table", {
			filter: { property: "Status", select: { equals: "open" } },
			sorts: [{ property: "Asked At", direction: "descending" }],
		});
		await ensureLinkedView(notion, rootId, scan, dbs.decisions.dsId, ROOT_LATEST_DECISIONS_VIEW_TITLE, "table", {
			sorts: [{ property: "Made At", direction: "descending" }],
		});
		await ensureLinkedView(notion, rootId, scan, dbs.sources.dsId, ROOT_SOURCES_VIEW_TITLE, "table", {
			sorts: [{ property: "Captured At", direction: "descending" }],
		});
	} catch (err) {
		console.warn("[provision] dashboard/view enrichment skipped:", err);
	}
}

async function createRootPage(
	notion: Client,
	briefId: string,
	briefTitle: string,
	category: Category | undefined,
): Promise<string> {
	const res = await notion.pages.create({
		parent: { type: "page_id", page_id: briefId },
		icon: projectIcon(category),
		cover: PROJECT_COVER,
		properties: {
			title: {
				title: [{ type: "text", text: { content: `📁 ${briefTitle}` } }],
			},
		},
		children: rootDashboardChildren(category),
	});
	return res.id;
}

async function createChildPage(
	notion: Client,
	parentId: string,
	title: string,
	children: NonNullable<CreatePageParameters["children"]>,
): Promise<string> {
	const res = await notion.pages.create({
		parent: { type: "page_id", page_id: parentId },
		properties: {
			title: {
				title: [{ type: "text", text: { content: title } }],
			},
		},
		children,
	});
	return res.id;
}

async function findOrCreateAnswerAnchor(
	notion: Client,
	rootId: string,
): Promise<string> {
	let cursor: string | undefined;
	do {
		const res = await notion.blocks.children.list({
			block_id: rootId,
			start_cursor: cursor,
			page_size: 100,
		});
		for (const block of res.results) {
			if (!("type" in block)) continue;
			if (block.type !== "heading_2") continue;
			const text = block.heading_2.rich_text
				.map((rt) => rt.plain_text)
				.join("");
			if (text.trim() === ANSWER_ANCHOR_TEXT) return block.id;
		}
		cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	} while (cursor);

	const appended = await notion.blocks.children.append({
		block_id: rootId,
		children: [heading2(ANSWER_ANCHOR_TEXT)],
	});
	const created = appended.results[0];
	if (!created || !("id" in created)) {
		throw new Error(
			"provisionProject: failed to create Answer anchor heading on root",
		);
	}
	return created.id;
}

/**
 * Create (or recover) the per-brief project subtree.
 *
 * Idempotent: safe to call multiple times. On retry it walks the root page's
 * children, reuses anything that already exists by name, and only creates
 * what's missing. Briefs provisioned under earlier (category-bifurcated)
 * shapes are healed on the next call — anything missing gets backfilled so
 * the Architect always sees the unified layout.
 *
 * Rate limiting: the @notionhq/client SDK retries 429s automatically with
 * exponential back-off and Retry-After awareness (RetryOptions defaults to
 * `maxRetries: 2`), so we don't add a second retry layer here.
 *
 * The `category` parameter is informational metadata only — it drives the
 * project icon and dashboard caption, never the layout.
 */
export async function provisionProject(
	notion: Client,
	briefId: string,
	briefTitle: string,
	category: Category | undefined,
): Promise<ProjectIds> {
	let state = await readHivemindState(notion, briefId);

	let projectRootId = state.projectRootId;
	if (!projectRootId) {
		projectRootId = await createRootPage(notion, briefId, briefTitle, category);
		state = { ...state, projectRootId };
		// CRITICAL: persist immediately. A crash after the page is created
		// but before state is written would orphan the page and trigger a
		// duplicate root on retry (we have no way to find it by name in a
		// subtree we never persisted).
		await writeHivemindState(notion, briefId, state);
	}

	// Anchor heading must be created BEFORE Plan/Activity child pages so it
	// sits at the top of the root, with all child_page blocks below. This is
	// the only way to get a stable insertion point for writeAnswer.
	let answerAnchorBlockId = state.answerAnchorBlockId;
	if (!answerAnchorBlockId) {
		answerAnchorBlockId = await findOrCreateAnswerAnchor(notion, projectRootId);
		state = { ...state, answerAnchorBlockId };
		await writeHivemindState(notion, briefId, state);
	}

	const scan = await scanRootChildren(notion, projectRootId);

	let planPageId =
		state.planPageId ?? scan.childPagesByTitle.get(PLAN_PAGE_TITLE);
	if (!planPageId) {
		planPageId = await createChildPage(
			notion,
			projectRootId,
			PLAN_PAGE_TITLE,
			PLAN_PAGE_CHILDREN,
		);
	} else if (!state.planPageId) {
		// Recovered Plan page from a prior run that crashed before persisting
		// state. If its body is empty, backfill the structured sections so the
		// agents' setPlanSection tool has somewhere to land.
		try {
			const children = await notion.blocks.children.list({
				block_id: planPageId,
				page_size: 1,
			});
			if (children.results.length === 0) {
				await appendBlocks(notion, planPageId, PLAN_PAGE_CHILDREN);
			}
		} catch {
			// Non-fatal: the Plan page exists; sections will be created on
			// first setPlanSection call by an agent.
		}
	}

	let activityPageId =
		state.activityPageId ?? scan.childPagesByTitle.get(ACTIVITY_PAGE_TITLE);
	if (!activityPageId) {
		activityPageId = await createChildPage(
			notion,
			projectRootId,
			ACTIVITY_PAGE_TITLE,
			ACTIVITY_PAGE_CHILDREN,
		);
	}

	let draftsIds: DbIds | undefined = state.dsIds?.drafts;
	if (!draftsIds) {
		const existingDbId = scan.childDbsByTitle.get(DRAFTS_DB_TITLE);
		if (existingDbId) {
			const dsId = await resolveDsId(notion, existingDbId);
			draftsIds = { dbId: existingDbId, dsId };
		} else {
			draftsIds = await createDraftsDatabase(notion, projectRootId);
		}
	}

	let sourcesIds: DbIds | undefined = state.dsIds?.sources;
	if (!sourcesIds) {
		sourcesIds = await findOrCreateProjectDatabase(
			notion,
			projectRootId,
			scan,
			SOURCES_DB_TITLE,
			SOURCES_DB_PROPERTIES,
		);
	}

	let decisionsIds: DbIds | undefined = state.dsIds?.decisions;
	if (!decisionsIds) {
		decisionsIds = await findOrCreateProjectDatabase(
			notion,
			projectRootId,
			scan,
			DECISIONS_DB_TITLE,
			DECISIONS_DB_PROPERTIES,
		);
	}

	let openQuestionsIds: DbIds | undefined = state.dsIds?.openQuestions;
	if (!openQuestionsIds) {
		openQuestionsIds = await findOrCreateProjectDatabase(
			notion,
			projectRootId,
			scan,
			OPEN_QUESTIONS_DB_TITLE,
			OPEN_QUESTIONS_DB_PROPERTIES,
		);
	}

	let runsIds: DbIds | undefined = state.dsIds?.runs;
	if (!runsIds) {
		runsIds = await ensureRunsDatabase({
			notion,
			projectRootId,
			existingChildDbId: scan.childDbsByTitle.get(RUNS_DB_TITLE),
		});
	}

	state = {
		...state,
		projectRootId,
		planPageId,
		activityPageId,
		answerAnchorBlockId,
		dsIds: {
			drafts: draftsIds,
			sources: sourcesIds,
			decisions: decisionsIds,
			openQuestions: openQuestionsIds,
			runs: runsIds,
		},
	};
	await writeHivemindState(notion, briefId, state);

	await notion.dataSources.update({
		data_source_id: draftsIds.dsId,
		properties: {
			...DRAFTS_DB_ENRICHMENT_PROPERTIES,
			"Based On Draft": {
				relation: {
					data_source_id: draftsIds.dsId,
					single_property: {},
				},
			},
		},
	});

	await enrichProjectDashboard(notion, projectRootId, {
		drafts: draftsIds,
		sources: sourcesIds,
		decisions: decisionsIds,
		openQuestions: openQuestionsIds,
	});

	await ensureRunsViews({ notion, runs: runsIds });

	await writeProjectUrlToBrief(notion, briefId, projectRootId);

	const persistedState: HivemindState = state;
	return {
		projectRootId: persistedState.projectRootId ?? projectRootId,
		planPageId,
		activityPageId,
		answerAnchorBlockId,
		dbs: {
			drafts: draftsIds,
			sources: sourcesIds,
			decisions: decisionsIds,
			openQuestions: openQuestionsIds,
			runs: runsIds,
		},
	};
}

/**
 * Best-effort: surface the project root URL on the brief page so a human can
 * click straight from the brief into the deliverable subtree. Skipped silently
 * if the Briefs DB doesn't have the property (older deployments) — run
 * `scripts/configureBriefsUI.ts` to add it.
 */
async function writeProjectUrlToBrief(
	notion: Client,
	briefId: string,
	projectRootId: string,
): Promise<void> {
	try {
		const rootPage = await notion.pages.retrieve({ page_id: projectRootId });
		if (!isFullPage(rootPage)) return;
		const url = rootPage.url;
		if (!url) return;
		await notion.pages.update({
			page_id: briefId,
			properties: {
				[PROJECT_URL_PROP]: { url },
			},
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (
			msg.includes(PROJECT_URL_PROP) ||
			msg.includes("does not exist") ||
			msg.includes("validation_error")
		) {
			console.warn(
				`[provision] ${PROJECT_URL_PROP} property missing on Briefs DB — skip URL writeback. Run scripts/configureBriefsUI.ts to add it.`,
			);
			return;
		}
		console.warn(`[provision] writeProjectUrlToBrief failed:`, err);
	}
}
