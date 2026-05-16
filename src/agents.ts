import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const HAIKU_MODEL = "claude-haiku-4-5";
const SENTINEL_MODEL = "gpt-5-nano";

export interface Brief {
	title: string;
	body?: string;
}

async function callHaiku(args: {
	system: string;
	user: string;
	maxTokens: number;
}): Promise<string> {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		throw new Error(
			"ANTHROPIC_API_KEY is not set. Add it to .env locally and run `ntn workers env push`.",
		);
	}

	const client = new Anthropic({ apiKey });
	const response = await client.messages.create({
		model: HAIKU_MODEL,
		max_tokens: args.maxTokens,
		system: args.system,
		messages: [{ role: "user", content: args.user }],
	});

	const first = response.content[0];
	return first && first.type === "text" ? first.text : "(no text in response)";
}

async function callOpenAI(args: {
	instructions: string;
	input: string;
}): Promise<string> {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error(
			"OPENAI_API_KEY is not set. Add it to .env locally and run `ntn workers env push`.",
		);
	}

	const client = new OpenAI({ apiKey });
	const response = await client.responses.create({
		model: SENTINEL_MODEL,
		instructions: args.instructions,
		input: args.input,
	});

	return response.output_text ?? "(no text in response)";
}

const SCOUT_SYSTEM = `You are Scout, a research agent inside Hivemind — a multi-agent system that runs inside Notion. You are given a brief and must return a concise research note that another agent (Forge) can act on next.

Output exactly this markdown structure, no preamble:

## Context
2-3 sentences on what this brief is asking and why it matters.

## Prior Art
2-3 bullet points of similar work, references, or patterns to draw from.

## Recommended Next Action
One concrete recommendation for Forge to execute.

Keep the entire note under 250 words. Be specific and useful, not generic.`;

export async function runScout(brief: Brief): Promise<string> {
	const userMessage = brief.body
		? `Brief title: ${brief.title}\n\nBrief body:\n${brief.body}`
		: `Brief title: ${brief.title}\n\n(No additional body provided — work from the title alone.)`;

	return callHaiku({
		system: SCOUT_SYSTEM,
		user: userMessage,
		maxTokens: 600,
	});
}

const FORGE_SYSTEM = `You are Forge, a building agent inside Hivemind. You receive a brief plus Scout's research note, and you produce a concrete artifact that delivers on the brief.

Output exactly this markdown structure, no preamble:

## Artifact
The actual deliverable — a plan, draft, code snippet, outline, or whatever the brief calls for. Make it usable as-is.

## Notes
1-2 sentences on assumptions you made or open questions for review.

Keep the artifact under 400 words. Focus on doing the work, not describing the work.`;

const FORGE_RETRY_SYSTEM = `You are Forge, a building agent inside Hivemind. You previously produced an artifact for this brief. The reviewer has left feedback. Produce a revised artifact that addresses the feedback while keeping what worked.

Output exactly this markdown structure, no preamble:

## Artifact
The revised deliverable. Take the reviewer's feedback seriously — change the substance, not just the wording.

## What changed
2-3 bullets on what you revised in response to the feedback. Be specific.

Keep the artifact under 400 words. Be decisive — don't ask clarifying questions, ship the next iteration.`;

export async function runForge(args: {
	brief: Brief;
	scoutNotes: string;
}): Promise<string> {
	const userMessage = [
		`Brief title: ${args.brief.title}`,
		args.brief.body ? `\nBrief body:\n${args.brief.body}` : "",
		`\nScout's research note:\n${args.scoutNotes}`,
	].join("\n");

	return callHaiku({
		system: FORGE_SYSTEM,
		user: userMessage,
		maxTokens: 900,
	});
}

export async function runForgeRetry(args: {
	brief: Brief;
	scoutNotes: string;
	previousArtifact: string;
	feedback: string;
}): Promise<string> {
	const userMessage = [
		`Brief title: ${args.brief.title}`,
		args.brief.body ? `\nBrief body:\n${args.brief.body}` : "",
		`\nScout's research note:\n${args.scoutNotes}`,
		`\nYour previous artifact:\n${args.previousArtifact}`,
		`\nReviewer feedback:\n${args.feedback}`,
	].join("\n");

	return callHaiku({
		system: FORGE_RETRY_SYSTEM,
		user: userMessage,
		maxTokens: 900,
	});
}

const SENTINEL_SYSTEM = `You are Sentinel, the reviewer inside Hivemind. You receive a brief, Scout's research note, and Forge's artifact. Your job is a tight critique — strengths, risks, and a verdict.

Output exactly this markdown structure, no preamble:

## Strengths
2-3 bullets on what the artifact gets right.

## Risks
2-3 bullets on what could go wrong, what's missing, or what's weak. Be specific.

## Verdict
Exactly one of:
- **Looks good** — the artifact is ready for human approval
- **Needs revision** — the artifact has fixable issues, name them

Keep the whole review under 200 words. Be direct, no hedging.`;

export async function runSentinel(args: {
	brief: Brief;
	scoutNotes: string;
	artifact: string;
}): Promise<string> {
	const input = [
		`Brief title: ${args.brief.title}`,
		args.brief.body ? `\nBrief body:\n${args.brief.body}` : "",
		`\nScout's research note:\n${args.scoutNotes}`,
		`\nForge's artifact:\n${args.artifact}`,
	].join("\n");

	return callOpenAI({
		instructions: SENTINEL_SYSTEM,
		input,
	});
}
