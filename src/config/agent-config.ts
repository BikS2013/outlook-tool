// src/config/agent-config.ts
//
// Configuration resolver for the `agent` subcommand.
// See docs/design/project-design.md §3 (Public TypeScript Interfaces),
// §4 (Configuration Surface — canonical env-var table + precedence),
// and ADR-5 / ADR-8 for why this loader is parallel to `loadConfig`.
//
// Precedence (per design §4):
//   CLI flag > process env (at call-time) > .env file (loaded by caller) > default
// Mandatory rows (provider, model) have NO default — missing them raises a
// ConfigurationError. Dotenv loading is NOT this module's job; the caller
// (src/commands/agent.ts) calls `dotenv.config()` BEFORE invoking
// `loadAgentConfig`. This file only *records* the explicit `--env-file`
// path (after verifying it exists) on `AgentConfig.envFilePath`.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { UsageError } from '../commands/list-mail';
import { ConfigurationError } from './errors';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Literal union of LLM providers supported by the agent. Keep in sync with
 * the provider factories in `src/agent/providers/` (Unit 3).
 */
export type ProviderName =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'azure-openai'
  | 'azure-anthropic'
  | 'azure-deepseek';

const PROVIDER_NAMES: readonly ProviderName[] = [
  'openai',
  'anthropic',
  'google',
  'azure-openai',
  'azure-anthropic',
  'azure-deepseek',
] as const;

/**
 * CLI-flag shape consumed by `loadAgentConfig`. Mirrors the flags documented
 * in plan §2 Phase H and design §4 (the `Flag` column).
 *
 * Every field is optional — the loader fills unset fields from env vars or
 * applies a default where §4 permits one.
 */
export interface AgentConfigFlags {
  provider?: string;
  model?: string;
  maxSteps?: number;
  temperature?: number;
  systemPrompt?: string;
  systemPromptFile?: string;
  /** Raw CSV of tool names, e.g. "list_mail,get_mail". */
  tools?: string;
  perToolBudgetBytes?: number;
  allowMutations?: boolean;
  /** Explicit `--env-file` path. The loader verifies existence only. */
  envFile?: string;
  verbose?: boolean;
  interactive?: boolean;
}

/**
 * Fully-resolved agent configuration. Frozen before return so downstream
 * callers cannot mutate it. Matches the shape declared in design §3.
 */
export interface AgentConfig {
  readonly provider: ProviderName;
  readonly model: string;
  readonly temperature: number;
  readonly maxSteps: number;
  readonly perToolBudgetBytes: number;
  readonly systemPrompt: string | null;
  readonly systemPromptFile: string | null;
  readonly toolsAllowlist: readonly string[] | null;
  readonly allowMutations: boolean;
  readonly envFilePath: string | null;
  readonly verbose: boolean;
  readonly interactive: boolean;
  /** Frozen snapshot of every `OUTLOOK_AGENT_<PROVIDER>_*` env var set at
   *  call-time, for the selected provider. Consumed by Unit 3 factories. */
  readonly providerEnv: Readonly<Record<string, string>>;
}

/** Frozen empty env snapshot. Exported for test ergonomics. */
export const FROZEN_EMPTY: Readonly<Record<string, string>> = Object.freeze(
  {},
) as Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// Defaults (documented in design §4, optional rows only)
// ---------------------------------------------------------------------------

const DEFAULTS = {
  MAX_STEPS: 10,
  TEMPERATURE: 0,
  PER_TOOL_BUDGET_BYTES: 16384,
  ALLOW_MUTATIONS: false,
} as const;

// ---------------------------------------------------------------------------
// Env-var names (canonical table — design §4)
// ---------------------------------------------------------------------------

const ENV = {
  PROVIDER: 'OUTLOOK_AGENT_PROVIDER',
  MODEL: 'OUTLOOK_AGENT_MODEL',
  MAX_STEPS: 'OUTLOOK_AGENT_MAX_STEPS',
  TEMPERATURE: 'OUTLOOK_AGENT_TEMPERATURE',
  SYSTEM_PROMPT: 'OUTLOOK_AGENT_SYSTEM_PROMPT',
  SYSTEM_PROMPT_FILE: 'OUTLOOK_AGENT_SYSTEM_PROMPT_FILE',
  TOOLS: 'OUTLOOK_AGENT_TOOLS',
  PER_TOOL_BUDGET_BYTES: 'OUTLOOK_AGENT_PER_TOOL_BUDGET_BYTES',
  TOOL_OUTPUT_BUDGET_BYTES: 'OUTLOOK_AGENT_TOOL_OUTPUT_BUDGET_BYTES',
  ALLOW_MUTATIONS: 'OUTLOOK_AGENT_ALLOW_MUTATIONS',
} as const;

/** Provider → env-var prefix for the `providerEnv` snapshot. */
const PROVIDER_ENV_PREFIX: Readonly<Record<ProviderName, string>> = {
  openai: 'OUTLOOK_AGENT_OPENAI_',
  anthropic: 'OUTLOOK_AGENT_ANTHROPIC_',
  google: 'OUTLOOK_AGENT_GOOGLE_',
  'azure-openai': 'OUTLOOK_AGENT_AZURE_OPENAI_',
  'azure-anthropic': 'OUTLOOK_AGENT_AZURE_ANTHROPIC_',
  'azure-deepseek': 'OUTLOOK_AGENT_AZURE_DEEPSEEK_',
};

/** Shared Foundry-inference prefix included for azure-anthropic / azure-deepseek. */
const AZURE_AI_INFERENCE_PREFIX = 'OUTLOOK_AGENT_AZURE_AI_INFERENCE_';

/**
 * Per-provider fallback env var used to supply `model` when
 * `OUTLOOK_AGENT_MODEL` is not set. Each entry names the provider-scoped
 * variable that doubles as the model / deployment identifier for that
 * provider (see `.env.example` and design §4). Providers not listed here
 * have no alternative source for `model`.
 */
const PROVIDER_MODEL_FALLBACK_ENV: Readonly<Partial<Record<ProviderName, string>>> = {
  'azure-openai': 'OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT',
  'azure-anthropic': 'OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL',
  'azure-deepseek': 'OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a positive integer from a flag or env value. Throws `UsageError`
 * with a descriptive message on any invalid input (non-integer, non-finite,
 * zero, negative).
 */
function parsePositiveInt(raw: string | number, settingName: string): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
      throw new UsageError(
        `${settingName} must be a positive integer (got ${String(raw)})`,
      );
    }
    return raw;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new UsageError(
      `${settingName} must be a positive integer (got ${JSON.stringify(raw)})`,
    );
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new UsageError(
      `${settingName} must be a positive integer (got ${JSON.stringify(raw)})`,
    );
  }
  return n;
}

/**
 * Parse a finite non-negative float from a flag or env value. Throws
 * `UsageError` on NaN, infinity, or negative values.
 */
function parseNonNegativeFloat(
  raw: string | number,
  settingName: string,
): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new UsageError(
        `${settingName} must be a finite non-negative number (got ${String(raw)})`,
      );
    }
    return raw;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new UsageError(
      `${settingName} must be a finite non-negative number (got empty string)`,
    );
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) {
    throw new UsageError(
      `${settingName} must be a finite non-negative number (got ${JSON.stringify(raw)})`,
    );
  }
  return n;
}

/**
 * Parse a boolean from an env-var string. Accepts (case-insensitive):
 *   true  — "true", "1", "yes"
 *   false — "false", "0", "no", ""
 * Any other value throws `UsageError`.
 */
function parseBooleanEnv(raw: string, settingName: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === '') return false;
  throw new UsageError(
    `${settingName} must be a boolean-like value (true/false/1/0/yes/no), got ${JSON.stringify(raw)}`,
  );
}

/** Return `process.env[name]` trimmed, or undefined if unset or empty. */
function readEnv(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  return v;
}

/** Build the frozen providerEnv snapshot for the selected provider. */
function buildProviderEnv(
  provider: ProviderName,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  const primaryPrefix = PROVIDER_ENV_PREFIX[provider];
  // Azure Foundry providers also surface the shared inference block.
  const extraPrefixes: string[] = [];
  if (provider === 'azure-anthropic' || provider === 'azure-deepseek') {
    extraPrefixes.push(AZURE_AI_INFERENCE_PREFIX);
  }
  const prefixes = [primaryPrefix, ...extraPrefixes];
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    for (const p of prefixes) {
      if (key.startsWith(p)) {
        out[key] = value;
        break;
      }
    }
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Resolve a fully-materialized `AgentConfig` from CLI flags + current
 * `process.env`. The caller is responsible for invoking `dotenv.config()`
 * BEFORE calling this function (ADR-5).
 *
 * Precedence:   CLI flag > process env > default (optional rows only).
 * Mandatory rows (provider, model) raise `ConfigurationError` if unresolved.
 * Invalid flag/env values raise `UsageError` (exit 2).
 */
export function loadAgentConfig(flags: AgentConfigFlags): AgentConfig {
  // 1. envFilePath — verify existence if explicit --env-file was supplied.
  //    Dotenv loading already happened in the caller; we just record the path.
  let envFilePath: string | null = null;
  if (typeof flags.envFile === 'string' && flags.envFile !== '') {
    const abs = path.resolve(flags.envFile);
    if (!fs.existsSync(abs)) {
      throw new ConfigurationError(
        'envFile',
        ['--env-file'],
        `.env file not found at ${abs}`,
      );
    }
    envFilePath = abs;
  }

  // 2. provider — mandatory.
  const providerRaw =
    (typeof flags.provider === 'string' && flags.provider !== ''
      ? flags.provider
      : undefined) ?? readEnv(ENV.PROVIDER);
  if (providerRaw === undefined) {
    throw new ConfigurationError('OUTLOOK_AGENT_PROVIDER', [
      '--provider',
      'OUTLOOK_AGENT_PROVIDER',
    ]);
  }
  if (!(PROVIDER_NAMES as readonly string[]).includes(providerRaw)) {
    throw new UsageError(
      `--provider: ${JSON.stringify(providerRaw)} is not a supported provider. ` +
        `Expected one of: ${PROVIDER_NAMES.join(', ')}.`,
    );
  }
  const provider = providerRaw as ProviderName;

  // 3. model — mandatory. Precedence: --model > OUTLOOK_AGENT_MODEL >
  //    provider-specific deployment/model env var (see
  //    PROVIDER_MODEL_FALLBACK_ENV). The last tier exists because `.env.example`
  //    documents e.g. `OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT` as the
  //    canonical identifier for azure-openai; users who only set the
  //    provider-scoped var should not be forced to duplicate it as
  //    OUTLOOK_AGENT_MODEL.
  const providerModelFallbackName = PROVIDER_MODEL_FALLBACK_ENV[provider];
  const checkedModelSources = ['--model', 'OUTLOOK_AGENT_MODEL'];
  if (providerModelFallbackName) checkedModelSources.push(providerModelFallbackName);
  const model =
    (typeof flags.model === 'string' && flags.model !== ''
      ? flags.model
      : undefined) ??
    readEnv(ENV.MODEL) ??
    (providerModelFallbackName ? readEnv(providerModelFallbackName) : undefined);
  if (model === undefined) {
    throw new ConfigurationError('OUTLOOK_AGENT_MODEL', checkedModelSources);
  }

  // 4. maxSteps — optional, default 10.
  let maxSteps: number;
  if (typeof flags.maxSteps === 'number') {
    maxSteps = parsePositiveInt(flags.maxSteps, '--max-steps');
  } else {
    const raw = readEnv(ENV.MAX_STEPS);
    maxSteps =
      raw === undefined
        ? DEFAULTS.MAX_STEPS
        : parsePositiveInt(raw, ENV.MAX_STEPS);
  }

  // 5. temperature — optional, default 0.
  let temperature: number;
  if (typeof flags.temperature === 'number') {
    temperature = parseNonNegativeFloat(flags.temperature, '--temperature');
  } else {
    const raw = readEnv(ENV.TEMPERATURE);
    temperature =
      raw === undefined
        ? DEFAULTS.TEMPERATURE
        : parseNonNegativeFloat(raw, ENV.TEMPERATURE);
  }

  // 6. perToolBudgetBytes — optional, default 16384.
  //    Design §4 names it PER_TOOL_BUDGET_BYTES. `.env.example` used
  //    TOOL_OUTPUT_BUDGET_BYTES. Accept either; canonical name wins when both
  //    are set.
  let perToolBudgetBytes: number;
  if (typeof flags.perToolBudgetBytes === 'number') {
    perToolBudgetBytes = parsePositiveInt(
      flags.perToolBudgetBytes,
      '--per-tool-budget',
    );
  } else {
    const raw =
      readEnv(ENV.PER_TOOL_BUDGET_BYTES) ??
      readEnv(ENV.TOOL_OUTPUT_BUDGET_BYTES);
    perToolBudgetBytes =
      raw === undefined
        ? DEFAULTS.PER_TOOL_BUDGET_BYTES
        : parsePositiveInt(raw, 'per-tool-budget');
  }

  // 7. allowMutations — optional, default false.
  let allowMutations: boolean;
  if (typeof flags.allowMutations === 'boolean') {
    allowMutations = flags.allowMutations;
  } else {
    const raw = readEnv(ENV.ALLOW_MUTATIONS);
    allowMutations =
      raw === undefined
        ? DEFAULTS.ALLOW_MUTATIONS
        : parseBooleanEnv(raw, ENV.ALLOW_MUTATIONS);
  }

  // 8. toolsAllowlist — optional; null = "no allowlist" (full permitted set).
  let toolsAllowlist: readonly string[] | null;
  const toolsRaw =
    typeof flags.tools === 'string' ? flags.tools : readEnv(ENV.TOOLS);
  if (toolsRaw === undefined) {
    toolsAllowlist = null;
  } else {
    // An explicitly-empty CSV is a user error: they passed `--tools ""`.
    const parts = toolsRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length === 0) {
      throw new UsageError(
        `--tools: allowlist must contain at least one tool name (got ${JSON.stringify(toolsRaw)})`,
      );
    }
    toolsAllowlist = Object.freeze([...parts]);
  }

  // 9. systemPrompt / systemPromptFile — mutually exclusive. Do NOT read the
  //    file here; Unit 5 handles that.
  const systemPrompt =
    (typeof flags.systemPrompt === 'string' && flags.systemPrompt !== ''
      ? flags.systemPrompt
      : undefined) ??
    readEnv(ENV.SYSTEM_PROMPT) ??
    null;
  const systemPromptFile =
    (typeof flags.systemPromptFile === 'string' &&
    flags.systemPromptFile !== ''
      ? flags.systemPromptFile
      : undefined) ??
    readEnv(ENV.SYSTEM_PROMPT_FILE) ??
    null;
  if (systemPrompt !== null && systemPromptFile !== null) {
    throw new UsageError(
      '--system and --system-file are mutually exclusive (also applies to ' +
        'OUTLOOK_AGENT_SYSTEM_PROMPT and OUTLOOK_AGENT_SYSTEM_PROMPT_FILE)',
    );
  }

  // 10. verbose / interactive — CLI-only flags, no env var.
  const verbose = flags.verbose ?? false;
  const interactive = flags.interactive ?? false;

  // 11. providerEnv snapshot — frozen.
  const providerEnv = buildProviderEnv(provider);

  // 12. Assemble and freeze.
  const cfg: AgentConfig = {
    provider,
    model,
    temperature,
    maxSteps,
    perToolBudgetBytes,
    systemPrompt,
    systemPromptFile,
    toolsAllowlist,
    allowMutations,
    envFilePath,
    verbose,
    interactive,
    providerEnv,
  };
  return Object.freeze(cfg);
}
