// src/agent/tui/commands/monitor.ts
//
// `/monitor` handler — STUB. Built-in monitoring support is not yet
// wired up. See `Issues - Pending Items.md` and
// docs/design/project-design.md §TUI.8.

import type { DispatchResult, TuiContext } from "../types";

export async function handleMonitor(
  ctx: TuiContext,
): Promise<DispatchResult> {
  ctx.printSystem(
    "monitoring disabled (built-in monitoring not yet available). See Issues - Pending Items.md.",
  );
  return { handled: true };
}
