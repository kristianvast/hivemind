// scripts/configureBriefsUI.ts
//
// Idempotent UX bootstrap for the Hivemind Briefs DB. Run once after seeding
// (and safely re-run anytime). It turns the brief detail panel from a wall of
// internal JSON into something a human can read at a glance:
//
//   1. Adds a `📁 Project` URL property if missing. provision.ts populates
//      this with the project subtree URL so the user has a one-click entry
//      point from the brief into their Plan / Drafts / Activity.
//
//   2. Adds a description to the `Hivemind State` property explaining that
//      it is internal worker state. The description shows up on hover in
//      the Notion UI.
//
//   3. Hides `Hivemind State` from every view on the Briefs database via the
//      Views API. Hidden properties land in the collapsed "X hidden properties"
//      section at the bottom of the detail panel instead of dominating it.
//
// Requires:
//   - NOTION_API_TOKEN
//   - HIVEMIND_BRIEFS_DATABASE_ID
//   - HIVEMIND_BRIEFS_DATA_SOURCE_ID
//
// Usage:
//   bun run scripts/configureBriefsUI.ts
//   # or: npx tsx --env-file=.env scripts/configureBriefsUI.ts

import { Client } from "@notionhq/client";

const STATE_PROP = "Hivemind State";
const PROJECT_PROP = "📁 Project";
const STATE_DESCRIPTION =
	"🔒 Internal Hivemind orchestrator state. Managed by the worker — do not edit.";

async function main(): Promise<void> {
	const token = process.env.NOTION_API_TOKEN;
	const databaseId = process.env.HIVEMIND_BRIEFS_DATABASE_ID;
	const dataSourceId = process.env.HIVEMIND_BRIEFS_DATA_SOURCE_ID;

	if (!token) {
		console.error("ERROR: NOTION_API_TOKEN not set");
		process.exit(1);
	}
	if (!databaseId) {
		console.error("ERROR: HIVEMIND_BRIEFS_DATABASE_ID not set");
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

	const stateProp = props[STATE_PROP];
	if (!stateProp) {
		console.warn(
			`  ! ${STATE_PROP} not found on this data source. Skipping description update.`,
		);
	} else {
		const currentDescription = stateProp.description ?? "";
		if (currentDescription === STATE_DESCRIPTION) {
			console.log(`  = ${STATE_PROP} description already set, skipping`);
		} else {
			propertyUpdates[STATE_PROP] = {
				rich_text: {},
				description: STATE_DESCRIPTION,
			};
			console.log(`  ~ updating ${STATE_PROP} description`);
		}
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

	// Notion's page detail panel shows all visible-in-view properties up top
	// and tucks hidden ones into a collapsed "X hidden properties" section.
	// Marking the State property visible:false in every view keeps it out of
	// the user's face while remaining queryable by code.
	console.log(`\nListing views on database ${databaseId}…`);
	const viewList = await notion.views.list({ database_id: databaseId });
	console.log(`  found ${viewList.results.length} view(s)`);

	for (const ref of viewList.results) {
		const view = await notion.views.retrieve({ view_id: ref.id });
		if (!isFullView(view)) {
			console.warn(
				`  ! view ${ref.id} returned partial response (likely a permissions issue); skipping`,
			);
			continue;
		}
		const label = `${view.name} (${view.type})`;

		if (view.type === "dashboard") {
			console.log(`  - ${label}: dashboard, skipping`);
			continue;
		}

		if (view.type === "form") {
			console.log(`  - ${label}: form, skipping`);
			continue;
		}

		const existing = readViewProperties(view);
		const merged = applyVisibility(existing, ds.properties, {
			[STATE_PROP]: false,
			[PROJECT_PROP]: true,
		});

		if (!merged) {
			console.log(`  - ${label}: visibility already correct, skipping`);
			continue;
		}

		const updated = await notion.views.update({
			view_id: view.id,
			configuration: buildConfigurationPatch(view, merged),
		});
		const finalProps = readViewProperties(updated);
		const stateOk = singleEntryHasVisibility(finalProps, STATE_PROP, false);
		const projectOk = singleEntryHasVisibility(finalProps, PROJECT_PROP, true);
		console.log(
			`  ${stateOk && projectOk ? "✓" : "?"} ${label}: ${STATE_PROP}=hidden ${projectOk ? "✓" : "?"} ${PROJECT_PROP}=visible ${stateOk ? "✓" : "?"}`,
		);
	}

	await backfillProjectUrls(notion, dataSourceId);

	console.log("\nDone. Refresh Notion to see the cleaner brief detail panel.");
}

/**
 * Walk every brief in the Briefs data source and populate the 📁 Project URL
 * for any brief that already has a provisioned project subtree (i.e. its
 * Hivemind State JSON contains projectRootId). New briefs get this for free
 * via provision.ts; this only matters for briefs that pre-date the property.
 */
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

			const stateProp = page.properties[STATE_PROP];
			if (stateProp?.type !== "rich_text") {
				skipped++;
				continue;
			}
			const raw = stateProp.rich_text.map((rt) => rt.plain_text).join("");
			if (!raw.trim()) {
				skipped++;
				continue;
			}

			let projectRootId: string | undefined;
			try {
				const parsed = JSON.parse(raw) as { projectRootId?: string };
				projectRootId = parsed.projectRootId;
			} catch {
				skipped++;
				continue;
			}
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

interface ViewPropertyEntry {
	property_id?: string;
	property_name?: string;
	visible?: boolean;
	width?: number;
	wrap?: boolean;
	[k: string]: unknown;
}

interface FullView {
	id: string;
	name: string;
	type: string;
	configuration?:
		| {
				type: string;
				properties?: ViewPropertyEntry[] | null;
				[k: string]: unknown;
		  }
		| null;
}

function isFullView(view: unknown): view is FullView {
	return (
		typeof view === "object" &&
		view !== null &&
		"name" in view &&
		typeof (view as { name: unknown }).name === "string"
	);
}

function readViewProperties(view: unknown): ViewPropertyEntry[] {
	const v = view as FullView;
	const cfg = v.configuration;
	if (!cfg || !Array.isArray(cfg.properties)) return [];
	return cfg.properties;
}

/**
 * Build a properties array enforcing the requested visibility for one or more
 * named properties while preserving all other view customization (widths,
 * wraps, visibility of other columns).
 *
 * Returns `null` when no change is needed.
 *
 * Important: as of the March 30 2026 changelog, a partial `properties` array
 * sent to Update View hides any unlisted property. So we must echo back the
 * full set, not just the entry we're changing.
 *
 * Dedup: a previous run may have left duplicate entries (matching the same
 * property by id and by name). We canonicalize to exactly one entry per
 * managed property, keyed by name.
 */
function applyVisibility(
	existing: ViewPropertyEntry[],
	allProps: Record<string, { id: string; name: string }>,
	desired: Record<string, boolean>,
): ViewPropertyEntry[] | null {
	const managedNames = new Set(Object.keys(desired));
	const managedIds = new Set<string>();
	for (const name of managedNames) {
		const def = allProps[name];
		if (def?.id) managedIds.add(def.id);
	}

	const isManaged = (entry: ViewPropertyEntry): boolean => {
		if (entry.property_name && managedNames.has(entry.property_name)) return true;
		if (entry.property_id && managedIds.has(entry.property_id)) return true;
		if (entry.property_id && managedNames.has(entry.property_id)) return true;
		return false;
	};

	const unmanaged: ViewPropertyEntry[] = [];
	const observedVisibility = new Map<string, boolean | undefined>();
	for (const entry of existing) {
		if (!isManaged(entry)) {
			unmanaged.push({ ...entry });
			continue;
		}
		const name =
			entry.property_name && managedNames.has(entry.property_name)
				? entry.property_name
				: resolveManagedName(entry, allProps, managedNames);
		if (name && !observedVisibility.has(name)) {
			observedVisibility.set(name, entry.visible);
		}
	}

	let changed = false;

	if (existing.length === 0) {
		for (const [name, def] of Object.entries(allProps)) {
			if (managedNames.has(name)) continue;
			unmanaged.push({
				property_id: def.id,
				visible: true,
			});
		}
		changed = true;
	}

	const managedOut: ViewPropertyEntry[] = [];
	for (const name of managedNames) {
		const want = desired[name];
		const have = observedVisibility.get(name);
		if (have !== want) changed = true;
		managedOut.push({ property_id: name, visible: want });
	}

	const existingManagedCount = existing.filter(isManaged).length;
	if (existingManagedCount !== managedOut.length) changed = true;

	if (!changed) return null;

	const out: ViewPropertyEntry[] = [];
	for (const entry of unmanaged) {
		const cleaned: ViewPropertyEntry = { ...entry };
		delete cleaned.property_name;
		out.push(cleaned);
	}
	out.push(...managedOut);
	return out;
}

function resolveManagedName(
	entry: ViewPropertyEntry,
	allProps: Record<string, { id: string; name: string }>,
	managedNames: Set<string>,
): string | undefined {
	if (!entry.property_id) return undefined;
	for (const [name, def] of Object.entries(allProps)) {
		if (def.id === entry.property_id && managedNames.has(name)) return name;
	}
	return undefined;
}

function singleEntryHasVisibility(
	properties: ViewPropertyEntry[],
	name: string,
	want: boolean,
): boolean {
	const matches = properties.filter(
		(p) => p.property_name === name || p.property_id === name,
	);
	if (matches.length !== 1) return false;
	return matches[0]?.visible === want;
}

/**
 * The Views API uses a discriminated-union `configuration` keyed on `type`.
 * Each variant has its own required fields (board needs `group_by`, calendar
 * needs `date_property_id`, timeline needs both date fields, etc). To safely
 * mutate only the `properties` array, echo back the view's existing config
 * with `properties` overwritten.
 */
function buildConfigurationPatch(
	view: FullView,
	properties: ViewPropertyEntry[],
): Parameters<Client["views"]["update"]>[0]["configuration"] {
	const existing = view.configuration ?? { type: view.type };
	const patch = { ...existing, type: view.type, properties };
	return patch as Parameters<Client["views"]["update"]>[0]["configuration"];
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`configureBriefsUI failed: ${msg}`);
	if (err instanceof Error && err.stack) {
		console.error(err.stack);
	}
	process.exit(1);
});
