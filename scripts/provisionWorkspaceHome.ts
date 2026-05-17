import { Client } from "@notionhq/client";

import { provisionWorkspaceHome } from "../src/workspaceHome";

async function main(): Promise<void> {
	const token = process.env.NOTION_API_TOKEN;
	const parentPageId = process.env.HIVEMIND_WORKSPACE_PARENT_PAGE_ID;
	const briefsDataSourceId = process.env.HIVEMIND_BRIEFS_DATA_SOURCE_ID;

	if (!token) {
		console.error("Missing NOTION_API_TOKEN");
		process.exit(1);
	}
	if (!parentPageId) {
		console.error(
			"Missing HIVEMIND_WORKSPACE_PARENT_PAGE_ID — set it to the parent page ID where the 🐝 Hivemind Workspace home should live.",
		);
		process.exit(1);
	}
	if (!briefsDataSourceId) {
		console.error(
			"Missing HIVEMIND_BRIEFS_DATA_SOURCE_ID — set it to the Briefs DB's primary data source ID.",
		);
		process.exit(1);
	}

	const notion = new Client({ auth: token });

	console.log("Provisioning 🐝 Hivemind Workspace home page...");
	const ids = await provisionWorkspaceHome({
		notion,
		parentPageId,
		briefsDataSourceId,
	});

	console.log("\n✅ Workspace home provisioned.\n");
	console.log("Add these to .env, then run `ntn workers env push`:\n");
	console.log(`HIVEMIND_WORKSPACE_HOME_PAGE_ID=${ids.homePageId}`);
	console.log(`HIVEMIND_WORKSPACE_ACTIVITY_DB_ID=${ids.activityDbId}`);
	console.log(`HIVEMIND_WORKSPACE_ACTIVITY_DS_ID=${ids.activityDsId}`);
	console.log(`HIVEMIND_WORKSPACE_AUDIT_DB_ID=${ids.auditDbId}`);
	console.log(`HIVEMIND_WORKSPACE_AUDIT_DS_ID=${ids.auditDsId}`);
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
