# Outlook Message Delete Endpoint

Research date: 2026-05-19

## Sources

- Microsoft Learn, Outlook Mail REST API reference v2.0, deprecated. The page
  lists "Delete messages" among message operations and states that message
  endpoints often include the containing folder but can also operate on
  messages directly.
- Microsoft Learn, Microsoft Graph `message: delete`, current reference. It
  documents `DELETE /me/messages/{id}` and `DELETE
  /me/mailFolders/{id}/messages/{id}` request forms, no request body, and
  `204 No Content` on success.

## Decision

Use the existing project endpoint family:

```text
DELETE /api/v2.0/me/messages/{messageId}
```

This matches the project's current Outlook REST v2.0 style for direct message
operations (`GET /api/v2.0/me/messages/{id}`, `POST
/api/v2.0/me/messages/{id}/move`). It also matches the current Microsoft Graph
shape for message deletion, adjusted to the project's Outlook v2 base URL.

## Semantics

The command implements normal message deletion, not permanent purge. It does
not add a `permanentDelete` or recoverable-items cleanup path.

## Implementation Notes

- Treat `204 No Content` as success. The existing HTTP response handler already
  maps empty bodies to `null`, so `deleteMessage` can ignore the return value.
- Reuse the method-agnostic request envelope so timeout, header construction,
  cookie handling, and 401 retry-once behavior stay identical to GET/POST.
- Do not send a request body for DELETE.
