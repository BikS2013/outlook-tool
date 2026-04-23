// src/agent/tui/commands/copy.ts
//
// `/copy` and `/copy-all` handlers — shell out to `copyToClipboard`.
// See docs/design/project-design.md §TUI.8.

import { copyToClipboard } from "../clipboard";
import type { DispatchResult, TuiContext } from "../types";

function formatAll(ctx: TuiContext): string {
  return ctx.messages
    .map((m) => `${m.role === "user" ? "You" : "Agent"}: ${m.text}`)
    .join("\n\n");
}

export async function handleCopy(
  ctx: TuiContext,
  all: boolean,
): Promise<DispatchResult> {
  const text = all ? formatAll(ctx) : ctx.lastRawResponse;
  if (text === "") {
    ctx.printSystem("nothing to copy");
    return { handled: true };
  }
  const res = await copyToClipboard(text);
  if (res.ok) {
    ctx.printSystem(`copied to clipboard (via ${res.tool ?? "system"})`);
  } else {
    ctx.printSystem(
      res.reason ?? "clipboard not available on this platform",
      "error",
    );
  }
  return { handled: true };
}
