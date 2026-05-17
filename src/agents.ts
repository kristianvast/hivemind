import type { Client } from "@notionhq/client";

import { runAgent, type AgentResult } from "./agentLoop";
import { getAgentSpec, type AgentName } from "./chains";
import { getToolsForAgent } from "./tools/registry";
import { createDispatcher, type ToolHandlerContext, type BriefMetadata } from "./tools/handlers";
import type { ProjectIds } from "./provision";
import type { ScopeGuard } from "./scope";
import type { Pacer } from "./pacer";
import type { TokenBudget } from "./budget";
import type { Category } from "./classify";

export type { BriefMetadata };

export interface RunAgentArgs {
	agent: AgentName;
	category: Category;
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
}

const dispatcher = createDispatcher();

export async function invokeAgent(args: RunAgentArgs): Promise<RunAgentReturn> {
	const spec = getAgentSpec(args.category, args.agent);

	const ctx: ToolHandlerContext = {
		notion: args.notion,
		briefId: args.briefMetadata.id,
		briefMetadata: args.briefMetadata,
		projectIds: args.projectIds,
		projectRootId: args.projectIds.projectRootId,
		scopeGuard: args.scopeGuard,
		pacer: args.pacer,
		tokenBudget: args.tokenBudget,
		agentName: args.agent,
	};

	const initialUserMessage = `Brief: ${args.briefMetadata.title}\n\nBody:\n${args.briefMetadata.body ?? "(no body)"}\n\nProject Root: ${args.projectIds.projectRootId}`;

	const result = await runAgent({
		systemPrompt: spec.systemPrompt,
		initialUserMessage,
		tools: getToolsForAgent(args.agent, args.category),
		dispatcher,
		ctx,
		model: spec.model,
		stepBudget: spec.stepBudget,
		taskBudgetTokens: spec.taskBudgetTokens,
		thinking: spec.thinking,
	});

	return { result, verdict: ctx.verdict };
}
