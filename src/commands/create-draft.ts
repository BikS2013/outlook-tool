// src/commands/create-draft.ts
//
// Create a saved Outlook draft message. This command deliberately never sends
// mail; the user reviews and sends the draft through the Outlook UI.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { CliConfig } from '../config/config';
import { IoError, UpstreamError } from '../config/errors';
import type { OutlookClient } from '../http/outlook-client';
import type {
  CreateDraftMessageRequest,
  DraftBodyContentType,
  DraftImportance,
  DraftMessage,
  DraftRecipient,
  Recipient,
} from '../http/types';
import type { SessionFile } from '../session/schema';

import { ensureSession, mapHttpError, UsageError } from './list-mail';

export interface CreateDraftDeps {
  config: CliConfig;
  sessionPath: string;
  loadSession: (path: string) => Promise<SessionFile | null>;
  saveSession: (path: string, s: SessionFile) => Promise<void>;
  doAuthCapture: () => Promise<SessionFile>;
  createClient: (s: SessionFile) => OutlookClient;
}

export interface CreateDraftOptions {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  bodyFile?: string;
  bodyType?: string;
  importance?: string;
}

export interface DraftSummary {
  id: string;
  subject: string;
  isDraft: boolean | null;
  importance: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  webLink: string | null;
  createdDateTime: string | null;
  lastModifiedDateTime: string | null;
  sentDateTime: string | null;
}

export async function run(
  deps: CreateDraftDeps,
  opts: CreateDraftOptions = {},
): Promise<DraftSummary> {
  const request = await buildRequest(opts);
  const session = await ensureSession(deps);
  const client = deps.createClient(session);

  let draft: DraftMessage;
  try {
    draft = await client.createDraftMessage(request);
  } catch (err) {
    throw mapHttpError(err);
  }

  if (!draft || typeof draft.Id !== 'string' || draft.Id.length === 0) {
    throw new UpstreamError({
      code: 'UPSTREAM_HTTP_201',
      message: 'create-draft response is missing the draft message Id.',
    });
  }

  return toDraftSummary(draft, request);
}

async function buildRequest(
  opts: CreateDraftOptions,
): Promise<CreateDraftMessageRequest> {
  const subject = requireNonEmpty(opts.subject, '--subject');
  const to = parseRecipients(opts.to, '--to', true);
  const cc = parseRecipients(opts.cc, '--cc', false);
  const bcc = parseRecipients(opts.bcc, '--bcc', false);
  const content = await resolveBody(opts);
  const contentType = parseBodyType(opts.bodyType);
  const importance = parseImportance(opts.importance);

  const request: CreateDraftMessageRequest = {
    Subject: subject,
    Body: {
      ContentType: contentType,
      Content: content,
    },
    ToRecipients: to,
  };
  if (cc.length > 0) request.CcRecipients = cc;
  if (bcc.length > 0) request.BccRecipients = bcc;
  if (importance !== undefined) request.Importance = importance;
  return request;
}

function requireNonEmpty(value: string | undefined, flag: string): string {
  if (typeof value !== 'string') {
    throw new UsageError(`create-draft: ${flag} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new UsageError(`create-draft: ${flag} must not be empty`);
  }
  return trimmed;
}

async function resolveBody(opts: CreateDraftOptions): Promise<string> {
  const hasBody = typeof opts.body === 'string';
  const hasBodyFile = typeof opts.bodyFile === 'string';
  if (hasBody && hasBodyFile) {
    throw new UsageError(
      'create-draft: --body and --body-file are mutually exclusive',
    );
  }
  if (!hasBody && !hasBodyFile) {
    throw new UsageError('create-draft: either --body or --body-file is required');
  }
  if (hasBody) {
    const body = opts.body as string;
    if (body.length === 0) {
      throw new UsageError('create-draft: --body must not be empty');
    }
    return body;
  }

  const filePath = path.resolve(opts.bodyFile as string);
  try {
    const body = await fs.readFile(filePath, 'utf8');
    if (body.length === 0) {
      throw new UsageError('create-draft: --body-file must not be empty');
    }
    return body;
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new IoError({
      code: 'IO_BODY_FILE_READ',
      message: `Unable to read create-draft body file: ${filePath}`,
      path: filePath,
      cause: err,
    });
  }
}

function parseBodyType(value: string | undefined): DraftBodyContentType {
  if (value === undefined || value.trim().length === 0) {
    return 'Text';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'text') return 'Text';
  if (normalized === 'html') return 'HTML';
  throw new UsageError(
    `create-draft: --body-type must be "text" or "html" (got ${JSON.stringify(value)})`,
  );
}

function parseImportance(value: string | undefined): DraftImportance | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'low') return 'Low';
  if (normalized === 'normal') return 'Normal';
  if (normalized === 'high') return 'High';
  throw new UsageError(
    `create-draft: --importance must be "low", "normal", or "high" (got ${JSON.stringify(value)})`,
  );
}

function parseRecipients(
  value: string | undefined,
  flag: string,
  required: boolean,
): DraftRecipient[] {
  if (value === undefined) {
    if (required) throw new UsageError(`create-draft: ${flag} is required`);
    return [];
  }
  const tokens = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (tokens.length === 0) {
    if (required) throw new UsageError(`create-draft: ${flag} must not be empty`);
    return [];
  }
  return tokens.map((token) => parseRecipient(token, flag));
}

function parseRecipient(token: string, flag: string): DraftRecipient {
  const named = token.match(/^(.+?)\s*<([^<>]+)>$/);
  const name = named ? named[1].trim() : undefined;
  const address = (named ? named[2] : token).trim();
  if (!isEmailLike(address)) {
    throw new UsageError(
      `create-draft: ${flag} contains an invalid email address: ${JSON.stringify(token)}`,
    );
  }
  return {
    EmailAddress:
      name && name.length > 0
        ? { Name: name, Address: address }
        : { Address: address },
  };
}

function isEmailLike(value: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+$/.test(value);
}

function toDraftSummary(
  draft: DraftMessage,
  request: CreateDraftMessageRequest,
): DraftSummary {
  return {
    id: draft.Id,
    subject: draft.Subject ?? request.Subject,
    isDraft: typeof draft.IsDraft === 'boolean' ? draft.IsDraft : null,
    importance: draft.Importance ?? request.Importance ?? null,
    to: recipientsToAddresses(draft.ToRecipients, request.ToRecipients),
    cc: recipientsToAddresses(draft.CcRecipients, request.CcRecipients ?? []),
    bcc: recipientsToAddresses(draft.BccRecipients, request.BccRecipients ?? []),
    webLink: draft.WebLink ?? null,
    createdDateTime: draft.CreatedDateTime ?? null,
    lastModifiedDateTime: draft.LastModifiedDateTime ?? null,
    sentDateTime: draft.SentDateTime ?? null,
  };
}

function recipientsToAddresses(
  actual: Recipient[] | undefined,
  fallback: DraftRecipient[],
): string[] {
  const source =
    Array.isArray(actual) && actual.length > 0
      ? actual.map((r) => r.EmailAddress)
      : fallback.map((r) => r.EmailAddress);
  return source
    .map((email) => email?.Address)
    .filter((address): address is string => typeof address === 'string');
}
