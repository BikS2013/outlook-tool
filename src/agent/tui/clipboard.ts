/**
 * Agent TUI — clipboard adapter (Unit U2).
 *
 * Cross-platform clipboard-copy helper used by `/copy` and `/copy-all`
 * slash commands in the Agent TUI. Spawns one of the platform-appropriate
 * CLI clipboard tools (`pbcopy` on darwin, `clip.exe` on win32,
 * `xclip`/`xsel` on linux/bsd, with a WSL fallback to `clip.exe`), pipes
 * the requested text into its stdin, and resolves a `ClipboardResult`
 * describing which tool (if any) succeeded.
 *
 * Design references:
 *   - docs/design/project-design.md §TUI.2 (module catalogue) and
 *     §TUI.14 decision #11 (clip.exe detection fallback).
 *   - prompts/004-agent-tui-spec.md §2.3 and §13.
 *
 * The module intentionally never throws from `copyToClipboard` —
 * clipboard failures are reported as `{ ok: false, reason }` so the
 * command layer can degrade gracefully (e.g., print the text verbatim
 * so the user can select-copy manually).
 */

import { spawn as cpSpawn } from "node:child_process";

/**
 * Outcome of a clipboard-copy attempt.
 *
 * On success, `tool` identifies which CLI actually accepted the text
 * (`"pbcopy"`, `"xclip"`, `"xsel"`, or `"clip.exe"`). On failure,
 * `reason` carries a human-readable message suitable for stderr.
 */
export interface ClipboardResult {
  readonly ok: boolean;
  readonly tool?: string;
  readonly reason?: string;
}

/**
 * Minimal spawn contract the dispatcher relies on. Only the three
 * surfaces we actually drive are modeled — stdin piping, the `close`
 * event (exit code), and the `error` event (notably ENOENT when a
 * binary is not on PATH). Tests inject a fake implementation so the
 * real `node:child_process.spawn` is never invoked.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
) => {
  stdin: { write(chunk: string): void; end(): void };
  on(event: "close", handler: (code: number) => void): void;
  on(event: "error", handler: (err: NodeJS.ErrnoException) => void): void;
};

/**
 * Absolute path used as the final fallback for `clip.exe` under WSL
 * when the bare name is not resolvable via PATH.
 */
const WSL_CLIP_ABSOLUTE_PATH = "/mnt/c/Windows/System32/clip.exe";

/**
 * Returns the ordered list of clipboard CLIs to try on the current
 * platform. Exported so the test suite can exercise the detection
 * logic in isolation (the dispatcher itself accepts the list as a
 * parameter).
 *
 * Order of preference:
 *   - darwin  → `pbcopy`
 *   - win32   → `clip.exe`
 *   - linux/bsd/other → `xclip`, then `xsel`, plus `clip.exe` when
 *     running inside WSL (detected by scanning `/proc/version`).
 */
export function detectTools(): string[] {
  if (process.platform === "darwin") {
    return ["pbcopy"];
  }
  if (process.platform === "win32") {
    return ["clip.exe"];
  }
  // linux / freebsd / etc.
  const tools: string[] = [];
  tools.push("xclip");
  tools.push("xsel");
  // WSL detection — if /proc/version mentions Microsoft/WSL, add
  // clip.exe as a final fallback so users on WSL without an X server
  // still get their Windows clipboard populated.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const v = fs.readFileSync("/proc/version", "utf8").toLowerCase();
    if (v.includes("microsoft") || v.includes("wsl")) {
      tools.push("clip.exe");
    }
  } catch {
    // /proc/version unreadable — not WSL; skip.
  }
  return tools;
}

/**
 * Default `SpawnFn` implementation — a thin adapter around
 * `node:child_process.spawn` that matches the abstracted contract
 * exposed to the dispatcher and tests.
 */
const defaultSpawn: SpawnFn = (command, args) => {
  const child = cpSpawn(command, [...args], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  return {
    stdin: {
      write: (chunk: string) => {
        // Swallow write errors here — if the child dies before/while
        // we write, the subsequent `close`/`error` events carry the
        // failure; we must not throw synchronously out of this adapter.
        try {
          child.stdin!.write(chunk);
        } catch {
          /* ignored — surfaced via 'error' event */
        }
      },
      end: () => {
        try {
          child.stdin!.end();
        } catch {
          /* ignored — surfaced via 'error' event */
        }
      },
    },
    on: (event: "close" | "error", handler: (arg: never) => void) => {
      if (event === "close") {
        child.on("close", (code) => {
          // `code` may be null if the process was killed by a signal;
          // treat null as a non-zero failure by substituting 1.
          (handler as unknown as (code: number) => void)(
            typeof code === "number" ? code : 1,
          );
        });
      } else {
        child.on(
          "error",
          handler as unknown as (err: NodeJS.ErrnoException) => void,
        );
      }
    },
  };
};

/**
 * Returns the canonical argument list for the given clipboard CLI.
 *
 * - `pbcopy`   → no arguments (reads stdin)
 * - `xclip`    → `-selection clipboard`
 * - `xsel`     → `--clipboard --input`
 * - `clip.exe` → no arguments (reads stdin)
 *
 * Any unexpected tool name returns an empty argv (safe default —
 * the dispatcher only ever calls this with tools from its own
 * ordered list).
 */
function argsForTool(tool: string): readonly string[] {
  switch (tool) {
    case "pbcopy":
      return [];
    case "xclip":
      return ["-selection", "clipboard"];
    case "xsel":
      return ["--clipboard", "--input"];
    case "clip.exe":
      return [];
    default:
      return [];
  }
}

/**
 * Drives a single spawn attempt end-to-end: pipes `text` into the
 * child's stdin, waits for exit, and resolves a normalized result.
 *
 * Resolves to:
 *   - `{ ok: true }`                                — exit code 0
 *   - `{ ok: false, enoent: true }`                 — ENOENT (binary not on PATH)
 *   - `{ ok: false, enoent: false, reason }`        — any other failure
 *
 * Never rejects.
 */
function tryOnce(
  command: string,
  args: readonly string[],
  text: string,
  spawnFn: SpawnFn,
): Promise<{ ok: true } | { ok: false; enoent: boolean; reason: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (
      r: { ok: true } | { ok: false; enoent: boolean; reason: string },
    ) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let child: ReturnType<SpawnFn>;
    try {
      child = spawnFn(command, args);
    } catch (err) {
      // Synchronous spawn failure — mimic an ENOENT so the dispatcher
      // advances to the next tool.
      const e = err as NodeJS.ErrnoException;
      const enoent = e && e.code === "ENOENT";
      settle({
        ok: false,
        enoent,
        reason: e && e.message ? e.message : "spawn failed",
      });
      return;
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      const enoent = err && err.code === "ENOENT";
      settle({
        ok: false,
        enoent,
        reason: err && err.message ? err.message : "spawn error",
      });
    });

    child.on("close", (code: number) => {
      if (code === 0) {
        settle({ ok: true });
      } else {
        settle({
          ok: false,
          enoent: false,
          reason: `exited with code ${code}`,
        });
      }
    });

    // Pipe the payload, then close stdin. If the child has already
    // errored/closed, the adapter's write/end swallow the exception
    // and the outcome is decided by whichever event arrived first.
    child.stdin.write(text);
    child.stdin.end();
  });
}

/**
 * Iterates `tools` in order, spawns each via `spawnFn`, and returns
 * the first success. See module-level doc for semantics.
 *
 * Special-cases `clip.exe` on linux: if the bare-name attempt fails
 * with ENOENT, retries once against the absolute WSL path
 * (`/mnt/c/Windows/System32/clip.exe`) before giving up on the tool.
 *
 * If every tool is exhausted, resolves to
 * `{ ok: false, reason: "clipboard not available on this platform" }`.
 */
export async function clipboardDispatch(
  text: string,
  tools: readonly string[],
  spawnFn: SpawnFn = defaultSpawn,
): Promise<ClipboardResult> {
  for (const tool of tools) {
    const args = argsForTool(tool);
    const outcome = await tryOnce(tool, args, text, spawnFn);
    if (outcome.ok) {
      return { ok: true, tool };
    }
    // Linux fallback for WSL: if clip.exe wasn't on PATH, try the
    // well-known absolute path once before advancing to the next tool.
    if (
      tool === "clip.exe" &&
      outcome.enoent &&
      process.platform !== "win32"
    ) {
      const retry = await tryOnce(
        WSL_CLIP_ABSOLUTE_PATH,
        argsForTool("clip.exe"),
        text,
        spawnFn,
      );
      if (retry.ok) {
        return { ok: true, tool: "clip.exe" };
      }
    }
    // Any non-success (ENOENT or otherwise) → advance to next tool.
  }
  return {
    ok: false,
    reason: "clipboard not available on this platform",
  };
}

/**
 * Public one-shot entry point. Detects the platform's preferred
 * clipboard CLIs and dispatches `text` through them. Never throws —
 * failures are returned as `{ ok: false, reason }`.
 */
export async function copyToClipboard(
  text: string,
): Promise<ClipboardResult> {
  return clipboardDispatch(text, detectTools());
}
