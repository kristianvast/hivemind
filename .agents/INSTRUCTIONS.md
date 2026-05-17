# Repository Guidelines

## Project Structure & Module Organization
- `src/index.ts` defines the worker and capabilities.
- `anvil/` is the local-executor daemon — runs on the user's Mac, drives a Linux VM + Playwright browser + GitHub remote for `Owner=Forge-Local` briefs. Has its own `package.json` / `tsconfig.json` / `dist/`. The Worker (root) and Anvil (`anvil/`) share no code; they communicate over Pusher Channels. See [`anvil/README.md`](anvil/README.md).
- `.examples/` has focused samples (sync, tool, automation, OAuth, webhook).
- Shared agent skills live in `.agents/skills/`. `.claude/skills` is kept as a compatibility symlink for Claude-specific discovery.
- Generated: `dist/` build output, `workers.json` CLI config.
- `opencode.json` wires up project-level MCP servers and other opencode settings.
- Historical plans live under `.sisyphus/plans/` (active) and `.sisyphus/archive/` (superseded).

## Hivemind v1 Architecture (project-specific)

This worker is the Hivemind multi-agent orchestrator. Briefs (Notion DB rows) trigger a chain of Claude tool-use agents that populate a per-brief Notion project subtree.

- **Status state machine** lives in `src/chain.ts`. Webhook in `src/index.ts` routes by Status.
- **Project subtree** provisioned in `src/provision.ts`. Layout per brief:
  - `📁 {briefTitle}` (root page)
  - `Plan` (page — Context / Approach / Decisions / Sources / Open Questions / Status)
  - `Drafts` (the only database — iteration history; reviews are appended inline on each draft page)
  - `Activity` (page — chronological agent run log)
- **Agent execution** is in `src/agentLoop.ts` (hand-rolled Anthropic tool-use loop, step budget = tool calls).
- **Tools** live in `src/tools/`: `registry.ts` (schemas), `handlers.ts` (dispatch + scope guard). `createSource` / `createDecision` / `createOpenQuestion` append blocks to the matching Plan section; `createReview` appends a Review section to the draft page it reviews.
- **Scope rule**: agent writes MUST be inside the project subtree (`src/scope.ts` enforces).
- **Notion API**: always use `data_source_id` for relations, page creates under DBs, and queries (not `database_id`). SDK default version is 2025-09-03.

See `.sisyphus/plans/hivemind-omo-orchestrator.md` for the full v1 plan.

## Hivemind v2 — Anvil (local executor)

Anvil extends Hivemind with a **local daemon** that runs on the user's Mac. It gives the orchestrator full-tool capabilities (real shell, filesystem, Playwright browser, GitHub remote) without breaking the Worker's sandbox.

- **Trigger**: admin sets `Owner = Forge-Local`, `Status = Triaged | Provisioned` on a brief.
- **Routing** (`src/index.ts` → `pusherPublish`): the existing `onBriefStatusChange` webhook publishes `{ briefId }` to Pusher channel `anvil-dispatch` (event `brief.dispatched`) when those conditions hit.
- **Receive** (`anvil/src/pusher-subscriber.ts`): Anvil holds an outbound WebSocket to Pusher on the user's machine. No inbound network on the host.
- **Dispatch** (`anvil/src/main.ts → dispatchBrief`): claim brief via `Owner=Forge-Local-Busy` → spawn VM via `anvil/src/vm-runtime.ts` (Lima default, E2B opt-in) → prepare repo (scaffold new or clone existing via `anvil/src/github.ts`) → start dev server in VM on port 3000 → spawn host-side Playwright MCP → run **Forge-Local** agent loop.
- **Forge-Local** (`anvil/src/forge-local.ts`, `tools.ts`): Claude tool-use loop with Anthropic native `bash_20250124` + `text_editor_20250728` plus custom `playwright_*` + `git_commit_push` + `report_proof` (terminal). 40-step budget. All bash + file ops run inside the VM, NOT on the host.
- **Proof** (`anvil/src/proof.ts`): host-side screenshot via Playwright MCP → uploaded to Notion via `notion.fileUploads` → appended as Proof block group to the brief's project subtree → `Status=Done`, `Owner=Forge-Local`, `Repo` + `PR URL` set.
- **Recovery** (`anvil/src/brief.ts → findStaleBusyBriefs`): on daemon start, briefs stuck `Owner=Forge-Local-Busy` for > 30 min revert to `Triaged`.
- **Crucial**: the Worker's sandbox constraints (no shell, no subprocess, no npm at runtime) apply **only to `src/`**. Anvil intentionally has all of those — running on the user's machine is the entire point. Anvil's safety boundary is the VM, not the runtime.

See [`anvil/README.md`](anvil/README.md) for install, CLI, verification runbook, and the `lima` vs `e2b` driver choice (`SANDBOX_DRIVER` env var, default `lima`).

Locked plan: `.sisyphus/plans/local-executor.md`.

## Worker Capabilities

Capabilities currently registered in `src/index.ts`:

- `notionWhoAmI` (tool) - smoke test: returns the bot user identity
- `pingClaude` (tool) - smoke test: sends a prompt to Claude and returns the response
- `classifyBrief` (tool) - admin: classify a brief title+body via Haiku, returns Category
- `provisionProject` (tool) - admin: idempotently provision the project subtree for a brief
- `debugState` (tool) - admin: read and pretty-print the Hivemind State JSON for a brief
- `onBriefStatusChange` (webhook) - chain trigger: fires when a brief's Status property changes. Routes by Status (`Triaged` → in-Worker agent chain; `Done` → `handleBriefApproved`) **and** by Owner: when `Owner=Forge-Local` and Status is in `{Triaged, Provisioned}`, publishes `{ briefId }` to Pusher channel `anvil-dispatch` so the local Anvil daemon can pick it up. Pusher publish is best-effort: if `PUSHER_APP_ID/KEY/SECRET/CLUSTER` aren't configured the publish is logged and skipped, the webhook still 200s.

### Rate-limit hygiene for `onBriefStatusChange`

The webhook is a **per-capability rate-limited** resource on the Workers platform. A burst of deliveries can blow the budget and lock the capability out for ~30 minutes (visible as runs with empty logs + exit code 1 + ~50 ms duration). Three things keep volume sane — change one without the others and the budget will get tight again:

1. **Worker filters bot-authored edits.** `onBriefStatusChange` checks `page.last_edited_by.id` against `HIVEMIND_BOT_USER_ID` (env var) and short-circuits when they match. This is essential because the chain itself writes `Status=In Progress` once per agent (3-4 writes per chain) — without the filter, each write loops back through the webhook. Keep `HIVEMIND_BOT_USER_ID` set in `.env` (and pushed via `ntn workers env push`) or the filter degrades to a no-op.
2. **Worker coalesces rapid retriggers.** `acquireChainLock` skips deliveries that arrive within `CHAIN_COALESCE_MS` (10 s) of the previous chain start. This absorbs Notion automation retry storms without affecting legitimate human-paced retries (Triaged → Needs Review → Triaged), which always happen on a > 10 s timescale.
3. **Notion automation must filter on the right transitions.** In the Briefs database, edit the automation that fires this webhook and set its trigger condition to `Status` is `Triaged` OR `Status` is `Done` (and `Owner` is `Forge-Local` for the Anvil dispatch path). The default "any property change" trigger fires on every column edit and is the single biggest source of wasted deliveries. There is no code-side fallback for this — the Worker has to receive the delivery before it can early-return, and the early-return still costs a rate-limit slot.

If a brief is stuck in Triaged and the chain is not advancing, check `ntn workers runs list --plain | head -n 20` for a wall of exit-1 / empty-log runs. That is the rate-limit signature. Either wait for the window to drain (run `ntn workers exec debugState -d '{"briefId":"…"}'` and read the `Retry after N seconds` in the 429), or redeploy with `ntn workers deploy` to reset the window.

## Documentation Lookup (Notion Docs MCP)

The `notion-docs` MCP server is wired up in `opencode.json` and points at `https://developers.notion.com/mcp` (no auth required). Use it whenever you need authoritative answers about the **public Notion API** that backs `context.notion` / `@notionhq/client` — endpoints, request/response shapes, property types, OAuth scopes, rate limits, webhook delivery, etc.

Two tools are exposed:

- `notion-docs_search_notion_docs` — semantic search over the docs. Best first step for conceptual or fuzzy questions ("how do I paginate query results?", "what scopes does the public OAuth flow need?"). Returns titles and page paths.
- `notion-docs_query_docs_filesystem_notion_docs` — read-only shell against an in-memory virtual filesystem containing all docs pages (`.mdx`) and the OpenAPI spec. Supports `rg`, `grep`, `find`, `tree`, `ls`, `cat`, `head`, `tail`, `stat`, `wc`, `sort`, `uniq`, `cut`, `sed`, `awk`, `jq`. Each call is stateless — pass absolute paths or chain with `&&`. Output is truncated to 30KB per call.

**Typical flow:**

1. Broad question → `search_notion_docs` to find the right page path.
2. Read the page → `query_docs_filesystem` with `head -200 /api-reference/post-database-query.mdx` (or `cat` for short pages).
3. Need exact keyword matches across the docs → `rg -il "rate limit" /` then `rg -C 3 "pattern" /path/file.mdx`.
4. Inspect the API surface → `cat /openapi/spec.json | jq '.paths | keys'`.

**Scope reminder:** this MCP covers the **public Notion API**. For Workers-specific concerns — `Worker`, `Schema`, `Builder`, sync runtime, `ntn` CLI, capability shapes — this file and `.examples/` remain the source of truth.

## Worker & Capability API (SDK)
- `@notionhq/workers` provides `Worker`, schema helpers, and builders; the `ntn` CLI powers worker management.
- Capability keys are unique strings used by the CLI (e.g., `ntn workers exec tasksSync`).

```ts
import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

worker.sync("tasksSync", {
	primaryKeyProperty: "ID",
	schema: { defaultName: "Tasks", properties: { Name: Schema.title(), ID: Schema.richText() } },
	execute: async (_state, { notion }) => ({
		changes: [{ type: "upsert", key: "1", properties: { Name: Builder.title("Write docs"), ID: Builder.richText("1") } }],
		hasMore: false,
	}),
});

worker.tool("sayHello", {
	title: "Say Hello",
	description: "Return a greeting",
	schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
	execute: ({ name }, { notion }) => `Hello, ${name}`,
});

worker.automation("sendWelcomeEmail", {
	title: "Send Welcome Email",
	description: "Runs from a database automation",
	execute: async (event, { notion }) => {},
});

worker.oauth("googleAuth", { name: "my-google-auth", provider: "google" });

worker.webhook("onGithubPush", {
	title: "GitHub Push Webhook",
	description: "Handles push events from GitHub",
	execute: async (events, { notion }) => {
		for (const event of events) {
			console.log("Push:", event.body);
		}
	},
});
```

### Notion API access (`context.notion`)

All `execute` handlers receive a `context.notion` object (a `@notionhq/client` SDK instance). You can use this to make API requests to Notion.

However, `context.notion` is only **pre-authenticated** when it's a tool capability invoked by a Custom Agent. In that case, the platform sets `NOTION_API_TOKEN` automatically, using the permissions of the Custom Agent — no setup required.

For all other capabilities (syncs, automations, webhooks), `context.notion` is **not** pre-authenticated. The user must set the `NOTION_API_TOKEN` environment variable themselves by:
1. Creating an internal integration at https://www.notion.so/profile/integrations/internal
2. Giving that integration access to the relevant pages and databases in Notion
3. Adding the token to `.env` locally, or pushing it with `ntn workers env push` for deployed workers

Before writing code that uses `context.notion` in a non-tool capability, check whether `NOTION_API_TOKEN` is configured: look for it in `.env` (e.g. `grep -q '^NOTION_API_TOKEN=' .env`). If it is not set, prompt the user to create an internal integration at https://www.notion.so/profile/integrations/internal and add the token to `.env`.

- For user-managed OAuth, supply `name`, `authorizationEndpoint`, `tokenEndpoint`, `clientId`, `clientSecret`, and `scope` (optional: `authorizationParams`, `callbackUrl`, `accessTokenExpireMs`).
- After deploying a worker with an OAuth capability, the user must configure their OAuth provider's redirect URL to match the one assigned by Notion. Run `ntn workers oauth show-redirect-url` to get the redirect URL, then set it in the provider's OAuth app settings. **Always remind the user of this step after deploying any OAuth capability.**
- **OAuth setup order:** Deploy → `ntn workers env push` → set redirect URL → `ntn workers oauth start`. Secrets must be pushed before starting the OAuth flow because the deployed worker needs the client secret to exchange the authorization code for tokens.

### Sync
#### Strategy and Pagination

Syncs run in a "sync cycle": a back-to-back chain of `execute` calls that starts at a scheduled trigger and ends when an execution returns `hasMore: false`. By default, syncs run every 30 minutes. Set `schedule` to an interval like `"15m"`, `"1h"`, `"1d"` (min `"1m"`, max `"7d"`), or `"continuous"` to run as fast as possible.

- Always use pagination, when available. Returning too many changes in one execution will fail. Start with batch sizes of ~100 changes.
- `mode=replace` is simpler — use it when the API has no change tracking (no `updated_at` filter, no event feed)
- Use `mode=incremental` when the API supports change tracking (e.g. `updated_since`, event streams), which enterprise APIs like Salesforce, Stripe, and Linear typically do
- When using `mode=incremental`, emit delete markers as needed if easy to do (below)

**Sync strategy (`mode`):**
- `replace`: each sync cycle must return the full dataset. After the final `hasMore: false`, any records not seen during that cycle are deleted.
- `incremental`: each sync cycle returns a subset of the full dataset (usually the changes since the last run). Deletions must be explicit via `{ type: "delete", key: "..." }`. Records not mentioned are left unchanged.

**How pagination works:**
1. Return a batch of changes with `hasMore: true` and a `nextState` value
2. The runtime calls `execute` again with that state
3. Continue until you return `hasMore: false`

**Example replace sync:**

```ts
worker.sync("paginatedSync", {
	mode: "replace",
	primaryKeyProperty: "ID",
	schema: { defaultName: "Records", properties: { Name: Schema.title(), ID: Schema.richText() } },
	execute: async (state, { notion }) => {
		const page = state?.page ?? 1;
		const pageSize = 100;
		const { items, hasMore } = await fetchPage(page, pageSize);
		return {
			changes: items.map((item) => ({
				type: "upsert",
				key: item.id,
				properties: { Name: Builder.title(item.name), ID: Builder.richText(item.id) },
			})),
			hasMore,
			nextState: hasMore ? { page: page + 1 } : undefined,
		};
	},
});
```

**State types:** The `nextState` can be any serializable value—a cursor string, page number, timestamp, or complex object. Type your execute function's `state` to match.

**Incremental example (changes only, with deletes):**
```ts
worker.sync("incrementalSync", {
	primaryKeyProperty: "ID",
	mode: "incremental",
	schema: { defaultName: "Records", properties: { Name: Schema.title(), ID: Schema.richText() } },
	execute: async (state, { notion }) => {
		const { upserts, deletes, nextCursor } = await fetchChanges(state?.cursor);
		return {
			changes: [
				...upserts.map((item) => ({
					type: "upsert",
					key: item.id,
					properties: { Name: Builder.title(item.name), ID: Builder.richText(item.id) },
				})),
				...deletes.map((id) => ({ type: "delete", key: id })),
			],
			hasMore: Boolean(nextCursor),
			nextState: nextCursor ? { cursor: nextCursor } : undefined,
		};
	},
});
```

#### Relations

Two syncs can relate to one another using `Schema.relation(relatedSyncKey)` and `Builder.relation(primaryKey)` entries inside an array.

```ts
worker.sync("projectsSync", {
	primaryKeyProperty: "Project ID",
	...
});

// Example sync worker that syncs sample tasks to a database
worker.sync("tasksSync", {
	primaryKeyProperty: "Task ID",
	...
	schema: {
		...
		properties: {
			...
			Project: Schema.relation("projectsSync", {
				// Optionally configure a two-way relation. This will automatically create the
				// "Tasks" property on the project synced database: there is no need
				// to configure "Tasks" on the projectSync capability.
				twoWay: true, relatedPropertyName: "Tasks"
			}),
		},
	},

	execute: async () => {
		// Return sample tasks as database entries
		const tasks = fetchTasks()
		const changes = tasks.map((task) => ({
			type: "upsert" as const,
			key: task.id,
			properties: {
				...
				Project: [Builder.relation(task.projectId)],
			},
		}));

		return {
			changes,
			hasMore: false,
		};
	},
});
```

### Webhooks

Webhooks expose HTTP endpoints that external services can call. After deploying, the CLI prints the webhook URL. Use `ntn workers webhooks list` to see URLs at any time.

The execute handler receives an array of `WebhookEvent` objects. Each event contains `deliveryId` (stable idempotency key across retries), `body` (parsed JSON), `rawBody` (string, for signature verification), `headers`, and `method`.

```ts
worker.webhook("onExternalEvent", {
	title: "External Event Handler",
	description: "Processes incoming webhook requests",
	execute: async (events, { notion }) => {
		for (const event of events) {
			console.log("Method:", event.method);
			console.log("Body:", JSON.stringify(event.body));
			// Use event.headers to access request headers
		}
	},
});
```

**Security:** Each webhook gets a unique ID in the URL path that acts as a shared secret. The URL format is:
```
https://www.notion.so/webhooks/worker/{spaceId}/{workerId}/{uniqueWebhookId}/{webhookName}
```

This full URL can be retrieved using the `notion workers webhooks ls` command.

It is also the responsibility of the worker to verify the webhook. Throw WebhookVerificationError if the payload is not valid. 5 invalid payloads in a row will cause webhooks to short circuit until redeployed.

### Sync Management (CLI)

**Monitor sync status:**
```shell
ntn workers sync status              # live-updating watch mode (polls every 5s)
ntn workers sync status <key>        # filter to a specific sync capability
ntn workers sync status --no-watch   # print once and exit
ntn workers sync status --interval 10 # custom poll interval in seconds
```

Status labels:
- **HEALTHY** — last run succeeded
- **INITIALIZING** — deployed but hasn't succeeded yet
- **WARNING** — 1–2 consecutive failures
- **ERROR** — 3+ consecutive failures
- **DISABLED** — capability is disabled

**Preview a sync (inspect output without writing):**
```shell
ntn workers sync trigger <key> --preview                   # run execute, show objects, don't write to the database
ntn workers sync trigger <key> --preview --context '{"page":2}'  # resume from a previous preview's nextContext
```
Preview calls your sync's `execute` function and shows the objects it would produce, but **does not write anything to the Notion database**. Use it to verify your sync logic and inspect the data before committing to a real run. When piped, outputs raw JSON.

**Trigger a sync (write immediately, bypass schedule):**
```shell
ntn workers sync trigger <key>
```
Trigger starts a **real** sync cycle that writes to the database, bypassing the normal schedule. Use it to push changes immediately rather than waiting for the next scheduled run.

**Reset sync state (restart from scratch):**
```shell
ntn workers sync state reset <key>
```
Clears the cursor and stats so the next run starts from the beginning.

**Enable / disable a sync:**
```shell
ntn workers capabilities list            # show all capabilities
ntn workers capabilities disable <key>   # pause a sync
ntn workers capabilities enable <key>    # resume a sync
```

> **Note:** `ntn workers deploy` does **not** reset sync state. Syncs resume from their last cursor position after a deploy. Use `ntn workers sync state reset <key>` to explicitly restart from scratch.

### Querying a database

Use `ntn datasources query <data-source-id>` to list pages in a database. **The argument is a data source ID, not a database ID** — a database in Notion is a container for one or more data sources, and the public API queries data sources directly.

If you only have a database ID, run `ntn datasources resolve <database-id>` first to list the data sources it contains:

```shell
ntn datasources resolve <database-id>
```

If exactly one data source is returned, retry the query with that ID. If multiple are returned, pick the one whose name matches what you want.

When `ntn datasources query <id>` returns 404 or "Could not find data source", the ID is most likely a database ID — run `resolve` against it and retry with one of the data source IDs it lists.

## Build, Test, and Development Commands
- Node >= 22 and npm >= 10.9.2 (see `package.json` engines).
- `npm run build`: compile TypeScript to `dist/`.
- `npm run check`: type-check only (no emit).
- `ntn login`: connect to a Notion workspace.
- `ntn workers deploy`: build and publish capabilities. Does not reset sync state.
- `ntn workers exec <capability>`: run a sync or tool.
- `ntn workers sync status`: monitor sync health (live-updating).
- `ntn workers sync trigger <key> --preview`: preview sync output without writing to the database.
- `ntn workers sync trigger <key>`: trigger a real sync immediately (writes to the database).

## Debugging & Monitoring Runs
Use `ntn workers runs` to inspect run history and logs.

**List recent runs:**
```shell
ntn workers runs list
```

**Get logs for a specific run:**
```shell
ntn workers runs logs <runId>
```

**Get logs for the latest run (any capability):**
```shell
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

**Get logs for the latest run of a specific capability:**
```shell
ntn workers runs list --plain | grep tasksSync | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

The `--plain` flag outputs tab-separated values without formatting, making it easy to pipe to other commands.

### Debugging Syncs

**Check sync health:**
```shell
ntn workers sync status
```
Look at failure counts, error messages, and last succeeded times.

**Sync not running?** Check if the capability is disabled:
```shell
ntn workers capabilities list
```

**Preview what a sync would produce (without writing):**
```shell
ntn workers sync trigger <key> --preview
```

**Retry a failed sync (writes to the database):**
```shell
ntn workers sync trigger <key>
```

**Sync in a bad state?** Reset the cursor and restart:
```shell
ntn workers sync state reset <key>
```

## Coding Style & Naming Conventions
- TypeScript with `strict` enabled; keep types explicit when shaping I/O.
- Use tabs for indentation; capability keys in lowerCamelCase.

## Testing Guidelines
- No test runner configured; validate with `npm run check` and end-to-end testing via `ntn workers exec`.
- Write a test script that exercises each tool capability using `ntn workers exec`. This can be a bash script (`test.sh`) or a TypeScript script (`test.ts`, run via `npx tsx test.ts`). Use the `--local` flag for local execution or omit it to run against the deployed worker.

**Local execution** runs your worker code directly on your machine. Any `.env` file in the project root is automatically loaded, so secrets and config values are available via `process.env`.

**Remote execution** (without `--local`) runs against the deployed worker. Any required secrets must be pushed to the remote environment first using `ntn workers env push`.

**Example bash test script (`test.sh`):**
```shell
#!/usr/bin/env bash
set -euo pipefail

# Run locally (uses .env automatically):
ntn workers exec sayHello --local -d '{"name": "World"}'

# Or run against the deployed worker (requires `ntn workers deploy` and `ntn workers env push` first):
# ntn workers exec sayHello -d '{"name": "World"}'
```

**Example TypeScript test script (`test.ts`, run with `npx tsx test.ts`):**
```ts
import { execSync } from "child_process";

function exec(capability: string, input: Record<string, unknown>) {
	const result = execSync(
		`ntn workers exec ${capability} --local -d '${JSON.stringify(input)}'`,
		{ encoding: "utf-8" },
	);
	console.log(result);
}

exec("sayHello", { name: "World" });
```

Use this pattern to build up a suite of exec calls that covers each tool with representative inputs.

## Commit & Pull Request Guidelines
- Messages typically use `feat(scope): ...`, `TASK-123: ...`, or version bumps.
- PRs should describe changes, list commands run, and update examples if behavior changes.
