# Plan 005 — Delete Mail by ID

Plan date: 2026-05-19

Inputs consumed:

1. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/reference/refined-request-delete-mail-by-id.md`
2. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/research/outlook-v2-delete-message.md`
3. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/reference/codebase-scan-folders.md`
4. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/project-design.md`
5. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/project-functions.MD`
6. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/README.md`

Investigation skipped: the project already has a clear command pattern for
single/multiple message mutation through `move-mail`.

Technical research conducted: `docs/research/outlook-v2-delete-message.md`
confirms the deletion endpoint family and response behavior.

Codebase scan reused: `docs/reference/codebase-scan-folders.md` maps the
existing command, HTTP client, formatter, and test integration points.

## Design

Add `outlook-cli delete-mail <messageIds...> --yes`.

The command is intentionally explicit:

- `--yes` is required before any deletion occurs.
- IDs are accepted as one or more positional arguments.
- Deletions are sequential.
- `--continue-on-error` collects per-ID failures and continues.
- Without `--continue-on-error`, the first failure aborts.

## Files to Modify

- `src/http/outlook-client.ts`
  - Extend the request method union to include `DELETE`.
  - Add `OutlookClient.deleteMessage(messageId): Promise<void>`.
- `src/commands/delete-mail.ts`
  - New command module with validation, session/client setup, loop, and result
    shaping.
- `src/cli.ts`
  - Register the new subcommand and table columns.
- `test_scripts/outlook-client-delete.spec.ts`
  - Test DELETE request path and auth retry behavior.
- `test_scripts/commands-delete-mail.spec.ts`
  - Test command validation and multi-ID behavior.
- `README.md`
  - Add examples.
- `docs/design/project-functions.MD`
  - Register the new functional requirement.
- `docs/design/project-design.md`
  - Register the design delta.

## Verification

- Run targeted delete-mail tests.
- Run full test suite.
- Run TypeScript build.
- Check built CLI help.
