import { Client } from "@notionhq/client";

interface BlockResult {
	type: string;
	[key: string]: unknown;
}

async function countBlocks(notion: Client, pageId: string): Promise<number> {
	let count = 0;
	let cursor: string | undefined;
	do {
		const res = await notion.blocks.children.list({
			block_id: pageId,
			start_cursor: cursor,
			page_size: 100,
		});
		count += res.results.length;
		cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	} while (cursor);
	return count;
}

async function countPlanSections(
	notion: Client,
	planPageId: string,
): Promise<Record<string, number>> {
	const sectionCounts: Record<string, number> = {};
	let currentSection: string | null = null;
	let cursor: string | undefined;
	do {
		const res = await notion.blocks.children.list({
			block_id: planPageId,
			start_cursor: cursor,
			page_size: 100,
		});
		for (const block of res.results) {
			if (!("type" in block)) continue;
			const typed = block as BlockResult;
			if (typed.type === "heading_2") {
				const h = typed.heading_2 as { rich_text: { plain_text: string }[] };
				currentSection = h.rich_text.map((rt) => rt.plain_text).join("");
				sectionCounts[currentSection] = 0;
				continue;
			}
			if (currentSection !== null) {
				sectionCounts[currentSection] = (sectionCounts[currentSection] ?? 0) + 1;
			}
		}
		cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	} while (cursor);
	return sectionCounts;
}

async function main(): Promise<void> {
	const briefId = process.argv[2];
	if (!briefId) {
		console.error("Usage: inspectBrief.ts <briefId>");
		process.exit(1);
	}
	const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

	const page = await notion.pages.retrieve({ page_id: briefId });
	const props = "properties" in page ? page.properties : {};
	const status =
		props.Status?.type === "select" ? props.Status.select?.name : null;
	const owner =
		props.Owner?.type === "select" ? props.Owner.select?.name : null;
	const category =
		props.Category?.type === "select" ? props.Category.select?.name : null;
	const projectUrl =
		props["📁 Project"]?.type === "url" ? props["📁 Project"].url : null;
	console.log(`Status:   ${status}`);
	console.log(`Owner:    ${owner}`);
	console.log(`Category: ${category}`);
	console.log(`Project:  ${projectUrl ?? "(unset)"}`);

	const stateRaw =
		props["Hivemind State"]?.type === "rich_text"
			? props["Hivemind State"].rich_text.map((r) => r.plain_text).join("")
			: null;
	const state = stateRaw ? JSON.parse(stateRaw) : {};

	const draftsDsId = state.dsIds?.drafts?.dsId;
	if (draftsDsId) {
		const res = await notion.dataSources.query({
			data_source_id: draftsDsId,
			page_size: 100,
		});
		console.log(`\nDrafts:   ${res.results.length} rows`);
	}

	if (state.planPageId) {
		const sections = await countPlanSections(notion, state.planPageId);
		console.log("\nPlan sections (blocks per section):");
		for (const [name, count] of Object.entries(sections)) {
			console.log(`  ${name.padEnd(20)} ${count}`);
		}
	}

	if (state.activityPageId) {
		const n = await countBlocks(notion, state.activityPageId);
		console.log(`\nActivity: ${n} blocks`);
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
