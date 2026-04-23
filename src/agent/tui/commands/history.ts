// src/agent/tui/commands/history.ts
//
// `/history` handler — prints `ctx.messages` truncated to 200 chars per
// entry. See docs/design/project-design.md §TUI.8.

import type { DispatchResult, LocalMessage, TuiContext } from "../types";

const MAX_LEN = 200;

function truncate(s: string): string {
  if (s.length <= MAX_LEN) return s;
  return `${s.slice(0, MAX_LEN)}…`;
}

function formatLine(m: LocalMessage): string {
  const who = m.role === "user" ? "you" : "agent";
  // Collapse runs of whitespace so multi-line messages stay on one row.
  const compact = m.text.replace(/\s+/g, " ").trim();
  return `${who}: ${truncate(compact)}`;
}

export async function handleHistory(ctx: TuiContext): Promise<DispatchResult> {
  if (ctx.messages.length === 0) {
    ctx.printSystem("(history is empty)");
    return { handled: true };
  }
  for (const m of ctx.messages) {
    ctx.printSystem(formatLine(m));
  }
  return { handled: true };
}
