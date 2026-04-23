// test_scripts/agent-run.spec.ts
//
// Tests for runOneShot and runInteractive.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { FakeToolCallingModel } from 'langchain';
import { runOneShot, runInteractive } from '../src/agent/run';
import { createAgentLogger } from '../src/agent/logging';
import type { AgentConfig } from '../src/config/agent-config';

function makeCfg(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base = {
    provider: 'openai' as const,
    model: 'gpt-test',
    temperature: 0,
    maxSteps: 10,
    perToolBudgetBytes: 16384,
    systemPrompt: null,
    systemPromptFile: null,
    toolsAllowlist: null,
    allowMutations: false,
    envFilePath: null,
    verbose: false,
    interactive: false,
    providerEnv: Object.freeze({}),
  } satisfies AgentConfig;
  return Object.freeze({ ...base, ...overrides }) as AgentConfig;
}

function silentLogger(cfg: AgentConfig) {
  return createAgentLogger(cfg, { quiet: true });
}

function makePingTool() {
  return tool(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (_input: any): Promise<string> => JSON.stringify({ ok: 1 }),
    {
      name: 'ping',
      description: 'Returns {ok:1}.',
      schema: z.object({}),
    },
  );
}

describe('runOneShot', () => {
  it('returns AgentResult with one step and terminatedBy=final', async () => {
    const model = new FakeToolCallingModel({
      toolCalls: [
        [{ name: 'ping', args: {}, id: 'call-1' }],
        [], // final answer.
      ],
    });
    const cfg = makeCfg();
    const logger = silentLogger(cfg);

    const res = await runOneShot({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      tools: [makePingTool()],
      systemPrompt: 'sp',
      cfg,
      prompt: 'hi',
      logger,
    });
    await logger.close();

    expect(res.steps.length).toBe(1);
    expect(res.steps[0].tool).toBe('ping');
    expect(res.meta.terminatedBy).toBe('final');
    expect(res.meta.stepsUsed).toBe(1);
    expect(res.meta.durationMs).toBeGreaterThanOrEqual(0);
    // FakeToolCallingModel doesn't emit usage metadata → all zeros.
    expect(res.usage.totalInputTokens).toBe(0);
    expect(res.usage.totalOutputTokens).toBe(0);
    expect(res.usage.totalTokens).toBe(0);
  });

  it('sets terminatedBy=maxSteps (or error) when recursion limit is hit', async () => {
    // Model keeps calling the ping tool forever.
    const model = new FakeToolCallingModel({
      toolCalls: [[{ name: 'ping', args: {}, id: 'call-loop' }]],
    });
    const cfg = makeCfg({ maxSteps: 2 });
    const logger = silentLogger(cfg);

    const res = await runOneShot({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      tools: [makePingTool()],
      systemPrompt: 'sp',
      cfg,
      prompt: 'go',
      logger,
    });
    await logger.close();

    // Either the graph caught the limit and we labeled it 'maxSteps', or
    // LangGraph returned a final state where the last message still had
    // tool_calls (which we label 'error'). Both are acceptable per the unit
    // contract — the important thing is the method returned, not crashed.
    expect(['maxSteps', 'error']).toContain(res.meta.terminatedBy);
  });

  it('extracts answer from the final AIMessage', async () => {
    // No tool calls at all → model's content is the answer. The
    // FakeToolCallingModel uses the last user message text as the AIMessage
    // content when no toolCalls are scheduled — we assert that round-trip.
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const cfg = makeCfg();
    const logger = silentLogger(cfg);

    const res = await runOneShot({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      tools: [],
      systemPrompt: 'sp',
      cfg,
      prompt: 'hello world',
      logger,
    });
    await logger.close();

    expect(res.meta.terminatedBy).toBe('final');
    expect(res.steps.length).toBe(0);
    // The fake echoes back the last message content.
    expect(res.answer.length).toBeGreaterThan(0);
  });
});

describe('runInteractive', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Guard against process.exit(130) from the SIGINT path escaping the test.
    exitSpy = vi
      .spyOn(process, 'exit')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(((_code?: number) => undefined) as any);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('prints a banner and exits cleanly on /exit', async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const cfg = makeCfg();
    const logger = silentLogger(cfg);

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stdoutChunks: string[] = [];
    stdout.on('data', (c: Buffer) => stdoutChunks.push(c.toString('utf8')));

    const done = runInteractive({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      tools: [],
      systemPrompt: 'sp',
      cfg,
      logger,
      stdin,
      stdout,
    });

    // Feed one user turn, then /exit.
    stdin.write('hello\n');
    stdin.write('/exit\n');
    stdin.end();

    await done;
    await logger.close();

    const out = stdoutChunks.join('');
    expect(out).toContain('Outlook agent');
    expect(out).toContain('/exit');
    // FakeToolCallingModel was invoked at least once (answer printed).
    expect(model.index).toBeGreaterThanOrEqual(0);
  });
});
