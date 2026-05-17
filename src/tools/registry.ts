import type Anthropic from "@anthropic-ai/sdk";

type BetaToolUnion = Anthropic.Beta.Messages.BetaToolUnion;

export type AgentName =
	| "Architect"
	| "Scout"
	| "Librarian"
	| "Oracle"
	| "Forge"
	| "Scribe"
	| "Sentinel";

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
				"equation",
				"embed",
				"image",
				"video",
				"audio",
				"pdf",
				"file",
				"link_to_page",
				"table",
				"breadcrumb",
				"table_of_contents",
			],
		},
		text: {
			type: "string",
			description:
				"Primary text for the block. For `equation`, holds the LaTeX expression.",
		},
		checked: { type: "boolean" },
		language: { type: "string" },
		emoji: { type: "string" },
		url: {
			type: "string",
			description:
				"For `bookmark`/`embed`: the target URL. For `image`/`video`/`audio`/`pdf`/`file`: the external file URL (alternative to `file_upload_id`).",
		},
		caption: {
			type: "string",
			description:
				"Optional caption text for `image`/`video`/`audio`/`pdf`/`file` blocks.",
		},
		file_upload_id: {
			type: "string",
			description:
				"For `image`/`video`/`audio`/`pdf`/`file`: ID returned by uploadFile, alternative to `url`.",
		},
		target_page_id: {
			type: "string",
			description: "For `link_to_page`: the destination page ID.",
		},
		target_database_id: {
			type: "string",
			description: "For `link_to_page`: the destination database ID.",
		},
		rows: {
			type: "array",
			items: {
				type: "array",
				items: { type: "string" },
			},
			description:
				"For `table`: 2-D array of cell strings (rows × columns). Every row must have the same length.",
		},
		has_column_header: { type: "boolean" },
		has_row_header: { type: "boolean" },
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

	delegateScout: {
		name: "delegateScout",
		description:
			"Spawn a Scout sub-agent to research a specific question against the Notion workspace + web. Scout runs in its own context, reads pages and web sources, captures findings as Sources on the Plan page, and returns a 1-3 paragraph summary. Use when you need to find more than 1-2 pages, or when the search is broad/exploratory. Do NOT use for a single readPage on a known ID. You can fan out multiple Scouts in parallel in one turn for independent angles. Returns { summary, tool_calls, tokens, duration_ms }.",
		input_schema: {
			type: "object" as const,
			properties: {
				query: {
					type: "string",
					description: "The specific question Scout should answer. Be concrete — 'find prior auth implementations' beats 'auth stuff'.",
				},
				context: {
					type: "string",
					description: "Optional 1-2 sentence context about the broader brief so Scout can prioritize.",
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
	},

	delegateLibrarian: {
		name: "delegateLibrarian",
		description:
			"Spawn a Librarian sub-agent to research EXTERNAL references (docs, APIs, articles, web). Librarian has web_search and web_fetch, runs in its own context, captures findings as Sources on the Plan page, and returns a 1-3 paragraph summary with cited URLs. Use when: the brief mentions a library/API/framework, contains URLs to dig into, or asks 'how do I X' for external tooling. Fan out parallel Librarians for independent topics. Returns { summary, tool_calls, tokens, duration_ms }.",
		input_schema: {
			type: "object" as const,
			properties: {
				query: {
					type: "string",
					description: "The specific external reference question. Be concrete — 'Notion API rate limit headers' beats 'Notion rate limits'.",
				},
				context: {
					type: "string",
					description: "Optional 1-2 sentence context about the broader brief.",
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
	},

	delegateOracle: {
		name: "delegateOracle",
		description:
			"Spawn an Oracle sub-agent for DEEP analysis on a hard problem — architecture tradeoffs, security implications, multi-system decisions, debugging after a failed approach. Oracle has extended thinking enabled (8k thinking budget), is read-only (no writes), and returns structured analysis + recommendation + confidence. Use when: a decision affects multiple modules, a previous approach failed and you need new angles, or the brief requires deep reasoning beyond a Scout/Librarian lookup. Returns { analysis, tool_calls, tokens, duration_ms }.",
		input_schema: {
			type: "object" as const,
			properties: {
				question: {
					type: "string",
					description: "The specific question for Oracle. Frame as a decision or analysis question, not a research question.",
				},
				context: {
					type: "string",
					description: "Context about what's been tried, what's known, what's at stake.",
				},
			},
			required: ["question"],
			additionalProperties: false,
		},
	},

	getWorkspaceHome: {
		name: "getWorkspaceHome",
		description:
			"Fetch IDs of the workspace-level Hivemind Home page and its 🪵 Activity database (cross-brief run mirror). Use when you want to surface a linked view, chart, or dashboard widget on the workspace home, or query cross-brief Activity data. Returns { home_page_id, activity_db_id, activity_ds_id } if configured, or { configured: false } if the admin hasn't run scripts/provisionWorkspaceHome yet.",
		input_schema: {
			type: "object" as const,
			properties: {},
			required: [],
			additionalProperties: false,
		},
	},

	readPageMarkdown: {
		name: "readPageMarkdown",
		description:
			"Retrieve a page's full content as Notion-flavored markdown. Much cheaper than `readPage` (which returns one block per stringified line, capped at 100). Use when you need the full content of a longer page. Returns { markdown: string, truncated?: boolean }.",
		input_schema: {
			type: "object" as const,
			properties: {
				page_id: { type: "string" },
				include_transcript: {
					type: "boolean",
					description:
						"Whether to include meeting note transcripts (defaults to false).",
				},
			},
			required: ["page_id"],
			additionalProperties: false,
		},
	},

	manageDatabase: {
		name: "manageDatabase",
		description:
			"Create or modify Notion databases. Six ops via `op`: `create` (new database with initial schema), `update` (rename a database), `addProperty` (extend a data source's schema), `removeProperty`, `listTemplates` (enumerate templates on a data source), `retrieve` (fetch database metadata). Returns shape varies by op. Use when the brief needs a new structured artifact (e.g. 'create a Risk Register database').",
		input_schema: {
			type: "object" as const,
			properties: {
				op: {
					type: "string",
					enum: [
						"create",
						"update",
						"addProperty",
						"removeProperty",
						"listTemplates",
						"retrieve",
					],
				},
				database_id: { type: "string" },
				data_source_id: { type: "string" },
				parent_page_id: { type: "string" },
				title: { type: "string" },
				property_name: { type: "string" },
				property_type: {
					type: "string",
					enum: [
						"title",
						"rich_text",
						"number",
						"select",
						"multi_select",
						"status",
						"date",
						"people",
						"files",
						"checkbox",
						"url",
						"email",
						"phone_number",
						"formula",
						"relation",
						"rollup",
						"created_time",
						"created_by",
						"last_edited_time",
						"last_edited_by",
						"unique_id",
						"verification",
					],
				},
				options: {
					type: "array",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							color: { type: "string" },
						},
						required: ["name"],
						additionalProperties: false,
					},
					description:
						"For select/multi_select/status property types: choices with optional colors.",
				},
				schema: {
					type: "object",
					additionalProperties: true,
					description:
						"For `create`: full property schema map (property_name → property config). See https://developers.notion.com/reference/property-object.",
				},
				expression: {
					type: "string",
					description: "For formula property type: the formula expression.",
				},
				related_data_source_id: {
					type: "string",
					description: "For relation property type: the data source to link.",
				},
			},
			required: ["op"],
			additionalProperties: false,
		},
	},

	createPageFromTemplate: {
		name: "createPageFromTemplate",
		description:
			"Create a page in a database, pre-populated from one of the database's templates. Use `manageDatabase({op:'listTemplates', data_source_id})` first to discover available templates. Note: template application is asynchronous — the returned page starts empty and Notion fills it in shortly after.",
		input_schema: {
			type: "object" as const,
			properties: {
				data_source_id: { type: "string" },
				template_id: {
					type: "string",
					description: "Template ID from listTemplates, or omit + set use_default=true.",
				},
				use_default: {
					type: "boolean",
					description: "Apply the data source's default template instead.",
				},
				timezone: {
					type: "string",
					description:
						"IANA timezone for resolving @now/@today template variables (e.g. 'America/Los_Angeles').",
				},
				properties: {
					type: "object",
					additionalProperties: true,
					description: "Property values for the new page (same shape as createPage).",
				},
			},
			required: ["data_source_id"],
			additionalProperties: false,
		},
	},

	managePage: {
		name: "managePage",
		description:
			"Update a page's metadata or move/trash/restore it. Six ops via `op`: `setIcon` (emoji / external URL / file_upload_id / native icon name), `setCover` (external URL / file_upload_id), `setTitle`, `move` (to a new parent page or data source), `trash` (soft delete), `restore` (un-trash). Returns { ok: true }.",
		input_schema: {
			type: "object" as const,
			properties: {
				op: {
					type: "string",
					enum: ["setIcon", "setCover", "setTitle", "move", "trash", "restore"],
				},
				page_id: { type: "string" },
				emoji: { type: "string", description: "For setIcon: an emoji like 🐝." },
				external_url: {
					type: "string",
					description: "For setIcon / setCover: an external image URL.",
				},
				file_upload_id: {
					type: "string",
					description:
						"For setIcon / setCover: a file_upload_id returned by uploadFile.",
				},
				icon_name: {
					type: "string",
					description:
						"For setIcon: a native Notion icon name (e.g. 'briefcase'). Combine with `icon_color`.",
				},
				icon_color: {
					type: "string",
					description: "For setIcon (native): icon color name.",
				},
				title: { type: "string", description: "For setTitle: the new title." },
				new_parent_page_id: {
					type: "string",
					description: "For move: parent page to move under.",
				},
				new_parent_data_source_id: {
					type: "string",
					description:
						"For move: data source to move under (page becomes a DB row).",
				},
			},
			required: ["op", "page_id"],
			additionalProperties: false,
		},
	},

	uploadFile: {
		name: "uploadFile",
		description:
			"Upload a file to Notion-hosted storage via the external_url mode. Notion fetches the URL, stores the file, and returns a `file_upload_id`. Use the returned id with managePage(setIcon/setCover), or as `file_upload_id` on `image`/`video`/`audio`/`pdf`/`file` blocks. Returns { file_upload_id, status }.",
		input_schema: {
			type: "object" as const,
			properties: {
				external_url: {
					type: "string",
					description: "Public URL of the file to fetch and store.",
				},
				filename: {
					type: "string",
					description:
						"Optional override for the stored filename (defaults to URL basename).",
				},
				content_type: {
					type: "string",
					description: "Optional MIME type hint.",
				},
			},
			required: ["external_url"],
			additionalProperties: false,
		},
	},

	manageView: {
		name: "manageView",
		description:
			"All-purpose tool for working with Notion database views (table / board / calendar / timeline / gallery / list / form / chart / map / dashboard). Eight ops via the `op` discriminator: `create` (new top-level view on a database), `update` (change name/filter/sorts/config), `list` (enumerate views), `delete` (remove a view), `addWidget` (add a widget view inside an existing dashboard view), `createLinkedDatabase` (insert a linked-database block + view on a page), `query` (run a saved view's filter+sort to get matching pages), `retrieve` (full view details). See https://developers.notion.com/guides/data-apis/working-with-views for view-type-specific configuration shapes.",
		input_schema: {
			type: "object" as const,
			properties: {
				op: {
					type: "string",
					enum: [
						"create",
						"update",
						"list",
						"delete",
						"addWidget",
						"createLinkedDatabase",
						"query",
						"retrieve",
					],
				},
				view_id: { type: "string" },
				database_id: { type: "string" },
				data_source_id: { type: "string" },
				dashboard_view_id: {
					type: "string",
					description: "For `addWidget`: the parent dashboard view's id.",
				},
				target_page_id: {
					type: "string",
					description:
						"For `createLinkedDatabase`: the page where the linked database block goes.",
				},
				name: { type: "string" },
				type: {
					type: "string",
					enum: [
						"table",
						"board",
						"calendar",
						"timeline",
						"gallery",
						"list",
						"form",
						"chart",
						"map",
						"dashboard",
					],
				},
				filter: { type: "object", additionalProperties: true },
				sorts: {
					type: "array",
					items: { type: "object", additionalProperties: true },
				},
				quick_filters: { type: "object", additionalProperties: true },
				configuration: {
					type: "object",
					additionalProperties: true,
					description:
						"Type-specific layout configuration. Discriminated by `type` field inside (must match the view type). See Notion docs for per-view-type schema.",
				},
				placement: { type: "object", additionalProperties: true },
				position: { type: "object", additionalProperties: true },
				page_size: { type: "number" },
				start_cursor: { type: "string" },
			},
			required: ["op"],
			additionalProperties: false,
		},
	},

	writePageMarkdown: {
		name: "writePageMarkdown",
		description:
			"Write to a page using Notion-flavored markdown. Replaces appendBlocks/writeAnswer for most prose-shaped writes — converts markdown to the right block structure server-side. Four modes: `append` (add at end), `replace` (wipe everything and rewrite), `replace_range` (replace content between two anchor strings using \"start...end\" format), `update` (search-and-replace specific strings). Returns { ok: true }.",
		input_schema: {
			type: "object" as const,
			properties: {
				page_id: { type: "string" },
				mode: {
					type: "string",
					enum: ["append", "replace", "replace_range", "update"],
				},
				content: {
					type: "string",
					description:
						"The markdown content to write. For `update` mode, this field is unused — use `updates` instead.",
				},
				after: {
					type: "string",
					description:
						"For `append` mode: optional `start...end` anchor selecting an insertion point. Omit to append at the end of the page.",
				},
				content_range: {
					type: "string",
					description:
						"For `replace_range` mode: `start text...end text` to identify the range to replace.",
				},
				allow_deleting_content: {
					type: "boolean",
					description:
						"Set true to allow the operation to delete child pages or databases (defaults false).",
				},
				updates: {
					type: "array",
					items: {
						type: "object",
						properties: {
							old_str: { type: "string" },
							new_str: { type: "string" },
							replace_all_matches: { type: "boolean" },
						},
						required: ["old_str", "new_str"],
						additionalProperties: false,
					},
					description:
						"For `update` mode: array of search-and-replace operations.",
				},
			},
			required: ["page_id", "mode"],
			additionalProperties: false,
		},
	},
};

// ---------------------------------------------------------------------------
// Per-agent whitelists (Phase 4 — single unified shape per agent, no
// category-driven branching). Every brief is provisioned with both the
// Drafts DB and the Answer anchor, so the Architect gets the full surface
// and picks `writeAnswer` (inline prose) or `createDraft` (iterative
// artifact) at runtime based on the brief.
// ---------------------------------------------------------------------------

const ARCHITECT_TOOLS = [
	"searchWorkspace",
	"readPage",
	"readDataSource",
	"getBriefMetadata",
	"getProjectIds",
	"readPlanSection",
	"setPlanSection",
	"appendToPlanSection",
	"writeAnswer",
	"listDrafts",
	"getDraft",
	"getDraftBody",
	"createDraft",
	"updateDraftStatus",
	"createSource",
	"createDecision",
	"createOpenQuestion",
	"addComment",
	"delegateScout",
	"delegateLibrarian",
	"delegateOracle",
	"getWorkspaceHome",
	"readPageMarkdown",
	"writePageMarkdown",
	"manageView",
	"managePage",
	"manageDatabase",
	"createPageFromTemplate",
	"uploadFile",
	"done",
] as const;

const SCOUT_TOOLS = [
	"searchWorkspace",
	"readPage",
	"readDataSource",
	"getBriefMetadata",
	"getProjectIds",
	"appendToPlanSection",
	"createSource",
	"createOpenQuestion",
	"addComment",
	"done",
] as const;

const LIBRARIAN_TOOLS = [
	"getBriefMetadata",
	"getProjectIds",
	"appendToPlanSection",
	"createSource",
	"createOpenQuestion",
	"addComment",
	"done",
] as const;

const ORACLE_TOOLS = [
	"searchWorkspace",
	"readPage",
	"readDataSource",
	"getBriefMetadata",
	"getProjectIds",
	"readPlanSection",
	"listDrafts",
	"getDraft",
	"getDraftBody",
	"done",
] as const;

const SENTINEL_TOOLS = [
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

export function getToolNamesForAgent(agent: AgentName): readonly string[] {
	switch (agent) {
		case "Architect":
			return ARCHITECT_TOOLS;
		case "Scout":
			return SCOUT_TOOLS;
		case "Librarian":
			return LIBRARIAN_TOOLS;
		case "Oracle":
			return ORACLE_TOOLS;
		case "Forge":
		case "Scribe":
			// Forge/Scribe are v1 agent identifiers retained in the union for
			// transitional reasons (createDraft labels `Author Agent` based on
			// agentName). They're never spawned in v2 — fall back to the
			// Architect surface so any accidental call still has a sane toolset.
			return ARCHITECT_TOOLS;
		case "Sentinel":
			return SENTINEL_TOOLS;
	}
}

// ---------------------------------------------------------------------------
// Server-side tools (executed by Anthropic, not by our dispatcher)
//
// Granted to research sub-agents: Scout (workspace + web) and Librarian
// (external references). web_search yields cited snippets; web_fetch
// retrieves a URL's full content with optional citations. Both are GA on
// the public Claude API and supported by claude-haiku-4-5.
// ---------------------------------------------------------------------------

const WEB_SERVER_TOOLS: BetaToolUnion[] = [
	{
		type: "web_search_20250305",
		name: "web_search",
		// Cost guardrail: Anthropic bills $10 / 1,000 web_search calls,
		// so this caps the per-run search spend.
		max_uses: 5,
		user_location: {
			type: "approximate",
			city: "San Francisco",
			region: "California",
			country: "US",
			timezone: "America/Los_Angeles",
		},
	},
	{
		type: "web_fetch_20250910",
		name: "web_fetch",
		// web_fetch returns FULL page content. Chain budget is 200k tokens
		// and 2-3 Librarian fan-outs are common, so this is tight on purpose:
		// 3 × 8k = 24k worst case per Librarian.
		max_uses: 3,
		max_content_tokens: 8_000,
		citations: { enabled: true },
	},
];

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const WEB_TOOL_AGENTS: ReadonlySet<AgentName> = new Set(["Scout", "Librarian"]);

export function getToolsForAgent(agent: AgentName): BetaToolUnion[] {
	const customTools: BetaToolUnion[] = getToolNamesForAgent(agent).map(
		(name) => {
			const tool = ALL_TOOLS[name];
			if (!tool) {
				throw new Error(
					`Tool "${name}" in ${agent} whitelist not found in ALL_TOOLS`,
				);
			}
			return tool as BetaToolUnion;
		},
	);
	if (WEB_TOOL_AGENTS.has(agent)) {
		return [...customTools, ...WEB_SERVER_TOOLS];
	}
	return customTools;
}
