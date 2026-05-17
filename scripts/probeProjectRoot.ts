import { Client } from "@notionhq/client";

async function main() {
	const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
	const rootId = process.argv[2];
	if (!rootId) throw new Error("usage: probeProjectRoot.ts <rootPageId>");

	const blocks = await notion.blocks.children.list({
		block_id: rootId,
		page_size: 100,
	});

	console.log("=== Project root child_databases (untitled investigation) ===");
	for (const b of blocks.results) {
		if (!("type" in b)) continue;
		if (b.type !== "child_database") continue;
		const cdb = (b as { child_database: { title?: string }; id: string });
		console.log(`\n[child_database] id=${cdb.id} title="${cdb.child_database.title ?? ""}"`);
		try {
			const db = await notion.databases.retrieve({ database_id: cdb.id });
			const title = (db as { title?: Array<{ plain_text?: string }> }).title
				?.map((rt) => rt.plain_text ?? "")
				.join("");
			console.log(`  retrieve title: "${title}"`);
			console.log(`  data_sources:`, (db as { data_sources?: Array<{ id: string; name?: string }> }).data_sources?.map((d) => `${d.id} name="${d.name ?? ""}"`));
		} catch (e) {
			console.log(`  ERROR: ${(e as Error).message}`);
		}
	}

	console.log("\n=== Runs DB contents (what tools Architect called) ===");
	const runsDbBlock = blocks.results.find((b) => {
		if (!("type" in b) || b.type !== "child_database") return false;
		const t = (b as { child_database: { title?: string } }).child_database.title ?? "";
		return t.includes("Runs");
	});
	if (runsDbBlock) {
		const runsDbId = (runsDbBlock as { id: string }).id;
		const runsDb = await notion.databases.retrieve({ database_id: runsDbId });
		const runsDsId = (runsDb as { data_sources: Array<{ id: string }> }).data_sources[0].id;
		const runs = await notion.dataSources.query({
			data_source_id: runsDsId,
			page_size: 100,
			sorts: [{ timestamp: "created_time", direction: "ascending" }],
		});
		for (const r of runs.results) {
			if (!("properties" in r)) continue;
			const p = r.properties as Record<string, unknown>;
			const get = (n: string, key: "rich_text" | "title" | "select" | "number"): string => {
				const v = p[n] as { type?: string } & Record<string, unknown>;
				if (!v) return "";
				if (key === "rich_text") return ((v.rich_text as Array<{ plain_text: string }>) ?? []).map((x) => x.plain_text).join("");
				if (key === "title") return ((v.title as Array<{ plain_text: string }>) ?? []).map((x) => x.plain_text).join("");
				if (key === "select") return ((v.select as { name?: string }) ?? {}).name ?? "";
				if (key === "number") return String((v.number as number) ?? "");
				return "";
			};
			const name = get("Name", "title");
			const agent = get("Agent", "select");
			const status = get("Status", "select");
			const tokens = get("Tokens", "number");
			const calls = get("Tool Calls", "number");
			const summary = get("Summary", "rich_text");
			console.log(
				`- [${agent || "?"}] ${name} | status=${status} tokens=${tokens} calls=${calls}`,
			);
			if (summary) console.log(`    summary: ${summary.slice(0, 200)}`);
		}
	} else {
		console.log("(no Runs DB found)");
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
