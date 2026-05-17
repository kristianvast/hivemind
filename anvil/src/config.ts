import os from "node:os";
import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

import type { AnvilConfig } from "./types.js";

dotenv.config();

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

const rawConfigSchema = z.object({
	NOTION_API_TOKEN: z.string().min(1),
	ANTHROPIC_API_KEY: z.string().min(1),
	E2B_API_KEY: z.string().min(1),
	PUSHER_KEY: z.string().min(1),
	PUSHER_CLUSTER: z.string().min(1),
	GITHUB_PAT: z.string().min(1),
	HIVEMIND_BRIEFS_DATABASE_ID: z.string().min(1),
	GITHUB_DEFAULT_ORG: z.string().min(1).optional(),
	PUSHER_CHANNEL: z.string().min(1).default("anvil-dispatch"),
	FORGE_LOCAL_MODEL: z.string().min(1).default("claude-sonnet-4-5-20250929"),
	ANVIL_WORKDIR_ROOT: z.string().min(1).default(path.join(os.homedir(), ".anvil")),
	SANDBOX_DRIVER: z.enum(["e2b", "lima"]).default("lima"),
	AUDIT_DIR: z.string().min(1).optional(),
	LOG_LEVEL: logLevelSchema.default("info"),
	MOCK_MODE: z.enum(["true", "false"]).default("false"),
});

function formatIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
		.join("; ");
}

export function loadConfig(): AnvilConfig {
	const parsed = rawConfigSchema.safeParse(process.env);
	if (!parsed.success) {
		throw new Error(`Invalid Anvil environment: ${formatIssues(parsed.error)}`);
	}

	const auditDir = parsed.data.AUDIT_DIR ?? path.join(parsed.data.ANVIL_WORKDIR_ROOT, "audit");

	return {
		...parsed.data,
		GITHUB_DEFAULT_ORG: parsed.data.GITHUB_DEFAULT_ORG ?? null,
		AUDIT_DIR: auditDir,
	};
}

let configSingleton: AnvilConfig | undefined;

export function getConfig(): AnvilConfig {
	configSingleton ??= loadConfig();
	return configSingleton;
}
