// scripts/seedBriefs.ts
//
// Creates a regular (NOT Worker-managed) "Hivemind Briefs" database via the
// Notion REST API, parented under a page you own + have shared with the
// Hivemind Hack integration.
//
// Why this script exists:
//   `worker.database()` in the Workers SDK creates a Notion-managed DB whose
//   schema is permanently read-only in the Notion UI — you cannot add Kanban
//   views, edit cells, or wire automations on it. This script bypasses that
//   by hitting POST /v1/databases directly with the bot token, producing a
//   regular DB that the user fully controls.
//
// Prerequisites:
//   1. .env contains NOTION_API_TOKEN (your Hivemind Hack integration token).
//   2. You created a Notion page (e.g. named "Hivemind") and shared it with
//      the Hivemind Hack integration via ... → Connections.
//
// Usage:
//   bun run scripts/seedBriefs.ts <parent-page-url-or-id>
//
//   # or, if you prefer Node + tsx:
//   npx tsx --env-file=.env scripts/seedBriefs.ts <parent-page-url-or-id>

const NOTION_VERSION = "2025-09-03";
const NOTION_API_URL = "https://api.notion.com/v1/databases";

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

interface SelectOption {
	name: string;
	color: NotionColor;
}

const STATUS_OPTIONS: SelectOption[] = [
	{ name: "Backlog", color: "default" },
	{ name: "Triaged", color: "gray" },
	{ name: "In Progress", color: "blue" },
	{ name: "Needs Review", color: "yellow" },
	{ name: "Done", color: "green" },
	{ name: "Failed", color: "red" },
	{ name: "Archived", color: "brown" },
];

const OWNER_OPTIONS: SelectOption[] = [
	{ name: "Triage", color: "default" },
	{ name: "Architect", color: "yellow" },
	{ name: "Scout", color: "blue" },
	{ name: "Forge", color: "orange" },
	{ name: "Scribe", color: "purple" },
	{ name: "Sentinel", color: "red" },
];

const CATEGORY_OPTIONS: SelectOption[] = [
	{ name: "visual-engineering", color: "blue" },
	{ name: "ultrabrain", color: "purple" },
	{ name: "deep", color: "orange" },
	{ name: "quick", color: "gray" },
	{ name: "writing", color: "pink" },
];

function extractPageId(input: string): string {
	const hex = input.replace(/[^a-f0-9]/gi, "").toLowerCase();
	const last32 = hex.slice(-32);
	if (last32.length !== 32) {
		throw new Error(
			`Could not extract a 32-char hex page ID from input: ${input}\n` +
				`Expected a Notion page URL or a 32-char (or dashed UUID) page ID.`,
		);
	}
	return [
		last32.slice(0, 8),
		last32.slice(8, 12),
		last32.slice(12, 16),
		last32.slice(16, 20),
		last32.slice(20),
	].join("-");
}

async function main(): Promise<void> {
	const token = process.env.NOTION_API_TOKEN;
	if (!token) {
		console.error(
			"ERROR: NOTION_API_TOKEN is not set in the environment.\n" +
				"Run with bun (auto-loads .env):  bun run scripts/seedBriefs.ts <url>\n" +
				"Or with tsx:                     npx tsx --env-file=.env scripts/seedBriefs.ts <url>",
		);
		process.exit(1);
	}

	const arg = process.argv[2];
	if (!arg) {
		console.error(
			"Usage: bun run scripts/seedBriefs.ts <parent-page-url-or-id>",
		);
		process.exit(1);
	}

	const parentPageId = extractPageId(arg);
	console.log(`Parent page ID: ${parentPageId}`);

	// Check if Briefs DB already exists under the parent page
	const checkRes = await fetch(
		`https://api.notion.com/v1/blocks/${parentPageId}/children?page_size=100`,
		{
			headers: {
				Authorization: `Bearer ${token}`,
				"Notion-Version": NOTION_VERSION,
			},
		},
	);

	const checkJson = (await checkRes.json()) as Record<string, unknown>;
	const results = Array.isArray(checkJson.results) ? checkJson.results : [];

	for (const block of results) {
		const blockObj = block as Record<string, unknown>;
		if (
			blockObj.type === "child_database" &&
			typeof blockObj.child_database === "object" &&
			blockObj.child_database !== null
		) {
			const childDb = blockObj.child_database as Record<string, unknown>;
			if (childDb.title === "Hivemind Briefs") {
				const existingId = typeof blockObj.id === "string" ? blockObj.id : undefined;
				console.log(`✅ Briefs DB already exists: ${existingId}`);
				console.log("\nNext steps:");
				console.log("  1. Resolve the data source ID:");
				console.log(`     ntn datasources resolve ${existingId ?? "<db-id>"}`);
				console.log("");
				console.log("  2. Update .env with the IDs:");
				console.log(`     HIVEMIND_BRIEFS_DATABASE_ID=${existingId ?? "<db-id>"}`);
				console.log(`     HIVEMIND_BRIEFS_DATA_SOURCE_ID=<data-source-id>`);
				process.exit(0);
			}
		}
	}

	const body = {
		parent: { type: "page_id" as const, page_id: parentPageId },
		title: [
			{
				type: "text" as const,
				text: { content: "Hivemind Briefs" },
			},
		],
		initial_data_source: {
			properties: {
				Name: { title: {} },
				Status: { select: { options: STATUS_OPTIONS } },
				Owner: { select: { options: OWNER_OPTIONS } },
				Category: { select: { options: CATEGORY_OPTIONS } },
				"📁 Project": { url: {} },
			},
		},
	};

	const res = await fetch(NOTION_API_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"Notion-Version": NOTION_VERSION,
		},
		body: JSON.stringify(body),
	});

	const json = (await res.json()) as Record<string, unknown>;

	if (!res.ok) {
		console.error(`Notion API error (HTTP ${res.status}):`);
		console.error(JSON.stringify(json, null, 2));
		console.error(
			"\nMost common causes:\n" +
				"  - The integration is not shared with the parent page (Connections menu).\n" +
				"  - The parent page ID is wrong (paste the full Notion page URL).",
		);
		process.exit(1);
	}

	const dbId = typeof json.id === "string" ? json.id : undefined;
	const dbUrl = typeof json.url === "string" ? json.url : undefined;

	console.log("\n✅ Hivemind Briefs DB created\n");
	if (dbId) console.log(`Database ID:  ${dbId}`);
	if (dbUrl) console.log(`Database URL: ${dbUrl}`);

	console.log("\nNext steps:");
	console.log("  1. Resolve the data source ID:");
	console.log(`     ntn datasources resolve ${dbId ?? "<db-id>"}`);
	console.log("");
	console.log("  2. Update .env with the new IDs:");
	console.log(`     HIVEMIND_BRIEFS_DATABASE_ID=${dbId ?? "<db-id>"}`);
	console.log(`     HIVEMIND_BRIEFS_DATA_SOURCE_ID=<data-source-id>`);
	console.log("");
	console.log("  3. Push to the deployed worker:");
	console.log("     ntn workers env push --yes");
	console.log("");
	console.log("  4. Apply UX bootstrap (📁 Project URL + remove legacy state prop):");
	console.log("     bun run scripts/configureBriefsUI.ts");
	console.log("");
	console.log("  5. In Notion, on the new DB:");
	console.log("     - Add a Kanban view grouped by Status");
	console.log("     - Create one test brief in 'Backlog'");
	console.log("     - Category is auto-populated by the classifier");
	console.log("     - 📁 Project URL is auto-populated after the chain provisions the subtree");
	console.log(
		"     - Wire DB automation: When Status changes → Send webhook → paste the onBriefStatusChange URL",
	);
	console.log("     - Add header: X-Hivemind-Secret: <HIVEMIND_WEBHOOK_SECRET>");
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
