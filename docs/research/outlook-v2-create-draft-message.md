# Outlook REST v2.0 Draft Message Creation

Research date: 2026-05-19

## Scope

Implementation-level notes for adding `outlook-cli create-draft` using the existing Outlook REST v2.0 client and captured web-session authentication.

## Sources

- Microsoft Learn, "[DEPRECATED] Outlook Mail REST API reference (version 2.0)", section "Create and send messages": https://learn.microsoft.com/en-us/previous-versions/office/office-365-api/api/version-2.0/mail-rest-operations
- Microsoft Learn, "Automate creating, sending, and processing messages using the Outlook mail API": https://learn.microsoft.com/en-us/graph/outlook-create-send-messages

## Findings

The v2.0 Mail API documents a distinct draft creation flow from sending. For a new draft saved in the Drafts folder, the shortcut endpoint is:

```http
POST https://outlook.office.com/api/v2.0/me/messages
```

The same API also supports creating a draft in a specific mail folder:

```http
POST https://outlook.office.com/api/v2.0/me/MailFolders/{folder_id}/messages
```

For this project, `POST /me/messages` is the correct first implementation because the user explicitly wants a prepared draft that the end user can send through Outlook UI. Microsoft documents that this shortcut saves to Drafts.

The request body is a writable message object. The core shape needed by the CLI is:

```json
{
  "Subject": "Subject text",
  "Body": {
    "ContentType": "Text",
    "Content": "Body text"
  },
  "ToRecipients": [
    {
      "EmailAddress": {
        "Address": "recipient@example.com"
      }
    }
  ]
}
```

`Body.ContentType` may be `Text` or `HTML`. Recipients use the standard Outlook recipient shape under `ToRecipients`, `CcRecipients`, and `BccRecipients`.

The response is a message resource. A successful new draft response returns status `201`, includes `IsDraft: true`, and may include fields such as `Id`, `Subject`, `Body`, `ToRecipients`, `CcRecipients`, `BccRecipients`, `ParentFolderId`, timestamps, and `WebLink`.

Sending is a separate action:

```http
POST https://outlook.office.com/api/v2.0/me/messages/{message_id}/send
```

The implementation must not call this endpoint.

## Attachments

The v2.0 API supports adding file attachments to an existing message:

```http
POST https://outlook.office.com/api/v2.0/me/messages/{message_id}/attachments
```

with a `#Microsoft.OutlookServices.FileAttachment` payload containing `Name` and base64 `ContentBytes`. It also documents adding reference attachments during draft creation. Because the user's requested outcome is draft preparation, not attachment upload specifically, file attachment support can be added either as a focused extension after the base draft command or in the same command if it can be implemented without broad HTTP-client changes.

## Implementation Guidance

- Add a new `post` capability to the shared Outlook client rather than bypassing it.
- Keep the command intentionally draft-only.
- Build a payload from validated CLI inputs:
  - `Subject`
  - `Body.ContentType`
  - `Body.Content`
  - `ToRecipients`
  - optional `CcRecipients`
  - optional `BccRecipients`
  - optional `Importance`
- Prefer no attachment support in the first cut unless the existing code already has enough attachment helpers to keep the change small.
- Return a shaped draft summary instead of dumping the full message resource by default.

## Uncertainties

- Outlook REST v2.0 is deprecated by Microsoft. This project intentionally uses that endpoint because its existing architecture reuses Outlook web session tokens rather than Graph app registration.
- Exact returned fields can vary by tenant and backend. The CLI output should tolerate missing optional fields such as `WebLink`.
