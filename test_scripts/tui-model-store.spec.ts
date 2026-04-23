// test_scripts/tui-model-store.test.ts
//
// Unit tests for src/agent/tui/model-store.ts — persistent last-used
// model record with atomic-write semantics, mode 0600 / 0700, and
// strict schema validation on load().

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createModelStore } from "../src/agent/tui/model-store";
import type { SavedModel } from "../src/agent/tui/types";

const IS_WIN = process.platform === "win32";

function makeSavedModel(overrides: Partial<SavedModel> = {}): SavedModel {
  return {
    version: 1,
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0,
    maxSteps: 10,
    providerSpecific: Object.freeze({}),
    ...overrides,
  } as SavedModel;
}

describe("createModelStore", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-store-"));
    filePath = path.join(tmpDir, "nested", "model.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("load() returns null when the file is missing", () => {
    const store = createModelStore(filePath);
    expect(store.load()).toBeNull();
  });

  it("save() + load() round-trip", () => {
    const store = createModelStore(filePath);
    const m = makeSavedModel();
    store.save(m);

    const loaded = createModelStore(filePath).load();
    expect(loaded).not.toBeNull();
    expect(loaded!.provider).toBe(m.provider);
    expect(loaded!.model).toBe(m.model);
    expect(loaded!.temperature).toBe(m.temperature);
    expect(loaded!.maxSteps).toBe(m.maxSteps);
    expect(loaded!.version).toBe(1);
    expect(loaded!.providerSpecific).toEqual({});
  });

  it("save() throws TypeError on schema-invalid input", () => {
    const store = createModelStore(filePath);
    // Missing the required providerSpecific object.
    const bad = {
      version: 1,
      provider: "openai",
      model: "gpt-4o-mini",
    } as unknown as SavedModel;
    expect(() => store.save(bad)).toThrow(TypeError);

    // Unknown provider string.
    const badProvider = makeSavedModel({
      provider: "not-a-provider" as unknown as SavedModel["provider"],
    });
    expect(() => store.save(badProvider)).toThrow(TypeError);

    // Empty model string.
    const emptyModel = makeSavedModel({ model: "" });
    expect(() => store.save(emptyModel)).toThrow(TypeError);

    // No file should have been written for any of those attempts.
    expect(fs.existsSync(filePath)).toBe(false);
  });

  (IS_WIN ? it.skip : it)(
    "writes mode 0600 on file + 0700 on parent dir",
    () => {
      const store = createModelStore(filePath);
      store.save(makeSavedModel());

      const fileMode = fs.statSync(filePath).mode & 0o777;
      expect(fileMode).toBe(0o600);

      const parentMode = fs.statSync(path.dirname(filePath)).mode & 0o777;
      expect(parentMode).toBe(0o700);
    },
  );

  it("load() returns null and warns on corrupt JSON", () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, "{not valid json");

    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const store = createModelStore(filePath);
    expect(store.load()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("load() returns null and warns on schema-invalid content (unknown provider)", () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        provider: "not-a-provider",
        model: "x",
        providerSpecific: {},
      }),
    );

    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const store = createModelStore(filePath);
    expect(store.load()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("load() returns null and warns when `model` is not a string", () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        provider: "openai",
        model: 123,
        providerSpecific: {},
      }),
    );

    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const store = createModelStore(filePath);
    expect(store.load()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("clear() deletes the file", () => {
    const store = createModelStore(filePath);
    store.save(makeSavedModel());
    expect(fs.existsSync(filePath)).toBe(true);

    store.clear();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("clear() on an already-missing file is idempotent", () => {
    const store = createModelStore(filePath);
    // File does not exist yet.
    expect(() => store.clear()).not.toThrow();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
