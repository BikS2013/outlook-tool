# Refined Request: List Folders by Substring

## Category
Development

## Objective
Add a way to list Outlook mail folders whose emitted folder path partially
matches a user-provided substring.

## Scope
In scope:

- Extend the existing `outlook-cli list-folders` command with a substring
  filter option.
- Preserve existing `list-folders` behavior for `--parent`, `--recursive`,
  `--include-hidden`, `--top`, `--first-match`, `--json`, and `--table`.
- Match against the command's emitted `Path` field so both direct folder names
  and nested folder paths can be found.
- Add focused unit tests for matching, non-matching, case-insensitive matching,
  and validation.
- Update project design, function documentation, and user-facing README usage.

Out of scope:

- Adding a separate top-level search command.
- Server-side search or Microsoft Graph integration.
- Changing folder resolver semantics.
- Changing folder creation, movement, or mail listing behavior.

## Requirements
- `list-folders` must accept `--contains <substring>`.
- When `--contains` is omitted, `list-folders` output must remain unchanged.
- Matching must be case-insensitive.
- Matching must use Unicode NFC normalization before comparison.
- Empty or whitespace-only substring values must raise the existing usage-error
  path with exit code `2`.
- The filter must run after hidden-folder filtering and path materialization so
  table and JSON output remain consistent.

## Constraints
- Do not add runtime dependencies.
- Keep implementation localized to existing list-folder command wiring and tests.
- Preserve existing output shapes; filtered output is still a `ListFoldersRow[]`.
- Maintain project documentation artifacts under `docs/design` and
  `docs/reference`.

## Acceptance Criteria
- `outlook-cli list-folders --contains project` returns only rows whose `Path`
  contains `project`, ignoring case.
- `outlook-cli list-folders --recursive --contains alpha` searches the full
  recursive output under the selected parent.
- `outlook-cli list-folders --contains ""` fails with `UsageError` / exit `2`.
- Existing `list-folders` tests continue to pass.
- New tests cover direct and recursive filtering.
- TypeScript build succeeds.

## Assumptions
- The user's request for a "command" can be satisfied by extending the existing
  `list-folders` command with a filter option.
- Matching the emitted `Path` is more useful than matching only
  `DisplayName`, because it supports nested folder discovery.

## Open Questions
None blocking.

## Original Request
can you add a command to list folders that matches partialy a substring ?
