// src/agent/tui/types.ts  (new file; co-locates shared types to avoid
// cyclic imports between index.ts, turn.ts, and commands/*.ts)

import type {
  AgentConfig,
  AgentConfigFlags,
  ProviderName,
} from "../../config/agent-config";
import type { AgentLogger } from "../logging";

export interface LocalMessage {
  readonly role: "user" | "agent";
  readonly text: string;
  readonly timestamp: number; // Date.now()
}

export interface SpinnerHandle {
  setLabel(s: string): void;
  start(): void;
  stop(): void;
  isActive(): boolean;
}

export interface MemoryStore {
  getEntries(): readonly string[];
  add(entry: string): void;
  remove(oneIndexed: number): void;   // throws RangeError if out of range
  clear(): void;
  readonly filePath: string;
}

export interface SavedModel {
  readonly version: 1;
  readonly provider: ProviderName;
  readonly model: string;
  readonly temperature?: number;
  readonly maxSteps?: number;
  readonly systemPromptFile?: string;
  /** User-entered `--flag` values keyed by canonical env-var name.
   *  Resolved-from-env defaults are NEVER written here. */
  readonly providerSpecific: Readonly<Record<string, string>>;
}

export interface ModelStore {
  load(): SavedModel | null;         // null on missing OR corrupt
  save(m: SavedModel): void;         // atomic write, mode 0600
  clear(): void;                     // rm (idempotent)
  readonly filePath: string;
}

export interface ClipboardResult {
  readonly ok: boolean;
  readonly tool?: string;            // "pbcopy" | "xclip" | "xsel" | "clip.exe"
  readonly reason?: string;          // populated when !ok
}

export type ReadInputResult = string; // rejected with Error("SIGINT") or Error("EOF")

export interface TurnEventHandlers {
  onChatModelStream(chunk: string): void;
  onToolStart(toolName: string): void;
  onToolEnd(toolName: string): void;
}

export interface TurnResult {
  readonly aborted: boolean;
  readonly errored: boolean;
  readonly errorMessage?: string;    // redacted
  readonly agentText: string;        // accumulated stream (may be "")
}

export interface DispatchResult {
  readonly handled: boolean;         // true = don't treat as agent turn
  readonly exit?: boolean;           // quit after this dispatch
  readonly resetThread?: boolean;    // new thread id + wipe messages/history
  readonly rebuildGraph?: boolean;   // recreate runnable from newModel/config
  readonly newModel?: SavedModel;    // passed up by /model success path
}

export interface ParsedSlash {
  readonly command: string;          // lowercase, no leading slash
  readonly args: readonly string[];  // tokens after command, quotes stripped
}

/** Structural subset of the runnable returned by `createAgent()` used by
 *  the TUI. Declared here — not imported — to avoid coupling to the
 *  langchain v1 type hierarchy. */
export interface AgentGraph {
  streamEvents(
    input: { messages: Array<{ role: string; content: string }> },
    opts: {
      version: "v2";
      configurable?: { thread_id?: string };
      signal?: AbortSignal;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callbacks?: readonly any[];
    },
  ): AsyncIterable<AgentStreamEvent>;
  getState(opts: {
    configurable: { thread_id: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<{ values?: any; next?: readonly string[] }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(input: any, opts?: any): Promise<any>;
}

export interface AgentStreamEvent {
  readonly event: string;
  readonly name?: string;
  readonly data?: {
    readonly chunk?: { readonly content?: unknown };
  };
}

/**
 * The runtime state bag threaded through the TUI main loop. Every field
 * is either readonly (swap-via-closure is not allowed) or explicitly
 * marked mutable (`messages`, `inputHistory`, `lastRawResponse`,
 * `threadId`, `isRunning`, `abortController`, `graph`, `cfg`).
 */
export interface TuiContext {
  cfg: AgentConfig;                          // swapped by /model
  graph: AgentGraph;                         // swapped by /model and /new
  threadId: string;                          // swapped by /new, /reset, /model
  messages: LocalMessage[];                  // cleared by /new
  inputHistory: string[];                    // cleared by /new
  lastRawResponse: string;                   // updated at end of each turn
  readonly logger: AgentLogger;
  readonly memoryStore: MemoryStore;
  readonly modelStore: ModelStore;
  isRunning: boolean;                        // true while a turn streams
  abortController: AbortController | null;   // non-null only during a turn
  readonly printSystem: (line: string, kind?: "info"|"error"|"warn") => void;
  /** Flags captured at `runTui` entry. Used by `/model reset` to rebuild
   *  the config from the original startup state (no saved-model file). */
  readonly startupFlags: AgentConfigFlags;
  /** Callback that recreates `ctx.graph` + swaps `ctx.cfg` from a new
   *  `AgentConfig`. Supplied by U9 (`runTui`). `/model` invokes it after
   *  saving the new `SavedModel` to disk. */
  readonly rebuildGraph: (cfg: AgentConfig) => Promise<void>;
}
