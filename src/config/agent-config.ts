// src/config/agent-config.ts
//
// Configuration resolver for the `agent` subcommand.
// See docs/design/project-design.md §3 (Public TypeScript Interfaces),
// §4 (Configuration Surface — canonical env-var table + precedence),
// and ADR-5 / ADR-8 for why this loader is parallel to `loadConfig`.
//
// Precedence (v2.1.0+, project-specific policy — folder .env overrides shell):
//   CLI flag > ~/.tool-agents/outlook-cli/.env > process env (at call-time)
//   > cwd/.env (--env-file) > ~/.tool-agents/outlook-cli/config.json
//   > default (optional) / throw (mandatory)
//
// This inverts the cli-agent-builder canonical (which says "shell > file").
// The per-user folder is the user's durable, intentional config — a stale
// shell export from another project must not shadow it. Rationale recorded
// in src/config/agent-config-folder.ts's module header and in CHANGELOG.md
// under [2.1.0].
//
// Dotenv loading for the tool-agents folder is done inside this module (via
// the agent-config-folder helper, with override:true). The cwd/.env load is
// the caller's responsibility (src/commands/agent.ts calls `dotenv.config()`
// BEFORE invoking `loadAgentConfig`).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { UsageError } from '../commands/list-mail';
import { ConfigurationError } from './errors';
import { ensureAgentConfigFolder, loadConfigJson } from './agent-config-folder';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Literal union of LLM providers supported by the agent. Keep in sync with
 * the provider factories in `src/agent/providers/` (Unit 3).
 *
 * Canonical six (standard_conventions): openai, anthropic, gemini,
 *   azure-openai, azure-anthropic, local-openai.
 * Project extension: azure-deepseek.
 * Deprecated alias: google (normalised to gemini at parse time).
 */
export type ProviderName =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'azure-openai'
  | 'azure-anthropic'
  | 'local-openai'
  | 'azure-deepseek';

const PROVIDER_NAMES: readonly ProviderName[] = [
  'openai',
  'anthropic',
  'gemini',
  'azure-openai',
  'azure-anthropic',
  'local-openai',
  'azure-deepseek',
] as const;

/** Deprecated alias `google` → canonical `gemini`. */
const DEPRECATED_PROVIDER_ALIASES: Readonly<Record<string, ProviderName>> = {
  google: 'gemini',
};

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
  /** Override for the on-disk agent memory file (see §TUI.7). */
  agentMemoryFile?: string;
  /** Override for the on-disk agent model-preference file (see §TUI.7). */
  agentModelFile?: string;
  /**
   * Override base URL for the LLM endpoint. Primarily used by `local-openai`
   * to set the `OPENAI_BASE_URL`-equivalent without exporting a shell var.
   * Also honoured by `openai` for proxy endpoints. (R2)
   */
  baseUrl?: string;
  /**
   * Override the path to `~/.tool-agents/outlook-cli/config.json`. (R3)
   */
  configPath?: string;
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
  /** Frozen snapshot of every standard provider env var set at
   *  call-time, for the selected provider. Consumed by Unit 3 factories. */
  readonly providerEnv: Readonly<Record<string, string>>;
  /** Absolute path to the agent memory JSON file (see design §TUI.7).
   *  Default: `$HOME/.outlook-cli/agent-memory.json`. */
  readonly memoryFile: string;
  /** Absolute path to the agent model-preference JSON file (see §TUI.7).
   *  Default: `$HOME/.outlook-cli/agent-model.json`. */
  readonly modelFile: string;
}

/**
 * Optional second parameter to `loadAgentConfig`. Every field is additive —
 * single-arg callers continue to work unchanged (see design §TUI.14 #4).
 */
export interface AgentConfigOverrides {
  /** Explicit values that take precedence over CLI flags, env, and
   *  defaults. Typed as `AgentConfigFlags` so the same validators fire. */
  readonly overrides?: Partial<AgentConfigFlags>;
  /** Provider-specific env overrides — merged into the `providerEnv`
   *  snapshot for the duration of this call only. Does NOT mutate
   *  `process.env`. Used by `/model` to pass typed `--flag` values into
   *  Unit 3 provider factories. */
  readonly providerEnvOverrides?: Readonly<Record<string, string>>;
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
  // §TUI.7 — on-disk paths for the TUI memory + model-preference files.
  // Defaults are computed per-call (not at module load) because
  // `os.homedir()` must run at call time.
  MEMORY_FILENAME: 'agent-memory.json',
  MODEL_FILENAME: 'agent-model.json',
  OUTLOOK_CLI_DIR: '.outlook-cli',
} as const;

// ---------------------------------------------------------------------------
// Env-var names (canonical table — design §4)
// Control vars (prefixed) — NOT renamed in v2.0.0.
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
  MEMORY_FILE: 'OUTLOOK_AGENT_MEMORY_FILE',
  MODEL_FILE: 'OUTLOOK_AGENT_MODEL_FILE',
} as const;

// ---------------------------------------------------------------------------
// Provider env-var sets (standard vendor-documented names — v2.0.0)
//
// Each entry lists the env var names that belong to this provider.
// `buildProviderEnv` captures any of these that are set in `process.env`.
// ---------------------------------------------------------------------------

/** Standard env vars for each provider (read from process.env). */
const PROVIDER_ENV_KEYS: Readonly<Record<ProviderName, readonly string[]>> = {
  openai: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID'],
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
  gemini: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  'azure-openai': [
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_DEPLOYMENT',
    'AZURE_OPENAI_API_VERSION',
  ],
  'azure-anthropic': [
    'AZURE_AI_INFERENCE_KEY',
    'AZURE_AI_INFERENCE_ENDPOINT',
    'AZURE_ANTHROPIC_MODEL',
  ],
  'local-openai': [
    'OPENAI_BASE_URL',
    'LOCAL_OPENAI_BASE_URL',
    'OLLAMA_HOST',
    'OPENAI_API_KEY',
  ],
  'azure-deepseek': [
    'AZURE_AI_INFERENCE_KEY',
    'AZURE_AI_INFERENCE_ENDPOINT',
    'AZURE_DEEPSEEK_MODEL',
  ],
};

/**
 * Per-provider fallback env var used to supply `model` when
 * `OUTLOOK_AGENT_MODEL` is not set. Each entry names the provider-scoped
 * variable that doubles as the model / deployment identifier for that
 * provider. Providers not listed here have no alternative source for `model`.
 */
const PROVIDER_MODEL_FALLBACK_ENV: Readonly<Partial<Record<ProviderName, string>>> = {
  'azure-openai': 'AZURE_OPENAI_DEPLOYMENT',
  'azure-anthropic': 'AZURE_ANTHROPIC_MODEL',
  'azure-deepseek': 'AZURE_DEEPSEEK_MODEL',
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

/** Build the frozen providerEnv snapshot for the selected provider.
 *  Captures the specific standard env vars for the provider from process.env.
 *  `overrides`, when supplied, is layered on top.
 *  `process.env` is never mutated. */
function buildProviderEnv(
  provider: ProviderName,
  baseUrlOverride: string | undefined,
  overrides?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  const keys = PROVIDER_ENV_KEYS[provider] ?? [];

  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== '') {
      out[key] = value;
    }
  }

  // If --base-url was set on the CLI, inject it into the snapshot so
  // factories can pick it up. For openai and local-openai it maps to
  // OPENAI_BASE_URL; for other providers it is ignored (they don't use
  // a generic baseURL concept in the same way).
  if (baseUrlOverride !== undefined && baseUrlOverride !== '') {
    if (provider === 'openai' || provider === 'local-openai') {
      out['OPENAI_BASE_URL'] = baseUrlOverride;
    }
  }

  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      out[k] = v;
    }
  }
  return Object.freeze(out);
}

/**
 * Resolve an optional on-disk agent file path with the standard precedence:
 *   CLI flag > env var > default (`$HOME/.outlook-cli/<defaultFilename>`).
 * The return value is always an absolute path.
 */
function resolveAgentFile(
  flagValue: string | undefined,
  envVarName: string,
  defaultFilename: string,
): string {
  const raw =
    (typeof flagValue === 'string' && flagValue !== ''
      ? flagValue
      : undefined) ?? readEnv(envVarName);
  if (raw !== undefined) {
    return path.resolve(raw);
  }
  // Default: $HOME/.outlook-cli/<filename>.
  return path.join(os.homedir(), DEFAULTS.OUTLOOK_CLI_DIR, defaultFilename);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Resolve a fully-materialized `AgentConfig` from CLI flags + current
 * `process.env`. The caller is responsible for invoking `dotenv.config()`
 * for cwd/.env BEFORE calling this function (ADR-5). This function also
 * loads `~/.tool-agents/outlook-cli/.env` and `~/.tool-agents/outlook-cli/config.json`
 * as lower-priority sources.
 *
 * Precedence (v2.1.0+ — folder .env overrides shell):
 *   CLI flag > ~/.tool-agents/outlook-cli/.env > process env >
 *   cwd/.env (loaded by caller) > ~/.tool-agents/outlook-cli/config.json >
 *   default (optional) / throw (mandatory).
 *
 * Mandatory rows (provider, model) raise `ConfigurationError` if unresolved.
 * Invalid flag/env values raise `UsageError` (exit 2).
 */
export function loadAgentConfig(
  flags: AgentConfigFlags,
  opts?: AgentConfigOverrides,
): AgentConfig {
  // 0. Merge overrides into the effective flag set. Overrides win over the
  //    CLI flags (design §TUI.14 #4). The overrides object is `Partial<...>`
  //    so unset keys do not clobber values set on `flags`.
  const effective: AgentConfigFlags = {
    ...flags,
    ...(opts?.overrides ?? {}),
  };

  // 0a. Ensure the ~/.tool-agents/outlook-cli/ folder exists and seed it on
  //     first run. Also loads the .env from the folder (override:TRUE — the
  //     folder .env wins over shell exports, per project policy) and returns
  //     the parsed config.json values (if any).
  const configFolderPath = typeof effective.configPath === 'string' && effective.configPath !== ''
    ? effective.configPath
    : undefined;
  const folderConfig = ensureAgentConfigFolder(configFolderPath);

  // 1. envFilePath — verify existence if explicit --env-file was supplied.
  //    Dotenv loading already happened in the caller; we just record the path.
  let envFilePath: string | null = null;
  if (typeof effective.envFile === 'string' && effective.envFile !== '') {
    const abs = path.resolve(effective.envFile);
    if (!fs.existsSync(abs)) {
      throw new ConfigurationError(
        'envFile',
        ['--env-file'],
        `.env file not found at ${abs}`,
      );
    }
    envFilePath = abs;
  }

  // Helper: read from process.env (includes .env values already loaded),
  // falling back to the config.json value if the key is a control var.
  // For credential env vars the config.json is not consulted (secrets
  // should stay in .env, not config.json).
  // Numbers from config.json are stringified so downstream parsers work.
  function readWithFolderFallback(envName: string, configKey?: string): string | undefined {
    const fromEnv = readEnv(envName);
    if (fromEnv !== undefined) return fromEnv;
    if (configKey !== undefined && folderConfig !== null) {
      const v = (folderConfig as Record<string, unknown>)[configKey];
      if (typeof v === 'string' && v !== '') return v;
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      if (typeof v === 'boolean') return String(v);
    }
    return undefined;
  }

  // 2. provider — mandatory.
  const providerRaw =
    (typeof effective.provider === 'string' && effective.provider !== ''
      ? effective.provider
      : undefined) ?? readWithFolderFallback(ENV.PROVIDER, 'provider');
  if (providerRaw === undefined) {
    throw new ConfigurationError('OUTLOOK_AGENT_PROVIDER', [
      '--provider',
      'OUTLOOK_AGENT_PROVIDER',
      '~/.tool-agents/outlook-cli/.env',
      '~/.tool-agents/outlook-cli/config.json',
    ]);
  }

  // Handle deprecated `google` alias — normalise to `gemini` + warn.
  let finalProviderRaw = providerRaw;
  if (DEPRECATED_PROVIDER_ALIASES[providerRaw] !== undefined) {
    const canonical = DEPRECATED_PROVIDER_ALIASES[providerRaw];
    process.stderr.write(
      `[outlook-cli agent] DEPRECATION WARNING: provider "${providerRaw}" is deprecated. ` +
        `Use "${canonical}" instead. Support for "${providerRaw}" will be removed in a future version.\n`,
    );
    finalProviderRaw = canonical;
  }

  if (!(PROVIDER_NAMES as readonly string[]).includes(finalProviderRaw)) {
    throw new UsageError(
      `--provider: ${JSON.stringify(providerRaw)} is not a supported provider. ` +
        `Expected one of: ${PROVIDER_NAMES.join(', ')}.`,
    );
  }
  const provider = finalProviderRaw as ProviderName;

  // 3. model — mandatory. Precedence: --model > OUTLOOK_AGENT_MODEL >
  //    provider-specific deployment/model env var (see
  //    PROVIDER_MODEL_FALLBACK_ENV) > config.json.
  const providerModelFallbackName = PROVIDER_MODEL_FALLBACK_ENV[provider];
  const checkedModelSources = [
    '--model',
    'OUTLOOK_AGENT_MODEL',
    '~/.tool-agents/outlook-cli/.env',
    '~/.tool-agents/outlook-cli/config.json',
  ];
  if (providerModelFallbackName) checkedModelSources.push(providerModelFallbackName);
  const model =
    (typeof effective.model === 'string' && effective.model !== ''
      ? effective.model
      : undefined) ??
    readWithFolderFallback(ENV.MODEL, 'model') ??
    (providerModelFallbackName ? readEnv(providerModelFallbackName) : undefined);
  if (model === undefined) {
    throw new ConfigurationError('OUTLOOK_AGENT_MODEL', checkedModelSources);
  }

  // 4. maxSteps — optional, default 10.
  let maxSteps: number;
  if (typeof effective.maxSteps === 'number') {
    maxSteps = parsePositiveInt(effective.maxSteps, '--max-steps');
  } else {
    const raw = readWithFolderFallback(ENV.MAX_STEPS, 'maxSteps');
    maxSteps =
      raw === undefined
        ? DEFAULTS.MAX_STEPS
        : parsePositiveInt(raw, ENV.MAX_STEPS);
  }

  // 5. temperature — optional, default 0.
  let temperature: number;
  if (typeof effective.temperature === 'number') {
    temperature = parseNonNegativeFloat(effective.temperature, '--temperature');
  } else {
    const raw = readWithFolderFallback(ENV.TEMPERATURE, 'temperature');
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
  if (typeof effective.perToolBudgetBytes === 'number') {
    perToolBudgetBytes = parsePositiveInt(
      effective.perToolBudgetBytes,
      '--per-tool-budget',
    );
  } else {
    const raw =
      readWithFolderFallback(ENV.PER_TOOL_BUDGET_BYTES, 'perToolBudgetBytes') ??
      readEnv(ENV.TOOL_OUTPUT_BUDGET_BYTES);
    perToolBudgetBytes =
      raw === undefined
        ? DEFAULTS.PER_TOOL_BUDGET_BYTES
        : parsePositiveInt(raw, 'per-tool-budget');
  }

  // 7. allowMutations — optional, default false.
  let allowMutations: boolean;
  if (typeof effective.allowMutations === 'boolean') {
    allowMutations = effective.allowMutations;
  } else {
    const raw = readWithFolderFallback(ENV.ALLOW_MUTATIONS, 'allowMutations');
    allowMutations =
      raw === undefined
        ? DEFAULTS.ALLOW_MUTATIONS
        : parseBooleanEnv(raw, ENV.ALLOW_MUTATIONS);
  }

  // 8. toolsAllowlist — optional; null = "no allowlist" (full permitted set).
  let toolsAllowlist: readonly string[] | null;
  const toolsRaw =
    typeof effective.tools === 'string'
      ? effective.tools
      : readWithFolderFallback(ENV.TOOLS, 'tools');
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
    (typeof effective.systemPrompt === 'string' && effective.systemPrompt !== ''
      ? effective.systemPrompt
      : undefined) ??
    readWithFolderFallback(ENV.SYSTEM_PROMPT, 'systemPrompt') ??
    null;
  const systemPromptFile =
    (typeof effective.systemPromptFile === 'string' &&
    effective.systemPromptFile !== ''
      ? effective.systemPromptFile
      : undefined) ??
    readWithFolderFallback(ENV.SYSTEM_PROMPT_FILE, 'systemPromptFile') ??
    null;
  if (systemPrompt !== null && systemPromptFile !== null) {
    throw new UsageError(
      '--system and --system-file are mutually exclusive (also applies to ' +
        'OUTLOOK_AGENT_SYSTEM_PROMPT and OUTLOOK_AGENT_SYSTEM_PROMPT_FILE)',
    );
  }

  // 10. verbose / interactive — CLI-only flags, no env var.
  const verbose = effective.verbose ?? false;
  const interactive = effective.interactive ?? false;

  // 11. providerEnv snapshot — frozen. Captures standard env vars for the
  //     selected provider. --base-url is injected when present.
  //     providerEnvOverrides from `opts` are layered on top without touching
  //     process.env.
  const baseUrlOverride =
    typeof effective.baseUrl === 'string' && effective.baseUrl !== ''
      ? effective.baseUrl
      : undefined;
  const providerEnv = buildProviderEnv(
    provider,
    baseUrlOverride,
    opts?.providerEnvOverrides,
  );

  // 12. memoryFile / modelFile — §TUI.7 plumbing defaults.
  const memoryFile = resolveAgentFile(
    effective.agentMemoryFile,
    ENV.MEMORY_FILE,
    DEFAULTS.MEMORY_FILENAME,
  );
  const modelFile = resolveAgentFile(
    effective.agentModelFile,
    ENV.MODEL_FILE,
    DEFAULTS.MODEL_FILENAME,
  );

  // 13. Assemble and freeze.
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
    memoryFile,
    modelFile,
  };
  return Object.freeze(cfg);
}
