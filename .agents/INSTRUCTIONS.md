# Repository Guidelines

This is the Hivemind multi-agent orchestrator: a Notion Worker that turns brief rows into populated project subtrees. The agent surface is the public Notion API plus a Notion-Workers SDK runtime. **The current architecture is v2 (orchestrator-first); the v1 fixed-chain code is gone.**

## Project Structure

```
src/
  index.ts          Worker + capabilities + webhook router
  orchestrator.ts   v2 orchestrator — locks, provisions, runs Architect, runs Sentinel
  architect.ts      Architect system prompt + spec
  subagents.ts      Scout / Librarian / Oracle / Sentinel specs
  agents.ts         invokeAgent — uniform wrapper around runAgent for any spec
  agentLoop.ts      Hand-rolled Anthropic tool-use loop (step budget = tool calls)
  tools/
    registry.ts     Tool schemas (per-agent whitelists)
    handlers.ts     Tool dispatch + scope guard
  provision.ts      Per-brief subtree provisioner (idempotent)
  notion.ts         Block builders, brief context loader, status helpers
  state.ts          HivemindState — stored in a collapsed toggle on the brief page
  scope.ts          Write-scope guard (project subtree only)
  pacer.ts          Shared RPS pacer (Notion API)
  budget.ts         Per-brief token budget circuit breaker
  classify.ts       Category classifier (informational only in v2 — does NOT route execution; provision is unified as of Phase 4)
anvil/              Local-executor daemon (separate package, talks to Worker over Pusher). See anvil/README.md.
.examples/          Focused SDK samples (sync, tool, automation, OAuth, webhook). READ THESE for Workers SDK shape questions before asking.
.agents/skills/     Auto-loaded skills: sync-guide, sync, sync-debug, sync-validate, auth-guide. .claude/skills is a compat symlink.
.sisyphus/plans/    Active plans. hivemind-v2-orchestrator.md is the current architecture plan (read it before designing changes).
.sisyphus/archive/  Superseded plans (v1).
scripts/            Admin scripts run via `npx tsx scripts/<name>.ts` — seedBriefs, inspectBrief, migrateBriefs, configureBriefsUI, etc.
opencode.json       Project-level MCP servers and opencode settings.
```

## Hivemind v2 Architecture

A brief (Notion DB row) flips to `Status=Triaged` → the `onBriefStatusChange` webhook runs a single **Architect** agent end-to-end. The Architect plans, writes the deliverable, and **delegates** to sub-agents when it saves tokens or needs specialist capability.

**Status state machine (current):** `Backlog → Triaged → In Progress → Needs Review → Done | Failed`. The Architect drives Status. Sentinel sets the verdict that decides `Needs Review` (approve) vs leaves `In Progress` (needs-revision).

**Anvil — local execution sub-agent (✅ wired, in-process).** Anvil is the only Hivemind sub-agent that touches the local filesystem, spins up a localhost HTTP server, and drives a real headless Chromium via Playwright. It runs **only in `--local` orchestrator mode** (e.g. `ntn workers exec runOrchestrator --local`). The Architect calls `delegateAnvil({ task, context })` when a brief is about BUILDING and DEMONSTRATING something visual (website, landing page, UI mockup). Anvil writes its own proof (image block + URL callout) into the project root via dedicated tools (`anvilWriteFile`, `anvilServe`, `anvilScreenshot`, `anvilEmbedImage`, `anvilSay`) and returns a summary to the Architect.

Anvil sessions are per-brief, owned by `src/anvil.ts`. Each session has a temp directory under `os.tmpdir()/hivemind-anvil-<briefId>-<ts>/` plus an `http.Server` bound to 127.0.0.1 on an auto-allocated port. **The HTTP server is intentionally NOT `unref()`d** — it keeps the Node event loop alive past `runOrchestrator`'s return so the human can visit the URL. `runOrchestrator` prints an `⚒️  ANVIL SERVERS STILL RUNNING` banner with the URLs after it finishes; Ctrl+C exits.

The original `anvil/` daemon (Pusher subscriber + E2B/Lima VMs + GitHub PRs) in [`anvil/`](anvil/README.md) is **separate** from this in-process Anvil and remains available for the heavier dispatched-execution use case (driven by `Owner=Forge-Local` + Pusher channel `anvil-dispatch` — wiring stays in `src/index.ts`). The two paths can coexist: in-process Anvil for visual local demos invoked by the Architect, and the daemon for VM-based code execution + PRs.

**Per-brief subtree** (provisioned in `src/provision.ts`, idempotent). **Unified layout (Phase 4)** — every brief, regardless of Category, gets the same shape:

- `📁 root` with a `📄 Answer` heading anchor (writeAnswer drops content here).
- `Plan` page (Context / Approach / Decisions / Sources / Open Questions / Status).
- `Drafts` database (createDraft drops rows here; may stay empty if the Architect chose writeAnswer).
- `Sources` / `Decisions` / `Open Questions` mini-DBs (one row per createSource / createDecision / createOpenQuestion).
- `Activity` page (chronological agent run log).

The Architect picks writeAnswer (inline prose) vs createDraft (iterative artifact) at runtime based on the brief — Category is no longer the routing signal.

**Sub-agents.** Each is spawned by a `delegateX` tool that runs a fresh `runAgent()` with a tight tool whitelist and small step/task budget. The sub-agent's final value is its `done({summary})` payload — its working tokens never enter the Architect's context.

| Sub-agent  | Delegate tool        | Status     | Purpose |
|------------|----------------------|------------|---------|
| Scout      | `delegateScout`      | ✅ wired   | Workspace + web research, captures Sources |
| Librarian  | `delegateLibrarian`  | ✅ wired   | External docs / web reference research |
| Oracle     | `delegateOracle`     | ✅ wired   | Deep analysis (extended thinking, read-only) |
| Sentinel   | (fixed post-step)    | 🟡 partial | Currently invoked as a fixed post-step in `orchestrator.ts`. Phase 3 migrates this to `delegateSentinel`. |
| Anvil      | `delegateAnvil`      | ✅ wired   | **In-process, `--local` mode only.** Local filesystem + localhost HTTP server + Playwright headless Chromium. Architect uses it for build-and-demo briefs (websites, UI mockups). See `src/anvil.ts` and `getAnvilSpec()` in `src/subagents.ts`. The separate `anvil/` daemon is the Pusher-dispatched, VM-backed alternative for code execution + GitHub PRs. |

**Scope rule.** Agent writes MUST be inside the brief's project subtree. Enforced by `src/scope.ts` — violations are caught and reported, not silently dropped.

**State storage.** `HivemindState` (`src/state.ts`) lives in a collapsed `🔒 Hivemind internal state (do not edit)` toggle on the brief page, single JSON code block inside. The legacy `Hivemind State` rich_text property is removed (it dominated the brief detail panel because Notion ignores per-view visibility there). Cleanup: `scripts/configureBriefsUI.ts`.

**The plan is the spec.** `.sisyphus/plans/hivemind-v2-orchestrator.md` is the source of truth for the architecture, phasing (P1 ✅, P2 ✅, P4 ✅, P3 + P5 pending), decisions D1–D14, and the Architect system prompt. **Read it before making non-trivial changes.** v1 plan lives in `.sisyphus/archive/`.

## Notion API gotchas the SDK won't catch

- **Always use `data_source_id`, not `database_id`** for relations, page creates under DBs, and queries. A database is a container for one or more data sources; the public API operates on data sources. Default SDK API version is `2025-09-03`.
- `ntn datasources query <id>` returning 404 means you handed it a database ID — run `ntn datasources resolve <database-id>` to list the data sources inside it, then retry with one of those.
- `context.notion` is **only** pre-authenticated for tool capabilities invoked by a Custom Agent. For syncs, automations, webhooks, and `ntn workers exec --local`, set `NOTION_API_TOKEN` yourself: create an internal integration at <https://www.notion.so/profile/integrations/internal>, give it page access, add to `.env`, `ntn workers env push` for deployed.

## Worker Capabilities (currently registered in `src/index.ts`)

| Capability               | Kind     | Purpose |
|--------------------------|----------|---------|
| `notionWhoAmI`           | tool     | Smoke test: Notion API reachability |
| `pingClaude`             | tool     | Smoke test: Anthropic API reachability |
| `classifyBrief`          | tool     | Admin: classify title+body via Haiku. **Informational in v2** — does not route execution; provision shape still consumes it until Phase 4. |
| `provisionProject`       | tool     | Admin: idempotently provision the subtree for a brief |
| `debugState`             | tool     | Admin: pretty-print HivemindState JSON |
| `runOrchestrator`        | tool     | Admin: invoke v2 orchestrator directly on a brief — bypasses webhook auth / chain lock / dedup. Use for `ntn workers exec runOrchestrator --local`. |
| `runRescueSweep`         | tool     | Admin: manually invoke the `triagedRescue` sweep. Returns counts (scanned/acquired/processed/skipped/errors). Same code path as the scheduled sync, useful for testing without waiting 2 min. |
| `onBriefStatusChange`    | webhook  | Chain trigger. Verifies `X-Hivemind-Secret`, runs the storm gate, filters trash + bot edits, then routes by Status read directly from page properties. `Status=Triaged` → acquire chain lock → orchestrator; `Status=Done` → `handleBriefApproved`; `Owner=Forge-Local` + Status in `{Triaged, Provisioned}` → Pusher publish (best-effort). Non-trigger deliveries early-exit after a single `pages.retrieve` call (no state read, no body read). |
| `triagedRescue`          | sync     | Scheduled every 2 min. Queries the Briefs DS for `Status=Triaged`, acquires the same chain lock as the webhook, and runs the orchestrator on whatever the webhook missed. Backstop against webhook rate-limit lockouts. Writes nothing to its managed `Hivemind System` DB (the DB is a sync-API requirement, not a state store). |

### Rate-limit defenses for `onBriefStatusChange` (READ THIS)

The webhook is **per-capability rate-limited** by the Notion Workers platform. A burst can blow the budget and lock the capability out for ~30 min — visible as runs with empty logs + exit code 1 + ~50 ms duration. The defenses below are layered so any single misconfiguration cannot strand briefs at Triaged:

1. **In-memory storm gate (`src/index.ts`)** — per-page sliding window. If a single page produces > 12 deliveries inside 10 seconds, suppress further deliveries to that page for 90 s with ZERO Notion API calls. Protects the platform delivery budget for other pages. Best-effort records `state.storm` once on trip for observability.
2. **Chain lock + coalesce (`src/lock.ts`)** — shared between webhook and rescue sync. `CHAIN_LOCK_TTL_MS` (15 min) prevents concurrent orchestrator runs on the same brief; `CHAIN_COALESCE_MS` (10 s) absorbs Notion automation retry storms while leaving human-paced retries unaffected.
3. **Bot-edit filter** — checks `page.last_edited_by.id` against `HIVEMIND_BOT_USER_ID`. Without this, every Status write the Architect/sub-agents make would loop back through the webhook. Keep `HIVEMIND_BOT_USER_ID` in `.env` and pushed via `ntn workers env push`.
4. **Fast-path early-exit** — non-Triaged/non-Done deliveries no longer read state or the page body. The Status check is done directly from `page.properties` (already in the `pages.retrieve` response). Reduces per-delivery Notion API calls from 6–9 to 1.
5. **Rescue sync backstop (`src/rescue.ts`, `worker.sync("triagedRescue")`)** — runs every 2 minutes on its own per-capability budget. Catches any `Status=Triaged` brief the webhook missed. **This is the layer that makes "Triaged stays stuck forever" mathematically impossible.** Even if the webhook is completely locked out, the sync runs and processes the backlog.
6. **Notion automation trigger scoping** — in the Briefs DB, the automation that fires this webhook MUST be scoped to `Status is Triaged` OR `Status is Done` (+ `Owner is Forge-Local` for the Anvil path). The default "any property change" trigger is the single biggest source of wasted deliveries. Use `npx tsx scripts/automationCanary.ts <briefId>` to detect over-firing.

#### Validating the setup

```
set -a; source .env; set +a
npx tsx scripts/validateBriefsDb.ts         # checks DB schema + env vars
npx tsx scripts/automationCanary.ts <briefId>   # edits a non-Status prop, verifies webhook does NOT fire
```

Create the canary brief as a regular brief at `Status=Backlog` with a `Canary Nonce` rich_text property (add via the Notion UI). Set `HIVEMIND_AUTOMATION_CANARY_BRIEF_ID=<page-id>` in `.env` to default the script argument.

#### Symptom → action runbook

| Symptom | Action |
|---|---|
| Brief moved to Triaged sits there for > 2 min | Wait one more minute; the rescue sync runs every 2 min. If still stuck after 5 min, check `ntn workers runs list --plain \| head -n 20` for the rate-limit signature. |
| Wall of exit-1 + empty-log + ~50 ms webhook runs | Webhook is rate-limited. `ntn workers deploy` resets it. Rescue sync will catch up briefs in the meantime. |
| `[storm] tripped for <pageId>` in webhook logs | Notion automation is firing too broadly on `<pageId>`. Run `npx tsx scripts/automationCanary.ts <pageId>` to confirm; fix the automation trigger to scope on `Status is Triaged`. |
| Brief stuck `In Progress` with `Owner=Architect` and no recent activity | Orchestrator crashed mid-run. `ntn workers exec runOrchestrator --local -d '{"briefId":"<id>"}'` re-runs it; the chain lock auto-clears. |
| Brief stuck `Triaged`, state shows `budgetCircuitTripped: true` | Previous run hit the 400k token safety net. The orchestrator now sets `Status=Failed` automatically; expand the `🔒 Hivemind internal state` toggle on the brief and clear the JSON, then flip Status back to Triaged. |

## Documentation Lookup (notion-docs MCP)

`opencode.json` wires the `notion-docs` MCP at `https://developers.notion.com/mcp` (no auth). Covers the **public Notion API** — endpoints, property types, OAuth scopes, rate limits, webhook delivery.

- `notion-docs_search_notion_docs` — semantic search → page paths. Start here for fuzzy/conceptual questions.
- `notion-docs_query_docs_filesystem_notion_docs` — stateless shell: `rg`, `grep`, `head`, `cat`, `jq`, etc. against `.mdx` pages + `/openapi/spec.json`. Chain commands with `&&`; output capped at 30 KB. Inspect API surface with `cat /openapi/spec.json | jq '.paths | keys'`.

**Scope:** this MCP is **public Notion API only**. For Workers SDK (`Worker`, `Schema`, `Builder`, sync runtime, `ntn` CLI, capability shapes) read `.examples/` and `src/`.

## Workers SDK

Don't inline boilerplate here — `.examples/` has working samples for every capability kind (sync, tool, automation, OAuth, webhook). Read `.examples/<kind>-example.ts` before writing a new capability. The `sync-guide` skill auto-loads for sync work and covers patterns, pagination, deletion strategies, and common pitfalls in depth. The `auth-guide` skill covers third-party OAuth / API-key setup.

**Project-specific SDK reminders the examples won't tell you:**

- OAuth setup order is **deploy → `ntn workers env push` → set redirect URL → `ntn workers oauth start`**. Secrets must be pushed before the OAuth flow because the deployed Worker needs the client secret to exchange the code. Run `ntn workers oauth show-redirect-url` after deploy to get the URL to configure on the provider.
- `ntn workers deploy` does **not** reset sync state. Use `ntn workers sync state reset <key>` to start a sync from scratch.

## Build / Test / Deploy

```
npm run check               # tsc --noEmit (run after every change)
npm run build               # tsc → dist/
ntn login                   # connect to a Notion workspace (once)
ntn workers deploy          # build + publish capabilities
ntn workers env push        # push .env to the deployed worker
ntn workers exec <key>      # invoke a capability (--local runs on your machine with .env)
```

**Run logs** (the single most useful debugging command):

```
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

**Testing.** No test runner is configured. Validate with `npm run check` + `ntn workers exec` (or `runOrchestrator --local` for end-to-end on a real brief). Write a `test.sh` or `test.ts` (`npx tsx test.ts`) that exercises each tool capability with representative inputs. `--local` loads `.env` automatically; remote needs `ntn workers env push` first.

## Coding Style

- TypeScript with `strict` enabled. Explicit types at I/O boundaries (`agentLoop` shapes, tool input schemas, Notion responses).
- **Tabs** for indentation. Capability keys in `lowerCamelCase`.
- Commits: `feat(scope): ...`, `TASK-123: ...`, or version bumps. PRs describe changes, list commands run, and update `.examples/` if SDK-visible behavior changes.
