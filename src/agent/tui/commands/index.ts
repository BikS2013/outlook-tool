// src/agent/tui/commands/index.ts
//
// Slash-command dispatcher + tokenizer. See
// docs/design/project-design.md §TUI.8 / §TUI.9 and
// prompts/004-agent-tui-spec.md §2.3 / §9.

import type { DispatchResult, ParsedSlash, TuiContext } from "../types";
import { handleCopy } from "./copy";
import { handleHelp } from "./help";
import { handleHistory } from "./history";
import { handleLast } from "./last";
import { handleMemory } from "./memory";
import { handleModel } from "./model";
import { handleMonitor } from "./monitor";
import { handleNewThread } from "./new-thread";
import { handleQuit } from "./quit";
import { handleState } from "./state";

// Canonical tokenizer used by every command handler. Keeps double-quoted
// spans intact; all other whitespace separates tokens.
const TOKEN_RE = /(?:[^\s"]+|"[^"]*")/g;

function stripQuotes(t: string): string {
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parse a raw user input line into a `ParsedSlash` iff it starts with
 * a `/`. Returns `null` for non-slash lines (let the main loop treat
 * them as agent turns).
 */
export function parseSlashCommand(input: string): ParsedSlash | null {
  const s = input.trim();
  if (!s.startsWith("/")) return null;
  const tokens = s.match(TOKEN_RE) ?? [];
  const head = tokens[0];
  if (head === undefined) return null;
  const cmdToken = head.slice(1).toLowerCase(); // strip leading "/"
  if (cmdToken === "") return null;
  const args = tokens.slice(1).map(stripQuotes);
  return { command: cmdToken, args: Object.freeze(args) };
}

/**
 * Route a user input line to a slash-command handler. Returns
 * `{ handled: false }` when the line is not a slash command — the
 * caller should treat it as an agent turn.
 */
export async function dispatch(
  input: string,
  ctx: TuiContext,
): Promise<DispatchResult> {
  const parsed = parseSlashCommand(input);
  if (parsed === null) return { handled: false };
  switch (parsed.command) {
    case "help":
      return handleHelp(ctx);
    case "history":
      return handleHistory(ctx);
    case "state":
      return handleState(ctx);
    case "memory":
      return handleMemory(parsed.args, ctx);
    case "new":
    case "reset":
      return handleNewThread(ctx);
    case "last":
    case "raw":
      return handleLast(ctx);
    case "copy":
      return handleCopy(ctx, false);
    case "copy-all":
      return handleCopy(ctx, true);
    case "model":
      return handleModel(parsed.args, ctx);
    case "monitor":
      return handleMonitor(ctx);
    case "quit":
    case "exit":
      return handleQuit(ctx);
    default:
      ctx.printSystem(
        `unknown command: /${parsed.command} (try /help)`,
        "error",
      );
      return { handled: true };
  }
}
