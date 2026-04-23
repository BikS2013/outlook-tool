// src/agent/tui/model-store.ts
//
// Persistent store for the TUI's last-used model selection (§TUI.6.2).
//
// Behavior contract (see docs/design/project-design.md §TUI.3 + §TUI.14#9):
//   - load()  : returns null on missing file (ENOENT) or on corrupt / schema-
//               invalid JSON. Never throws. A warning is written to stderr
//               when the file is present but unusable; the file is NOT
//               deleted or overwritten (decision #9).
//   - save(m) : atomic write via temp + fsync + rename, mode 0600, parent
//               directory created 0700 if missing. Validates the input
//               shape before writing and throws TypeError on a malformed
//               SavedModel (caller bug — no silent corruption on disk).
//   - clear() : deletes the file; ENOENT is not an error (idempotent).
//
// Only sync I/O is used; no async surface.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelStore, SavedModel } from "./types";
import type { ProviderName } from "../../config/agent-config";

const FILE_VERSION = 1 as const;

const VALID_PROVIDERS: readonly ProviderName[] = [
  "openai",
  "anthropic",
  "google",
  "azure-openai",
  "azure-anthropic",
  "azure-deepseek",
] as const;

/**
 * Structural validation of a parsed JSON value (or of an in-memory
 * candidate passed to save()). Returns a freshly-constructed SavedModel
 * on success, or null when any field violates the schema.
 *
 * Never throws — the contract is "return null and let the caller warn".
 */
function validateSavedModel(o: unknown): SavedModel | null {
  if (!o || typeof o !== "object") return null;
  const obj = o as Record<string, unknown>;

  if (obj.version !== FILE_VERSION) return null;

  if (
    typeof obj.provider !== "string" ||
    !(VALID_PROVIDERS as readonly string[]).includes(obj.provider)
  ) {
    return null;
  }

  if (typeof obj.model !== "string" || obj.model.length === 0) return null;

  if (obj.temperature !== undefined) {
    if (
      typeof obj.temperature !== "number" ||
      !Number.isFinite(obj.temperature)
    ) {
      return null;
    }
  }

  if (obj.maxSteps !== undefined) {
    if (
      typeof obj.maxSteps !== "number" ||
      !Number.isInteger(obj.maxSteps) ||
      obj.maxSteps <= 0
    ) {
      return null;
    }
  }

  if (obj.systemPromptFile !== undefined) {
    if (
      typeof obj.systemPromptFile !== "string" ||
      obj.systemPromptFile.length === 0
    ) {
      return null;
    }
  }

  const ps = obj.providerSpecific;
  if (!ps || typeof ps !== "object" || Array.isArray(ps)) return null;
  for (const [k, v] of Object.entries(ps as Record<string, unknown>)) {
    if (typeof k !== "string" || typeof v !== "string") return null;
  }

  return {
    version: FILE_VERSION,
    provider: obj.provider as ProviderName,
    model: obj.model,
    temperature: obj.temperature as number | undefined,
    maxSteps: obj.maxSteps as number | undefined,
    systemPromptFile: obj.systemPromptFile as string | undefined,
    providerSpecific: Object.freeze({
      ...(ps as Record<string, string>),
    }),
  };
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

function writeAtomic(filePath: string, m: SavedModel): void {
  ensureParentDir(filePath);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmpPath, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(m, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

export function createModelStore(filePath: string): ModelStore {
  return {
    get filePath() {
      return filePath;
    },
    load(): SavedModel | null {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        console.warn(
          `model-store: cannot read ${filePath}: ${(err as Error).message}`,
        );
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.warn(
          `model-store: corrupt JSON at ${filePath} — ignoring: ${
            (err as Error).message
          }`,
        );
        return null;
      }
      const validated = validateSavedModel(parsed);
      if (!validated) {
        console.warn(`model-store: schema invalid at ${filePath} — ignoring`);
        return null;
      }
      return validated;
    },
    save(m: SavedModel): void {
      // Validate the input shape before writing. Throw if wrong (caller bug);
      // we must not persist a malformed record.
      const validated = validateSavedModel(m);
      if (!validated) {
        throw new TypeError("model-store.save: invalid SavedModel shape");
      }
      writeAtomic(filePath, validated);
    },
    clear(): void {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
  };
}
