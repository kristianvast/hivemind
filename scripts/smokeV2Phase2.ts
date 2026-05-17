import { Client } from "@notionhq/client";

async function main(): Promise<void> {
	const token = process.env.NOTION_API_TOKEN;
	const dsId = process.env.HIVEMIND_BRIEFS_DATA_SOURCE_ID;
	if (!token || !dsId) {
		console.error("Missing NOTION_API_TOKEN or HIVEMIND_BRIEFS_DATA_SOURCE_ID");
		process.exit(1);
	}

	const notion = new Client({ auth: token });
	const ts = new Date().toISOString().slice(0, 19);
	const title = `v2 phase2 smoke — ${ts}`;
	const body =
		"In 2-3 short paragraphs, compare Anthropic's server-side tools `web_search` and `web_fetch`. Cover: what each does, when to use which, and one cost/limit consideration per tool. Cite the official Anthropic docs (URLs).";

	const created = await notion.pages.create({
		parent: { type: "data_source_id", data_source_id: dsId },
		properties: {
			Name: { title: [{ type: "text", text: { content: title } }] },
			Status: { select: { name: "Backlog" } },
			Category: { select: { name: "quick" } },
		},
		children: [
			{
				type: "paragraph",
				paragraph: {
					rich_text: [{ type: "text", text: { content: body } }],
				},
			},
		],
	});

	console.log(`Created brief in Backlog: ${created.id}`);
	console.log(`Title: ${title}`);
	console.log("");
	console.log("Run locally:");
	console.log(
		`  ntn workers exec runOrchestrator --local -d '${JSON.stringify({ briefId: created.id })}'`,
	);
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
