// test_scripts/agent-logging.spec.ts
//
// Unit tests for the agent's redacting logger.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgentLogger } from '../src/agent/logging';
import type { AgentConfig } from '../src/config/agent-config';

function makeCfg(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base = {
    provider: 'openai' as const,
    model: 'gpt-4o-mini',
    temperature: 0,
    maxSteps: 10,
    perToolBudgetBytes: 16384,
    systemPrompt: null,
    systemPromptFile: null,
    toolsAllowlist: null,
    allowMutations: false,
    envFilePath: null,
    verbose: false,
    interactive: false,
    providerEnv: Object.freeze({}),
  } satisfies AgentConfig;
  return Object.freeze({ ...base, ...overrides }) as AgentConfig;
}

// Build a 140+ char base64-url string with no runs of non-URL-safe chars so
// the redactString regex captures the whole thing as a single token.
const LONG_KEY = 'Aa' + 'b'.repeat(140) + 'c';
// A JWT-shaped blob: three base64url segments. Long enough (> 100 chars) that
// the redactor triggers.
const LONG_JWT =
  'eyJ' + 'A'.repeat(60) + '.' + 'B'.repeat(50) + '.' + 'C'.repeat(30);

describe('createAgentLogger — redaction on stderr', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let writes: string[] = [];

  beforeEach(() => {
    writes = [];
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        return true;
      });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('redacts API-key-shaped long strings in the message', () => {
    const logger = createAgentLogger(makeCfg());
    logger.info(`about to call with key=${LONG_KEY}`);
    const joined = writes.join('');
    expect(joined).not.toContain(LONG_KEY);
    expect(joined).toContain('[REDACTED]');
  });

  it('redacts JWT-shaped bearer tokens', () => {
    const logger = createAgentLogger(makeCfg());
    logger.warn(`authorization bearer=${LONG_JWT}`);
    const joined = writes.join('');
    expect(joined).not.toContain(LONG_JWT);
    expect(joined).toContain('[REDACTED]');
  });

  it('redacts string meta values too', () => {
    const logger = createAgentLogger(makeCfg());
    logger.info('event', { token: LONG_JWT, safe: 'ok' });
    const joined = writes.join('');
    expect(joined).not.toContain(LONG_JWT);
    expect(joined).toContain('[REDACTED]');
    expect(joined).toContain('"safe":"ok"');
  });

  it('quiet=true suppresses stderr', () => {
    const logger = createAgentLogger(makeCfg(), { quiet: true });
    logger.info('hello');
    logger.warn('warning');
    logger.error('bad');
    expect(writes.length).toBe(0);
  });
});

describe('createAgentLogger — log-file behavior', () => {
  let tmpdir: string;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-log-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('creates the log file with mode 0600 and writes redacted lines', async () => {
    const logFile = path.join(tmpdir, 'agent.log');
    const logger = createAgentLogger(makeCfg(), {
      logFilePath: logFile,
      quiet: true,
    });
    logger.info(`key=${LONG_KEY}`);
    logger.error('boom');
    await logger.close();

    expect(fs.existsSync(logFile)).toBe(true);
    const st = fs.statSync(logFile);
    // mask to permission bits; verify rw for owner only (0600).
    // eslint-disable-next-line no-bitwise
    expect(st.mode & 0o777).toBe(0o600);

    const body = fs.readFileSync(logFile, 'utf8');
    expect(body).not.toContain(LONG_KEY);
    expect(body).toContain('[REDACTED]');
    expect(body).toContain('"level":"error"');
    expect(body).toContain('"message":"boom"');
    // Two newline-separated JSON records.
    expect(body.trim().split('\n').length).toBe(2);
  });

  it('close() releases the file descriptor cleanly', async () => {
    const logFile = path.join(tmpdir, 'agent.log');
    const logger = createAgentLogger(makeCfg(), {
      logFilePath: logFile,
      quiet: true,
    });
    logger.info('one');
    await logger.close();
    // A second close() is a no-op (idempotent).
    await expect(logger.close()).resolves.toBeUndefined();
    // File is still readable after close.
    expect(fs.readFileSync(logFile, 'utf8')).toContain('"message":"one"');
  });
});
