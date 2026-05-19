# Plan 003 — List Folders Substring Filter

Plan date: 2026-05-19

Inputs consumed:

1. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/reference/refined-request-list-folders-substring.md`
2. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/reference/codebase-scan-folders.md`
3. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/project-design.md`
4. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/docs/design/project-functions.MD`
5. `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool/README.md`

Investigation skipped: the project already has an established folder listing
command, folder resolver, command wiring style, and test structure.

Technical research skipped: no new external API or dependency is introduced.

Codebase scan reused: `docs/reference/codebase-scan-folders.md` already maps the
folder command integration points. The implementation is localized to the
existing `list-folders` command surface.

## Design

Add `--contains <substring>` to `outlook-cli list-folders`.

Behavior:

- Existing output remains unchanged when the option is omitted.
- The command materializes `Path` exactly as it does today, then filters rows
  whose `Path` contains the provided substring.
- Comparison is case-insensitive and Unicode NFC-normalized.
- Empty or whitespace-only values raise `UsageError` with exit code `2`.
- Filtering composes with `--parent`, `--recursive`, `--include-hidden`,
  `--top`, `--first-match`, `--json`, and `--table`.

## Files to Modify

- `src/commands/list-folders.ts`
  - Add `contains?: string` to `ListFoldersOptions`.
  - Validate and normalize the substring.
  - Apply filtering after folder rows are generated.
- `src/cli.ts`
  - Add `.option('--contains <substring>', ...)` to `list-folders` wiring.
- `test_scripts/commands-list-folders.spec.ts`
  - Add focused command-level tests.
- `README.md`
  - Document the new usage.
- `docs/design/project-design.md`
  - Register the design delta.
- `docs/design/project-functions.MD`
  - Update FR-008.

## Verification

- Run the focused list-folder tests.
- Run the full test suite if the focused tests pass.
- Run the TypeScript build.
