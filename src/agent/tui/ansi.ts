// src/agent/tui/ansi.ts — shared VT100 primitives.

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const GREEN = "\x1b[32m";
export const CYAN = "\x1b[36m";
export const YELLOW = "\x1b[33m";
export const RED = "\x1b[31m";

export const CLEAR_LINE = "\r\x1b[2K";
export const SAVE_CURSOR = "\x1b[s";
export const RESTORE_CURSOR = "\x1b[u";

const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}
