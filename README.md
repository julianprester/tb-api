# Thunderbird REST API

[![CI](https://github.com/julianprester/tb-api/actions/workflows/ci.yml/badge.svg)](https://github.com/julianprester/tb-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Thunderbird 128+](https://img.shields.io/badge/Thunderbird-128%2B-blue.svg)](https://www.thunderbird.net/)

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
{"folder_id":"account1://Sent","mailbox":"Sent","refreshed":true,"elapsed_ms":120,"resolved_mailbox":{"id":"account1://Sent","name":"Sent","matched_by":"role"}}
```

The response includes `resolved_mailbox: { "id", "name", "matched_by" }`: the
folder that was refreshed and how it was matched (`id`, `role`, `name`, or
`fuzzy`). Reporting a fuzzy choice makes a typo visible instead of silently
refreshing a different folder.

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
| text | q, query, search, keyword, keywords | string | Full-text search in message content |
| from | sender, author | string | Filter by sender |
| to | recipient, recipients | string | Filter by recipient |
| subject | subj | string | Filter by subject |
| mailbox | folder, mailboxId, folderId, box | string | Filter by folder ID, name, or role (inbox, sent, drafts...) |
| after | since, from_date, fromDate, start, startDate | string | Messages after date |
| before | until, to_date, toDate, end, endDate | string | Messages before date |
| limit | max, count, size, maxResults | number | Max results (default 50, max 100) |
| read | seen, opened | boolean | Filter by read status (`true` = read, `false` = unread) |
| unread | unseen | boolean | Filter by unread status (`true` = unread, `false` = read) |
| flagged | starred, important, flag | boolean | Filter by flagged/starred status |
| junk | spam | boolean | Filter by junk status |
| refresh | | boolean | Refresh the selected folder before searching (default false; requires mailbox) |
| include_preview | includePreview | boolean | Include `preview` and `has_attachment` (default true). `false` returns header-only results and reads no message bodies |
| timeoutMs | timeout_ms, timeout | integer | Refresh deadline in milliseconds (default 30000, range 1–60000) |
| sort | | string | Result order: `date_desc` (default, newest first) or `date_asc` (oldest first) |

**Strict booleans**: `refresh`, `include_preview`, `read`/`unread`, `flagged`
and `junk` accept only `true`/`false`/`1`/`0` (case-sensitive strings or
booleans). Any other supplied value is a `400 invalid_filter`/`400
invalid_refresh` instead of being silently ignored, and `read`/`unread` must
not contradict each other (`400 invalid_filter`).

**Date formats**: ISO 8601 (`2024-01-15T10:30:00`), date-only (`2024-01-15`,
local midnight), natural language (`today`, `yesterday`, `2 days ago`, `next
monday`), numeric dates carrying a four-digit year (`15/01/2024`,
`01-15-2024`) and JavaScript date strings with a four-digit year (`Jan 15
2024`). See [Date and Time Formats](#date-and-time-formats); forms without a
four-digit year such as `Jan 15` are rejected.

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

When a `mailbox` filter was supplied, the response also includes
`resolved_mailbox: { "id", "name", "matched_by" }`: the exact folder that was
searched and how it was matched (`id`, `role`, `name`, or `fuzzy`). Reporting a
fuzzy choice makes a typo visible instead of silently searching a different
folder. With `refresh=true` the response additionally carries the `refresh`
object described under [Refresh Folder](#refresh-folder).

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
stored offline downloads message content. `has_attachment` is omitted (not
`false`) when that MIME call fails, so an absent value means unknown. Set
`include_preview=false` for a cheap header-only listing: `preview` and
`has_attachment` are then omitted entirely and no message bodies are read. This
is useful for triaging which messages to fetch
in full afterwards.

#### Get Message

```http
GET /messages/:message_id
```

Returns full message content including body and attachments. The `message_id` is the Message-ID header value (URL-encoded). Angle brackets are optional: Thunderbird stores Message-IDs without them, and the API compares the text exactly, so `<abc123@example.com>`, `abc123@example.com` and surrounding whitespace are equivalent. The response includes the boolean `read` and `draft` fields and a `flags` array (`read`, `flagged`, `junk`, `draft`).

If the same Message-ID appears in several folders (for example an Inbox copy and an archived copy), the first match is returned and the response includes `matches`, the number of copies found. `matches` counts the copies in the first query page (Thunderbird returns one page per query); an internal numeric ID is looked up directly and reports `matches: 1`. To choose a specific copy, search by `mailbox` first and use the internal `id` from the result (a `mailbox` parameter for GET/PATCH is a planned follow-up). `PATCH` changes only the first match of a Message-ID.

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

Most parameters also accept their `snake_case` spelling (`start_date`,
`calendar_id`, `end_time`, ...); `start`/`end` accept the full
[date grammar](#date-and-time-formats).

When a `calendar` filter was supplied, the response also includes
`resolved_calendar: { "id", "name", "matched_by" }`: the calendar that was
read and how it was matched (`id`, `name`, or `fuzzy`). Reporting a fuzzy
choice makes a typo visible instead of silently reading a different calendar.

#### Upcoming Events

```http
GET /upcoming
```

Returns events between now and the end of today (local time), earliest first.
`calendar` (`calendarId`, `cal`) optionally restricts the result to one
calendar; names are fuzzy matched, as in `GET /events`.

```bash
curl "http://localhost:9595/upcoming"
curl "http://localhost:9595/upcoming?calendar=Work"
```

The response contains `events` (the same [event fields](#event-fields) as
`GET /events`), the window bounds `from`/`until` as local
`YYYY-MM-DDTHH:MM:SS`, and `hints` when nothing is left today. When `calendar`
was supplied, it also carries the same `resolved_calendar` object as
`GET /events`.

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
| allDay | all_day | No | Strict boolean: `true` stores a date-only (all-day) event. `start`/`end` must then be `YYYY-MM-DD` and `end` is the **exclusive** end date (default: start + 1 day) |
| sendInvites | send_invites, notify | No | Strict boolean alias for `inviteMode: "draft"` |
| inviteMode | invite_mode | No | `draft` (default) saves the invitation as a draft; `send` sends immediately (requires `TB_API_ALLOW_SEND=1`) |

*Calendar auto-selected if only one writable calendar exists

An all-day event defaults to exactly one day, so an explicit `end` is optional
when `allDay: true` (a date-only `end` is exclusive). Strict booleans
(`sendInvites`, `allDay`) reject any value other than `true`/`false`/`1`/`0`
with `400 invalid_filter`.

Creating an event returns `201 Created` with `invitations: { "status": "draft_saved"
| "sent" | "queued" | "failed", "error"? }` when invitations were requested.
`draft_saved` is the default; `sent`/`queued` need `inviteMode: "send"` plus
`TB_API_ALLOW_SEND=1`; `failed` carries an `error` and still leaves the created
event in place (a failed invitation is a warning, never a rolled-back event).
The response also reports the stored `id`, `calendar` (name), `title`, `start`,
`end`, `allDay`, and `organizer`/`attendees` when supplied.

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

`allDay` switches the stored representation (`true` = date-only, `false` =
timed); `start`/`end` move the event. When an all-day `start` is changed
without an `end`, the event covers exactly one day. See
[Recurring Events](#recurring-events) for `recurrenceId`/`scope`.

The response reports `id`, `title`, and for a recurring event the `scope`
(`"occurrence"` or `"series"`) plus the `recurrenceId` when one occurrence was
updated. `PATCH` never sends invitation updates.

#### Delete Event

```http
DELETE /events/:id?calendar=calendar-id
```

The `calendar` parameter is required. See
[Recurring Events](#recurring-events) for deleting one occurrence
(`recurrenceId`) or the whole series (`scope: "series"`). A recurring event
without either parameter is refused with `409 ambiguous_recurrence`. `DELETE`
never sends cancellation mails.

#### Recurring Events

`GET /events` and `GET /upcoming` return one entry per occurrence. An
occurrence carries `occurrence: true` and the `recurrenceId` to pass back to
`PATCH`/`DELETE`; the series itself is identified by the event `id`.

```bash
# Delete just this occurrence (timed series: UTC instant)
curl -X DELETE "http://localhost:9595/events/EVENT_ID?calendar=Work" \
  -H "Content-Type: application/json" \
  -d '{"recurrenceId": "2026-10-14T07:00:00Z"}'

# Update the whole series
curl -X PATCH "http://localhost:9595/events/EVENT_ID?calendar=Work" \
  -H "Content-Type: application/json" \
  -d '{"scope": "series", "title": "New title"}'
```

- `recurrenceId` targets exactly one occurrence. Timed occurrences use the UTC
  instant from `GET /events` (`2026-10-14T07:00:00Z`); all-day occurrences use
  the date (`2026-10-14`).
- `scope: "series"` targets the whole recurring series.
- The two are mutually exclusive (`400 invalid_parameter`), and any `scope`
  other than `"series"` is also `400 invalid_parameter`.
- Editing or deleting a recurring event without either parameter is refused
  with `409 ambiguous_recurrence`, so a series cannot be changed by accident.
- An unknown `recurrenceId` is `404 occurrence_not_found`; using `recurrenceId`
  on a non-recurring event is `400 not_recurring`.
- Non-recurring events keep working unchanged, even when `scope=series` is
  supplied.

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
| query | q, search, text | string | Search in name and email (case-insensitive) |
| addressbook | addressBook, book, bookId, addressBookId | string | Filter by address book ID or name |
| limit | max, count, size, maxResults | number | Max results (default 50, max 100) |

Contact parameters are normalized per domain: here `q`/`query`/`search` all mean
the contact search field (unlike `GET /messages`, where `q` means `text`).

Example:
```bash
curl "http://localhost:9595/contacts?q=alice"
curl "http://localhost:9595/contacts?addressbook=Personal&limit=100"
```

When `addressbook` was supplied, the response includes
`resolved_addressbook: { "id", "name", "matched_by" }`: the address book that
was searched and how it was matched (`id`, `name`, or `fuzzy`). Reporting a
fuzzy choice makes a typo visible instead of silently searching a different
address book.

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
| displayName | No | Display name (auto-generated if omitted); accepts `name`, `fullName` |
| addressbook | Auto* | Address book ID or name |

*Address book auto-selected if only one writable book exists

With several writable address books and no `addressbook`, the create is
refused with `409 ambiguous_target` (the writable books are listed in
`matches`) instead of writing to whichever comes first; nothing is created.

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

## Date and Time Formats

Every `after`/`before` (email) and `start`/`end` (events) value is parsed by
the same grammar. The `suggestions` array of a date parse error lists only
examples that parse.

| Form | Meaning |
|------|---------|
| `2024-01-15` | Calendar date at **local midnight** (not UTC) |
| `2024-01-15T10:30:00` | Local time; seconds and milliseconds optional |
| `2024-01-15T10:30:00Z`, `2024-01-15T10:30:00+02:00` | That exact instant (offset kept) |
| `now` | The current instant |
| `today`, `yesterday`, `tomorrow` | Local midnight of that day |
| `last week`, `next week`, `a week ago`, `last month`, `next month`, `a month ago` | Local midnight ± 7 days / ± 1 month |
| `3 days ago`, `in 2 weeks`, `4 months ago` | Local midnight ± N days/weeks/months |
| `monday`, `next monday`, `last friday`, `this wednesday` | Local midnight of that weekday |
| `15/01/2024`, `01-15-2024`, `31-12-2024` | Numeric date with a four-digit year |
| `Jan 15 2024`, `January 15 2024` | Anything else containing a four-digit year that JavaScript's date parser understands |

Details:

- Date-only values use **local midnight**; a bare date is never interpreted as
  UTC.
- Date-times without an offset are local time; `Z` and `±HH:MM` keep that exact
  instant.
- Weekdays are Monday-based. `next <weekday>` and a bare `<weekday>` mean the
  next occurrence **strictly after today** (so `next monday` on a Monday is +7
  days); `last <weekday>` is the most recent occurrence strictly before today;
  `this <weekday>` is that weekday in the current ISO week (it may be today, in
  the past, or still ahead).
- Numeric dates with a four-digit year: **slash is day-first**
  (`15/01/2024` = 15 January 2024), **dash is month-first** (`01-15-2024` = 15
  January 2024). If one field is out of range it is swapped
  (`31-12-2024` = 2024-12-31, `01/15/2024` = 2024-01-15).
- A four-digit-year fallback (`new Date`) is used only when the string contains
  a four-digit year: `Jan 15 2024` parses, while `Jan 15` is rejected instead
  of silently becoming the year 2001.
- `+` is treated as a space (clients sometimes double-encode `next+week`),
  except when it introduces a timezone offset in an ISO datetime.
- Impossible dates (`2024-02-31`), overflow arithmetic and unknown words are
  rejected with `400 invalid_date` and the supported examples.
- All-day event `start`/`end` values must be date-only (`YYYY-MM-DD`); they are
  not run through the relative/natural-language forms.

---

## Response Format

### Success (list)

```json
{
  "messages": [...],
  "total": 10,
  "matched": 42,
  "complete": true,
  "has_more": true,
  "resolved_mailbox": {"id": "account1:/Inbox", "name": "Inbox", "matched_by": "role"}
}
```

List responses report `total` (number returned), `matched` (exact number of
matches; omitted while `complete` is `false`), `complete` (the whole result set
was scanned), `has_more` (more matches exist than were returned), and — when a
folder was selected — `resolved_mailbox` with `matched_by`. Search responses
that hit the scan budget add `warnings`. `PATCH /messages` responses use
`results`/`updated`/`moved` instead.

### Event fields

`GET /events` and `GET /upcoming` return events like:

```json
{
  "id": "event-uuid",
  "calendar": "Work",
  "title": "Team Meeting",
  "start": "2024-01-15T10:00:00",
  "end": "2024-01-15T11:00:00",
  "allDay": false,
  "timezone": "Europe/Berlin",
  "location": null,
  "description": null,
  "organizer": null,
  "attendees": null
}
```

- `calendar` is the calendar's display name; use `GET /calendars` for IDs.
- `start`/`end` are local times (`YYYY-MM-DDTHH:MM:SS`) in the calendar's
  default timezone, or date-only (`YYYY-MM-DD`) when `allDay` is `true`. For
  all-day events `end` is the **exclusive** end date, as in iCalendar.
- `timezone` is the calendar's default timezone (`tzid`).
- `location`, `description`, `organizer` and `attendees` are `null` when unset.
- An occurrence of a recurring series additionally has `occurrence: true` and
  `recurrenceId` (see [Recurring Events](#recurring-events)).

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
recommend a fix. A malformed query string (bad percent-encoding) is a `400`
without a `code`.

#### Shared codes

| Code | HTTP status | Meaning |
|------|-------------|---------|
| `invalid_body` | 400 | Request body is not a JSON object |
| `invalid_parameter` | 400 | Missing or invalid parameter |
| `invalid_filter` | 400 | Invalid strict boolean or contradictory filter value |
| `invalid_date` | 400 | Date could not be parsed, or end is not after start |
| `invalid_target` | 400 | Target (mailbox/calendar/address book/identity) is not a non-empty ID, name, or role |
| `not_found` | 404 | Requested resource does not exist |
| `folder_not_found` | 404 | Mail folder does not exist |
| `ambiguous_target` | 409 | Several targets match; `matches` in the body lists them |
| `read_only` | 403 | Calendar or address book is read-only |
| `request_timeout` | 504 | No handler answered the request within the watchdog (120 s) |

#### Email codes

| Code | HTTP status | Meaning |
|------|-------------|---------|
| `missing_mailbox` | 400 | `mailbox` is required (refresh, or `refresh=true`) |
| `invalid_mailbox` | 400 | Mailbox is not a non-empty folder ID, name, or role |
| `invalid_folder` | 400 | A folder ID is required |
| `invalid_timeout` | 400 | `timeoutMs` is not an integer between 1 and 60000 |
| `invalid_refresh` | 400 | `refresh` is not `true`, `false`, `1`, or `0` |
| `search_timeout` | 504 | The search produced no page within the 20-second budget |
| `compose_failed` | 500 | `POST /messages` could not save the draft |
| `update_failed` | 502 | `PATCH /messages` could not change any message |
| `refresh_failed` | 500/502 | Folder refresh failed (500 when the call throws, 502 when Thunderbird reports a failed update) |
| `refresh_timeout` | 504 | The caller deadline passed; the native update continues and later callers share it |
| `refresh_stalled` | 504 | No completion signal within five minutes; the operation is abandoned |
| `refresh_cancelled` | 503 | The API/extension stopped while waiting |
| `refresh_unavailable` | 503 | Folder refresh is unavailable on this Thunderbird version |
| `unsupported_folder` | 400 | Root, virtual/unified, tag, or non-selectable folder |
| `unsupported_protocol` | 400 | Per-folder refresh is not supported for this account type |
| `thunderbird_offline` | 503 | Thunderbird is offline |

#### Calendar codes

| Code | HTTP status | Meaning |
|------|-------------|---------|
| `calendar_unavailable` | 503 | Thunderbird's calendar component is not available |
| `list_failed` | 500 | Listing calendars failed |
| `create_failed` | 500 | Creating the event failed |
| `update_failed` | 500 | Updating the event failed |
| `delete_failed` | 500 | Deleting the event failed |
| `not_recurring` | 400 | `recurrenceId` was used on a non-recurring event |
| `occurrence_not_found` | 404 | No occurrence matches the given `recurrenceId` |
| `ambiguous_recurrence` | 409 | Recurring event needs `recurrenceId` or `scope=series` |
| `sending_disabled` | 403 | Sending invitations is disabled (`TB_API_ALLOW_SEND`) |
| `read_only` | 403 | Calendar is read-only |

#### Contact codes

| Code | HTTP status | Meaning |
|------|-------------|---------|
| `create_failed` | 500 | Creating the contact failed |
| `update_failed` | 500 | Updating the contact failed |
| `delete_failed` | 500 | Deleting the contact failed |
| `read_only` | 403 | Address book is read-only |

#### Transport codes

Emitted by the HTTP layer before routing, so the request body may contain only
`error` and `code`.

| Code | HTTP status | Meaning |
|------|-------------|---------|
| `origin_not_allowed` | 403 | `Origin` is not in `TB_API_ALLOWED_ORIGINS` |
| `cross_site_request` | 403 | Cross-site browser request without an allowlisted origin |
| `unsupported_media_type` | 415 | Body sent without `Content-Type: application/json` |
| `api_not_ready` | 503 | The background handler is not registered (yet) or the server is shutting down |

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 201 | Created (`POST /events`) |
| 204 | No Content (CORS preflight for an allowlisted origin) |
| 207 | Partial success (some messages were updated/moved, some failed) |
| 400 | Bad request (missing/invalid parameters) |
| 401 | Unauthorized (`TB_API_TOKEN` set but missing/wrong) |
| 403 | Forbidden (read-only target, sending disabled, rejected origin) |
| 404 | Resource not found |
| 405 | Method not allowed |
| 409 | Ambiguous target (specify the calendar, folder, or occurrence) |
| 415 | Unsupported Media Type (body without `Content-Type: application/json`) |
| 500 | Internal server error |
| 502 | Thunderbird's folder update failed, or `PATCH /messages` changed nothing |
| 503 | Thunderbird offline, calendar unavailable, or refresh unavailable/stopped |
| 504 | Request, search, or folder refresh exceeded the deadline |

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

A missing or wrong token is `401 Unauthorized` with a `WWW-Authenticate:
Bearer` header. The server refuses to start when it is bound to a non-loopback
address (for example `TB_API_HOST=0.0.0.0` inside Docker) without a token.

### Origins and browser access

The API never emits a wildcard CORS header. A browser request is served only
when its `Origin` header exactly matches an entry in `TB_API_ALLOWED_ORIGINS`
(comma-separated, empty by default), and only the matching origin is echoed
back:

```bash
export TB_API_ALLOWED_ORIGINS="https://app.example.com"
```

Any other `Origin`, and requests that look cross-site (`Sec-Fetch-Site:
cross-site` or `same-site`) without an allowlisted origin, are rejected with
`403` (`code: "origin_not_allowed"` or `"cross_site_request"`) before
authentication runs. Non-browser clients such as curl send neither header and
are unaffected. Browser requests with a body must use `Content-Type:
application/json`; anything else is `415 unsupported_media_type`, which blocks
cross-site form posts that bypass a CORS preflight.

### Deployment

The default bind address is `127.0.0.1:9595` (localhost only). The Docker
Compose file sets `TB_API_HOST=0.0.0.0` inside the container but publishes all
three ports on `127.0.0.1` only, and it refuses to start without
`TB_API_TOKEN`. Do not expose port 9595 on a public interface; use a reverse
proxy with TLS and a token instead. Host-header validation (`TB_API_HOSTS`) is
not an authentication boundary.

See [SECURITY.md](SECURITY.md) for the full model, including the
[Origin policy](SECURITY.md#origin-policy), Host-header validation and the
fail-closed rules.

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

Run the mocked test suite without Thunderbird or network access:

```bash
node --test tests/test-*.js
```

These cover native listener completion, errors/timeouts, concurrent callers,
folder targeting, search ordering and boundedness, HTTP routing and
authentication, dates, per-domain aliases, message IDs, boolean filters, and a
documentation consistency check (every route described in `GET /` and
`README.md`). CI runs them.

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

- Thunderbird 128 or later

## License

MIT
