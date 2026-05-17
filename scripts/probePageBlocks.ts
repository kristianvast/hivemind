import { Client } from "@notionhq/client";

async function main(): Promise<void> {
	const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
	const pageId = process.argv[2];
	if (!pageId) throw new Error("usage: probePageBlocks.ts <pageId>");

	const blocks = await notion.blocks.children.list({
		block_id: pageId,
		page_size: 100,
	});
	console.log(`=== Blocks on page ${pageId} ===`);
	console.log(`  total: ${blocks.results.length}`);
	for (const b of blocks.results) {
		if (!("type" in b)) continue;
		const block = b as { type: string; id: string } & Record<string, unknown>;
		const data = block[block.type] as { rich_text?: Array<{ plain_text: string }> } | undefined;
		const text = data?.rich_text
			?.map((rt) => rt.plain_text)
			.join("")
			.slice(0, 100);
		console.log(`  [${block.type}] ${text ?? ""}`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
