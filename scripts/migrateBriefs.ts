// scripts/migrateBriefs.ts
//
// Idempotent migration: adds Category, Hivemind State, and 📁 Project
// properties to the existing Hivemind Briefs data source. Safe to re-run.
//
// For the UX polish on top (description on Hivemind State, hide it from
// views), run scripts/configureBriefsUI.ts after this.
//
// Usage: npx tsx --env-file=.env scripts/migrateBriefs.ts

import { Client } from "@notionhq/client";

type NotionColor =
	| "default"
	| "gray"
	| "brown"
	| "orange"
	| "yellow"
	| "green"
	| "blue"
	| "purple"
	| "pink"
	| "red";

const CATEGORY_OPTIONS: { name: string; color: NotionColor }[] = [
	{ name: "visual-engineering", color: "blue" },
	{ name: "ultrabrain", color: "purple" },
	{ name: "deep", color: "orange" },
	{ name: "quick", color: "gray" },
	{ name: "writing", color: "pink" },
];

async function main(): Promise<void> {
	const token = process.env.NOTION_API_TOKEN;
	const dsId = process.env.HIVEMIND_BRIEFS_DATA_SOURCE_ID;

	if (!token) {
		console.error("ERROR: NOTION_API_TOKEN not set");
		process.exit(1);
	}
	if (!dsId) {
		console.error("ERROR: HIVEMIND_BRIEFS_DATA_SOURCE_ID not set");
		process.exit(1);
	}

	const notion = new Client({ auth: token });

	console.log(`Inspecting data source ${dsId}...`);
	const ds = await notion.dataSources.retrieve({ data_source_id: dsId });

	const existingProps = ds.properties;
	const updates: Record<string, unknown> = {};

	if (!existingProps.Category) {
		updates.Category = { select: { options: CATEGORY_OPTIONS } };
		console.log("  + adding Category (select)");
	} else {
		console.log("  = Category already present, skipping");
	}

	if (!existingProps["Hivemind State"]) {
		updates["Hivemind State"] = { rich_text: {} };
		console.log("  + adding Hivemind State (rich_text)");
	} else {
		console.log("  = Hivemind State already present, skipping");
	}

	if (!existingProps["📁 Project"]) {
		updates["📁 Project"] = { url: {} };
		console.log("  + adding 📁 Project (url)");
	} else {
		console.log("  = 📁 Project already present, skipping");
	}

	if (Object.keys(updates).length === 0) {
		console.log("\nAlready fully migrated. No changes needed.");
		return;
	}

	console.log(`\nApplying ${Object.keys(updates).length} property addition(s)...`);
	await notion.dataSources.update({
		data_source_id: dsId,
		properties: updates as Parameters<typeof notion.dataSources.update>[0]["properties"],
	});
	console.log("Migration complete.");
	console.log(
		"\nNext: hide Hivemind State from views and add a property description:",
	);
	console.log("  bun run scripts/configureBriefsUI.ts");
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`Migration failed: ${msg}`);
	process.exit(1);
});
