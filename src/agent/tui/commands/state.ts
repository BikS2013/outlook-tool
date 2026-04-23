// src/agent/tui/commands/state.ts
//
// `/state` handler — calls `graph.getState` and prints a short
// summary (thread id, server-side message count, pending next nodes).
// See docs/design/project-design.md §TUI.8.

import type { DispatchResult, TuiContext } from "../types";

export async function handleState(ctx: TuiContext): Promise<DispatchResult> {
  try {
    const s = await ctx.graph.getState({
      configurable: { thread_id: ctx.threadId },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values = (s as any)?.values;
    const msgs = values && Array.isArray(values.messages) ? values.messages : [];
    ctx.printSystem(`threadId: ${ctx.threadId}`);
    ctx.printSystem(`messages (server-side): ${msgs.length}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const next = (s as any)?.next;
    if (Array.isArray(next) && next.length > 0) {
      ctx.printSystem(`next nodes: ${next.join(", ")}`);
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    ctx.printSystem(`failed to read state: ${msg}`, "error");
  }
  return { handled: true };
}
