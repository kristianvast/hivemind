import { Client } from "@notionhq/client";

interface SmokeBrief {
	title: string;
	bodyParagraph: string;
	phaseLabel: string;
}

const SMOKE_BRIEFS: SmokeBrief[] = [
	{
		title: "Smoke 8 — Markdown explainer",
		bodyParagraph:
			"Explain the difference between databases and data sources in the Notion API. Target audience: a junior backend developer who has used Notion casually but never touched the API.",
		phaseLabel: "Phase 8 (writeAnswer via writePageMarkdown)",
	},
	{
		title: "Smoke 10 — Cross-subtree summary",
		bodyParagraph:
			"Summarize all approved drafts in the Hivemind workspace. Walk the Drafts databases across briefs and produce a one-paragraph rollup. This exercise the workspace-wide read path.",
		phaseLabel: "Phase 10 (cross-subtree read with audit log)",
	},
	{
		title: "Smoke 9 — Kanban builder",
		bodyParagraph:
			"Build a kanban board on the workspace home that shows all open Briefs grouped by Category. Use manageView with type=board. Confirm the kanban renders correctly.",
		phaseLabel: "Phase 9 (manageView create)",
	},
	{
		title: "Smoke 11 — Risk Register database",
		bodyParagraph:
			"Create a Risk Register database with these properties: Name (title), Severity (select: low/medium/high/critical), Status (select: open/mitigating/closed), Owner (rich_text), Captured At (date). Seed 5 starter rows with realistic example risks for a typical SaaS launch. Add a Kanban-by-Severity view.",
		phaseLabel: "Phase 11 (manageDatabase create + manageView)",
	},
	{
		title: "Smoke 10b — Update workspace home chart",
		bodyParagraph:
			"Add a new chart view to the Hivemind Workspace home page that shows token consumption per agent over the last 14 days. Use manageView with type=chart against the workspace Activity DB.",
		phaseLabel: "Phase 10 (cross-subtree write + audit log)",
	},
];

async function main(): Promise<void> {
	const token = process.env.NOTION_API_TOKEN;
	const dsId = process.env.HIVEMIND_BRIEFS_DATA_SOURCE_ID;
	if (!token) {
		console.error("Missing NOTION_API_TOKEN");
		process.exit(1);
	}
	if (!dsId) {
		console.error(
			"Missing HIVEMIND_BRIEFS_DATA_SOURCE_ID — set it to the Briefs DB's primary data source ID.",
		);
		process.exit(1);
	}

	const notion = new Client({ auth: token });

	console.log(`Seeding ${SMOKE_BRIEFS.length} v3 smoke briefs...\n`);

	for (const brief of SMOKE_BRIEFS) {
		const created = await notion.pages.create({
			parent: { type: "data_source_id", data_source_id: dsId },
			properties: {
				Name: { title: [{ type: "text", text: { content: brief.title } }] },
				Status: { select: { name: "Backlog" } },
			},
			children: [
				{
					type: "paragraph",
					paragraph: {
						rich_text: [{ type: "text", text: { content: brief.bodyParagraph } }],
					},
				},
				{
					type: "callout",
					callout: {
						rich_text: [
							{
								type: "text",
								text: { content: `Exercises: ${brief.phaseLabel}` },
							},
						],
						icon: { type: "emoji", emoji: "🧪" },
						color: "gray_background",
					},
				},
			],
		});
		console.log(`  ✅ ${brief.title} — ${created.id}`);
	}

	console.log(
		`\nDone. Flip any brief Status=Triaged to trigger the v3 orchestrator (or run \`ntn workers exec runOrchestrator --local <briefId>\` directly).`,
	);
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
