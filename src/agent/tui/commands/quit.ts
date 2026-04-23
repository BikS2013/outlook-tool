// src/agent/tui/commands/quit.ts
//
// `/quit` (alias `/exit`) handler. See docs/design/project-design.md §TUI.8.
//
// Shutdown sequence (strict order):
//   1. abort any in-flight turn, wait up to 500ms,
//   2. belt-and-braces: clear the current terminal line (spinner leftovers),
//   3. restore cooked mode + pause stdin,
//   4. close the logger,
//   5. print "goodbye" and return { handled: true, exit: true }.
//
// This handler does NOT call `process.exit(0)` — U9 (runTui) owns
// termination once it observes `exit: true` on the DispatchResult.

import { CLEAR_LINE } from "../ansi";
import type { DispatchResult, TuiContext } from "../types";

const ABORT_WAIT_MS = 500;

export async function handleQuit(ctx: TuiContext): Promise<DispatchResult> {
  // 1. Abort in-flight turn.
  if (ctx.isRunning && ctx.abortController) {
    try {
      ctx.abortController.abort();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ABORT_WAIT_MS);
    });
  }

  // 2. Clear any lingering spinner line.
  try {
    process.stderr.write(CLEAR_LINE);
  } catch {
    /* ignore — stderr may be closed in edge cases */
  }

  // 3. Restore cooked mode + pause stdin.
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  } catch {
    /* non-TTY or permission issue — ignore */
  }
  try {
    process.stdin.pause();
  } catch {
    /* ignore */
  }

  // 4. Close logger.
  try {
    await ctx.logger.close();
  } catch {
    /* logger close should not block shutdown */
  }

  ctx.printSystem("goodbye");
  return { handled: true, exit: true };
}
