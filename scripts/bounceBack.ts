import { Client } from "@notionhq/client";

import { readHivemindState } from "../src/state";

async function main(): Promise<void> {
	const briefId = process.argv[2];
	if (!briefId) {
		console.error("Usage: bounceBack.ts <briefId>");
		process.exit(1);
	}
	const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

	const state = await readHivemindState(notion, briefId);
	const draftsDsId = state.dsIds?.drafts?.dsId;
	if (!draftsDsId) throw new Error("no drafts dsId in state");

	const drafts = await notion.dataSources.query({
		data_source_id: draftsDsId,
		page_size: 5,
	});
	const latest = drafts.results[0];
	if (!latest) throw new Error("no drafts found");
	const draftId = latest.id;

	console.log(`Setting draft ${draftId} status to needs-revision...`);
	await notion.pages.update({
		page_id: draftId,
		properties: { Status: { select: { name: "needs-revision" } } },
	});

	console.log(`Flipping brief ${briefId} to Triaged...`);
	await notion.pages.update({
		page_id: briefId,
		properties: { Status: { select: { name: "Triaged" } } },
	});

	console.log("Bounce-back triggered. Retry chain should skip Scout.");
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
