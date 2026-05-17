// scripts/configureBriefsUI.ts
//
// Idempotent UX bootstrap for the Hivemind Briefs DB. Run once after seeding
// (and safely re-run anytime). Two responsibilities:
//
//   1. Adds a `📁 Project` URL property if missing. provision.ts populates
//      this with the project subtree URL so the user has a one-click entry
//      point from the brief into their Plan / Drafts / Activity.
//
//   2. Removes the legacy `Hivemind State` rich_text property. State now
//      lives in a collapsed toggle on the brief page itself (see
//      src/state.ts) — keeping the property would just expose a stale, empty
//      JSON blob in the brief detail panel.
//
// Then backfills `📁 Project` URLs on existing briefs that have a
// provisioned subtree (state.projectRootId) but no URL yet.
//
// Requires:
//   - NOTION_API_TOKEN
//   - HIVEMIND_BRIEFS_DATABASE_ID  (for backfill via dataSources.query)
//   - HIVEMIND_BRIEFS_DATA_SOURCE_ID
//
// Usage:
//   bun run scripts/configureBriefsUI.ts
//   # or: npx tsx --env-file=.env scripts/configureBriefsUI.ts

import { Client } from "@notionhq/client";

import { readHivemindState } from "../src/state";

const LEGACY_STATE_PROP = "Hivemind State";
const PROJECT_PROP = "📁 Project";

async function main(): Promise<void> {
	const token = process.env.NOTION_API_TOKEN;
	const dataSourceId = process.env.HIVEMIND_BRIEFS_DATA_SOURCE_ID;

	if (!token) {
		console.error("ERROR: NOTION_API_TOKEN not set");
		process.exit(1);
	}
	if (!dataSourceId) {
		console.error("ERROR: HIVEMIND_BRIEFS_DATA_SOURCE_ID not set");
		process.exit(1);
	}

	const notion = new Client({ auth: token });

	console.log(`Inspecting data source ${dataSourceId}…`);
	const ds = await notion.dataSources.retrieve({
		data_source_id: dataSourceId,
	});
	const props = ds.properties;

	const propertyUpdates: Record<string, unknown> = {};

	if (!props[PROJECT_PROP]) {
		propertyUpdates[PROJECT_PROP] = { url: {} };
		console.log(`  + adding ${PROJECT_PROP} (url)`);
	} else if (props[PROJECT_PROP].type !== "url") {
		console.warn(
			`  ! ${PROJECT_PROP} exists but is type=${props[PROJECT_PROP].type}, expected url — skipping`,
		);
	} else {
		console.log(`  = ${PROJECT_PROP} already present, skipping`);
	}

	if (props[LEGACY_STATE_PROP]) {
		propertyUpdates[LEGACY_STATE_PROP] = null;
		console.log(`  - removing legacy ${LEGACY_STATE_PROP} property`);
	} else {
		console.log(`  = ${LEGACY_STATE_PROP} already absent, skipping`);
	}

	if (Object.keys(propertyUpdates).length > 0) {
		await notion.dataSources.update({
			data_source_id: dataSourceId,
			properties: propertyUpdates as Parameters<
				typeof notion.dataSources.update
			>[0]["properties"],
		});
		console.log(
			`  ✓ applied ${Object.keys(propertyUpdates).length} schema update(s)`,
		);
	} else {
		console.log("  ✓ schema already in desired state");
	}

	await backfillProjectUrls(notion, dataSourceId);

	console.log("\nDone. Refresh Notion to see the cleaner brief detail panel.");
}

async function backfillProjectUrls(
	notion: Client,
	dataSourceId: string,
): Promise<void> {
	console.log(`\nBackfilling ${PROJECT_PROP} on existing briefs…`);
	let cursor: string | undefined;
	let scanned = 0;
	let backfilled = 0;
	let skipped = 0;

	do {
		const res = await notion.dataSources.query({
			data_source_id: dataSourceId,
			start_cursor: cursor,
			page_size: 100,
		});
		for (const page of res.results) {
			if (!("properties" in page)) continue;
			scanned++;

			const projectProp = page.properties[PROJECT_PROP];
			if (projectProp?.type === "url" && projectProp.url) {
				skipped++;
				continue;
			}

			const state = await readHivemindState(notion, page.id);
			const projectRootId = state.projectRootId;
			if (!projectRootId) {
				skipped++;
				continue;
			}

			try {
				const rootPage = await notion.pages.retrieve({
					page_id: projectRootId,
				});
				if (!("url" in rootPage) || !rootPage.url) {
					skipped++;
					continue;
				}
				await notion.pages.update({
					page_id: page.id,
					properties: {
						[PROJECT_PROP]: { url: rootPage.url },
					},
				});
				backfilled++;
				console.log(`  ✓ ${page.id.slice(0, 8)}… → ${rootPage.url}`);
			} catch (err) {
				console.warn(
					`  ! ${page.id.slice(0, 8)}…: backfill failed (${err instanceof Error ? err.message : String(err)})`,
				);
				skipped++;
			}
		}
		cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	} while (cursor);

	console.log(
		`  scanned=${scanned} backfilled=${backfilled} skipped=${skipped}`,
	);
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`configureBriefsUI failed: ${msg}`);
	if (err instanceof Error && err.stack) {
		console.error(err.stack);
	}
	process.exit(1);
});
