// Phase 4: Category is informational metadata only. The orchestrator still
// runs this classifier on Backlog→Triaged transitions to fill the brief's
// Category property (used for kanban filters and the project root's icon /
// caption), but it does NOT route execution. The Architect picks
// writeAnswer vs createDraft itself based on the brief content — every
// brief is provisioned with the unified layout, regardless of Category.

import Anthropic from "@anthropic-ai/sdk";

export type Category = "visual-engineering" | "ultrabrain" | "deep" | "quick" | "writing";

export const ALL_CATEGORIES: readonly Category[] = [
	"visual-engineering",
	"ultrabrain",
	"deep",
	"quick",
	"writing",
];

export interface ClassifyInput {
	title: string;
	body?: string;
}

const SYSTEM_PROMPT = `You are a task classifier. Your job is to classify a brief into exactly one of these 5 categories:

- visual-engineering: UI, UX, CSS, styling, design, animation, frontend components, layouts
- ultrabrain: Hard logic, complex architecture, algorithms, deep technical reasoning
- deep: Open-ended research-plus-implementation, autonomous problem-solving on hairy problems
- quick: Trivial tasks — typos, single-file fixes, small mechanical changes
- writing: Documentation, prose, blog posts, technical writing, communication

Respond with ONLY the category name, nothing else. No explanation, no punctuation, just the word.`;

/**
 * Classifies a brief into one of 5 categories using Claude Haiku.
 * Returns a Category. Defaults to "deep" on any error or invalid output (safe middle-ground).
 *
 * @param input - The brief to classify (title and optional body)
 * @param apiKey - Optional API key; falls back to process.env.ANTHROPIC_API_KEY
 * @returns A Category string
 */
export async function classifyBrief(
	input: ClassifyInput,
	apiKey?: string,
): Promise<Category> {
	const key = apiKey || process.env.ANTHROPIC_API_KEY;

	if (!key) {
		console.warn(
			"[classify] No API key provided. Set apiKey arg or ANTHROPIC_API_KEY env var.",
		);
		return "deep";
	}

	const client = new Anthropic({ apiKey: key });

	const userMessage = `Title: ${input.title}\n\nBody:\n${input.body ?? "(no body)"}`;

	try {
		const response = await client.messages.create({
			model: "claude-haiku-4-5",
			max_tokens: 32,
			system: SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: userMessage,
				},
			],
		});

		// Extract text from response
		const text =
			response.content[0]?.type === "text" ? response.content[0].text : "";
		const trimmed = text.trim().toLowerCase();

		// Check if it matches one of our categories
		if (ALL_CATEGORIES.includes(trimmed as Category)) {
			return trimmed as Category;
		}

		// Invalid output, default to "deep"
		console.warn(
			`[classify] Invalid category returned: "${trimmed}". Defaulting to "deep".`,
		);
		return "deep";
	} catch (error) {
		console.warn(
			`[classify] API error: ${error instanceof Error ? error.message : String(error)}. Defaulting to "deep".`,
		);
		return "deep";
	}
}
