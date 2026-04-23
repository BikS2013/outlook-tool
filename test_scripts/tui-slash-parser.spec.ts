// test_scripts/tui-slash-parser.spec.ts
//
// Unit tests for parseSlashCommand() exported from
// src/agent/tui/commands/index.ts. See design §TUI.8 / §TUI.11.

import { describe, it, expect } from "vitest";

import { parseSlashCommand } from "../src/agent/tui/commands/index";

describe("parseSlashCommand", () => {
  it("returns null for plain input without a leading slash", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
  });

  it("returns null for the empty string", () => {
    expect(parseSlashCommand("")).toBeNull();
  });

  it("parses '/help' with no args", () => {
    const p = parseSlashCommand("/help");
    expect(p).not.toBeNull();
    expect(p!.command).toBe("help");
    expect(p!.args).toEqual([]);
  });

  it("lowercases the command token ('/Help' -> 'help')", () => {
    const p = parseSlashCommand("/Help");
    expect(p).not.toBeNull();
    expect(p!.command).toBe("help");
  });

  it("parses '/memory add foo' into command + two positional args", () => {
    const p = parseSlashCommand("/memory add foo");
    expect(p).not.toBeNull();
    expect(p!.command).toBe("memory");
    expect(p!.args).toEqual(["add", "foo"]);
  });

  it("strips outer double-quotes around a multi-word argument", () => {
    const p = parseSlashCommand('/memory add "prefer concise summaries"');
    expect(p).not.toBeNull();
    expect(p!.command).toBe("memory");
    expect(p!.args).toEqual(["add", "prefer concise summaries"]);
  });

  it("parses '/model openai --api-key sk-123' preserving dashes and values", () => {
    const p = parseSlashCommand("/model openai --api-key sk-123");
    expect(p).not.toBeNull();
    expect(p!.command).toBe("model");
    expect(p!.args).toEqual(["openai", "--api-key", "sk-123"]);
  });

  it("strips leading and trailing whitespace from the raw input", () => {
    const p = parseSlashCommand("   /help   ");
    expect(p).not.toBeNull();
    expect(p!.command).toBe("help");
    expect(p!.args).toEqual([]);
  });

  it("multiple spaces between tokens collapse to zero empty args", () => {
    const p = parseSlashCommand("/memory    add     foo");
    expect(p).not.toBeNull();
    expect(p!.args).toEqual(["add", "foo"]);
  });

  it("args array is frozen (Object.freeze) — pushing throws in strict mode", () => {
    const p = parseSlashCommand("/memory add foo");
    expect(p).not.toBeNull();
    // ES modules run in strict mode, so mutating a frozen array throws.
    expect(() => {
      (p!.args as string[]).push("bar");
    }).toThrow(TypeError);
    // Shape still intact.
    expect(p!.args).toEqual(["add", "foo"]);
  });
});
