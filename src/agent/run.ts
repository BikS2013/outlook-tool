// src/agent/run.ts
//
// One-shot and interactive ReAct runners. Both share the graph construction
// path from `createAgentGraph`. Interactive mode wires up an in-process
// `MemorySaver` and a REPL; one-shot mode executes a single `.invoke()` and
// walks the final message list to extract steps, answer, and token usage.
//
// Normative references:
//   - docs/design/project-design.md §7 (ReAct Loop Contract)
//   - docs/design/project-design.md §8 (JSON Output Envelope)

import { MemorySaver } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentConfig, AgentConfigFlags } from '../config/agent-config';
import type { AgentLogger } from './logging';
import { createAgentGraph } from './graph';

// ---------------------------------------------------------------------------
// Public types (see design §3)
// ---------------------------------------------------------------------------

export interface AgentStep {
  index: number;
  tool?: string;
  args?: unknown;
  result?: string;
  reasoning?: string;
}

export interface AgentUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
}

export interface AgentMeta {
  maxSteps: number;
  stepsUsed: number;
  durationMs: number;
  terminatedBy: 'final' | 'maxSteps' | 'error' | 'interrupted';
}

export interface AgentResult {
  answer: string;
  provider: string;
  model: string;
  steps: AgentStep[];
  usage: AgentUsage;
  meta: AgentMeta;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a single message's text content (handles string | ContentBlock[]). */
function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const t = (part as { text?: unknown }).text;
          return typeof t === 'string' ? t : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

function isAIMessage(m: unknown): m is {
  getType?: () => string;
  _getType?: () => string;
  tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>;
  content?: unknown;
  usage_metadata?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  response_metadata?: Record<string, unknown>;
} {
  if (!m || typeof m !== 'object') return false;
  const type =
    typeof (m as { getType?: () => string }).getType === 'function'
      ? (m as { getType: () => string }).getType()
      : typeof (m as { _getType?: () => string })._getType === 'function'
        ? (m as { _getType: () => string })._getType()
        : undefined;
  if (type === 'ai') return true;
  // Fallback structural check.
  return (
    'tool_calls' in (m as Record<string, unknown>) ||
    'usage_metadata' in (m as Record<string, unknown>)
  );
}

function isToolMessage(m: unknown): m is {
  tool_call_id?: string;
  content?: unknown;
} {
  if (!m || typeof m !== 'object') return false;
  const type =
    typeof (m as { getType?: () => string }).getType === 'function'
      ? (m as { getType: () => string }).getType()
      : typeof (m as { _getType?: () => string })._getType === 'function'
        ? (m as { _getType: () => string })._getType()
        : undefined;
  return type === 'tool';
}

/**
 * Walk the final state's `messages[]` and stitch `AIMessage(tool_calls=[…])`
 * + subsequent `ToolMessage(tool_call_id=…)` pairs into `AgentStep`s. The
 * final AIMessage (no tool_calls) supplies the `answer`.
 *
 * Also accumulates token usage from every AIMessage.usage_metadata.
 */
function walkMessages(messages: unknown[]): {
  answer: string;
  steps: AgentStep[];
  usage: AgentUsage;
  lastHadToolCalls: boolean;
} {
  const steps: AgentStep[] = [];
  let answer = '';
  let totalIn = 0;
  let totalOut = 0;
  let totalAll = 0;
  let lastHadToolCalls = false;

  // Map tool_call_id → step index for fast attach of ToolMessages.
  const pending = new Map<string, number>();

  let stepIndex = 0;
  for (const m of messages) {
    if (isAIMessage(m)) {
      const um = m.usage_metadata;
      if (um) {
        if (typeof um.input_tokens === 'number') totalIn += um.input_tokens;
        if (typeof um.output_tokens === 'number') totalOut += um.output_tokens;
        if (typeof um.total_tokens === 'number') totalAll += um.total_tokens;
      }
      const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (tcs.length > 0) {
        lastHadToolCalls = true;
        const contentText = extractContentText(m.content);
        for (const tc of tcs) {
          stepIndex += 1;
          const step: AgentStep = {
            index: stepIndex,
            tool: tc.name,
            args: tc.args,
          };
          if (contentText) step.reasoning = contentText;
          steps.push(step);
          if (tc.id) pending.set(tc.id, steps.length - 1);
        }
      } else {
        lastHadToolCalls = false;
        const text = extractContentText(m.content);
        if (text) answer = text;
      }
    } else if (isToolMessage(m)) {
      const id = m.tool_call_id;
      if (typeof id === 'string' && pending.has(id)) {
        const idx = pending.get(id)!;
        pending.delete(id);
        const tmContent = extractContentText(m.content);
        steps[idx].result = tmContent;
      }
    }
  }

  // Prefer explicit total; else derive.
  const totalTokens = totalAll > 0 ? totalAll : totalIn + totalOut;

  return {
    answer,
    steps,
    usage: {
      totalInputTokens: totalIn,
      totalOutputTokens: totalOut,
      totalTokens,
    },
    lastHadToolCalls,
  };
}

function isRecursionLimitError(err: unknown): boolean {
  if (!err) return false;
  const msg =
    (err as { message?: string }).message ??
    (typeof err === 'string' ? err : '');
  const name = (err as { name?: string }).name ?? '';
  return (
    name === 'GraphRecursionError' ||
    /recursion[_ ]?limit/i.test(msg) ||
    /GRAPH_RECURSION_LIMIT/.test(msg)
  );
}

// Attempt to read provider/model off the chat model for AgentResult. Every
// BaseChatModel exposes these via public getters; the shapes vary.
function describeModel(m: BaseChatModel): { provider: string; model: string } {
  const mm = m as unknown as Record<string, unknown>;
  const provider =
    (typeof mm._llmType === 'function'
      ? (mm._llmType as () => string).call(m)
      : '') ||
    (typeof mm.lc_serializable === 'boolean' && typeof mm.constructor === 'function'
      ? (m.constructor as { name?: string }).name ?? ''
      : '') ||
    'unknown';
  const model =
    (typeof mm.model === 'string' && (mm.model as string)) ||
    (typeof mm.modelName === 'string' && (mm.modelName as string)) ||
    '';
  return { provider, model };
}

// ---------------------------------------------------------------------------
// runOneShot
// ---------------------------------------------------------------------------

export async function runOneShot(args: {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  systemPrompt: string;
  cfg: AgentConfig;
  prompt: string;
  logger: AgentLogger;
}): Promise<AgentResult> {
  const { model, tools, systemPrompt, cfg, prompt, logger } = args;
  const start = Date.now();

  // Guard against accidentally logging large raw prompts.
  if (prompt.length <= 2048) {
    logger.info('agent.one-shot.start', { promptLen: prompt.length });
  } else {
    logger.info('agent.one-shot.start', { promptLen: prompt.length });
  }

  const graph = createAgentGraph({ model, tools, systemPrompt });

  let terminatedBy: AgentMeta['terminatedBy'] = 'error';
  let finalState: { messages?: unknown[] } = {};
  try {
    finalState = (await graph.invoke(
      { messages: [{ role: 'user', content: prompt }] },
      { recursionLimit: cfg.maxSteps },
    )) as { messages?: unknown[] };
  } catch (err) {
    if (isRecursionLimitError(err)) {
      terminatedBy = 'maxSteps';
      logger.warn('agent.one-shot.recursion-limit', {
        maxSteps: cfg.maxSteps,
      });
    } else {
      // Let the caller decide how to surface a fatal; still return an
      // envelope with terminatedBy='error' so logs are consistent.
      logger.error('agent.one-shot.error', {
        message: (err as { message?: string }).message ?? String(err),
      });
      throw err;
    }
  }

  const messages = Array.isArray(finalState.messages)
    ? finalState.messages
    : [];
  const walked = walkMessages(messages);

  if (terminatedBy !== 'maxSteps') {
    terminatedBy = walked.lastHadToolCalls ? 'error' : 'final';
  }

  // Emit verbose step traces.
  for (const s of walked.steps) logger.step(s);
  if (walked.answer) {
    logger.step({ index: walked.steps.length + 1, reasoning: walked.answer });
  }

  const { provider, model: modelId } = describeModel(model);
  const durationMs = Date.now() - start;

  const result: AgentResult = {
    answer: walked.answer,
    provider,
    model: modelId || (cfg.model ?? ''),
    steps: walked.steps,
    usage: walked.usage,
    meta: {
      maxSteps: cfg.maxSteps,
      stepsUsed: walked.steps.length,
      durationMs,
      terminatedBy,
    },
  };

  logger.info('agent.one-shot.done', {
    stepsUsed: result.meta.stepsUsed,
    terminatedBy: result.meta.terminatedBy,
    durationMs,
  });

  return result;
}

// ---------------------------------------------------------------------------
// runInteractive
// ---------------------------------------------------------------------------

export async function runInteractive(args: {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  systemPrompt: string;
  cfg: AgentConfig;
  logger: AgentLogger;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  /** NEW — when provided (alongside `rebuildModel` + `rebuildTools`),
   *  `runInteractive` dispatches to the TUI entry point in `./tui/index`.
   *  When absent, it falls back to the legacy readline REPL so existing
   *  test harnesses keep working unmodified. */
  startupFlags?: AgentConfigFlags;
  rebuildModel?: (cfg: AgentConfig) => Promise<BaseChatModel>;
  rebuildTools?: (cfg: AgentConfig) => StructuredToolInterface[];
}): Promise<void> {
  if (args.startupFlags && args.rebuildModel && args.rebuildTools) {
    // Lazy-load the TUI tree so test harnesses that never hit this path
    // don't pull in the full raw-mode terminal stack (and its transitive
    // system-prompt loader, which uses `require()` at load time).
    const { runTui } = await import('./tui/index');
    await runTui({
      model: args.model,
      tools: args.tools,
      systemPrompt: args.systemPrompt,
      cfg: args.cfg,
      startupFlags: args.startupFlags,
      logger: args.logger,
      rebuildModel: args.rebuildModel,
      rebuildTools: args.rebuildTools,
    });
    return;
  }
  // Fall back to the legacy readline REPL for callers that haven't migrated
  // (used only by existing tests — production wiring in cli.ts→commands/agent.ts
  // always passes the new fields).
  await runInteractiveLegacy(args);
}

async function runInteractiveLegacy(args: {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  systemPrompt: string;
  cfg: AgentConfig;
  logger: AgentLogger;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}): Promise<void> {
  const { model, tools, systemPrompt, cfg, logger } = args;
  const stdin = args.stdin ?? process.stdin;
  const stdout = args.stdout ?? process.stdout;

  let checkpointer = new MemorySaver();
  let threadId = `outlook-agent-${process.pid}-${Date.now()}`;
  let graph = createAgentGraph({
    model,
    tools,
    systemPrompt,
    checkpointer,
  });

  const { provider, model: modelId } = describeModel(model);
  const banner = `Outlook agent (provider=${provider} model=${modelId || cfg.model || 'unknown'}). Type /exit to quit, /reset to start a new thread.\n`;
  stdout.write(banner);

  // Use classic event-based readline: it works reliably with generic streams
  // (PassThrough in tests, process.stdin in production). The promise-based
  // `rl.question` API does not emit 'line' events dependably on non-TTY
  // streams, so we roll our own line queue on top of the event API.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const readline = require('node:readline') as typeof import('node:readline');
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: false,
  });

  // Line queue + waiter — resolves promises as lines arrive or as the input
  // stream closes (EOF).
  const lineQueue: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;
  const onLine = (ln: string) => {
    if (waiters.length > 0) {
      const w = waiters.shift()!;
      w(ln);
    } else {
      lineQueue.push(ln);
    }
  };
  const onClose = () => {
    closed = true;
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      w(null);
    }
  };
  rl.on('line', onLine);
  rl.on('close', onClose);

  function nextLine(): Promise<string | null> {
    if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift()!);
    if (closed) return Promise.resolve(null);
    stdout.write('> ');
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    try {
      rl.close();
    } catch {
      /* ignore */
    }
  };
  process.once('SIGINT', onSigint);

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const line = await nextLine();
      if (line == null) break;
      if (interrupted) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === '/exit' || trimmed === '/quit') break;
      if (trimmed === '/reset') {
        checkpointer = new MemorySaver();
        threadId = `outlook-agent-${process.pid}-${Date.now()}`;
        graph = createAgentGraph({
          model,
          tools,
          systemPrompt,
          checkpointer,
        });
        stdout.write('(thread reset)\n');
        continue;
      }

      logger.info('agent.repl.turn', { promptLen: trimmed.length });
      try {
        const state = (await graph.invoke(
          { messages: [{ role: 'user', content: trimmed }] },
          {
            configurable: { thread_id: threadId },
            recursionLimit: cfg.maxSteps,
          },
        )) as { messages?: unknown[] };
        const walked = walkMessages(
          Array.isArray(state.messages) ? state.messages : [],
        );
        for (const s of walked.steps) logger.step(s);
        const answer = walked.answer || '(no final answer)';
        stdout.write(answer + '\n');
      } catch (err) {
        if (isRecursionLimitError(err)) {
          stdout.write(
            `(step limit ${cfg.maxSteps} reached — try /reset and rephrase)\n`,
          );
          logger.warn('agent.repl.recursion-limit', { maxSteps: cfg.maxSteps });
        } else {
          const msg = (err as { message?: string }).message ?? String(err);
          logger.error('agent.repl.error', { message: msg });
          stdout.write(`(error: ${msg})\n`);
        }
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    rl.off('line', onLine);
    rl.off('close', onClose);
    try {
      rl.close();
    } catch {
      /* ignore */
    }
    if (interrupted) {
      // Exit with the conventional SIGINT code.
      process.exit(130);
    }
  }
}
