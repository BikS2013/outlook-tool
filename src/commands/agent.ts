// src/commands/agent.ts
//
// Agent subcommand entry point. Orchestrates dotenv → config load →
// auth-check → system-prompt resolution → provider factory → tool catalog
// → runner (one-shot or interactive). This is the single CLI-layer binding
// for the LangGraph ReAct agent (Plan 003 Phase G).
//
// Design references:
//   - docs/design/project-design.md §1 (Control flow diagram)
//   - docs/design/project-design.md §2 (Module layout)
//   - docs/design/plan-003-langgraph-agent.md Phase G
//
// This module MUST call `dotenv.config(...)` BEFORE `loadAgentConfig` reads
// process.env. `cli.ts` deliberately does not load dotenv so that every
// agent-specific env read is observable here.

import * as path from 'node:path';
import * as dotenv from 'dotenv';

import type { CliConfig } from '../config/config';
import type { SessionFile } from '../session/schema';
import type { OutlookClient } from '../http/outlook-client';

import {
  loadAgentConfig,
  type AgentConfig,
  type AgentConfigFlags,
} from '../config/agent-config';
import { AuthError } from '../config/errors';
import { UsageError } from './list-mail';
import { loadSystemPrompt } from '../agent/system-prompt';
import { getProvider } from '../agent/providers/registry';
import { buildToolCatalog } from '../agent/tools/registry';
import { createAgentLogger } from '../agent/logging';
import {
  runOneShot,
  runInteractive,
  type AgentResult,
  type AgentStep,
  type AgentUsage,
  type AgentMeta,
} from '../agent/run';
import * as authCheck from './auth-check';

// Re-export result types for consumers that import via this module.
export type { AgentResult, AgentStep, AgentUsage, AgentMeta };
export type { AgentConfig };

// ---------------------------------------------------------------------------
// Public types (design §3)
// ---------------------------------------------------------------------------

/**
 * Structural extension of `CommandDeps` (see `src/cli.ts`). Kept local to
 * this module so tests can construct it without importing `cli.ts` (which
 * would pull in commander + the entire subcommand registry).
 */
export interface AgentDeps {
  config: CliConfig;
  sessionPath: string;
  loadSession: (p: string) => Promise<SessionFile | null>;
  saveSession: (p: string, s: SessionFile) => Promise<void>;
  doAuthCapture: () => Promise<SessionFile>;
  createClient: (s: SessionFile) => OutlookClient;
}

/**
 * Options accepted by the agent command. A superset of
 * `AgentConfigFlags` (provider/model/etc. — the config loader owns those)
 * plus a handful of globals that Unit 6 forwards through from commander
 * (`--log-file`, `--quiet`, `--no-auto-reauth`).
 */
export interface AgentOptions extends AgentConfigFlags {
  /** Path forwarded from the global `--log-file` flag. */
  logFile?: string;
  /** Inherited from the global `--no-auto-reauth` flag (deps.config.noAutoReauth
   *  is the source of truth — this is redundant but convenient for tests). */
  noAutoReauth?: boolean;
  /** Inherited from the global `--quiet` flag. */
  quiet?: boolean;
}

// ---------------------------------------------------------------------------
// run()
// ---------------------------------------------------------------------------

/**
 * Entry point for the `agent` subcommand.
 *
 * Returns:
 *   - `AgentResult` in one-shot mode.
 *   - `void` in interactive mode (the REPL has already drained stdout).
 *
 * Throws:
 *   - `UsageError` (exit 2) on invalid argv (prompt missing without
 *     `--interactive`, prompt provided with `--interactive` — the latter is
 *     a warning, not a throw).
 *   - `ConfigurationError` (exit 3) on missing mandatory env vars (provider,
 *     model, provider-specific keys).
 *   - `AuthError` (exit 4) when `--no-auto-reauth` is set and the cached
 *     session is expired/rejected.
 *   - `UpstreamError` (exit 5) / `IoError` (exit 6) via tool adapters.
 */
export async function run(
  deps: AgentDeps,
  prompt: string | null,
  opts: AgentOptions,
): Promise<AgentResult | void> {
  // 1. Load .env BEFORE any env reads. If the user passed an explicit path,
  //    verify it exists (dotenv treats a missing file as a silent no-op, so
  //    the user's typo would otherwise be lost). `override: false` — process
  //    env always wins.
  if (typeof opts.envFile === 'string' && opts.envFile !== '') {
    const abs = path.resolve(opts.envFile);
    dotenv.config({ path: abs, override: false });
  } else {
    // Default cwd/.env lookup; silent on absence per dotenv's default.
    dotenv.config({ override: false });
  }

  // 2. Resolve config. `loadAgentConfig` validates --env-file existence
  //    (independently of step 1) and enforces precedence + mandatory rows.
  const cfg: AgentConfig = loadAgentConfig(opts);

  // 3. Validate CLI invariants. Must come AFTER config load so env-file
  //    issues surface as ConfigurationError (exit 3) rather than usage (2).
  const hasPrompt = typeof prompt === 'string' && prompt.trim() !== '';
  if (!cfg.interactive && !hasPrompt) {
    throw new UsageError(
      'agent: a prompt is required unless --interactive is set',
    );
  }
  if (cfg.interactive && hasPrompt) {
    // Non-fatal: we honor --interactive and ignore the positional arg.
    // `quiet` suppresses this nudge.
    if (opts.quiet !== true) {
      process.stderr.write(
        'agent: --interactive is set; ignoring positional prompt\n',
      );
    }
  }

  // 4. Logger. Funnels every string + meta value through redactString.
  const logger = createAgentLogger(cfg, {
    logFilePath: opts.logFile ?? null,
    quiet: opts.quiet === true,
  });

  try {
    // 5. Auth-check. Never opens the browser here — we rely on
    //    `createClient(onReauthNeeded=doAuthCapture)` to do that on the
    //    first tool call. If --no-auto-reauth is set AND the session is
    //    not ok, this is the correct place to fail fast.
    const authResult = await authCheck.run(deps);
    if (authResult.status !== 'ok') {
      if (deps.config.noAutoReauth) {
        throw new AuthError(
          'AUTH_NO_REAUTH',
          `auth-check returned status="${authResult.status}"; --no-auto-reauth is set`,
        );
      }
      logger.warn('agent.auth-check.non-ok', {
        status: authResult.status,
        note: 'will attempt re-auth on first tool call',
      });
    }

    // 6. System prompt.
    const systemPrompt = loadSystemPrompt(cfg.systemPrompt, cfg.systemPromptFile);

    // 7. Model.
    const providerFactory = getProvider(cfg.provider);
    const model = providerFactory(cfg);

    // 8. Tool catalog.
    const tools = buildToolCatalog(deps, cfg);

    // 9. Startup line.
    logger.info('agent: ready', {
      provider: cfg.provider,
      model: cfg.model,
      tools: tools.map((t) => t.name),
      allowMutations: cfg.allowMutations,
      maxSteps: cfg.maxSteps,
    });

    // 10. Dispatch.
    if (cfg.interactive) {
      await runInteractive({ model, tools, systemPrompt, cfg, logger });
      return;
    }
    // Non-interactive path: prompt is guaranteed non-null here by the
    // validation above.
    return await runOneShot({
      model,
      tools,
      systemPrompt,
      cfg,
      prompt: prompt as string,
      logger,
    });
  } finally {
    await logger.close();
  }
}
