// test_scripts/commands-create-draft.spec.ts
//
// Command-level tests for `src/commands/create-draft.ts`.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  run as runCreateDraft,
  type CreateDraftDeps,
} from '../src/commands/create-draft';
import { UsageError } from '../src/commands/list-mail';
import { IoError } from '../src/config/errors';
import type { CliConfig } from '../src/config/config';
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

function buildDeps(client: Partial<OutlookClient>): CreateDraftDeps {
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

describe('create-draft command', () => {
  it('(1) creates a draft with recipients, subject, body, body type, and importance', async () => {
    const createDraftMessage = vi.fn(async () => ({
      Id: 'draft-1',
      Subject: 'Planning',
      IsDraft: true,
      Importance: 'High' as const,
      ToRecipients: [
        { EmailAddress: { Name: 'Bob', Address: 'bob@example.com' } },
        { EmailAddress: { Name: 'Carol', Address: 'carol@example.com' } },
      ],
      CcRecipients: [
        { EmailAddress: { Name: 'Dana', Address: 'dana@example.com' } },
      ],
      BccRecipients: [
        { EmailAddress: { Name: 'Erin', Address: 'erin@example.com' } },
      ],
      WebLink: 'https://outlook.office.com/owa/?ItemID=draft-1',
      CreatedDateTime: '2026-05-19T10:00:00Z',
      LastModifiedDateTime: '2026-05-19T10:00:01Z',
    }));
    const deps = buildDeps({ createDraftMessage });

    const result = await runCreateDraft(deps, {
      to: 'Bob <bob@example.com>, carol@example.com',
      cc: 'Dana <dana@example.com>',
      bcc: 'erin@example.com',
      subject: 'Planning',
      body: '<p>Hello</p>',
      bodyType: 'html',
      importance: 'high',
    });

    expect(createDraftMessage).toHaveBeenCalledTimes(1);
    expect(createDraftMessage).toHaveBeenCalledWith({
      Subject: 'Planning',
      Body: { ContentType: 'HTML', Content: '<p>Hello</p>' },
      ToRecipients: [
        { EmailAddress: { Name: 'Bob', Address: 'bob@example.com' } },
        { EmailAddress: { Address: 'carol@example.com' } },
      ],
      CcRecipients: [
        { EmailAddress: { Name: 'Dana', Address: 'dana@example.com' } },
      ],
      BccRecipients: [{ EmailAddress: { Address: 'erin@example.com' } }],
      Importance: 'High',
    });
    expect(result).toMatchObject({
      id: 'draft-1',
      subject: 'Planning',
      isDraft: true,
      importance: 'High',
      to: ['bob@example.com', 'carol@example.com'],
      cc: ['dana@example.com'],
      bcc: ['erin@example.com'],
      webLink: 'https://outlook.office.com/owa/?ItemID=draft-1',
    });
  });

  it('(2) reads body content from --body-file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-draft-body-'));
    const bodyFile = path.join(dir, 'body.txt');
    fs.writeFileSync(bodyFile, 'Body from file', 'utf8');
    const createDraftMessage = vi.fn(async () => ({
      Id: 'draft-file',
      IsDraft: true,
    }));
    const deps = buildDeps({ createDraftMessage });

    try {
      await runCreateDraft(deps, {
        to: 'bob@example.com',
        subject: 'File body',
        bodyFile,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    expect(createDraftMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        Body: { ContentType: 'Text', Content: 'Body from file' },
      }),
    );
  });

  it('(3) missing required inputs fail before any REST call', async () => {
    const createDraftMessage = vi.fn(async () => ({
      Id: 'draft-never',
      IsDraft: true,
    }));
    const deps = buildDeps({ createDraftMessage });

    await expect(
      runCreateDraft(deps, { subject: 'No to', body: 'Body' }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      runCreateDraft(deps, { to: 'bob@example.com', body: 'Body' }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      runCreateDraft(deps, { to: 'bob@example.com', subject: 'No body' }),
    ).rejects.toBeInstanceOf(UsageError);
    expect(createDraftMessage).not.toHaveBeenCalled();
  });

  it('(4) invalid recipient and option values fail before any REST call', async () => {
    const createDraftMessage = vi.fn(async () => ({
      Id: 'draft-never',
      IsDraft: true,
    }));
    const deps = buildDeps({ createDraftMessage });

    await expect(
      runCreateDraft(deps, {
        to: 'not-an-email',
        subject: 'Bad recipient',
        body: 'Body',
      }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      runCreateDraft(deps, {
        to: 'bob@example.com',
        subject: 'Bad type',
        body: 'Body',
        bodyType: 'markdown',
      }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      runCreateDraft(deps, {
        to: 'bob@example.com',
        subject: 'Bad importance',
        body: 'Body',
        importance: 'urgent',
      }),
    ).rejects.toBeInstanceOf(UsageError);
    expect(createDraftMessage).not.toHaveBeenCalled();
  });

  it('(5) missing body file maps to IoError', async () => {
    const createDraftMessage = vi.fn(async () => ({
      Id: 'draft-never',
      IsDraft: true,
    }));
    const deps = buildDeps({ createDraftMessage });

    await expect(
      runCreateDraft(deps, {
        to: 'bob@example.com',
        subject: 'Missing file',
        bodyFile: '/path/that/does/not/exist.txt',
      }),
    ).rejects.toBeInstanceOf(IoError);
    expect(createDraftMessage).not.toHaveBeenCalled();
  });
});
