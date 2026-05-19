# Plan 006: Create Draft Email

Refined request: `docs/reference/refined-request-create-draft-email.md`
Investigation: skipped — existing Outlook REST v2.0 strategy is prescribed by the project.
Technical research: `docs/research/outlook-v2-create-draft-message.md`
Codebase scan: `docs/reference/codebase-scan-create-draft-email.md`

## Objective

Add `outlook-cli create-draft` so users can prepare an email draft in Outlook and send it manually through the Outlook UI.

## Scope

In scope:

- Add a draft-only CLI command.
- Add Outlook client support for `POST /api/v2.0/me/messages`.
- Validate recipients, subject, body source, body mode, and importance.
- Support inline body text and body file input.
- Return a concise draft summary with id, subject, recipients, `IsDraft`, timestamps, and `WebLink` when available.
- Add focused command and client tests.
- Update project function/design/tool/README documentation.

Out of scope:

- Sending email.
- Reply/forward draft workflows.
- File attachments in the first implementation.
- Graph app registration or OAuth changes.

## Files to Modify

- `src/http/types.ts`
- `src/http/outlook-client.ts`
- `src/commands/create-draft.ts` (new)
- `src/cli.ts`
- `test_scripts/commands-create-draft.spec.ts` (new)
- `test_scripts/outlook-client-create-draft.spec.ts` (new)
- `test_scripts/cli-smoke.spec.ts`
- `docs/design/project-functions.MD`
- `docs/design/project-design.md`
- `docs/tools/outlook-cli.md`
- `README.md`

Out-of-scope files from the scan must remain untouched unless required by build/test fallout:

- `src/auth/*`
- `src/session/*`
- `src/folders/*`
- `src/commands/download-attachments.ts`

## Implementation Steps

1. Add draft request/result typing.
2. Add `OutlookClient.createDraftMessage(...)` using the existing private POST helper and error mapping.
3. Add `src/commands/create-draft.ts` with validation and draft summary shaping.
4. Register `create-draft` in `src/cli.ts` with options:
   - `--to <emails>`
   - `--cc <emails>`
   - `--bcc <emails>`
   - `--subject <text>`
   - `--body <text>`
   - `--body-file <path>`
   - `--body-type <text|html>`
   - `--importance <low|normal|high>`
5. Add tests for command validation, request payload shape, client POST behavior, 401 retry reuse, and no-send safety.
6. Update docs.
7. Run `npm test` and `npm run build`.

## Acceptance Criteria

- Valid input creates a draft through `POST /api/v2.0/me/messages`.
- No code path calls `/send`.
- Missing or invalid inputs fail before REST calls.
- Body file input is read safely and errors map to `IoError`.
- Tests and build pass.
