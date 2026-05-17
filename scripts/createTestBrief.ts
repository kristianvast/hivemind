import { Client } from "@notionhq/client";

async function main(): Promise<void> {
	const token = process.env.NOTION_API_TOKEN;
	const dsId = process.env.HIVEMIND_BRIEFS_DATA_SOURCE_ID;
	if (!token || !dsId) {
		console.error("Missing NOTION_API_TOKEN or HIVEMIND_BRIEFS_DATA_SOURCE_ID");
		process.exit(1);
	}

	const notion = new Client({ auth: token });
	const title = `Hivemind v1 smoke test — ${new Date().toISOString().slice(0, 19)}`;

	const created = await notion.pages.create({
		parent: { type: "data_source_id", data_source_id: dsId },
		properties: {
			Name: { title: [{ type: "text", text: { content: title } }] },
			Status: { select: { name: "Backlog" } },
		},
		children: [
			{
				type: "paragraph",
				paragraph: {
					rich_text: [
						{
							type: "text",
							text: {
								content:
									"Smoke test brief for the OMO orchestrator. Write a 200-word explainer about what TypeScript is and why it matters, aimed at a junior JavaScript developer. Use concrete examples.",
							},
						},
					],
				},
			},
		],
	});

	const briefId = created.id;
	console.log(`Created brief: ${briefId}`);
	console.log(`  Title: ${title}`);

	console.log("Flipping Status to Triaged in 3s...");
	await new Promise((r) => setTimeout(r, 3000));

	await notion.pages.update({
		page_id: briefId,
		properties: { Status: { select: { name: "Triaged" } } },
	});
	console.log(`Status → Triaged. Webhook should fire on the deployed worker.`);
	console.log(`\nBrief page ID: ${briefId}`);
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
