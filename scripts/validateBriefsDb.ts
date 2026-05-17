import { Client } from "@notionhq/client";

const EXPECTED_STATUS_OPTIONS = [
	"Backlog",
	"Triaged",
	"In Progress",
	"Needs Review",
	"Done",
	"Failed",
];

const EXPECTED_OWNER_OPTIONS = ["Architect", "Sentinel", "Forge-Local"];

const REQUIRED_PROPERTIES = ["Status", "Owner", "Category", "📁 Project"] as const;

interface ValidationIssue {
	severity: "error" | "warn";
	message: string;
}

async function main(): Promise<void> {
	const dataSourceId = process.env.HIVEMIND_BRIEFS_DATA_SOURCE_ID;
	if (!dataSourceId) {
		console.error(
			"HIVEMIND_BRIEFS_DATA_SOURCE_ID is not set. Source .env first:",
		);
		console.error("  set -a; source .env; set +a; npx tsx scripts/validateBriefsDb.ts");
		process.exit(2);
	}

	const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
	const ds = await notion.dataSources.retrieve({ data_source_id: dataSourceId });

	const issues: ValidationIssue[] = [];
	const props = (ds as { properties?: Record<string, unknown> }).properties ?? {};

	for (const name of REQUIRED_PROPERTIES) {
		if (!(name in props)) {
			issues.push({
				severity: "error",
				message: `Missing required property "${name}" on Briefs data source`,
			});
		}
	}

	const statusProp = props.Status as
		| { type?: string; select?: { options?: { name: string }[] } }
		| undefined;
	if (statusProp?.type !== "select") {
		issues.push({
			severity: "error",
			message: `"Status" must be type "select" (currently ${statusProp?.type ?? "missing"})`,
		});
	} else {
		const existing = (statusProp.select?.options ?? []).map((o) => o.name);
		for (const expected of EXPECTED_STATUS_OPTIONS) {
			if (!existing.includes(expected)) {
				issues.push({
					severity: "error",
					message: `"Status" missing option "${expected}". Existing: [${existing.join(", ")}]`,
				});
			}
		}
	}

	const ownerProp = props.Owner as
		| { type?: string; select?: { options?: { name: string }[] } }
		| undefined;
	if (ownerProp?.type !== "select") {
		issues.push({
			severity: "warn",
			message: `"Owner" must be type "select" for Forge-Local routing (currently ${ownerProp?.type ?? "missing"})`,
		});
	} else {
		const existing = (ownerProp.select?.options ?? []).map((o) => o.name);
		for (const expected of EXPECTED_OWNER_OPTIONS) {
			if (!existing.includes(expected)) {
				issues.push({
					severity: "warn",
					message: `"Owner" missing option "${expected}". Existing: [${existing.join(", ")}]`,
				});
			}
		}
	}

	for (const envVar of [
		"HIVEMIND_BRIEFS_DATA_SOURCE_ID",
		"HIVEMIND_BRIEFS_DATABASE_ID",
		"HIVEMIND_WEBHOOK_SECRET",
		"HIVEMIND_BOT_USER_ID",
		"NOTION_API_TOKEN",
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
	]) {
		if (!process.env[envVar]) {
			issues.push({
				severity: "error",
				message: `env var "${envVar}" is not set`,
			});
		}
	}

	const errors = issues.filter((i) => i.severity === "error");
	const warns = issues.filter((i) => i.severity === "warn");

	console.log(
		`Validation complete: ${errors.length} error(s), ${warns.length} warning(s)`,
	);
	for (const issue of issues) {
		const tag = issue.severity === "error" ? "ERROR" : "WARN ";
		console.log(`  ${tag} ${issue.message}`);
	}

	if (errors.length === 0) {
		console.log("OK: Briefs data source + env config look good.");
	}

	console.log("");
	console.log("Note: this script cannot verify the Notion automation trigger");
	console.log("configuration (Notion has no public API for automations). Use");
	console.log("`npx tsx scripts/automationCanary.ts` to detect over-firing.");

	process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
