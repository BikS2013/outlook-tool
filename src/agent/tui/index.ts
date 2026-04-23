// src/agent/tui/index.ts
//
// Unit U9 — the interactive TUI entry point (`runTui`). Wires together
// every other TUI unit: the raw-mode line editor (input.ts), the slash
// dispatcher (commands/*), the per-turn streaming loop (turn.ts), the
// on-disk memory + model stores (memory-store.ts, model-store.ts), and
// the ReAct graph (../graph.ts).
//
// Normative references:
//   - prompts/004-agent-tui-spec.md §2.5 (banner), §2.6 (error handling),
//     §8 (execution loop pseudocode), §10 (memory injection).
//   - docs/design/project-design.md §TUI.1 (architecture + invariants),
//     §TUI.3 (TuiContext), §TUI.10 (error matrix + unhandledRejection
//     allow-list).
//
// Invariants:
//   - NO direct reads of `process.env`. All config is derived via
//     `loadAgentConfig` through the provided `startupFlags`.
//   - NO `process.exit()`. Exit is surfaced via `process.exitCode` +
//     `return`; `/quit` handler returns `{ exit: true }` which breaks
//     the main loop.
//   - Banner goes to stderr, not stdout.

import { MemorySaver } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";

import {
  loadAgentConfig,
  type AgentConfig,
  type AgentConfigFlags,
  type ProviderName,
} from "../../config/agent-config";
import type { AgentLogger } from "../logging";
import { createAgentGraph } from "../graph";
import { loadSystemPrompt } from "../system-prompt";

import type {
  AgentGraph,
  LocalMessage,
  MemoryStore,
  TuiContext,
} from "./types";
import { createMemoryStore } from "./memory-store";
import { createModelStore } from "./model-store";
import { readInput } from "./input";
import { runTurn } from "./turn";
import { dispatch, parseSlashCommand } from "./commands";
import { generateId } from "./commands/new-thread";
import { printSystem } from "./io";
import { BOLD, DIM, GREEN, RESET } from "./ansi";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface RunTuiArgs {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  systemPrompt: string;
  cfg: AgentConfig;
  /** Flags captured by `commands/agent.ts` at CLI startup. Passed through
   *  to `loadAgentConfig` when a saved model overrides provider/model, and
   *  recorded on `TuiContext.startupFlags` so `/model reset` can rebuild
   *  from the original startup state. */
  startupFlags: AgentConfigFlags;
  logger: AgentLogger;
  /** Deps forwarded from CLI; used when `/model` triggers a graph rebuild.
   *  The CLI layer wraps `getProvider(cfg.provider)(cfg)` and
   *  `buildToolCatalog(deps, cfg)` respectively, so this file stays
   *  agnostic of `deps` from `commands/agent.ts`. */
  rebuildModel: (cfg: AgentConfig) => Promise<BaseChatModel>;
  rebuildTools: (cfg: AgentConfig) => StructuredToolInterface[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compose the effective system prompt by appending the user-memory
 * `<user-instructions>` block when entries are present. See spec §10.
 * Numbering is 1-based, matching `/memory list`.
 */
export function composeSystemPrompt(base: string, memStore: MemoryStore): string {
  const entries = memStore.getEntries();
  if (entries.length === 0) return base;
  const block = entries.map((e, i) => `${i + 1}. ${e}`).join("\n");
  return `${base}\n\n<user-instructions>\n${block}\n</user-instructions>`;
}

/** Human-friendly provider label for the banner. */
function providerDisplay(p: ProviderName): string {
  switch (p) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google";
    case "azure-openai":
      return "Azure OpenAI";
    case "azure-anthropic":
      return "Azure Anthropic";
    case "azure-deepseek":
      return "Azure DeepSeek";
  }
}

/** Banner — stderr, so it never contaminates stdout agent output. */
function printBanner(cfg: AgentConfig, threadId: string): void {
  const lines = [
    `${BOLD}Outlook Agent CLI (LangGraph)${RESET}`,
    `${DIM}LLM: ${providerDisplay(cfg.provider)} (${cfg.model})${RESET}`,
    `${DIM}Session: ${threadId.slice(0, 8)}${RESET}`,
    `${DIM}Commands: /history /memory /new /last /quit /help${RESET}`,
    `${DIM}Shift+Enter or Ctrl+J for newline, Enter to send${RESET}`,
  ];
  for (const l of lines) process.stderr.write(l + "\n");
}

/**
 * Attempt to load a saved model from disk. If present, returns a tuple of
 * the overridden config + freshly-built model + tools + effective system
 * prompt. Returns `null` when no valid saved model exists (caller keeps
 * the defaults from `args`).
 */
async function applySavedModel(
  args: RunTuiArgs,
): Promise<
  | {
      cfg: AgentConfig;
      model: BaseChatModel;
      tools: StructuredToolInterface[];
      systemPrompt: string;
    }
  | null
> {
  const store = createModelStore(args.cfg.modelFile);
  const saved = store.load();
  if (saved === null) return null;
  try {
    const overrideCfg = loadAgentConfig(args.startupFlags, {
      overrides: {
        provider: saved.provider,
        model: saved.model,
        temperature: saved.temperature,
        maxSteps: saved.maxSteps,
      },
      providerEnvOverrides: saved.providerSpecific,
    });
    const nextModel = await args.rebuildModel(overrideCfg);
    const nextTools = args.rebuildTools(overrideCfg);
    const nextPrompt = loadSystemPrompt(
      overrideCfg.systemPrompt,
      overrideCfg.systemPromptFile,
    );
    printSystem(`loaded saved model: ${saved.provider}/${saved.model}`);
    return {
      cfg: overrideCfg,
      model: nextModel,
      tools: nextTools,
      systemPrompt: nextPrompt,
    };
  } catch (err) {
    printSystem(
      `failed to load saved model — falling back to startup cfg: ${
        (err as Error).message
      }`,
      "warn",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// runTui
// ---------------------------------------------------------------------------

export async function runTui(args: RunTuiArgs): Promise<void> {
  // 1. TTY guard. `readInput` would reject with NOT_A_TTY, but failing
  //    early gives a cleaner error.
  if (!process.stdin.isTTY) {
    printSystem(
      "stdin is not a TTY — interactive mode requires a terminal",
      "error",
    );
    process.exitCode = 2;
    return;
  }

  // 2. Persistent stores (memory + model).
  const memoryStore = createMemoryStore(args.cfg.memoryFile);
  const modelStore = createModelStore(args.cfg.modelFile);

  // 3. Effective config/model/tools/prompt — may be replaced by a saved
  //    model on first launch.
  let effCfg: AgentConfig = args.cfg;
  let effModel: BaseChatModel = args.model;
  let effTools: StructuredToolInterface[] = args.tools;
  let effSystemPrompt: string = args.systemPrompt;

  const overridden = await applySavedModel(args);
  if (overridden !== null) {
    effCfg = overridden.cfg;
    effModel = overridden.model;
    effTools = overridden.tools;
    effSystemPrompt = overridden.systemPrompt;
  }

  // 4. Initial graph — every new graph gets its own MemorySaver.
  const initialGraph = createAgentGraph({
    model: effModel,
    tools: effTools,
    systemPrompt: composeSystemPrompt(effSystemPrompt, memoryStore),
    checkpointer: new MemorySaver(),
  });
  const threadId = generateId();

  // 5. Assemble TuiContext. The structural cast on `graph` is required
  //    because `createAgentGraph` delegates to `createAgent()` (LangChain
  //    v1) whose return type is widened; `TuiContext.graph` is the local
  //    structural `AgentGraph` subset declared in `types.ts`. At runtime
  //    the same object satisfies both.
  const ctx: TuiContext = {
    cfg: effCfg,
    graph: initialGraph as unknown as AgentGraph,
    threadId,
    messages: [] as LocalMessage[],
    inputHistory: [] as string[],
    lastRawResponse: "",
    logger: args.logger,
    memoryStore,
    modelStore,
    isRunning: false,
    abortController: null,
    printSystem,
    startupFlags: args.startupFlags,
    rebuildGraph: async (nextCfg: AgentConfig): Promise<void> => {
      const nextModel = await args.rebuildModel(nextCfg);
      const nextTools = args.rebuildTools(nextCfg);
      const base = loadSystemPrompt(
        nextCfg.systemPrompt,
        nextCfg.systemPromptFile,
      );
      effCfg = nextCfg;
      effModel = nextModel;
      effTools = nextTools;
      effSystemPrompt = base;
      const nextGraph = createAgentGraph({
        model: nextModel,
        tools: nextTools,
        systemPrompt: composeSystemPrompt(base, memoryStore),
        checkpointer: new MemorySaver(),
      });
      ctx.cfg = nextCfg;
      ctx.graph = nextGraph as unknown as AgentGraph;
    },
  };

  // 6. Banner (stderr).
  printBanner(effCfg, ctx.threadId);

  // 7. unhandledRejection allow-list — design §TUI.10. Two provider-
  //    specific transient errors are swallowed; anything else is re-
  //    thrown so Node's default handler can take over.
  const onUnhandled = (reason: unknown): void => {
    const maybeMsg =
      typeof reason === "string"
        ? reason
        : ((reason as { message?: string })?.message ?? "");
    const m = String(maybeMsg);
    const recoverable =
      m.includes("Error reading from the stream") ||
      m.includes("GoogleGenerativeAI");
    if (recoverable) {
      // AgentLogger has no debug level — warn is the closest sink that
      // still honors the redaction/quiet contract. The message is short
      // and already surfaced via stderr elsewhere, so this is fine.
      args.logger.warn("suppressed provider stream error", {
        msg: m.slice(0, 200),
      });
      return;
    }
    queueMicrotask(() => {
      throw reason;
    });
  };
  process.on("unhandledRejection", onUnhandled);

  const PROMPT = `${GREEN}You>${RESET} `;
  const CONT = `${GREEN} ..${RESET} `;

  // 8. Main loop.
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let line: string;
      try {
        line = await readInput(PROMPT, CONT, ctx.inputHistory);
      } catch (err) {
        const message = (err as Error).message ?? "";
        if (message === "SIGINT") {
          // Ctrl+C during input — cancel the current edit, loop around.
          process.stderr.write("\n");
          continue;
        }
        if (message === "EOF") {
          // Ctrl+D on empty input — exit cleanly.
          break;
        }
        if (message === "NOT_A_TTY") {
          printSystem("stdin is not a TTY — exiting", "error");
          process.exitCode = 2;
          return;
        }
        // Transient / unknown — log and continue.
        args.logger.error("readInput unexpected error", {
          name: (err as Error).name,
          message,
        });
        continue;
      }

      const trimmed = line.trim();
      if (trimmed === "") continue;

      // 8a. Slash command path.
      if (trimmed.startsWith("/")) {
        const parsed = parseSlashCommand(trimmed);
        const res = await dispatch(trimmed, ctx);
        if (res.exit === true) break;
        if (res.resetThread === true) {
          // `/new`, `/reset`, `/model` — handlers have already updated
          // `ctx.threadId`, and for `/model` the graph was rebuilt via
          // `ctx.rebuildGraph`. Nothing else to do here.
          continue;
        }
        // Special case: `/memory add|remove|clear` — rebuild the graph
        // so the NEXT turn picks up the new <user-instructions> block.
        // Thread id is preserved (memory edits don't warrant a new
        // thread; the user expects continuity). This uses a fresh
        // MemorySaver; checkpointed state of the current thread is
        // dropped, which is acceptable because memory edits happen
        // between turns.
        if (
          parsed !== null &&
          parsed.command === "memory" &&
          res.handled === true
        ) {
          try {
            const nextGraph = createAgentGraph({
              model: effModel,
              tools: effTools,
              systemPrompt: composeSystemPrompt(effSystemPrompt, memoryStore),
              checkpointer: new MemorySaver(),
            });
            ctx.graph = nextGraph as unknown as AgentGraph;
          } catch (err) {
            printSystem(
              `graph rebuild after /memory failed: ${(err as Error).message}`,
              "error",
            );
          }
        }
        continue;
      }

      // 8b. Agent turn.
      ctx.messages.push({
        role: "user",
        text: trimmed,
        timestamp: Date.now(),
      });
      const result = await runTurn(ctx, trimmed);
      if (!result.aborted && !result.errored && result.agentText !== "") {
        ctx.messages.push({
          role: "agent",
          text: result.agentText,
          timestamp: Date.now(),
        });
      }
    }
  } finally {
    // 9. Cleanup — belt-and-braces. `/quit` already did most of this,
    //    but the loop may exit via EOF or an exception. All operations
    //    are idempotent.
    process.off("unhandledRejection", onUnhandled);
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      /* ignore — stdin may already be closed */
    }
    process.stdin.pause();
  }
}
