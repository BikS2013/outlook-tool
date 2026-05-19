# Refined Request: Delete Mail by ID

## Category
Development

## Objective
Add a CLI capability to delete one or more Outlook email messages by message ID.

## Scope
In scope:

- Add a new `outlook-cli delete-mail` subcommand.
- Accept one or more message IDs as positional arguments.
- Delete messages sequentially using the existing authenticated Outlook REST v2
  client/session pipeline.
- Require an explicit confirmation flag before deletion.
- Support continuing through per-message failures for multi-ID deletion.
- Return a structured JSON result and a table view.
- Add focused command and HTTP-client tests.
- Update README, project functions, and project design documentation.

Out of scope:

- Permanently purging messages from recoverable items.
- Searching for messages to delete by sender, date, subject, or folder.
- Reading IDs from files or stdin.
- Concurrent deletion or batching.
- Deleting folders or calendar events.

## Requirements

- `delete-mail` must accept one or more message IDs:
  `outlook-cli delete-mail <messageId...> --yes`.
- The command must require `--yes`; without it, it must fail with `UsageError`
  and perform no REST calls.
- The command must support `--continue-on-error`; when set, failures for
  individual IDs are collected in `failed[]` and remaining IDs are attempted.
- Without `--continue-on-error`, the first deletion failure must abort the run.
- The HTTP client must expose a semantic `deleteMessage(messageId)` method that
  uses `DELETE /api/v2.0/me/messages/{id}`.
- The existing 401 auto-reauth and timeout behavior must apply to delete calls.
- Successful deletion must be represented in output as `{ id }`.
- Partial failure with `--continue-on-error` must emit the result and exit `5`.

## Constraints

- Do not add runtime dependencies.
- Do not perform any real mailbox deletion during implementation or tests.
- Preserve existing command behavior and output shapes.
- Keep the operation sequential; no batching or concurrency.
- Treat delete as a non-permanent Outlook message delete, not a hard purge.

## Acceptance Criteria

- `outlook-cli delete-mail AAMk... --yes` deletes one message and returns a
  summary with `requested: 1`, `deleted: 1`, `failed: 0`.
- `outlook-cli delete-mail id1 id2 --yes` deletes both messages sequentially.
- `outlook-cli delete-mail id1 id2 --yes --continue-on-error` reports per-ID
  failures while continuing through the list.
- `outlook-cli delete-mail id1` without `--yes` fails before any REST call.
- The built CLI help exposes `delete-mail` and its flags.
- Targeted tests, full test suite, and TypeScript build pass.

## Assumptions

- "List of ids" means multiple positional message IDs in a single command.
- The command should use the same Outlook REST v2 endpoint family as the rest
  of this project rather than migrating to Microsoft Graph.
- Because deletion is destructive, requiring `--yes` is acceptable.

## Open Questions

None blocking.

## Original Request
I want you to add capability of delete emails based on id, or list of ids
