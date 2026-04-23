// src/agent/tui/commands/help.ts
//
// `/help` handler — prints the command table + keybindings summary in
// the dim "[system]" style (see `printSystem(line, "info")`). See
// docs/design/project-design.md §TUI.8.

import type { DispatchResult, TuiContext } from "../types";

const HELP_LINES: readonly string[] = [
  "Commands:",
  "  /help                    show this help panel",
  "  /history                 list local conversation (200-char truncated)",
  "  /state                   show agent server-side state (thread + counts)",
  "  /memory                  list persistent user instructions",
  "  /memory add <text>       append an instruction (applies to NEXT turn)",
  "  /memory remove <N>       remove the Nth instruction (1-indexed)",
  "  /memory clear            wipe all instructions",
  "  /new     (alias /reset)  start a new thread (fresh id + local history)",
  "  /last    (alias /raw)    print the raw last agent response",
  "  /copy                    copy last response to clipboard",
  "  /copy-all                copy full conversation to clipboard",
  "  /model                   show current LLM config (secrets masked)",
  "  /model <provider> [--flag value]*   switch LLM at runtime",
  "  /model reset             revert to env config, reset session",
  "  /monitor                 show monitoring summary (stub)",
  "  /quit    (alias /exit)   shut down cleanly",
  "",
  "Keybindings:",
  "  Enter                    send the current input",
  "  Shift+Enter / Ctrl+J     insert a newline in the input",
  "  ESC / Ctrl+C             abort an in-flight response",
  "  Up / Down                cycle through input history",
  "",
  "Note: `/memory add` entries are picked up on the NEXT turn — the",
  "current turn, if any, is unaffected.",
  "",
  "Shift+Enter troubleshooting: many terminals send plain `\\r` for both",
  "Enter and Shift+Enter by default, so the TUI can't distinguish them.",
  "Kitty/Ghostty work out of the box. For iTerm2, enable",
  '"Report modifiers using CSI u" in Preferences → Profiles → Keys. On',
  "any terminal, Ctrl+J is the universal fallback and always inserts a",
  "newline.",
];

export async function handleHelp(ctx: TuiContext): Promise<DispatchResult> {
  for (const line of HELP_LINES) {
    ctx.printSystem(line, "info");
  }
  return { handled: true };
}
