import type Anthropic from "@anthropic-ai/sdk";

import type { Category } from "../classify";

export type AgentName = "Scout" | "Forge" | "Scribe" | "Sentinel";

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

const BLOCK_SHAPE = {
	type: "object" as const,
	properties: {
		type: {
			type: "string",
			enum: [
				"paragraph",
				"heading_2",
				"heading_3",
				"bulleted_list_item",
				"numbered_list_item",
				"to_do",
				"quote",
				"code",
				"callout",
				"toggle",
				"divider",
				"bookmark",
			],
		},
		text: { type: "string" },
		checked: { type: "boolean" },
		language: { type: "string" },
		emoji: { type: "string" },
		url: { type: "string" },
	},
	required: ["type"] as string[],
	additionalProperties: false,
};

const BLOCKS_ARRAY = {
	type: "array" as const,
	items: BLOCK_SHAPE,
};

const PLAN_SECTION_ENUM = {
	type: "string",
	enum: ["Context", "Approach", "Decisions", "Sources", "Open Questions", "Status"],
};

// ---------------------------------------------------------------------------
// All tool definitions
// ---------------------------------------------------------------------------

export const ALL_TOOLS: Record<string, Anthropic.Tool> = {
	searchWorkspace: {
		name: "searchWorkspace",
		description:
			"Keyword search across the workspace. Returns up to `page_size` results (default 5, max 20) as compact {id, title, type} entries.",
		input_schema: {
			type: "object" as const,
			properties: {
				query: { type: "string" },
				page_size: { type: "number", minimum: 1, maximum: 20 },
			},
			required: ["query"],
			additionalProperties: false,
		},
	},

	readPage: {
		name: "readPage",
		description:
			"Read a page's title + blocks as markdown-ish strings. Capped at 100 blocks; longer pages set truncated=true with total_blocks. Properties are NOT included to keep results small.",
		input_schema: {
			type: "object" as const,
			properties: {
				page_id: { type: "string" },
			},
			required: ["page_id"],
			additionalProperties: false,
		},
	},

	readDataSource: {
		name: "readDataSource",
		description:
			"Query rows from a data source. Returns {id, title, ...common scalar props} only — relations, rollups, formulas, files are omitted. Default page_size 20, max 100.",
		input_schema: {
			type: "object" as const,
			properties: {
				data_source_id: { type: "string" },
				page_size: { type: "number", minimum: 1, maximum: 100 },
				start_cursor: { type: "string" },
			},
			required: ["data_source_id"],
			additionalProperties: false,
		},
	},

	getBriefMetadata: {
		name: "getBriefMetadata",
		description:
			"Retrieve metadata for the current brief being processed. Use this to understand the task at hand — title, status, category, and project root. Returns id, title, body, status, category, and project_root_id.",
		input_schema: {
			type: "object" as const,
			properties: {},
			required: [],
			additionalProperties: false,
		},
	},

	getProjectIds: {
		name: "getProjectIds",
		description:
			"Get all provisioned project IDs for the current brief, including the root page, plan page, and all database/data-source IDs. Use this to find the correct IDs before reading or writing to project DBs.",
		input_schema: {
			type: "object" as const,
			properties: {},
			required: [],
			additionalProperties: false,
		},
	},

	readPlanSection: {
		name: "readPlanSection",
		description:
			"Read a specific named section of the project Plan page (Context, Approach, Open Questions, or Status). Use this to understand what prior agents have written before adding your own output. Returns an array of block strings.",
		input_schema: {
			type: "object" as const,
			properties: {
				section: {
					...PLAN_SECTION_ENUM,
					description: "The plan section to read.",
				},
			},
			required: ["section"],
			additionalProperties: false,
		},
	},

	listDrafts: {
		name: "listDrafts",
		description:
			"List all draft records in the project Drafts database. Use this to see what drafts exist, their iteration numbers, statuses, and summaries before creating or reviewing a new draft.",
		input_schema: {
			type: "object" as const,
			properties: {},
			required: [],
			additionalProperties: false,
		},
	},

	getDraft: {
		name: "getDraft",
		description:
			"Get draft metadata only (id, iteration, status, summary, sources, author_agent). Cheap — call this first. Use getDraftBody for the full text.",
		input_schema: {
			type: "object" as const,
			properties: {
				draft_id: { type: "string" },
			},
			required: ["draft_id"],
			additionalProperties: false,
		},
	},

	getDraftBody: {
		name: "getDraftBody",
		description:
			"Fetch the full body of a draft (stringified blocks). Larger payload — only call when you actually need to read the content (e.g. Sentinel review, Forge revision).",
		input_schema: {
			type: "object" as const,
			properties: {
				draft_id: { type: "string" },
			},
			required: ["draft_id"],
			additionalProperties: false,
		},
	},

	appendBlocks: {
		name: "appendBlocks",
		description:
			"Append one or more blocks to a Notion page within the project subtree. Use this to add content to any page the agent has write access to. Returns the IDs of the newly created blocks.",
		input_schema: {
			type: "object" as const,
			properties: {
				page_id: { type: "string", description: "The Notion page ID to append blocks to." },
				blocks: {
					...BLOCKS_ARRAY,
					description: "Array of block objects to append.",
				},
			},
			required: ["page_id", "blocks"],
			additionalProperties: false,
		},
	},

	updateBlock: {
		name: "updateBlock",
		description:
			"Update the content of an existing block within the project subtree. Use this to correct or revise previously written content. Returns { updated: true } on success.",
		input_schema: {
			type: "object" as const,
			properties: {
				block_id: { type: "string", description: "The Notion block ID to update." },
				block: {
					...BLOCK_SHAPE,
					description: "The new block content to replace the existing block.",
				},
			},
			required: ["block_id", "block"],
			additionalProperties: false,
		},
	},

	deleteBlock: {
		name: "deleteBlock",
		description:
			"Delete a block from a page within the project subtree. Use this to remove outdated or incorrect content. Returns { deleted: true } on success.",
		input_schema: {
			type: "object" as const,
			properties: {
				block_id: { type: "string", description: "The Notion block ID to delete." },
			},
			required: ["block_id"],
			additionalProperties: false,
		},
	},

	setPlanSection: {
		name: "setPlanSection",
		description:
			"Replace the entire content of a named section on the project Plan page with new blocks. Use this to write structured output (Context, Approach, Open Questions, Status) to the plan. Returns the section name and block count.",
		input_schema: {
			type: "object" as const,
			properties: {
				section: {
					...PLAN_SECTION_ENUM,
					description: "The plan section to replace.",
				},
				blocks: {
					...BLOCKS_ARRAY,
					description: "New block content to set for this section.",
				},
			},
			required: ["section", "blocks"],
			additionalProperties: false,
		},
	},

	appendToPlanSection: {
		name: "appendToPlanSection",
		description:
			"Append blocks to a named section on the project Plan page without replacing existing content. Use this to add incremental findings to Context or Open Questions. Returns the count of appended blocks.",
		input_schema: {
			type: "object" as const,
			properties: {
				section: {
					...PLAN_SECTION_ENUM,
					description: "The plan section to append to.",
				},
				blocks: {
					...BLOCKS_ARRAY,
					description: "Blocks to append to this section.",
				},
			},
			required: ["section", "blocks"],
			additionalProperties: false,
		},
	},

	createChildPage: {
		name: "createChildPage",
		description:
			"Create a new child page under a parent page within the project subtree. Use this to create supplementary pages for detailed research, notes, or structured output. Returns the new page_id.",
		input_schema: {
			type: "object" as const,
			properties: {
				parent_id: {
					type: "string",
					description: "The Notion page ID of the parent page.",
				},
				title: { type: "string", description: "Title for the new child page." },
				blocks: {
					...BLOCKS_ARRAY,
					description: "Optional initial block content for the new page.",
				},
			},
			required: ["parent_id", "title"],
			additionalProperties: false,
		},
	},

	writeAnswer: {
		name: "writeAnswer",
		description:
			"Write the answer directly onto the project root page (for `writing` and `quick` categories — no Drafts DB exists). The body is converted from markdown to Notion blocks and inserted between the `📄 Answer` anchor heading and the Plan/Activity navigation child pages. On re-run (revision cycle), any prior content in that region is replaced. Use this as the single output for these categories — there is no createDraft. Returns { written: true, block_count }.",
		input_schema: {
			type: "object" as const,
			properties: {
				body: {
					type: "string",
					description: "Full answer body as markdown. Converted to Notion blocks: ## / ### headings, - and 1. lists, ```code fences```, paragraphs.",
				},
				sources: {
					type: "array",
					items: { type: "string" },
					description: "Optional list of source URLs referenced in the answer. Appended as a Sources section at the end.",
				},
			},
			required: ["body"],
			additionalProperties: false,
		},
	},

	createDraft: {
		name: "createDraft",
		description:
			"Create a new draft record in the project Drafts database. Use this when you have produced a complete piece of written output ready for review. Returns the draft_id and iteration number.",
		input_schema: {
			type: "object" as const,
			properties: {
				summary: {
					type: "string",
					description: "One-paragraph summary of the draft (used as the DB row summary).",
				},
				body: {
					type: "string",
					description: "Full draft body text (markdown). Stored as page content.",
				},
				sources: {
					type: "array",
					items: { type: "string" },
					description: "Optional list of source URLs referenced in this draft.",
				},
				based_on_draft_id: {
					type: "string",
					description: "Optional draft_id this draft is a revision of.",
				},
			},
			required: ["summary", "body"],
			additionalProperties: false,
		},
	},

	updateDraftStatus: {
		name: "updateDraftStatus",
		description:
			"Update the status of an existing draft in the Drafts database. Use this to move a draft through the review lifecycle (draft → in-review → needs-revision → approved). Returns { updated: true }.",
		input_schema: {
			type: "object" as const,
			properties: {
				draft_id: { type: "string", description: "The draft page ID to update." },
				status: {
					type: "string",
					enum: ["draft", "in-review", "needs-revision", "approved"],
					description: "The new status for the draft.",
				},
			},
			required: ["draft_id", "status"],
			additionalProperties: false,
		},
	},

	createReview: {
		name: "createReview",
		description:
			"Append a Sentinel review section directly to the draft page (so the draft and its review live together). Records verdict, strengths, risks, and summary as headings and bullets, and stamps the draft's Last Verdict property. Use this after evaluating a draft.",
		input_schema: {
			type: "object" as const,
			properties: {
				draft_id: { type: "string", description: "The draft page ID being reviewed." },
				verdict: {
					type: "string",
					enum: ["approve", "needs-revision"],
					description: "The review verdict.",
				},
				strengths: {
					type: "array",
					items: { type: "string" },
					description: "List of strengths identified in the draft.",
				},
				risks: {
					type: "array",
					items: { type: "string" },
					description: "List of risks or weaknesses identified in the draft.",
				},
				summary: {
					type: "string",
					description: "One-paragraph review summary.",
				},
			},
			required: ["draft_id", "verdict", "strengths", "risks", "summary"],
			additionalProperties: false,
		},
	},

	createSource: {
		name: "createSource",
		description:
			"Append a source (title + URL + optional summary) as a bullet to the Sources section of the Plan page. Use this when you find a relevant external resource during research.",
		input_schema: {
			type: "object" as const,
			properties: {
				title: { type: "string", description: "Title or name of the source." },
				url: { type: "string", description: "URL of the source." },
				summary: {
					type: "string",
					description: "Optional 1–3 sentence summary of the source content.",
				},
			},
			required: ["title", "url"],
			additionalProperties: false,
		},
	},

	createDecision: {
		name: "createDecision",
		description:
			"Append a decision (heading + choice + rationale + optional alternatives) to the Decisions section of the Plan page. Use this to document significant choices.",
		input_schema: {
			type: "object" as const,
			properties: {
				title: { type: "string", description: "The decision in one sentence." },
				choice: { type: "string", description: "What was decided." },
				rationale: { type: "string", description: "Why this choice was made." },
				alternatives_considered: {
					type: "array",
					items: { type: "string" },
					description: "Optional list of alternatives that were considered but not chosen.",
				},
			},
			required: ["title", "choice", "rationale"],
			additionalProperties: false,
		},
	},

	createOpenQuestion: {
		name: "createOpenQuestion",
		description:
			"Append an open question (and optional why-it-matters note) as a bullet to the Open Questions section of the Plan page. Use this when you encounter something that needs human input or further investigation.",
		input_schema: {
			type: "object" as const,
			properties: {
				question: { type: "string", description: "The open question to record." },
				why_it_matters: {
					type: "string",
					description: "Optional explanation of why this question is important.",
				},
			},
			required: ["question"],
			additionalProperties: false,
		},
	},

	addComment: {
		name: "addComment",
		description:
			"Add a comment to a Notion page or block. Use this to communicate findings, flag issues, or leave notes for humans reviewing the work. Returns the comment_id.",
		input_schema: {
			type: "object" as const,
			properties: {
				target: {
					anyOf: [
						{
							type: "object" as const,
							properties: {
								page_id: { type: "string", description: "The page ID to comment on." },
							},
							required: ["page_id"],
							additionalProperties: false,
						},
						{
							type: "object" as const,
							properties: {
								block_id: { type: "string", description: "The block ID to comment on." },
							},
							required: ["block_id"],
							additionalProperties: false,
						},
					],
					description: "The target page or block to comment on.",
				},
				text: { type: "string", description: "The comment text to add." },
			},
			required: ["target", "text"],
			additionalProperties: false,
		},
	},

	setBriefStatus: {
		name: "setBriefStatus",
		description:
			"Update the Status property of the current brief in the Briefs database. Use this to signal state transitions (e.g., marking as Needs Review after Sentinel approves). Returns { updated: true }.",
		input_schema: {
			type: "object" as const,
			properties: {
				status: {
					type: "string",
					enum: ["In Progress", "Needs Review", "Failed"],
					description: "The new status to set on the brief.",
				},
			},
			required: ["status"],
			additionalProperties: false,
		},
	},

	setBriefOwner: {
		name: "setBriefOwner",
		description:
			"Update the Owner property of the current brief to indicate which agent is currently responsible. Use this at the start and end of each agent's turn. Returns { updated: true }.",
		input_schema: {
			type: "object" as const,
			properties: {
				owner: {
					type: ["string", "null"],
					enum: ["Scout", "Forge", "Scribe", "Sentinel", null],
					description: "The agent name to set as owner, or null to clear the owner.",
				},
			},
			required: ["owner"],
			additionalProperties: false,
		},
	},

	setVerdict: {
		name: "setVerdict",
		description:
			"(Sentinel only) Record the final verdict on the current brief's draft cycle. Use this as the last action before calling done — it drives the Status transition to Needs Review and records whether the brief is approved or needs revision. Returns { verdict_set: true }.",
		input_schema: {
			type: "object" as const,
			properties: {
				verdict: {
					type: "string",
					enum: ["approve", "needs-revision"],
					description: "The verdict: approve to mark the brief ready for human review, needs-revision to send back for another draft cycle.",
				},
				summary: {
					type: "string",
					description: "A concise summary of the verdict rationale.",
				},
			},
			required: ["verdict", "summary"],
			additionalProperties: false,
		},
	},

	done: {
		name: "done",
		description:
			"Signal that the agent has completed its work for this turn. Call this as the final tool when you have nothing more to do. Optionally include a summary of what was accomplished. Terminates the agent loop.",
		input_schema: {
			type: "object" as const,
			properties: {
				summary: {
					type: "string",
					description: "Optional summary of what the agent accomplished in this turn.",
				},
			},
			required: [],
			additionalProperties: false,
		},
	},
};

// ---------------------------------------------------------------------------
// Per-(agent, category) whitelists
//
// Forge / Scribe / Sentinel split by category:
//   - "writing" / "quick" → no Drafts DB exists. Drafters use writeAnswer, no
//     listDrafts/getDraft/createDraft/updateDraftStatus. Sentinel reviews the
//     project root page directly.
//   - others → full Drafts DB toolkit, current behavior.
//
// Scout's tool surface doesn't depend on the drafts path — it only touches Plan.
// ---------------------------------------------------------------------------

const SCOUT_TOOLS = [
	"searchWorkspace",
	"readPage",
	"readDataSource",
	"getBriefMetadata",
	"getProjectIds",
	"setPlanSection",
	"appendToPlanSection",
	"createSource",
	"createOpenQuestion",
	"addComment",
	"done",
] as const;

const DRAFTS_DRAFTER_TOOLS = [
	"searchWorkspace",
	"readPage",
	"readDataSource",
	"getBriefMetadata",
	"getProjectIds",
	"readPlanSection",
	"listDrafts",
	"getDraft",
	"getDraftBody",
	"createDraft",
	"updateDraftStatus",
	"createDecision",
	"createOpenQuestion",
	"addComment",
	"done",
] as const;

const INLINE_DRAFTER_TOOLS_WITH_PLAN = [
	"searchWorkspace",
	"readPage",
	"readDataSource",
	"getBriefMetadata",
	"getProjectIds",
	"readPlanSection",
	"writeAnswer",
	"createDecision",
	"createOpenQuestion",
	"addComment",
	"done",
] as const;

const INLINE_DRAFTER_TOOLS_NO_PLAN = [
	"searchWorkspace",
	"readPage",
	"readDataSource",
	"getBriefMetadata",
	"getProjectIds",
	"writeAnswer",
	"addComment",
	"done",
] as const;

const DRAFTS_SENTINEL_TOOLS = [
	"searchWorkspace",
	"readPage",
	"readDataSource",
	"getBriefMetadata",
	"getProjectIds",
	"readPlanSection",
	"listDrafts",
	"getDraft",
	"getDraftBody",
	"createReview",
	"setVerdict",
	"addComment",
	"done",
] as const;

const INLINE_SENTINEL_TOOLS_WITH_PLAN = [
	"searchWorkspace",
	"readPage",
	"readDataSource",
	"getBriefMetadata",
	"getProjectIds",
	"readPlanSection",
	"createReview",
	"setVerdict",
	"addComment",
	"done",
] as const;

const INLINE_SENTINEL_TOOLS_NO_PLAN = [
	"searchWorkspace",
	"readPage",
	"readDataSource",
	"getBriefMetadata",
	"getProjectIds",
	"createReview",
	"setVerdict",
	"addComment",
	"done",
] as const;

function isInlineCategory(category: Category): boolean {
	return category === "writing" || category === "quick";
}

function hasPlanPage(category: Category): boolean {
	return category !== "quick";
}

export function getToolNamesForAgent(
	agent: AgentName,
	category: Category,
): readonly string[] {
	const inline = isInlineCategory(category);
	const plan = hasPlanPage(category);
	switch (agent) {
		case "Scout":
			return SCOUT_TOOLS;
		case "Forge":
		case "Scribe":
			if (!inline) return DRAFTS_DRAFTER_TOOLS;
			return plan
				? INLINE_DRAFTER_TOOLS_WITH_PLAN
				: INLINE_DRAFTER_TOOLS_NO_PLAN;
		case "Sentinel":
			if (!inline) return DRAFTS_SENTINEL_TOOLS;
			return plan
				? INLINE_SENTINEL_TOOLS_WITH_PLAN
				: INLINE_SENTINEL_TOOLS_NO_PLAN;
	}
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

export function getToolsForAgent(
	agent: AgentName,
	category: Category,
): Anthropic.Tool[] {
	return getToolNamesForAgent(agent, category).map((name) => {
		const tool = ALL_TOOLS[name];
		if (!tool) {
			throw new Error(
				`Tool "${name}" in ${agent}/${category} whitelist not found in ALL_TOOLS`,
			);
		}
		return tool;
	});
}
