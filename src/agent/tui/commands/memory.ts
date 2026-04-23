// src/agent/tui/commands/memory.ts
//
// `/memory` handler — wraps `ctx.memoryStore` CRUD.
// Syntax:
//   /memory                   → list entries (1-indexed)
//   /memory add <text>        → append one entry
//   /memory remove <N>        → delete Nth entry
//   /memory clear             → wipe all entries
//
// Per spec §2.3 and design §TUI.8, added entries apply to the NEXT
// turn (the system-prompt builder reads `getEntries()` each time).

import type { DispatchResult, TuiContext } from "../types";

function printList(ctx: TuiContext): void {
  const entries = ctx.memoryStore.getEntries();
  if (entries.length === 0) {
    ctx.printSystem("(no memory entries)");
    return;
  }
  entries.forEach((e, i) => {
    ctx.printSystem(`${i + 1}. ${e}`);
  });
}

export async function handleMemory(
  args: readonly string[],
  ctx: TuiContext,
): Promise<DispatchResult> {
  if (args.length === 0) {
    printList(ctx);
    return { handled: true };
  }

  const sub = args[0].toLowerCase();

  if (sub === "add") {
    // Join all remaining tokens with a single space so multi-word
    // entries (quoted OR bare) both land as one string.
    const text = args.slice(1).join(" ").trim();
    if (text === "") {
      ctx.printSystem("/memory add: entry text cannot be empty", "error");
      return { handled: true };
    }
    try {
      ctx.memoryStore.add(text);
      ctx.printSystem("added");
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      ctx.printSystem(`/memory add failed: ${msg}`, "error");
    }
    return { handled: true };
  }

  if (sub === "remove") {
    if (args.length < 2) {
      ctx.printSystem("/memory remove: missing N", "error");
      return { handled: true };
    }
    const raw = args[1];
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || String(n) !== raw.trim()) {
      ctx.printSystem(
        `/memory remove: N must be a positive integer (got ${JSON.stringify(raw)})`,
        "error",
      );
      return { handled: true };
    }
    try {
      ctx.memoryStore.remove(n);
      ctx.printSystem("removed");
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      ctx.printSystem(`/memory remove failed: ${msg}`, "error");
    }
    return { handled: true };
  }

  if (sub === "clear") {
    try {
      ctx.memoryStore.clear();
      ctx.printSystem("cleared");
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      ctx.printSystem(`/memory clear failed: ${msg}`, "error");
    }
    return { handled: true };
  }

  ctx.printSystem(
    `/memory: unknown subcommand ${JSON.stringify(sub)} (try /help)`,
    "error",
  );
  return { handled: true };
}
