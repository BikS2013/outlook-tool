# Refined Request: List Mail by Sender

## Category
Development

## Objective
Add sender filtering to the existing `outlook-cli list-mail` command so users
can list messages from a specific sender email address or sender display name.

## Scope
In scope:

- Extend `list-mail` with sender filter flags.
- Support filtering by sender email address and by sender display name.
- Compose sender filters with existing folder selection, date-window filtering,
  count mode, JSON output, and table output.
- Add focused tests for filter generation and validation.
- Update user-facing and project design documentation.

Out of scope:

- Adding a new top-level mail-search command.
- Fetching full message bodies for every result; `list-mail` keeps returning
  message summaries.
- Changing `get-mail --at` query mode.
- Adding mailbox-wide pagination beyond the existing `--top` / folder-scoped
  listing behavior.
- Adding new runtime dependencies.

## Requirements

- `list-mail` must accept `--from-address <email>`.
- `list-mail` must accept `--from-name <name>`.
- `--from-address` must filter via exact, case-insensitive
  `From/EmailAddress/Address` comparison.
- `--from-name` must filter via case-insensitive substring matching against
  `From/EmailAddress/Name`.
- Sender filters must combine with `--from` / `--to` date-window filters using
  `and`.
- Sender filters must be passed through all existing list-mail paths:
  fast-path folder aliases, `--folder-id`, and resolved folder paths.
- Sender filters must work in `--just-count` mode.
- Empty or whitespace-only sender filter values must raise `UsageError`
  before any REST call.

## Constraints

- Preserve existing output shapes.
- Keep implementation localized to `list-mail` command code and CLI wiring.
- OData string literals must escape single quotes by doubling them.
- Do not add dependencies.

## Acceptance Criteria

- `outlook-cli list-mail --from-address alice@example.com --table` lists only
  messages whose sender email address equals `alice@example.com`, ignoring case.
- `outlook-cli list-mail --from-name Alice --table` lists only messages whose
  sender display name contains `Alice`, ignoring case.
- `outlook-cli list-mail --folder Archive --from-address alice@example.com --just-count`
  returns the server-side count for the combined filter.
- Existing folder and date-window list-mail tests continue to pass.
- TypeScript build succeeds.

## Assumptions

- The requested "get all the emails" maps to the existing `list-mail` summary
  workflow, bounded by the existing `--top` behavior unless `--just-count` is
  used.
- Default folder behavior remains unchanged: `list-mail` searches the configured
  default folder, currently `Inbox`, unless the user selects another folder.

## Open Questions

None blocking.

## Original Request
add the featur to get all the emails from an email address 
or from a specific sender name
