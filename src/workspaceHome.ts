// Workspace-level Hivemind Home page. One per workspace (not per brief).
// Provisioned ONCE by the admin script `scripts/provisionWorkspaceHome.ts`,
// then referenced via env vars by the orchestrator + the Architect's
// `getWorkspaceHome` tool.
//
// Layout (initial — Phase 9's manageView tool can extend):
//   🐝 Hivemind Workspace                    (page, parent = HIVEMIND_WORKSPACE_PARENT_PAGE_ID)
//   ├── heading_1: "Hivemind Command Center"
//   ├── callout banner
//   ├── linked database view (Briefs DB grouped by Status → kanban)
//   ├── divider
//   ├── 🪵 Activity                          (child database — cross-brief run mirror)
//   │     properties: Name, Agent, Status, Started, Finished, Tokens, Brief URL
//   │     views: Kanban by Status, Latest (table sorted by Started desc)
//   └── (Phase 9 will add dashboard views / charts here)
//
// Env contract (set after running the admin script, then `ntn workers env push`):
//   HIVEMIND_WORKSPACE_PARENT_PAGE_ID  — input: where to create the home (a page the
//                                       integration has access to)
//   HIVEMIND_BRIEFS_DATA_SOURCE_ID    — input: data source of the Briefs DB (required
//                                       to seed the kanban linked view)
//   HIVEMIND_WORKSPACE_HOME_PAGE_ID    — output: created home page ID
//   HIVEMIND_WORKSPACE_ACTIVITY_DB_ID  — output: child DB container ID
//   HIVEMIND_WORKSPACE_ACTIVITY_DS_ID  — output: child DB data source ID (write target)

import type { Client } from "@notionhq/client";
import { isFullDatabase } from "@notionhq/client";
import type {
	CreateDatabaseParameters,
	CreatePageParameters,
} from "@notionhq/client";

import {
	callout,
	divider,
	heading1,
	heading2,
	paragraph,
} from "./notion";
import { createView } from "./views";

export const WORKSPACE_HOME_TITLE = "🐝 Hivemind Workspace";
export const WORKSPACE_ACTIVITY_DB_TITLE = "🪵 Activity";
export const WORKSPACE_AUDIT_DB_TITLE = "🪵 Audit";
export const WORKSPACE_BRIEFS_LINKED_VIEW_TITLE = "📋 Briefs by Status";

export interface WorkspaceHomeIds {
	homePageId: string;
	activityDbId: string;
	activityDsId: string;
	auditDbId: string;
	auditDsId: string;
}

type DbPropertiesRequest = NonNullable<
	NonNullable<CreateDatabaseParameters["initial_data_source"]>["properties"]
>;

const ACTIVITY_DB_PROPERTIES: DbPropertiesRequest = {
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
				{ name: "running", color: "yellow" },
				{ name: "done", color: "green" },
				{ name: "failed", color: "red" },
			],
		},
	},
	Started: { type: "date", date: {} },
	Finished: { type: "date", date: {} },
	Tokens: { type: "number", number: { format: "number" } },
	"Brief URL": { type: "url", url: {} },
	"Brief Title": { type: "rich_text", rich_text: {} },
};

const AUDIT_DB_PROPERTIES: DbPropertiesRequest = {
	Name: { type: "title", title: {} },
	Op: {
		type: "select",
		select: {
			options: [
				{ name: "appendBlocks", color: "blue" },
				{ name: "updateBlock", color: "blue" },
				{ name: "deleteBlock", color: "red" },
				{ name: "createChildPage", color: "green" },
				{ name: "writeAnswer", color: "purple" },
				{ name: "createDraft", color: "purple" },
				{ name: "addComment", color: "yellow" },
				{ name: "writePageMarkdown", color: "blue" },
				{ name: "setIcon", color: "gray" },
				{ name: "setCover", color: "gray" },
				{ name: "setTitle", color: "gray" },
				{ name: "move", color: "orange" },
				{ name: "trash", color: "red" },
				{ name: "restore", color: "green" },
				{ name: "uploadFile", color: "blue" },
				{ name: "manageView", color: "pink" },
				{ name: "manageDatabase", color: "pink" },
			],
		},
	},
	Agent: {
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
	Status: {
		type: "select",
		select: {
			options: [
				{ name: "ok", color: "green" },
				{ name: "error", color: "red" },
			],
		},
	},
	"Brief URL": { type: "url", url: {} },
	"Target URL": { type: "url", url: {} },
	At: { type: "date", date: {} },
	Detail: { type: "rich_text", rich_text: {} },
};

const HOME_PAGE_CHILDREN: NonNullable<CreatePageParameters["children"]> = [
	heading1("Hivemind Command Center"),
	callout(
		"Live observability across every brief and agent run. Briefs kanban below shows active work; Activity DB further down is the cross-brief run log.",
		"🐝",
		"yellow_background",
	),
	divider(),
	heading2("Briefs"),
	paragraph("Kanban of every brief grouped by Status. Drag cards to retrigger workflows."),
	divider(),
	heading2("Recent runs (cross-brief)"),
	paragraph("Every agent invocation across every brief logs a summary row here for workspace-wide observability."),
];

/**
 * Provision the workspace home page + its 🪵 Activity database. Idempotent
 * is intentionally NOT a goal here — the admin runs this once. Re-running
 * creates a fresh home page; the old one becomes orphaned. The admin can
 * trash the orphan manually.
 *
 * Returns the IDs the operator must set in `.env` and push via
 * `ntn workers env push` before the orchestrator can use the workspace
 * mirror.
 */
export async function provisionWorkspaceHome(args: {
	notion: Client;
	parentPageId: string;
	briefsDataSourceId: string;
}): Promise<WorkspaceHomeIds> {
	const { notion, parentPageId, briefsDataSourceId } = args;

	const home = await notion.pages.create({
		parent: { type: "page_id", page_id: parentPageId },
		icon: { type: "emoji", emoji: "🐝" },
		cover: {
			type: "external",
			external: {
				url: "https://images.unsplash.com/photo-1518837695005-2083093ee35b?auto=format&fit=crop&w=2400&q=80",
			},
		},
		properties: {
			title: {
				title: [{ type: "text", text: { content: WORKSPACE_HOME_TITLE } }],
			},
		},
		children: HOME_PAGE_CHILDREN,
	});
	const homePageId = home.id;

	const briefsView = await safeCreateView(notion, {
		create_database: {
			parent: { type: "page_id", page_id: homePageId },
		},
		data_source_id: briefsDataSourceId,
		name: WORKSPACE_BRIEFS_LINKED_VIEW_TITLE,
		type: "board",
		configuration: {
			type: "board",
			group_by: {
				type: "select",
				property_id: "Status",
				sort: { type: "manual" },
			},
		},
	});
	if (briefsView) {
		console.log(`  📋 Briefs kanban created: ${briefsView.url ?? briefsView.id}`);
	} else {
		console.warn(
			"  ⚠️  Briefs kanban view could not be created — surface it manually on the home page.",
		);
	}

	const activity = await notion.databases.create({
		parent: { type: "page_id", page_id: homePageId },
		title: [{ type: "text", text: { content: WORKSPACE_ACTIVITY_DB_TITLE } }],
		initial_data_source: { properties: ACTIVITY_DB_PROPERTIES },
	});
	if (!isFullDatabase(activity)) {
		throw new Error(
			"provisionWorkspaceHome: databases.create returned partial response for Activity",
		);
	}
	const activityPrimary = activity.data_sources[0];
	if (!activityPrimary) {
		throw new Error(
			"provisionWorkspaceHome: created Activity database has no data source",
		);
	}

	await safeCreateView(notion, {
		database_id: activity.id,
		data_source_id: activityPrimary.id,
		name: "📋 Kanban by Status",
		type: "board",
		configuration: {
			type: "board",
			group_by: {
				type: "select",
				property_id: "Status",
				sort: { type: "manual" },
			},
		},
	});
	await safeCreateView(notion, {
		database_id: activity.id,
		data_source_id: activityPrimary.id,
		name: "🕐 Recent runs",
		type: "table",
		sorts: [{ property: "Started", direction: "descending" }],
	});
	await safeCreateView(notion, {
		database_id: activity.id,
		data_source_id: activityPrimary.id,
		name: "📊 Tokens by agent",
		type: "chart",
		configuration: {
			type: "chart",
			chart_type: "column",
			x_axis: {
				type: "select",
				property_id: "Agent",
				sort: { type: "manual" },
			},
			y_axis: { aggregator: "sum", property_id: "Tokens" },
		},
	});

	const audit = await notion.databases.create({
		parent: { type: "page_id", page_id: homePageId },
		title: [{ type: "text", text: { content: WORKSPACE_AUDIT_DB_TITLE } }],
		initial_data_source: { properties: AUDIT_DB_PROPERTIES },
	});
	if (!isFullDatabase(audit)) {
		throw new Error(
			"provisionWorkspaceHome: databases.create returned partial response for Audit",
		);
	}
	const auditPrimary = audit.data_sources[0];
	if (!auditPrimary) {
		throw new Error(
			"provisionWorkspaceHome: created Audit database has no data source",
		);
	}

	await safeCreateView(notion, {
		database_id: audit.id,
		data_source_id: auditPrimary.id,
		name: "🕐 Recent writes",
		type: "table",
		sorts: [{ property: "At", direction: "descending" }],
	});
	await safeCreateView(notion, {
		database_id: audit.id,
		data_source_id: auditPrimary.id,
		name: "📋 By Op",
		type: "board",
		configuration: {
			type: "board",
			group_by: {
				type: "select",
				property_id: "Op",
				sort: { type: "manual" },
			},
		},
	});

	return {
		homePageId,
		activityDbId: activity.id,
		activityDsId: activityPrimary.id,
		auditDbId: audit.id,
		auditDsId: auditPrimary.id,
	};
}

async function safeCreateView(
	notion: Client,
	args: Parameters<typeof createView>[1],
): Promise<{ id: string; url: string | null } | null> {
	try {
		return await createView(notion, args);
	} catch (err) {
		console.warn(
			`[workspaceHome] view "${args.name}" create failed:`,
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

/**
 * Read the workspace home IDs from env vars. Returns null if any of the
 * three IDs is missing — callers should treat that as "workspace mirror
 * not configured" and skip cross-brief writes silently. This is how the
 * orchestrator stays backwards-compatible during the Phase 7 rollout.
 */
export function getWorkspaceHomeIdsFromEnv(): WorkspaceHomeIds | null {
	const homePageId = process.env.HIVEMIND_WORKSPACE_HOME_PAGE_ID;
	const activityDbId = process.env.HIVEMIND_WORKSPACE_ACTIVITY_DB_ID;
	const activityDsId = process.env.HIVEMIND_WORKSPACE_ACTIVITY_DS_ID;
	const auditDbId = process.env.HIVEMIND_WORKSPACE_AUDIT_DB_ID;
	const auditDsId = process.env.HIVEMIND_WORKSPACE_AUDIT_DS_ID;
	if (!homePageId || !activityDbId || !activityDsId) return null;
	return {
		homePageId,
		activityDbId,
		activityDsId,
		auditDbId: auditDbId ?? "",
		auditDsId: auditDsId ?? "",
	};
}
