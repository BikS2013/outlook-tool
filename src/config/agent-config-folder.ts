// src/config/agent-config-folder.ts
//
// Manages the ~/.tool-agents/outlook-cli/ per-user configuration folder.
//
// Responsibilities:
//   1. Ensure the folder exists (mode 0700) on first run.
//   2. Seed .env (mode 0600) with placeholder values if absent.
//   3. Seed config.json (mode 0600) from docs/reference/config.json.example
//      if absent.
//   4. Load .env (dotenv, override:true — project policy, see below).
//   5. Load and Zod-validate config.json; return parsed values (or null
//      if absent / parse fails — never overwrite an existing malformed file).
//   6. Check expiresAt fields: warn on stderr if within 7 days of expiry.
//
// PROJECT POLICY (2026-04-24): the folder .env OVERRIDES shell environment
// variables. This is a deliberate reversal of the cli-agent-builder's
// canonical "shell-wins" precedence. The rationale is ergonomic: the
// per-user folder is the user's durable, intentional config; a stale shell
// export left over from another project should not shadow it. CLI flags
// still win over everything.
//
// Effective precedence:
//   CLI flag > ~/.tool-agents/outlook-cli/.env > process env
//     > cwd/.env (--env-file) > ~/.tool-agents/outlook-cli/config.json
//     > default (optional) / throw (mandatory).
//
// Guard: if the folder or files cannot be created (read-only home dir, etc.),
// log a single warning to stderr and continue — do NOT throw.
//
// Invariant: the seeded .env contains ONLY placeholder strings.
//            NEVER copy from process.env.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as dotenv from 'dotenv';

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Folder path
// ---------------------------------------------------------------------------

export const AGENT_CONFIG_FOLDER_NAME = 'outlook-cli';

/**
 * Resolve the `~/.tool-agents/` root at call time — never at module load.
 * Tests stub `process.env.HOME` in a `beforeAll`, which runs AFTER the
 * module is imported. A module-level constant would capture the real home
 * and silently bypass the stub.
 */
function toolAgentsRoot(): string {
  return path.join(os.homedir(), '.tool-agents');
}

/** Absolute path to ~/.tool-agents/outlook-cli/ */
export function getAgentConfigFolderPath(override?: string): string {
  if (override !== undefined && override !== '') return path.resolve(override);
  return path.join(toolAgentsRoot(), AGENT_CONFIG_FOLDER_NAME);
}

// ---------------------------------------------------------------------------
// Config JSON schema (schemaVersion: 1)
// ---------------------------------------------------------------------------

/** Any ISO8601 expiration hint stored in config.json. */
const ExpiresAtSchema = z.string().optional();

/**
 * Zod schema for ~/.tool-agents/outlook-cli/config.json.
 * All fields are optional so the user can set only the ones they care about.
 * Unknown keys are stripped (z.object(...).strip() is default behaviour).
 */
const ConfigJsonSchema = z.object({
  schemaVersion: z.literal(1),
  // Control / runtime settings (non-secret)
  provider: z.string().optional(),
  model: z.string().optional(),
  maxSteps: z.union([z.number(), z.string()]).optional(),
  temperature: z.union([z.number(), z.string()]).optional(),
  perToolBudgetBytes: z.union([z.number(), z.string()]).optional(),
  allowMutations: z.union([z.boolean(), z.string()]).optional(),
  tools: z.string().optional(),
  systemPrompt: z.string().optional(),
  systemPromptFile: z.string().optional(),
  // Expiry hints — checked at startup
  apiKeyExpiresAt: ExpiresAtSchema,
  azureKeyExpiresAt: ExpiresAtSchema,
  // Arbitrary extra expiry fields a user might add
  expiresAt: ExpiresAtSchema,
});

export type ConfigJson = z.infer<typeof ConfigJsonSchema>;

// ---------------------------------------------------------------------------
// Seeded .env placeholder content
// ---------------------------------------------------------------------------

const ENV_SEED_CONTENT = `# ~/.tool-agents/outlook-cli/.env
# Secrets for the outlook-cli agent subcommand.
# Process environment variables (and any --env-file you pass) always override
# these values. dotenv loads this file with override:false.
#
# Fill in only the vars for the provider you use. Never commit this file.

# ── Control vars ──────────────────────────────────────────────────────────
# OUTLOOK_AGENT_PROVIDER=openai
# OUTLOOK_AGENT_MODEL=gpt-4o-mini

# ── OpenAI ────────────────────────────────────────────────────────────────
# Uncomment and fill in the vars you need. Commented lines inject nothing.
# OPENAI_API_KEY=REPLACE_ME
# OPENAI_BASE_URL=
# OPENAI_ORG_ID=

# ── Anthropic ─────────────────────────────────────────────────────────────
# ANTHROPIC_API_KEY=REPLACE_ME
# ANTHROPIC_BASE_URL=

# ── Google Gemini ─────────────────────────────────────────────────────────
# GOOGLE_API_KEY=REPLACE_ME
# GEMINI_API_KEY=REPLACE_ME  # alias for GOOGLE_API_KEY

# ── Azure OpenAI ──────────────────────────────────────────────────────────
# AZURE_OPENAI_API_KEY=REPLACE_ME
# AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
# AZURE_OPENAI_API_VERSION=2024-10-21
# AZURE_OPENAI_DEPLOYMENT=REPLACE_ME

# ── Azure AI Foundry (azure-anthropic / azure-deepseek) ───────────────────
# AZURE_AI_INFERENCE_KEY=REPLACE_ME
# AZURE_AI_INFERENCE_ENDPOINT=https://<resource>.services.ai.azure.com

# ── local-openai ──────────────────────────────────────────────────────────
# OPENAI_BASE_URL=http://localhost:11434/v1
# LOCAL_OPENAI_BASE_URL=http://localhost:11434/v1
# OLLAMA_HOST=localhost:11434
`;

// ---------------------------------------------------------------------------
// Seeded config.json placeholder content (JSON string)
// ---------------------------------------------------------------------------

const CONFIG_JSON_SEED: ConfigJson = {
  schemaVersion: 1,
};

// ---------------------------------------------------------------------------
// Expiry check
// ---------------------------------------------------------------------------

const WARN_DAYS = 7;

function checkExpiresAt(label: string, value: string | undefined): void {
  if (!value) return;
  try {
    const expiry = new Date(value);
    const now = new Date();
    const diffMs = expiry.getTime() - now.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays <= WARN_DAYS) {
      process.stderr.write(
        `[outlook-cli agent] WARNING: "${label}" (${value}) expires in ` +
          `${Math.ceil(diffDays)} day(s). Please renew soon.\n`,
      );
    }
  } catch {
    // Malformed date — ignore silently.
  }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Ensure the ~/.tool-agents/outlook-cli/ folder is set up, seed missing files,
 * load the .env (override:false), validate config.json, check expiry hints.
 *
 * @param configPathOverride  Optional override for the folder path (--config
 *   flag resolves to the folder containing config.json, or the file itself —
 *   we accept either).
 * @returns Parsed config.json values, or null if the file is absent or invalid.
 */
export function ensureAgentConfigFolder(
  configPathOverride?: string,
): ConfigJson | null {
  // Resolve folder path.
  let folderPath: string;
  let configJsonPath: string;

  if (configPathOverride !== undefined && configPathOverride !== '') {
    const abs = path.resolve(configPathOverride);
    // If the override points at a file, use its directory.
    if (abs.endsWith('.json')) {
      configJsonPath = abs;
      folderPath = path.dirname(abs);
    } else {
      folderPath = abs;
      configJsonPath = path.join(folderPath, 'config.json');
    }
  } else {
    folderPath = getAgentConfigFolderPath();
    configJsonPath = path.join(folderPath, 'config.json');
  }

  const envFilePath = path.join(folderPath, '.env');

  // 1. Ensure the folder exists (mode 0700).
  try {
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true, mode: 0o700 });
    }
  } catch (err) {
    process.stderr.write(
      `[outlook-cli agent] WARNING: could not create config folder at ${folderPath}: ${String(err)}\n`,
    );
    return null;
  }

  // 2. Seed .env if absent (mode 0600, placeholder values only).
  try {
    if (!fs.existsSync(envFilePath)) {
      fs.writeFileSync(envFilePath, ENV_SEED_CONTENT, { mode: 0o600 });
    }
  } catch (err) {
    process.stderr.write(
      `[outlook-cli agent] WARNING: could not seed .env at ${envFilePath}: ${String(err)}\n`,
    );
  }

  // 3. Seed config.json if absent (mode 0600).
  try {
    if (!fs.existsSync(configJsonPath)) {
      fs.writeFileSync(
        configJsonPath,
        JSON.stringify(CONFIG_JSON_SEED, null, 2) + '\n',
        { mode: 0o600 },
      );
    }
  } catch (err) {
    process.stderr.write(
      `[outlook-cli agent] WARNING: could not seed config.json at ${configJsonPath}: ${String(err)}\n`,
    );
  }

  // 4. Load .env (override:TRUE — project policy, 2026-04-24).
  //    The folder .env wins over pre-existing process.env values. See
  //    the module header for rationale. This is the inverse of the
  //    cli-agent-builder canonical (which uses override:false / shell-wins).
  try {
    dotenv.config({ path: envFilePath, override: true });
  } catch (err) {
    process.stderr.write(
      `[outlook-cli agent] WARNING: could not load .env from ${envFilePath}: ${String(err)}\n`,
    );
  }

  // 5. Load and validate config.json.
  return loadConfigJson(configJsonPath);
}

/**
 * Load and Zod-validate config.json. Returns parsed values or null.
 * Never overwrites a malformed file — reports the path + error and returns null.
 * Exported for testing.
 */
export function loadConfigJson(configJsonPath: string): ConfigJson | null {
  if (!fs.existsSync(configJsonPath)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(configJsonPath, 'utf-8');
  } catch (err) {
    process.stderr.write(
      `[outlook-cli agent] WARNING: could not read config.json at ${configJsonPath}: ${String(err)}\n`,
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `[outlook-cli agent] WARNING: config.json at ${configJsonPath} is not valid JSON: ${String(err)}\n`,
    );
    return null;
  }

  // Check schemaVersion before full parse.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as Record<string, unknown>)['schemaVersion'] !== 1
  ) {
    process.stderr.write(
      `[outlook-cli agent] WARNING: config.json at ${configJsonPath} has an unsupported ` +
        `schemaVersion (expected 1). Skipping config.json values. ` +
        `Please update the file to schemaVersion 1.\n`,
    );
    return null;
  }

  const result = ConfigJsonSchema.safeParse(parsed);
  if (!result.success) {
    process.stderr.write(
      `[outlook-cli agent] WARNING: config.json at ${configJsonPath} failed validation: ` +
        `${result.error.message}. Skipping config.json values.\n`,
    );
    return null;
  }

  const cfg = result.data;

  // 6. Check expiry hints.
  checkExpiresAt('apiKeyExpiresAt', cfg.apiKeyExpiresAt);
  checkExpiresAt('azureKeyExpiresAt', cfg.azureKeyExpiresAt);
  checkExpiresAt('expiresAt', cfg.expiresAt);

  return cfg;
}
