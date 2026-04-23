// src/agent/tui/commands/last.ts
//
// `/last` (alias `/raw`) handler — prints `ctx.lastRawResponse`
// verbatim to stdout (no ANSI stripping, no redaction).
// See docs/design/project-design.md §TUI.8.

import type { DispatchResult, TuiContext } from "../types";

export async function handleLast(ctx: TuiContext): Promise<DispatchResult> {
  if (ctx.lastRawResponse === "") {
    ctx.printSystem("no previous response");
  } else {
    process.stdout.write(`${ctx.lastRawResponse}\n`);
  }
  return { handled: true };
}
