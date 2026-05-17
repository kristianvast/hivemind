import { Client } from "@notionhq/client";

async function main() {
	const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
	const dsId = process.env.HIVEMIND_BRIEFS_DATA_SOURCE_ID;
	if (!dsId) throw new Error("HIVEMIND_BRIEFS_DATA_SOURCE_ID missing");

	const ds = await notion.dataSources.retrieve({ data_source_id: dsId });
	const statusProp = (ds as { properties?: Record<string, unknown> }).properties
		?.Status as
		| {
				type?: string;
				select?: { options?: Array<{ name: string }> };
				status?: { options?: Array<{ name: string }>; groups?: unknown };
		  }
		| undefined;

	console.log("=== Status property schema ===");
	console.log("  type:", statusProp?.type);
	if (statusProp?.type === "select") {
		console.log(
			"  select options:",
			statusProp.select?.options?.map((o) => o.name).join(", "),
		);
	} else if (statusProp?.type === "status") {
		console.log(
			"  status options:",
			statusProp.status?.options?.map((o) => o.name).join(", "),
		);
	}

	const all = await notion.dataSources.query({
		data_source_id: dsId,
		page_size: 100,
	});
	const byStatus = new Map<string, Array<{ id: string; title: string }>>();
	for (const row of all.results) {
		if (!("properties" in row)) continue;
		const p = row.properties as Record<string, { type?: string } & Record<string, unknown>>;
		const sp = p.Status;
		let statusVal = "(null)";
		if (sp?.type === "status") {
			statusVal = (sp.status as { name?: string } | null)?.name ?? "(null)";
		} else if (sp?.type === "select") {
			statusVal = (sp.select as { name?: string } | null)?.name ?? "(null)";
		} else {
			statusVal = `(unknown type=${sp?.type})`;
		}
		const nameProp = p.Name ?? p.Title;
		const titleVal =
			(nameProp?.title as Array<{ plain_text?: string }> | undefined)?.[0]
				?.plain_text ?? "(untitled)";
		if (!byStatus.has(statusVal)) byStatus.set(statusVal, []);
		byStatus.get(statusVal)!.push({ id: row.id, title: titleVal });
	}

	console.log("\n=== Briefs by Status ===");
	for (const [s, rows] of byStatus.entries()) {
		console.log(`  ${s}: ${rows.length}`);
		for (const r of rows.slice(0, 5))
			console.log(`    - ${r.id}  ${r.title.slice(0, 60)}`);
	}

	console.log("\n=== Rescue sync filter test (Status select equals Triaged) ===");
	try {
		const r1 = await notion.dataSources.query({
			data_source_id: dsId,
			filter: { property: "Status", select: { equals: "Triaged" } },
			page_size: 5,
		});
		console.log("  select filter result count:", r1.results.length);
	} catch (e) {
		console.log("  select filter ERROR:", (e as Error).message);
	}
	console.log("\n=== Alternative filter test (Status status equals Triaged) ===");
	try {
		const r2 = await notion.dataSources.query({
			data_source_id: dsId,
			filter: { property: "Status", status: { equals: "Triaged" } } as never,
			page_size: 5,
		});
		console.log("  status filter result count:", r2.results.length);
	} catch (e) {
		console.log("  status filter ERROR:", (e as Error).message);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
