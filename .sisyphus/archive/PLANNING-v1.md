# Hivemind

**Chief-of-Staff platform for Notion.** Multi-agent orchestrator on Workers + Custom Agents. Drop a brief in a Notion database, the right specialist agent picks it up, handoffs and approvals happen as comments. Notion is the hive, your AI agents are the swarm.

## Identity

- **Project**: Hivemind
- **Repo**: [github.com/kristianvas/hivemind](https://github.com/kristianvas/hivemind)
- **License**: MIT
- **Stack**: TypeScript strict + `@notionhq/workers` + Anthropic Claude (all agents).
- **Runtime**: Notion-hosted Workers (sandboxed TS). No custom UI, no shell, no npm at runtime, no subprocess. Notion is the entire surface.

## Cast

| Role | Name | Model | Notes |
| --- | --- | --- | --- |
| Orchestrator | Core | (no LLM, pure code) | runs in webhook handler |
| Researcher | Scout | Sonnet/Opus (category-dependent) | populates Plan + Sources |
| Writer (prose) | Scribe | Opus | `writing` category primary drafter |
| Builder | Forge | Sonnet/Opus | non-writing primary drafter |
| Reviewer | Sentinel | Sonnet | structured `set_verdict` tool |

## Architecture

The brief is the task. The Project subtree is the agent's room.

When a brief moves from Backlog to Triaged, the webhook fires and the orchestrator runs: classify the brief (if no Category), provision the per-brief Project subtree (if not yet created), then run the agent chain.

**Per-brief Project subtree:**
- Root page (📁 `{brief title}`) created as a child of the brief page
- Plan page with structured sections: Context, Approach, Open Questions, Status
- 6 child databases: Drafts, Reviews, Decisions, Sources, Open Questions, Activity

**Agents** are Claude tool-use loops. Each has a step budget (Scout 8, Forge 15, Scribe 15, Sentinel 5). Step = one tool call.

**Scope guard:** every agent WRITE goes through ancestor-walk verification (`src/scope.ts`). Reads are workspace-wide.

**Status state machine:** Backlog -> Triaged -> In Progress -> Needs Review -> Done / Failed / Archived.

## Categories

| Category | Scout | Forge / Scribe | Sentinel |
| --- | --- | --- | --- |
| `visual-engineering` | Sonnet | Opus | Sonnet |
| `ultrabrain` | Sonnet | Opus + extended thinking | Sonnet |
| `deep` | Sonnet | Sonnet | Sonnet |
| `quick` | (skipped) | Haiku | Sonnet |
| `writing` | Sonnet | Opus | Sonnet |

`quick` skips Scout and runs Forge directly into Sentinel.

## Loop (end-to-end)

1. Brief lands in Briefs DB (Backlog status, no Category).
2. Human moves card to Triaged.
3. Webhook fires. Secret verified, `deliveryId` dedupe checked via `Hivemind State` property.
4. If no Category, classifier (Haiku) sets it.
5. If no Project Root, `provisionProject` creates the subtree (root + Plan + 6 DBs, 2-pass for cross-relations).
6. Retry detection: query Drafts DB for `status="needs-revision"`. If found, chain skips Scout.
7. Agent chain runs. Each agent is a Claude tool-use loop with step budget + token budget + scope guard + rate pacer.
8. Sentinel calls `setVerdict({ verdict, summary })` to exit. Status moves to Needs Review.
9. Human approves. `handleBriefApproved` posts approval comment, Activity finalized.
10. Human bounces back to Triaged. Retry path runs (primary drafter + Sentinel only).

Failures: any catch in chain sets status to Failed, posts error blocks as a comment.

## Tool registry

26 tools total. Read scope = workspace-wide. Write scope = project subtree (scope-guarded).

**Read tools:** `searchWorkspace`, `readPage`, `readDataSource`, `getBriefMetadata`, `getProjectIds`, `readPlanSection`, `listDrafts`, `getDraft`, `listReviews`

**Write tools:** `appendBlocks`, `updateBlock`, `deleteBlock`, `setPlanSection`, `appendToPlanSection`, `createChildPage`, `createDraft`, `updateDraftStatus`, `createReview`, `createSource`, `createDecision`, `createOpenQuestion`, `addComment`

**Brief-level:** `setBriefStatus`, `setBriefOwner`, `setVerdict` (Sentinel only)

**Control:** `done`

## Persistence

`Hivemind State` is a rich-text JSON property on each brief:

```json
{
  "lastDeliveryId": "...",
  "projectRootId": "...",
  "planPageId": "...",
  "dsIds": { "drafts": { "dbId": "...", "dsId": "..." }, "..." },
  "tokensUsed": 0,
  "budgetCircuitTripped": false
}
```

This property is hidden from views via `scripts/configureBriefsUI.ts` so it
doesn't dominate the brief detail panel. The same script adds a `📁 Project`
URL property which `provision.ts` populates with the project subtree URL —
the human's one-click entry point from a brief into its Plan / Drafts /
Activity.

Per-brief token budget circuit-breaker at 200k tokens. Rate pacer: 2.5 RPS, burst 5.

## Repo layout

```
hivemind/
├── src/
│   ├── index.ts         webhook + admin tools
│   ├── chain.ts         orchestrator state machine
│   ├── agents.ts        thin invokeAgent wrapper
│   ├── chains.ts        per-category chain + agent specs + system prompts
│   ├── classify.ts      Haiku-based category classifier
│   ├── provision.ts     2-pass idempotent project provisioner
│   ├── agentLoop.ts     hand-rolled Claude tool-use loop
│   ├── scope.ts         scope guard (ancestor walk + session set)
│   ├── state.ts         Hivemind State JSON in rich-text prop
│   ├── pacer.ts         token-bucket rate pacer
│   ├── budget.ts        TokenBudget circuit breaker
│   ├── notion.ts        block builders + helpers
│   └── tools/
│       ├── registry.ts  Anthropic.Tool[] definitions + per-agent whitelists
│       └── handlers.ts  tool dispatcher with scope-guard wiring
├── scripts/
│   ├── seedBriefs.ts        creates Briefs DB (2025-09-03 + Category + Hivemind State + 📁 Project)
│   ├── migrateBriefs.ts     adds missing properties to an existing Briefs DB
│   └── configureBriefsUI.ts hides Hivemind State from views, sets description, ensures 📁 Project exists
├── test.ts              exec-based smoke test suite
├── PLANNING.md          this file
└── .sisyphus/plans/hivemind-omo-orchestrator.md  full architecture plan
```

## Conventions

- TS strict. No `any`, no `@ts-ignore`, no `@ts-expect-error`.
- Worker calls: every external call wrapped in try/catch. Return `{ ok: true, data }` or `{ ok: false, error }`.
- Idempotency: provisioner checks for existing subtree by name before creating. Dedup via `lastDeliveryId`.
- Errors: post as block comment on the card with trace. Status -> Failed.
- **Selects, not Status.** The Briefs DB uses `select` properties for Status and Owner because Notion's first-class `status` type can't be edited in the UI after creation.

## Don't-do (Workers runtime limits)

- No custom UI. Notion is the surface. No React, no blocks SDK, no custom views.
- No shell, no subprocess, no `npm install` at runtime.
- No long-running compute in-Worker. Call out to external services over HTTPS.
- No localhost. Workers run on Notion's infra.
- No dynamic code loading. Workers SDK forbids it.
- No `database_id` in 2025-09-03 contexts. Use `data_source_id` for relations, page creates under DBs, and queries.

## Credits

Kristian Vastveit (Agrointel AS).
