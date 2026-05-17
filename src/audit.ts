// Workspace-level audit log for cross-subtree writes (Phase 10).
//
// The v3 architecture drops the scope guard's gate (per user decision V2).
// To preserve traceability, every write the agent performs OUTSIDE the
// current brief's subtree is appended as a row to a workspace-level
// 🪵 Audit database. This is observability-only — never blocks.
//
// The Audit DB lives in the workspace home and is provisioned by the
// admin script `scripts/provisionWorkspaceHome.ts`. Its data source ID is
// read from the env var `HIVEMIND_WORKSPACE_AUDIT_DS_ID`. If unset, audit
// writes silently no-op (and a single console.warn is emitted per process).
//
// Schema:
//   Name        title       e.g. "🧠 Architect — appendBlocks"
//   Op          select      appendBlocks | updateBlock | deleteBlock | ...
//   Agent       select      Architect | Scout | Librarian | Oracle | Sentinel
//   Brief URL   url         deep link to the brief that spawned this write
//   Target URL  url         deep link to the page that was written
//   Status      select      ok | error
//   At          date        ISO8601 timestamp
//   Detail      rich_text   human-readable detail (truncated to 1900 chars)

import type { Client } from "@notionhq/client";

import type { Pacer } from "./pacer";

export type AuditStatus = "ok" | "error";

export interface AuditEntry {
	notion: Client;
	pacer: Pacer;
	agent: string;
	op: string;
	briefUrl: string;
	targetPageId: string;
	status: AuditStatus;
	detail?: string;
}

let warnedMissing = false;

function getAuditDsId(): string | undefined {
	return process.env.HIVEMIND_WORKSPACE_AUDIT_DS_ID;
}

function targetUrlFor(pageId: string): string {
	return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

function truncate(text: string, max = 1900): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
	const dsId = getAuditDsId();
	if (!dsId) {
		if (!warnedMissing) {
			console.warn(
				"[audit] HIVEMIND_WORKSPACE_AUDIT_DS_ID not configured; cross-subtree writes won't be audit-logged. Run scripts/provisionWorkspaceHome.ts and push the env vars.",
			);
			warnedMissing = true;
		}
		return;
	}
	try {
		await entry.pacer.acquire();
		await entry.notion.pages.create({
			parent: { type: "data_source_id", data_source_id: dsId },
			properties: {
				Name: {
					title: [
						{
							type: "text",
							text: {
								content: `${entry.agent} — ${entry.op}`,
							},
						},
					],
				},
				Op: { select: { name: entry.op } },
				Agent: { select: { name: entry.agent } },
				"Brief URL": { url: entry.briefUrl },
				"Target URL": { url: targetUrlFor(entry.targetPageId) },
				Status: { select: { name: entry.status } },
				At: { date: { start: new Date().toISOString() } },
				Detail: entry.detail
					? {
							rich_text: [
								{
									type: "text",
									text: { content: truncate(entry.detail) },
								},
							],
						}
					: { rich_text: [] },
			},
		});
	} catch (err) {
		console.warn("[audit] append failed:", err);
	}
}
