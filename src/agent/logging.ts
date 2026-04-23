// src/agent/logging.ts
//
// Single log sink for the agent. Writes redacted lines to stderr (unless
// --quiet), and optionally appends to a --log-file (mode 0600). Step-trace
// entries are emitted only when verbose is on for stderr, and always to the
// log file when it is open.
//
// Every string argument and every string value inside `meta` is passed
// through `redactString` from `src/util/redact.ts` BEFORE any sink write —
// this is the mandatory redaction boundary described in design §10.

import { existsSync, openSync, closeSync, writeSync } from 'node:fs';
import type { AgentConfig } from '../config/agent-config';
import type { AgentStep } from './run';
import { redactString } from '../util/redact';
import { IoError } from '../config/errors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum sanity floor for step-trace truncation (even if perToolBudgetBytes
 *  is tiny we still want a legible debug line). */
const MIN_TRACE_BYTES = 2048;

/** Hard cap on any single meta field's serialized length. The redactString
 *  helper protects the content; this cap protects the log throughput. */
const MAX_META_STRING = 16 * 1024;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface AgentLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  /** Verbose-mode step trace — emitted to stderr only when cfg.verbose is on,
   *  but always written to the log file when one is open. */
  step(s: AgentStep): void;
  close(): Promise<void>;
}

export interface CreateAgentLoggerOpts {
  /** Absolute path for the JSON-line log file (mode 0600). Null/undefined
   *  disables file logging. */
  logFilePath?: string | null;
  /** When true, stderr is suppressed. File logging is unaffected. */
  quiet?: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentLogger(
  cfg: AgentConfig,
  opts: CreateAgentLoggerOpts = {},
): AgentLogger {
  const quiet = opts.quiet === true;
  const logFilePath = opts.logFilePath ?? null;
  const perToolBudget = Math.max(
    MIN_TRACE_BYTES,
    cfg.perToolBudgetBytes ?? MIN_TRACE_BYTES,
  );
  const verbose = cfg.verbose === true;

  let fd: number | null = null;
  function openFile(): number {
    if (fd != null) return fd;
    try {
      // 'a' with 0o600 — IoError on any EACCES / ENOENT / EISDIR.
      fd = openSync(logFilePath!, 'a', 0o600);
      return fd;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'IO';
      throw new IoError({
        code: 'IO_LOG_WRITE_FAILED',
        message: `agent log file could not be opened (${code}): ${logFilePath}`,
        path: logFilePath ?? undefined,
        cause: err,
      });
    }
  }

  function redactMeta(
    meta: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (meta == null) return meta;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      out[k] = redactValue(v);
    }
    return out;
  }

  function emit(
    level: 'info' | 'warn' | 'error' | 'debug',
    msg: string,
    meta?: Record<string, unknown>,
  ): void {
    const redactedMsg = redactString(msg);
    const redactedMeta = redactMeta(meta);
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      message: redactedMsg,
    };
    if (redactedMeta) Object.assign(record, redactedMeta);
    const line = JSON.stringify(record);

    // stderr — suppressed when quiet, and debug suppressed unless verbose.
    if (!quiet && (level !== 'debug' || verbose)) {
      process.stderr.write(line + '\n');
    }

    // Log file — always (when set), regardless of quiet.
    if (logFilePath) {
      const handle = openFile();
      try {
        writeSync(handle, line + '\n');
      } catch (err) {
        throw new IoError({
          code: 'IO_LOG_WRITE_FAILED',
          message: `agent log file write failed: ${logFilePath}`,
          path: logFilePath,
          cause: err,
        });
      }
    }
  }

  function formatStep(s: AgentStep): string {
    const idx = s.index;
    if (s.tool) {
      const argsJson = truncate(safeJson(s.args), perToolBudget);
      const resultJson =
        s.result !== undefined
          ? ' result=' + truncate(safeJson(s.result), perToolBudget)
          : '';
      return `[step ${idx}] tool=${s.tool} args=${argsJson}${resultJson}`;
    }
    // Pure-reasoning or final-answer step.
    const reasoning = s.reasoning ?? '';
    const first200 = reasoning.length > 200 ? reasoning.slice(0, 200) : reasoning;
    return `[step ${idx}] answer=${first200}`;
  }

  return {
    info(msg, meta) {
      emit('info', msg, meta);
    },
    warn(msg, meta) {
      emit('warn', msg, meta);
    },
    error(msg, meta) {
      emit('error', msg, meta);
    },
    step(s) {
      const line = formatStep(s);
      // stderr only when verbose — file always (when set).
      if (!quiet && verbose) {
        process.stderr.write(redactString(line) + '\n');
      }
      if (logFilePath) {
        const handle = openFile();
        const record = JSON.stringify({
          ts: new Date().toISOString(),
          level: 'debug',
          message: redactString(line),
          stepIndex: s.index,
          tool: s.tool ?? null,
        });
        try {
          writeSync(handle, record + '\n');
        } catch (err) {
          throw new IoError({
            code: 'IO_LOG_WRITE_FAILED',
            message: `agent log file write failed: ${logFilePath}`,
            path: logFilePath,
            cause: err,
          });
        }
      }
    },
    async close() {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          // swallow — closing after a write error would only compound it.
        }
        fd = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers (non-exported)
// ---------------------------------------------------------------------------

/** Recursively redact string values inside meta. Non-strings pass through. */
function redactValue(v: unknown): unknown {
  if (typeof v === 'string') {
    const redacted = redactString(v);
    return redacted.length > MAX_META_STRING
      ? redacted.slice(0, MAX_META_STRING) + '…[truncated]'
      : redacted;
  }
  if (Array.isArray(v)) {
    return v.map(redactValue);
  }
  if (v != null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactValue(inner);
    }
    return out;
  }
  return v;
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…[truncated]';
}

// Dead-store reference to silence "unused" warnings on existsSync under some
// tsc configurations; the actual open happens lazily above. Keeping the
// import avoids bundler-specific behavior diverging between ts-node and tsc.
void existsSync;
