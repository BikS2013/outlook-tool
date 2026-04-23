// test_scripts/tui-compose-prompt.spec.ts
//
// Unit tests for composeSystemPrompt() exported from
// src/agent/tui/index.ts. See design §TUI.11 and spec §10
// (<user-instructions> block appended to the base prompt).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The real `src/agent/system-prompt.ts` does a CJS `require('../commands/
// list-mail')` to sidestep a circular import. vitest's module transformer
// mis-resolves that when the graph is loaded through this test (which pulls
// in `src/agent/tui/index.ts` -> `src/agent/system-prompt.ts`). Mirror the
// stub used in commands-agent.spec.ts.
vi.mock("../src/agent/system-prompt", () => ({
  DEFAULT_SYSTEM_PROMPT: "test-system-prompt",
  loadSystemPrompt: (inline: string | null, filePath: string | null) => {
    if (inline != null) return inline;
    if (filePath != null) return `<from-file:${filePath}>`;
    return "test-system-prompt";
  },
}));

import { composeSystemPrompt } from "../src/agent/tui/index";
import { createMemoryStore } from "../src/agent/tui/memory-store";

describe("composeSystemPrompt", () => {
  let tmpDir: string;
  let memoryFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-"));
    memoryFile = path.join(tmpDir, "memory.json");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("returns the base prompt unchanged when memory is empty", () => {
    const store = createMemoryStore(memoryFile);
    expect(composeSystemPrompt("BASE", store)).toBe("BASE");
  });

  it("appends a <user-instructions> block when memory has entries", () => {
    const store = createMemoryStore(memoryFile);
    store.add("prefer concise summaries");
    store.add("always include message ids");

    const out = composeSystemPrompt("BASE", store);
    expect(out).toContain("BASE");
    expect(out).toContain("<user-instructions>");
    expect(out).toContain("1. prefer concise summaries");
    expect(out).toContain("2. always include message ids");
    expect(out).toContain("</user-instructions>");
    // The block must come AFTER the base prompt.
    expect(out.indexOf("BASE")).toBeLessThan(out.indexOf("<user-instructions>"));
  });

  it("re-reads memory on each call (no caching)", () => {
    const store = createMemoryStore(memoryFile);
    expect(composeSystemPrompt("BASE", store)).toBe("BASE");

    store.add("added later");
    expect(composeSystemPrompt("BASE", store)).toContain("added later");
  });
});
