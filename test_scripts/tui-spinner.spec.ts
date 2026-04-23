// test_scripts/tui-spinner.test.ts
//
// Unit tests for src/agent/tui/spinner.ts — the TUI's module-global
// single-active spinner. All timing is driven by vi.useFakeTimers().

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createSpinner,
  SPINNER_FRAMES,
  SPINNER_TICK_MS,
} from "../src/agent/tui/spinner";
import { CLEAR_LINE } from "../src/agent/tui/ansi";

describe("spinner constants", () => {
  it("SPINNER_FRAMES has 10 frames", () => {
    expect(SPINNER_FRAMES.length).toBe(10);
  });

  it("SPINNER_TICK_MS === 80", () => {
    expect(SPINNER_TICK_MS).toBe(80);
  });
});

describe("createSpinner", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as unknown as typeof process.stderr.write);
  });

  afterEach(() => {
    // Best-effort: stop any lingering spinners by restoring timers + mocks.
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns a handle with all four methods", () => {
    const h = createSpinner("Thinking...");
    expect(typeof h.start).toBe("function");
    expect(typeof h.stop).toBe("function");
    expect(typeof h.setLabel).toBe("function");
    expect(typeof h.isActive).toBe("function");
  });

  it("start() + advancing 3 ticks produces 4 renders (initial + 3 timer ticks)", () => {
    const h = createSpinner("Thinking...");
    h.start();
    // The initial render happens synchronously on start(). Each subsequent
    // TICK_MS advance triggers one more render.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SPINNER_TICK_MS * 3);
    expect(writeSpy).toHaveBeenCalledTimes(4);
    h.stop();
  });

  it("setLabel() while running causes the next render to include the new label", () => {
    const h = createSpinner("old");
    h.start();
    // Flush the initial render call.
    const initial = writeSpy.mock.calls[0][0] as string;
    expect(initial).toContain("old");

    h.setLabel("new");
    // setLabel renders synchronously while running — that's the second call.
    const afterSetLabel = writeSpy.mock.calls[1][0] as string;
    expect(afterSetLabel).toContain("new");
    expect(afterSetLabel).not.toContain("old");
    h.stop();
  });

  it("stop() writes CLEAR_LINE and halts the timer", () => {
    const h = createSpinner("x");
    h.start();
    const callsBeforeStop = writeSpy.mock.calls.length;

    h.stop();
    // After stop(), the final write is CLEAR_LINE exactly.
    const lastCall = writeSpy.mock.calls[writeSpy.mock.calls.length - 1][0];
    expect(lastCall).toBe(CLEAR_LINE);
    expect(writeSpy.mock.calls.length).toBe(callsBeforeStop + 1);

    // Advancing more time must not produce further writes.
    vi.advanceTimersByTime(SPINNER_TICK_MS * 5);
    expect(writeSpy.mock.calls.length).toBe(callsBeforeStop + 1);
  });

  it("isActive() is true between start/stop and false otherwise", () => {
    const h = createSpinner("x");
    expect(h.isActive()).toBe(false);
    h.start();
    expect(h.isActive()).toBe(true);
    h.stop();
    expect(h.isActive()).toBe(false);
  });

  it("starting a second spinner stops the first (module-global single-active)", () => {
    const a = createSpinner("a");
    const b = createSpinner("b");

    a.start();
    expect(a.isActive()).toBe(true);

    b.start();
    // The first handle should have been stopped as a side effect.
    expect(a.isActive()).toBe(false);
    expect(b.isActive()).toBe(true);

    b.stop();
  });
});
