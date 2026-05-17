import type { Client } from "@notionhq/client";
import type { BlockObjectRequest } from "@notionhq/client";

import type { Pacer } from "./pacer";

export type StatusHeroState =
	| { kind: "provisioning" }
	| { kind: "running"; agent: "Architect" | "Sentinel"; startedAt: string }
	| {
			kind: "approved";
			durationMs: number;
			tokens: number;
			verdictSummary: string;
	  }
	| {
			kind: "needs-revision";
			durationMs: number;
			tokens: number;
			verdictSummary: string;
	  }
	| { kind: "failed"; stage: string; errorMsg: string };

const TEXT_LIMIT = 1900;

function clip(text: string, limit = TEXT_LIMIT): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - 1)}…`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	return `${(n / 1000).toFixed(1)}k`;
}

function elapsedSince(iso: string): string {
	const ms = Date.now() - Date.parse(iso);
	if (Number.isNaN(ms) || ms < 0) return "just now";
	return formatDuration(ms);
}

interface CalloutShape {
	rich_text: Array<
		| { type: "text"; text: { content: string } }
		| {
				type: "text";
				text: { content: string };
				annotations: { italic?: boolean; bold?: boolean };
		  }
	>;
	icon: { type: "emoji"; emoji: string };
	color: string;
}

function plainRun(text: string): {
	type: "text";
	text: { content: string };
} {
	return { type: "text", text: { content: clip(text) } };
}

function italicRun(text: string): {
	type: "text";
	text: { content: string };
	annotations: { italic: true };
} {
	return {
		type: "text",
		text: { content: clip(text) },
		annotations: { italic: true },
	};
}

export function buildStatusHeroShape(state: StatusHeroState): CalloutShape {
	switch (state.kind) {
		case "provisioning":
			return {
				rich_text: [plainRun("Provisioning workspace…")],
				icon: { type: "emoji", emoji: "🌱" },
				color: "gray_background",
			};
		case "running": {
			const elapsed = elapsedSince(state.startedAt);
			const label =
				state.agent === "Architect"
					? "🧠 Architect working"
					: "🛡️ Sentinel reviewing";
			return {
				rich_text: [plainRun(`${label} — ${elapsed} elapsed`)],
				icon: { type: "emoji", emoji: "🌀" },
				color: "blue_background",
			};
		}
		case "approved":
			return {
				rich_text: [
					plainRun(
						`Approved · 🧠 → 🛡️ · ${formatDuration(state.durationMs)} · ${formatTokens(state.tokens)} tokens\n`,
					),
					italicRun(`"${state.verdictSummary.trim()}"`),
				],
				icon: { type: "emoji", emoji: "✅" },
				color: "green_background",
			};
		case "needs-revision":
			return {
				rich_text: [
					plainRun(
						`Needs revision · 🧠 → 🛡️ · ${formatDuration(state.durationMs)} · ${formatTokens(state.tokens)} tokens\n`,
					),
					italicRun(`"${state.verdictSummary.trim()}"`),
				],
				icon: { type: "emoji", emoji: "🔁" },
				color: "yellow_background",
			};
		case "failed":
			return {
				rich_text: [
					plainRun(`Failed at ${state.stage}\n`),
					italicRun(state.errorMsg),
				],
				icon: { type: "emoji", emoji: "❌" },
				color: "red_background",
			};
	}
}

export function buildStatusHeroBlock(
	state: StatusHeroState,
): BlockObjectRequest {
	const shape = buildStatusHeroShape(state);
	return {
		type: "callout",
		callout: shape as never,
	};
}

export async function updateStatusHero(
	notion: Client,
	pacer: Pacer,
	blockId: string | undefined,
	state: StatusHeroState,
): Promise<void> {
	if (!blockId) return;
	try {
		const shape = buildStatusHeroShape(state);
		await pacer.acquire();
		await notion.blocks.update({
			block_id: blockId,
			callout: shape as never,
		});
	} catch (err) {
		console.warn("[statusHero] update failed:", err);
	}
}
