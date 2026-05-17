import { Client } from "@notionhq/client";

const PAGE = process.argv[2];
if (!PAGE) {
	console.error("Usage: tsx scripts/dumpActivity.ts <pageId>");
	process.exit(1);
}

const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

interface Block {
	id: string;
	type: string;
	has_children?: boolean;
	[key: string]: unknown;
}

function richText(rt: { plain_text: string }[] | undefined): string {
	return (rt ?? []).map((r) => r.plain_text).join("");
}

async function dumpPage(pageId: string, indent = 0): Promise<void> {
	let cursor: string | undefined;
	do {
		const res = await notion.blocks.children.list({
			block_id: pageId,
			start_cursor: cursor,
			page_size: 100,
		});
		for (const raw of res.results) {
			if (!("type" in raw)) continue;
			const b = raw as Block;
			const pad = "  ".repeat(indent);
			let line: string;
			switch (b.type) {
				case "paragraph":
					line = richText((b.paragraph as { rich_text: { plain_text: string }[] }).rich_text);
					break;
				case "heading_2":
					line = "## " + richText((b.heading_2 as { rich_text: { plain_text: string }[] }).rich_text);
					break;
				case "heading_3":
					line = "### " + richText((b.heading_3 as { rich_text: { plain_text: string }[] }).rich_text);
					break;
				case "bulleted_list_item":
					line = "- " + richText((b.bulleted_list_item as { rich_text: { plain_text: string }[] }).rich_text);
					break;
				case "toggle":
					line = "▸ " + richText((b.toggle as { rich_text: { plain_text: string }[] }).rich_text);
					break;
				case "callout":
					line = "📢 " + richText((b.callout as { rich_text: { plain_text: string }[] }).rich_text);
					break;
				case "divider":
					line = "---";
					break;
				case "code":
					line = "```\n" + richText((b.code as { rich_text: { plain_text: string }[] }).rich_text) + "\n```";
					break;
				default:
					line = `[${b.type}]`;
			}
			console.log(`${pad}${line}`);
			if (b.has_children) await dumpPage(b.id, indent + 1);
		}
		cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
	} while (cursor);
}

dumpPage(PAGE).catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
