# Hivemind

**Chief-of-Staff platform for Notion.** Drop a brief in a database, the swarm picks it up.

Hivemind is a multi-agent operating system that runs entirely inside Notion. Notion is the hive — the UI, the queue, the audit log, the comment thread, the kanban — and the AI agents are the swarm. There is no separate frontend, no dashboard, no shell. Open Notion, drag a card, watch the bees work.

Built at the Notion Developer Platform Hackathon (May 16–17 2026, Notion HQ) on the **Workflow Relay** theme.

## The swarm

| Role | Name | Model |
| --- | --- | --- |
| Researcher | **Scout** | Anthropic Claude Haiku |
| Builder | **Forge** | Anthropic Claude Haiku |
| Reviewer | **Sentinel** | OpenAI GPT-5-nano |

Three specialists today, more on the way (Scribe for polishing, Core as a router). Cross-vendor by design: Anthropic for production work, OpenAI for impartial review.

## How the relay runs

1. Drop a brief in the **Briefs** database (`Status = Backlog`). Write the title, optionally add detail in the page body.
2. Drag it to **`Triaged`**. A Notion DB automation fires the Worker webhook.
3. The Worker advances the card through the chain, appending each agent's output as live blocks on the brief:
   - `Status → In Progress`, `Owner → Scout` — Scout posts a research note.
   - `Owner → Forge` — Forge produces the artifact.
   - `Owner → Sentinel` — Sentinel posts strengths, risks, and a verdict.
   - `Status → Needs Review`.
4. Read the artifact. Leave Notion comments with feedback if you want changes.
5. Either:
   - **Drag to `Done`** → the swarm posts an approval comment and rests.
   - **Drag back to `Triaged`** → retry path: Forge re-drafts using your comments as feedback, Sentinel re-reviews, and a fresh `iteration N` lands on the page. Scout's earlier note is reused, not regenerated.
6. If anything throws mid-chain, `Status → Failed` and the trace is appended as a code block on the card. The chain is idempotent — fix and re-trigger.

The card is always the truth. Open the brief mid-run and you see exactly which agent is working.

## Project layout

```
hivemind/
├── PLANNING.md          The full vision, cast, cut order
├── AGENTS.md            Workers SDK + Notion API field guide
├── src/
│   ├── index.ts         Worker shell: webhook handler, dedup, status routing
│   ├── chain.ts         Orchestration: initial chain + retry path + approval
│   ├── agents.ts        Scout / Forge / Sentinel — model calls and prompts
│   └── notion.ts        Notion glue: read brief, append blocks, md → blocks, error reporting
├── scripts/
│   └── seedBriefs.ts    Creates a regular (user-editable) Briefs DB via Notion API
└── .env.example         Required environment variables
```

## Setup

You need:
- A Notion workspace
- The `ntn` CLI: `curl -fsSL https://ntn.dev | bash`
- An Anthropic API key
- An OpenAI API key (with org verification if using `gpt-5-mini` instead of `nano`)

### 1. Scaffold and install

```shell
git clone <this repo>
cd hivemind
npm install
ntn login
```

### 2. Create the Briefs database

Create a Notion page named `Hivemind` and share it with your internal integration (… → Connections → your integration). Then:

```shell
bun run scripts/seedBriefs.ts <hivemind-page-url>
```

This creates a regular (user-editable) Notion database with `Status` and `Owner` select properties, color-coded for kanban. The script avoids `worker.database()` deliberately — managed databases have read-only schemas in the Notion UI, which breaks the demo's drag-and-drop flow.

Resolve the data source ID:

```shell
ntn datasources resolve <database-id>
```

### 3. Fill `.env`

Copy `.env.example` to `.env` and populate:
- `NOTION_API_TOKEN` — your internal integration token
- `ANTHROPIC_API_KEY` — for Scout + Forge
- `OPENAI_API_KEY` — for Sentinel
- `HIVEMIND_BRIEFS_DATABASE_ID` — from the seed script output
- `HIVEMIND_BRIEFS_DATA_SOURCE_ID` — from `ntn datasources resolve`
- `HIVEMIND_WEBHOOK_SECRET` — any random string; you'll paste it into the Notion automation
- `HIVEMIND_BOT_USER_ID` — your integration's bot user ID (`curl https://api.notion.com/v1/users/me -H "Authorization: Bearer $NOTION_API_TOKEN" -H "Notion-Version: 2022-06-28"`)

### 4. Deploy

```shell
ntn workers env push
ntn workers deploy
ntn workers webhooks list   # copy the onBriefStatusChange URL
```

### 5. Wire the Notion automation

On the Briefs database in Notion: **… → Automations → New automation**:
- **Trigger**: `Status` is edited
- **Action**: Send webhook
  - **URL**: the `onBriefStatusChange` URL from `ntn workers webhooks list`
  - **Headers**: `X-Hivemind-Secret: <your HIVEMIND_WEBHOOK_SECRET value>`

Add a kanban view grouped by `Status` for the demo.

## Demo flow

The shipped repo includes three seeded briefs in Backlog:

- *Plan a 1-week launch sequence for Hivemind*
- *Outline a 3-tweet thread explaining Hivemind to a non-technical friend*
- *Suggest a Hivemind mascot bee with a name and one-line backstory*

To run the live demo: open the Briefs kanban, drag any brief from **Backlog → Triaged**. In ~25 seconds the card transits **Triaged → In Progress → Needs Review** and three new sections appear on the page — Scout's research note, Forge's artifact, Sentinel's review. Drag to **Done** to close it out.

To demo the revision loop: drag a completed brief back to **Triaged**. The chain detects the prior Forge output, picks up any comments you've added as feedback, and ships **iteration 2** of the artifact with a fresh Sentinel review.

## Conventions

- **TypeScript strict.** No `any`, no `@ts-ignore`, no `@ts-expect-error`.
- **Errors are visible.** Every chain failure lands on the card as a heading + code block plus `Status = Failed`. No silent swallows.
- **The chain is idempotent.** Re-triggering a brief that already has Forge output takes the retry path; the initial Scout note is reused.
- **Selects, not Status.** The Briefs DB uses `select` properties for Status and Owner because Notion's first-class `status` type can't be edited in the UI after creation, which would block the kanban flow.

## What's next

See [PLANNING.md](./PLANNING.md) for the full vision and cut order. The MVP described there ("Core + Scout + Forge, kanban, comments, approve button, hard-coded research → build chain") is shipped. Items still on the table for stretch goals: Scribe (a polishing agent), Workflows DB (configurable chain recipes), team-mode parallel fan-out, the Activity feed.

## License

MIT.
