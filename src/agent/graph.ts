// src/agent/graph.ts
//
// SOLE importer of `createAgent` from `langchain` v1. Per ADR-1 the whole
// ReAct engine is built here so swapping to `createReactAgent` from
// `@langchain/langgraph/prebuilt` is a one-file edit (Risk 2 mitigation).
//
// LangChain v1 `CreateAgentParams` exposes the parameter as `systemPrompt`
// (verified against node_modules/langchain/dist/agents/types.d.ts). Keep
// the `args.systemPrompt` name; it maps 1:1.

import { createAgent } from 'langchain';
import type { MemorySaver } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';

export interface CreateAgentGraphArgs {
  model: BaseChatModel;
  // Accept both the strict `StructuredToolInterface` type and the looser
  // union that LangChain's `tool()` helper returns — the createAgent signature
  // itself is permissive.
  tools: ReadonlyArray<StructuredToolInterface | unknown>;
  systemPrompt: string;
  /** Only used in interactive mode (runInteractive). One-shot passes undefined. */
  checkpointer?: MemorySaver;
}

/**
 * Thin wrapper over `createAgent({ model, tools, systemPrompt, checkpointer })`.
 * The returned object has an `.invoke(...)` method per the LangGraph runnable
 * contract.
 */
export function createAgentGraph(args: CreateAgentGraphArgs) {
  return createAgent({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: args.model as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: args.tools as any,
    systemPrompt: args.systemPrompt,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    checkpointer: args.checkpointer as any,
  });
}
