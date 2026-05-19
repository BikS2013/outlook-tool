// test_scripts/outlook-client-create-draft.spec.ts
//
// Tests for OutlookClient.createDraftMessage.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpstreamError } from '../src/config/errors';
import { createOutlookClient } from '../src/http/outlook-client';
import type { CreateDraftMessageRequest } from '../src/http/types';
import type { SessionFile } from '../src/session/schema';

const JWT_SHAPED_TOKEN = 'aaaaaaaaaa.bbbbbbbbbb.cccccccccc';

function buildFakeSession(overrides: Partial<SessionFile> = {}): SessionFile {
  const base: SessionFile = {
    version: 1,
    capturedAt: '2026-04-21T12:00:00.000Z',
    account: {
      upn: 'alice@contoso.com',
      puid: '1234567890',
      tenantId: 'tenant-id-abc',
    },
    bearer: {
      token: JWT_SHAPED_TOKEN,
      expiresAt: '2099-04-21T12:00:00.000Z',
      audience: 'https://outlook.office.com',
      scopes: ['Mail.ReadWrite'],
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
  return { ...base, ...overrides };
}

function makeResponse(init: {
  status: number;
  body?: unknown;
  bodyText?: string;
  headers?: Record<string, string>;
}): Response {
  const status = init.status;
  const headersMap = new Headers(init.headers ?? {});
  const bodyText =
    init.bodyText !== undefined
      ? init.bodyText
      : init.body !== undefined
        ? JSON.stringify(init.body)
        : '';
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headersMap,
    text: async () => bodyText,
  } as unknown as Response;
}

function buildRequest(): CreateDraftMessageRequest {
  return {
    Subject: 'Draft subject',
    Body: { ContentType: 'Text', Content: 'Draft body' },
    ToRecipients: [
      { EmailAddress: { Address: 'bob@example.com' } },
    ],
  };
}

describe('createOutlookClient.createDraftMessage', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('(1) sends POST /me/messages with JSON draft payload and never calls /send', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 201,
        body: {
          Id: 'draft-1',
          Subject: 'Draft subject',
          IsDraft: true,
          WebLink: 'https://outlook.office.com/owa/?ItemID=draft-1',
        },
      }),
    );

    const session = buildFakeSession();
    const client = createOutlookClient({
      session,
      httpTimeoutMs: 5_000,
      noAutoReauth: false,
      onReauthNeeded: async () => session,
    });

    const result = await client.createDraftMessage(buildRequest());

    expect(result.Id).toBe('draft-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body?: string },
    ];
    expect(url).toBe('https://outlook.office.com/api/v2.0/me/messages');
    expect(url).not.toContain('/send');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${JWT_SHAPED_TOKEN}`);
    expect(init.headers.Accept).toBe('application/json');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body ?? '')).toEqual(buildRequest());
  });

  it('(2) 401 triggers auto-reauth and retries POST once', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse({ status: 401, bodyText: 'expired' }))
      .mockResolvedValueOnce(
        makeResponse({ status: 201, body: { Id: 'draft-2', IsDraft: true } }),
      );

    const original = buildFakeSession();
    const refreshed = buildFakeSession({
      bearer: { ...original.bearer, token: 'new.new.new' },
    });
    const onReauthNeeded = vi.fn(async () => refreshed);

    const client = createOutlookClient({
      session: original,
      httpTimeoutMs: 5_000,
      noAutoReauth: false,
      onReauthNeeded,
    });

    await client.createDraftMessage(buildRequest());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onReauthNeeded).toHaveBeenCalledTimes(1);
    const secondCall = fetchMock.mock.calls[1] as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(secondCall[0]).toBe('https://outlook.office.com/api/v2.0/me/messages');
    expect(secondCall[1].method).toBe('POST');
    expect(secondCall[1].headers.Authorization).toBe('Bearer new.new.new');
  });

  it('(3) upstream 400 maps to UpstreamError via semantic method wrapper', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ status: 400, bodyText: 'bad request' }),
    );
    const session = buildFakeSession();
    const client = createOutlookClient({
      session,
      httpTimeoutMs: 5_000,
      noAutoReauth: false,
      onReauthNeeded: async () => session,
    });

    await expect(client.createDraftMessage(buildRequest())).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it('(4) invalid request rejects before fetch', async () => {
    const session = buildFakeSession();
    const client = createOutlookClient({
      session,
      httpTimeoutMs: 5_000,
      noAutoReauth: false,
      onReauthNeeded: async () => session,
    });

    await expect(
      client.createDraftMessage({ ...buildRequest(), Subject: '' }),
    ).rejects.toThrow('createDraftMessage requires Subject');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
