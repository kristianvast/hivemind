# Hivemind

> A multi-agent operating system that runs inside Notion. Notion is the hive, your agents are the swarm.

Hivemind turns a Notion database row into a populated project subtree. You drop a brief — a title, a body, optionally a category — flip its `Status` to `Triaged`, and an autonomous **Architect** agent plans the work, writes the deliverable, and delegates to specialist sub-agents (Scout, Librarian, Oracle, Sentinel, and Anvil) as needed. Notion is the database, the orchestrator UI, and the deliverable surface — all at once.

## What you get out of the box

- **Brief → subtree pipeline.** Each brief gets an idempotent project subtree: an Answer anchor, a Plan page, a Drafts DB, and Sources / Decisions / Open Questions / Activity mini-DBs. The Architect picks `writeAnswer` (inline prose) or `createDraft` (iterative artifact) at runtime.
- **Single-Architect orchestration.** One model end-to-end. It uses a hand-rolled Anthropic tool-use loop (`src/agentLoop.ts`) with a strict per-agent tool whitelist (`src/tools/registry.ts`) and a write-scope guard (`src/scope.ts`) that prevents stray writes outside the brief's subtree.
- **Specialist sub-agents** spawned via `delegateScout` / `delegateLibrarian` / `delegateOracle` / `delegateAnvil` tools. Each runs in its own context with its own budget; only the final `done({summary})` payload flows back to the Architect — sub-agent working tokens never enter the Architect's context.
- **Anvil — local executor.** When a brief is "build and demonstrate something visual" (landing page, UI mockup), the Architect delegates to Anvil, which writes files into a temp dir, serves them over a localhost HTTP server, drives a headless Chromium via Playwright, and embeds the screenshot back into the Notion page. Anvil runs **only in `--local` orchestrator mode**.
- **Layered rate-limit defenses** for the status-change webhook: in-memory storm gate, chain lock + coalesce window, bot-edit filter, fast-path early-exit on non-trigger deliveries, and a `triagedRescue` sync (every 2 min) as a backstop. Briefs cannot get stuck at `Triaged` even if the webhook is fully locked out.
- **Token budget circuit breaker.** Per-brief token cap (`src/budget.ts`) trips the orchestrator to `Status=Failed` rather than burning unbounded API spend.

## Architecture at a glance

```
Notion (Briefs DB)
   │
   │  Status: Backlog → Triaged → In Progress → Needs Review → Done | Failed
   │
   └─▶ onBriefStatusChange (webhook capability)
          ├─ storm gate (in-memory, per-page)
          ├─ chain lock (shared with rescue sync)
          ├─ bot-edit filter (skip self-edits)
          └─▶ runOrchestrator(briefId)
                 │
                 ├─ provision subtree (idempotent)
                 ├─ Architect ⟳ tool-use loop ─▶ delegateScout / delegateLibrarian / delegateOracle / delegateAnvil
                 └─ Sentinel post-step ─▶ verdict → Needs Review | back to In Progress

triagedRescue sync (every 2 min) ─▶ same chain lock ─▶ same runOrchestrator
                                                       (catches what the webhook missed)
```

State lives in a collapsed `🔒 Hivemind internal state (do not edit)` toggle on each brief page (single JSON code block) — see `src/state.ts`.

## Project layout

```
src/
  index.ts          Worker entrypoint + capabilities + webhook router + storm gate
  orchestrator.ts   v2 orchestrator — locks, provisions, runs Architect, runs Sentinel
  architect.ts      Architect system prompt + agent spec
  subagents.ts      Scout / Librarian / Oracle / Sentinel / Anvil specs
  agents.ts         invokeAgent — uniform wrapper around runAgent for any spec
  agentLoop.ts      Hand-rolled Anthropic tool-use loop
  anvil.ts          In-process Anvil session (temp dir + localhost HTTP + Playwright)
  tools/
    registry.ts     Tool schemas (per-agent whitelists)
    handlers.ts     Tool dispatch + scope guard
  provision.ts      Per-brief subtree provisioner (idempotent)
  notion.ts         Block builders, brief context loader, status helpers
  state.ts          HivemindState — stored in a collapsed toggle on the brief page
  scope.ts          Write-scope guard (project subtree only)
  pacer.ts          Shared RPS pacer (Notion API)
  budget.ts         Per-brief token budget circuit breaker
  rescue.ts         triagedRescue sync — backstop for webhook rate-limit lockouts
  lock.ts           Chain lock (shared between webhook and rescue)
  classify.ts       Category classifier (informational only in v2)
anvil/              Separate VM-backed executor daemon (Pusher + Lima/E2B + GitHub PRs)
.examples/          Working Notion Workers SDK samples (sync, tool, automation, OAuth, webhook)
.agents/            Internal-facing agent contract + skills
scripts/            Admin scripts: seedBriefs, inspectBrief, validateBriefsDb, etc.
```

Internal contract / deep dive: see [`AGENTS.md`](AGENTS.md).

## Quick start

### Prerequisites

- Node ≥ 22, npm ≥ 10.9.2
- A Notion workspace with the Notion Workers CLI installed: `npm install -g @notionhq/workers`
- API keys: Anthropic (Architect + sub-agents), OpenAI (Sentinel), optionally Pusher (Anvil dispatch)

### Set up

1. **Create the Briefs database in Notion.** Run `npx tsx scripts/seedBriefs.ts` after you've connected your integration. It scaffolds the schema (Status, Owner, Category, 📁 Project, etc.) and creates a couple of sample briefs.

2. **Copy and fill the environment template.**

   ```bash
   cp .env.example .env
   # fill in NOTION_API_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY,
   # HIVEMIND_BRIEFS_DATABASE_ID, HIVEMIND_WEBHOOK_SECRET, HIVEMIND_BOT_USER_ID
   ```

   See [`.env.example`](.env.example) for the full list with comments on where to get each value.

3. **Validate the setup.**

   ```bash
   npm run check                              # tsc --noEmit
   npx tsx scripts/validateBriefsDb.ts        # verifies DB schema + env vars
   ```

4. **Run end-to-end locally** against a real brief.

   ```bash
   ntn login                                  # one-time, connects to your workspace
   ntn workers exec runOrchestrator --local -d '{"briefId":"<page-id>"}'
   ```

   `--local` runs the Worker on your machine with `.env` loaded. In-process Anvil only works in `--local` mode — it needs a real filesystem and a real port.

5. **Deploy to Notion's runtime** (so the webhook fires automatically when briefs are triaged in the UI).

   ```bash
   ntn workers deploy
   ntn workers env push                       # push .env to the deployed Worker
   ```

   Then configure the Notion automation on the Briefs DB to POST to the deployed webhook URL when `Status is Triaged` (and again when `Status is Done`, if you use the Anvil dispatch path). Add header `X-Hivemind-Secret: <your HIVEMIND_WEBHOOK_SECRET>`. Test it didn't over-fire with `npx tsx scripts/automationCanary.ts <briefId>`.

### Run logs (the single most useful debugging command)

```bash
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

## Status

| Phase | Status |
|---|---|
| P1 — single-Architect orchestrator + idempotent provisioning | ✅ shipped |
| P2 — sub-agent delegation (Scout / Librarian / Oracle / Anvil) | ✅ shipped |
| P3 — Sentinel as a delegated sub-agent (currently a fixed post-step) | 🟡 pending |
| P4 — unified provisioning shape (was Category-branched) | ✅ shipped |
| P5 — multi-turn refinement loop | 🟡 pending |

The active architecture plan with decisions D1–D14 lives at [`.sisyphus/plans/hivemind-v2-orchestrator.md`](.sisyphus/plans/hivemind-v2-orchestrator.md). A newer v3 direction (Notion power-user Architect) is being explored in [`.sisyphus/plans/hivemind-v3-notion-power-user.md`](.sisyphus/plans/hivemind-v3-notion-power-user.md); the v1 plan lives in [`.sisyphus/archive/PLANNING-v1.md`](.sisyphus/archive/PLANNING-v1.md).

## Concepts worth knowing before you change something

- **`data_source_id`, not `database_id`.** A Notion database is a container for one or more data sources; the public API operates on data sources. Default SDK API version is `2025-09-03`. `ntn datasources resolve <database-id>` lists the data sources inside a DB.
- **Scope guard.** All agent writes go through `src/scope.ts`. Writes outside the brief's project subtree are caught and reported, not silently dropped. Be deliberate when you add a new tool — wire it through the guard.
- **Bot-edit filter.** Every status-write the Architect/Sentinel make would otherwise loop back through the webhook. The webhook compares `page.last_edited_by.id` against `HIVEMIND_BOT_USER_ID` to break the loop. Keep that env var populated.
- **Tool-use truncation.** If a single Architect response emits more output tokens than `maxTokens`, the loop throws `max_tokens hit — agent may have produced truncated tool_use`. Raise the per-agent cap if you see this for legitimate large outputs (long `writeAnswer` bodies, big `createChildPage` block arrays).

## Anvil (the local executor)

Two flavors:

- **In-process Anvil** (`src/anvil.ts`) — the default. Spawned by the Architect via `delegateAnvil({ task, context })` only in `--local` orchestrator mode. Writes files into `os.tmpdir()/hivemind-anvil-<briefId>-<ts>/`, serves them on a 127.0.0.1 auto-allocated port, drives a headless Chromium via Playwright, and embeds the screenshot back into the brief's project root. The HTTP server is intentionally **not** `unref()`'d, so the human can visit the URL after `runOrchestrator` returns. Ctrl+C exits.
- **VM-backed Anvil daemon** (`anvil/`) — the heavier path. Subscribes to a Pusher channel; the Worker publishes `brief.dispatched` events when a brief gets `Owner=Forge-Local`. Anvil then runs the work in an E2B Firecracker microVM or a local Lima VM and ships the result back as a GitHub PR. See [`anvil/README.md`](anvil/README.md).

Both paths can coexist.

## Contributing

This is a personal R&D project that's now open source. If you find it useful, file an issue or open a PR — but please read [`AGENTS.md`](AGENTS.md) and the v2 plan first; the architecture is opinionated and the surface area is small on purpose.

Style notes:

- TypeScript with `strict` enabled. Explicit types at I/O boundaries.
- **Tabs** for indentation. Capability keys in `lowerCamelCase`.
- Commit format: `feat(scope): ...`, `fix(scope): ...`, `chore: ...`.
- Run `npm run check` before pushing.

## License

[MIT](LICENSE) © 2026 Kristian Vast
