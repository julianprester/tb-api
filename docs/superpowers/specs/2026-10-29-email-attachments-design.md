# Email Attachments Design

**Date:** 2026-10-29
**Status:** Draft for approval
**Feature:** Download attachments from messages and attach files to drafts

## Intent

`tb-api` can currently report that a message has attachments, and `GET
/messages/:id` lists their name, size, and content type. It cannot return the
actual bytes, and `POST /messages` has no way to add files to a draft. An agent
that needs to read an emailed invoice or send a generated report has to leave
the API.

This feature adds both directions over the existing HTTP/JSON surface:

- a download endpoint that returns the file itself, plus an optional base64
  JSON form for clients that cannot consume binary;
- an `attachments` field on `POST /messages` that accepts base64 file content
  and adds it to a new draft, reply, or forward.

## Goals

- Retrieve any attachment of a message by its MIME part name, as raw bytes or
  as base64 JSON.
- Attach one or more files to any draft created by `POST /messages`, using
  base64 content in the JSON body.
- Expose the attachment identity (`partName`) and a `download_url` in
  `GET /messages/:id`, so a client can go from a message to its attachments
  without guessing.
- Preserve the existing authentication, origin, error-code, and test/doc
  conventions.
- Use only WebExtension APIs already available in Thunderbird 128:
  `messages.listAttachments`, `messages.getAttachmentFile`, and
  `compose.addAttachment`.

## Non-goals

- `multipart/form-data` uploads.
- Reading or writing files by filesystem path on the Thunderbird host.
- Attaching an attachment from another message by reference. Downloading and
  re-uploading satisfies this; forwarding already carries the original
  attachments.
- Inline attachments, `Content-ID` generation, attachment deletion, or
  attachment updates after a draft is saved.
- Adding attachments to calendar invitations; the existing `invite.ics` path is
  unchanged.
- Streaming a download directly from disk. The whole file is read into memory
  by Thunderbird's `getAttachmentFile` either way.

## Anti-goals

- Saving a draft with some requested attachments silently missing.
- Guessing a filename or content type in a way that changes what is sent.
- Letting a `partName` or filename cause path traversal or header injection.
- Accepting unbounded attachment payloads or decoded base64 content.

## Constraints

- The repo targets Thunderbird 128+. `messages.getAttachmentFile` returns a
  DOM `File`; `compose.addAttachment(tabId, { file, name })` accepts one.
- The HTTP layer currently decodes every request body as UTF-8 text and every
  normal response as a JSON string. Base64 upload is therefore the safe JSON
  representation.
- `background.js` runs in the WebExtension context; `experiment/api.js` owns
  the raw HTTP response. A raw download needs a new binary response function on
  the experiment bridge.
- `experiment/api.js` cannot call `messenger` directly; message resolution and
  file reading stay in the background.
- Bodies are read fully into memory. Attachment limits must be enforced before
  decoding or copying large content. The existing HTTP layer buffers the raw
  body; this feature does not add a global request-body cap (see Decisions).
- Existing browser-origin rejection, bearer auth, `Content-Type:
  application/json`, and the 120-second watchdog apply unchanged.

## Approaches Considered

### 1. Raw download + base64 in the JSON upload (selected)

`GET /messages/:id/attachments/:partName` returns the bytes with the
attachment's content type and a download filename. `?format=json` returns a
base64 envelope instead. `POST /messages` accepts an `attachments` array whose
entries carry `name`, optional `content_type`, and `data_base64`.

**Why selected:** It matches the requested contract exactly, uses the
Thunderbird APIs that already exist, and keeps upload handling in JSON. The
cost is a new binary response path in the experiment bridge and base64's ~33%
size overhead.

### 2. Base64 JSON in both directions

The download endpoint always returns `{ data_base64 }`. This is the simplest
bridge because the existing string response path is enough, and it is uniform
for LLM tooling. It does not literally return the file, and every client must
decode it. Rejected because the user explicitly wants a file download.

### 3. Raw download + multipart upload

`POST /messages` uses `multipart/form-data` with file parts. This avoids base64
inflation and supports `curl -F`, but the HTTP layer currently assumes UTF-8
text bodies and the background expects JSON. It would add a multipart parser and
change the API contract. Rejected because the requested upload is a JSON field.

## Design

### Listing attachments

`GET /messages/:id` keeps its current attachment array and adds:

```json
{
  "name": "report.pdf",
  "size": 12345,
  "contentType": "application/pdf",
  "partName": "1.2",
  "content_id": "<inline-image>",
  "download_url": "/messages/abc%40example.com/attachments/1.2"
}
```

- `partName` is the value from `messages.listAttachments` and is the download
  identifier.
- `content_id` is copied when present (`contentId` on the native attachment).
- `inline` is included only when Thunderbird reports `contentDisposition`
  (140+): true for `inline`, false for `attachment`. On Thunderbird 128 that
  field does not exist, so `inline` is omitted rather than fabricated. This is
  the same "unknown stays absent" rule the repo already uses for `answered`,
  `forwarded`, and `has_attachment`.
- `download_url` is a path relative to the API root. The message reference and
  `partName` are URL-encoded. A client that already has the message and
  `partName` may construct the URL itself.
- The existing `contentType` key is kept for backward compatibility; new
  JSON-only fields use snake_case (`content_type`, `content_id`) like the rest
  of the email surface.

### Download

```http
GET /messages/:id/attachments/:partName
```

- `:id` is resolved by the existing message resolver, so a Message-ID with or
  without angle brackets, or an internal numeric ID, works.
- The background lists the message's attachments and requires an exact
  `partName` match. Unknown part names are `404 attachment_not_found`, not an
  empty file.
- `messages.getAttachmentFile(id, partName)` supplies the `File`.
- The route validates `partName` against the same shape Thunderbird accepts:
  `^\d+(\.\d+\$?)*$`. Anything else is `400 invalid_part_name` before the
  native call.
- Default response is raw bytes:
  - `Content-Type`: the attachment's content type, or `application/octet-stream`
    when missing.
  - `Content-Length`: exact byte length.
  - `Content-Disposition: attachment; filename="<fallback>";
    filename*=UTF-8''<percent-encoded-name>`.
  - `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.
- `?format=json` returns:

  ```json
  {
    "message_id": "abc@example.com",
    "partName": "1.2",
    "name": "report.pdf",
    "content_type": "application/pdf",
    "size": 12345,
    "data_base64": "JVBERi0x..."
  }
  ```

- Any other `format` value is `400 invalid_parameter`.
- Downloads are not artificially size-capped. `getAttachmentFile` already
  loads the file, and the HTTP server has no streaming path. The raw response
  writes the bytes directly; the JSON form pays the base64 overhead.

### Upload

`POST /messages` accepts an optional `attachments` array:

```json
{
  "to": "recipient@example.com",
  "subject": "Report",
  "body": "See attached",
  "attachments": [
    {
      "name": "report.pdf",
      "content_type": "application/pdf",
      "data_base64": "JVBERi0x..."
    }
  ]
}
```

- `name` is required. `content_type` defaults to
  `application/octet-stream`. `data_base64` must be present and must be
  standard base64: the `A-Z a-z 0-9 + /` alphabet, whitespace stripped, and
  `=` padding optional. The URL-safe `-`/`_` alphabet is rejected. An explicit
  empty string (`""`) is a valid zero-byte attachment; an absent
  `data_base64` is `invalid_attachment`.
- Per-item aliases: `filename`/`fileName` for `name`, `contentType`/`mime_type`/
  `mimeType` for `content_type`, and `data`/`content`/`base64`/`dataBase64` for
  `data_base64`.
- Top-level aliases: `attachment` and `files` for `attachments`.
- The field applies to new messages, replies, and forwards. For a forward,
  Thunderbird's own forwarding may already include the original attachments;
  the supplied files are added on top.
- Attachments are added after the compose window is created and the body is
  prepared, and before `saveMessage`. If any attachment fails, the whole
  request fails, the compose tab is closed best-effort, and no draft is saved.
  Partial drafts are never reported as success.
- Success responses gain an `attachments` array with `name`, `content_type`,
  and `size` for each file actually added.

### Encoding and limits

A new `tb-api/api/attachments.js` holds pure helpers shared by the background
and the experiment:

- `encodeBase64(bytes)` for downloads.
- `decodeBase64(text)` for uploads and for the experiment's binary writer.
- Validation and limit helpers used by `POST /messages`.

Limits are constants, enforced on decoded byte counts:

- 10 MiB per attachment.
- 25 MiB total per request.
- 20 attachments per request.

The base64 length is checked before decoding so an oversized payload is
rejected without allocating the decoded copy. The raw request body is still
buffered by the existing HTTP layer; this feature does not add a global body
cap. Exceeding an attachment limit is `413 attachment_too_large`; more than 20
entries is `400 too_many_attachments`.

### Transport

Normal responses remain JSON strings. A raw download is returned as an envelope
from the background:

```js
{ statusCode: 200, headers: { ... }, binaryBodyBase64: "..." }
```

`background.js` detects `binaryBodyBase64` and calls a new
`browser.httpServer.sendBinaryResponse(requestId, statusCode, headers,
bodyBase64)` instead of `sendResponse`. `experiment/api.js` implements that
function with `nsIBinaryOutputStream` and the shared base64 decoder, sets the
status line and headers, writes the byte array, and finishes the response. The
watchdog and pending-request bookkeeping are the same as for JSON responses.

`experiment/api.js` loads `api/attachments.js` into its own scope, alongside
the existing `api/utils.js` load for calendar. The manifest's background
`scripts` list includes `api/attachments.js` before `api/email.js`.

### Security

- `partName` is validated against Thunderbird's own pattern; it is never used
  as a path.
- Attachment filenames are rejected when they contain `/`, `\`, control
  characters, or only whitespace. This prevents a name from being interpreted
  as a path or injecting a header.
- `Content-Type` is rejected when it contains CR/LF; the fallback is
  `application/octet-stream`.
- `Content-Disposition` uses a quoted ASCII fallback plus RFC 5987
  `filename*=UTF-8''...`, so Unicode names survive without breaking the header.
- `X-Content-Type-Options: nosniff` prevents an HTML attachment from being
  treated as an active document.
- Auth, origin rejection, and the JSON `Content-Type` requirement are unchanged.

### Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| `invalid_attachment` | 400 | Missing name/data, invalid base64, or unsafe filename |
| `attachment_too_large` | 413 | A file or the total exceeds the limit |
| `too_many_attachments` | 400 | More than 20 files |
| `invalid_part_name` | 400 | `partName` does not match the MIME-part pattern |
| `attachment_not_found` | 404 | The message has no attachment with that `partName` |
| `attachment_failed` | 500 | Thunderbird could not read or add the attachment |
| `compose_failed` | 500 | The draft could not be saved (existing code, reused) |

## Testing

- New `tests/test-attachments.js` covering:
  - `GET /messages/:id` reports `partName`, `content_id`, and `download_url`,
    and reports `inline` only when the native attachment has
    `contentDisposition`.
  - Raw download returns exact bytes, content type, length, disposition, and
    no-sniff headers.
  - `?format=json` returns the base64 envelope; an unknown format is 400.
  - Unknown and malformed `partName` values are 404/400 without a native call.
  - `POST /messages` attaches one and several files, including Unicode names,
    missing content types, and an explicit zero-byte file.
  - Attachments are added before `saveMessage` for new, reply, and forward.
  - Invalid base64 (including URL-safe input), unsafe names, oversized files,
    total overflow, and more than 20 files are rejected without creating a
    draft.
  - An `addAttachment` failure closes the compose tab and saves no draft.
- Extend `tests/helpers/harness.js` with attachment fixtures:
  `listAttachments`/`getAttachmentFile` fakes, a binary output stream fake,
  byte recording on the fake response, and exposed compose calls.
- Update `tests/test-docs-consistency.js` so the new nested route is extracted,
  included in the expected route list, described by `GET /`, and documented in
  `README.md`.
- Update `README.md`, `SKILL.md`, `CHANGELOG.md`, and the `GET /` endpoint
  descriptions.
- The existing Node suite remains the required check:
  `node --test tests/test-*.js`. Live shell scripts may be extended later; they
  are not required for this feature.

## Files Expected to Change

- `tb-api/api/attachments.js` (new): base64, validation, limits.
- `tb-api/api/email.js`: attachment download, listing fields, compose field.
- `tb-api/background.js`: download route, binary response envelope, docs text.
- `tb-api/experiment/api.js`: binary response function, attachment scope.
- `tb-api/experiment/schema.json`: `sendBinaryResponse`.
- `tb-api/manifest.json`: load `api/attachments.js` in the background.
- `tests/helpers/harness.js`: attachment and binary fakes.
- `tests/test-attachments.js` (new).
- `tests/test-docs-consistency.js`: route extraction/expectations.
- `README.md`, `SKILL.md`, `CHANGELOG.md`.

## Decisions Made Here (not yet agreed by the human partner)

- Raw bytes are the download default; `?format=json` is the opt-in base64 form.
- The route is nested under the message:
  `GET /messages/:id/attachments/:partName`.
- Upload limits are 10 MiB per file, 25 MiB total, 20 files.
- A failed attachment fails the whole draft; no partial draft is saved.
- `attachments` applies to new, reply, and forward drafts.
- Duplicate attachment names are allowed; the API preserves each entry.
- Downloads have no API-level size cap.
- `inline` is omitted on Thunderbird 128 because `contentDisposition` is not
  available there; `content_id` is still reported when present.
- Upload base64 accepts optional `=` padding and rejects the URL-safe
  alphabet; an explicit empty string is a zero-byte file.
- No global request-body cap is added; the attachment limits are the bound for
  this feature.

## Left to the Builder

- The exact base64 implementation and byte-array conversion details.
- The precise header-escaping helper and its tests.
- Fixture shape for fake attachment files in the harness.
- Whether the JSON download envelope should also include a `download_url`
  (the design includes `message_id` and `partName`, which are sufficient).
- Any refactoring needed to keep `background.js` readable as routes grow.
