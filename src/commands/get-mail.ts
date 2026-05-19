// src/commands/get-mail.ts
//
// Retrieve a single message + its attachment metadata.
// See project-design.md §2.13.4 and refined spec §5.4.
//
// Two lookup modes are supported:
//   1. By id    — `get-mail <id>`                     → returns one Message
//   2. By query — `get-mail --at <ts> [--subject ...] [--from-address ...]`
//                                                     → returns Message[]
//
// Mode 2 performs a server-side `$filter` against `/api/v2.0/me/messages`
// (all folders) using exact equality on `ReceivedDateTime`, optional
// substring match on `Subject`, and exact equality on
// `From/EmailAddress/Address`. Every match is fetched along with its
// attachment metadata so the returned shape is identical to id-mode times N.

import type { CliConfig } from '../config/config';
import type { OutlookClient } from '../http/outlook-client';
import type {
  AttachmentSummary,
  Message,
  MessageSummary,
  ODataListResponse,
} from '../http/types';
import type { SessionFile } from '../session/schema';
import { parseTimestamp } from '../util/dates';

import { ensureSession, mapHttpError, UsageError } from './list-mail';

export interface GetMailDeps {
  config: CliConfig;
  sessionPath: string;
  loadSession: (path: string) => Promise<SessionFile | null>;
  saveSession: (path: string, s: SessionFile) => Promise<void>;
  doAuthCapture: () => Promise<SessionFile>;
  createClient: (s: SessionFile) => OutlookClient;
}

export type BodyMode = 'html' | 'text' | 'none';

export interface GetMailOptions {
  body?: BodyMode;
  /** ISO8601 / "now"/"now±Nd" — exact equality on ReceivedDateTime. */
  at?: string;
  /** Substring match on Subject (case-sensitive, server-side `contains`). */
  subject?: string;
  /** Exact equality on From/EmailAddress/Address (case-insensitive). */
  fromAddress?: string;
}

const BODY_MODES: readonly BodyMode[] = ['html', 'text', 'none'];

/**
 * Run get-mail.
 *
 * - When `id` is a non-empty string, returns one `Message` (legacy behaviour).
 * - When `id` is omitted (empty / undefined) and `opts.at` is set, returns
 *   `Message[]` — all messages whose `ReceivedDateTime` exactly equals `at`,
 *   further narrowed by `--subject` / `--from-address` if supplied.
 *
 * Exactly one of `id` / `opts.at` must be present; otherwise a `UsageError`
 * (exit code 2) is raised.
 */
export async function run(
  deps: GetMailDeps,
  id: string | undefined,
  opts: GetMailOptions = {},
): Promise<Message | Message[]> {
  const hasId = typeof id === 'string' && id.length > 0;
  const hasAt = typeof opts.at === 'string' && opts.at.length > 0;
  const hasSubject = typeof opts.subject === 'string' && opts.subject.length > 0;
  const hasFromAddress =
    typeof opts.fromAddress === 'string' && opts.fromAddress.length > 0;

  if (!hasId && !hasAt) {
    throw new UsageError(
      'get-mail: either <id> or --at <timestamp> is required',
    );
  }
  if (hasId && hasAt) {
    throw new UsageError(
      'get-mail: <id> and --at are mutually exclusive — pass one or the other',
    );
  }
  if ((hasSubject || hasFromAddress) && !hasAt) {
    throw new UsageError(
      'get-mail: --subject and --from-address require --at (they narrow the ' +
        'timestamp lookup)',
    );
  }

  const body: BodyMode = opts.body ?? deps.config.bodyMode;
  if (!BODY_MODES.includes(body)) {
    throw new UsageError(
      `get-mail: --body must be one of ${BODY_MODES.join('|')} (got ${String(body)})`,
    );
  }

  const session = await ensureSession(deps);
  const client = deps.createClient(session);

  if (hasId) {
    return fetchOneById(client, id as string, body);
  }

  // --- Lookup mode ---------------------------------------------------------

  const atResult = parseTimestamp(opts.at as string);
  if (!atResult.ok) {
    throw new UsageError(`get-mail: --at is ${atResult.reason}`);
  }
  const filter = buildLookupFilter(
    atResult.iso,
    hasSubject ? (opts.subject as string) : undefined,
    hasFromAddress ? (opts.fromAddress as string) : undefined,
  );

  let summaries: MessageSummary[];
  try {
    const resp = await client.get<ODataListResponse<MessageSummary>>(
      '/api/v2.0/me/messages',
      {
        $filter: filter,
        // Keep payload minimal — we re-fetch each match in full below.
        $select: 'Id,Subject,From,ReceivedDateTime',
        $orderby: 'ReceivedDateTime desc',
        // Hard cap. If a single instant matches > 50 messages something is
        // very off; the user should narrow with --subject / --from-address.
        $top: '50',
      },
    );
    summaries = Array.isArray(resp.value) ? resp.value : [];
  } catch (err) {
    throw mapHttpError(err);
  }

  // Fetch each match in full, preserving the order returned by the server.
  const fullMessages: Message[] = [];
  for (const summary of summaries) {
    if (typeof summary.Id !== 'string' || summary.Id.length === 0) {
      continue;
    }
    fullMessages.push(await fetchOneById(client, summary.Id, body));
  }
  return fullMessages;
}

/**
 * Fetch one message by id along with its attachment metadata, applying the
 * `body` policy to the result. Extracted so id-mode and lookup-mode share the
 * exact same network shape.
 */
async function fetchOneById(
  client: OutlookClient,
  id: string,
  body: BodyMode,
): Promise<Message> {
  const encodedId = encodeURIComponent(id);
  try {
    const [message, attachments] = await Promise.all([
      client.get<Message>(`/api/v2.0/me/messages/${encodedId}`),
      client.get<ODataListResponse<AttachmentSummary>>(
        `/api/v2.0/me/messages/${encodedId}/attachments`,
        { $select: 'Id,Name,ContentType,Size,IsInline' },
      ),
    ]);

    const merged: Message = {
      ...message,
      Attachments: Array.isArray(attachments.value) ? attachments.value : [],
    };

    if (body === 'none') {
      delete merged.Body;
    }
    return merged;
  } catch (err) {
    throw mapHttpError(err);
  }
}

/**
 * Build the server-side `$filter` for lookup mode. Conventions:
 *
 *   ReceivedDateTime eq <iso>                                          (always)
 *   contains(Subject,'<escaped>')                                      (opt)
 *   tolower(From/EmailAddress/Address) eq '<lowercase escaped>'        (opt)
 *
 * Single-quotes inside any user-supplied literal are doubled per OData rules.
 */
function buildLookupFilter(
  isoAt: string,
  subject: string | undefined,
  fromAddress: string | undefined,
): string {
  const parts: string[] = [`ReceivedDateTime eq ${isoAt}`];
  if (typeof subject === 'string' && subject.length > 0) {
    parts.push(`contains(Subject,'${escapeODataString(subject)}')`);
  }
  if (typeof fromAddress === 'string' && fromAddress.length > 0) {
    const lc = fromAddress.toLowerCase();
    parts.push(
      `tolower(From/EmailAddress/Address) eq '${escapeODataString(lc)}'`,
    );
  }
  return parts.join(' and ');
}

/** OData v4 string-literal escape: only the single quote needs doubling. */
function escapeODataString(s: string): string {
  return s.replace(/'/g, "''");
}
