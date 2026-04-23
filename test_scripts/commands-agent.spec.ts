// test_scripts/commands-agent.spec.ts
//
// Tests for src/commands/agent.ts — the LangGraph agent subcommand entry
// point. Validates CLI invariants, env-var precedence, auth-check behavior
// (fatal with --no-auto-reauth, warn-only otherwise), and the one-shot
// happy-path dispatch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeToolCallingModel } from 'langchain';

import * as agentCmd from '../src/commands/agent';
import { ConfigurationError, AuthError } from '../src/config/errors';
import { UsageError } from '../src/commands/list-mail';
import type { CliConfig } from '../src/config/config';
import type { OutlookClient } from '../src/http/outlook-client';
import type { SessionFile } from '../src/session/schema';

// ---------------------------------------------------------------------------
// Mocks — set up BEFORE any import that consumes them.
//
// We replace the provider registry and tool catalog so tests never need a
// real LLM SDK nor a real Outlook client. FakeToolCallingModel is a
// langchain-core fake that emits `AIMessage`s deterministically.
// ---------------------------------------------------------------------------

// Shared mutable hooks. Tests override these per-case via
// `vi.mocked(...).mockImplementation(...)`.
let fakeModel: FakeToolCallingModel = new FakeToolCallingModel({
  toolCalls: [[]],
});

// Prevent any real .env file in the cwd from polluting process.env during
// these tests — the command calls `dotenv.config()` which would otherwise
// undo `resetAgentEnv({})` for users who have a local .env on disk.
vi.mock('dotenv', () => ({
  default: { config: vi.fn(() => ({ parsed: {} })) },
  config: vi.fn(() => ({ parsed: {} })),
}));

vi.mock('../src/agent/providers/registry', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getProvider: vi.fn(() => () => fakeModel as any),
}));

vi.mock('../src/agent/tools/registry', () => ({
  buildToolCatalog: vi.fn(() => []),
}));

// The real `src/agent/system-prompt.ts` uses a CJS `require('../commands/
// list-mail')` call to sidestep a circular import. vitest's module
// transformer mis-resolves that relative path when the module graph is
// loaded through this test. We replace it with a minimal stub that returns
// the verbatim default prompt and supports `loadSystemPrompt`.
vi.mock('../src/agent/system-prompt', () => ({
  DEFAULT_SYSTEM_PROMPT: 'test-system-prompt',
  loadSystemPrompt: (inline: string | null, filePath: string | null) => {
    if (inline != null) return inline;
    if (filePath != null) return `<from-file:${filePath}>`;
    return 'test-system-prompt';
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FUTURE_ISO = '2099-04-21T12:00:00.000Z';
const PAST_ISO = '2000-01-01T00:00:00.000Z';
const JWT_SHAPED_TOKEN = 'aaaaaaaaaa.bbbbbbbbbb.cccccccccc';

function makeSession(expiresAt: string): SessionFile {
  return {
    version: 1,
    capturedAt: '2026-04-21T12:00:00.000Z',
    account: {
      upn: 'alice@contoso.com',
      puid: '1234567890',
      tenantId: 'tenant-id-abc',
    },
    bearer: {
      token: JWT_SHAPED_TOKEN,
      expiresAt,
      audience: 'https://outlook.office.com',
      scopes: ['Mail.Read'],
    },
    cookies: [
      {
        name: 'SessionCookie',
        value: 'outlook-cookie-value',
        domain: '.outlook.office.com',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      },
    ],
    anchorMailbox: 'PUID:1234567890@tenant-id-abc',
  };
}

function makeConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  const base: CliConfig = {
    httpTimeoutMs: 30_000,
    loginTimeoutMs: 300_000,
    chromeChannel: 'chrome',
    sessionFilePath: '/tmp/does-not-exist/session.json',
    profileDir: '/tmp/does-not-exist/profile',
    tz: 'UTC',
    outputMode: 'json',
    listMailTop: 10,
    listMailFolder: 'Inbox',
    bodyMode: 'text',
    calFrom: 'now',
    calTo: 'now + 7d',
    quiet: true,
    noAutoReauth: false,
    ...overrides,
  };
  return Object.freeze(base);
}

function makeDeps(
  overrides: Partial<agentCmd.AgentDeps> = {},
): agentCmd.AgentDeps {
  const session = makeSession(FUTURE_ISO);
  // Minimal stub client — `/me` succeeds, everything else throws.
  const stubClient: OutlookClient = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: vi.fn(async () => ({ EmailAddress: 'alice@contoso.com' }) as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    post: vi.fn(async () => ({}) as any),
  } as unknown as OutlookClient;
  return {
    config: makeConfig(),
    sessionPath: '/tmp/session.json',
    loadSession: async () => session,
    saveSession: async () => {
      /* no-op */
    },
    doAuthCapture: async () => session,
    createClient: () => stubClient,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scrub every OUTLOOK_AGENT_* env var and reinstate just the ones the test
 * needs. Keeps tests hermetic when the developer's shell has real creds.
 */
function resetAgentEnv(set: Record<string, string | undefined> = {}): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('OUTLOOK_AGENT_')) {
      delete process.env[k];
    }
  }
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('commands/agent.run — usage validation', () => {
  beforeEach(() => {
    resetAgentEnv({
      OUTLOOK_AGENT_PROVIDER: 'openai',
      OUTLOOK_AGENT_MODEL: 'gpt-test',
      OUTLOOK_AGENT_OPENAI_API_KEY: 'sk-test',
    });
    fakeModel = new FakeToolCallingModel({ toolCalls: [[]] });
  });

  afterEach(() => {
    resetAgentEnv();
    vi.clearAllMocks();
  });

  it('throws UsageError when not interactive and prompt is null', async () => {
    await expect(agentCmd.run(makeDeps(), null, { quiet: true })).rejects.toThrow(
      UsageError,
    );
  });

  it('throws UsageError when not interactive and prompt is empty string', async () => {
    await expect(agentCmd.run(makeDeps(), '', { quiet: true })).rejects.toThrow(
      UsageError,
    );
  });

  it('throws UsageError when not interactive and prompt is whitespace', async () => {
    await expect(
      agentCmd.run(makeDeps(), '   \t\n', { quiet: true }),
    ).rejects.toThrow(UsageError);
  });
});

describe('commands/agent.run — config validation', () => {
  beforeEach(() => {
    resetAgentEnv({}); // no provider env — expect failure
    fakeModel = new FakeToolCallingModel({ toolCalls: [[]] });
  });

  afterEach(() => {
    resetAgentEnv();
    vi.clearAllMocks();
  });

  it('throws ConfigurationError when OUTLOOK_AGENT_PROVIDER is absent', async () => {
    try {
      await agentCmd.run(makeDeps(), 'hello', { quiet: true });
      throw new Error('expected ConfigurationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      expect((err as ConfigurationError).missingSetting).toBe(
        'OUTLOOK_AGENT_PROVIDER',
      );
    }
  });
});

describe('commands/agent.run — auth-check + --no-auto-reauth', () => {
  beforeEach(() => {
    resetAgentEnv({
      OUTLOOK_AGENT_PROVIDER: 'openai',
      OUTLOOK_AGENT_MODEL: 'gpt-test',
      OUTLOOK_AGENT_OPENAI_API_KEY: 'sk-test',
    });
    fakeModel = new FakeToolCallingModel({ toolCalls: [[]] });
  });

  afterEach(() => {
    resetAgentEnv();
    vi.clearAllMocks();
  });

  it('throws AuthError when session missing and --no-auto-reauth is set', async () => {
    const deps = makeDeps({
      config: makeConfig({ noAutoReauth: true }),
      loadSession: async () => null, // → auth-check status: 'missing'
    });
    try {
      await agentCmd.run(deps, 'hello', { quiet: true, noAutoReauth: true });
      throw new Error('expected AuthError');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe('AUTH_NO_REAUTH');
    }
  });

  it('throws AuthError when session expired and --no-auto-reauth is set', async () => {
    const deps = makeDeps({
      config: makeConfig({ noAutoReauth: true }),
      loadSession: async () => makeSession(PAST_ISO), // expired → status 'expired'
    });
    try {
      await agentCmd.run(deps, 'hello', { quiet: true, noAutoReauth: true });
      throw new Error('expected AuthError');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe('AUTH_NO_REAUTH');
    }
  });

  it('proceeds (warns only) when session expired but --no-auto-reauth is false', async () => {
    const deps = makeDeps({
      config: makeConfig({ noAutoReauth: false }),
      loadSession: async () => makeSession(PAST_ISO),
    });
    // fakeModel returns a final AIMessage on first turn → run completes.
    fakeModel = new FakeToolCallingModel({ toolCalls: [[]] });

    const res = await agentCmd.run(deps, 'hello world', { quiet: true });
    expect(res).toBeDefined();
    expect((res as agentCmd.AgentResult).meta.terminatedBy).toBe('final');
  });
});

describe('commands/agent.run — one-shot happy path', () => {
  beforeEach(() => {
    resetAgentEnv({
      OUTLOOK_AGENT_PROVIDER: 'openai',
      OUTLOOK_AGENT_MODEL: 'gpt-test',
      OUTLOOK_AGENT_OPENAI_API_KEY: 'sk-test',
    });
    fakeModel = new FakeToolCallingModel({ toolCalls: [[]] });
  });

  afterEach(() => {
    resetAgentEnv();
    vi.clearAllMocks();
  });

  it('returns an AgentResult with terminatedBy=final', async () => {
    const deps = makeDeps();
    const result = (await agentCmd.run(deps, 'hello world', {
      quiet: true,
    })) as agentCmd.AgentResult;
    expect(result).toBeDefined();
    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.meta.terminatedBy).toBe('final');
    expect(result.steps).toEqual([]);
  });

  it('honors --interactive + prompt by running interactive (no throw)', async () => {
    // In interactive mode with a prompt supplied we expect a stderr warning
    // but not a throw. We short-circuit the REPL by stubbing runInteractive
    // to resolve immediately via the mocked model returning no tool calls.
    // `runInteractive` reads from process.stdin; to keep the test hermetic
    // we write `/exit` to a PassThrough and swap it in.
    const { PassThrough } = await import('node:stream');
    const stdinReal = process.stdin;
    const ptyIn = new PassThrough();
    // Node's `process.stdin` is readonly but monkey-patch with
    // defineProperty — this mirrors what `agent-run.spec.ts` does indirectly
    // via the `stdin` arg (we don't have that option here because
    // `commands/agent.run` doesn't surface it). Luckily `runInteractive`
    // defaults to process.stdin/stdout only when no arg is given.
    Object.defineProperty(process, 'stdin', {
      value: ptyIn,
      configurable: true,
    });
    const stdoutWritten: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: string | Buffer) => {
      stdoutWritten.push(
        typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
      );
      return true;
    };

    const exitSpy = vi
      .spyOn(process, 'exit')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(((_code?: number) => undefined) as any);
    try {
      const p = agentCmd.run(makeDeps(), 'ignored', {
        interactive: true,
        quiet: true,
      });
      // Drive the REPL to exit cleanly.
      ptyIn.write('/exit\n');
      ptyIn.end();
      const result = await p;
      expect(result).toBeUndefined();
    } finally {
      exitSpy.mockRestore();
      Object.defineProperty(process, 'stdin', {
        value: stdinReal,
        configurable: true,
      });
      (process.stdout.write as unknown) = origWrite;
    }
  });
});
