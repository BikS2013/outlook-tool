// src/agent/tui/io.ts

import { BOLD, CYAN, DIM, RED, RESET, YELLOW } from "./ansi";

let _quiet = false;
let _headerPrintedThisTurn = false;

export function setQuiet(q: boolean): void {
  _quiet = q;
}

export type PrintKind = "info" | "error" | "warn";

/** Print a [system] line to stderr. Honors --quiet for "info" kind only;
 *  errors and warnings are always printed. */
export function printSystem(line: string, kind: PrintKind = "info"): void {
  if (_quiet && kind === "info") return;
  const label =
    kind === "error"
      ? `${RED}[error]${RESET}`
      : kind === "warn"
        ? `${YELLOW}[warn]${RESET}`
        : `${DIM}${YELLOW}[system]${RESET}`;
  const msg = kind === "info" ? `${DIM}${line}${RESET}` : line;
  process.stderr.write(`${label} ${msg}\n`);
}

/** Print the "Agent" header to stdout exactly once per turn.
 *  Call `resetAgentHeader()` at turn start. */
export function printAgentHeader(trailingSpace = true): void {
  if (_headerPrintedThisTurn) return;
  _headerPrintedThisTurn = true;
  process.stdout.write(`${BOLD}${CYAN}Agent${RESET}${trailingSpace ? " " : ""}`);
}

export function resetAgentHeader(): void {
  _headerPrintedThisTurn = false;
}

export function isAgentHeaderPrinted(): boolean {
  return _headerPrintedThisTurn;
}
