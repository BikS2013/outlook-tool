// src/agent/tui/commands/new-thread.ts
//
// `/new` (alias `/reset`) handler — starts a new conversation thread.
// See docs/design/project-design.md §TUI.8.
//
// Rejects when a turn is in flight — the user must ESC / Ctrl+C
// first. LangGraph consults `thread_id` per-call, so no graph rebuild
// is required.

import type { DispatchResult, TuiContext } from "../types";

/**
 * Cheap, monotonic-ish thread-id generator. Exported so `/model` uses
 * the same scheme when it resets the thread on switch/reset.
 *
 * Not cryptographically random, not a UUID — just unique-enough for a
 * single interactive session. Collisions would require two concurrent
 * processes creating an id in the same millisecond AND drawing the
 * same 48-bit suffix from `Math.random`.
 */
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function handleNewThread(
  ctx: TuiContext,
): Promise<DispatchResult> {
  if (ctx.isRunning) {
    ctx.printSystem(
      "cannot start a new thread while a turn is in flight",
      "error",
    );
    return { handled: true };
  }
  ctx.threadId = generateId();
  ctx.messages = [];
  ctx.inputHistory.length = 0;
  ctx.lastRawResponse = "";
  ctx.printSystem(`started new thread ${ctx.threadId.slice(0, 8)}`);
  return { handled: true, resetThread: true };
}
