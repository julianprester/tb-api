# Thunderbird REST API

[![CI](https://github.com/julianprester/tb-api/actions/workflows/ci.yml/badge.svg)](https://github.com/julianprester/tb-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Thunderbird 115+](https://img.shields.io/badge/Thunderbird-115%2B-blue.svg)](https://www.thunderbird.net/)

A Thunderbird extension that exposes email, calendar, and contacts via a REST API for AI agents and automation.

## Features

- **LLM-friendly design**: Flexible parameter aliases, fuzzy matching, and helpful error messages with suggestions
- **Natural language dates**: Use "today", "tomorrow", "2 days ago", "next week", or ISO 8601 formats
- **Smart defaults**: Auto-selects calendars/address books when only one writable option exists
- **Calendar invitations**: Create events with attendees and send ICS invitation emails
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
| refresh | | boolean | Refresh the selected folder before searching (default false; requires mailbox) |
| timeoutMs | timeout_ms, timeout | integer | Refresh deadline in milliseconds (default 30000, range 1–60000) |

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

#### Get Message

```http
GET /messages/:message_id
```

Returns full message content including body and attachments. The `message_id` is the Message-ID header value (URL-encoded). Angle brackets are optional.

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

Update flags or move messages.

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

**Flag aliases**: `read`/`seen`, `flagged`/`starred`/`important`, `junk`/`spam`

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
| organizer | host, owner | No | Organizer email or {email, name} |
| attendees | participants, invitees, guests | No | Array of emails or {email, name, role, status} |
| sendInvites | send_invites, notify | No | Send ICS invitation emails (requires organizer) |

*Calendar auto-selected if only one writable calendar exists

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
  "suggestions": [
    "Did you mean: inbox?",
    "Valid roles: archives, drafts, inbox, junk, outbox, sent, templates, trash",
    "Use GET /mailboxes to see all available folders"
  ]
}
```

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Bad request (missing/invalid parameters) |
| 404 | Resource not found |
| 405 | Method not allowed |
| 500 | Internal server error |
| 502 | Thunderbird's folder update failed |
| 503 | Thunderbird offline or refresh unavailable/stopped |
| 504 | Folder refresh exceeded the caller's deadline |

Refresh errors include a machine-readable `code`, such as `refresh_timeout`,
`thunderbird_offline`, or `unsupported_folder`.

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
