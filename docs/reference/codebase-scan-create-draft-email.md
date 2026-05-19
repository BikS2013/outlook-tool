---
language: TypeScript
framework: Node.js CLI
package_manager: npm
build_command: npm run build
test_command: npm test
lint_command: null
entry_points:
  - src/cli.ts
last_scanned_commit: 31d7c0a31939f76295e48bf02aa59f4aeb7aa77e
request_file: docs/reference/refined-request-create-draft-email.md
scan_scope: request-driven
generated_at: 2026-05-19T00:00:00+03:00
---

# Codebase Scan: Create Draft Email

## Metadata

- Project root: `/Users/giorgosmarinos/aiwork/coding-platform/outlook-tool`
- Package: `@biks2013/outlook-cli`
- Runtime: Node.js `>=20`
- Module format: CommonJS
- TypeScript strict mode: inferred from existing source patterns; build command is `npm run build`
- Test framework: Vitest via `npm test`

## Module Map

### In Scope

- `src/cli.ts`
  - Commander entry point and command registration.
  - Imports each command module and wires command options to `run(...)`.
  - Owns table column specs and output emission.
  - New `create-draft` command should be registered here.

- `src/http/outlook-client.ts`
  - Shared REST v2.0 client.
  - Already has private `doPost<TBody, TRes>` and method-agnostic retry envelope.
  - Public interface currently exposes semantic methods such as `createFolder`, `moveMessage`, and `deleteMessage`.
  - New draft method should be added here instead of bypassing the client.

- `src/http/types.ts`
  - PascalCase Outlook REST v2.0 resource shapes.
  - Existing `Message` shape already includes recipients, body, importance, and draft-compatible fields.
  - New request/result interfaces can live here if reused by the client and command.

- `src/commands/`
  - Command modules are one file per CLI verb.
  - `delete-mail.ts` and `move-mail.ts` are closest patterns for validated, mutating mail operations.
  - New `src/commands/create-draft.ts` is the expected landing point.

- `test_scripts/`
  - All tests live here per project convention.
  - Add focused command tests and HTTP client tests for draft creation.

- `docs/design/project-design.md`
  - Must record the design extension and cite the refined request, research, codebase scan, and plan.

- `docs/design/project-functions.MD`
  - Must register the new functional requirement.

- `docs/tools/outlook-cli.md` and `README.md`
  - User-facing command documentation should mention the new command and explicitly state it creates a draft only.

### Out of Scope

- `src/auth/*`
  - Session capture and JWT parsing do not need changes.

- `src/session/*`
  - Draft creation reuses existing session loading/persistence.

- `src/folders/*`
  - No folder resolver changes are needed when using the documented `/me/messages` Drafts shortcut.

- `src/commands/download-attachments.ts`
  - Existing attachment download behavior is unrelated to creating drafts.

- `dist/*`
  - Generated output; should be updated only by `npm run build` if the project expects built artifacts to be checked in.

## Existing Feature Check

The requested feature is not already implemented.

Evidence:

- `src/commands/` has commands for login, auth-check, list/get mail, attachments download, calendar, folders, move, and delete, but no draft creation command.
- `src/http/outlook-client.ts` has `moveMessage` and `deleteMessage`, but no `createDraft` or generic public `post` method.
- README explicitly states the tool does not send mail, but does not document creating drafts.

## Integration Points

### New Integration Point: `src/commands/create-draft.ts`

Expected responsibilities:

- Validate CLI inputs.
- Load/refresh session through `ensureSession`.
- Build recipient arrays for `ToRecipients`, `CcRecipients`, and `BccRecipients`.
- Resolve body content from inline text or file input.
- Call `client.createDraftMessage(...)`.
- Shape the returned draft summary.
- Map HTTP errors through `mapHttpError`.

### In-Scope Modification: `src/http/outlook-client.ts`

Expected changes:

- Extend `OutlookClient` with a semantic `createDraftMessage(request)` method.
- Use existing private `doPost` to call `POST /api/v2.0/me/messages`.
- Reuse existing error mapping and 401 retry behavior.

### In-Scope Modification: `src/http/types.ts`

Expected changes:

- Add draft creation request types if needed:
  - recipient arrays
  - body content
  - importance
- Reuse existing `Message` for the response if practical.

### In-Scope Modification: `src/cli.ts`

Expected changes:

- Import the new command module.
- Register `create-draft`.
- Add command options for recipients, subject, body mode, body text/file, and importance.
- Add table columns for draft summary if table output is supported.

### In-Scope Tests

Expected new files:

- `test_scripts/commands-create-draft.spec.ts`
- `test_scripts/outlook-client-create-draft.spec.ts`

Optional update:

- `test_scripts/cli-smoke.spec.ts` to assert the command appears in `--help`.

## Conventions Observed

- Commands expose `run(deps, ..., opts)` and receive injected dependencies for testability.
- Command validation raises `UsageError` from `src/commands/list-mail.ts`, mapping to exit code 2.
- Mutating mail commands reuse `ensureSession` and `mapHttpError` from `src/commands/list-mail.ts`.
- HTTP client semantic methods encode path segments, call private `doPost`/`doDelete`, and map `ApiError`/`NetworkError` into CLI-facing errors.
- Tests mock `OutlookClient` for command-level behavior and stub global `fetch` for client behavior.
- No new runtime dependency is needed for this request.

## Risks

- The project uses deprecated Outlook REST v2.0 intentionally. The new command should not introduce Graph dependencies.
- A draft creation endpoint that returns optional/missing fields must be handled defensively in output shaping.
- Adding attachments in the first cut would expand the scope to file IO and multi-step REST calls. Base draft creation should land first.
