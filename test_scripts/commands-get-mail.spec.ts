// test_scripts/commands-get-mail.spec.ts
//
// Covers the two get-mail lookup modes: id mode (legacy) and the new
// query mode (--at, --subject, --from-address). See project-design §2.13.4.

import { describe, it, expect, vi } from 'vitest';

import { run } from '../src/commands/get-mail';
import { UsageError } from '../src/commands/list-mail';
import type { OutlookClient } from '../src/http/outlook-client';
import type {
  AttachmentSummary,
  Message,
  MessageSummary,
  ODataListResponse,
} from '../src/http/types';
import type { SessionFile } from '../src/session/schema';
import type { CliConfig } from '../src/config/config';

const MINIMAL_CONFIG = {
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

function makeFullMessage(id: string, received: string): Message {
  return {
    Id: id,
    Subject: `subj-${id}`,
    From: { EmailAddress: { Name: 'Alice', Address: 'alice@example.com' } },
    ReceivedDateTime: received,
    HasAttachments: false,
    IsRead: true,
    WebLink: '',
    ToRecipients: [],
    CcRecipients: [],
    BccRecipients: [],
    ReplyTo: [],
    Body: { ContentType: 'Text', Content: `body-${id}` },
  };
}

function makeSummary(id: string, received: string): MessageSummary {
  return {
    Id: id,
    Subject: `subj-${id}`,
    From: { EmailAddress: { Name: 'Alice', Address: 'alice@example.com' } },
    ReceivedDateTime: received,
    HasAttachments: false,
    IsRead: true,
    WebLink: '',
  };
}

function makeDeps() {
  const client = {
    get: vi.fn(),
  } as unknown as OutlookClient;
  return {
    deps: {
      config: MINIMAL_CONFIG,
      sessionPath: '/tmp/session.json',
      loadSession: vi.fn(async () => SESSION),
      saveSession: vi.fn(async () => {}),
      doAuthCapture: vi.fn(async () => SESSION),
      createClient: vi.fn(() => client),
    },
    client,
  };
}

describe('get-mail — usage validation', () => {
  it('rejects when neither <id> nor --at is given', async () => {
    const { deps } = makeDeps();
    await expect(run(deps, undefined, {})).rejects.toBeInstanceOf(UsageError);
  });

  it('rejects when both <id> and --at are given', async () => {
    const { deps } = makeDeps();
    await expect(
      run(deps, 'someId', { at: '2026-05-01T00:00:00Z' }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('rejects --subject without --at', async () => {
    const { deps } = makeDeps();
    await expect(
      run(deps, undefined, { subject: 'foo' }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('rejects --from-address without --at', async () => {
    const { deps } = makeDeps();
    await expect(
      run(deps, undefined, { fromAddress: 'a@b.com' }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('rejects malformed --at with UsageError', async () => {
    const { deps } = makeDeps();
    await expect(
      run(deps, undefined, { at: '!!not-a-date!!' }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('rejects invalid --body', async () => {
    const { deps } = makeDeps();
    await expect(
      run(deps, 'someId', { body: 'pdf' as never }),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe('get-mail — id mode (regression)', () => {
  it('fetches one message + attachments and merges them', async () => {
    const { deps, client } = makeDeps();
    const msg = makeFullMessage('mid-1', '2026-05-01T10:00:00Z');
    const atts: ODataListResponse<AttachmentSummary> = {
      value: [
        {
          Id: 'att-1',
          Name: 'doc.pdf',
          ContentType: 'application/pdf',
          Size: 1234,
          IsInline: false,
        } as AttachmentSummary,
      ],
    };
    (client.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(msg)
      .mockResolvedValueOnce(atts);

    const result = await run(deps, 'mid-1', {});

    expect(Array.isArray(result)).toBe(false);
    const single = result as Message;
    expect(single.Id).toBe('mid-1');
    expect(single.Attachments).toEqual(atts.value);
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it('strips Body when --body=none', async () => {
    const { deps, client } = makeDeps();
    (client.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeFullMessage('m', '2026-05-01T10:00:00Z'))
      .mockResolvedValueOnce({ value: [] });

    const result = (await run(deps, 'm', { body: 'none' })) as Message;
    expect(result.Body).toBeUndefined();
  });
});

describe('get-mail — query mode', () => {
  it('builds $filter with exact ReceivedDateTime equality', async () => {
    const { deps, client } = makeDeps();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      value: [],
    });

    await run(deps, undefined, { at: '2026-05-01T14:32:11Z' });

    const [path, query] = (client.get as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, Record<string, string>];
    expect(path).toBe('/api/v2.0/me/messages');
    expect(query.$filter).toBe(
      'ReceivedDateTime eq 2026-05-01T14:32:11.000Z',
    );
    expect(query.$orderby).toBe('ReceivedDateTime desc');
    expect(query.$top).toBe('50');
  });

  it('appends contains(Subject,...) when --subject given', async () => {
    const { deps, client } = makeDeps();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      value: [],
    });

    await run(deps, undefined, {
      at: '2026-05-01T14:32:11Z',
      subject: "Q4's review",
    });

    const [, query] = (client.get as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, Record<string, string>];
    // Single-quote in subject must be doubled per OData v4 string-literal rules.
    expect(query.$filter).toContain("contains(Subject,'Q4''s review')");
  });

  it('appends tolower(...) eq for --from-address (lowercased)', async () => {
    const { deps, client } = makeDeps();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      value: [],
    });

    await run(deps, undefined, {
      at: '2026-05-01T14:32:11Z',
      fromAddress: 'Alice@Example.COM',
    });

    const [, query] = (client.get as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, Record<string, string>];
    expect(query.$filter).toContain(
      "tolower(From/EmailAddress/Address) eq 'alice@example.com'",
    );
  });

  it('returns Message[] with attachments merged for every match', async () => {
    const { deps, client } = makeDeps();
    const at = '2026-05-01T14:32:11Z';
    // 1: discovery query
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      value: [makeSummary('m1', at), makeSummary('m2', at)],
    });
    // 2..5: per-match (message + attachments) × 2
    (client.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeFullMessage('m1', at))
      .mockResolvedValueOnce({ value: [] })
      .mockResolvedValueOnce(makeFullMessage('m2', at))
      .mockResolvedValueOnce({ value: [] });

    const result = (await run(deps, undefined, { at })) as Message[];

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]!.Id).toBe('m1');
    expect(result[1]!.Id).toBe('m2');
    expect(result[0]!.Attachments).toEqual([]);
  });

  it('returns an empty array when no message matches', async () => {
    const { deps, client } = makeDeps();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      value: [],
    });

    const result = (await run(deps, undefined, {
      at: '2026-05-01T14:32:11Z',
    })) as Message[];

    expect(result).toEqual([]);
    // Discovery query only — no per-match fetches.
    expect(client.get).toHaveBeenCalledTimes(1);
  });
});
