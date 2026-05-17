import { Client, isFullPage } from "@notionhq/client";

async function readPageMarkdown(notion: Client, pageId: string): Promise<string> {
	const blocks = await notion.blocks.children.list({
		block_id: pageId,
		page_size: 100,
	});
	const lines: string[] = [];
	for (const b of blocks.results) {
		if (!("type" in b)) continue;
		const block = b as { type: string } & Record<string, unknown>;
		switch (block.type) {
			case "paragraph":
			case "quote":
			case "callout":
			case "toggle": {
				const data = block[block.type] as {
					rich_text?: Array<{ plain_text: string }>;
				};
				lines.push(
					`[${block.type}] ${(data.rich_text ?? [])
						.map((r) => r.plain_text)
						.join("")}`,
				);
				break;
			}
			case "heading_1":
			case "heading_2":
			case "heading_3": {
				const data = block[block.type] as {
					rich_text?: Array<{ plain_text: string }>;
				};
				const level = block.type === "heading_1" ? "#" : block.type === "heading_2" ? "##" : "###";
				lines.push(
					`${level} ${(data.rich_text ?? [])
						.map((r) => r.plain_text)
						.join("")}`,
				);
				break;
			}
			case "bulleted_list_item":
			case "numbered_list_item":
			case "to_do": {
				const data = block[block.type] as {
					rich_text?: Array<{ plain_text: string }>;
				};
				lines.push(
					`- ${(data.rich_text ?? []).map((r) => r.plain_text).join("")}`,
				);
				break;
			}
			case "child_page": {
				const cp = block.child_page as { title?: string };
				lines.push(`[child_page] ${cp.title ?? "(untitled)"}`);
				break;
			}
			case "child_database": {
				const cdb = block.child_database as { title?: string };
				lines.push(`[child_database] ${cdb.title ?? "(untitled)"}`);
				break;
			}
			case "table": {
				lines.push(`[table block — would need separate fetch for rows]`);
				break;
			}
			case "divider":
				lines.push(`---`);
				break;
			default:
				lines.push(`[${block.type}]`);
		}
	}
	return lines.join("\n");
}

async function main() {
	const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
	const briefId = process.argv[2];
	if (!briefId) throw new Error("usage: probeBriefOutput.ts <briefId>");

	const page = await notion.pages.retrieve({ page_id: briefId });
	if (!isFullPage(page)) throw new Error("partial page");

	const title = Object.values(page.properties)
		.find((p) => p.type === "title")
		?.title.map((rt) => rt.plain_text)
		.join("");

	const cat = Object.values(page.properties).find((p) => p.type === "select" && (p as { name?: string }).name);

	console.log("=== Brief metadata ===");
	console.log("  id:", briefId);
	console.log("  title:", title);
	console.log("  status:", (page.properties.Status as { select?: { name?: string } } | undefined)?.select?.name);
	console.log(
		"  category:",
		(page.properties.Category as { select?: { name?: string } } | undefined)?.select?.name,
	);
	console.log("  last_edited_time:", page.last_edited_time);

	console.log("\n=== Brief body (user's actual question) ===");
	const briefBody = await readPageMarkdown(notion, briefId);
	console.log(briefBody);

	console.log("\n=== Project root contents (what Architect wrote) ===");
	const blocks = await notion.blocks.children.list({
		block_id: briefId,
		page_size: 100,
	});
	const projectRoot = blocks.results.find(
		(b) => "type" in b && (b as { type: string }).type === "child_page",
	);
	if (projectRoot) {
		const rootId = (projectRoot as { id: string }).id;
		console.log("project root id:", rootId);
		const rootContent = await readPageMarkdown(notion, rootId);
		console.log(rootContent);
	} else {
		console.log("(no project root child_page found on brief)");
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
