import { Client } from "@notionhq/client";

async function main(): Promise<void> {
	const token = process.env.NOTION_API_TOKEN;
	const dsId = process.env.HIVEMIND_BRIEFS_DATA_SOURCE_ID;
	if (!token || !dsId) {
		console.error("Missing NOTION_API_TOKEN or HIVEMIND_BRIEFS_DATA_SOURCE_ID");
		process.exit(1);
	}

	const notion = new Client({ auth: token });
	const title = `what is notion? (demo-mode smoke ${new Date().toISOString().slice(11, 19)})`;

	const created = await notion.pages.create({
		parent: { type: "data_source_id", data_source_id: dsId },
		properties: {
			Name: { title: [{ type: "text", text: { content: title } }] },
			Status: { select: { name: "Backlog" } },
		},
	});

	const briefId = created.id;
	console.log("Created brief:", briefId);
	console.log("  Title:", title);
	console.log("");
	console.log(
		"To exercise DEMO MODE end-to-end, run:",
	);
	console.log(
		`  ntn workers exec runOrchestrator --local -d '{"briefId":"${briefId}"}'`,
	);
	console.log("");
	console.log("Then inspect the deliverable:");
	console.log(`  npx tsx scripts/probeBriefOutput.ts ${briefId}`);
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
