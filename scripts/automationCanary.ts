import { Client } from "@notionhq/client";

import { readHivemindState } from "../src/state";

const CANARY_PROPERTY = "Canary Nonce";
const WAIT_MS = 30_000;

interface CliArgs {
	briefId: string;
}

function parseArgs(): CliArgs {
	const briefId = process.argv[2] ?? process.env.HIVEMIND_AUTOMATION_CANARY_BRIEF_ID;
	if (!briefId) {
		console.error("Usage: automationCanary.ts <briefId>");
		console.error("");
		console.error("Or set HIVEMIND_AUTOMATION_CANARY_BRIEF_ID in .env.");
		console.error("");
		console.error("The canary brief MUST be at a non-Triaged, non-Done status (e.g. Backlog)");
		console.error("and MUST have a rich_text property named 'Canary Nonce'.");
		console.error("Create one with: ntn workers exec runOrchestrator --local ... (manually).");
		process.exit(2);
	}
	return { briefId };
}

async function ensureCanaryProperty(
	notion: Client,
	briefId: string,
): Promise<void> {
	const page = await notion.pages.retrieve({ page_id: briefId });
	const props = (page as { properties?: Record<string, unknown> }).properties ?? {};
	if (!(CANARY_PROPERTY in props)) {
		console.error(
			`Brief is missing the "${CANARY_PROPERTY}" property. Add it as a rich_text property to the Briefs data source.`,
		);
		console.error(
			"You can add it via the Notion UI, or by editing the schema in scripts/seedBriefs.ts and re-deploying.",
		);
		process.exit(2);
	}
}

function randomNonce(): string {
	return `canary-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function main(): Promise<void> {
	const { briefId } = parseArgs();
	if (!process.env.NOTION_API_TOKEN) {
		console.error("NOTION_API_TOKEN is not set. source .env first.");
		process.exit(2);
	}

	const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
	await ensureCanaryProperty(notion, briefId);

	const stateBefore = await readHivemindState(notion, briefId);
	const stormTripsBefore = stateBefore.storm?.trips ?? 0;
	const lastDeliveryBefore = stateBefore.lastDeliveryId;
	const chainStartedBefore = stateBefore.lastChainStartedAt;

	const nonce = randomNonce();
	console.log(
		`[canary] writing nonce=${nonce} to ${CANARY_PROPERTY} on brief ${briefId}`,
	);
	await notion.pages.update({
		page_id: briefId,
		properties: {
			[CANARY_PROPERTY]: {
				rich_text: [
					{ type: "text", text: { content: nonce } },
				],
			},
		},
	});

	console.log(`[canary] waiting ${WAIT_MS / 1000}s for webhook deliveries to settle...`);
	await new Promise((resolve) => setTimeout(resolve, WAIT_MS));

	const stateAfter = await readHivemindState(notion, briefId);
	const stormTripsAfter = stateAfter.storm?.trips ?? 0;
	const lastDeliveryAfter = stateAfter.lastDeliveryId;
	const chainStartedAfter = stateAfter.lastChainStartedAt;
	const deliveryChanged = lastDeliveryAfter !== lastDeliveryBefore;
	const chainStartedChanged = chainStartedAfter !== chainStartedBefore;
	const stormTripped = stormTripsAfter > stormTripsBefore;

	console.log("");
	console.log("[canary] results:");
	console.log(
		`  deliveryId changed:        ${deliveryChanged} (before=${lastDeliveryBefore ?? "—"}, after=${lastDeliveryAfter ?? "—"})`,
	);
	console.log(
		`  chain started during test: ${chainStartedChanged} (before=${chainStartedBefore ?? "—"}, after=${chainStartedAfter ?? "—"})`,
	);
	console.log(
		`  storm gate tripped:        ${stormTripped} (trips before=${stormTripsBefore}, after=${stormTripsAfter})`,
	);

	console.log("");
	if (chainStartedChanged) {
		console.log("FAIL: a chain run started while we only edited a non-Status property.");
		console.log("      The Notion automation is firing on too broad a trigger.");
		console.log("      Fix: in the Briefs DB automation UI, scope the trigger to");
		console.log("           'Status is Triaged' OR 'Status is Done' (NOT 'any property change').");
		process.exit(1);
	}
	if (stormTripped) {
		console.log("WARN: the storm gate tripped — the webhook saw a burst of deliveries.");
		console.log("      The Notion automation likely fires on too broad a trigger.");
		console.log("      Fix as above. The storm gate prevented rate-limit lockout, but");
		console.log("      the underlying misconfiguration should be fixed.");
		process.exit(1);
	}
	if (deliveryChanged) {
		console.log("WARN: the webhook received a delivery for the canary edit.");
		console.log("      It correctly bailed (no chain run), but ideally the automation");
		console.log("      should not fire on non-Status edits at all.");
		console.log("      Consider scoping the automation trigger to Status changes only.");
		process.exit(0);
	}
	console.log("PASS: the webhook did not fire for a non-Status property edit.");
	console.log("      Notion automation trigger appears to be correctly scoped.");
	process.exit(0);
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
