# Thunderbird REST API

A Thunderbird extension that exposes email, calendar, and contacts via a REST API for AI agents and automation.

## Installation

1. Download or clone this repository
2. In Thunderbird, go to **Add-ons and Themes** (Tools menu or `Ctrl+Shift+A`)
3. Click the gear icon and select **Debug Add-ons**
4. Click **Load Temporary Add-on** and select the `manifest.json` file

The API server starts automatically on `http://localhost:9595`.

## API Reference

### Base URL

```
http://localhost:9595
```

### Email

#### List Mailboxes

```http
GET /mailboxes
```

Returns all mail folders/mailboxes.

#### List Identities

```http
GET /identities
```

Returns available sending identities (email accounts).

#### Search Messages

```http
GET /messages
```

| Parameter | Type   | Description                                    |
|-----------|--------|------------------------------------------------|
| text      | string | Search in subject, from, to                    |
| from      | string | Filter by sender                               |
| to        | string | Filter by recipient                            |
| subject   | string | Filter by subject                              |
| mailbox   | string | Filter by folder name or role (inbox, sent...) |
| after     | string | Messages after date (ISO 8601 or "today")      |
| before    | string | Messages before date                           |
| limit     | number | Max results (default 50)                       |

Example:
```bash
curl "http://localhost:9595/messages?mailbox=inbox&limit=10"
curl "http://localhost:9595/messages?from=alice@example.com&after=2026-01-01"
```

#### Get Message

```http
GET /messages/:message_id
```

Returns full message content by Message-ID (URL-encoded).

Example:
```bash
curl "http://localhost:9595/messages/%3Cabc123%40example.com%3E"
```

#### Compose Message

```http
POST /messages
Content-Type: application/json

{
  "to": "recipient@example.com",
  "subject": "Hello",
  "body": "Message content",
  "cc": "cc@example.com",
  "bcc": "bcc@example.com",
  "identity": "identity-id",
  "send": false
}
```

- `send: false` (default): saves as draft
- `send: true`: sends immediately

#### Update Messages

```http
PATCH /messages
Content-Type: application/json

{
  "message_ids": ["<id1@example.com>", "<id2@example.com>"],
  "read": true,
  "flagged": false,
  "move_to": "folder-id"
}
```

### Calendar

#### List Calendars

```http
GET /calendars
```

#### List Events

```http
GET /events
```

| Parameter | Type   | Description                      |
|-----------|--------|----------------------------------|
| calendar  | string | Filter by calendar ID            |
| start     | string | Events starting after (ISO 8601) |
| end       | string | Events ending before (ISO 8601)  |

Example:
```bash
curl "http://localhost:9595/events?start=2026-01-01T00:00:00Z&end=2026-12-31T23:59:59Z"
```

#### Create Event

```http
POST /events
Content-Type: application/json

{
  "calendar": "calendar-uuid",
  "title": "Team Meeting",
  "start": "2026-01-15T10:00:00Z",
  "end": "2026-01-15T11:00:00Z",
  "location": "Room 101",
  "description": "Weekly sync"
}
```

#### Update Event

```http
PATCH /events/:id?calendar=calendar-uuid
Content-Type: application/json

{
  "title": "Updated Title",
  "start": "2026-01-15T11:00:00Z"
}
```

#### Delete Event

```http
DELETE /events/:id?calendar=calendar-uuid
```

### Contacts

#### List Address Books

```http
GET /addressbooks
```

#### Search Contacts

```http
GET /contacts
```

| Parameter   | Type   | Description                  |
|-------------|--------|------------------------------|
| q           | string | Search query (name, email)   |
| addressbook | string | Filter by address book ID    |
| limit       | number | Max results (default 50)     |

Example:
```bash
curl "http://localhost:9595/contacts?q=alice&limit=10"
```

#### Create Contact

```http
POST /contacts
Content-Type: application/json

{
  "addressbook": "addressbook-uuid",
  "email": "alice@example.com",
  "firstName": "Alice",
  "lastName": "Smith",
  "displayName": "Alice Smith"
}
```

#### Update Contact

```http
PATCH /contacts/:id?addressbook=addressbook-uuid
Content-Type: application/json

{
  "firstName": "Alicia"
}
```

#### Delete Contact

```http
DELETE /contacts/:id?addressbook=addressbook-uuid
```

### Meta

#### API Info

```http
GET /
```

Returns API version and available endpoints.

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
  "error": "message_id parameter is required"
}
```

### HTTP Status Codes

- `200` Success
- `400` Bad request (missing/invalid parameters)
- `404` Resource not found
- `405` Method not allowed
- `500` Internal server error

## Testing

Run the test script to verify read endpoints:

```bash
./test-api.sh
```

## Development

### Project Structure

```
tb-api/
├── manifest.json           # Extension manifest
├── background.js           # Background script (starts API)
├── httpd.sys.mjs           # HTTP server (Mozilla httpd)
└── mcp_server/
    ├── api.js              # Main entry, routing
    ├── utils.sys.mjs       # Shared utilities
    ├── email.sys.mjs       # Email operations
    ├── calendar.sys.mjs    # Calendar operations
    ├── contacts.sys.mjs    # Contact operations
    └── schema.json         # Experiment API schema
```

### Reloading Changes

- **Background script or manifest changes**: Reload from Debug Add-ons page
- **ES Module changes (.sys.mjs)**: Requires full Thunderbird restart (modules are cached)

## Requirements

- Thunderbird 115 or later

## License

MIT
