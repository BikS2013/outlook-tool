# Plan 004 — List Mail Sender Filters

Plan date: 2026-05-19

Inputs consumed:

1. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/reference/refined-request-list-mail-sender-filter.md`
2. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/reference/codebase-scan-folders.md`
3. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/project-design.md`
4. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/project-functions.MD`
5. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/README.md`

Investigation skipped: `list-mail` already has an established server-side
OData filter pattern for date windows and a folder-aware command structure.

Technical research skipped: this uses existing Outlook REST v2.0 OData filter
syntax already present in `get-mail --from-address`.

Codebase scan reused: `docs/reference/codebase-scan-folders.md` documents the
`list-mail` command and folder integration points. The implementation is
localized to the existing command, CLI wiring, tests, and documentation.

## Design

Extend `outlook-cli list-mail` with:

- `--from-address <email>`: exact case-insensitive match against
  `From/EmailAddress/Address`.
- `--from-name <name>`: case-insensitive substring match against
  `From/EmailAddress/Name`.

Both filters are folded into the existing `$filter` expression builder and
combine with `--from` / `--to` using `and`. The composed filter is passed
unchanged through every existing list-mail branch:

- Fast-path alias via `client.get(...)`.
- Raw folder id via `client.listMessagesInFolder(...)`.
- Resolved folder path via `client.listMessagesInFolder(...)`.
- Count mode via `client.countMessagesInFolder(...)`.

## Files to Modify

- `src/commands/list-mail.ts`
  - Add `fromAddress?: string` and `fromName?: string`.
  - Replace the date-only filter helper with a general list-mail filter helper.
  - Validate non-empty sender filter values.
- `src/cli.ts`
  - Register `--from-address <email>` and `--from-name <name>`.
- `test_scripts/commands-list-mail-sender.spec.ts`
  - Add command-level tests for sender filters.
- `README.md`
  - Add usage examples.
- `docs/design/project-functions.MD`
  - Update FR-003.
- `docs/design/project-design.md`
  - Register the additive design delta.

## Verification

- Run sender-filter tests.
- Run existing list-mail date/folder/count tests.
- Run the full suite.
- Run TypeScript build.
