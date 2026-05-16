# Hivemind

**Chief-of-Staff platform for Notion.** Multi-agent orchestrator on Workers + Custom Agents. Drop a brief in a Notion database, the right specialist agent picks it up, handoffs and approvals happen as comments. Notion is the hive, your AI agents are the swarm.

## Identity

- **Project**: Hivemind
- **Repo**: [github.com/kristianvas/hivemind](https://github.com/kristianvas/hivemind)
- **License**: MIT
- **Stack**: TypeScript strict + Bun + `@notionhq/workers` + Anthropic Claude (primary) + OpenAI GPT-5 (cross-vendor review).
- **Runtime**: Notion-hosted Workers (sandboxed TS). No custom UI, no shell, no npm at runtime, no subprocess. Notion is the entire surface.

## Cast

| Role | Name | Provider |
| --- | --- | --- |
| Orchestrator (Chief of Staff) | Core | Claude |
| Researcher | Scout | Claude |
| Writer | Scribe | Claude |
| Builder, coder | Forge | Claude |
| Reviewer, critic | Sentinel | GPT-5 |

## Surface (Notion-native, zero frontend code)

| Surface | Notion primitive |
| --- | --- |
| Briefs board | Database, kanban view grouped by Status |
| Agents gallery | Database, gallery view, icon thumbnails |
| Workflows | Database (recipes that chain agents) |
| Skills | Database (scoped MCP / tool bundles) |
| Activity feed | Database, list view sorted by date |
| Approve / Reject | Native button blocks → Worker webhook |
| Comments | Native (block + page level) |
| @ mentions | Native |
| Realtime sync, auth, billing, access control, mobile, offline | All native |

## Worker tools

- `intent.classify(brief)` — tag Category, Priority, required Skills. Hashes inputs to dedupe webhook storms.
- `category.route(brief)` — match Category to specialist agent.
- `orchestrator.advance(brief, oldStatus, newStatus)` — Core's hook on status change.
- `agent.invoke(agentName, brief, context)` — fan out to specialist.
- `hook.fire(event, payload)` — generic hook bus.
- `skill.load(skillName)` — fetch and bind a Skill bundle.
- `team.fan-out(briefIds, agentName)` — parallel dispatch.
- `approve.handle(briefId, decision, comment)` — process Approve button + comment.

## Categories (model routing)

- `visual-engineering` → claude-opus-4-7 / max — frontend, UI, design
- `ultrabrain` → gpt-5 / xhigh — hard logic, architecture
- `deep` → gpt-5 / medium — autonomous research + impl
- `quick` → claude-haiku — single-file, trivial
- `writing` → claude-opus-4-7 / high — docs, prose

## Loop (end-to-end)

1. Brief lands in Briefs DB (Backlog status).
2. Webhook fires → Worker validates (`last_edited_time` + content hash, dedupes noisy webhooks).
3. `intent.classify` tags Category, Priority, Skills. Status → Triaged.
4. Core (`category.route`) picks specialist, sets Assigned Agent, status → In Progress.
5. Specialist works, posts progress as block comments, drops artifacts as sub-pages.
6. When done, agent moves card to Needs Review and @ mentions human.
7. Human:
    - Approve button → Done. Orchestrator chains to next Workflow step if any.
    - Comment with edits → bounces to In Progress, agent retries with comment as new input.
    - Reject button → Archived with reason.
8. Failures: try/catch wraps every Worker call. On error: status → Failed, agent posts trace as comment, orchestrator retries 3x with backoff, then human is tagged.
9. Stuck cards: cron Worker scans for cards In Progress past timeout and escalates.

The card is always the truth. Open Notion mid-run, see exactly where the agent is.

## Repo layout

```
hivemind/
├── AGENTS.md            Workers SDK + Notion API field guide (symlink to .agents/INSTRUCTIONS.md)
├── PLANNING.md          This file — product vision, cast, loop
├── package.json
├── tsconfig.json
├── bun.lock
├── src/
│   ├── index.ts         Worker shell: webhook handler, dedup, status routing
│   ├── chain.ts         Orchestration: initial chain + retry path + approval
│   ├── agents.ts        Scout / Forge / Sentinel — model calls and prompts
│   └── notion.ts        Notion glue: read brief, append blocks, md → blocks, error reporting
├── scripts/
│   └── seedBriefs.ts    Creates the Briefs DB in a Notion page via the public API
├── .examples/           Sample Workers (sync, tool, automation, OAuth, webhook)
├── .agents/             Agent skills + shared instructions
├── docs/                Architecture notes, screenshots
└── .env.example         Required environment variables
```

## Conventions

- TS strict. No `any`, no `@ts-ignore`, no `@ts-expect-error`.
- Worker calls: every external call wrapped in try/catch. Return `{ ok: true, data }` or `{ ok: false, error }`.
- Hooks: pure functions `(brief, oldStatus, newStatus) => Promise<void>`. Side effects to Notion only.
- Idempotency: every Worker tool reads + writes `last_edited_time` + `_hash` property. Skip if hash unchanged.
- Errors: post as block comment on the card with trace. Status → Failed after 3 retries.
- Realtime: rely on Notion's native sync. No client polling.
- **Selects, not Status.** The Briefs DB uses `select` properties for Status and Owner because Notion's first-class `status` type can't be edited in the UI after creation, which would block the kanban flow.

## Don't-do (Workers runtime limits)

- No custom UI. Notion is the surface. No React, no blocks SDK, no custom views.
- No shell, no subprocess, no `npm install` at runtime.
- No long-running compute in-Worker. Call out to E2B / Modal / Anthropic code-exec over HTTPS.
- No localhost. Workers run on Notion's infra.

## Credits

Kristian Vastveit (Agrointel AS).
