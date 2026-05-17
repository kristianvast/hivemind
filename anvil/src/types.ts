export interface AnvilConfig {
	NOTION_API_TOKEN: string;
	ANTHROPIC_API_KEY: string;
	E2B_API_KEY: string;
	PUSHER_KEY: string;
	PUSHER_CLUSTER: string;
	GITHUB_PAT: string;
	HIVEMIND_BRIEFS_DATABASE_ID: string;
	GITHUB_DEFAULT_ORG: string | null;
	PUSHER_CHANNEL: string;
	FORGE_LOCAL_MODEL: string;
	ANVIL_WORKDIR_ROOT: string;
	SANDBOX_DRIVER: "e2b" | "lima";
	AUDIT_DIR: string;
	LOG_LEVEL: LogLevel;
	MOCK_MODE: "true" | "false";
}

export interface Brief {
	id: string;
	title: string;
	body: string;
	status: string;
	owner: string;
	category: string | null;
	repoUrl: string | null;
	prUrl: string | null;
	projectRootPageId: string | null;
}

export interface Proof {
	screenshotPath: string;
	consoleErrors: string[];
	failedRequests: string[];
	devUrl: string;
	commitSha: string;
	prUrl: string;
}

export interface DispatchTask {
	briefId: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export type { VmHandle } from "./vm-runtime.js";
export type { McpHandle } from "./playwright-mcp.js";
