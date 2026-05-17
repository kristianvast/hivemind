import { Client } from "@notionhq/client";

async function main(): Promise<void> {
	const briefId = process.argv[2];
	if (!briefId) {
		console.error("Usage: dumpAnvilSubtree.ts <briefId>");
		process.exit(1);
	}
	const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
	const children = await notion.blocks.children.list({
		block_id: briefId,
		page_size: 100,
	});
	const projectRoot = children.results.find(
		(b) =>
			"type" in b &&
			b.type === "child_page" &&
			(b as { child_page: { title: string } }).child_page.title.startsWith("📁"),
	);
	if (!projectRoot) {
		console.log("No project root found");
		return;
	}
	const rootId = (projectRoot as { id: string }).id;
	console.log("Project root:", rootId);
	console.log(
		"Title:",
		(projectRoot as { child_page: { title: string } }).child_page.title,
	);
	console.log("---");
	const rootChildren = await notion.blocks.children.list({
		block_id: rootId,
		page_size: 100,
	});
	for (const b of rootChildren.results) {
		if (!("type" in b)) continue;
		const obj = b as unknown as Record<string, unknown>;
		const t = obj.type as string;
		let text = "";
		const rt = (p: { rich_text?: { plain_text: string }[] } | undefined) =>
			(p?.rich_text ?? []).map((r) => r.plain_text).join("");
		if (t === "paragraph") {
			text = rt(obj.paragraph as { rich_text: { plain_text: string }[] });
		} else if (t === "heading_1" || t === "heading_2" || t === "heading_3") {
			const level = parseInt(t.slice(-1));
			text = "#".repeat(level) + " " + rt(obj[t] as { rich_text: { plain_text: string }[] });
		} else if (t === "bulleted_list_item") {
			text = "- " + rt(obj.bulleted_list_item as { rich_text: { plain_text: string }[] });
		} else if (t === "callout") {
			const c = obj.callout as {
				rich_text: { plain_text: string }[];
				icon?: { emoji?: string };
				color?: string;
			};
			text = `📢[${c.icon?.emoji ?? ""}][${c.color ?? ""}] ${rt(c)}`;
		} else if (t === "child_page") {
			text = `[child_page] ${(obj.child_page as { title: string }).title}`;
		} else if (t === "child_database") {
			text = `[child_db] ${(obj.child_database as { title: string }).title}`;
		} else if (t === "image") {
			const img = obj.image as {
				type: string;
				file?: { url?: string };
				file_upload?: { id?: string };
				external?: { url?: string };
				caption?: { plain_text: string }[];
			};
			text = `[image] type=${img.type} cap="${(img.caption ?? []).map((r) => r.plain_text).join("")}" ${
				img.file?.url ? `file_url=${img.file.url.slice(0, 80)}…` : ""
			}${img.file_upload?.id ? `upload_id=${img.file_upload.id}` : ""}${
				img.external?.url ? `ext_url=${img.external.url}` : ""
			}`;
		} else if (t === "divider") {
			text = "---";
		} else {
			text = `[${t}]`;
		}
		console.log(text);
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
