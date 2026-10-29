---
name: handling-email
description: Use when processing, triaging, summarizing, or drafting emails via Thunderbird REST API. Triggers on inbox management, email search, replying, forwarding, archiving, or any email-related request.
---

# Handling Email

Use when processing, searching, or drafting emails via the Thunderbird REST API.

## Quick Reference

```bash
# Search inbox (newest first by default)
curl -s "http://localhost:9595/messages?mailbox=inbox&limit=50"

# Oldest first instead
curl -s "http://localhost:9595/messages?mailbox=inbox&sort=date_asc"

# Refresh the selected IMAP folder before searching (opt-in)
curl -s --max-time 65 "http://localhost:9595/messages?mailbox=sent&refresh=true&after=yesterday"

# Or refresh explicitly before a later read
curl -s --max-time 65 -X POST "http://localhost:9595/mailboxes/refresh?mailbox=sent"

# Search with filters (ALWAYS use date filters on large mailboxes)
curl -s "http://localhost:9595/messages?mailbox=archive&subject=query&after=2024-01-01&limit=50"
curl -s "http://localhost:9595/messages?from=sender@example.com&after=7+days+ago"

# Get full message by Message-ID
curl -s "http://localhost:9595/messages/<message_id@example.com>"

# Download an attachment (partName comes from GET /messages/:id)
curl -OJ "http://localhost:9595/messages/<message_id@example.com>/attachments/1.2"
curl -s "http://localhost:9595/messages/<message_id@example.com>/attachments/1.2?format=json"

# Create draft
curl -s -X POST http://localhost:9595/messages -H "Content-Type: application/json" \
  -d '{"to":"recipient@example.com", "subject":"Subject", "body":"Message body"}'

# Create a draft with an attachment (standard base64 in data_base64)
curl -s -X POST http://localhost:9595/messages -H "Content-Type: application/json" \
  -d '{"to":"recipient@example.com", "subject":"Report", "body":"See attached", "attachments":[{"name":"report.pdf", "content_type":"application/pdf", "data_base64":"JVBERi0x..."}]}'

# Reply to message (saves as draft)
curl -s -X POST http://localhost:9595/messages -H "Content-Type: application/json" \
  -d '{"in_reply_to":"<message_id@example.com>", "body":"Reply text"}'

# Forward message (saves as draft)
curl -s -X POST http://localhost:9595/messages -H "Content-Type: application/json" \
  -d '{"forward_of":"<message_id@example.com>", "to":"recipient@example.com", "body":"FYI"}'

# Update flags and move messages (both are applied in one request)
curl -s -X PATCH http://localhost:9595/messages -H "Content-Type: application/json" \
  -d '{"ids":["<message_id@example.com>"], "move_to":"Archive", "add_flags":["read"]}'

# List mailboxes
curl -s "http://localhost:9595/mailboxes"

# List identities (sender accounts)
curl -s "http://localhost:9595/identities"

# Events still left today
curl -s "http://localhost:9595/upcoming"
```

## Key Points

- **Date filters required for large mailboxes** - Without `after`/`before`, searches on archive/sent often timeout. Date-only values (`2024-01-15`) are local midnight; `today`, `yesterday`, `7 days ago`, `next monday` and ISO datetimes work too. Numeric short dates need a four-digit year and are day-first with `/` (`15/01/2024`) but month-first with `-` (`01-15-2024`); forms without a year such as `Jan 15` are rejected.
- **Newest first** - `GET /messages` returns newest-first by default (`sort=date_desc`); `sort=date_asc` flips the order. `matched` is exact only when `complete` is true; when the 20-second scan budget expires the response has `complete: false`, `has_more: true` and a `warnings` entry. When a `mailbox` was given, `resolved_mailbox.matched_by` says whether it matched by `id`, `role`, `name`, or `fuzzy`.
- **Read status** - List and single-message responses include boolean `read` (`false` means unread, not unknown). The `flags` array also contains `"read"` for read messages. Avoid `jq '.read // null'` or Python `message.get("read") or None`, which turn valid `false` into null. Older builds omitted the field; reload the updated extension. Getting message content does not mark it read.
- **Attachments and message flags** - Search results include boolean `draft` (true in Drafts/Templates folders) and, with the default `include_preview=true`, `has_attachment` and a `preview`. `answered`/`forwarded` are reported when Thunderbird can read them, and `has_attachment` is omitted when the MIME tree cannot be read; an absent value means unknown, not `false`. The `flags` array covers `read`, `flagged`, `junk`, `draft`, `answered`, `forwarded`.
- **Attachment download and draft upload** - `GET /messages/:id` entries carry `partName` and `download_url`; `GET /messages/:id/attachments/:partName` returns the raw file (or `?format=json` for `{data_base64, ...}`). `POST /messages` accepts `attachments: [{name, content_type?, data_base64}]` for new, reply, and forward drafts. Base64 is standard (optional `=` padding, no URL-safe `-`/`_`), and an empty string is a zero-byte file. Limits are 10 MiB per file, 25 MiB total, and 20 files. If any attachment fails, the request is `500 attachment_failed` and no draft is saved.
- **Cheap header-only listings** - `GET /messages?include_preview=false` omits `preview`/`has_attachment` and reads no message bodies. Use it to triage a large folder, then fetch full content only for the messages you keep.
- **Message-IDs work with or without angle brackets** - `<abc123@example.com>`, `abc123@example.com` and surrounding spaces are equivalent (URL-encode `<`, `>`, `@` in GET paths). Prefer Message-IDs over internal numeric IDs; both are accepted for GET and PATCH. When a Message-ID appears in several folders, GET returns the first match plus a `matches` count, and PATCH changes only the first match.
- **Batch updates are honest** - `PATCH /messages` applies flags first, then the move, and reports one `results` entry per message (`{ "ref", "id", "updated", "moved", "error"? }`). All messages succeeded → `200`; some failed → `207` with `success: false` and `partial: true`; no message was fully updated → `502 update_failed` (`updated`/`results` still show what partly applied). Unresolved `ids` are listed in `not_found`. Flag aliases include the inverse `unread`/`unseen` (`add_flags: ["unread"]` clears `read`); an unknown flag is a `400` that changes nothing.
- **Drafts only** - `POST /messages` always saves as draft for safety; messages must be sent manually from Thunderbird
- **Invitation drafts** - `POST /events` with `sendInvites: true` (or `inviteMode: "draft"`) saves an `invite.ics` invitation as a draft; nothing is sent. Sending immediately needs `inviteMode: "send"` **and** `TB_API_ALLOW_SEND=1` (otherwise `403 sending_disabled`, no event). The `organizer` must be one of your Thunderbird identities. `PATCH`/`DELETE` never send updates or cancellations. A created event also reports `invitations: {"status": "draft_saved"|"sent"|"queued"|"failed", "error"?}`.
- **Recurring events** - `GET /events` returns each occurrence with `occurrence: true` and a `recurrenceId`. Edit or delete one occurrence with `recurrenceId` (timed series use the UTC instant, all-day series the `YYYY-MM-DD` date), or the whole series with `scope: "series"`. Both together is `400`, and a recurring event without either is `409 ambiguous_recurrence`; an unknown occurrence is `404 occurrence_not_found`.
- **Opt-in freshness** - Use `refresh=true` with a specific mailbox to sync IMAP headers before searching. Refresh failures return errors, not stale results. Local folders return an explicit no-op; root/virtual folders and other protocols are unsupported. `timeoutMs` defaults to 30000 (max 60000); this does not guarantee offline body downloads.
- **Flexible parameters** - Most parameters accept aliases (e.g., `mailbox`/`folder`). Aliases are per endpoint: `q` means full text for `GET /messages` but the contact search for `GET /contacts` (`query`/`q`/`search` there).
- **Fuzzy matching** - Calendar and address book names are fuzzy matched; errors include suggestions. Reads report the chosen target when one was given (`resolved_mailbox`, `resolved_calendar`, `resolved_addressbook`) with `matched_by` (`id`, `role`, `name`, or `fuzzy`). Writes need an exact ID or name, and `POST /contacts` auto-selects only when exactly one writable address book exists (several writable books without `addressbook` is `409 ambiguous_target`).

## Available Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /messages | Search messages |
| GET | /messages/:id | Get full message |
| GET | /messages/:id/attachments/:partName | Download attachment (raw or `?format=json`) |
| POST | /messages | Compose/reply/forward (draft, optional attachments) |
| PATCH | /messages | Update flags or move |
| GET | /mailboxes | List mail folders |
| POST | /mailboxes/refresh | Refresh a concrete folder (mailbox required) |
| GET | /identities | List sender identities |
| GET | /calendars | List calendars |
| GET | /events | List events (occurrences carry `recurrenceId`) |
| GET | /upcoming | Events from now until end of today |
| POST | /events | Create event |
| PATCH | /events/:id | Update event |
| DELETE | /events/:id | Delete event |
| GET | /addressbooks | List address books |
| GET | /contacts | Search contacts |
| POST | /contacts | Create contact |
| PATCH | /contacts/:id | Update contact |
| DELETE | /contacts/:id | Delete contact |
