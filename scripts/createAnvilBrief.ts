import { Client } from "@notionhq/client";

async function main(): Promise<void> {
	const token = process.env.NOTION_API_TOKEN;
	const dsId = process.env.HIVEMIND_BRIEFS_DATA_SOURCE_ID;
	if (!token || !dsId) {
		console.error("Missing NOTION_API_TOKEN or HIVEMIND_BRIEFS_DATA_SOURCE_ID");
		process.exit(1);
	}

	const notion = new Client({ auth: token });
	const title = `Anvil smoke — local coffee landing — ${new Date().toISOString().slice(0, 19)}`;

	const body = [
		"Build a one-page landing site for **Foundry Coffee**, a fictional San Francisco roastery, and demonstrate it running on localhost.",
		"",
		"Requirements:",
		"- Single index.html, self-contained (inline CSS, no external assets).",
		"- Hero with the name, a one-line tagline, and a 'Visit the Roastery' CTA.",
		"- A short About paragraph (2-3 sentences).",
		"- A 3-column menu (Espresso, Pour-over, Cold Brew) with prices.",
		"- Footer with address and hours.",
		"- Tasteful palette: warm browns / cream. Web-safe fonts only.",
		"",
		"Use Anvil to spin up the local server, screenshot the rendered page, embed the screenshot in this brief, and surface the localhost URL as a callout so I can click it.",
	].join("\n");

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
					rich_text: [{ type: "text", text: { content: body } }],
				},
			},
		],
	});

	console.log(`Created brief: ${created.id}`);
	console.log(`  Title: ${title}`);
	console.log(``);
	console.log(`Next step:`);
	console.log(`  ntn workers exec runOrchestrator --local -d '{"briefId":"${created.id}"}'`);
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
