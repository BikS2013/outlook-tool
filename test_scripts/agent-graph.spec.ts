// test_scripts/agent-graph.spec.ts
//
// Smoke test for `createAgentGraph` — the sole importer of langchain v1's
// `createAgent`. We assert the returned object is invokable.

import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { FakeToolCallingModel } from 'langchain';
import { createAgentGraph } from '../src/agent/graph';

describe('createAgentGraph', () => {
  it('returns an invokable runnable', () => {
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const graph = createAgentGraph({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      tools: [],
      systemPrompt: 'test prompt',
    });
    expect(graph).toBeTruthy();
    expect(typeof (graph as { invoke?: unknown }).invoke).toBe('function');
  });

  it('invokes with a tool call and resolves with the final AIMessage', async () => {
    // Step 1: AIMessage requesting a tool call. Step 2: a final AIMessage.
    const fake = tool(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (_input: any): Promise<string> => {
        return JSON.stringify({ ok: 1 });
      },
      {
        name: 'ping',
        description: 'Returns {ok:1}.',
        schema: z.object({}),
      },
    );

    const model = new FakeToolCallingModel({
      toolCalls: [
        [{ name: 'ping', args: {}, id: 'call-1' }],
        [], // second turn: no tool calls → final answer.
      ],
    });

    const graph = createAgentGraph({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      tools: [fake],
      systemPrompt: 'use the ping tool',
    });

    const state = (await graph.invoke({
      messages: [new HumanMessage('hi')],
    })) as { messages: unknown[] };

    const msgs = state.messages;
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    // Contains at least one ToolMessage whose tool_call_id matches `call-1`.
    const tm = msgs.find(
      (m) =>
        m instanceof ToolMessage &&
        (m as ToolMessage).tool_call_id === 'call-1',
    );
    expect(tm).toBeDefined();
    // Last message is an AIMessage.
    const last = msgs[msgs.length - 1];
    expect(last instanceof AIMessage).toBe(true);
  });
});
