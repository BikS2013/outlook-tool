// src/agent/tools/types.ts
//
// Shared tool-adapter types + error-routing helper. This file is the single
// point where we express the per-adapter factory signature and the
// recoverable-vs-fatal error policy.
//
// `AgentConfig` and `AgentDeps` are imported from their canonical
// modules — `AgentConfig` from `src/config/agent-config.ts` (Unit 2) and
// `AgentDeps` from `src/commands/agent.ts` (Unit 5). The stub forward-
// declarations that used to live here were replaced once those units
// landed (see Issues - Pending Items.md :: agent-stub-AgentConfig-drift).

import type { StructuredToolInterface } from '@langchain/core/tools';

import {
  ConfigurationError,
  AuthError,
  UpstreamError,
  IoError,
  OutlookCliError,
} from '../../config/errors';
import { CollisionError } from '../../http/errors';
import { UsageError } from '../../commands/list-mail';

import type { AgentConfig } from '../../config/agent-config';
import type { AgentDeps } from '../../commands/agent';

// Re-export so downstream adapters keep importing from `./types` without
// caring about which canonical module owns the declaration.
export type { AgentConfig, AgentDeps };
export type { ProviderName } from '../../config/agent-config';

// ---------------------------------------------------------------------------
// Factory signature every adapter implements.
// ---------------------------------------------------------------------------

export type ToolAdapterFactory = (
  deps: AgentDeps,
  cfg: AgentConfig,
) => StructuredToolInterface;

export interface ToolCatalogOptions {
  // Reserved for future overrides (no fields today).
}

// ---------------------------------------------------------------------------
// Recoverable vs. fatal error router (design §6, plan-003 Phase D).
//
// Contract:
//   - ConfigurationError → FATAL (rethrow; exit 3 via makeAction).
//   - AuthError          → FATAL (rethrow; exit 4).
//   - UsageError         → recoverable JSON (the LLM can retry with new args).
//   - UpstreamError      → recoverable JSON.
//   - IoError            → recoverable JSON (download_attachments relies on this;
//                          other tools never raise IoError organically).
//   - CollisionError     → recoverable JSON (create_folder idempotency feedback).
//   - Anything else      → FATAL rethrow (exit 1 via makeAction's default path).
// ---------------------------------------------------------------------------

/**
 * Route an error thrown by a `commands/*.run()` call into either a
 * model-visible JSON ToolMessage (string) or a re-raised exception. The
 * returned string is ALWAYS valid JSON when this function returns normally.
 */
export function handleToolError(err: unknown): string {
  // Fatal — rethrow so the graph aborts and exits with the right code.
  if (err instanceof ConfigurationError) {
    throw err;
  }
  if (err instanceof AuthError) {
    throw err;
  }

  // Recoverable — stringify as {error:{code,message,httpStatus?}}
  if (
    err instanceof UsageError ||
    err instanceof UpstreamError ||
    err instanceof IoError ||
    err instanceof CollisionError
  ) {
    const httpStatus =
      err instanceof UpstreamError && typeof err.httpStatus === 'number'
        ? err.httpStatus
        : null;
    return JSON.stringify({
      error: {
        code: err.code,
        message: err.message,
        httpStatus,
      },
    });
  }

  // OutlookCliError subclasses we did not list explicitly: rethrow so we do
  // not accidentally swallow a newly-introduced fatal class. Anything non-
  // CliError is a genuine bug — rethrow.
  if (err instanceof OutlookCliError) {
    throw err;
  }
  throw err;
}
