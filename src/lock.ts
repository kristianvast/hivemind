// Per-brief chain lock shared by the webhook (`onBriefStatusChange`) and the
// scheduled rescue sync (`triagedRescue`). Only one orchestrator run may be
// in flight for a given brief; whichever caller acquires the lock first wins,
// the other bails out.
//
// State shape: `chainRunning = { startedAt, deliveryId }` in the brief's
// HivemindState toggle. `lastChainStartedAt` is a separate field that survives
// chain completion and is consulted to coalesce rapid-fire retriggers within
// CHAIN_COALESCE_MS — burst noise gets absorbed, human-paced retries (Triaged →
// Needs Review → Triaged) are always > 10 s and pass through.
//
// Race detection: after writing our own ownership we sleep
// LOCK_VERIFY_DELAY_MS then re-read state; if a concurrent writer overwrote
// us, we abort. Without the second read two webhooks delivered ~10 ms apart
// can both pass the "chainRunning is empty" check, both write themselves in,
// and both proceed.

import type { Client } from "@notionhq/client";

import { mergeHivemindState, readHivemindState } from "./state";

export const CHAIN_LOCK_TTL_MS = 15 * 60 * 1000;
export const LOCK_VERIFY_DELAY_MS = 750;
export const CHAIN_COALESCE_MS = 10_000;

export interface AcquireChainLockArgs {
	notion: Client;
	pageId: string;
	deliveryId: string;
}

export async function acquireChainLock(
	args: AcquireChainLockArgs,
): Promise<boolean> {
	const { notion, pageId, deliveryId } = args;
	const now = Date.now();

	const fresh = await readHivemindState(notion, pageId);
	if (fresh.chainRunning) {
		const startedAt = Date.parse(fresh.chainRunning.startedAt);
		if (Number.isFinite(startedAt) && now - startedAt < CHAIN_LOCK_TTL_MS) {
			console.log(
				"[lock] chain already running for",
				pageId,
				"since",
				fresh.chainRunning.startedAt,
				"owner-delivery=",
				fresh.chainRunning.deliveryId,
				"— skip",
				deliveryId,
			);
			return false;
		}
		console.log(
			"[lock] stale lock for",
			pageId,
			"from",
			fresh.chainRunning.startedAt,
			"— overriding with",
			deliveryId,
		);
	}

	if (fresh.lastChainStartedAt) {
		const lastStartedAt = Date.parse(fresh.lastChainStartedAt);
		if (
			Number.isFinite(lastStartedAt) &&
			now - lastStartedAt < CHAIN_COALESCE_MS
		) {
			console.log(
				"[lock] coalesced — chain started",
				now - lastStartedAt,
				"ms ago for",
				pageId,
				"— skip",
				deliveryId,
			);
			return false;
		}
	}

	const startedAtIso = new Date(now).toISOString();
	await mergeHivemindState(notion, pageId, {
		chainRunning: {
			startedAt: startedAtIso,
			deliveryId,
		},
		lastChainStartedAt: startedAtIso,
	});

	await new Promise((resolve) => setTimeout(resolve, LOCK_VERIFY_DELAY_MS));

	const afterWait = await readHivemindState(notion, pageId);
	if (afterWait.chainRunning?.deliveryId !== deliveryId) {
		console.log(
			"[lock] lost race for",
			pageId,
			"winner=",
			afterWait.chainRunning?.deliveryId,
			"— abort",
			deliveryId,
		);
		return false;
	}

	console.log("[lock] acquired", pageId, "delivery=", deliveryId);
	return true;
}

export async function releaseChainLock(args: {
	notion: Client;
	pageId: string;
}): Promise<void> {
	await mergeHivemindState(args.notion, args.pageId, {
		chainRunning: undefined,
	});
}
