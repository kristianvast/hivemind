import { Client } from "@notionhq/client";

async function main(): Promise<void> {
	const briefId = process.argv[2];
	if (!briefId) {
		console.error("Usage: bounceBack.ts <briefId>");
		process.exit(1);
	}
	const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

	const briefPage = await notion.pages.retrieve({ page_id: briefId });
	if (!("properties" in briefPage)) {
		throw new Error("partial page response");
	}
	const stateRaw =
		briefPage.properties["Hivemind State"]?.type === "rich_text"
			? briefPage.properties["Hivemind State"].rich_text
					.map((r) => r.plain_text)
					.join("")
			: "";
	const state = JSON.parse(stateRaw || "{}");
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
