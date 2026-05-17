import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { getConfig } from "./config.js";

export interface AuditEntry {
	ts: string;
	kind: "tool_call" | "llm_message" | "system" | "error" | "stale_release";
	data: unknown;
}

export async function appendAudit(
	briefId: string,
	kind: AuditEntry["kind"],
	data: unknown,
): Promise<void> {
	const config = getConfig();
	await mkdir(config.AUDIT_DIR, { recursive: true });
	const entry: AuditEntry = { ts: new Date().toISOString(), kind, data };
	await appendFile(path.join(config.AUDIT_DIR, `${briefId}.jsonl`), `${JSON.stringify(entry)}\n`, "utf8");
}
