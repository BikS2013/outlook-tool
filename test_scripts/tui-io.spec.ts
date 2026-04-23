// test_scripts/tui-io.spec.ts
//
// Unit tests for src/agent/tui/io.ts — stderr/stdout helpers with
// module-level quiet + header state. See design §TUI.11.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  printSystem,
  printAgentHeader,
  resetAgentHeader,
  isAgentHeaderPrinted,
  setQuiet,
} from "../src/agent/tui/io";

describe("printSystem", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as unknown as typeof process.stderr.write);
    // Reset quiet state to the default each test so ordering does not matter.
    setQuiet(false);
  });

  afterEach(() => {
    setQuiet(false);
    vi.restoreAllMocks();
  });

  it("writes to process.stderr including a [system] label and the message", () => {
    printSystem("hello");
    expect(errSpy).toHaveBeenCalledTimes(1);
    const out = errSpy.mock.calls[0][0] as string;
    expect(out).toContain("[system]");
    expect(out).toContain("hello");
  });

  it("info kind is suppressed when setQuiet(true) is active", () => {
    setQuiet(true);
    printSystem("hidden info", "info");
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("error kind is NEVER suppressed by setQuiet(true)", () => {
    setQuiet(true);
    printSystem("boom", "error");
    expect(errSpy).toHaveBeenCalledTimes(1);
    const out = errSpy.mock.calls[0][0] as string;
    expect(out).toContain("[error]");
    expect(out).toContain("boom");
  });

  it("warn kind is NEVER suppressed by setQuiet(true)", () => {
    setQuiet(true);
    printSystem("careful", "warn");
    expect(errSpy).toHaveBeenCalledTimes(1);
    const out = errSpy.mock.calls[0][0] as string;
    expect(out).toContain("[warn]");
    expect(out).toContain("careful");
  });

  it("after setQuiet(false), info prints again", () => {
    setQuiet(true);
    printSystem("silenced", "info");
    expect(errSpy).not.toHaveBeenCalled();

    setQuiet(false);
    printSystem("speaking", "info");
    expect(errSpy).toHaveBeenCalledTimes(1);
    const out = errSpy.mock.calls[0][0] as string;
    expect(out).toContain("speaking");
  });
});

describe("agent header state machine", () => {
  let outSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as unknown as typeof process.stdout.write);
    resetAgentHeader();
  });

  afterEach(() => {
    resetAgentHeader();
    vi.restoreAllMocks();
  });

  it("resetAgentHeader() sets isAgentHeaderPrinted() to false", () => {
    resetAgentHeader();
    expect(isAgentHeaderPrinted()).toBe(false);
  });

  it("first printAgentHeader(true) writes the bold cyan 'Agent ' with trailing space to stdout", () => {
    printAgentHeader(true);
    expect(outSpy).toHaveBeenCalledTimes(1);
    const out = outSpy.mock.calls[0][0] as string;
    // Bold + cyan wrapping the word "Agent", followed by a single trailing space.
    expect(out).toContain("Agent");
    expect(out).toContain("\x1b[1m"); // BOLD
    expect(out).toContain("\x1b[36m"); // CYAN
    expect(out.endsWith("Agent\x1b[0m ")).toBe(true);
    expect(isAgentHeaderPrinted()).toBe(true);
  });

  it("printAgentHeader(false) writes 'Agent' without a trailing space", () => {
    printAgentHeader(false);
    expect(outSpy).toHaveBeenCalledTimes(1);
    const out = outSpy.mock.calls[0][0] as string;
    expect(out).toContain("Agent");
    expect(out.endsWith("Agent\x1b[0m")).toBe(true);
    expect(isAgentHeaderPrinted()).toBe(true);
  });

  it("second printAgentHeader() after the first writes nothing; flag stays true", () => {
    printAgentHeader(true);
    expect(outSpy).toHaveBeenCalledTimes(1);
    expect(isAgentHeaderPrinted()).toBe(true);

    printAgentHeader(true);
    // Still only one call — the guard blocked the second print.
    expect(outSpy).toHaveBeenCalledTimes(1);
    expect(isAgentHeaderPrinted()).toBe(true);
  });

  it("after resetAgentHeader() the next call prints again", () => {
    printAgentHeader(true);
    expect(outSpy).toHaveBeenCalledTimes(1);

    resetAgentHeader();
    expect(isAgentHeaderPrinted()).toBe(false);

    printAgentHeader(true);
    expect(outSpy).toHaveBeenCalledTimes(2);
    expect(isAgentHeaderPrinted()).toBe(true);
  });
});
