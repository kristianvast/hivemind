// Per-brief project subtree provisioner.
//
// Layout depends on Category:
//
// "writing" / "quick" (single-shot prose answers, no iteration):
//   📁 {briefTitle}              (root page — Scribe/Forge writes the answer here)
//   ├── 📄 Answer                (heading_2 on root, anchor for writeAnswer)
//   ├── …answer content…         (inserted between anchor and child pages below)
//   ├── …Sentinel review…        (appended inline after content)
//   ├── Plan                     (child page — writing only; Scout's context)
//   └── Activity                 (child page — chronological agent run log)
//
// "deep" / "ultrabrain" / "visual-engineering" (iterative work, needs revision history):
//   📁 {briefTitle}              (root page)
//   ├── Plan                     (child page — Context/Approach/Decisions/Sources/Open Questions/Status)
//   ├── Drafts                   (database — iterating artifacts; reviews are appended inline on each draft page)
//   └── Activity                 (child page — chronological agent run log)
//
// Ordering trick for writing/quick: the Answer heading is created BEFORE Plan
// and Activity child pages so it appears at the top of the root page. writeAnswer
// then uses Notion's `after` insert parameter to slot content between the anchor
// heading and the child_page navigation blocks below.
//
// Idempotency: walk-by-name on every step; state persisted after root creation
// and after every step, so partial failures recover cleanly.

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
import { readHivemindState, writeHivemindState } from "./state";
import type { DbIds, HivemindState } from "./state";

export type { DbIds } from "./state";

const PROJECT_URL_PROP = "📁 Project";

const ANSWER_ANCHOR_TEXT = "📄 Answer";

export function usesDraftsDb(category: Category): boolean {
	return category !== "writing" && category !== "quick";
}

export interface ProjectIds {
	projectRootId: string;
	planPageId: string | null;
	activityPageId: string;
	answerAnchorBlockId?: string;
	dbs: {
		drafts?: DbIds;
		sources?: DbIds;
		decisions?: DbIds;
		openQuestions?: DbIds;
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

function projectIcon(category: Category): NonNullable<CreatePageParameters["icon"]> {
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
	toggle("Research details", [paragraph("_Pending Scout output_")]),
	heading2("Approach"),
	callout("Recommended path through the work, kept concise enough for a human reviewer to scan.", "🛠️", "gray_background"),
	toggle("Assumptions and rejected paths", [paragraph("_Pending Scout output_")]),
	heading2("Decisions"),
	callout("Significant choices made by the swarm, with rationale.", "✅", "green_background"),
	paragraph("_Pending agents_"),
	heading2("Sources"),
	callout("Evidence and references the agents relied on.", "🔎", "yellow_background"),
	paragraph("_Pending Scout output_"),
	heading2("Open Questions"),
	callout("Human input needed, unresolved risks, or follow-up opportunities.", "❓", "orange_background"),
	paragraph("_Pending agents_"),
	heading2("Status"),
	callout("Current chain state, latest verdict, and next action.", "📍", "purple_background"),
	todoBlock("Scout context captured", false),
	todoBlock("Draft created", false),
	todoBlock("Sentinel review complete", false),
];

function rootDashboardChildren(category: Category): NonNullable<CreatePageParameters["children"]> {
	const inlineAnswer = !usesDraftsDb(category);
	const deliverable = inlineAnswer
		? "Final answer appears directly under the Answer section on this page."
		: "Draft iterations live in the Drafts database. The approved draft is the deliverable.";
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
					paragraph(`Category: ${category}`),
				],
			},
			{
				widthRatio: 0.33,
				children: [
					heading3("Deliverable"),
					paragraph(deliverable),
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
				{ name: "Scout", color: "blue" },
				{ name: "Forge", color: "orange" },
				{ name: "Scribe", color: "purple" },
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
				{ name: "Scout", color: "blue" },
				{ name: "Forge", color: "orange" },
				{ name: "Scribe", color: "purple" },
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
				{ name: "Scout", color: "blue" },
				{ name: "Forge", color: "orange" },
				{ name: "Scribe", color: "purple" },
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

type NotionWithViews = {
	views?: {
		list(args: { database_id?: string; data_source_id?: string }): Promise<{ results: { id: string }[] }>;
		retrieve(args: { view_id: string }): Promise<{ id: string; name?: string }>;
		create(args: Record<string, unknown>): Promise<unknown>;
	};
};

async function viewNames(notion: Client, dbId: string): Promise<Set<string>> {
	const views = (notion as unknown as NotionWithViews).views;
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
	const views = (notion as unknown as NotionWithViews).views;
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
	const views = (notion as NotionWithViews).views;
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
		drafts?: DbIds;
		sources?: DbIds;
		decisions?: DbIds;
		openQuestions?: DbIds;
	},
): Promise<void> {
	try {
		const scan = await scanRootChildren(notion, rootId);
		if (dbs.drafts) {
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
		}
		if (dbs.openQuestions) {
			await ensureLinkedView(notion, rootId, scan, dbs.openQuestions.dsId, ROOT_OPEN_QUESTIONS_VIEW_TITLE, "table", {
				filter: { property: "Status", select: { equals: "open" } },
				sorts: [{ property: "Asked At", direction: "descending" }],
			});
		}
		if (dbs.decisions) {
			await ensureLinkedView(notion, rootId, scan, dbs.decisions.dsId, ROOT_LATEST_DECISIONS_VIEW_TITLE, "table", {
				sorts: [{ property: "Made At", direction: "descending" }],
			});
		}
		if (dbs.sources) {
			await ensureLinkedView(notion, rootId, scan, dbs.sources.dsId, ROOT_SOURCES_VIEW_TITLE, "table", {
				sorts: [{ property: "Captured At", direction: "descending" }],
			});
		}
	} catch (err) {
		console.warn("[provision] dashboard/view enrichment skipped:", err);
	}
}

async function createRootPage(
	notion: Client,
	briefId: string,
	briefTitle: string,
	category: Category,
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
 * what's missing.
 *
 * Rate limiting: the @notionhq/client SDK retries 429s automatically with
 * exponential back-off and Retry-After awareness (RetryOptions defaults to
 * `maxRetries: 2`), so we don't add a second retry layer here.
 */
export async function provisionProject(
	notion: Client,
	briefId: string,
	briefTitle: string,
	category: Category,
): Promise<ProjectIds> {
	let state = await readHivemindState(notion, briefId);
	const inlineAnswer = !usesDraftsDb(category);
	const needsPlan = category !== "quick";

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
	if (inlineAnswer && !answerAnchorBlockId) {
		answerAnchorBlockId = await findOrCreateAnswerAnchor(notion, projectRootId);
		state = { ...state, answerAnchorBlockId };
		await writeHivemindState(notion, briefId, state);
	}

	const scan = await scanRootChildren(notion, projectRootId);

	let planPageId =
		state.planPageId ?? scan.childPagesByTitle.get(PLAN_PAGE_TITLE);
	if (needsPlan) {
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
			// agents' set_plan_section tool has somewhere to land.
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
				// first set_plan_section call by an agent.
			}
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
	if (usesDraftsDb(category) && !draftsIds) {
		const existingDbId = scan.childDbsByTitle.get(DRAFTS_DB_TITLE);
		if (existingDbId) {
			const dsId = await resolveDsId(notion, existingDbId);
			draftsIds = { dbId: existingDbId, dsId };
		} else {
			draftsIds = await createDraftsDatabase(notion, projectRootId);
		}
	}

	let sourcesIds: DbIds | undefined = state.dsIds?.sources;
	let decisionsIds: DbIds | undefined = state.dsIds?.decisions;
	let openQuestionsIds: DbIds | undefined = state.dsIds?.openQuestions;
	if (needsPlan) {
		if (!sourcesIds) {
			sourcesIds = await findOrCreateProjectDatabase(
				notion,
				projectRootId,
				scan,
				SOURCES_DB_TITLE,
				SOURCES_DB_PROPERTIES,
			);
		}
		if (!decisionsIds) {
			decisionsIds = await findOrCreateProjectDatabase(
				notion,
				projectRootId,
				scan,
				DECISIONS_DB_TITLE,
				DECISIONS_DB_PROPERTIES,
			);
		}
		if (!openQuestionsIds) {
			openQuestionsIds = await findOrCreateProjectDatabase(
				notion,
				projectRootId,
				scan,
				OPEN_QUESTIONS_DB_TITLE,
				OPEN_QUESTIONS_DB_PROPERTIES,
			);
		}
	}

	state = {
		...state,
		projectRootId,
		planPageId: planPageId ?? state.planPageId,
		activityPageId,
		answerAnchorBlockId,
		dsIds: {
			...state.dsIds,
			...(draftsIds ? { drafts: draftsIds } : {}),
			...(sourcesIds ? { sources: sourcesIds } : {}),
			...(decisionsIds ? { decisions: decisionsIds } : {}),
			...(openQuestionsIds ? { openQuestions: openQuestionsIds } : {}),
		},
	};
	await writeHivemindState(notion, briefId, state);

	if (draftsIds) {
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
	}

	await enrichProjectDashboard(notion, projectRootId, {
		drafts: draftsIds,
		sources: sourcesIds,
		decisions: decisionsIds,
		openQuestions: openQuestionsIds,
	});

	await writeProjectUrlToBrief(notion, briefId, projectRootId);

	const persistedState: HivemindState = state;
	return {
		projectRootId: persistedState.projectRootId ?? projectRootId,
		planPageId: planPageId ?? null,
		activityPageId,
		answerAnchorBlockId,
		dbs: {
			...(draftsIds ? { drafts: draftsIds } : {}),
			...(sourcesIds ? { sources: sourcesIds } : {}),
			...(decisionsIds ? { decisions: decisionsIds } : {}),
			...(openQuestionsIds ? { openQuestions: openQuestionsIds } : {}),
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
