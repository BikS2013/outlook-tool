// test_scripts/tui-clipboard.test.ts
//
// Unit tests for src/agent/tui/clipboard.ts — the cross-platform
// clipboard dispatcher. Uses an injected SpawnFn mock so no real
// child processes are ever created.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clipboardDispatch,
  detectTools,
  type SpawnFn,
} from "../src/agent/tui/clipboard";

// -----------------------------------------------------------------------------
// Helper: build a fake SpawnFn whose behavior is driven by a lookup table
// keyed by the command string. Each outcome is one of:
//   { kind: "success" }                             -> emits `close` with 0
//   { kind: "enoent" }                              -> emits `error` ENOENT
//   { kind: "exit",   code: number }                -> emits `close` with code
//   { kind: "syncThrow", err: NodeJS.ErrnoException } -> spawn itself throws
// Records every stdin.write / stdin.end call on `recorded`.
// -----------------------------------------------------------------------------

type Outcome =
  | { kind: "success" }
  | { kind: "enoent" }
  | { kind: "exit"; code: number }
  | { kind: "syncThrow"; err: NodeJS.ErrnoException };

interface RecordedCall {
  command: string;
  args: readonly string[];
  writes: string[];
  ended: boolean;
}

function buildMockSpawn(
  plan: Record<string, Outcome>,
): { spawn: SpawnFn; recorded: RecordedCall[] } {
  const recorded: RecordedCall[] = [];

  const spawn: SpawnFn = (command, args) => {
    const rec: RecordedCall = {
      command,
      args,
      writes: [],
      ended: false,
    };
    recorded.push(rec);

    const outcome = plan[command] ?? { kind: "enoent" };

    if (outcome.kind === "syncThrow") {
      throw outcome.err;
    }

    const handlers: {
      close?: (code: number) => void;
      error?: (err: NodeJS.ErrnoException) => void;
    } = {};

    const stdin = {
      write: (chunk: string) => {
        rec.writes.push(chunk);
      },
      end: () => {
        rec.ended = true;
        // After stdin closes, the "child" decides its fate asynchronously.
        setImmediate(() => {
          if (outcome.kind === "success" && handlers.close) {
            handlers.close(0);
          } else if (outcome.kind === "exit" && handlers.close) {
            handlers.close(outcome.code);
          } else if (outcome.kind === "enoent" && handlers.error) {
            const err = Object.assign(new Error("spawn ENOENT"), {
              code: "ENOENT",
            }) as NodeJS.ErrnoException;
            handlers.error(err);
          }
        });
      },
    };

    return {
      stdin,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      on(event: any, h: any) {
        if (event === "close") handlers.close = h;
        else if (event === "error") handlers.error = h;
      },
    } as unknown as ReturnType<SpawnFn>;
  };

  return { spawn, recorded };
}

// -----------------------------------------------------------------------------
// clipboardDispatch
// -----------------------------------------------------------------------------

describe("clipboardDispatch", () => {
  it("returns failure when every tool ENOENTs", async () => {
    const { spawn } = buildMockSpawn({
      // every command resolves to ENOENT by default
    });

    const result = await clipboardDispatch(
      "hello",
      ["pbcopy", "xclip", "xsel"],
      spawn,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("clipboard not available on this platform");
    expect(result.tool).toBeUndefined();
  });

  it("succeeds on the first tool when it exits 0 and records stdin writes", async () => {
    const { spawn, recorded } = buildMockSpawn({
      pbcopy: { kind: "success" },
    });

    const result = await clipboardDispatch("payload", ["pbcopy"], spawn);

    expect(result).toEqual({ ok: true, tool: "pbcopy" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].command).toBe("pbcopy");
    expect(recorded[0].args).toEqual([]);
    expect(recorded[0].writes).toEqual(["payload"]);
    expect(recorded[0].ended).toBe(true);
  });

  it("advances from first tool on ENOENT to second tool on success", async () => {
    const { spawn, recorded } = buildMockSpawn({
      xclip: { kind: "enoent" },
      xsel: { kind: "success" },
    });

    const result = await clipboardDispatch("payload", ["xclip", "xsel"], spawn);

    expect(result).toEqual({ ok: true, tool: "xsel" });
    expect(recorded.map((r) => r.command)).toEqual(["xclip", "xsel"]);
    // xsel's canonical argv
    expect(recorded[1].args).toEqual(["--clipboard", "--input"]);
    expect(recorded[1].writes).toEqual(["payload"]);
    expect(recorded[1].ended).toBe(true);
  });

  it("advances to next tool when first exits non-zero", async () => {
    const { spawn, recorded } = buildMockSpawn({
      xclip: { kind: "exit", code: 2 },
      xsel: { kind: "success" },
    });

    const result = await clipboardDispatch("payload", ["xclip", "xsel"], spawn);

    expect(result).toEqual({ ok: true, tool: "xsel" });
    expect(recorded.map((r) => r.command)).toEqual(["xclip", "xsel"]);
  });

  it("clip.exe ENOENT on linux retries /mnt/c/Windows/System32/clip.exe once", async () => {
    // Force platform to linux so the WSL fallback branch runs.
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    try {
      const { spawn, recorded } = buildMockSpawn({
        "clip.exe": { kind: "enoent" },
        "/mnt/c/Windows/System32/clip.exe": { kind: "success" },
      });

      const result = await clipboardDispatch("hi", ["clip.exe"], spawn);

      expect(result).toEqual({ ok: true, tool: "clip.exe" });
      expect(recorded.map((r) => r.command)).toEqual([
        "clip.exe",
        "/mnt/c/Windows/System32/clip.exe",
      ]);
      // Both invocations got the payload piped through.
      expect(recorded[0].writes).toEqual(["hi"]);
      expect(recorded[1].writes).toEqual(["hi"]);
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it("surfaces synchronous spawn failures as ENOENT and advances", async () => {
    const enoent = Object.assign(new Error("no bin"), {
      code: "ENOENT",
    }) as NodeJS.ErrnoException;

    const { spawn, recorded } = buildMockSpawn({
      xclip: { kind: "syncThrow", err: enoent },
      xsel: { kind: "success" },
    });

    const result = await clipboardDispatch("payload", ["xclip", "xsel"], spawn);

    expect(result).toEqual({ ok: true, tool: "xsel" });
    expect(recorded.map((r) => r.command)).toEqual(["xclip", "xsel"]);
  });
});

// -----------------------------------------------------------------------------
// detectTools (platform stubbing)
// -----------------------------------------------------------------------------

describe("detectTools", () => {
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    originalPlatform = process.platform;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", {
      value: p,
      configurable: true,
    });
  }

  it("returns [pbcopy] on darwin", () => {
    setPlatform("darwin");
    expect(detectTools()).toEqual(["pbcopy"]);
  });

  it("returns [clip.exe] on win32", () => {
    setPlatform("win32");
    expect(detectTools()).toEqual(["clip.exe"]);
  });

  it("returns [xclip, xsel] on linux without WSL markers", () => {
    setPlatform("linux");
    // Force /proc/version read to fail or return non-WSL content.
    // We can't mock `require("node:fs")` that's loaded lazily inside
    // detectTools; instead, cover both branches by stubbing fs.readFileSync
    // to return a generic Linux kernel string (no microsoft/wsl substring).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const spy = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation(
        ((p: fs.PathOrFileDescriptor, _enc?: unknown) => {
          if (typeof p === "string" && p === "/proc/version") {
            return "Linux version 6.1.0-generic" as unknown as string;
          }
          // Delegate to the real implementation for any other path read
          // (though none is expected during detectTools).
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }) as unknown as typeof fs.readFileSync,
      );

    try {
      expect(detectTools()).toEqual(["xclip", "xsel"]);
    } finally {
      spy.mockRestore();
    }
  });
});
