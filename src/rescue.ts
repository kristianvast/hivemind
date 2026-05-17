// Self-healing rescue sweep for the Hivemind orchestrator.
//
// Why this exists: the `onBriefStatusChange` webhook is the primary trigger for
// orchestrator runs, but it shares a per-capability delivery budget with the
// Notion Workers platform. A misconfigured Notion automation (firing on every
// property change instead of just Status=Triaged) can exhaust that budget in
// ~60 deliveries and lock the webhook out for ~30 minutes. While locked out,
// briefs the user moves to Triaged sit forever — the webhook never gets to run.
//
// This sync runs every 2 minutes on its OWN per-capability budget. It queries
// the Briefs DS for Status=Triaged, acquires the same chain lock as the
// webhook (`acquireChainLock` from src/lock.ts), and runs the orchestrator on
// any brief the webhook missed. Bounded batch (page_size=5) keeps a single
// sync run cheap; the cadence drains backlog steadily.
//
// Idempotency: both paths use the same lock + `lastChainStartedAt` coalesce
// window, so a brief that the webhook is already processing (or just finished
// processing) will be skipped by the sync.

import type { Client } from "@notionhq/client";
import { isFullPage } from "@notionhq/client";

import { acquireChainLock, releaseChainLock } from "./lock";
import { getBriefContext } from "./notion";
import { runOrchestratorForBrief } from "./orchestrator";

const RESCUE_BATCH_SIZE = 5;
const TRIAGED_STATUS = "Triaged";

export interface RescuePassResult {
	scanned: number;
	acquired: number;
	processed: number;
	skipped: number;
	errors: number;
}

export async function runTriagedRescuePass(args: {
	notion: Client;
	dataSourceId: string;
	botUserId: string | undefined;
}): Promise<RescuePassResult> {
	const { notion, dataSourceId, botUserId } = args;
	const result: RescuePassResult = {
		scanned: 0,
		acquired: 0,
		processed: 0,
		skipped: 0,
		errors: 0,
	};

	let triaged: Awaited<ReturnType<typeof notion.dataSources.query>>;
	try {
		triaged = await notion.dataSources.query({
			data_source_id: dataSourceId,
			filter: {
				property: "Status",
				select: { equals: TRIAGED_STATUS },
			},
			sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
			page_size: RESCUE_BATCH_SIZE,
		});
	} catch (err) {
		console.error("[rescue] data source query failed:", err);
		result.errors += 1;
		return result;
	}

	result.scanned = triaged.results.length;

	for (const row of triaged.results) {
		if (!("id" in row)) {
			result.skipped += 1;
			continue;
		}
		const pageId = row.id;
		const deliveryId = `triagedRescue:${new Date().toISOString()}:${pageId}`;

		let acquired = false;
		try {
			acquired = await acquireChainLock({ notion, pageId, deliveryId });
			if (!acquired) {
				result.skipped += 1;
				continue;
			}
			result.acquired += 1;

			const page = await notion.pages.retrieve({ page_id: pageId });
			if (!isFullPage(page) || page.in_trash) {
				result.skipped += 1;
				continue;
			}

			const brief = await getBriefContext(notion, page);
			if (brief.status !== TRIAGED_STATUS) {
				console.log(
					"[rescue] status changed under us for",
					pageId,
					"status=",
					brief.status,
					"— skipping",
				);
				result.skipped += 1;
				continue;
			}

			console.log(
				"[rescue] dispatching orchestrator for",
				pageId,
				"title=",
				brief.title.slice(0, 80),
			);
			const orchestratorResult = await runOrchestratorForBrief({
				notion,
				brief,
				botUserId,
			});
			if (orchestratorResult.ok) {
				result.processed += 1;
			} else {
				console.error(
					"[rescue] orchestrator reported failure for",
					pageId,
					"stage=",
					orchestratorResult.stage,
					"error=",
					orchestratorResult.error,
				);
				result.errors += 1;
			}
		} catch (err) {
			console.error("[rescue] error processing", pageId, err);
			result.errors += 1;
		} finally {
			if (acquired) {
				try {
					await releaseChainLock({ notion, pageId });
				} catch (err) {
					console.warn(
						"[rescue] failed to release chain lock for",
						pageId,
						err,
					);
				}
			}
		}
	}

	console.log(
		"[rescue] pass complete:",
		`scanned=${result.scanned}`,
		`acquired=${result.acquired}`,
		`processed=${result.processed}`,
		`skipped=${result.skipped}`,
		`errors=${result.errors}`,
	);
	return result;
}
