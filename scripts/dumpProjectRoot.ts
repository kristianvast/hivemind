import { Client } from "@notionhq/client";

async function main(): Promise<void> {
	const rootId = process.argv[2];
	if (!rootId) {
		console.error("Usage: dumpProjectRoot.ts <projectRootId>");
		process.exit(1);
	}
	const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
	const res = await notion.blocks.children.list({
		block_id: rootId,
		page_size: 100,
	});
	for (const block of res.results) {
		if (!("type" in block)) continue;
		const t = block.type;
		let text = "";
		if (t === "paragraph") {
			text = ((block as Record<string, unknown>).paragraph as { rich_text: { plain_text: string }[] }).rich_text
				.map((r) => r.plain_text)
				.join("");
		} else if (t === "heading_1") {
			text = "# " + ((block as Record<string, unknown>).heading_1 as { rich_text: { plain_text: string }[] }).rich_text
				.map((r) => r.plain_text)
				.join("");
		} else if (t === "heading_2") {
			text = "## " + ((block as Record<string, unknown>).heading_2 as { rich_text: { plain_text: string }[] }).rich_text
				.map((r) => r.plain_text)
				.join("");
		} else if (t === "heading_3") {
			text = "### " + ((block as Record<string, unknown>).heading_3 as { rich_text: { plain_text: string }[] }).rich_text
				.map((r) => r.plain_text)
				.join("");
		} else if (t === "bulleted_list_item") {
			text = "- " + ((block as Record<string, unknown>).bulleted_list_item as { rich_text: { plain_text: string }[] }).rich_text
				.map((r) => r.plain_text)
				.join("");
		} else if (t === "callout") {
			text = "📢 " + ((block as Record<string, unknown>).callout as { rich_text: { plain_text: string }[] }).rich_text
				.map((r) => r.plain_text)
				.join("");
		} else if (t === "child_page") {
			text = "[child_page] " + ((block as Record<string, unknown>).child_page as { title: string }).title;
		} else if (t === "child_database") {
			text = "[child_db] " + ((block as Record<string, unknown>).child_database as { title: string }).title;
		} else if (t === "divider") {
			text = "---";
		} else {
			text = "[" + t + "]";
		}
		console.log(text);
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
