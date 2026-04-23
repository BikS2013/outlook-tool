// test_scripts/tui-input-helpers.spec.ts
//
// Unit tests for the four pure helpers exported by src/agent/tui/input.ts:
//   - replaceInput
//   - insertNewline
//   - handleBackspace
//   - redrawCurrentLine
//
// These are pure functions (no stdio access) — covered as one of the
// test seams listed in design §TUI.11.

import { describe, it, expect } from "vitest";

import {
  replaceInput,
  insertNewline,
  handleBackspace,
  redrawCurrentLine,
  type EditorState,
} from "../src/agent/tui/input";
import { CLEAR_LINE } from "../src/agent/tui/ansi";

function makeState(
  lines: string[],
  cursorRow: number,
  cursorCol: number,
): EditorState {
  return { lines: [...lines], cursorRow, cursorCol };
}

describe("replaceInput", () => {
  it("replaces with a non-empty multi-line buffer and moves cursor to EOL of last row", () => {
    const before = makeState(["hello"], 0, 3);
    const out = replaceInput(before, ["abc", "defgh"]);
    expect(out.lines).toEqual(["abc", "defgh"]);
    expect(out.cursorRow).toBe(1); // last row
    expect(out.cursorCol).toBe(5); // length of "defgh"
  });

  it("empty array normalizes to [\"\"] with cursor at (0, 0)", () => {
    const before = makeState(["something"], 0, 4);
    const out = replaceInput(before, []);
    expect(out.lines).toEqual([""]);
    expect(out.cursorRow).toBe(0);
    expect(out.cursorCol).toBe(0);
  });

  it("single-line replace places cursor at end of that line", () => {
    const before = makeState(["prev line"], 0, 2);
    const out = replaceInput(before, ["hi"]);
    expect(out.lines).toEqual(["hi"]);
    expect(out.cursorRow).toBe(0);
    expect(out.cursorCol).toBe(2);
  });
});

describe("insertNewline", () => {
  it("splits the current line at the cursor; new cursor lands on next row col 0", () => {
    const before = makeState(["hello world"], 0, 5);
    const out = insertNewline(before);
    expect(out.lines).toEqual(["hello", " world"]);
    expect(out.cursorRow).toBe(1);
    expect(out.cursorCol).toBe(0);
  });

  it("cursor at EOL appends a blank line below; cursor moves to (row+1, 0)", () => {
    const before = makeState(["hello"], 0, 5);
    const out = insertNewline(before);
    expect(out.lines).toEqual(["hello", ""]);
    expect(out.cursorRow).toBe(1);
    expect(out.cursorCol).toBe(0);
  });

  it("cursor at col 0 inserts an empty line above; original line shifts to row+1", () => {
    const before = makeState(["hello"], 0, 0);
    const out = insertNewline(before);
    expect(out.lines).toEqual(["", "hello"]);
    expect(out.cursorRow).toBe(1);
    expect(out.cursorCol).toBe(0);
  });
});

describe("handleBackspace", () => {
  it("cursorCol > 0 deletes the char before the cursor and decrements col", () => {
    const before = makeState(["hello"], 0, 3);
    const out = handleBackspace(before);
    expect(out.lines).toEqual(["helo"]);
    expect(out.cursorRow).toBe(0);
    expect(out.cursorCol).toBe(2);
  });

  it("cursorCol 0 on row 0 is a no-op (returns the same state object)", () => {
    const before = makeState(["hello"], 0, 0);
    const out = handleBackspace(before);
    expect(out).toBe(before); // same reference — the implementation returns `state`
    expect(out.lines).toEqual(["hello"]);
    expect(out.cursorRow).toBe(0);
    expect(out.cursorCol).toBe(0);
  });

  it("cursorCol 0 on row > 0 merges the current line into the previous; cursor lands at old EOL of previous line", () => {
    const before = makeState(["foo", "bar"], 1, 0);
    const out = handleBackspace(before);
    expect(out.lines).toEqual(["foobar"]);
    expect(out.cursorRow).toBe(0);
    expect(out.cursorCol).toBe(3); // old EOL of "foo"
  });
});

describe("redrawCurrentLine", () => {
  it("starts with CLEAR_LINE (\\r\\x1b[2K) and includes the prompt + line", () => {
    const out = redrawCurrentLine("hello", "> ", 5);
    expect(out.startsWith(CLEAR_LINE)).toBe(true);
    expect(out).toContain("> ");
    expect(out).toContain("hello");
  });

  it("cursorCol < line.length appends \\x1b[<n>D where n = line.length - cursorCol", () => {
    const line = "hello"; // length 5
    const cursorCol = 2;
    const out = redrawCurrentLine(line, "> ", cursorCol);
    expect(out.endsWith(`\x1b[${line.length - cursorCol}D`)).toBe(true);
    // The full tail must be exactly the left-cursor CSI.
    expect(out).toBe(`${CLEAR_LINE}> hello\x1b[3D`);
  });

  it("cursorCol === line.length does NOT append a left-cursor sequence", () => {
    const out = redrawCurrentLine("hello", "> ", 5);
    // Should not contain a trailing "\x1b[NNND" with N > 0.
    expect(/\x1b\[\d+D$/.test(out)).toBe(false);
    expect(out).toBe(`${CLEAR_LINE}> hello`);
  });

  it("empty line and cursorCol 0 produces exactly CLEAR_LINE + prompt", () => {
    const out = redrawCurrentLine("", "> ", 0);
    expect(out).toBe(`${CLEAR_LINE}> `);
  });
});
