# Refined Request: Create Draft Email Capability

## Category
Development

## Objective
Add an Outlook CLI capability that creates or prepares draft email messages in the user's mailbox so the end user can review and send them manually through the Outlook web user interface.

## Scope
In scope:

- Add a new CLI command for creating an email draft in Outlook.
- Persist the draft in the mailbox's Drafts folder through the existing authenticated Outlook REST v2.0 session.
- Support draft fields needed for a practical outbound message: recipients, subject, body, importance, and optional attachments if the current API/client structure can support them without broad refactoring.
- Return enough metadata for the user to find and open the created draft in Outlook, including the message id and any available web link.
- Preserve the existing safety posture: the tool must not send the email.
- Add or update tests under `test_scripts`.
- Update project documentation, including the functional requirements and design docs.

Out of scope:

- Sending email directly.
- Building a graphical composer.
- Adding Microsoft Graph app registration or OAuth flows.
- Supporting shared mailboxes or delegated send-as behavior unless already supported by the existing session/API layer.
- Replacing the existing Outlook REST v2.0 client architecture.

## Requirements
- Introduce a user-facing command, expected to be named `create-draft`, that creates a draft message.
- The command must use the existing session loading, auto-reauth, output formatting, and error-handling conventions.
- The command must accept `--to`, `--cc`, and `--bcc` recipient inputs, with at least one `--to` recipient required unless project conventions support another explicit draft-only flow.
- The command must accept a subject value.
- The command must accept body content as either direct CLI text and/or a file input, with a clear precedence rule if both are supplied.
- The command must support text and HTML body modes in a way compatible with Outlook REST v2.0.
- The command must create a saved draft only; it must not call any send endpoint.
- The command output must include the draft id, subject, recipients, created/updated timestamp if returned, and web link if returned.
- Invalid recipient input, missing required fields, unreadable body files, and upstream failures must map to the existing typed error/exit-code conventions.
- Tests must cover command validation, REST request shape, output shaping, and the no-send safety guarantee.
- Documentation must register the feature in `docs/design/project-functions.MD`, update `docs/design/project-design.md`, and update user-facing tool docs/README where appropriate.

## Constraints
- The implementation must remain TypeScript.
- Test scripts must be created or updated only under `test_scripts`.
- No new runtime dependency should be added unless necessary; any new dependency must be security-vetted before being written to the manifest.
- Configuration values must not gain unrecorded fallbacks.
- Existing user changes must be preserved.
- The current tool authenticates by reusing the Outlook web session and should continue to do so.

## Acceptance Criteria
- Running the new command with valid recipient, subject, and body inputs creates a message in the Outlook Drafts folder and does not send it.
- The command's REST call uses the existing Outlook client and the documented Outlook draft creation endpoint/payload.
- The command rejects missing recipients, missing subject, missing body source, invalid body mode, unreadable body file, and malformed recipient lists with usage or IO errors consistent with the existing CLI.
- Unit tests or integration-style command tests verify the request path, method, payload, output object, and validation behavior.
- Existing test suite passes.
- `docs/design/project-functions.MD`, `docs/design/project-design.md`, and command documentation mention the draft creation capability and explicitly state that sending remains out of scope.

## Assumptions
- The intended workflow is to prepare drafts for manual review and sending in Outlook, not to automate outbound sending.
- A draft should be created in the authenticated user's mailbox through the same Outlook REST v2.0 API surface already used by this project.
- Multiple recipients can be passed as comma-separated values or repeated flags, following the style that best matches the current CLI implementation.
- Attachments are desirable but not mandatory if adding them would require a separate upload flow with disproportionate scope.

## Open Questions
- Should attachment support be included in the first implementation, or deferred to a later command/extension?
- Should the body input prefer inline text, file input, stdin, or support all three?

## Original Request
I want you to add capability of creating draft emails, or preparing draft emails, in order to allow the end user to send them through the Outlook user interface.
