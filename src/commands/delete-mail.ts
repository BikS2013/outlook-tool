// src/commands/delete-mail.ts
//
// Delete one or more Outlook messages by id.
// See docs/reference/refined-request-delete-mail-by-id.md and
// docs/design/plan-005-delete-mail.md.

import type { CliConfig } from '../config/config';
import { UpstreamError } from '../config/errors';
import type { OutlookClient } from '../http/outlook-client';
import type { SessionFile } from '../session/schema';

import { ensureSession, mapHttpError, UsageError } from './list-mail';

export interface DeleteMailDeps {
  config: CliConfig;
  sessionPath: string;
  loadSession: (path: string) => Promise<SessionFile | null>;
  saveSession: (path: string, s: SessionFile) => Promise<void>;
  doAuthCapture: () => Promise<SessionFile>;
  createClient: (s: SessionFile) => OutlookClient;
}

export interface DeleteMailOptions {
  /** Required confirmation guard. Without it the command performs no REST calls. */
  yes?: boolean;
  /** If true, collect per-message failures and keep deleting later ids. */
  continueOnError?: boolean;
}

export interface DeleteEntry {
  id: string;
}

export interface DeleteFailedEntry {
  id: string;
  error: { code: string; httpStatus?: number; message?: string };
}

export interface DeleteMailResult {
  deleted: DeleteEntry[];
  failed: DeleteFailedEntry[];
  summary: { requested: number; deleted: number; failed: number };
}

export async function run(
  deps: DeleteMailDeps,
  messageIds: string[],
  opts: DeleteMailOptions = {},
): Promise<DeleteMailResult> {
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw new UsageError(
      'delete-mail: at least one <messageId> positional argument is required',
    );
  }
  for (const id of messageIds) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new UsageError(
        'delete-mail: <messageId> positional arguments must be non-empty strings',
      );
    }
  }
  if (opts.yes !== true) {
    throw new UsageError(
      'delete-mail: refusing to delete messages without --yes',
    );
  }

  const continueOnError = opts.continueOnError === true;

  const session = await ensureSession(deps);
  const client = deps.createClient(session);
  const deleted: DeleteEntry[] = [];
  const failed: DeleteFailedEntry[] = [];

  for (const id of messageIds) {
    try {
      await client.deleteMessage(id);
      deleted.push({ id });
    } catch (err) {
      const mapped = mapHttpError(err);
      if (continueOnError) {
        failed.push(toFailedEntry(id, mapped));
        continue;
      }
      throw mapped;
    }
  }

  return {
    deleted,
    failed,
    summary: {
      requested: messageIds.length,
      deleted: deleted.length,
      failed: failed.length,
    },
  };
}

function toFailedEntry(id: string, err: unknown): DeleteFailedEntry {
  if (err instanceof UpstreamError) {
    return {
      id,
      error: {
        code: err.code,
        httpStatus: err.httpStatus,
        message: err.message,
      },
    };
  }

  const maybe = err as { code?: unknown; message?: unknown };
  const code =
    typeof maybe.code === 'string' && maybe.code.length > 0
      ? maybe.code
      : 'UPSTREAM_UNKNOWN';
  const message =
    typeof maybe.message === 'string' ? maybe.message : String(err);
  return { id, error: { code, message } };
}
