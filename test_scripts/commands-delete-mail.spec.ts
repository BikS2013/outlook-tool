// test_scripts/commands-delete-mail.spec.ts
//
// Command-level tests for `src/commands/delete-mail.ts`.
// No real HTTP: OutlookClient is mocked via deps.createClient.

import { describe, expect, it, vi } from 'vitest';

import {
  run as runDeleteMail,
  type DeleteMailDeps,
} from '../src/commands/delete-mail';
import { UsageError } from '../src/commands/list-mail';
import type { CliConfig } from '../src/config/config';
import { ApiError } from '../src/http/errors';
import type { OutlookClient } from '../src/http/outlook-client';
import type { SessionFile } from '../src/session/schema';

const JWT_SHAPED_TOKEN = 'aaaaaaaaaa.bbbbbbbbbb.cccccccccc';

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
      token: JWT_SHAPED_TOKEN,
      expiresAt: '2099-04-21T12:00:00.000Z',
      audience: 'https://outlook.office.com',
      scopes: ['Mail.ReadWrite'],
    },
    cookies: [],
    anchorMailbox: 'PUID:1234567890@tenant-id-abc',
  };
}

function buildConfig(): CliConfig {
  return Object.freeze({
    httpTimeoutMs: 5_000,
    loginTimeoutMs: 60_000,
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
    noAutoReauth: false,
  }) as CliConfig;
}

function buildDeps(client: Partial<OutlookClient>): DeleteMailDeps {
  const session = buildFakeSession();
  return {
    config: buildConfig(),
    sessionPath: '/tmp/session.json',
    loadSession: async () => session,
    saveSession: async () => {
      /* no-op */
    },
    doAuthCapture: async () => session,
    createClient: () => client as OutlookClient,
  };
}

describe('delete-mail command', () => {
  it('(1) single id + --yes deletes one message and returns summary', async () => {
    const deleteMessage = vi.fn(async () => undefined);
    const deps = buildDeps({ deleteMessage });

    const result = await runDeleteMail(deps, ['msg-1'], { yes: true });

    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith('msg-1');
    expect(result.deleted).toEqual([{ id: 'msg-1' }]);
    expect(result.failed).toEqual([]);
    expect(result.summary).toEqual({ requested: 1, deleted: 1, failed: 0 });
  });

  it('(2) multiple ids delete sequentially in input order', async () => {
    const calls: string[] = [];
    const deleteMessage = vi.fn(async (id: string) => {
      calls.push(id);
    });
    const deps = buildDeps({ deleteMessage });

    const result = await runDeleteMail(deps, ['m1', 'm2', 'm3'], {
      yes: true,
    });

    expect(calls).toEqual(['m1', 'm2', 'm3']);
    expect(result.deleted).toEqual([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]);
    expect(result.summary).toEqual({ requested: 3, deleted: 3, failed: 0 });
  });

  it('(3) missing --yes raises UsageError before any REST call', async () => {
    const deleteMessage = vi.fn(async () => undefined);
    const deps = buildDeps({ deleteMessage });

    await expect(runDeleteMail(deps, ['m1'], {})).rejects.toBeInstanceOf(
      UsageError,
    );
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('(4) first failure without --continue-on-error aborts the loop', async () => {
    const deleteMessage = vi.fn(async (id: string) => {
      if (id === 'm1') {
        throw new ApiError({
          code: 'NOT_FOUND',
          message: 'message m1 is gone',
          httpStatus: 404,
          url: 'https://outlook.office.com/api/v2.0/me/messages/m1',
        });
      }
    });
    const deps = buildDeps({ deleteMessage });

    await expect(
      runDeleteMail(deps, ['m1', 'm2'], { yes: true }),
    ).rejects.toBeDefined();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('(5) --continue-on-error records failures and continues', async () => {
    const deleteMessage = vi.fn(async (id: string) => {
      if (id === 'm1') {
        throw new ApiError({
          code: 'NOT_FOUND',
          message: 'message m1 is gone',
          httpStatus: 404,
          url: 'https://outlook.office.com/api/v2.0/me/messages/m1',
        });
      }
    });
    const deps = buildDeps({ deleteMessage });

    const result = await runDeleteMail(deps, ['m1', 'm2', 'm3'], {
      yes: true,
      continueOnError: true,
    });

    expect(deleteMessage).toHaveBeenCalledTimes(3);
    expect(result.deleted).toEqual([{ id: 'm2' }, { id: 'm3' }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe('m1');
    expect(result.failed[0].error.httpStatus).toBe(404);
    expect(result.summary).toEqual({ requested: 3, deleted: 2, failed: 1 });
  });

  it('(6) empty id list raises UsageError', async () => {
    const deps = buildDeps({});
    await expect(
      runDeleteMail(deps, [], { yes: true }),
    ).rejects.toBeInstanceOf(UsageError);
  });
});
