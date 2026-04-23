// src/agent/tui/commands/model.ts
//
// `/model` handler. See docs/design/project-design.md §TUI.8 and §TUI.9,
// and prompts/004-agent-tui-spec.md §9.
//
// Grammar:
//   /model                                  → print current config (masked)
//   /model reset                            → revert to env + reset session
//   /model <provider> [--flag value]*       → switch LLM at runtime
//
// Tokenizer already applied by `parseSlashCommand` in `./index.ts`
// (regex `/(?:[^\s"]+|"[^"]*")/g`, quoted tokens have outer quotes
// stripped). `args` here is the post-tokenization tail.

import {
  loadAgentConfig,
  type AgentConfig,
  type AgentConfigFlags,
  type ProviderName,
} from "../../../config/agent-config";
import type { DispatchResult, SavedModel, TuiContext } from "../types";
import { generateId } from "./new-thread";

// ---------------------------------------------------------------------------
// Provider catalogue
// ---------------------------------------------------------------------------

const VALID_PROVIDERS: readonly ProviderName[] = [
  "openai",
  "anthropic",
  "google",
  "azure-openai",
  "azure-anthropic",
  "azure-deepseek",
] as const;

function isValidProvider(s: string): s is ProviderName {
  return (VALID_PROVIDERS as readonly string[]).includes(s);
}

/**
 * Per-provider map from `/model` `--flag` to canonical env-var name.
 * Env-var names MUST match `.env.example` verbatim — do not guess.
 * Agent-wide flags (`--model`, `--temperature`, `--max-steps`) are
 * handled upstream and never appear in this table.
 */
const FLAG_TO_ENV: Readonly<Record<ProviderName, Readonly<Record<string, string>>>> = {
  openai: {
    "--api-key": "OUTLOOK_AGENT_OPENAI_API_KEY",
    "--base-url": "OUTLOOK_AGENT_OPENAI_BASE_URL",
    "--org": "OUTLOOK_AGENT_OPENAI_ORG",
  },
  anthropic: {
    "--api-key": "OUTLOOK_AGENT_ANTHROPIC_API_KEY",
    "--base-url": "OUTLOOK_AGENT_ANTHROPIC_BASE_URL",
  },
  google: {
    "--api-key": "OUTLOOK_AGENT_GOOGLE_API_KEY",
  },
  "azure-openai": {
    "--api-key": "OUTLOOK_AGENT_AZURE_OPENAI_API_KEY",
    "--endpoint": "OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT",
    "--api-version": "OUTLOOK_AGENT_AZURE_OPENAI_API_VERSION",
    "--deployment": "OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT",
  },
  "azure-anthropic": {
    "--key": "OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY",
    "--endpoint": "OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT",
  },
  "azure-deepseek": {
    "--key": "OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY",
    "--endpoint": "OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT",
  },
};

// ---------------------------------------------------------------------------
// Helpers — masking + precedence
// ---------------------------------------------------------------------------

/**
 * Mask a secret-looking value: `"sk-abcd…wxyz"`. Strings ≤ 8 chars are
 * masked wholesale with `"****"` (not enough entropy to show a prefix
 * safely). Called only on values whose KEY name screams "secret".
 */
export function maskSecret(v: string): string {
  if (v.length <= 8) return "****";
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

/**
 * Heuristic: does this env-var name likely hold a secret? True when
 * the name contains KEY / SECRET / TOKEN / PASSWORD (case-insensitive).
 */
export function isSecretKeyName(k: string): boolean {
  return /KEY|SECRET|TOKEN|PASSWORD/i.test(k);
}

/**
 * Resolution helper — single seam through which `/model` (and future
 * commands) read `process.env`. Design §TUI.1 invariant #1 keeps this
 * as the only place the TUI layer touches the environment directly.
 *
 * Precedence:   flag (from current `/model` line) > process env > null.
 */
export function resolveParam(
  flag: string,
  envVar: string,
  parsedFlags: Map<string, string>,
): string | null {
  if (parsedFlags.has(flag)) {
    const v = parsedFlags.get(flag);
    return v === undefined ? null : v;
  }
  const v = process.env[envVar];
  if (typeof v === "string" && v !== "") return v;
  return null;
}

// ---------------------------------------------------------------------------
// `/model` with no args — print current config
// ---------------------------------------------------------------------------

function printCurrentConfig(ctx: TuiContext): void {
  ctx.printSystem(`provider: ${ctx.cfg.provider}`);
  ctx.printSystem(`model:    ${ctx.cfg.model}`);
  ctx.printSystem(`temperature: ${ctx.cfg.temperature}`);
  ctx.printSystem(`maxSteps: ${ctx.cfg.maxSteps}`);
  const envEntries = Object.entries(ctx.cfg.providerEnv);
  if (envEntries.length === 0) {
    ctx.printSystem("providerEnv: (none)");
    return;
  }
  ctx.printSystem("providerEnv:");
  // Sort by key for deterministic output (tests rely on this).
  envEntries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [k, v] of envEntries) {
    const display = isSecretKeyName(k) ? maskSecret(v) : v;
    ctx.printSystem(`  ${k}: ${display}`);
  }
}

// ---------------------------------------------------------------------------
// `/model reset`
// ---------------------------------------------------------------------------

async function doReset(ctx: TuiContext): Promise<DispatchResult> {
  if (ctx.isRunning) {
    ctx.printSystem(
      "cannot switch model while a turn is in flight",
      "error",
    );
    return { handled: true };
  }

  try {
    ctx.modelStore.clear();
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    ctx.printSystem(
      `failed to clear saved model file: ${msg}`,
      "error",
    );
    return { handled: true };
  }

  let fresh: AgentConfig;
  try {
    fresh = loadAgentConfig(ctx.startupFlags);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    ctx.printSystem(
      `failed to reload env config: ${msg}`,
      "error",
    );
    return { handled: true };
  }

  try {
    await ctx.rebuildGraph(fresh);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    ctx.printSystem(
      `saved-model cleared but graph rebuild failed: ${msg}`,
      "error",
    );
    return { handled: true };
  }

  ctx.threadId = generateId();
  ctx.messages = [];
  ctx.inputHistory.length = 0;
  ctx.lastRawResponse = "";
  ctx.printSystem(
    `model reverted to env config (${fresh.provider}/${fresh.model})`,
  );
  return { handled: true, resetThread: true, rebuildGraph: true };
}

// ---------------------------------------------------------------------------
// `/model <provider> [--flag value]*`
// ---------------------------------------------------------------------------

interface ParsedLine {
  readonly flags: Map<string, string>;
}

function parseFlags(
  args: readonly string[],
  ctx: TuiContext,
): ParsedLine | null {
  const flags = new Map<string, string>();
  // args[0] is the provider token — skip it.
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    if (!flag.startsWith("--")) {
      ctx.printSystem(
        `expected --flag, got ${JSON.stringify(flag)}`,
        "error",
      );
      return null;
    }
    const value = args[i + 1];
    if (value === undefined) {
      ctx.printSystem(`missing value for ${flag}`, "error");
      return null;
    }
    flags.set(flag, value);
  }
  return { flags };
}

async function doSwitch(
  provider: ProviderName,
  args: readonly string[],
  ctx: TuiContext,
): Promise<DispatchResult> {
  if (ctx.isRunning) {
    ctx.printSystem(
      "cannot switch model while a turn is in flight",
      "error",
    );
    return { handled: true };
  }

  const parsed = parseFlags(args, ctx);
  if (parsed === null) return { handled: true };

  const mapping = FLAG_TO_ENV[provider];
  const providerEnvOverrides: Record<string, string> = {};
  const overrides: Partial<AgentConfigFlags> = { provider };

  for (const [flag, value] of parsed.flags.entries()) {
    if (flag === "--model") {
      overrides.model = value;
      continue;
    }
    if (flag === "--temperature") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        ctx.printSystem(
          `--temperature must be a finite non-negative number (got ${JSON.stringify(value)})`,
          "error",
        );
        return { handled: true };
      }
      overrides.temperature = n;
      continue;
    }
    if (flag === "--max-steps") {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n <= 0 || String(n) !== value.trim()) {
        ctx.printSystem(
          `--max-steps must be a positive integer (got ${JSON.stringify(value)})`,
          "error",
        );
        return { handled: true };
      }
      overrides.maxSteps = n;
      continue;
    }
    const envVar = mapping?.[flag];
    if (envVar === undefined) {
      ctx.printSystem(
        `unknown flag for ${provider}: ${flag}`,
        "error",
      );
      return { handled: true };
    }
    providerEnvOverrides[envVar] = value;
  }

  let fresh: AgentConfig;
  try {
    fresh = loadAgentConfig(ctx.startupFlags, {
      overrides,
      providerEnvOverrides,
    });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    ctx.printSystem(`failed to switch: ${msg}`, "error");
    return { handled: true };
  }

  // Persist BEFORE rebuilding the graph — a failed rebuild still leaves
  // the user's requested preference on disk (design §TUI.9 step 5).
  const saved: SavedModel = {
    version: 1,
    provider: fresh.provider,
    model: fresh.model,
    temperature: fresh.temperature,
    maxSteps: fresh.maxSteps,
    providerSpecific: Object.freeze({ ...providerEnvOverrides }),
  };
  try {
    ctx.modelStore.save(saved);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    ctx.printSystem(
      `failed to persist saved-model file: ${msg}`,
      "error",
    );
    return { handled: true };
  }

  try {
    await ctx.rebuildGraph(fresh);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    ctx.printSystem(
      `model saved but graph rebuild failed: ${msg}`,
      "error",
    );
    return { handled: true };
  }

  ctx.threadId = generateId();
  ctx.messages = [];
  ctx.inputHistory.length = 0;
  ctx.lastRawResponse = "";
  ctx.printSystem(`switched to ${fresh.provider}/${fresh.model}`);
  return {
    handled: true,
    resetThread: true,
    rebuildGraph: true,
    newModel: saved,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleModel(
  args: readonly string[],
  ctx: TuiContext,
): Promise<DispatchResult> {
  if (args.length === 0) {
    printCurrentConfig(ctx);
    return { handled: true };
  }

  const first = args[0];
  if (first === "reset") {
    if (args.length > 1) {
      ctx.printSystem(
        "/model reset takes no arguments",
        "error",
      );
      return { handled: true };
    }
    return doReset(ctx);
  }

  if (!isValidProvider(first)) {
    ctx.printSystem(
      `unknown provider: ${first}. Valid: ${VALID_PROVIDERS.join(", ")}`,
      "error",
    );
    return { handled: true };
  }

  return doSwitch(first, args, ctx);
}
