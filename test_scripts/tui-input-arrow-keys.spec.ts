// test_scripts/tui-input-arrow-keys.spec.ts
//
// Regression: arrow keys used to be echoed as 'A'/'B'/'C'/'D' because the
// CSI introducer `\x1b[` was misidentified as a terminated escape sequence.
// This spec drives `readInput` against a mocked process.stdin (a PassThrough
// stream marked as a TTY) and asserts that ESC-prefixed keys never leak
// into the submitted input.

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInput } from "../src/agent/tui/input";

type StdinLike = PassThrough & {
  isTTY: boolean;
  setRawMode?: (b: boolean) => unknown;
};

function mockStdin(): StdinLike {
  const s = new PassThrough() as StdinLike;
  s.isTTY = true;
  s.setRawMode = () => s;
  return s;
}

describe("readInput — arrow-key framing (regression)", () => {
  let origStdin: typeof process.stdin;
  let origWrite: typeof process.stdout.write;
  let captured: string;

  beforeEach(() => {
    origStdin = process.stdin;
    const fake = mockStdin();
    Object.defineProperty(process, "stdin", {
      value: fake,
      configurable: true,
      writable: true,
    });
    captured = "";
    origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      captured += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    Object.defineProperty(process, "stdin", {
      value: origStdin,
      configurable: true,
      writable: true,
    });
    process.stdout.write = origWrite;
  });

  function drive(
    bytes: Buffer | number[],
    opts?: { delayMs?: number },
  ): Promise<string> {
    const history: string[] = [];
    const p = readInput("You> ", " .. ", history);
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const stdin = process.stdin as unknown as PassThrough;
    if (opts?.delayMs) {
      setTimeout(() => {
        stdin.emit("data", buf);
        stdin.emit("data", Buffer.from([0x0d])); // Enter
      }, opts.delayMs);
    } else {
      queueMicrotask(() => {
        stdin.emit("data", buf);
        stdin.emit("data", Buffer.from([0x0d])); // Enter
      });
    }
    return p;
  }

  it("↑ (\\x1b[A) alone submits an empty buffer (no 'A' leak)", async () => {
    const result = await drive([0x1b, 0x5b, 0x41]); // ESC [ A
    expect(result).toBe("");
  });

  it("↓ (\\x1b[B) alone submits an empty buffer (no 'B' leak)", async () => {
    const result = await drive([0x1b, 0x5b, 0x42]);
    expect(result).toBe("");
  });

  it("→ (\\x1b[C) alone submits an empty buffer (no 'C' leak)", async () => {
    const result = await drive([0x1b, 0x5b, 0x43]);
    expect(result).toBe("");
  });

  it("← (\\x1b[D) alone submits an empty buffer (no 'D' leak)", async () => {
    const result = await drive([0x1b, 0x5b, 0x44]);
    expect(result).toBe("");
  });

  it("SS3 Home (\\x1bOH) submits empty (no 'H' leak)", async () => {
    const result = await drive([0x1b, 0x4f, 0x48]);
    expect(result).toBe("");
  });

  it("\\x1b[3~ (Delete) submits empty (no '3' or '~' leak)", async () => {
    const result = await drive([0x1b, 0x5b, 0x33, 0x7e]);
    expect(result).toBe("");
  });

  it("\\x1b[1;5D (Ctrl+←) submits empty (no '1;5D' leak)", async () => {
    const result = await drive([0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x44]);
    expect(result).toBe("");
  });

  it("Alt+b (\\x1bb) submits empty — ESC+letter is a 2-byte key", async () => {
    const result = await drive([0x1b, 0x62]);
    expect(result).toBe("");
  });

  it("typing 'ab' then ↑ then 'c' submits 'abc' (history nav no-op on empty history)", async () => {
    const result = await drive([
      0x61, 0x62,             // 'a' 'b'
      0x1b, 0x5b, 0x41,       // ↑ (no history → no-op)
      0x63,                   // 'c'
    ]);
    expect(result).toBe("abc");
  });

  describe("Shift+Enter variants all insert a newline", () => {
    const cases: Array<[string, number[]]> = [
      ["\\x1b[13;2u (Kitty / Ghostty / iTerm2 CSI-u)", [0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x32, 0x75]],
      ["\\x1bOM (legacy SS3)", [0x1b, 0x4f, 0x4d]],
      ["\\x1b\\r (ESC + CR — Alt+Enter / some Shift+Enter)", [0x1b, 0x0d]],
      ["\\x1b\\n (ESC + LF)", [0x1b, 0x0a]],
      ["\\x1b[27;2;13~ (xterm modifyOtherKeys=2)", [0x1b, 0x5b, 0x32, 0x37, 0x3b, 0x32, 0x3b, 0x31, 0x33, 0x7e]],
    ];
    for (const [label, bytes] of cases) {
      it(label, async () => {
        const prefix = Buffer.from("ab");
        const suffix = Buffer.from("cd");
        const result = await drive(
          Buffer.concat([prefix, Buffer.from(bytes), suffix]),
        );
        expect(result).toBe("ab\ncd");
      });
    }
  });

  it("Ctrl+J (0x0A) alone inserts a newline — universal fallback", async () => {
    const result = await drive([0x61, 0x0a, 0x62]);
    expect(result).toBe("a\nb");
  });

  it("Greek text (Αναφορά) survives UTF-8 decoding byte-for-byte", async () => {
    // 'test Αναφορά' — UTF-8 bytes for the Greek letters each take 2 bytes.
    const bytes = Buffer.from("test Αναφορά", "utf8");
    const result = await drive(bytes);
    expect(result).toBe("test Αναφορά");
  });

  it("Emoji paste (😀 = 4-byte UTF-8) produces the correct char", async () => {
    const bytes = Buffer.from("😀", "utf8");
    const result = await drive(bytes);
    expect(result).toBe("😀");
  });

  it("UTF-8 continuation split across data chunks still decodes", async () => {
    const history: string[] = [];
    const p = readInput("You> ", " .. ", history);
    const stdin = process.stdin as unknown as PassThrough;
    // 'α' = 0xCE 0xB1 — deliver the leading byte first, continuation second.
    queueMicrotask(() => {
      stdin.emit("data", Buffer.from([0xce]));
      stdin.emit("data", Buffer.from([0xb1]));
      stdin.emit("data", Buffer.from([0x0d]));
    });
    const result = await p;
    expect(result).toBe("α");
  });

  it("Mixed ASCII + Greek + arrow — Greek stays intact, arrow is consumed", async () => {
    const bytes = Buffer.concat([
      Buffer.from("αβ", "utf8"),
      Buffer.from([0x1b, 0x5b, 0x44]), // ←  (consumed, no leak)
      Buffer.from("γ", "utf8"),
    ]);
    const result = await drive(bytes);
    // Cursor moved left by one before 'γ' — so final is α γ β.
    expect(result).toBe("αγβ");
  });

  it("split data event — ESC [ in one chunk, A in the next — still recognized", async () => {
    const history: string[] = [];
    const p = readInput("You> ", " .. ", history);
    const stdin = process.stdin as unknown as PassThrough;
    queueMicrotask(() => {
      stdin.emit("data", Buffer.from([0x1b, 0x5b])); // ESC [
      stdin.emit("data", Buffer.from([0x41]));       // A
      stdin.emit("data", Buffer.from([0x0d]));       // Enter
    });
    const result = await p;
    expect(result).toBe("");
  });
});
