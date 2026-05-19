// test_scripts/commands-list-mail-sender.spec.ts
//
// Tests sender filters on `list-mail`: --from-address and --from-name.

import { describe, it, expect, vi } from 'vitest';

import { run, UsageError } from '../src/commands/list-mail';
import type { CliConfig } from '../src/config/config';
import type { OutlookClient } from '../src/http/outlook-client';
import type { MessageSummary, ODataListResponse } from '../src/http/types';
import type { SessionFile } from '../src/session/schema';

const CONFIG = {
  httpTimeoutMs: 30000,
  loginTimeoutMs: 300000,
  chromeChannel: 'chrome',
  sessionFilePath: '/tmp/session.json',
  profileDir: '/tmp/profile',
  tz: 'UTC',
  outputMode: 'json',
  listMailTop: 10,
  listMailFolder: 'Inbox',
  bodyMode: 'text',
  calFrom: 'now',
  calTo: 'now + 7d',
  quiet: true,
  noAutoReauth: true,
} as unknown as CliConfig;

const SESSION: SessionFile = {
  version: 1,
  capturedAt: '2026-04-21T12:00:00.000Z',
  account: { upn: 'a@b', puid: 'p', tenantId: 't' },
  bearer: {
    token: 'x.y.z',
    expiresAt: '2099-04-21T12:00:00.000Z',
    audience: 'https://outlook.office.com',
    scopes: [],
  },
  cookies: [],
  anchorMailbox: 'PUID:p@t',
};

function makeMessage(id: string): MessageSummary {
  return {
    Id: id,
    Subject: id,
    ReceivedDateTime: '2026-04-01T00:00:00Z',
    HasAttachments: false,
    IsRead: false,
    WebLink: '',
    From: {
      EmailAddress: {
        Name: 'Alice Example',
        Address: 'alice@example.com',
      },
    },
  };
}

function makeDeps(clientOverrides: Partial<OutlookClient> = {}) {
  const client = {
    get: vi.fn(),
    listMessagesInFolder: vi.fn(),
    countMessagesInFolder: vi.fn(),
    getFolder: vi.fn(),
    listFolders: vi.fn(),
    ...clientOverrides,
  } as unknown as OutlookClient;
  return {
    deps: {
      config: CONFIG,
      sessionPath: '/tmp/session.json',
      loadSession: vi.fn(async () => SESSION),
      saveSession: vi.fn(async () => {}),
      doAuthCapture: vi.fn(async () => SESSION),
      createClient: vi.fn(() => client),
    },
    client,
  };
}

describe('list-mail sender filters', () => {
  it('(fast path) builds exact case-insensitive sender email filter', async () => {
    const { deps, client } = makeDeps();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      value: [makeMessage('m1')],
    } satisfies ODataListResponse<MessageSummary>);

    await run(deps, { fromAddress: 'Alice@Example.COM' });

    expect(client.get).toHaveBeenCalledTimes(1);
    const [, query] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, string>,
    ];
    expect(query.$filter).toBe(
      "tolower(From/EmailAddress/Address) eq 'alice@example.com'",
    );
  });

  it('(fast path) builds case-insensitive sender display-name substring filter and escapes quotes', async () => {
    const { deps, client } = makeDeps();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ value: [] });

    await run(deps, { fromName: "O'Connor" });

    const [, query] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, string>,
    ];
    expect(query.$filter).toBe(
      "contains(tolower(From/EmailAddress/Name),'o''connor')",
    );
  });

  it('combines sender filters with received-date windows using and', async () => {
    const { deps, client } = makeDeps();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ value: [] });

    await run(deps, {
      from: '2026-04-01T00:00:00Z',
      to: '2026-05-01T00:00:00Z',
      fromAddress: 'alice@example.com',
      fromName: 'Alice',
    });

    const [, query] = (client.get as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, string>,
    ];
    expect(query.$filter).toContain('ReceivedDateTime ge 2026-04-01');
    expect(query.$filter).toContain('ReceivedDateTime lt 2026-05-01');
    expect(query.$filter).toContain(
      "tolower(From/EmailAddress/Address) eq 'alice@example.com'",
    );
    expect(query.$filter).toContain(
      "contains(tolower(From/EmailAddress/Name),'alice')",
    );
    expect(query.$filter.split(' and ')).toHaveLength(4);
  });

  it('(--folder-id path) threads sender filter into listMessagesInFolder.filter', async () => {
    const { deps, client } = makeDeps();
    (client.listMessagesInFolder as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMessage('m1'),
    ]);

    await run(deps, {
      folderId: 'AAMk=abc',
      fromAddress: 'alice@example.com',
    });

    const [folderId, opts] = (
      client.listMessagesInFolder as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, { filter?: string }];
    expect(folderId).toBe('AAMk=abc');
    expect(opts.filter).toBe(
      "tolower(From/EmailAddress/Address) eq 'alice@example.com'",
    );
  });

  it('(--just-count) routes sender filter into countMessagesInFolder.filter', async () => {
    const { deps, client } = makeDeps();
    (client.countMessagesInFolder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      count: 17,
      exact: true,
    });

    const result = await run(deps, {
      justCount: true,
      folder: 'Archive',
      fromName: 'Alice',
    });

    expect(result).toEqual({ count: 17, exact: true });
    const [folderId, opts] = (
      client.countMessagesInFolder as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, { filter?: string }];
    expect(folderId).toBe('Archive');
    expect(opts.filter).toBe(
      "contains(tolower(From/EmailAddress/Name),'alice')",
    );
  });

  it('rejects empty sender filters before any REST call', async () => {
    const { deps, client } = makeDeps();

    await expect(run(deps, { fromAddress: '   ' })).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(run(deps, { fromName: '' })).rejects.toBeInstanceOf(
      UsageError,
    );

    expect(client.get).not.toHaveBeenCalled();
    expect(client.listMessagesInFolder).not.toHaveBeenCalled();
    expect(client.countMessagesInFolder).not.toHaveBeenCalled();
  });
});
