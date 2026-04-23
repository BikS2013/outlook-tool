// src/agent/tui/turn.ts
//
// Unit U8 — the per-turn execution loop.
//
// `runTurn()` drives one user->agent round trip:
//   1. starts a spinner,
//   2. iterates `ctx.graph.streamEvents(...)` with a per-turn AbortController,
//   3. dispatches each stream event (chat-model chunk, tool start, tool end),
//   4. gracefully handles ESC/Ctrl+C (abort) and unexpected errors,
//   5. renders the post-stream epilogue (interrupted / error / no-content
//      / plain newline) to stdout.
//
// Contract:
//   - `runTurn` NEVER throws. Every exit path returns a `TurnResult`.
//   - When the optional `handlers` parameter is supplied, ALL rendering is
//     delegated to the handlers and no direct stdout writes are produced.
//   - `ctx.lastRawResponse` is always updated to the accumulated agent text
//     (including on error or abort) per spec §TUI.14.6.

import { DIM, RED, RESET, YELLOW } from "./ansi";
import { isAgentHeaderPrinted, printAgentHeader, resetAgentHeader } from "./io";
import { createSpinner } from "./spinner";
import type {
  AgentStreamEvent,
  SpinnerHandle,
  TurnEventHandlers,
  TurnResult,
  TuiContext,
} from "./types";

// Project redact helper — fall back to identity if the module is ever moved.
// Using dynamic require keeps tsc happy even if the path resolves to
// something that doesn't export `redactString`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let redactString: (s: string) => string;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const mod = require("../../util/redact") as { redactString?: unknown };
  redactString =
    typeof mod.redactString === "function"
      ? (mod.redactString as (s: string) => string)
      : (s: string): string => s;
} catch {
  redactString = (s: string): string => s;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract plain text from a stream chunk's `content` field.
 *  Mirrors `extractContentText` in `src/agent/run.ts` — supports string,
 *  `{ text: string }`, or an array of either. */
function extractContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object" && "text" in (p as object)) {
          const t = (p as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .join("");
  }
  if (c && typeof c === "object" && "text" in (c as object)) {
    const t = (c as { text?: unknown }).text;
    return typeof t === "string" ? t : "";
  }
  return "";
}

interface DispatchStash {
  readonly spinner: SpinnerHandle;
  readonly handlers?: TurnEventHandlers;
  readonly agentText: { value: string };
}

function dispatchEvent(ev: AgentStreamEvent, stash: DispatchStash): void {
  switch (ev.event) {
    case "on_chat_model_stream": {
      const chunkRaw = ev.data?.chunk?.content;
      const chunk = extractContent(chunkRaw);
      if (chunk.length === 0) return;
      stash.spinner.stop();
      if (stash.handlers) {
        stash.handlers.onChatModelStream(chunk);
      } else {
        printAgentHeader(true); // trailing space
        process.stdout.write(chunk);
      }
      stash.agentText.value += chunk;
      return;
    }
    case "on_tool_start": {
      const name = ev.name ?? "unknown";
      stash.spinner.stop();
      if (stash.handlers) {
        stash.handlers.onToolStart(name);
      } else {
        if (!isAgentHeaderPrinted()) {
          printAgentHeader(false); // no trailing space (spec §6)
        }
        process.stdout.write(`\n  ↳ calling ${name}(...)`);
      }
      return;
    }
    case "on_tool_end": {
      const name = ev.name ?? "";
      if (stash.handlers) {
        stash.handlers.onToolEnd(name);
      } else {
        process.stdout.write(" ✓");
      }
      stash.spinner.setLabel("Processing tool result...");
      stash.spinner.start();
      return;
    }
    default:
      // Every other event type is deliberately ignored.
      return;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runTurn(
  ctx: TuiContext,
  userText: string,
  handlers?: TurnEventHandlers,
): Promise<TurnResult> {
  resetAgentHeader();

  const stash: DispatchStash = {
    agentText: { value: "" },
    handlers,
    spinner: createSpinner("Thinking..."),
  };

  const abort = new AbortController();
  ctx.abortController = abort;
  ctx.isRunning = true;

  let aborted = false;
  let errored = false;
  let errorMessage: string | undefined;

  // Re-enter raw mode so we can detect ESC / Ctrl+C keystrokes during the
  // stream. `readInput` (U7) has already finished and restored cooked mode
  // by the time this runs.
  const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
  const wasRaw = stdin.isRaw ?? false;
  if (!wasRaw && stdin.isTTY) {
    try {
      stdin.setRawMode(true);
    } catch {
      /* non-TTY or permission issue — silently skip */
    }
  }
  stdin.resume();

  const escHandler = (buf: Buffer): void => {
    for (const b of buf) {
      if (b === 0x1b /* ESC */ || b === 0x03 /* Ctrl+C */) {
        abort.abort();
        break;
      }
    }
  };
  stdin.on("data", escHandler);

  stash.spinner.start();

  try {
    const iter = ctx.graph.streamEvents(
      { messages: [{ role: "user", content: userText }] },
      {
        version: "v2",
        configurable: { thread_id: ctx.threadId },
        signal: abort.signal,
        callbacks: [],
      },
    );
    for await (const ev of iter) {
      if (abort.signal.aborted) break;
      dispatchEvent(ev, stash);
    }
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (abort.signal.aborted || name === "AbortError") {
      aborted = true;
    } else {
      errored = true;
      const raw = (err as { message?: string })?.message ?? String(err);
      errorMessage = redactString(raw);
    }
  } finally {
    stash.spinner.stop();
    stdin.off("data", escHandler);
    if (!wasRaw) {
      if (stdin.isTTY) {
        try {
          stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
      }
      stdin.pause();
    }
    ctx.abortController = null;
    ctx.isRunning = false;
  }

  // Post-stream rendering — ONLY when no handlers override IO.
  if (!handlers) {
    if (aborted) {
      process.stdout.write(`\n${DIM}${YELLOW}[interrupted]${RESET}\n`);
    } else if (errored) {
      process.stdout.write(`\n${RED}[error]${RESET} ${errorMessage ?? ""}\n`);
    } else if (stash.agentText.value === "") {
      process.stdout.write(`\n${DIM}[no content]${RESET}\n`);
    } else {
      process.stdout.write("\n");
    }
  }

  // Always update lastRawResponse — even on error/abort (spec §TUI.14.6).
  ctx.lastRawResponse = stash.agentText.value;

  return {
    aborted,
    errored,
    errorMessage,
    agentText: stash.agentText.value,
  };
}
