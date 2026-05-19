// test_scripts/outlook-client-delete.spec.ts
//
// Tests for OutlookClient.deleteMessage.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpstreamError } from '../src/config/errors';
import { createOutlookClient } from '../src/http/outlook-client';
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

describe('createOutlookClient.deleteMessage', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('(1) sends DELETE /me/messages/{id} without a request body', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 204 }));

    const session = buildFakeSession();
    const client = createOutlookClient({
      session,
      httpTimeoutMs: 5_000,
      noAutoReauth: false,
      onReauthNeeded: async () => session,
    });

    await expect(client.deleteMessage('AAMk id/with spaces')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body?: unknown },
    ];
    expect(url).toBe(
      'https://outlook.office.com/api/v2.0/me/messages/AAMk%20id%2Fwith%20spaces',
    );
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    expect(init.headers.Authorization).toBe(`Bearer ${JWT_SHAPED_TOKEN}`);
    expect(init.headers.Accept).toBe('application/json');
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('(2) 401 triggers auto-reauth and retries DELETE once', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse({ status: 401, bodyText: 'expired' }))
      .mockResolvedValueOnce(makeResponse({ status: 204 }));

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

    await client.deleteMessage('m1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onReauthNeeded).toHaveBeenCalledTimes(1);
    const secondCall = fetchMock.mock.calls[1] as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(secondCall[1].method).toBe('DELETE');
    expect(secondCall[1].headers.Authorization).toBe('Bearer new.new.new');
  });

  it('(3) 404 maps to UpstreamError via semantic method wrapper', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ status: 404, bodyText: 'not found' }),
    );
    const session = buildFakeSession();
    const client = createOutlookClient({
      session,
      httpTimeoutMs: 5_000,
      noAutoReauth: false,
      onReauthNeeded: async () => session,
    });

    await expect(client.deleteMessage('missing')).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it('(4) empty id rejects before fetch', async () => {
    const session = buildFakeSession();
    const client = createOutlookClient({
      session,
      httpTimeoutMs: 5_000,
      noAutoReauth: false,
      onReauthNeeded: async () => session,
    });

    await expect(client.deleteMessage('')).rejects.toThrow(
      'deleteMessage requires a non-empty messageId',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
