import { Client } from "@notionhq/client";

async function main(): Promise<void> {
	const briefId = process.argv[2];
	if (!briefId) {
		console.error("Usage: retryBrief.ts <briefId>");
		process.exit(1);
	}
	const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
	await notion.pages.update({
		page_id: briefId,
		properties: { Status: { select: { name: "Triaged" } } },
	});
	console.log(`Status flipped to Triaged: ${briefId}`);
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
