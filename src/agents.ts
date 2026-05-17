import type { Client } from "@notionhq/client";

import { runAgent, type AgentResult } from "./agentLoop";
import type { AgentSpec } from "./architect";
import type { TokenBudget } from "./budget";
import type { ProjectIds } from "./provision";
import type { Pacer } from "./pacer";
import type { ScopeGuard } from "./scope";
import { createDispatcher, type BriefMetadata, type ToolHandlerContext } from "./tools/handlers";
import { getToolsForAgent } from "./tools/registry";

export type { AgentSpec };
export type { BriefMetadata };

export interface RunAgentArgs {
	spec: AgentSpec;
	notion: Client;
	briefMetadata: BriefMetadata;
	projectIds: ProjectIds;
	scopeGuard: ScopeGuard;
	pacer: Pacer;
	tokenBudget: TokenBudget;
}

export interface RunAgentReturn {
	result: AgentResult;
	verdict?: { verdict: "approve" | "needs-revision"; summary: string };
	doneSummary?: string;
}

const dispatcher = createDispatcher();

export async function invokeAgent(args: RunAgentArgs): Promise<RunAgentReturn> {
	const ctx: ToolHandlerContext = {
		notion: args.notion,
		briefId: args.briefMetadata.id,
		briefMetadata: args.briefMetadata,
		projectIds: args.projectIds,
		projectRootId: args.projectIds.projectRootId,
		scopeGuard: args.scopeGuard,
		pacer: args.pacer,
		tokenBudget: args.tokenBudget,
		agentName: args.spec.name as ToolHandlerContext["agentName"],
	};

	const tools = getToolsForAgent(
		args.spec.name as Parameters<typeof getToolsForAgent>[0],
	);

	const initialUserMessage = `Brief: ${args.briefMetadata.title}\n\nBody:\n${args.briefMetadata.body ?? "(no body)"}\n\nProject Root: ${args.projectIds.projectRootId}`;

	const result = await runAgent({
		systemPrompt: args.spec.systemPrompt,
		initialUserMessage,
		tools,
		dispatcher,
		ctx,
		model: args.spec.model,
		stepBudget: args.spec.stepBudget,
		taskBudgetTokens: args.spec.taskBudgetTokens,
		maxTokens: args.spec.maxTokens,
		thinking: args.spec.thinking,
	});

	return { result, verdict: ctx.verdict, doneSummary: ctx.doneSummary };
}
