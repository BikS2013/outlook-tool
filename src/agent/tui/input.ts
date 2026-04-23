// src/agent/tui/input.ts — raw-mode line editor for the Agent TUI.
//
// Implements the keyboard state machine documented in spec §5 and design
// §TUI.5 (categories A–F). Pure helpers (`replaceInput`, `insertNewline`,
// `handleBackspace`, `redrawCurrentLine`) are exported for the unit-test
// seams listed in §TUI.11 — they perform no stdio access. The stdio side
// (raw mode, stdin/stdout writes, listener lifecycle) lives inside the
// `readInput` closure and is restored on every resolve / reject path.

import { StringDecoder } from "node:string_decoder";

import { CLEAR_LINE } from "./ansi";

// ---------- public types ----------

export interface EditorState {
  lines: string[]; // each line without trailing \n
  cursorRow: number; // 0-based
  cursorCol: number; // 0-based, in characters (not display width)
}

// ---------- pure helpers ----------

/**
 * Replace the editor buffer with `newLines`. Cursor lands at the end of
 * the last line. An empty array normalizes to `[""]` so the buffer is
 * never zero-length (the rest of the editor assumes at least one row).
 */
export function replaceInput(
  _state: EditorState,
  newLines: string[],
): EditorState {
  const lines = newLines.length === 0 ? [""] : [...newLines];
  const last = lines[lines.length - 1];
  return {
    lines,
    cursorRow: lines.length - 1,
    cursorCol: last.length,
  };
}

/**
 * Split the current line at the cursor column. The cursor lands at
 * col 0 on the newly-inserted next row.
 */
export function insertNewline(state: EditorState): EditorState {
  const { lines, cursorRow, cursorCol } = state;
  const cur = lines[cursorRow];
  const before = cur.slice(0, cursorCol);
  const after = cur.slice(cursorCol);
  const newLines = [
    ...lines.slice(0, cursorRow),
    before,
    after,
    ...lines.slice(cursorRow + 1),
  ];
  return { lines: newLines, cursorRow: cursorRow + 1, cursorCol: 0 };
}

/**
 * Backspace semantics:
 *   - At col > 0: delete the character immediately before the cursor.
 *   - At col 0, row > 0: merge with the previous line; cursor lands at
 *     the previous line's old EOL.
 *   - At row 0, col 0: no-op (returns the same state object).
 */
export function handleBackspace(state: EditorState): EditorState {
  const { lines, cursorRow, cursorCol } = state;
  if (cursorCol > 0) {
    const cur = lines[cursorRow];
    const newCur = cur.slice(0, cursorCol - 1) + cur.slice(cursorCol);
    const newLines = [...lines];
    newLines[cursorRow] = newCur;
    return { lines: newLines, cursorRow, cursorCol: cursorCol - 1 };
  }
  if (cursorRow === 0) return state;
  const prev = lines[cursorRow - 1];
  const cur = lines[cursorRow];
  const merged = prev + cur;
  const newLines = [
    ...lines.slice(0, cursorRow - 1),
    merged,
    ...lines.slice(cursorRow + 1),
  ];
  return { lines: newLines, cursorRow: cursorRow - 1, cursorCol: prev.length };
}

/**
 * Build the ANSI sequence that redraws a single line:
 *   \r\x1b[2K  +  prompt  +  line  +  (optional) cursor-left CSI.
 * The caller is responsible for writing the returned string and for
 * positioning the cursor on the correct terminal row beforehand.
 */
export function redrawCurrentLine(
  line: string,
  prompt: string,
  cursorCol: number,
): string {
  let out = CLEAR_LINE + prompt + line;
  const leftCols = line.length - cursorCol;
  if (leftCols > 0) out += `\x1b[${leftCols}D`;
  return out;
}

// ---------- word motion helpers (internal) ----------

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

function wordLeft(line: string, col: number): number {
  if (col <= 0) return 0;
  let i = col - 1;
  // Skip any trailing whitespace immediately to the left of the cursor.
  while (i > 0 && isSpace(line[i])) i--;
  // Walk back over the word itself.
  while (i > 0 && !isSpace(line[i - 1])) i--;
  return i;
}

function wordRight(line: string, col: number): number {
  const n = line.length;
  if (col >= n) return n;
  let i = col;
  // Walk over the current word.
  while (i < n && !isSpace(line[i])) i++;
  // Then over the trailing whitespace.
  while (i < n && isSpace(line[i])) i++;
  return i;
}

// ---------- main entry ----------

/**
 * Interactive line reader. Resolves with the joined buffer on Enter,
 * rejects with `Error("SIGINT")` on Ctrl+C, `Error("EOF")` on Ctrl+D
 * at an empty buffer, or `Error("NOT_A_TTY")` if stdin is not a TTY.
 *
 * `inputHistory` is mutated in place on a successful submit, suppressing
 * consecutive duplicates per spec §2.1.
 */
export function readInput(
  prompt: string,
  continuationPrompt: string,
  inputHistory: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("NOT_A_TTY"));
      return;
    }

    let state: EditorState = { lines: [""], cursorRow: 0, cursorCol: 0 };
    let historyIndex: number | null = null;
    let preHistoryLines: string[] | null = null;
    let escBuf: number[] = [];
    const stdout = process.stdout;
    let settled = false;
    // Multi-byte UTF-8 decoder — buffers partial sequences across bytes
    // AND across chunk boundaries. ASCII bytes pass through unchanged.
    const decoder = new StringDecoder("utf8");

    const promptFor = (row: number): string =>
      row === 0 ? prompt : continuationPrompt;

    const writePromptAndLine = (): void => {
      stdout.write(
        redrawCurrentLine(
          state.lines[state.cursorRow],
          promptFor(state.cursorRow),
          state.cursorCol,
        ),
      );
    };

    const finish = (ok: boolean, value?: string, err?: Error): void => {
      if (settled) return;
      settled = true;
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      } catch {
        // Ignore — stdin may already be closed.
      }
      process.stdin.pause();
      process.stdin.off("data", onData);
      stdout.write("\n");
      if (ok) resolve(value as string);
      else reject(err as Error);
    };

    // -------- escape-sequence dispatcher --------

    // Dispatch a known, fully-terminated escape sequence. Returns true iff
    // the sequence matched; false means it terminated but wasn't bound.
    const dispatchKnown = (seq: string): boolean => {
      switch (seq) {
        case "\x1b[A":
          upArrow();
          return true;
        case "\x1b[B":
          downArrow();
          return true;
        case "\x1b[C":
          rightArrow();
          return true;
        case "\x1b[D":
          leftArrow();
          return true;
        case "\x1b[H":
        case "\x1bOH":
        case "\x1b[1~":
          home();
          return true;
        case "\x1b[F":
        case "\x1bOF":
        case "\x1b[4~":
          end();
          return true;
        case "\x1b[1;3D":
        case "\x1b[1;5D":
          wordBack();
          return true;
        case "\x1b[1;3C":
        case "\x1b[1;5C":
          wordForward();
          return true;
        case "\x1b[1;9D":
        case "\x1b[1;2H":
          home();
          return true;
        case "\x1b[1;9C":
        case "\x1b[1;2F":
          end();
          return true;
        case "\x1b[3~":
          deleteKey();
          return true;
        case "\x1b[3;9~":
          delToStartOfLine();
          return true;
        case "\x1b[13;2u": // Kitty / Ghostty / iTerm2 (with CSI-u enabled)
        case "\x1bOM":      // legacy SS3 Enter on some terminals
        case "\x1b\r":      // Alt+Enter on macOS; Shift+Enter on many Linux terms
        case "\x1b\n":      // rare variant — ESC + LF
        case "\x1b[27;2;13~": // xterm with `modifyOtherKeys=2`
          doInsertNewline();
          return true;
        case "\x1bb":
          wordBack();
          return true;
        case "\x1bf":
          wordForward();
          return true;
        case "\x1b\x7f":
          wordDeleteBack();
          return true;
      }
      return false;
    };

    // Returns true when the accumulated buffer has been consumed (matched
    // or dropped as unknown-but-terminated) and should be cleared; false
    // when more bytes are expected.
    //
    // Correct framing for ANSI escapes:
    //   - `\x1b[...FINAL`  CSI — parameter/intermediate bytes, then a FINAL
    //                      byte in 0x40–0x7E. The `[` itself is the
    //                      introducer, NOT a terminator.
    //   - `\x1bO<key>`     SS3 — exactly 3 bytes total.
    //   - `\x1b<char>`     ESC-prefixed single char (Alt+x, Alt+Backspace)
    //                      — 2 bytes total.
    const tryHandleEscape = (seq: string): boolean => {
      if (seq.length < 2) return false; // just the lone ESC — wait.
      const second = seq.charCodeAt(1);
      if (second === 0x5b /* [ */) {
        // CSI — wait for a final byte at the end.
        if (seq.length < 3) return false;
        const last = seq.charCodeAt(seq.length - 1);
        if (last < 0x40 || last > 0x7e) return false; // still accumulating.
        // Terminated — dispatch (or drop silently if unbound).
        dispatchKnown(seq);
        return true;
      }
      if (second === 0x4f /* O */) {
        // SS3 — exactly one byte after the `O`.
        if (seq.length < 3) return false;
        dispatchKnown(seq.slice(0, 3));
        return true;
      }
      // Non-CSI/SS3 prefix: ESC + single char. Dispatch at length 2.
      dispatchKnown(seq.slice(0, 2));
      return true;
    };

    // -------- single-byte dispatcher --------

    const handleSingleByte = (b: number): void => {
      switch (b) {
        case 0x03:
          return finish(false, undefined, new Error("SIGINT"));
        case 0x04: {
          const empty =
            state.lines.length === 1 && state.lines[0] === "";
          if (empty) return finish(false, undefined, new Error("EOF"));
          return;
        }
        case 0x0d:
          return submit();
        case 0x0a:
          return doInsertNewline();
        case 0x7f:
        case 0x08:
          return doBackspace();
        case 0x01:
          state = { ...state, cursorCol: 0 };
          writePromptAndLine();
          return;
        case 0x05:
          state = {
            ...state,
            cursorCol: state.lines[state.cursorRow].length,
          };
          writePromptAndLine();
          return;
        case 0x0b:
          return deleteToEnd();
        case 0x15:
          return deleteToStart();
        case 0x17:
          return wordDeleteBack();
      }
      // Printable byte — push through the UTF-8 decoder. ASCII returns
      // immediately; multi-byte characters (Greek, emoji, CJK, …) buffer
      // until the continuation bytes arrive, possibly across chunks.
      if (b >= 0x20) {
        const ch = decoder.write(Buffer.from([b]));
        if (ch.length > 0) insertChar(ch);
      }
    };

    // -------- mutators (all re-render the current line) --------

    function insertChar(ch: string): void {
      const cur = state.lines[state.cursorRow];
      const newCur =
        cur.slice(0, state.cursorCol) + ch + cur.slice(state.cursorCol);
      const lines = [...state.lines];
      lines[state.cursorRow] = newCur;
      state = {
        lines,
        cursorRow: state.cursorRow,
        cursorCol: state.cursorCol + ch.length,
      };
      writePromptAndLine();
    }

    function doInsertNewline(): void {
      state = insertNewline(state);
      stdout.write("\n");
      writePromptAndLine();
    }

    function doBackspace(): void {
      const before = state;
      state = handleBackspace(state);
      if (state === before) return; // no-op at row 0, col 0
      if (state.cursorRow < before.cursorRow) {
        // Merged with the previous line — move terminal cursor up and
        // redraw the (now merged) line at the correct row.
        stdout.write("\x1b[A");
      }
      writePromptAndLine();
    }

    function submit(): void {
      const value = state.lines.join("\n");
      if (
        value !== "" &&
        inputHistory[inputHistory.length - 1] !== value
      ) {
        inputHistory.push(value);
      }
      finish(true, value);
    }

    // -------- arrow motion / history --------

    function upArrow(): void {
      if (state.cursorRow > 0) {
        const targetRow = state.cursorRow - 1;
        state = {
          ...state,
          cursorRow: targetRow,
          cursorCol: Math.min(state.cursorCol, state.lines[targetRow].length),
        };
        stdout.write("\x1b[A");
        writePromptAndLine();
        return;
      }
      if (inputHistory.length === 0) return;
      if (historyIndex === null) {
        preHistoryLines = [...state.lines];
        historyIndex = inputHistory.length;
      }
      if (historyIndex <= 0) return;
      historyIndex -= 1;
      const entry = inputHistory[historyIndex];
      state = replaceInput(state, entry.split("\n"));
      writePromptAndLine();
    }

    function downArrow(): void {
      if (state.cursorRow < state.lines.length - 1) {
        const targetRow = state.cursorRow + 1;
        state = {
          ...state,
          cursorRow: targetRow,
          cursorCol: Math.min(state.cursorCol, state.lines[targetRow].length),
        };
        stdout.write("\x1b[B");
        writePromptAndLine();
        return;
      }
      if (historyIndex === null) return;
      historyIndex += 1;
      if (historyIndex >= inputHistory.length) {
        historyIndex = null;
        state = replaceInput(state, preHistoryLines ?? [""]);
        preHistoryLines = null;
      } else {
        const entry = inputHistory[historyIndex];
        state = replaceInput(state, entry.split("\n"));
      }
      writePromptAndLine();
    }

    function leftArrow(): void {
      if (state.cursorCol > 0) {
        state = { ...state, cursorCol: state.cursorCol - 1 };
        writePromptAndLine();
      }
      // At col 0 we do NOT wrap to the previous line — multi-line left-
      // wrap is out of scope for the simplified redraw model.
    }

    function rightArrow(): void {
      if (state.cursorCol < state.lines[state.cursorRow].length) {
        state = { ...state, cursorCol: state.cursorCol + 1 };
        writePromptAndLine();
      }
    }

    function home(): void {
      state = { ...state, cursorCol: 0 };
      writePromptAndLine();
    }

    function end(): void {
      state = {
        ...state,
        cursorCol: state.lines[state.cursorRow].length,
      };
      writePromptAndLine();
    }

    function wordBack(): void {
      state = {
        ...state,
        cursorCol: wordLeft(state.lines[state.cursorRow], state.cursorCol),
      };
      writePromptAndLine();
    }

    function wordForward(): void {
      state = {
        ...state,
        cursorCol: wordRight(state.lines[state.cursorRow], state.cursorCol),
      };
      writePromptAndLine();
    }

    function deleteKey(): void {
      const cur = state.lines[state.cursorRow];
      if (state.cursorCol < cur.length) {
        const newCur =
          cur.slice(0, state.cursorCol) + cur.slice(state.cursorCol + 1);
        const lines = [...state.lines];
        lines[state.cursorRow] = newCur;
        state = { ...state, lines };
        writePromptAndLine();
        return;
      }
      if (state.cursorRow < state.lines.length - 1) {
        const nxt = state.lines[state.cursorRow + 1];
        const lines = [...state.lines];
        lines[state.cursorRow] = cur + nxt;
        lines.splice(state.cursorRow + 1, 1);
        state = { ...state, lines };
        writePromptAndLine();
      }
    }

    function delToStartOfLine(): void {
      const cur = state.lines[state.cursorRow];
      const lines = [...state.lines];
      lines[state.cursorRow] = cur.slice(state.cursorCol);
      state = { ...state, lines, cursorCol: 0 };
      writePromptAndLine();
    }

    function deleteToEnd(): void {
      const cur = state.lines[state.cursorRow];
      const lines = [...state.lines];
      lines[state.cursorRow] = cur.slice(0, state.cursorCol);
      state = { ...state, lines };
      writePromptAndLine();
    }

    function deleteToStart(): void {
      // Ctrl+U — identical semantics to Cmd+Backspace per §TUI.5.
      delToStartOfLine();
    }

    function wordDeleteBack(): void {
      const cur = state.lines[state.cursorRow];
      const newCol = wordLeft(cur, state.cursorCol);
      if (newCol === state.cursorCol) return;
      const newCur = cur.slice(0, newCol) + cur.slice(state.cursorCol);
      const lines = [...state.lines];
      lines[state.cursorRow] = newCur;
      state = { ...state, lines, cursorCol: newCol };
      writePromptAndLine();
    }

    // -------- byte pump --------

    const onData = (buf: Buffer): void => {
      for (let i = 0; i < buf.length; i++) {
        if (settled) return;
        const b = buf[i];
        if (escBuf.length > 0) {
          escBuf.push(b);
          if (escBuf.length > 10) {
            // §TUI.5 category F: discard an over-long escape buffer and
            // return to normal input mode.
            escBuf = [];
            continue;
          }
          const seq = String.fromCharCode(...escBuf);
          const consumed = tryHandleEscape(seq);
          if (consumed) escBuf = [];
          continue;
        }
        if (b === 0x1b) {
          escBuf = [b];
          continue;
        }
        handleSingleByte(b);
      }
    };

    // -------- install --------

    try {
      process.stdin.setRawMode(true);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    process.stdin.resume();
    process.stdin.on("data", onData);
    stdout.write(prompt);
  });
}
