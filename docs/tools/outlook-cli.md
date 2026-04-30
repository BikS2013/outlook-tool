# outlook-cli

<outlook-cli>
    <objective>
        CLI tool to authenticate against Outlook web (outlook.office.com), capture
        session cookies + bearer token via a headed Playwright Chrome browser,
        persist them safely under `$HOME/.tool-agents/outlook-cli/`, and access inbox,
        calendar, and attachments through the Outlook REST v2.0 API
        (`https://outlook.office.com/api/v2.0/...`). All subcommands read the
        cached session; expired or rejected sessions trigger a single
        automatic browser re-auth unless `--no-auto-reauth` is passed.
    </objective>
    <command>
        npx ts-node src/cli.ts <subcommand> [options]
        # after `npm run build`:
        node dist/cli.js <subcommand> [options]
        # or via npm run:
        npm run cli -- <subcommand> [options]
    </command>
    <info>
        Global flags (apply to every subcommand):
        - `--timeout <ms>`           Per-REST-call HTTP timeout (env
                                     `OUTLOOK_CLI_HTTP_TIMEOUT_MS`). Default: 30000.
        - `--login-timeout <ms>`     Max wait for interactive login (env
                                     `OUTLOOK_CLI_LOGIN_TIMEOUT_MS`). Default: 300000.
        - `--chrome-channel <name>`  Playwright Chrome channel (env
                                     `OUTLOOK_CLI_CHROME_CHANNEL`). Default: `chrome`.
                                     Other examples: `chrome-beta`, `msedge`.
        - `--session-file <path>`    Override session file. Default:
                                     `$HOME/.tool-agents/outlook-cli/session.json` (mode 0600).
        - `--profile-dir <path>`     Override Playwright profile dir. Default:
                                     `$HOME/.tool-agents/outlook-cli/playwright-profile/` (mode 0700).
        - `--tz <iana>`              IANA timezone. Defaults to system TZ.
        - `--json`                   Emit JSON (default).
        - `--table`                  Emit human-readable table (mutually exclusive with `--json`).
        - `--quiet`                  Suppress stderr progress messages.
        - `--no-auto-reauth`         On 401 or expired session, FAIL instead of re-opening browser.
        - `--log-file <path>`        Write debug log to file (mode 0600).

        Exit codes:
          0 success
          2 invalid argv / usage
          3 configuration error (missing mandatory config)
          4 auth failure (user cancellation, login timeout, 401-after-retry, or
            --no-auto-reauth with missing/expired session)
          5 upstream API error (non-401 HTTP error, timeout, network failure)
          6 IO error (cannot write session file, dir permission, file collision
            without --overwrite)
          1 unexpected error

        Subcommands:

        1. `login [--force]`
           - Opens Chrome via Playwright, waits for the user to log into Outlook,
             captures the first Bearer token + cookies, writes the session file.
           - With `--force`, always opens the browser (no cache reuse).
           - Without `--force`, returns the cached session directly if it exists
             and is not expired.
           - Output: `{status, sessionFile, tokenExpiresAt, account:{upn, puid, tenantId}}`.

        2. `auth-check`
           - Loads the session and calls `GET /api/v2.0/me` with
             `noAutoReauth: true` to verify the token is still accepted.
           - Never opens the browser. Always exits 0 (the status is reported
             in the payload).
           - Output: `{status: "ok"|"expired"|"missing"|"rejected", tokenExpiresAt, account}`.

        3. `list-mail [-n <N>] [--folder <name>] [--folder-id <id>] [--folder-parent <anchor>] [--select <csv>] [--from <iso|keyword>] [--to <iso|keyword>] [--just-count]`
           - Lists recent messages from a folder (well-known alias, display-name
             path, or raw id), optionally filtered by a ReceivedDateTime window.
           - `--top N`           1..1000 (default 10).
           - `--folder`          One of `Inbox`, `SentItems`, `Drafts`,
                                 `DeletedItems`, `Archive` (original fast path,
                                 no resolver hop) OR any other well-known alias
                                 (`JunkEmail`, `Outbox`, `MsgFolderRoot`,
                                 `RecoverableItemsDeletions`) OR a display-name
                                 path (e.g. `Inbox/Projects/Alpha`). Default:
                                 `Inbox`.
           - `--folder-id <id>`  Raw folder id. XOR with `--folder` — passing
                                 both → exit 2. When set, the resolver is
                                 bypassed and the id is used verbatim.
           - `--folder-parent`   Anchor folder (well-known alias, path, or
                                 `id:<raw>`) used when `--folder` is a bare
                                 name / path. Default `MsgFolderRoot`. Illegal
                                 with `--folder-id` or alone (without
                                 `--folder`) → exit 2.
           - `--select`          Comma-separated $select fields. Default:
                                 `Id,Subject,From,ReceivedDateTime,HasAttachments,IsRead,WebLink`.
           - `--from <iso|kw>`   Lower bound on `ReceivedDateTime` (inclusive).
                                 Accepts ISO8601 OR `now` / `now + Nd` /
                                 `now - Nd`. Omitted → no lower bound.
           - `--to <iso|kw>`     Upper bound on `ReceivedDateTime` (exclusive).
                                 Same grammar as `--from`. Omitted → no upper
                                 bound. Either, both, or neither may be set.
                                 Malformed values → exit 2.
           - `--just-count`      Return ONLY the count of matching messages
                                 (server-side via `$count=true`) instead of
                                 the messages themselves. Ignores `--top` and
                                 `--select`. Works with every folder flag and
                                 the `--from`/`--to` window. Output becomes
                                 `{ count: <int>, exact: <bool> }`;
                                 `exact: false` means the server did not
                                 return `@odata.count` and the count reflects
                                 only the first page.
           - JSON: array of `MessageSummary` (default) OR
                   `{ count, exact }` when `--just-count` is set.
           - Table columns: `Received | From | Subject | Att | Id` (default).

        4. `get-mail <id> [--body <html|text|none>]`
           - Retrieves one message. `id` is positional and required.
           - `--body`     `html` (raw HTML Body passed through),
                          `text` (default; upstream Body passed through untouched
                           — HTML→text conversion is deferred),
                          `none` (omit the Body field).
           - Fetches `/api/v2.0/me/messages/{id}` plus `.../attachments` metadata
             and merges them as `Attachments: AttachmentSummary[]` on the result.

        5. `get-thread <id> [--body <html|text|none>] [--order <asc|desc>]`
           - Retrieves every message in the conversation (thread) that `id`
             belongs to, regardless of folder. Uses
             `GET /me/messages?$filter=ConversationId eq '<id>'`.
           - `<id>` positional — either a message id, or `conv:<rawConversationId>`
             to skip the initial resolve hop.
           - `--body`     `html` / `text` (default) / `none`. Body handling
                          mirrors `get-mail`: `none` omits it; `html`/`text`
                          include the upstream Body + BodyPreview in
                          `$select`. No HTML→text conversion is done.
           - `--order`    `asc` (default, oldest-first) or `desc`. Passed
                          through as `$orderby=ReceivedDateTime <order>`.
           - JSON: `{ conversationId, count, messages: MessageSummary[] }`.
           - Table columns: `Received | From | Subject | Id` (renders only
                          the messages array).

        6. `download-attachments <id> --out <dir> [--overwrite] [--include-inline]`
           - Saves FileAttachment content bytes into `--out` (created with mode
             0700 if missing).
           - `--out` is mandatory; missing → exit 3.
           - Skips inline attachments unless `--include-inline` is set.
           - Skips ReferenceAttachment and ItemAttachment (recorded in
             `skipped[]` with the appropriate `reason`).
           - Without `--overwrite`, colliding filenames exit 6; duplicate names
             within the same run are auto-suffixed `" (1)"`, `" (2)"`, ...
           - Output: `{messageId, outDir, saved:[{id,name,path,size}],
                      skipped:[{id,name,reason,sourceUrl?,odataType?}]}`.

        7. `list-calendar [--from <ISO>] [--to <ISO>] [--tz <iana>]`
           - `--from` accepts ISO8601, `now`, or `now + Nd` (default `now`).
           - `--to`   accepts ISO8601, `now`, or `now + Nd` (default `now + 7d`).
           - Calls `GET /api/v2.0/me/calendarview?startDateTime=...&endDateTime=...
             &$orderby=Start/DateTime asc&$select=Id,Subject,Start,End,
             Organizer,Location,IsAllDay`.
           - JSON: array of `EventSummary`.
           - Table columns: `Start | End | Subject | Organizer | Location | Id`.

        8. `get-event <id> [--body <html|text|none>]`
           - Retrieves a single event. Body handling identical to get-mail.

        9. `list-folders [--parent <spec>] [--top <N>] [--recursive] [--include-hidden] [--first-match]`
           - Enumerates mail folders under a parent.
           - `--parent <spec>`   Well-known alias, display-name path, or
                                 `id:<raw>`. Default `MsgFolderRoot`.
           - `--top N`           Per-page `$top` (1..250, default 100).
           - `--recursive`       Walk the full sub-tree (bounded by the
                                 internal 5000-folder safety cap). Materializes
                                 a `Path` field on each row (escaped
                                 slash-separated — `/` becomes `\/`, `\`
                                 becomes `\\`).
           - `--include-hidden`  Include folders whose `IsHidden === true`.
                                 Default: false.
           - `--first-match`     On ambiguity during `--parent` resolution,
                                 pick the oldest candidate (`CreatedDateTime`
                                 ascending, `Id` ascending) instead of exit 2.
           - JSON: array of `FolderSummary` objects with a materialized `Path`.
           - Table columns: `Path | Unread | Total | Children | Id`.

        10. `find-folder <spec> [--anchor <spec>] [--first-match]`
           - Resolves a folder query to a single `ResolvedFolder` (including
             the resolver's provenance in `ResolvedVia`).
           - `<spec>` (required) — one of:
               - a well-known alias (`Inbox`, `Archive`, …),
               - a display-name path (`Inbox/Projects/Alpha`),
               - `id:<raw>` for a direct GET on the opaque id.
           - `--anchor <spec>`   Anchor for path-form queries. Ignored for
                                 well-known / id queries. Default
                                 `MsgFolderRoot`.
           - `--first-match`     Tiebreaker on ambiguity (see `list-folders`).
           - Exit codes:
               - 5 `UPSTREAM_FOLDER_NOT_FOUND` — the folder or any path
                 segment does not exist.
               - 2 `FOLDER_AMBIGUOUS` — multiple siblings share the same
                 DisplayName (add `--first-match` or use `id:<raw>`).
           - JSON: single `ResolvedFolder` object with `ResolvedVia:
             "wellknown" | "path" | "id"`.

        11. `create-folder <path-or-name> [--parent <spec>] [--create-parents] [--idempotent]`
           - Creates a folder (or a nested path) under an anchor.
           - `<path-or-name>` (required) — a bare name (`Alpha`) or a
             slash-separated display-name path (`Projects/Alpha`). A well-known
             alias is rejected when the anchor is `MsgFolderRoot`. Escape
             rules: `/` inside a DisplayName is `\/`, `\` is `\\`.
           - `--parent <spec>`      Anchor folder (well-known, path, or
                                    `id:<raw>`). Default `MsgFolderRoot`.
           - `--create-parents`     Create missing intermediate segments.
                                    Without it, a missing intermediate →
                                    exit 2 `FOLDER_MISSING_PARENT`.
           - `--idempotent`         Treat a `FOLDER_ALREADY_EXISTS` collision
                                    (HTTP 400 or 409 with OData
                                    `error.code === 'ErrorFolderExists'`) as
                                    success and return the pre-existing folder
                                    (`PreExisting: true`, top-level
                                    `idempotent: true`). Without this flag,
                                    the collision exits 6 with
                                    `FOLDER_ALREADY_EXISTS`.
           - JSON: `CreateFolderResult` (`{ created:[…], leaf:…, idempotent:
             boolean }`) — `created[]` entries carry `Path`, `Id`,
             `ParentFolderId`, `PreExisting`.
           - Table columns: `Path | Id | PreExisting` (applied to
             `result.created[]`).

        12. `move-mail <messageIds...> --to <spec> [--first-match] [--continue-on-error]`
           - Moves one or more messages to a destination folder.
           - **IMPORTANT — move returns a NEW id.** Outlook's
             `POST /me/messages/{id}/move` responds with a new message
             identity in the destination folder; the source id is no longer
             resolvable. The command surfaces the pairing explicitly in
             `moved[]` so scripts don't chain stale ids.
           - `<messageIds...>` (required) — one or more source message ids.
           - `--to <spec>` (required) — destination folder: well-known alias,
             display-name path, or `id:<raw>`. Aliases are always pre-resolved
             to a raw id before the `/move` POST (ADR-16).
           - `--first-match`         Tiebreaker on ambiguity during `--to`
                                     resolution.
           - `--continue-on-error`   Collect per-message failures in
                                     `failed[]` instead of aborting. The
                                     process still exits 5 when `failed[]`
                                     is non-empty (partial-failure rule).
           - JSON: `MoveMailResult` with `destination`, `moved[]` (each entry
             `{ sourceId, newId }`), `failed[]` (each entry
             `{ sourceId, error:{ code, httpStatus?, message? } }`), and a
             `summary: { requested, moved, failed }`.
           - Table columns: `Source Id | New Id | Status | Error`.

        Folder error codes (additional to the generic upstream taxonomy):
          - `UPSTREAM_FOLDER_NOT_FOUND`   — exit 5 (folder or path segment
                                             absent).
          - `UPSTREAM_PAGINATION_LIMIT`   — exit 5 (50-page per-collection
                                             cap or 5000-node tree cap).
          - `FOLDER_PATH_INVALID`         — exit 2 (bad escape, empty
                                             segment, > 16 segments).
          - `FOLDER_MISSING_PARENT`       — exit 2 (intermediate segment
                                             absent without --create-parents).
          - `FOLDER_AMBIGUOUS`            — exit 2 (multiple siblings share
                                             a DisplayName; use --first-match
                                             or id:<raw>).
          - `FOLDER_ALREADY_EXISTS`       — exit 6 (leaf collision without
                                             --idempotent).

        Examples:

        First-time login (sets mandatory config via env for this shell):
        ```bash
        export OUTLOOK_CLI_HTTP_TIMEOUT_MS=30000
        export OUTLOOK_CLI_LOGIN_TIMEOUT_MS=300000
        export OUTLOOK_CLI_CHROME_CHANNEL=chrome
        npx ts-node src/cli.ts login
        ```

        Verify the session, list 5 most-recent inbox messages, download attachments:
        ```bash
        npx ts-node src/cli.ts auth-check
        npx ts-node src/cli.ts list-mail --top 5 --table
        npx ts-node src/cli.ts get-mail AAMkAGI... --body text > message.json
        npx ts-node src/cli.ts download-attachments AAMkAGI... --out ./att
        ```

        Calendar:
        ```bash
        npx ts-node src/cli.ts list-calendar --from now --to "now + 14d" --table
        npx ts-node src/cli.ts get-event AAMkAGI...
        ```

        Folders — enumerate, resolve, create, move, list-in:
        ```bash
        # Top-level folders; recursive walk with --table
        npx ts-node src/cli.ts list-folders --table
        npx ts-node src/cli.ts list-folders --parent Inbox --recursive --table

        # Resolve a path to an id
        npx ts-node src/cli.ts find-folder "Inbox/Projects/Alpha" --json

        # Create a path; idempotent re-run returns the pre-existing folder
        npx ts-node src/cli.ts create-folder "Projects/Alpha" --parent Inbox --create-parents
        npx ts-node src/cli.ts create-folder "Projects/Alpha" --parent Inbox --create-parents --idempotent

        # List messages in a user folder (by path or by id)
        npx ts-node src/cli.ts list-mail --folder "Inbox/Projects/Alpha" -n 5
        npx ts-node src/cli.ts list-mail --folder-id AAMkAGI... -n 5

        # Move messages (surface the new ids in moved[])
        npx ts-node src/cli.ts move-mail AAMkAGI...srcA AAMkAGI...srcB \
          --to "Inbox/Projects/Alpha" --continue-on-error
        ```

        Security notes:
        - The bearer token and cookie values are NEVER logged or printed.
        - The session file is written atomically (write + fsync + rename) with
          mode 0600 inside a 0700 parent directory.
        - A PID-based advisory lock at `$HOME/.tool-agents/outlook-cli/.browser.lock`
          prevents two concurrent login flows from racing on the profile dir.
    </info>
</outlook-cli>
