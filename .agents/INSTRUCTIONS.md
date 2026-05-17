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

**Anvil branch (planned, not fully implemented).** Anvil is the local-executor daemon in [`anvil/`](anvil/README.md) — a Node daemon on the user's Mac that drives a real Linux VM + Playwright browser + GitHub remote. The dispatch wiring is in place: admin sets `Owner=Forge-Local` + Status in `{Triaged, Provisioned}`, the webhook publishes `{briefId}` to Pusher channel `anvil-dispatch`, Anvil picks it up and executes locally, writes proof + PR back to the subtree, flips Status to `Done`. **The full v2 integration is deferred to Phase 3**, which replaces the `Owner=Forge-Local` indirection with a direct `delegateAnvil` tool the Architect calls. Until Phase 3 lands, treat Anvil as an out-of-band path — the Architect does not invoke it.

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
| Anvil      | (Pusher dispatch)    | 📋 planned | Dispatch wiring exists (`Owner=Forge-Local` → Pusher). Architect-driven `delegateAnvil` is Phase 3 — not in use yet. |

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
| `onBriefStatusChange`    | webhook  | Chain trigger. Verifies `X-Hivemind-Secret`, dedups by `deliveryId`, filters trash + bot edits. Routes: `Status=Triaged` → orchestrator; `Status=Done` → `handleBriefApproved`; `Owner=Forge-Local` + Status in `{Triaged, Provisioned}` → Pusher publish (best-effort). |

### Rate-limit hygiene for `onBriefStatusChange` (READ THIS)

The webhook is **per-capability rate-limited**. A burst can blow the budget and lock the capability out for ~30 min — visible as runs with empty logs + exit code 1 + ~50 ms duration. Three lines of defense; change one without the others and the budget gets tight:

1. **Worker filters bot-authored edits** — checks `page.last_edited_by.id` against `HIVEMIND_BOT_USER_ID`. Without this, every Status write the Architect/sub-agents make would loop back through the webhook. Keep `HIVEMIND_BOT_USER_ID` in `.env` and pushed via `ntn workers env push`.
2. **Worker coalesces rapid retriggers** within `CHAIN_COALESCE_MS` (10 s) in `acquireChainLock`. Absorbs Notion automation retry storms; human-paced retries (Triaged → Needs Review → Triaged) are unaffected (always > 10 s).
3. **Notion automation must filter on the right transitions.** In the Briefs DB, edit the automation that fires this webhook and set its trigger to `Status is Triaged` OR `Status is Done` (+ `Owner is Forge-Local` for the Anvil path). The default "any property change" trigger is the single biggest source of wasted deliveries. No code-side fallback — the Worker must receive the delivery before it can early-return, and the early-return still costs a rate-limit slot.

If a brief is stuck: `ntn workers runs list --plain | head -n 20`. A wall of exit-1 + empty-log + ~50 ms runs is the rate-limit signature. Wait for the window to drain (the 429 says `Retry after N seconds`), or `ntn workers deploy` resets it.

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
