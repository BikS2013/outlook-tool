# Project Functions — Outlook CLI

This document registers every functional requirement and feature of the Outlook CLI.
Each command exposed by the `outlook-cli` binary is represented as a numbered functional
requirement (FR-xxx). Source of truth: `docs/design/refined-request-outlook-cli.md`.

Last updated: 2026-04-21

---

## FR-001 — `outlook-cli login`

**Purpose.** Open a headed Chrome window via Playwright, let the user complete Microsoft
365 login against `outlook.office.com`, capture the first `Authorization: Bearer <JWT>`
header and the browser cookie jar, and persist the session to
`$HOME/.outlook-cli/session.json` (mode `0600`).

**Inputs.** `--force` (ignore any cached session and always open the browser).
**Outputs (JSON).** `{ status, sessionFile, tokenExpiresAt, account: { puid, tenantId, upn } }`.
**Exit codes.** `0` success, `3` missing mandatory config, `4` login not completed / user
cancelled, `6` IO error writing the session file.
**Source.** Refined request §5.1.

---

## FR-002 — `outlook-cli auth-check`

**Purpose.** Verify that the cached session file exists, its Bearer token has not
expired, and a cheap REST call against `/api/v2.0/me` succeeds. Never launches a browser;
never triggers re-auth.

**Inputs.** none.
**Outputs (JSON).** `{ status: "ok" | "expired" | "missing" | "rejected",
tokenExpiresAt, account: { upn } }`.
**Exit codes.** `0` success (including the `expired`/`missing`/`rejected` reports — they
are informational, not errors), `3` missing mandatory config, `5` upstream error.
**Source.** Refined request §5.2.

---

## FR-003 — `outlook-cli list-mail`

**Purpose.** List the user's N most recent messages in a named folder (default `Inbox`),
ordered by `ReceivedDateTime desc`, optionally filtered by a `ReceivedDateTime` window
or reduced to a server-side count.

**Inputs.** `-n, --top <N>` (default 10, range 1..1000), `--folder <name>` (default
`Inbox`; fast-path well-known set: `Inbox`, `SentItems`, `Drafts`, `DeletedItems`,
`Archive`; also accepts any other well-known alias — `JunkEmail`, `Outbox`,
`MsgFolderRoot`, `RecoverableItemsDeletions` — and arbitrary display-name paths such as
`Inbox/Projects/Alpha`), `--folder-id <id>` (mutually exclusive with `--folder`; skips
the resolver and calls `/me/MailFolders/{id}/messages` directly), `--folder-parent
<name-or-path-or-id>` (default `MsgFolderRoot`; anchor for non-well-known `--folder`
values), `--select <comma-list>` (override selected fields),
`--from <iso|keyword>` (optional lower bound on `ReceivedDateTime`, inclusive;
ISO8601 `YYYY-MM-DDTHH:MM:SSZ`, space-separated local-time `YYYY-MM-DD HH:MM:SS`, or
keyword `now` / `now + Nd` / `now - Nd`), `--to <iso|keyword>` (optional upper bound,
exclusive; same grammar), `--just-count` (return only the count of matching messages
via server-side `$count=true`; ignores `--top` and `--select`).
**REST target.** `GET /api/v2.0/me/MailFolders/<folder-or-id>/messages?$top=N&$orderby=ReceivedDateTime desc&$select=...[&$filter=ReceivedDateTime ge X and ReceivedDateTime lt Y]` for the list path;
`GET /api/v2.0/me/MailFolders/<folder-or-id>/messages?$count=true&$top=1&$select=Id[&$filter=...]` for the count path.
**Outputs (JSON).** Array of message summaries (default fields: `Id`, `Subject`, `From`,
`ReceivedDateTime`, `HasAttachments`, `IsRead`, `WebLink`) — or, when `--just-count` is
set, a single object `{ count: <int>, exact: <bool> }`. `exact: false` signals the
server did not return `@odata.count` and the count reflects only the first page.
**Outputs (table, `--table`).** Columns `Received | From | Subject | Att | Id` (list mode);
the count object is rendered as a single-object payload when `--just-count` is set.
**Exit codes.** `0`, `2` (both `--folder` and `--folder-id`; invalid path; malformed
`--from`/`--to`), `3`, `4`, `5` (`UPSTREAM_FOLDER_NOT_FOUND` on bad path / id), `6`.
**Source.** Refined request §5.3 + folder extension refined-request-folders §5.5 +
CHANGELOG [1.2.0] (date window) + [1.3.0] (just-count, --top cap 1..1000).

---

## FR-004 — `outlook-cli get-mail <id>`

**Purpose.** Retrieve the full resource for a specific message, plus a computed
`Attachments[]` metadata summary.

**Inputs.** `<id>` positional (required), `--body <html|text|none>` (default `text`).
**REST targets.** `GET /api/v2.0/me/messages/{id}` and
`GET /api/v2.0/me/messages/{id}/attachments` (metadata only).
**Outputs (JSON).** Full message resource augmented with
`Attachments: [{ Id, Name, ContentType, Size, IsInline }, ...]`.
**Exit codes.** `0`, `2` (missing id), `3`, `4`, `5`, `6`.
**Source.** Refined request §5.4.

---

## FR-005 — `outlook-cli download-attachments <id>`

**Purpose.** Save every non-inline `FileAttachment` of a given message to a local
directory. `ItemAttachment` and `ReferenceAttachment` entries are skipped with a
recorded reason.

**Inputs.** `<id>` positional (required), `--out <dir>` (required — no default,
`ConfigurationError` if missing), `--overwrite` (default `false`), `--include-inline`
(default `false`).
**REST targets.** `GET /api/v2.0/me/messages/{id}/attachments` (list) + per-item
`GET /api/v2.0/me/messages/{id}/attachments/{attId}` (detail for `ContentBytes`).
**Outputs (JSON).** `{ messageId, outDir, saved: [{ id, name, path, size }],
skipped: [{ id, name, reason, ... }] }`. Skip reasons: `inline`, `item-attachment`,
`reference-attachment`, `content-bytes-null`, `access-denied`, `not-found`,
`unknown-attachment-type`.
**Exit codes.** `0`, `2` (missing id), `3` (missing `--out`), `4`, `5`, `6` (collision
without `--overwrite`, write error).
**Source.** Refined request §5.5; attachment semantics from
`docs/research/outlook-v2-attachments.md`.

---

## FR-006 — `outlook-cli list-calendar`

**Purpose.** List events in a time window, ordered by start time ascending.

**Inputs.** `--from <ISO8601>` (default `now`, env `OUTLOOK_CLI_CAL_FROM`),
`--to <ISO8601>` (default `now + 7d`, env `OUTLOOK_CLI_CAL_TO`), `--tz <IANA tz>`
(default system timezone, env `OUTLOOK_CLI_TZ`).
**REST target.** `GET /api/v2.0/me/calendarview?startDateTime=...&endDateTime=...&$orderby=Start/DateTime asc&$select=Id,Subject,Start,End,Organizer,Location,IsAllDay`.
**Outputs (JSON).** Array of event summaries.
**Outputs (table, `--table`).** Columns `Start | End | Subject | Organizer | Location | Id`.
**Exit codes.** `0`, `3`, `4`, `5`, `6`.
**Source.** Refined request §5.6.

---

## FR-007 — `outlook-cli get-event <id>`

**Purpose.** Retrieve the full resource for a specific calendar event.

**Inputs.** `<id>` positional (required), `--body <html|text|none>` (default `text`).
**REST target.** `GET /api/v2.0/me/events/{id}`.
**Outputs (JSON).** Full event resource (`Subject`, `Start`, `End`, `Organizer`,
`Attendees`, `Location`, `Body`, etc.).
**Exit codes.** `0`, `2` (missing id), `3`, `4`, `5`, `6`.
**Source.** Refined request §5.7.

---

## FR-008 — `outlook-cli list-folders`

**Purpose.** Enumerate mail folders under a specified parent, either direct children only
or the full sub-tree when `--recursive` is set. Part of the folder-management extension.

**Inputs.** `--parent <name-or-path-or-id>` (default `MsgFolderRoot`; accepts well-known
alias, display-name path, or `id:AAMkAGI...`), `--recursive` (default `false`),
`--include-hidden` (default `false`), `--top <N>` (default `100`, range `1..250` —
`$top` hint per `/childfolders` page; actual paging handled by the HTTP layer).
**REST targets.** `GET /api/v2.0/me/MailFolders?$top=N&$select=...` for the root level;
`GET /api/v2.0/me/MailFolders/{parentId}/childfolders?$top=N&$select=...` for children.
Pagination follows `@odata.nextLink` up to a 50-page cap per collection; whole-tree
walk bounded at 5000 visited nodes.
**Default `$select`.** `Id,DisplayName,ParentFolderId,ChildFolderCount,UnreadItemCount,
TotalItemCount,WellKnownName,CreatedDateTime,IsHidden`.
**Outputs (JSON).** Array of `FolderSummary`: `{ Id, DisplayName, ParentFolderId,
ChildFolderCount, UnreadItemCount, TotalItemCount, WellKnownName?, Path }`. `Path` is
materialized client-side from parent down using `/` separators (with `\/` and `\\`
escapes inside segments).
**Outputs (table, `--table`).** Columns `Path | Unread | Total | Children | Id` (no
truncation on `Id`).
**Exit codes.** `0`, `2` (bad flag value / invalid parent), `3`, `4`, `5`
(`UPSTREAM_FOLDER_NOT_FOUND` on bad parent; `UPSTREAM_PAGINATION_LIMIT` on cap
exceeded), `6`.
**Source.** Refined-request-folders §5.1.

---

## FR-009 — `outlook-cli find-folder <query>`

**Purpose.** Resolve a query (well-known alias, display-name path, or `id:...`) to a
single folder, returning its full metadata plus a `ResolvedVia` discriminator that
indicates how the lookup was satisfied.

**Inputs.** `<query>` positional (required — missing → `UsageError BAD_USAGE`),
`--parent <name-or-path-or-id>` (default `MsgFolderRoot`; used only when `<query>` is a
bare name), `--case-sensitive` (default `false`; default matching is Unicode NFC +
simple case-fold), `--include-hidden` (default `false`), `--first-match` (default
`false`; picks first candidate by `CreatedDateTime asc, Id asc` on ambiguity).
**REST target.** Either `GET /api/v2.0/me/MailFolders/{id}` (for `id:` form or
well-known alias) or repeated `GET /api/v2.0/me/MailFolders/{parentId}/childfolders`
(path walk, client-side match).
**Outputs (JSON).** One `ResolvedFolder`: `FolderSummary & { Path, ResolvedVia:
"wellknown" | "path" | "id" }`.
**Outputs (table, `--table`).** Two-line key/value fallback — current JSON is emitted
when no `ColumnSpec` is supplied (unchanged behaviour).
**Exit codes.** `0`, `2` (missing query; ambiguous match without `--first-match`;
invalid path — `FOLDER_PATH_INVALID`; depth cap), `3`, `4`, `5`
(`UPSTREAM_FOLDER_NOT_FOUND`), `6`.
**Source.** Refined-request-folders §5.2.

---

## FR-010 — `outlook-cli create-folder <path>`

**Purpose.** Create a new folder by path (`A/B/C`), optionally creating intermediate
parents, with idempotent-on-collision semantics.

**Inputs.** `<path>` positional (required), `--parent <name-or-path-or-id>` (default
`MsgFolderRoot`; anchor for `<path>`), `--create-parents` (default `false`;
intermediate missing parents → `UsageError FOLDER_MISSING_PARENT` without this flag),
`--idempotent` (default `false`; on collision with the existing leaf, exit 0 and
return the existing folder's id), `--display-name <name>` (default: last path segment
after unescape).
**REST target.** `POST /api/v2.0/me/MailFolders/{parentId}/childfolders` body
`{"DisplayName": "<segment>"}` for each segment that must be created. On 400 OR 409
with `error.code == "ErrorFolderExists"`, behaviour is governed by `--idempotent`.
**Outputs (JSON).** `{ created: [{ Id, DisplayName, Path, ParentFolderId, PreExisting
}, ...], leaf: { Id, Path, DisplayName, PreExisting }, idempotent: boolean }`.
**Outputs (table, `--table`).** Applied to `created`: columns `Path | Id | PreExisting`.
**Exit codes.** `0`, `2` (missing path, empty segments, path length >16,
`FOLDER_MISSING_PARENT`, attempt to create a well-known-alias-named folder at root),
`3`, `4`, `5` (other upstream 4xx/5xx), `6` (`FOLDER_ALREADY_EXISTS` on collision
without `--idempotent`).
**Source.** Refined-request-folders §5.3.

---

## FR-011 — `outlook-cli move-mail [<id>]`

**Purpose.** Move one or more messages to a destination folder. The move endpoint
creates a copy in the destination and deletes the source; the tool explicitly surfaces
the `{ sourceId, newId }` mapping per moved message because the new id differs from
the source id on v2.0.

**Inputs.**
- `<id>` positional (single message id) OR `--ids-from <path-or-->` (read one id per
  line, blank lines and `#` comments ignored; `-` reads stdin). Mutually exclusive;
  both absent or both present → `UsageError BAD_USAGE`.
- `--to <name-or-path>` OR `--to-id <folderId>`. Mutually exclusive; both absent or
  both present → `UsageError BAD_USAGE`. `--to` aliases always pre-resolve to a raw
  id via `GET /MailFolders/{alias}` before the move (consistent behaviour across
  tenants).
- `--to-parent <name-or-path-or-id>` (default `MsgFolderRoot`; anchor when `--to` is a
  bare name).
- `--continue-on-error` (default `false`; absorbs per-id failures into `failed[]`,
  still exits 5 at the end if any failed).
- `--stop-at <N>` (default `1000`, range `1..10000`; safety valve when `--ids-from`
  has more than N ids — exceeded → `UsageError BAD_USAGE` exit 2).
- `--first-match` (default `false`; disambiguation for path resolution).

**REST target.** `POST /api/v2.0/me/messages/{id}/move` body
`{"DestinationId": "<resolvedRawId>"}`. Response body is the moved message with a
**new Id**. Multi-message moves are N sequential REST calls (NG4: no `$batch`).
**Outputs (JSON).** `{ destination: { Id, Path, DisplayName }, moved: [{ sourceId,
newId }, ...], failed: [{ sourceId, error: { code, httpStatus } }, ...], summary: {
requested, moved, failed } }`.
**Outputs (table, `--table`).** Columns `Source Id | New Id | Status | Error`.
**Exit codes.** `0` (all moved), `2` (usage), `3`, `4`, `5` (any upstream failure not
absorbed by `--continue-on-error`; partial failure with `--continue-on-error` still
exits 5 while surfacing the full `failed[]` in the JSON payload), `6` (unused).
**Source.** Refined-request-folders §5.4.

---

## FR-012 — `outlook-cli get-thread <id>`

**Purpose.** Retrieve every message in the conversation (thread) that `<id>` belongs
to, regardless of folder. Enables linear inspection of a reply chain without having
to know which folder each reply landed in.

**Inputs.** `<id>` positional — either a raw message id (the tool resolves its
`ConversationId` first via a tight `$select`) or the literal prefix
`conv:<rawConversationId>` to skip the resolve hop. `--body <html|text|none>`
(default `text`; `none` omits Body + BodyPreview from `$select`, otherwise both are
included and passed through untouched — no HTML→text conversion). `--order <asc|desc>`
(default `asc`, oldest-first; passed as `$orderby=ReceivedDateTime <order>`).
**REST target.** `GET /api/v2.0/me/messages/{id}?$select=Id,ConversationId` (only in
raw-id mode) followed by
`GET /api/v2.0/me/messages?$filter=ConversationId eq '<id>'&$orderby=ReceivedDateTime <order>&$select=...`.
**Outputs (JSON).** `{ conversationId: <string>, count: <int>, messages: MessageSummary[] }`.
**Outputs (table, `--table`).** Columns `Received | From | Subject | Id` — renders
only the `messages` array.
**Exit codes.** `0`, `2` (empty positional, empty `conv:` suffix, invalid `--body`/`--order`,
upstream message has no ConversationId), `3`, `4`, `5` (upstream error on either GET).
**Source.** CHANGELOG [1.2.0].

---

## Cross-cutting features

### FF-001 — Global output modes

Every command supports `--json` (default) and `--table` (mutually exclusive). Progress
messages go to stderr; JSON / table output goes to stdout. `--quiet` suppresses
non-result logs.

### FF-002 — Runtime-plumbing configuration with documented defaults

`OUTLOOK_CLI_HTTP_TIMEOUT_MS`, `OUTLOOK_CLI_LOGIN_TIMEOUT_MS`, and
`OUTLOOK_CLI_CHROME_CHANNEL` have documented defaults (`30000`, `300000`, `"chrome"`)
instead of being mandatory. Precedence: CLI flag > env var > default. A **malformed**
flag or env value (non-integer, non-positive, etc.) still raises
`ConfigurationError` and exits `3`; the default only covers the unset case.
No other setting is exempt — any future mandatory setting must continue to throw
`ConfigurationError` on miss unless a similar exception is recorded in CLAUDE.md.
Source: refined request §8, superseded by CLAUDE.md "Project-specific exceptions to
global rules" (2026-04-21, shipped in [1.1.0]).

### FF-003 — Transparent re-authentication on 401 / expired token

On `401 Unauthorized` or when `now + 60s >= bearer.expiresAt`, the tool opens the
Playwright browser exactly once, captures a fresh Bearer + cookie jar, rewrites the
session file atomically, and retries the original REST call once. A second failure
exits `4`. `--no-auto-reauth` disables this and exits `4` on the first failure.
Source: refined request §6.4.

### FF-004 — Secret hygiene

The Bearer token and cookie values are never included in `Error.message`,
`Error.stack`, JSON output, or the optional `--log-file`. The session file is mode
`0600`; the session directory is `0700`. Source: refined request §7 and §9 (AC-PERMS,
AC-NO-SECRET-LEAK).

### FF-005 — Single-browser concurrency guard

An advisory PID lock at `<session-dir>/.browser.lock` prevents two concurrent
`outlook-cli login` (or automatic re-auth) invocations from launching two Chromes
against the same profile. Stale locks (PID no longer live, or age exceeds the login
timeout) are recovered automatically. Source: investigation §4.5.

### FF-006 — Canonical folder resolver

Every folder-aware command (`list-folders`, `find-folder`, `create-folder`,
`move-mail`, and the non-alias branch of `list-mail`) routes through a single
resolver module at `src/folders/resolver.ts`. The resolver owns: path parsing
(`/`-separated, `\/` and `\\` escape rules, 16-segment depth cap, NFC normalization),
well-known alias recognition (PascalCase match: `Inbox`, `SentItems`, `Drafts`,
`DeletedItems`, `Archive`, `JunkEmail`, `Outbox`, `MsgFolderRoot`,
`RecoverableItemsDeletions`), Unicode simple case-folding comparison (with
`--case-sensitive` override), ambiguity detection (two siblings same DisplayName
→ `UsageError FOLDER_AMBIGUOUS` exit 2 unless `--first-match`, which sorts by
`CreatedDateTime asc, Id asc`), well-known precedence at the root (well-known
alias wins over any user-created folder of the same name), and idempotent-on-
collision classification (HTTP 400 OR 409 + `error.code == "ErrorFolderExists"`).
Source: refined-request-folders §6; investigation-folders §4.2;
outlook-v2-folder-duplicate-error §4.

### FF-007 — Paginated list helper with safety caps

The HTTP client exposes `listAll<T>(path, query?, opts?)` — it issues the first
`GET`, then follows every `@odata.nextLink` **verbatim** (no query re-application)
until no more `nextLink` is emitted. Default `$top` hint: `250`. Per-collection
cap: `50` pages → `UpstreamError UPSTREAM_PAGINATION_LIMIT` exit 5 with an
actionable hint. Whole-tree walks (`list-folders --recursive`) are additionally
bounded at `5000` visited nodes. Off-host `nextLink` (any hostname other than
`outlook.office.com`) is rejected as `UpstreamError UPSTREAM_PAGINATION_OFF_HOST`.
The 401-retry-once envelope applies transparently per page. Source:
outlook-v2-folder-pagination-filter §5 + §6.

---

## Agent Subcommand (Plan 003)

Source: `docs/design/refined-request-langgraph-agent.md`,
`docs/design/investigation-langgraph-agent.md`,
`docs/research/azure-deepseek-tool-calling.md`,
`docs/design/plan-003-langgraph-agent.md`.

All agent-specific FR numbers use the `FR-AGT-N` prefix to avoid collision
with the existing `FR-00N` series.

### FR-AGT-1 — `outlook-cli agent [prompt]` subcommand

**Purpose.** Expose a LangGraph.js ReAct agent as a new commander subcommand
that accepts a natural-language prompt, plans tool calls against the existing
outlook-cli commands, and returns a final answer. Shares every global flag
(`--session-file`, `--profile-dir`, `--tz`, `--json`, `--table`, `--quiet`,
`--no-auto-reauth`, `--log-file`, `--timeout`, `--login-timeout`,
`--chrome-channel`).

**Inputs.** Positional `prompt` (required unless `--interactive`); `-i`,
`--provider`, `--model`, `--temperature`, `--max-steps`, `--system`,
`--system-file`, `--tools`, `--env-file`, `--allow-mutations`,
`--per-tool-budget`, `--verbose`, `--no-thread` (v1 no-op).
**Outputs (JSON).** `AgentResult` envelope (see FR-AGT-8).
**Exit codes.** `0`, `2` usage, `3` config, `4` auth, `5` upstream,
`6` IO, `1` unexpected, `130` SIGINT in interactive mode.

### FR-AGT-2 — Pluggable LLM provider registry

**Purpose.** Six-entry registry keyed by `openai | anthropic | google |
azure-openai | azure-anthropic | azure-deepseek`. Each factory is
self-contained, reads its own required env vars, and returns a LangChain
`BaseChatModel` ready to `.bindTools(...)`. A seventh provider requires only
a new factory file + one line in `registry.ts`.

**Source.** Refined §FR-3..FR-4; investigation §3 Provider Registry Blueprint.

### FR-AGT-3 — Mandatory config + no-fallback rule

**Purpose.** Every required env var raises `ConfigurationError`
(`code: 'CONFIG_MISSING'`, exit 3) naming the missing setting. No silent
defaults for secrets or endpoints. Precedence: CLI flag > process env >
`.env` file > NO FALLBACK.

**Source.** Refined §FR-2, §FR-4, NFR-1; CLAUDE.md global rule.

### FR-AGT-4 — `.env` file loading via dotenv

**Purpose.** Optional `.env` (default `./.env`) or `--env-file <path>` loaded
with `dotenv.config({ override: false })` before any `process.env.OUTLOOK_*`
read. A missing file with `--env-file` set → `ConfigurationError` exit 3
(`missingSetting: 'envFile'`). A missing default `.env` is silently ignored.
`.env` must be git-ignored; `.env.example` is shipped.

**Source.** Refined §FR-2, NFR-2; investigation D6.

### FR-AGT-5 — Tool catalog (MVP set of 11 tools)

**Purpose.** Wrap existing `src/commands/*.run()` as LangChain `tool(...)`
objects with Zod input schemas:
- Read-only: `auth_check`, `list_mail`, `get_mail`, `get_thread`,
  `list_folders`, `find_folder`, `list_calendar`, `get_event`.
- Mutation (gated by `--allow-mutations`): `create_folder`, `move_mail`,
  `download_attachments`.

Without `--allow-mutations`, mutation tools are **omitted from the catalog**
(closed-set registry per NFR-8). Output is JSON-serialized and truncated at
`OUTLOOK_AGENT_TOOL_OUTPUT_BUDGET_BYTES` (default `16384`); `Id` fields are
never truncated.

**Source.** Refined §FR-6, §8; investigation D4, D7.

### FR-AGT-6 — ReAct loop (`createAgent` + MemorySaver)

**Purpose.** Implement the ReAct loop via `createAgent` from `langchain` v1
(primary) with `createReactAgent` from `@langchain/langgraph/prebuilt` as a
fallback isolated to `src/agent/graph.ts`. Honor `--max-steps` via
`recursionLimit`. Terminate on no-tool-call AIMessage, max-steps reached
(`truncated: true`), fatal error, or SIGINT.

**Source.** Refined §FR-5; investigation D1, D5.

### FR-AGT-7 — Auth-check at boot + ensureSession

**Purpose.** Before constructing the graph, call `auth-check.run`. If status
is not `ok`:
- `--no-auto-reauth` → exit 4 (`AuthError`).
- Otherwise → `doAuthCapture` (existing captureOutlookSession flow under the
  existing PID lock), then re-run `auth-check`; second failure → exit 4.
Inside the loop, a 401 is handled by the existing `onReauthNeeded` retry-once
path; failure becomes either a ToolMessage error (model may recover) or a
fatal `AuthError` when `--no-auto-reauth` is set.

**Source.** Refined §FR-7; investigation D8.

### FR-AGT-8 — `--json` envelope + `--table` summary

**Purpose.** Default `--json` emits a single object:
```
{ provider, model, prompt, finalAnswer, steps[], usage|null, truncated,
  durationMs, runId }
```
`steps[i]` carries `{ index, tool, input, output, error|null, durationMs }`.
`--table` renders a short `Step | Tool | Status | DurationMs` grid with the
final answer as a header paragraph. `--verbose` writes the full transcript
to stderr post-run.

**Source.** Refined §FR-8; codebase-scan §8.

### FR-AGT-9 — Logging & redaction

**Purpose.** Every log line passes through `redactString` from
`src/util/redact.ts`. `--quiet` suppresses stderr; `--log-file <path>`
appends JSON-lines (mode `0600`). Records carry `runId` + ISO timestamp.
Provider API keys and bearer tokens never appear in logs, stdout, or
envelope output.

**Source.** Refined §FR-9, NFR-1; investigation D12.

### FR-AGT-10 — Interactive REPL

**Purpose.** `-i/--interactive` launches a readline REPL (`outlook-agent>`)
backed by `MemorySaver` with a stable `thread_id`. Slash commands:
`/exit`, `/quit` (exit 0), `/clear` (drop thread), `/tools` (list catalog),
`/system <text>` (replace system prompt), `/help`. Ctrl-C at idle exits
130; Ctrl-C during a run aborts the invoke and keeps the REPL alive.

**Source.** Refined §FR-11; investigation D5.

### FR-AGT-11 — System prompt override

**Purpose.** Default system prompt (text in investigation §5) with
`{mutationsEnabled}` template substitution. `--system <text>` and
`--system-file <path>` override (mutually exclusive — both set → exit 2).
`--system-file` unreadable → `ConfigurationError` exit 3.

**Source.** Refined §FR-12.

### FR-AGT-12 — `--max-steps` ceiling

**Purpose.** Integer in `[1..50]`, default `10`, env
`OUTLOOK_AGENT_MAX_STEPS`. Out-of-range → `UsageError` exit 2. Hitting the
ceiling sets `truncated: true` and exits 0 (not an error).

**Source.** Refined §FR-13.

### FR-AGT-13 — Azure DeepSeek model-variant gating

**Purpose.** `azure-deepseek` factory rejects, at config-load time, model
names matching any of these patterns (case-insensitive):
- `deepseek-v3.2-speciale` — tool calling omitted by design.
- `deepseek-r1` (excluding `deepseek-r1-0528`) — original R1 does not
  support tool calling on Microsoft Foundry.
- `deepseek-reasoner`.
- `mai-ds-r1` — tool calling unconfirmed.
- `deepseek-r1-0528` — rejected due to `ChatOpenAI` parameter-injection
  incompatibility (see research §5).
Accepts V3.x variants and unknown custom deployment names (with a single
`console.warn` to stderr, suppressed by `--quiet`). Rejection emits
`ConfigurationError` exit 3 with a message that names the model and
recommends `DeepSeek-V3.2` or `DeepSeek-V3.1`.

**Source.** Research `docs/research/azure-deepseek-tool-calling.md` §7;
investigation §7 Risk 3.

---

## F-TUI — Agent Interactive TUI

**Status:** planned (2026-04-23), replaces the readline-based interactive
mode in `src/agent/run.ts#runInteractive`. Spec source:
`prompts/004-agent-tui-spec.md`. Plan: `docs/design/plan-004-agent-tui.md`.
One-shot mode (`runOneShot`) is untouched.

### F-TUI.1  Banner

Printed once at startup and re-rendered after `/new`, `/reset`, `/model`,
and `/model reset`.

- **Line 1 (bold):** `Outlook Agent CLI (LangGraph)` — adapted from the
  spec's `NotebookLM Agent CLI` to this project's identity.
- **Line 2 (dim):** `LLM: <provider display name>` — e.g.
  `LLM: Azure OpenAI (gpt-4o)` or `LLM: OpenAI (gpt-4o-mini)`.
- **Line 3 (dim, conditional):** `Monitoring: <level> → <path>` — hidden
  while monitoring is stubbed (see F-TUI.7).
- **Line 4 (dim):** `Session: <first 8 chars of thread id>`.
- **Line 5 (dim):** `Commands: /history /memory /new /last /quit /help`.
- **Line 6 (dim):** `Shift+Enter or Ctrl+J for newline, Enter to send`.
- First-line prompt: `You> ` (green). Continuation prompt: ` .. ` (green).

### F-TUI.2  Input keybindings

Raw-mode stdin (`process.stdin.setRawMode(true)`); NOT `readline`. If
`!process.stdin.isTTY`, exit 2 with `"stdin is not a TTY"`.

**Submit / Cancel / Exit:**
- `Enter` (CR, `0x0D`) — submit: resolve with `lines.join("\n")`.
- `Shift+Enter` / `Ctrl+J` (LF, `0x0A`) — insert newline. Kitty variant
  `\x1b[13;2u` and terminal variant `\x1bOM` also accepted.
- `Ctrl+C` (`0x03`) during input — reject with `"SIGINT"` (cancel edit).
  During execution — abort via `AbortController`.
- `Ctrl+D` (`0x04`) on empty input — reject with `"EOF"` → exit.
- `ESC` during execution — abort the stream.

**Navigation:**
- `←` / `→` — cursor horizontal (within current line).
- `↑` / `↓` — move between lines of the current multi-line input; at the
  top/bottom edge they navigate **input history**.
- `Option+←/→` (`\x1b[1;3D` / `\x1b[1;3C`) — word motion.
- `Ctrl+←/→` (`\x1b[1;5D` / `\x1b[1;5C`) — word motion.
- Legacy `Alt+b` / `Alt+f` — word left / right.
- `Home`/`End` (`\x1b[H` / `\x1b[F` / `\x1bOH` / `\x1bOF` / `\x1b[1~` /
  `\x1b[4~`) — line start / end.
- `Cmd+←/→` (`\x1b[1;9D` / `\x1b[1;9C`; iTerm2 variants
  `\x1b[1;2H` / `\x1b[1;2F`) — line start / end.
- `Ctrl+A` / `Ctrl+E` — line start / end.

**Editing:**
- `Backspace` (`0x7F` / `0x08`) — delete prev char; at column 0, merge
  with previous line.
- `Delete` key (`\x1b[3~`) — delete char at cursor.
- `Ctrl+W` (`0x17`) / `Alt+Backspace` (`\x1b` + `0x7F`) — delete word
  backwards.
- `Ctrl+U` (`0x15`) — delete to start of line.
- `Ctrl+K` (`0x0B`) — delete to end of line.
- `Cmd+Backspace` (`\x1b[3;9~`) — delete to start of line.

**Input history:**
- In-memory `string[]`, lost on exit. Submitted non-empty inputs are
  pushed; consecutive duplicates are suppressed.

Escape-buffer accumulator discards any sequence longer than 10 bytes.

### F-TUI.3  Streaming output contract

Uses LangGraph v2 events:
`graph.streamEvents(input, { version: "v2", configurable: { thread_id },
signal, callbacks })`. Only three event types are consumed:

| Event | Payload | Action |
|---|---|---|
| `on_chat_model_stream` | `data.chunk.content: string` | Stop spinner, print `Agent` header ONCE (bold cyan), write chunk to stdout, append to `agentText`. |
| `on_tool_start` | `name: string` | Stop spinner, print header once (no trailing space in this branch), print `\n  ↳ calling <name>(...)`. |
| `on_tool_end` | — | Append ` ✓`, restart spinner with label `Processing tool result...`. |

Other events are ignored.

**Spinner:** braille frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at 80 ms tick, on its own line,
wrapped in ANSI save/restore. Label mutates (`Thinking...` →
`Processing tool result...` etc.). Single active instance at a time.

**Abort semantics:** `ESC` and `Ctrl+C` during execution call
`abort.abort()`; the `signal` is propagated into `streamEvents`. On
abort, the spinner stops and `[interrupted]` prints in dim yellow. On
success, a plain trailing newline.

**Budgets:** `perToolBudgetBytes` (16 KB, env
`OUTLOOK_AGENT_PER_TOOL_BUDGET_BYTES`) still caps tool results
injected into the LLM context. The on-screen `↳ calling foo(...) ✓`
indicator never prints tool output and is NOT affected by this budget.

### F-TUI.4  Slash commands

All begin with `/`. Dispatch happens before any agent turn is started.

- `/help` — print command list + keybinding summary.
- `/history` — print local (user↔agent) conversation mirror; each
  message truncated to 200 chars.
- `/state` — print agent server-side state:
  `graph.getState({ configurable: { thread_id } })` — thread id,
  domain state fields, message count.
- `/memory` — list persistent user instructions (1-indexed).
- `/memory add <text>` — append instruction; persists to memory file
  immediately; takes effect on the NEXT turn.
- `/memory remove <N>` — remove Nth instruction (1-indexed).
- `/memory clear` — wipe all instructions.
- `/new` (alias `/reset`) — new thread id (`generateId()`), clear local
  history + input history, close and recreate monitoring stub.
- `/last` (alias `/raw`) — print `lastRawResponse` verbatim.
- `/copy` — copy last agent response via platform clipboard
  (`pbcopy`/`xclip`/`xsel`/`clip.exe`). If no tool is detected, print
  `"clipboard not available on this platform"`.
- `/copy-all` — copy entire conversation formatted as
  `You: …\n\nAgent: …`.
- `/model` — show current LLM provider + resolved config with API keys
  masked (format `sk-abc…xyz`).
- `/model <provider> [--flag value ...]` — switch provider at runtime.
  Tokenizer regex `/(?:[^\s"]+|"[^"]*")/g` (quoted values supported).
  `resolveParam(flag, envVar) = flags.get(flag) ?? process.env[envVar] ??
  null`. Missing required params → user-visible error, no switch. On
  success: rebuild graph via `loadAgentConfig({ overrides })`, persist
  to `agent-model.json`, reset thread id, clear local history, recreate
  monitoring stub. **This is the only code path in the TUI that reads
  `process.env` directly.**
- `/model reset` — delete `agent-model.json`, reload config from env,
  rebuild graph + reset thread.
- `/monitor` — **stub this iteration:** prints
  `"monitoring disabled (built-in monitoring not yet available)"` via
  the existing logger. Rich summary deferred (see F-TUI.7).
- `/quit` (alias `/exit`) — close logger, clear spinner, disable raw
  mode, `process.exit(0)`.

Blocked while a turn is in flight: `/model <provider>`, `/model reset`,
`/new`, `/reset`. The TUI prints a user-visible
`"cannot <action> while a turn is in flight"` message instead.

### F-TUI.5  Persistence

| Artifact | Default location | Override (env) | Override (flag) | Mode | On missing |
|---|---|---|---|---|---|
| User memory | `$HOME/.outlook-cli/agent-memory.json` | `OUTLOOK_AGENT_MEMORY_FILE` | `--agent-memory-file <path>` | 0600 | treat as EMPTY (not a config error) |
| Model override | `$HOME/.outlook-cli/agent-model.json` | `OUTLOOK_AGENT_MODEL_FILE` | `--agent-model-file <path>` | 0600 | treat as ABSENT (fall through to env via `loadAgentConfig`) |
| Input history | in-memory | — | — | n/a | lost on exit |
| Monitoring JSONL | deferred (see F-TUI.7) | — | — | — | — |

Both files are written atomically (write tmp → fsync → rename) under the
0700 parent profile dir (`$HOME/.outlook-cli/`), modeled after
`src/session/store.ts`. Corrupt JSON logs a warning (redacted by the
existing logger) and falls back to EMPTY / ABSENT respectively.

`agent-model.json` is loaded BEFORE env config — a saved override wins
over env. `/model reset` deletes it.

User memory entries are injected into the system prompt each turn as a
`<user-instructions>` block appended to whatever `loadSystemPrompt`
returns. `src/agent/system-prompt.ts` itself is not modified — the
concatenation happens in the TUI layer.

### F-TUI.6  Configuration surface

New CLI flags on the `agent` subcommand:
- `--agent-memory-file <path>` — override memory file path. Env:
  `OUTLOOK_AGENT_MEMORY_FILE`.
- `--agent-model-file <path>` — override model-store file path. Env:
  `OUTLOOK_AGENT_MODEL_FILE`.

**Precedence** (both flags): CLI flag > env var > default. Defaults are
allowed for these two paths under the same rationale as the existing
three-setting defaults exception in CLAUDE.md — they are operational
plumbing, not secrets or environment-distinguishing identities. The
project CLAUDE.md's exception section is amended accordingly as part of
plan-004 Phase J.

All other config continues to flow through `loadAgentConfig`, which
already obeys the no-fallback rule for mandatory settings and the
documented three-setting defaults. No new raw `process.env` reads in
TUI code except inside `/model`'s `resolveParam` helper.

### F-TUI.7  Non-goals / deferred

- **Rich `/monitor` output** — turns, LLM calls, tool calls, token
  totals, latency, tool frequency, log path. Stubbed this iteration;
  TODO captured in `Issues - Pending Items.md`. Requires a
  `src/agent/monitoring/*` module (callback handler, logger, summary
  builders) that does not yet exist.
- **JSONL monitoring logs** — one file per session. Deferred with
  `/monitor`; file path would be shown as banner line 3 once enabled.
- **PTY smoke test harness** (spec §14) — optional, deferred; unit tests
  cover `replaceInput`, `insertNewline`, `handleBackspace`,
  `redrawCurrentLine` directly.
- **Encrypted model-store** — `agent-model.json` may contain
  provider-specific secrets entered on a `/model ...` line. File mode
  is 0600 but the content is plaintext. Future hardening tracked in
  Issues - Pending Items.
