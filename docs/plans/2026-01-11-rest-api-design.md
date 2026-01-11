# Thunderbird REST API Design

## Overview

A Thunderbird extension exposing email, calendar, and contacts via a REST API for AI agent consumption.

## Architecture

### File Structure

```
mcp_server/
├── api.js              # Entry point: HTTP server, routing, request handling
├── utils.sys.mjs       # Shared utilities: JSON helpers, date parsing, error handling
├── email.sys.mjs       # Email: search, show, draft/send, update, mailboxes, identities
├── calendar.sys.mjs    # Calendar: list calendars, CRUD events
└── contacts.sys.mjs    # Contacts: list addressbooks, CRUD contacts
```

### Module Loading

Thunderbird Experiment API allows single script entry point. Modules loaded via `ChromeUtils.importESModule()` with `.sys.mjs` extension.

### Dependency Flow

```
api.js
  ├── imports utils.sys.mjs
  ├── imports email.sys.mjs
  ├── imports calendar.sys.mjs
  └── imports contacts.sys.mjs
```

Thunderbird services (MailServices, cal) passed as parameters to module functions.

## REST API

Base URL: `http://localhost:9595`

### Email Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /messages | Search messages |
| GET | /messages/:id | Get full message by Message-ID |
| POST | /messages | Create draft or send email |
| PATCH | /messages | Update messages (flags, move) |
| GET | /mailboxes | List mailboxes/folders |
| GET | /identities | List sending identities |

### Calendar Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /calendars | List calendars |
| GET | /events | List events |
| POST | /events | Create event |
| PATCH | /events/:id | Update event |
| DELETE | /events/:id | Delete event |

### Contacts Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /addressbooks | List address books |
| GET | /contacts | Search/list contacts |
| POST | /contacts | Create contact |
| PATCH | /contacts/:id | Update contact |
| DELETE | /contacts/:id | Delete contact |

### Meta

| Method | Path | Description |
|--------|------|-------------|
| GET | / | API info and endpoint listing |

## Request Parameters

### GET /messages

| Param | Type | Description |
|-------|------|-------------|
| text | string | Search in subject, from, to |
| from | string | Filter by sender |
| to | string | Filter by recipient |
| subject | string | Filter by subject |
| mailbox | string | Filter by folder name/role |
| after | string | Messages after date (ISO 8601 or "today"/"yesterday") |
| before | string | Messages before date |
| limit | number | Max results (default 50) |

### GET /events

| Param | Type | Description |
|-------|------|-------------|
| calendar | string | Filter by calendar ID |
| start | string | Events starting after (ISO 8601) |
| end | string | Events ending before (ISO 8601) |

### GET /contacts

| Param | Type | Description |
|-------|------|-------------|
| q | string | Search query (name, email) |
| addressbook | string | Filter by address book ID |
| limit | number | Max results (default 50) |

### POST /messages

```json
{
  "to": "bob@example.com",
  "subject": "Hello",
  "body": "Message content",
  "cc": "carol@example.com",
  "bcc": "hidden@example.com",
  "identity": "account-id",
  "send": false
}
```

- `send: false` (default): saves as draft
- `send: true`: sends immediately

### POST /events

```json
{
  "calendar": "calendar-uuid",
  "title": "Team Meeting",
  "start": "2024-01-15T10:00:00Z",
  "end": "2024-01-15T11:00:00Z",
  "location": "Room 101",
  "description": "Weekly sync"
}
```

### POST /contacts

```json
{
  "addressbook": "addressbook-uuid",
  "email": "alice@example.com",
  "firstName": "Alice",
  "lastName": "Smith",
  "displayName": "Alice Smith"
}
```

### PATCH/DELETE /events/:id and /contacts/:id

Require `calendar` or `addressbook` parameter to identify the container.

## Response Format

### Success (list)

```json
{
  "messages": [...],
  "total": 42,
  "has_more": false
}
```

### Success (single item)

```json
{
  "id": "...",
  "subject": "...",
  ...
}
```

### Success (mutation)

```json
{
  "success": true,
  "message": "Draft saved",
  "id": "..."
}
```

### Error

```json
{
  "error": "message_id parameter is required"
}
```

### HTTP Status Codes

- 200: Success
- 400: Bad request (missing/invalid parameters)
- 404: Resource not found
- 405: Method not allowed
- 500: Internal server error
- 503: Service unavailable

## Data Models

### Message (list view)

```json
{
  "id": 12345,
  "message_id": "<abc123@example.com>",
  "date": "2024-01-15T10:30:00Z",
  "from": "alice@example.com",
  "subject": "Hello",
  "flags": ["read", "flagged"],
  "mailbox": "Inbox",
  "has_attachment": true,
  "preview": "First 300 chars..."
}
```

### Message (full view)

Adds: `to`, `cc`, `body`, `in_reply_to`, `references`, `attachments`

### Mailbox

```json
{
  "id": "folder-id",
  "name": "Inbox",
  "role": "inbox",
  "parent_id": null,
  "unread": 5,
  "total": 120
}
```

### Identity

```json
{
  "id": "account-id",
  "name": "Alice Smith",
  "email": "alice@example.com",
  "reply_to": null
}
```

### Calendar

```json
{
  "id": "calendar-uuid",
  "name": "Personal",
  "type": "caldav",
  "color": "#ff0000",
  "readOnly": false
}
```

### Event

```json
{
  "id": "event-uuid",
  "calendar": "calendar-uuid",
  "title": "Team Meeting",
  "start": "2024-01-15T10:00:00Z",
  "end": "2024-01-15T11:00:00Z",
  "location": "Room 101",
  "description": "Weekly sync"
}
```

### AddressBook

```json
{
  "id": "addressbook-uuid",
  "name": "Personal Address Book",
  "readOnly": false
}
```

### Contact

```json
{
  "id": "contact-uuid",
  "addressbook": "addressbook-uuid",
  "email": "alice@example.com",
  "displayName": "Alice Smith",
  "firstName": "Alice",
  "lastName": "Smith"
}
```

## Module Interfaces

### utils.sys.mjs

```javascript
export function parseQueryString(queryString) → object
export function parseRequestBody(request, NetUtil) → object
export function sendJson(response, httpVersion, data, status = 200)
export function sendError(response, httpVersion, message, status = 400)
export function parseDate(dateStr) → Date | null
```

### email.sys.mjs

```javascript
export function searchMessages(params, MailServices) → { messages, total, has_more }
export function getMessage(id, MailServices, MsgHdrToMimeMessage) → Promise
export function createDraft(params, MailServices) → result
export function sendMessage(params, MailServices) → result
export function updateMessages(params, MailServices) → result
export function listMailboxes(MailServices) → { mailboxes }
export function listIdentities(MailServices) → { identities }
```

### calendar.sys.mjs

```javascript
export function listCalendars(cal) → { calendars } | { error }
export function listEvents(params, cal) → Promise<{ events }>
export function createEvent(params, cal) → Promise<result>
export function updateEvent(id, params, cal) → Promise<result>
export function deleteEvent(id, params, cal) → Promise<result>
```

### contacts.sys.mjs

```javascript
export function listAddressBooks(MailServices) → { addressbooks }
export function searchContacts(params, MailServices) → { contacts, total, has_more }
export function createContact(params, MailServices) → result
export function updateContact(id, params, MailServices) → result
export function deleteContact(id, params, MailServices) → result
```

## Routing Implementation

Path parameters extracted manually (httpd limitation):

```javascript
function extractPathParam(path, prefix) {
  if (!path.startsWith(prefix)) return null;
  const param = path.slice(prefix.length);
  return param ? decodeURIComponent(param) : null;
}
```

Async operations use `processAsync()`/`finish()` pattern.
