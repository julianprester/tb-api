---
name: handling-email
description: Use when processing, triaging, summarizing, or drafting emails via Thunderbird REST API. Triggers on inbox management, email search, replying, forwarding, archiving, or any email-related request.
---

# Handling Email

Use when processing, searching, or drafting emails via the Thunderbird REST API.

## Quick Reference

```bash
# Search inbox
curl -s "http://localhost:9595/messages?mailbox=inbox&limit=50"

# Search with filters (ALWAYS use date filters on large mailboxes)
curl -s "http://localhost:9595/messages?mailbox=archive&subject=query&after=2024-01-01&limit=50"
curl -s "http://localhost:9595/messages?from=sender@example.com&after=7+days+ago"

# Get full message by Message-ID
curl -s "http://localhost:9595/messages/<message_id@example.com>"

# Create draft
curl -s -X POST http://localhost:9595/messages -H "Content-Type: application/json" \
  -d '{"to":"recipient@example.com", "subject":"Subject", "body":"Message body"}'

# Reply to message (saves as draft)
curl -s -X POST http://localhost:9595/messages -H "Content-Type: application/json" \
  -d '{"in_reply_to":"<message_id@example.com>", "body":"Reply text"}'

# Forward message (saves as draft)
curl -s -X POST http://localhost:9595/messages -H "Content-Type: application/json" \
  -d '{"forward_of":"<message_id@example.com>", "to":"recipient@example.com", "body":"FYI"}'

# Update flags / move messages
curl -s -X PATCH http://localhost:9595/messages -H "Content-Type: application/json" \
  -d '{"ids":["<message_id@example.com>"], "move_to":"Archive", "add_flags":["read"]}'

# List mailboxes
curl -s "http://localhost:9595/mailboxes"

# List identities (sender accounts)
curl -s "http://localhost:9595/identities"
```

## Key Points

- **Date filters required for large mailboxes** - Without `after`/`before`, searches on archive/sent often timeout. Formats: `2024-01-15`, `today`, `yesterday`, `7 days ago`
- **Use Message-ID strings for PATCH** - Use the RFC 5322 Message-ID (e.g., `<abc123@example.com>`), not internal numeric IDs
- **Drafts only** - `POST /messages` always saves as draft for safety; messages must be sent manually from Thunderbird
- **Flexible parameters** - Most parameters accept aliases (e.g., `q`/`query`/`search`, `mailbox`/`folder`)
- **Fuzzy matching** - Calendar and address book names are fuzzy matched; errors include suggestions

## Available Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /messages | Search messages |
| GET | /messages/:id | Get full message |
| POST | /messages | Compose/reply/forward (draft) |
| PATCH | /messages | Update flags or move |
| GET | /mailboxes | List mail folders |
| GET | /identities | List sender identities |
| GET | /calendars | List calendars |
| GET | /events | List events |
| POST | /events | Create event |
| PATCH | /events/:id | Update event |
| DELETE | /events/:id | Delete event |
| GET | /addressbooks | List address books |
| GET | /contacts | Search contacts |
| POST | /contacts | Create contact |
| PATCH | /contacts/:id | Update contact |
| DELETE | /contacts/:id | Delete contact |
