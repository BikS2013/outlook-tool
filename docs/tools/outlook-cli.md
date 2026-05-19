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

        Output convention note:
          Any command that returns a list of email messages should expose a
          1-based, ascending reference number for each returned message. The
          number must be stable for that specific output ordering, so a user can
          refer back to "email 1", "email 2", etc. without copying long Outlook
          message IDs. Table output should show it as a leading `#` column; JSON
          output should include the same ordinal on each message object.

        Email composition convention:
          Whenever an agent creates a draft email or sends an email through this
          tool, it must include the user's own authenticated mailbox address in
          Cc. For the current mailbox this is `biks@nbg.gr`. Do not add a
          duplicate Cc entry if that address is already present in To, Cc, or
          Bcc. This convention applies to `create-draft`, any future send
          command, and direct REST-backed draft/reply actions performed with the
          tool's Outlook session.

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

        4. `get-mail [<id>] [--body <html|text|none>]
                     [--at <ts> [--subject <text>] [--from-address <email>]]`
           - Two lookup modes — exactly one must be used:
               · **By id** — pass `<id>` as the positional argument. Returns
                 a single `Message` (legacy behaviour).
               · **By query** — omit `<id>` and pass `--at <timestamp>`.
                 Returns an array of full `Message` objects.
           - `--body`     `html` (raw HTML Body passed through),
                          `text` (default; upstream Body passed through untouched
                           — HTML→text conversion is deferred),
                          `none` (omit the Body field). Applied to every
                          returned message in both modes.
           - `--at <ts>`            ISO8601 timestamp or `now`/`now±Nd`. Server-
                                   side filter `ReceivedDateTime eq <iso>` —
                                   exact equality, no tolerance window. Useful
                                   when copying a `ReceivedDateTime` value
                                   verbatim from `list-mail`.
           - `--subject <text>`    Optional. Server-side `contains(Subject,'…')`
                                   to narrow the `--at` match. Case-sensitive.
                                   Requires `--at`.
           - `--from-address <em>` Optional. Server-side
                                   `tolower(From/EmailAddress/Address) eq '…'`
                                   to narrow the `--at` match (case-insensitive
                                   exact equality). Requires `--at`.
           - In id-mode, fetches `/api/v2.0/me/messages/{id}` plus
             `.../attachments` and merges the attachment metadata as
             `Attachments: AttachmentSummary[]`. In query-mode, the same
             id-mode fetch is performed for every match (so the array elements
             have identical shape to id-mode output).
           - Multi-match: query-mode returns every match (sorted
             `ReceivedDateTime desc`) — capped server-side at 50 to protect
             against pathological inputs. Empty array means no match.
           - Validation errors (exit 2): missing both `<id>` and `--at`;
             passing both; passing `--subject` / `--from-address` without
             `--at`; malformed `--at` timestamp.
           - Table columns (query-mode): `Received | From | Subject | Id`
             (same layout as `get-thread`).

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

        7. `create-draft --to <emails> --subject <text> (--body <text> | --body-file <path>)`
           - Creates a saved draft email in Outlook. It does **not** send the
             message; the user reviews and sends it manually in the Outlook UI.
           - Calls `POST /api/v2.0/me/messages`, the documented Drafts shortcut.
             The `/send` action is intentionally not exposed.
           - `--to <emails>`       Required comma-separated To recipients.
                                    Each token can be `email@example.com` or
                                    `Name <email@example.com>`.
           - `--cc <emails>`       Optional comma-separated Cc recipients.
           - `--bcc <emails>`      Optional comma-separated Bcc recipients.
           - `--subject <text>`    Required non-empty subject.
           - `--body <text>`       Inline body content.
           - `--body-file <path>`  Read UTF-8 body content from a file.
                                    Mutually exclusive with `--body`.
           - `--body-type <mode>`  `text` (default) or `html`.
           - `--importance <mode>` `low`, `normal`, or `high`.
           - JSON: `{ id, subject, isDraft, importance, to, cc, bcc, webLink,
                      createdDateTime, lastModifiedDateTime, sentDateTime }`.
           - Table columns: `Subject | To | Draft | Id`.

        8. `list-calendar [--from <ISO>] [--to <ISO>] [--tz <iana>]`
           - `--from` accepts ISO8601, `now`, or `now + Nd` (default `now`).
           - `--to`   accepts ISO8601, `now`, or `now + Nd` (default `now + 7d`).
           - Calls `GET /api/v2.0/me/calendarview?startDateTime=...&endDateTime=...
             &$orderby=Start/DateTime asc&$select=Id,Subject,Start,End,
             Organizer,Location,IsAllDay`.
           - JSON: array of `EventSummary`.
           - Table columns: `Start | End | Subject | Organizer | Location | Id`.

        9. `get-event <id> [--body <html|text|none>]`
           - Retrieves a single event. Body handling identical to get-mail.

        10. `list-folders [--parent <spec>] [--top <N>] [--recursive] [--include-hidden] [--contains <substring>] [--first-match]`
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
           - `--contains <text>` Case-insensitive substring filter applied to
                                 each materialized `Path` after traversal and
                                 hidden-folder filtering. Use with
                                 `--recursive` to search the whole mailbox tree
                                 for folders such as `hirings`.
           - `--first-match`     On ambiguity during `--parent` resolution,
                                 pick the oldest candidate (`CreatedDateTime`
                                 ascending, `Id` ascending) instead of exit 2.
           - JSON: array of `FolderSummary` objects with a materialized `Path`.
           - Table columns: `Path | Unread | Total | Children | Id`.

        11. `find-folder <spec> [--anchor <spec>] [--first-match]`
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

        12. `create-folder <path-or-name> [--parent <spec>] [--create-parents] [--idempotent]`
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

        13. `move-mail <messageIds...> --to <spec> [--first-match] [--continue-on-error]`
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

        14. `delete-mail <messageIds...> --yes [--continue-on-error]`
           - Deletes one or more messages by Outlook message id.
           - `--yes` is required so accidental invocations do not delete mail.
           - `--continue-on-error` collects per-message failures in `failed[]`
             instead of aborting on the first failed id. The process exits 5
             when any failure is reported.
           - JSON: `DeleteMailResult` with `deleted[]`, `failed[]`, and
             `summary: { requested, deleted, failed }`.
           - Table columns: `Id | Status | Error`.

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

        Create a draft for manual review and sending in Outlook:
        ```bash
        npx ts-node src/cli.ts create-draft \
          --to "Bob <bob@example.com>,carol@example.com" \
          --subject "Planning notes" \
          --body-file ./draft-body.html \
          --body-type html \
          --importance normal
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

        # Search the whole folder tree by path substring (e.g. "hirings")
        npx ts-node src/cli.ts list-folders --recursive --contains hirings --table

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

        # Delete messages by id (requires --yes)
        npx ts-node src/cli.ts delete-mail AAMkAGI... --yes
        ```

        Security notes:
        - The bearer token and cookie values are NEVER logged or printed.
        - The session file is written atomically (write + fsync + rename) with
          mode 0600 inside a 0700 parent directory.
        - A PID-based advisory lock at `$HOME/.tool-agents/outlook-cli/.browser.lock`
          prevents two concurrent login flows from racing on the profile dir.
    </info>
</outlook-cli>
