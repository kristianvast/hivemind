import type { Client } from "@notionhq/client";

import {
	type Brief,
	runForge,
	runForgeRetry,
	runScout,
	runSentinel,
} from "./agents";
import {
	type BriefContext,
	appendBlocks,
	heading2,
	listReviewerFeedback,
	mdToBlocks,
	postComment,
	readPriorChainState,
	reportChainFailure,
	setBriefProperties,
} from "./notion";

function briefForAgents(ctx: BriefContext): Brief {
	return ctx.body ? { title: ctx.title, body: ctx.body } : { title: ctx.title };
}

export async function runChainForBrief(args: {
	notion: Client;
	brief: BriefContext;
	botUserId: string | undefined;
}): Promise<void> {
	const { notion, brief, botUserId } = args;
	const pageId = brief.pageId;
	const agentBrief = briefForAgents(brief);
	const prior = await readPriorChainState(notion, pageId);

	let stage = "start";
	try {
		if (prior.hasForge) {
			stage = "retry:feedback";
			const feedback = await listReviewerFeedback(notion, pageId, botUserId);
			const effectiveFeedback =
				feedback.length > 0
					? feedback
					: "(no explicit reviewer comments — the human dragged the brief back to Triaged. Make a meaningfully different revision based on your own self-critique.)";

			stage = "retry:forge";
			await setBriefProperties(notion, pageId, {
				status: "In Progress",
				owner: "Forge",
			});
			const artifact = await runForgeRetry({
				brief: agentBrief,
				scoutNotes: prior.scoutNotes,
				previousArtifact: prior.previousArtifact,
				feedback: effectiveFeedback,
			});
			const nextIteration = prior.iteration + 1;
			await appendBlocks(notion, pageId, [
				heading2(`🔨 Forge — iteration ${nextIteration}`),
				...mdToBlocks(artifact),
			]);

			stage = "retry:sentinel";
			await setBriefProperties(notion, pageId, { owner: "Sentinel" });
			const review = await runSentinel({
				brief: agentBrief,
				scoutNotes: prior.scoutNotes,
				artifact,
			});
			await appendBlocks(notion, pageId, [
				heading2(`🛡 Sentinel — review (iteration ${nextIteration})`),
				...mdToBlocks(review),
			]);

			stage = "retry:finalize";
			await setBriefProperties(notion, pageId, { status: "Needs Review" });
			return;
		}

		stage = "initial:scout";
		await setBriefProperties(notion, pageId, {
			status: "In Progress",
			owner: "Scout",
		});
		const scoutNotes = await runScout(agentBrief);
		await appendBlocks(notion, pageId, [
			heading2("🔍 Scout — research note"),
			...mdToBlocks(scoutNotes),
		]);

		stage = "initial:forge";
		await setBriefProperties(notion, pageId, { owner: "Forge" });
		const artifact = await runForge({ brief: agentBrief, scoutNotes });
		await appendBlocks(notion, pageId, [
			heading2("🔨 Forge — artifact"),
			...mdToBlocks(artifact),
		]);

		stage = "initial:sentinel";
		await setBriefProperties(notion, pageId, { owner: "Sentinel" });
		const review = await runSentinel({
			brief: agentBrief,
			scoutNotes,
			artifact,
		});
		await appendBlocks(notion, pageId, [
			heading2("🛡 Sentinel — review"),
			...mdToBlocks(review),
		]);

		stage = "initial:finalize";
		await setBriefProperties(notion, pageId, { status: "Needs Review" });
	} catch (err) {
		console.error("[chain] failed at stage", stage, err);
		await reportChainFailure(notion, pageId, stage, err);
	}
}

const APPROVAL_COMMENT = "✅ Hivemind approved. The swarm is at rest.";

export async function handleBriefApproved(
	notion: Client,
	pageId: string,
): Promise<void> {
	const existing = await notion.comments.list({
		block_id: pageId,
		page_size: 100,
	});
	const alreadyApproved = existing.results.some((c) =>
		c.rich_text.some((rt) => rt.plain_text.includes(APPROVAL_COMMENT)),
	);
	if (alreadyApproved) {
		console.log("[chain] approval comment already present, skipping");
		return;
	}
	await postComment(notion, pageId, APPROVAL_COMMENT);
}
