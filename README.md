# Thunderbird REST API

[![CI](https://github.com/julianprester/tb-api/actions/workflows/ci.yml/badge.svg)](https://github.com/julianprester/tb-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Thunderbird 115+](https://img.shields.io/badge/Thunderbird-115%2B-blue.svg)](https://www.thunderbird.net/)

A Thunderbird extension that exposes email, calendar, and contacts via a REST API for AI agents and automation.

## Features

- **LLM-friendly design**: Flexible parameter aliases, fuzzy matching, and helpful error messages with suggestions
- **Natural language dates**: Use "today", "tomorrow", "2 days ago", "next week", or ISO 8601 formats
- **Smart defaults**: Auto-selects calendars/address books when only one writable option exists
- **Calendar invitations**: Create events with attendees and prepare ICS invitation drafts; opt in to sending immediately with `TB_API_ALLOW_SEND=1`
- **Opt-in folder refresh**: Synchronize an IMAP folder before searching its local messages

## Installation

### Option 1: Load Temporarily (Development)

1. Download or clone this repository
2. In Thunderbird, go to **Add-ons and Themes** (Tools menu or `Ctrl+Shift+A`)
3. Click the gear icon and select **Debug Add-ons**
4. Click **Load Temporary Add-on** and select the `tb-api/manifest.json` file

### Option 2: Install XPI Package

1. Build the package: `./build.sh`
2. In Thunderbird, go to **Add-ons and Themes**
3. Click the gear icon and select **Install Add-on From File**
4. Select the `tb-api.xpi` file

### Option 3: Docker

See the [Docker documentation](docker/README.md) for containerized deployment.

The API server starts automatically on `http://localhost:9595`.

## API Reference

### Base URL

```
http://localhost:9595
```

### API Info

```http
GET /
```

Returns API version, available endpoints, and usage tips.

---

### Email

#### List Mailboxes

```http
GET /mailboxes
```

Returns all mail folders with unread/total counts.

#### Refresh Folder

```http
POST /mailboxes/refresh
Content-Type: application/json
```

Refresh a concrete IMAP folder and wait for Thunderbird's folder update to complete.
Accepts a folder ID, name, or role using the same resolver as message search. Prefer
an exact ID from `GET /mailboxes` when multiple accounts have similarly named folders.

```json
{
  "mailbox": "sent",
  "timeoutMs": 30000
}
```

| Parameter | Aliases | Type | Description |
|-----------|---------|------|-------------|
| mailbox | folder, mailboxId, folderId, box | string | Folder ID, name, or role (required) |
| timeoutMs | timeout_ms, timeout | integer | Per-caller deadline in milliseconds (default 30000, range 1–60000) |

Parameters can also be supplied in the query string:

```bash
curl --max-time 65 -X POST "http://localhost:9595/mailboxes/refresh?mailbox=sent"
```

Successful refresh:

```json
{"folder_id":"account1://Sent","mailbox":"Sent","refreshed":true,"elapsed_ms":120}
```

Local folders have no remote server to synchronize and return an explicit no-op:

```json
{"folder_id":"account1://Local","mailbox":"Local","refreshed":false,"skipped":true,"reason":"local_folder"}
```

Account roots, virtual/unified folders, non-selectable IMAP folders, and other remote
protocols are not supported. Refresh does not recurse into subfolders or refresh an
entire account. Thunderbird must be online for IMAP refresh. Versions without
Thunderbird's native folder-ID resolver return `503` with `code: "refresh_unavailable"`.

Concurrent requests for the same native folder share one update, with independent
caller deadlines. A timeout returns `504`; it does not cancel Thunderbird's network
operation. Until that operation completes, retries share it rather than start another
update. Stopping the API or unloading the extension clears its waiting state.

A refresh succeeds when an update of that folder finishes after the request was made.
Thunderbird may already be updating the folder (for example when the folder was just
opened in the UI); it then drops the update listener handed to it, but still announces
`FolderLoaded` when the running update finishes, and the request completes with
`"via": "folder_loaded"`. If neither signal arrives within five minutes, the operation
is abandoned with `504 refresh_stalled` so it cannot block later refreshes; the next
request starts a new update.

Refresh synchronizes folder state and message headers, not necessarily offline copies
of message bodies. Normal Thunderbird update behavior, including configured incoming
mail filters, can run.

#### List Identities

```http
GET /identities
```

Returns available sending identities (email accounts configured in Thunderbird).

#### Search Messages

```http
GET /messages
```

| Parameter | Aliases | Type | Description |
|-----------|---------|------|-------------|
| text | q, query, search | string | Full-text search in message content |
| from | sender, author | string | Filter by sender |
| to | recipient | string | Filter by recipient |
| subject | | string | Filter by subject |
| mailbox | folder, mailboxId, folderId, box | string | Filter by folder ID, name, or role (inbox, sent, drafts...) |
| after | since | string | Messages after date |
| before | until | string | Messages before date |
| limit | | number | Max results (default 50, max 100) |
| read | seen, opened | boolean | Filter by read status (`true` = read, `false` = unread) |
| unread | unseen | boolean | Filter by unread status (`true` = unread, `false` = read) |
| refresh | | boolean | Refresh the selected folder before searching (default false; requires mailbox) |
| include_preview | includePreview | boolean | Include `preview` and `has_attachment` (default true). `false` returns header-only results and reads no message bodies |
| timeoutMs | timeout_ms, timeout | integer | Refresh deadline in milliseconds (default 30000, range 1–60000) |
| sort | | string | Result order: `date_desc` (default, newest first) or `date_asc` (oldest first) |

**Date formats**: ISO 8601 (`2024-01-15`), or natural language (`today`, `yesterday`, `2 days ago`, `last week`)

Example:
```bash
curl "http://localhost:9595/messages?mailbox=inbox&limit=10"
curl "http://localhost:9595/messages?from=alice@example.com&after=2024-01-01"
curl "http://localhost:9595/messages?q=meeting&after=yesterday"
curl --max-time 65 "http://localhost:9595/messages?mailbox=sent&refresh=true&after=yesterday"
```

Searches normally use Thunderbird's local database. With `refresh=true`, the exact
resolved folder is refreshed before the query starts. The response includes a
`refresh` object (also when no messages match). A requested refresh failure returns
an error instead of silently returning potentially stale results. `refresh=false`
or `refresh=0` never triggers synchronization; true/false and 1/0 are accepted.
Unscoped searches with `refresh=true` are rejected, since no single folder has been
selected to refresh. `timeoutMs` is only used when refresh is enabled.

**Ordering and bounded work:** Results are newest first by default
(`sort=date_desc`); `sort=date_asc` returns the oldest matches first. An unknown
`sort` value is a `400` with `code: "invalid_parameter"`.

Thunderbird returns matches page by page in database order (oldest first), so
finding the newest matches means scanning every page. Searches read pages of 500
messages under a 20-second budget. Responses report `complete`; when the whole
result set was scanned they also report the exact `matched` count and set
`has_more` to `matched > limit`. If the budget expires, the response contains
the newest matches found so far with `complete: false`, `has_more: true` and a
`warnings` array, and the background scan is aborted so Thunderbird stops using
CPU. If not even the first page arrives in time, the request fails with `504`
and `code: "search_timeout"` instead of an empty list. Narrow a slow search with
`after=`/`before=` or `mailbox=`.

**Full-text search:** `q`/`text` scans message bodies (Thunderbird matches the
subject and author first, then parses each message's MIME tree), so it can be
slow. For IMAP folders that are not stored offline, Thunderbird downloads the
messages to search them. Subject and full-text matching in Thunderbird is
case-sensitive, so search for the text exactly as it appears.

**Read status:** Every returned message includes a boolean `read`: `true` means
read, `false` means unread. This is also included in single-message responses.
The existing `flags` array still contains `"read"` only for read messages. Reading
through the API does not itself mark messages read; use `PATCH /messages` with
`add_flags: ["read"]` or `remove_flags: ["read"]` to change that state.

Older builds omitted `read`; their missing field could appear as `null`/`None` to
clients even though `flags` and read/unread filters worked. Reload the updated
extension to get the explicit field. Do not convert a valid `false` into null
(e.g. `jq '.read // null'` or Python `message.get("read") or None`); access `read`
directly instead. Read status reflects Thunderbird's local state; use a scoped
`refresh=true` search when current IMAP state is needed.

**Attachments and message flags:** Every returned message includes the boolean
fields `read` and `draft` (`draft: true` for messages in a Drafts or Templates
folder; Thunderbird's message header carries no draft flag, so the folder's
special use is used). The `flags` array reports `read`, `flagged`, `junk`,
`draft`, `answered`, and `forwarded` as applicable. `answered` and `forwarded`
are read from Thunderbird's internal message headers. They are only present when
Thunderbird can report them; an absent `answered`/`forwarded` means unknown and
must not be treated as `false`.

With the default `include_preview=true`, each returned message also includes
`has_attachment` (boolean) and `preview` (first 500 characters of the plain-text
body). Both require opening the message's MIME tree, which on IMAP folders not
stored offline downloads message content. Set `include_preview=false` for a cheap
header-only listing: `preview` and `has_attachment` are then omitted entirely and
no message bodies are read. This is useful for triaging which messages to fetch
in full afterwards.

#### Get Message

```http
GET /messages/:message_id
```

Returns full message content including body and attachments. The `message_id` is the Message-ID header value (URL-encoded). Angle brackets are optional: Thunderbird stores Message-IDs without them, and the API compares the text exactly, so `<abc123@example.com>`, `abc123@example.com` and surrounding whitespace are equivalent. The response includes the boolean `read` and `draft` fields and a `flags` array (`read`, `flagged`, `junk`, `draft`).

If the same Message-ID appears in several folders (for example an Inbox copy and an archived copy), the first match is returned and the response includes `matches`, the number of copies found. To choose a specific copy, search by `mailbox` first and use the internal `id` from the result (a `mailbox` parameter for GET/PATCH is a planned follow-up).

Example:
```bash
curl "http://localhost:9595/messages/%3Cabc123%40example.com%3E"
curl "http://localhost:9595/messages/abc123%40example.com"
```

#### Compose Message

```http
POST /messages
Content-Type: application/json
```

Creates a new message, reply, or forward. **Always saves as draft** (sending disabled for safety).

**New message:**
```json
{
  "to": "recipient@example.com",
  "subject": "Hello",
  "body": "Message content",
  "cc": "cc@example.com",
  "bcc": "bcc@example.com",
  "identity": "sender@example.com"
}
```

**Reply to message:**
```json
{
  "in_reply_to": "<original-message-id@example.com>",
  "body": "My reply text"
}
```

**Forward message:**
```json
{
  "forward_of": "<original-message-id@example.com>",
  "to": "forward-to@example.com",
  "body": "FYI, see below"
}
```

| Parameter | Aliases | Description |
|-----------|---------|-------------|
| to | | Recipient(s) - required for new/forward |
| cc | | CC recipient(s) |
| bcc | | BCC recipient(s) |
| subject | | Subject line |
| body | | Message body |
| identity | | Sender identity (email or ID) |
| in_reply_to | inReplyTo, reply_to | Message-ID to reply to |
| forward_of | forwardOf, forward | Message-ID to forward |

#### Update Messages

```http
PATCH /messages
Content-Type: application/json
```

Update flags and/or move messages. Flags are applied first, then the move;
both run in the same request and per-message outcomes are reported.

```json
{
  "ids": ["<id1@example.com>", "<id2@example.com>"],
  "add_flags": ["read", "flagged"],
  "remove_flags": ["junk"],
  "move_to": "Archive"
}
```

| Parameter | Aliases | Description |
|-----------|---------|-------------|
| ids | id, message_ids | Array of Message-IDs or internal IDs |
| add_flags | addFlags, add, flags | Flags to add |
| remove_flags | removeFlags, remove | Flags to remove |
| move_to | moveTo, destination, folder, mailbox | Destination folder |

**Flag aliases**: `read`/`seen`/`opened`, `flagged`/`starred`/`important`/`flag`, `junk`/`spam`, and the inverse `unread`/`unseen` (`add_flags: ["unread"]` clears `read`; `remove_flags: ["unread"]` sets it). Unknown flags are a `400 invalid_parameter` that names them; a flag may not appear in both `add_flags` and `remove_flags`.

Response shapes:

| Result | Body |
|--------|------|
| Every message updated/moved | `200 { "success": true, "updated": n, "moved": n, "results": [...] }` |
| Some messages failed | `207 { "success": false, "partial": true, "updated": n, "moved": n, "not_found": [...], "results": [...] }` |
| No message was changed | `502 { "error": "...", "code": "update_failed", "results": [...] }` |

`results` has one entry per resolved message: `{ "ref", "id", "updated", "moved", "error"? }` (`error` is present when the flag update or the move failed). Unresolved `ids` are listed in `not_found` and count as failures. The destination is resolved before any change, so a bad `move_to` returns `404`/`409` and nothing is updated.


`ids` entries can be Message-IDs with or without angle brackets (and surrounding
spaces) or internal numeric IDs. When a Message-ID appears in several folders,
only the first match is changed; use the internal `id` returned by search to
target a specific copy.

---

### Calendar

#### List Calendars

```http
GET /calendars
```

Returns all calendars with their IDs, names, and read-only status.

#### List Events

```http
GET /events
```

| Parameter | Aliases | Type | Description |
|-----------|---------|------|-------------|
| calendar | calendarId, cal | string | Filter by calendar ID or name |
| start | startDate, from, begin | string | Events starting after (default: now) |
| end | endDate, to, until | string | Events ending before (default: +30 days) |

Example:
```bash
curl "http://localhost:9595/events"
curl "http://localhost:9595/events?start=today&end=next+week"
curl "http://localhost:9595/events?calendar=Work&start=2024-01-01"
```

#### Create Event

```http
POST /events
Content-Type: application/json
```

```json
{
  "calendar": "Personal",
  "title": "Team Meeting",
  "start": "2024-01-15T10:00:00",
  "end": "2024-01-15T11:00:00",
  "location": "Room 101",
  "description": "Weekly sync",
  "organizer": {"email": "me@example.com", "name": "My Name"},
  "attendees": [
    {"email": "alice@example.com", "name": "Alice"},
    "bob@example.com"
  ],
  "sendInvites": true
}
```

| Parameter | Aliases | Required | Description |
|-----------|---------|----------|-------------|
| title | summary, name | Yes | Event title |
| start | startDate, from | Yes | Start date/time |
| end | endDate, to | Yes | End date/time |
| calendar | calendarId, cal | Auto* | Calendar ID or name |
| location | place, where | No | Event location |
| description | desc, details, notes | No | Event description |
| organizer | host, owner | No | Organizer email or {email, name}; must be one of your identities |
| attendees | participants, invitees, guests | No | Array of emails or {email, name, role, status} |
| sendInvites | send_invites, notify | No | Strict boolean alias for `inviteMode: "draft"` |
| inviteMode | invite_mode | No | `draft` (default) saves the invitation as a draft; `send` sends immediately (requires `TB_API_ALLOW_SEND=1`) |

*Calendar auto-selected if only one writable calendar exists

Creating an event returns `201 Created` with `invitations: { "status": "draft_saved"
| "sent" | "queued" | "failed", "error"? }` when invitations were requested.

**Invitations are drafts by default.** `sendInvites: true` (or
`inviteMode: "draft"`) creates a mail in the Drafts folder with `invite.ics`
attached; nothing is sent. Sending immediately requires **both**
`inviteMode: "send"` and the environment variable `TB_API_ALLOW_SEND=1`
(without it the request is `403 sending_disabled` and no event is created).
`inviteMode: "send"` cannot be combined with anything else to bypass this.

Invitations are **not** sent by `PATCH /events/:id` or `DELETE /events/:id`:
edits and cancellations do not mail the attendees.

`organizer` must match one of the sending identities configured in
Thunderbird; anything else is `400 invalid_parameter` and no event is created
(the API never silently sends from a different account).

#### Update Event

```http
PATCH /events/:id?calendar=calendar-id
Content-Type: application/json
```

The `calendar` parameter is required to identify which calendar contains the event.

```json
{
  "calendar": "Personal",
  "title": "Updated Title",
  "start": "2024-01-15T11:00:00",
  "attendees": [
    {"email": "alice@example.com", "name": "Alice"},
    {"email": "charlie@example.com", "name": "Charlie"}
  ]
}
```

Note: Updating `attendees` replaces all existing attendees.

#### Delete Event

```http
DELETE /events/:id?calendar=calendar-id
```

The `calendar` parameter is required.

---

### Contacts

#### List Address Books

```http
GET /addressbooks
```

Returns all address books with read-only status.

#### Search Contacts

```http
GET /contacts
```

| Parameter | Aliases | Type | Description |
|-----------|---------|------|-------------|
| q | query, search | string | Search in name and email |
| addressbook | book | string | Filter by address book ID or name |
| limit | | number | Max results (default 50) |

Example:
```bash
curl "http://localhost:9595/contacts?q=alice"
curl "http://localhost:9595/contacts?addressbook=Personal&limit=100"
```

#### Create Contact

```http
POST /contacts
Content-Type: application/json
```

```json
{
  "addressbook": "Personal",
  "email": "alice@example.com",
  "firstName": "Alice",
  "lastName": "Smith",
  "displayName": "Alice Smith"
}
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| email | Yes | Email address |
| firstName | No | First name |
| lastName | No | Last name |
| displayName | No | Display name (auto-generated if omitted) |
| addressbook | Auto* | Address book ID or name |

*Address book auto-selected if only one writable book exists

#### Update Contact

```http
PATCH /contacts/:id
Content-Type: application/json
```

```json
{
  "firstName": "Alicia",
  "lastName": "Johnson"
}
```

#### Delete Contact

```http
DELETE /contacts/:id
```

---

## Response Format

### Success (list)

```json
{
  "messages": [...],
  "total": 42,
  "has_more": false
}
```

### Success (mutation)

```json
{
  "success": true,
  "message": "Event created",
  "id": "..."
}
```

### Error

```json
{
  "error": "Mailbox not found: \"inbx\"",
  "code": "folder_not_found",
  "suggestions": [
    "Did you mean: inbox?",
    "Valid roles: archives, drafts, inbox, junk, outbox, sent, templates, trash",
    "Use GET /mailboxes to see all available folders"
  ]
}
```

`code` is stable and machine-readable: match on it. `error` is human-readable
and may be reworded between releases. `suggestions` is present when the API can
recommend a fix.

| Code | HTTP status | Meaning |
|------|-------------|---------|
| `invalid_body` | 400 | Request body is not a JSON object |
| `invalid_query` | 400 | Query string could not be parsed |
| `invalid_parameter` | 400 | Missing or invalid parameter |
| `invalid_filter` | 400 | Invalid message filter value |
| `invalid_date` | 400 | Date could not be parsed |
| `not_found` | 404 | Requested resource does not exist |
| `folder_not_found` | 404 | Mail folder does not exist |
| `ambiguous_target` | 409 | Several targets match; specify one |
| `ambiguous_recurrence` | 409 | Recurring event needs `recurrenceId` or `scope=series` |
| `read_only` | 403 | Calendar or address book is read-only |
| `sending_disabled` | 403 | Sending invitations is disabled (`TB_API_ALLOW_SEND`) |
| `update_failed` | 500/502 | Updating an existing resource failed; `PATCH /messages` uses 502 when no message could be changed |
| `request_timeout` | 504 | The request was not answered in time |

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 201 | Created (`POST /events`) |
| 207 | Partial success (some messages were updated/moved, some failed) |
| 400 | Bad request (missing/invalid parameters) |
| 403 | Forbidden (read-only target, sending disabled, rejected origin) |
| 404 | Resource not found |
| 405 | Method not allowed |
| 409 | Ambiguous target (specify the calendar or occurrence) |
| 500 | Internal server error |
| 502 | Thunderbird's folder update failed |
| 503 | Thunderbird offline or refresh unavailable/stopped |
| 504 | Request or folder refresh exceeded the deadline |

Folder-refresh errors additionally use machine-readable codes such as
`refresh_timeout`, `refresh_stalled`, `thunderbird_offline`, or
`unsupported_folder`.

---

## Authentication

By default, the API has no authentication and only binds to localhost. For production use, set the `TB_API_TOKEN` environment variable:

```bash
export TB_API_TOKEN="your-secret-token"
```

All requests must then include:
```
Authorization: Bearer your-secret-token
```

See [SECURITY.md](SECURITY.md) for more details.

### Sending invitations

Calendar invitations are saved as **drafts** by default, matching the
"drafts only" promise of `POST /messages`. To let `POST /events` send an
invitation immediately, set:

```bash
export TB_API_ALLOW_SEND=1
```

and pass `"inviteMode": "send"`. `sendInvites: true` always prepares a draft,
with or without the variable. Without the variable a `send` request is refused
with `403 sending_disabled` and no event is created.

---

## Testing

Run the mocked refresh tests without Thunderbird or network access:

```bash
node --test tests/test-refresh-folder.js
```

These cover native listener completion, errors/timeouts, concurrent callers,
folder targeting, search ordering, HTTP routing, and authentication. CI runs them.

The shell integration scripts require a running, configured Thunderbird API:

```bash
# Read-only endpoint tests
./tests/test-api.sh

# Write operation tests (creates/modifies data)
./tests/test-write-api.sh

# Comprehensive edge case tests
./tests/test-comprehensive.sh
```

To verify real IMAP synchronization, use a disposable test folder: deliver a new
message using another client, call `POST /mailboxes/refresh` for its exact folder ID,
and confirm a subsequent `GET /messages?mailbox=...` returns that Message-ID. Also
verify the one-shot `refresh=true` search. Mocked tests do not establish real server
synchronization or body download behavior.

---

## Development

### Project Structure

```
.
├── tb-api/                     # Extension source code
│   ├── manifest.json           # Extension manifest
│   ├── background.js           # HTTP request routing
│   ├── api/
│   │   ├── utils.js            # Shared utilities (date parsing, fuzzy matching)
│   │   ├── email.js            # Email operations
│   │   ├── contacts.js         # Contact operations
│   │   └── calendar.js         # Calendar operations
│   ├── experiment/
│   │   ├── api.js              # HTTP server setup (privileged context)
│   │   ├── folders.js          # Native folder refresh and concurrent caller lifecycle
│   │   └── schema.json         # Experiment API schema
│   └── lib/
│       ├── httpd.js            # Mozilla HTTP server
│       └── ical.js             # iCalendar library
├── docker/                     # Docker deployment
├── tests/                      # API test scripts
├── build.sh                    # Build script
└── README.md
```

### Reloading Changes

- **Background script or manifest changes**: Reload from Debug Add-ons page
- **ES Module changes**: Requires full Thunderbird restart (modules are cached)

### Building

```bash
./build.sh
```

Creates `tb-api.xpi` package for distribution.

---

## Requirements

- Thunderbird 115 or later

## License

MIT
