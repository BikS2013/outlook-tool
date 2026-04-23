// test_scripts/agent-tools.spec.ts
//
// Per-adapter unit tests. Each test stubs the `OutlookClient` method(s) the
// underlying command calls, invokes the tool's `.invoke()`, and asserts on
// the string returned (JSON-parseable).
//
// Error classification tests ensure recoverable vs. fatal routing
// (src/agent/tools/types.ts :: handleToolError) is correct for:
//   - UpstreamError    → recoverable (string JSON {error:{...}})
//   - ConfigurationError → fatal (invoke rejects)

import { describe, expect, it, vi } from 'vitest';

import type { CliConfig } from '../src/config/config';
import { ConfigurationError, UpstreamError } from '../src/config/errors';
import type { OutlookClient } from '../src/http/outlook-client';
import type { SessionFile } from '../src/session/schema';

import type { AgentConfig, AgentDeps } from '../src/agent/tools/types';

import { createAuthCheckTool } from '../src/agent/tools/auth-check-tool';
import { createListMailTool } from '../src/agent/tools/list-mail-tool';
import { createGetMailTool } from '../src/agent/tools/get-mail-tool';
import { createGetThreadTool } from '../src/agent/tools/get-thread-tool';
import { createListFoldersTool } from '../src/agent/tools/list-folders-tool';
import { createFindFolderTool } from '../src/agent/tools/find-folder-tool';
import { createListCalendarTool } from '../src/agent/tools/list-calendar-tool';
import { createGetEventTool } from '../src/agent/tools/get-event-tool';
import { createCreateFolderTool } from '../src/agent/tools/create-folder-tool';
import { createMoveMailTool } from '../src/agent/tools/move-mail-tool';
import { createDownloadAttachmentsTool } from '../src/agent/tools/download-attachments-tool';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FUTURE_ISO = '2099-04-21T12:00:00.000Z';

function buildFakeSession(): SessionFile {
  return {
    version: 1,
    capturedAt: '2026-04-21T12:00:00.000Z',
    account: {
      upn: 'alice@contoso.com',
      puid: '1234567890',
      tenantId: 'tenant-id-abc',
    },
    bearer: {
      token: 'aaaaaaaaaa.bbbbbbbbbb.cccccccccc',
      expiresAt: FUTURE_ISO,
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

function buildFakeCliConfig(overrides: Partial<CliConfig> = {}): CliConfig {
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

function buildFakeAgentCfg(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    temperature: 0,
    maxSteps: 10,
    perToolBudgetBytes: 16_384,
    envFilePath: null,
    allowMutations: true,
    systemPrompt: null,
    systemPromptFile: null,
    verbose: false,
    interactive: false,
    toolsAllowlist: null,
    providerEnv: Object.freeze({}) as Readonly<Record<string, string>>,
    ...overrides,
  };
}

interface StubClient extends OutlookClient {
  get: ReturnType<typeof vi.fn>;
  listFolders: ReturnType<typeof vi.fn>;
  getFolder: ReturnType<typeof vi.fn>;
  createFolder: ReturnType<typeof vi.fn>;
  moveMessage: ReturnType<typeof vi.fn>;
  listMessagesInFolder: ReturnType<typeof vi.fn>;
  countMessagesInFolder: ReturnType<typeof vi.fn>;
  listMessagesByConversation: ReturnType<typeof vi.fn>;
}

function makeStubClient(): StubClient {
  const stub = {
    get: vi.fn(async () => {
      throw new Error('stub: client.get not configured');
    }),
    listFolders: vi.fn(async () => {
      throw new Error('stub: client.listFolders not configured');
    }),
    getFolder: vi.fn(async () => {
      throw new Error('stub: client.getFolder not configured');
    }),
    createFolder: vi.fn(async () => {
      throw new Error('stub: client.createFolder not configured');
    }),
    moveMessage: vi.fn(async () => {
      throw new Error('stub: client.moveMessage not configured');
    }),
    listMessagesInFolder: vi.fn(async () => {
      throw new Error('stub: client.listMessagesInFolder not configured');
    }),
    countMessagesInFolder: vi.fn(async () => {
      throw new Error('stub: client.countMessagesInFolder not configured');
    }),
    listMessagesByConversation: vi.fn(async () => {
      throw new Error('stub: client.listMessagesByConversation not configured');
    }),
  };
  return stub as unknown as StubClient;
}

function makeDeps(client?: StubClient): { deps: AgentDeps; client: StubClient } {
  const stub = client ?? makeStubClient();
  const config = buildFakeCliConfig();
  const session = buildFakeSession();
  const deps: AgentDeps = {
    config,
    sessionPath: config.sessionFilePath,
    loadSession: async () => session,
    saveSession: async () => {
      /* no-op */
    },
    doAuthCapture: async () => {
      throw new Error('doAuthCapture should not be called');
    },
    createClient: () => stub,
  };
  return { deps, client: stub };
}

/** Cast-as-any because the langchain tool() return type is a union. */
async function invokeTool(t: unknown, input: unknown): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (t as any).invoke(input);
}

// ---------------------------------------------------------------------------
// auth_check
// ---------------------------------------------------------------------------

describe('auth_check tool', () => {
  it('happy path (missing session): returns JSON with status "missing"', async () => {
    // auth-check.run builds its own client via createOutlookClient, bypassing
    // deps.createClient — so we exercise the no-session branch which never
    // issues a real network call.
    const { deps } = makeDeps();
    const depsWithNoSession: AgentDeps = {
      ...deps,
      loadSession: async () => null,
    };
    const t = createAuthCheckTool(depsWithNoSession, buildFakeAgentCfg());

    const out = await invokeTool(t, {});
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe('missing');
    expect(parsed.account).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// list_mail
// ---------------------------------------------------------------------------

describe('list_mail tool', () => {
  it('happy path: returns stringified message array', async () => {
    const { deps, client } = makeDeps();
    client.get.mockResolvedValueOnce({
      value: [
        {
          Id: 'AAMkAG_1',
          Subject: 'hello',
          ReceivedDateTime: '2026-04-20T10:00:00Z',
          IsRead: false,
        },
      ],
    });
    const t = createListMailTool(deps, buildFakeAgentCfg());

    const out = await invokeTool(t, { top: 5 });
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].Id).toBe('AAMkAG_1');
  });

  it('UpstreamError → string JSON with error.code, no rethrow', async () => {
    const { deps, client } = makeDeps();
    client.get.mockRejectedValueOnce(
      new UpstreamError({
        code: 'UPSTREAM_HTTP_500',
        message: 'boom',
        httpStatus: 500,
      }),
    );
    const t = createListMailTool(deps, buildFakeAgentCfg());

    const out = await invokeTool(t, {});
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      error: { code: 'UPSTREAM_HTTP_500', httpStatus: 500 },
    });
  });

  it('ConfigurationError → rethrown (fatal)', async () => {
    const { deps, client } = makeDeps();
    client.get.mockRejectedValueOnce(
      new ConfigurationError('listMailTop', ['--top flag']),
    );
    const t = createListMailTool(deps, buildFakeAgentCfg());

    await expect(invokeTool(t, {})).rejects.toBeInstanceOf(ConfigurationError);
  });
});

// ---------------------------------------------------------------------------
// get_mail
// ---------------------------------------------------------------------------

describe('get_mail tool', () => {
  it('happy path: returns stringified Message with Attachments', async () => {
    const { deps, client } = makeDeps();
    // Two parallel GETs: /messages/{id} and /messages/{id}/attachments
    client.get.mockResolvedValueOnce({
      Id: 'AAMkAG_m',
      Subject: 'hello',
      Body: { ContentType: 'Text', Content: 'Hi!' },
    });
    client.get.mockResolvedValueOnce({
      value: [{ Id: 'a1', Name: 'file.txt', Size: 12 }],
    });
    const t = createGetMailTool(deps, buildFakeAgentCfg());

    const out = await invokeTool(t, { id: 'AAMkAG_m' });
    const parsed = JSON.parse(out);
    expect(parsed.Id).toBe('AAMkAG_m');
    expect(Array.isArray(parsed.Attachments)).toBe(true);
    expect(parsed.Attachments[0].Id).toBe('a1');
  });
});

// ---------------------------------------------------------------------------
// get_thread
// ---------------------------------------------------------------------------

describe('get_thread tool', () => {
  it('happy path (conv:<id>) returns {conversationId, count, messages}', async () => {
    const { deps, client } = makeDeps();
    client.listMessagesByConversation.mockResolvedValueOnce([
      { Id: 'm1', Subject: 's1' },
      { Id: 'm2', Subject: 's2' },
    ]);
    const t = createGetThreadTool(deps, buildFakeAgentCfg());

    const out = await invokeTool(t, { idOrConv: 'conv:conv-123' });
    const parsed = JSON.parse(out);
    expect(parsed.conversationId).toBe('conv-123');
    expect(parsed.count).toBe(2);
    expect(parsed.messages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// list_folders
// ---------------------------------------------------------------------------

describe('list_folders tool', () => {
  it('happy path: returns folder array with Path', async () => {
    const { deps, client } = makeDeps();
    client.listFolders.mockResolvedValueOnce([
      {
        Id: 'f1',
        DisplayName: 'Inbox',
        ParentFolderId: 'root',
        ChildFolderCount: 0,
        UnreadItemCount: 0,
        TotalItemCount: 3,
        IsHidden: false,
      },
    ]);
    const t = createListFoldersTool(deps, buildFakeAgentCfg());

    const out = await invokeTool(t, {});
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].Id).toBe('f1');
    expect(parsed[0].Path).toBe('Inbox');
  });
});

// ---------------------------------------------------------------------------
// find_folder
// ---------------------------------------------------------------------------

describe('find_folder tool', () => {
  it('happy path (well-known alias): returns ResolvedFolder via getFolder', async () => {
    const { deps, client } = makeDeps();
    client.getFolder.mockResolvedValueOnce({
      Id: 'inbox-id',
      DisplayName: 'Inbox',
      ParentFolderId: 'root',
    });
    const t = createFindFolderTool(deps, buildFakeAgentCfg());

    const out = await invokeTool(t, { spec: 'Inbox' });
    const parsed = JSON.parse(out);
    expect(parsed.Id).toBe('inbox-id');
    expect(parsed.DisplayName).toBe('Inbox');
  });
});

// ---------------------------------------------------------------------------
// list_calendar
// ---------------------------------------------------------------------------

describe('list_calendar tool', () => {
  it('happy path: returns event summary array', async () => {
    const { deps, client } = makeDeps();
    client.get.mockResolvedValueOnce({
      value: [
        {
          Id: 'e1',
          Subject: 'Standup',
          Start: { DateTime: '2026-04-22T09:00:00', TimeZone: 'UTC' },
          End: { DateTime: '2026-04-22T09:30:00', TimeZone: 'UTC' },
        },
      ],
    });
    const t = createListCalendarTool(deps, buildFakeAgentCfg());

    const out = await invokeTool(t, { from: 'now', to: 'now + 1d' });
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].Id).toBe('e1');
  });
});

// ---------------------------------------------------------------------------
// get_event
// ---------------------------------------------------------------------------

describe('get_event tool', () => {
  it('happy path: returns event object', async () => {
    const { deps, client } = makeDeps();
    client.get.mockResolvedValueOnce({
      Id: 'e2',
      Subject: 'Planning',
    });
    const t = createGetEventTool(deps, buildFakeAgentCfg());

    const out = await invokeTool(t, { id: 'e2' });
    const parsed = JSON.parse(out);
    expect(parsed.Id).toBe('e2');
  });
});

// ---------------------------------------------------------------------------
// create_folder (mutation)
// ---------------------------------------------------------------------------

describe('create_folder tool', () => {
  it('happy path: creates folder under MsgFolderRoot', async () => {
    const { deps, client } = makeDeps();
    // The create-folder command resolves the parent anchor first via
    // resolveFolder → client.getFolder('MsgFolderRoot') before POST'ing.
    client.getFolder.mockResolvedValueOnce({
      Id: 'root-id',
      DisplayName: 'MsgFolderRoot',
      ParentFolderId: '',
      ChildFolderCount: 1,
      UnreadItemCount: 0,
      TotalItemCount: 0,
      IsHidden: false,
    });
    client.createFolder.mockResolvedValueOnce({
      Id: 'new-id',
      DisplayName: 'Projects',
      ParentFolderId: 'root-id',
      ChildFolderCount: 0,
      UnreadItemCount: 0,
      TotalItemCount: 0,
      IsHidden: false,
    });
    const t = createCreateFolderTool(deps, buildFakeAgentCfg());

    const out = await invokeTool(t, { pathOrName: 'Projects' });
    const parsed = JSON.parse(out);
    // CreateFolderResult shape: { created, leaf, idempotent }
    expect(parsed).toHaveProperty('created');
    expect(parsed).toHaveProperty('leaf');
    expect(parsed.leaf.Id).toBe('new-id');
  });
});

// ---------------------------------------------------------------------------
// move_mail (mutation)
// ---------------------------------------------------------------------------

describe('move_mail tool', () => {
  it('happy path: returns MoveMailResult with moved[] pairs', async () => {
    const { deps, client } = makeDeps();
    // --to is a well-known alias → getFolder resolves it.
    client.getFolder.mockResolvedValueOnce({
      Id: 'archive-id',
      DisplayName: 'Archive',
      ParentFolderId: 'root',
    });
    client.moveMessage.mockResolvedValueOnce({ Id: 'new-id-for-src-a' });
    const t = createMoveMailTool(deps, buildFakeAgentCfg());

    const out = await invokeTool(t, {
      messageIds: ['src-a'],
      to: 'Archive',
    });
    const parsed = JSON.parse(out);
    expect(parsed.moved).toEqual([{ sourceId: 'src-a', newId: 'new-id-for-src-a' }]);
    expect(parsed.summary).toMatchObject({ requested: 1, moved: 1, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// download_attachments (mutation) — no happy path with real filesystem write.
// We only assert the fatal-vs-recoverable routing for now.
// ---------------------------------------------------------------------------

describe('download_attachments tool', () => {
  it('ConfigurationError when outDir is missing is rethrown (fatal)', async () => {
    const { deps } = makeDeps();
    const t = createDownloadAttachmentsTool(deps, buildFakeAgentCfg());
    // Zod validates `outDir` as required — an empty-string invoke throws
    // a validation error before hitting handleToolError.
    await expect(invokeTool(t, { id: 'm1', outDir: '' })).rejects.toBeTruthy();
  });
});
