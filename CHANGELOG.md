# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.0.0] - 2026-10-29

Email attachment support. The new endpoints and fields are additive; existing
behavior is unchanged.

### Added

- `GET /messages/:id/attachments/:partName` downloads one attachment as raw
  bytes, with an opt-in `?format=json` base64 envelope. `GET /messages/:id`
  now reports each attachment's `partName`, `content_id`, `download_url`, and
  `inline` when Thunderbird exposes `contentDisposition`.
- `POST /messages` accepts `attachments: [{name, content_type?, data_base64}]`
  for new, reply, and forward drafts. Attachments are limited to 10 MiB each,
  25 MiB total, and 20 files; any attachment failure saves no draft.

## [3.0.2] - 2026-10-15

### Fixed

- `GET /messages/:id` now reports `answered`/`forwarded` and includes them in
  `flags` exactly like search, instead of omitting them on the single-message
  path. Unknown values stay absent rather than being reported as `false`.

## [3.0.1] - 2026-10-14

### Fixed

- `answered`/`forwarded` are reported again on Thunderbird 140: the
  experiment's message-manager lookup indexed Thunderbird's tracker map with
  the string IDs the schema delivers, so every lookup silently missed and the
  flags were omitted. Numeric IDs are converted back to integers before the
  lookup, and the harness fake now keys by number like the real API.

## [3.0] - 2026-10-14

Version 3.0 makes writes fail loudly instead of guessing, returns the messages
people actually want first, and requires opt-in for sending invitations.

### Breaking changes

- **Write targets must be exact.** Moving messages, and resolving an address
  book, calendar or sender identity for a write, accept only an ID, an exact
  folder role, or a case-insensitive exact name. An ambiguous name is now
  `409 ambiguous_target` instead of silently picking one. Reads still accept
  fuzzy names and report what was resolved (for mail,
  `resolved_mailbox.matched_by`).
- **Boolean filters are strict.** `read`/`unread`, `flagged`, `junk`, `refresh`
  and `include_preview` accept only `true`/`false`/`1`/`0`; any other value is
  `400 invalid_filter` (`invalid_refresh` for `refresh`) instead of being
  ignored, and contradictory `read`/`unread` values are rejected too.
- **`GET /messages` is newest first.** The default order is `date_desc`; use
  `sort=date_asc` for the previous oldest-first order. Responses report an
  accurate `matched`/`has_more`, and long scans stop at a 20-second budget with
  `complete: false` plus `warnings` instead of running forever.
- **Recurring events need a scope.** `PATCH /events/:id` and `DELETE
  /events/:id` on a recurring event require `recurrenceId` (one occurrence) or
  `scope: "series"` (the whole series); without either the request is `409
  ambiguous_recurrence`.
- **Invitations are drafts by default.** `sendInvites: true` no longer sends
  immediately. Sending requires `inviteMode: "send"` **and** the environment
  variable `TB_API_ALLOW_SEND=1`; without it the request is `403
  sending_disabled` and no event is created.
- **Date-only input means local midnight.** `2024-01-15` is now local midnight,
  not UTC midnight, so dates and all-day events match the user's timezone.
- **Thunderbird 128 (ESR) is the minimum.** ESR 115 never worked with these
  APIs; `strict_min_version` is now `128.0`.
- Carried over from 2.7 (for upgrades straight from 2.6): browser-originated
  requests are rejected unless the origin is listed in `TB_API_ALLOWED_ORIGINS`
  (D1); requests with a body must send `Content-Type: application/json`, or they
  are `415` (D2); and the server refuses to start on a non-loopback host without
  `TB_API_TOKEN` (D3).

### Migration guide

1. **Docker:** set `TB_API_TOKEN` (Compose refuses to start without it); the API
   and noVNC ports publish on `127.0.0.1` only. Apply settings changes with
   `docker compose up -d --force-recreate` — **never** `docker compose down -v`,
   which deletes the Thunderbird profile and all local mail.
2. **Send `Content-Type: application/json`** on every request with a JSON body.
3. **Use exact move targets:** pass the folder ID, the exact role, or the exact
   name to `PATCH /messages` `move_to`; on `409 ambiguous_target`, choose one of
   the `matches` and retry.
4. **Pass `recurrenceId` or `scope`** when editing or deleting a recurring
   event: `recurrenceId` for one occurrence, `scope: "series"` for the series.
5. **Opt in to sending invitations:** use `inviteMode: "send"` together with
   `TB_API_ALLOW_SEND=1`; the default stays a draft in the Drafts folder.

### Email

- `PATCH /messages` applies flags and a move together, with per-message
  `results`, honest `207`/`502` outcomes, and no changes at all when the
  destination cannot be resolved.
- Message-IDs compare exactly with optional angle brackets and whitespace, and
  internal numeric IDs resolve directly.
- Search is bounded (500-message pages, 20-second budget, `abortList`) and
  reports `complete`, `matched`, `has_more` and `warnings`.
- `has_attachment`, `draft`, `answered` and `forwarded` are reported honestly;
  `include_preview=false` skips body reads entirely.
- One request parser: `=` is allowed in query values, `+` decodes as a space,
  only JSON objects are accepted as bodies, and parameter aliases are
  per-domain (contact search now honours `q`/`query`/`search`).

### Calendar

- Date-only input is local midnight; timed/all-day conversion and date range
  validation were fixed.
- Occurrence vs series edits and deletes via `recurrenceId`/`scope`.
- Invitations default to a draft with the correct sender identity and ICS UID,
  and the response reports the real `invitations.status`/`error` outcome.

### Refresh

- Folder refresh completes via the `FolderLoaded` event instead of wedging,
  with a five-minute hard ceiling and shared native updates.

### Documentation and compatibility

- Minimum Thunderbird 128; the Docker base image is pinned to
  `jlesage/thunderbird:v26.09.1`.
- README, SKILL.md and SECURITY.md document ordering, aliases, error codes,
  recurrence scope, invitation modes and the `/upcoming` endpoint.
- Dead caches and stale helpers removed; live shell checks updated for auth,
  `Content-Type` and the new behaviour.

### Review fixes

- `PATCH /events/:id` validates `attendees` and its entries exactly like
  `POST /events` before touching the stored event. A non-array is `400
  invalid_parameter` and changes nothing, instead of wiping every attendee,
  persisting the wipe and then failing with a 500; an empty array or `null`
  still means "remove all".
- `POST /contacts` auto-selects an address book only when exactly one writable
  book exists. Several writable books without `addressbook` is `409
  ambiguous_target` with the writable books in `matches`, never a list-order
  guess.
- Read responses report the target they resolved: `resolved_calendar` on
  `GET /events` and `GET /upcoming`, `resolved_addressbook` on `GET /contacts`
  (both `{id, name, matched_by}`), and the already-returned `resolved_mailbox`
  on `POST /mailboxes/refresh` is now documented.
- Honesty and safety hardening: a supplied-but-empty target
  (`move_to: ""`, `mailbox=`, `calendar=`, `addressbook=`, `identity=`) is
  `400 invalid_target`/`invalid_mailbox` instead of silently widening the
  read or auto-selecting a target; `has_attachment` is omitted when the MIME
  call fails instead of being reported `false`; the `502 update_failed`
  wording says "no message was fully updated" (`updated`/`results` show what
  partly applied); requested invitations without attendees return a warning;
  a failed invitation preparation closes its compose tab; folder-event
  handler failures are contained; an all-day start whose default end
  overflows names the start instead of `"undefined"`.
- Documentation: SECURITY.md lists 3.x, CONTRIBUTING.md includes
  `test-comprehensive.sh` in the live checks, docker/README.md carries a
  self-contained upgrade checklist, and Get Message documents that
  digits-only references resolve as internal IDs.

## [2.7] - 2026-10-14

### Security

- Removed `Access-Control-Allow-Origin: *`. Browser-originated requests are
  rejected unless the origin is listed in `TB_API_ALLOWED_ORIGINS`; cross-site
  requests are refused. (D1)
- Requests with a body must send `Content-Type: application/json`; anything else
  is `415 unsupported_media_type`. (D2)
- The server refuses to start on a non-loopback host without `TB_API_TOKEN`.
  (D3)

### Deployment

- Docker ports publish on `127.0.0.1` only (API 9595, noVNC 5800); Compose
  requires `TB_API_TOKEN` and ships a healthcheck.
- The external ocpa network moved to `docker-compose.ocpa.yml`.
- Documented that `docker compose down -v` deletes the Thunderbird profile and
  all local mail.
