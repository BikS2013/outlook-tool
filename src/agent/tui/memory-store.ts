// src/agent/tui/memory-store.ts
//
// Persistent user-memory store for the Agent TUI. See design §TUI.3
// (MemoryStore interface) and §TUI.6.1 (file format & behavior rules).
//
// Mirrors the atomic-write pattern in src/session/store.ts: temp-file +
// fsync + rename, parent dir created with mode 0700, file written with
// mode 0600. Store is synchronous — reads on every call so out-of-band
// edits are visible; cross-process writes are last-writer-wins by design.

import * as fs from "node:fs";
import * as path from "node:path";

import type { MemoryStore } from "./types";

const FILE_VERSION = 1 as const;

interface MemoryFile {
  readonly version: 1;
  readonly entries: readonly string[];
}

function isMemoryFile(o: unknown): o is MemoryFile {
  if (!o || typeof o !== "object") return false;
  const v = (o as { version?: unknown }).version;
  if (v !== FILE_VERSION) return false;
  const e = (o as { entries?: unknown }).entries;
  if (!Array.isArray(e)) return false;
  return e.every((x) => typeof x === "string");
}

function readEntriesFromDisk(filePath: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    // EACCES or similar — treat as absent but warn. Per §TUI.6.1 rule 1/2,
    // disk errors must never throw from read paths.
    console.warn(
      `memory-store: cannot read ${filePath}: ${(err as Error).message}`,
    );
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `memory-store: corrupt JSON at ${filePath} — treating as empty: ${(err as Error).message}`,
    );
    return [];
  }
  if (!isMemoryFile(parsed)) {
    console.warn(
      `memory-store: schema invalid at ${filePath} — treating as empty`,
    );
    return [];
  }
  return [...parsed.entries];
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // If the dir already existed with a looser mode, do NOT tighten it —
  // the user may have their own reasons. session/store.ts uses the same
  // pass-through policy.
}

function writeEntriesAtomic(
  filePath: string,
  entries: readonly string[],
): void {
  ensureParentDir(filePath);
  const payload: MemoryFile = {
    version: FILE_VERSION,
    entries: [...entries],
  };
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmpPath, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

export function createMemoryStore(filePath: string): MemoryStore {
  return {
    get filePath() {
      return filePath;
    },
    getEntries(): readonly string[] {
      return Object.freeze(readEntriesFromDisk(filePath));
    },
    add(entry: string): void {
      if (entry === "") {
        throw new RangeError("memory entry cannot be empty");
      }
      const current = readEntriesFromDisk(filePath);
      current.push(entry);
      writeEntriesAtomic(filePath, current);
    },
    remove(oneIndexed: number): void {
      const current = readEntriesFromDisk(filePath);
      if (
        !Number.isInteger(oneIndexed) ||
        oneIndexed < 1 ||
        oneIndexed > current.length
      ) {
        throw new RangeError(`memory index out of range: ${oneIndexed}`);
      }
      current.splice(oneIndexed - 1, 1);
      writeEntriesAtomic(filePath, current);
    },
    clear(): void {
      writeEntriesAtomic(filePath, []);
    },
  };
}
