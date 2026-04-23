// test_scripts/tui-memory-store.test.ts
//
// Unit tests for src/agent/tui/memory-store.ts — persistent user-memory
// store with atomic-write semantics and mode 0600 / 0700 permissions.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createMemoryStore } from "../src/agent/tui/memory-store";

const IS_WIN = process.platform === "win32";

describe("createMemoryStore", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-store-"));
    // Put the store file one level deeper so we exercise parent-dir
    // creation (mode 0700 assertion).
    filePath = path.join(tmpDir, "nested", "memory.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("getEntries() returns [] when the file is missing", () => {
    const store = createMemoryStore(filePath);
    expect(store.getEntries()).toEqual([]);
  });

  it("add() + getEntries() round-trips, and no leftover tmp file remains", () => {
    const store = createMemoryStore(filePath);
    store.add("foo");

    // Re-read via a fresh store instance to prove persistence is on disk,
    // not in memory.
    const store2 = createMemoryStore(filePath);
    expect(store2.getEntries()).toEqual(["foo"]);

    // Atomic-write leaves the final file in place and removes the tmp.
    expect(fs.existsSync(filePath)).toBe(true);
    const parent = path.dirname(filePath);
    const leftover = fs
      .readdirSync(parent)
      .filter((n) => n.startsWith(path.basename(filePath) + ".tmp-"));
    expect(leftover).toEqual([]);
  });

  (IS_WIN ? it.skip : it)(
    "writes the file with mode 0600 and parent dir with mode 0700",
    () => {
      const store = createMemoryStore(filePath);
      store.add("x");

      const fileMode = fs.statSync(filePath).mode & 0o777;
      expect(fileMode).toBe(0o600);

      const parentMode = fs.statSync(path.dirname(filePath)).mode & 0o777;
      expect(parentMode).toBe(0o700);
    },
  );

  it('add("") throws RangeError', () => {
    const store = createMemoryStore(filePath);
    expect(() => store.add("")).toThrow(RangeError);
  });

  it("remove(1) removes the first entry and leaves the rest", () => {
    const store = createMemoryStore(filePath);
    store.add("a");
    store.add("b");
    store.remove(1);
    expect(store.getEntries()).toEqual(["b"]);
  });

  it("remove(0) and remove(99) throw RangeError", () => {
    const store = createMemoryStore(filePath);
    store.add("only");
    expect(() => store.remove(0)).toThrow(RangeError);
    expect(() => store.remove(99)).toThrow(RangeError);
    // State unchanged.
    expect(store.getEntries()).toEqual(["only"]);
  });

  it("clear() leaves the file with an empty entries array", () => {
    const store = createMemoryStore(filePath);
    store.add("a");
    store.add("b");
    store.clear();
    expect(store.getEntries()).toEqual([]);
    // File still present (not deleted), just empty.
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("corrupt JSON -> getEntries() returns [] and warns", () => {
    // Create parent dir manually and drop garbage.
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, "{ not json");

    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const store = createMemoryStore(filePath);
    expect(store.getEntries()).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("missing 'version' field -> getEntries() returns [] and warns", () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, JSON.stringify({ entries: ["lost"] }));

    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const store = createMemoryStore(filePath);
    expect(store.getEntries()).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });
});
