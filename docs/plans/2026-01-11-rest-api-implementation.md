# Thunderbird REST API Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the Thunderbird extension to expose email, calendar, and contacts via a clean modular REST API.

**Architecture:** Single entry point (api.js) imports ES modules for each domain (email, calendar, contacts) plus shared utilities. HTTP server routes requests to domain handlers. Thunderbird services passed as parameters to module functions.

**Tech Stack:** Thunderbird Experiment API, Mozilla httpd.sys.mjs, ChromeUtils ES modules

**Testing:** Integration tests via curl against running extension. Each task includes curl commands for verification.

**Reference:** Design doc at `docs/plans/2026-01-11-rest-api-design.md`

---

## Task 1: Create utils.sys.mjs

**Files:**
- Create: `mcp_server/utils.sys.mjs`

**Step 1: Create the utilities module**

```javascript
/* exported utils */
"use strict";

/**
 * Parse query string into object
 * @param {string} queryString - URL query string (without leading ?)
 * @returns {object} Parsed parameters
 */
export function parseQueryString(queryString) {
  const params = {};
  if (!queryString) return params;
  for (const part of queryString.split("&")) {
    const [key, value] = part.split("=").map(decodeURIComponent);
    if (key) params[key] = value ?? "";
  }
  return params;
}

/**
 * Parse JSON request body
 * @param {object} request - HTTP request object
 * @param {object} NetUtil - Mozilla NetUtil module
 * @returns {object} Parsed JSON body or empty object
 */
export function parseRequestBody(request, NetUtil) {
  try {
    const stream = request.bodyInputStream;
    if (!stream || !stream.available()) return {};
    const body = NetUtil.readInputStreamToString(
      stream,
      stream.available(),
      { charset: "UTF-8" }
    );
    return JSON.parse(body);
  } catch (e) {
    return {};
  }
}

/**
 * Send JSON response
 * @param {object} response - HTTP response object
 * @param {string} httpVersion - HTTP version string
 * @param {object} data - Data to serialize as JSON
 * @param {number} status - HTTP status code (default 200)
 */
export function sendJson(response, httpVersion, data, status = 200) {
  const statusText = status === 200 ? "OK" : status === 404 ? "Not Found" : "Error";
  response.setStatusLine(httpVersion, status, statusText);
  response.setHeader("Content-Type", "application/json; charset=utf-8", false);
  response.write(JSON.stringify(data, null, 2));
}

/**
 * Send error response
 * @param {object} response - HTTP response object
 * @param {string} httpVersion - HTTP version string
 * @param {string} message - Error message
 * @param {number} status - HTTP status code (default 400)
 */
export function sendError(response, httpVersion, message, status = 400) {
  sendJson(response, httpVersion, { error: message }, status);
}

/**
 * Parse date string with natural language support
 * @param {string} dateStr - Date string (ISO 8601, "today", "yesterday")
 * @returns {Date|null} Parsed date or null if invalid
 */
export function parseDate(dateStr) {
  if (!dateStr) return null;
  const lower = dateStr.toLowerCase();
  const now = new Date();
  if (lower === "today") {
    now.setHours(0, 0, 0, 0);
    return now;
  }
  if (lower === "yesterday") {
    now.setDate(now.getDate() - 1);
    now.setHours(0, 0, 0, 0);
    return now;
  }
  const parsed = new Date(dateStr);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Extract path parameter from URL path
 * @param {string} path - Full URL path
 * @param {string} prefix - Path prefix to strip
 * @returns {string|null} Decoded parameter or null
 */
export function extractPathParam(path, prefix) {
  if (!path.startsWith(prefix)) return null;
  const param = path.slice(prefix.length);
  if (!param || param.includes("/")) return null;
  return decodeURIComponent(param);
}

/**
 * Sanitize string for JSON (remove control characters)
 * @param {string} text - Input text
 * @returns {string} Sanitized text
 */
export function sanitizeForJson(text) {
  if (!text) return text;
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
```

**Step 2: Verify syntax**

Run in Thunderbird console or check file loads without error.

**Step 3: Commit**

```bash
git add mcp_server/utils.sys.mjs
git commit -m "feat: add shared utilities module"
```

---

## Task 2: Create email.sys.mjs

**Files:**
- Create: `mcp_server/email.sys.mjs`

**Step 1: Create the email module**

```javascript
/* exported email */
"use strict";

import { sanitizeForJson } from "resource://tb-api/utils.sys.mjs";

const MAX_RESULTS = 100;
const DEFAULT_LIMIT = 50;
const PREVIEW_LENGTH = 300;

/**
 * Convert message header flags to array
 */
function msgHdrToFlags(msgHdr, Ci) {
  const flags = [];
  if (msgHdr.isRead) flags.push("read");
  if (msgHdr.isFlagged) flags.push("flagged");
  if (msgHdr.flags & Ci.nsMsgMessageFlags.Replied) flags.push("answered");
  if (msgHdr.flags & Ci.nsMsgMessageFlags.Forwarded) flags.push("forwarded");
  if (msgHdr.flags & Ci.nsMsgMessageFlags.HasAttachments) flags.push("attachment");
  if (msgHdr.flags & Ci.nsMsgMessageFlags.MDNReportNeeded) flags.push("draft");
  return flags;
}

/**
 * Get all folders recursively
 */
function getAllFolders(MailServices) {
  const folders = [];
  function collect(folder) {
    folders.push(folder);
    if (folder.hasSubFolders) {
      for (const sub of folder.subFolders) {
        collect(sub);
      }
    }
  }
  for (const account of MailServices.accounts.accounts) {
    collect(account.incomingServer.rootFolder);
  }
  return folders;
}

/**
 * Find folder by name, role, or URI
 */
function findFolder(nameOrUri, MailServices, Ci) {
  if (!nameOrUri) return null;
  
  // Try as URI first
  try {
    const folder = MailServices.folderLookup.getFolderForURL(nameOrUri);
    if (folder) return folder;
  } catch {}

  // Try as role
  const roleFlags = {
    inbox: Ci.nsMsgFolderFlags.Inbox,
    sent: Ci.nsMsgFolderFlags.SentMail,
    drafts: Ci.nsMsgFolderFlags.Drafts,
    trash: Ci.nsMsgFolderFlags.Trash,
    junk: Ci.nsMsgFolderFlags.Junk,
    archives: Ci.nsMsgFolderFlags.Archive,
    templates: Ci.nsMsgFolderFlags.Templates,
  };
  const flag = roleFlags[nameOrUri.toLowerCase()];
  if (flag) {
    for (const account of MailServices.accounts.accounts) {
      try {
        const folder = account.incomingServer.rootFolder.getFolderWithFlags(flag);
        if (folder) return folder;
      } catch {}
    }
  }

  // Try as folder name
  const lowerName = nameOrUri.toLowerCase();
  for (const folder of getAllFolders(MailServices)) {
    if (folder.prettyName.toLowerCase() === lowerName) {
      return folder;
    }
  }
  return null;
}

/**
 * Get folder role from flags
 */
function getFolderRole(folder, Ci) {
  if (folder.flags & Ci.nsMsgFolderFlags.Inbox) return "inbox";
  if (folder.flags & Ci.nsMsgFolderFlags.SentMail) return "sent";
  if (folder.flags & Ci.nsMsgFolderFlags.Drafts) return "drafts";
  if (folder.flags & Ci.nsMsgFolderFlags.Trash) return "trash";
  if (folder.flags & Ci.nsMsgFolderFlags.Junk) return "junk";
  if (folder.flags & Ci.nsMsgFolderFlags.Archive) return "archives";
  if (folder.flags & Ci.nsMsgFolderFlags.Templates) return "templates";
  if (folder.flags & Ci.nsMsgFolderFlags.Queue) return "outbox";
  return null;
}

/**
 * Search messages with filters
 */
export function searchMessages(params, MailServices, Ci, parseDate) {
  const {
    text,
    from,
    to,
    subject,
    mailbox,
    after,
    before,
    limit = DEFAULT_LIMIT,
  } = params;

  const results = [];
  const maxResults = Math.min(parseInt(limit, 10) || DEFAULT_LIMIT, MAX_RESULTS);
  const afterDate = parseDate(after);
  const beforeDate = parseDate(before);

  // Determine folders to search
  let foldersToSearch;
  if (mailbox) {
    const folder = findFolder(mailbox, MailServices, Ci);
    if (!folder) {
      return { error: `Mailbox not found: ${mailbox}` };
    }
    foldersToSearch = [folder];
  } else {
    foldersToSearch = getAllFolders(MailServices);
  }

  for (const folder of foldersToSearch) {
    if (results.length >= maxResults) break;

    try {
      const db = folder.msgDatabase;
      if (!db) continue;

      for (const msgHdr of db.enumerateMessages()) {
        if (results.length >= maxResults) break;

        // Date filters
        const msgDate = msgHdr.date ? new Date(msgHdr.date / 1000) : null;
        if (afterDate && msgDate && msgDate < afterDate) continue;
        if (beforeDate && msgDate && msgDate > beforeDate) continue;

        // Text filters
        const msgSubject = (msgHdr.mime2DecodedSubject || "").toLowerCase();
        const msgAuthor = (msgHdr.mime2DecodedAuthor || "").toLowerCase();
        const msgRecipients = (msgHdr.mime2DecodedRecipients || "").toLowerCase();

        if (from && !msgAuthor.includes(from.toLowerCase())) continue;
        if (to && !msgRecipients.includes(to.toLowerCase())) continue;
        if (subject && !msgSubject.includes(subject.toLowerCase())) continue;
        if (text) {
          const lowerText = text.toLowerCase();
          if (
            !msgSubject.includes(lowerText) &&
            !msgAuthor.includes(lowerText) &&
            !msgRecipients.includes(lowerText)
          ) {
            continue;
          }
        }

        results.push({
          id: msgHdr.messageKey,
          message_id: msgHdr.messageId,
          date: msgDate ? msgDate.toISOString() : null,
          from: msgHdr.mime2DecodedAuthor || msgHdr.author,
          subject: msgHdr.mime2DecodedSubject || msgHdr.subject,
          flags: msgHdrToFlags(msgHdr, Ci),
          mailbox: folder.prettyName,
          has_attachment: !!(msgHdr.flags & Ci.nsMsgMessageFlags.HasAttachments),
          preview: "", // TODO: Add preview extraction
        });
      }
    } catch (e) {
      // Skip inaccessible folders
    }
  }

  // Sort by date descending
  results.sort((a, b) => new Date(b.date) - new Date(a.date));

  return {
    messages: results,
    total: results.length,
    has_more: results.length >= maxResults,
  };
}

/**
 * Get full message content
 */
export function getMessage(messageId, MailServices, MsgHdrToMimeMessage, Ci) {
  return new Promise((resolve) => {
    // Find message by Message-ID header
    for (const folder of getAllFolders(MailServices)) {
      try {
        const db = folder.msgDatabase;
        if (!db) continue;

        for (const msgHdr of db.enumerateMessages()) {
          if (msgHdr.messageId === messageId) {
            MsgHdrToMimeMessage(
              msgHdr,
              null,
              (aMsgHdr, aMimeMessage) => {
                if (!aMimeMessage) {
                  resolve({ error: "Could not parse message" });
                  return;
                }

                let body = "";
                try {
                  body = sanitizeForJson(aMimeMessage.coerceBodyToPlaintext());
                } catch {
                  body = "(Could not extract body)";
                }

                const attachments = [];
                if (aMimeMessage.allAttachments) {
                  for (const att of aMimeMessage.allAttachments) {
                    attachments.push({
                      name: att.name,
                      size: att.size,
                      contentType: att.contentType,
                    });
                  }
                }

                resolve({
                  id: msgHdr.messageKey,
                  message_id: msgHdr.messageId,
                  date: msgHdr.date ? new Date(msgHdr.date / 1000).toISOString() : null,
                  from: msgHdr.mime2DecodedAuthor || msgHdr.author,
                  to: (msgHdr.mime2DecodedRecipients || msgHdr.recipients || "").split(",").map(s => s.trim()).filter(Boolean),
                  cc: (msgHdr.ccList || "").split(",").map(s => s.trim()).filter(Boolean),
                  subject: msgHdr.mime2DecodedSubject || msgHdr.subject,
                  flags: msgHdrToFlags(msgHdr, Ci),
                  mailbox: folder.prettyName,
                  body,
                  attachments,
                  in_reply_to: aMimeMessage.headers?.["in-reply-to"]?.[0] || null,
                  references: aMimeMessage.headers?.["references"]?.[0]?.split(/\s+/) || [],
                });
              },
              true,
              { examineEncryptedParts: true }
            );
            return;
          }
        }
      } catch {}
    }
    resolve({ error: `Message not found: ${messageId}` });
  });
}

/**
 * Create and save draft or send message
 */
export function composeMessage(params, MailServices, Ci) {
  const { to, cc, bcc, subject, body, identity, send = false } = params;

  if (!to) {
    return { error: "to field is required" };
  }

  // Find identity
  let sendIdentity = null;
  for (const account of MailServices.accounts.accounts) {
    for (const id of account.identities) {
      if (identity && (id.email === identity || id.key === identity)) {
        sendIdentity = id;
        break;
      }
      if (!sendIdentity) {
        sendIdentity = id; // Default to first identity
      }
    }
    if (sendIdentity && identity) break;
  }

  if (!sendIdentity) {
    return { error: "No sending identity available" };
  }

  try {
    const composeFields = Cc["@mozilla.org/messengercompose/composefields;1"]
      .createInstance(Ci.nsIMsgCompFields);

    composeFields.to = Array.isArray(to) ? to.join(", ") : to;
    if (cc) composeFields.cc = Array.isArray(cc) ? cc.join(", ") : cc;
    if (bcc) composeFields.bcc = Array.isArray(bcc) ? bcc.join(", ") : bcc;
    composeFields.subject = subject || "";
    composeFields.body = body || "";

    if (send) {
      // Send immediately
      const composeParams = Cc["@mozilla.org/messengercompose/composeparams;1"]
        .createInstance(Ci.nsIMsgComposeParams);
      composeParams.type = Ci.nsIMsgCompType.New;
      composeParams.format = Ci.nsIMsgCompFormat.PlainText;
      composeParams.composeFields = composeFields;
      composeParams.identity = sendIdentity;

      MailServices.compose.OpenComposeWindowWithParams(null, composeParams);
      return { success: true, message: "Compose window opened for sending" };
    } else {
      // Save as draft
      const draftsFolder = findFolder("drafts", MailServices, Ci);
      if (!draftsFolder) {
        return { error: "Drafts folder not found" };
      }

      // Create message content
      const msgContent = [
        `From: ${sendIdentity.email}`,
        `To: ${composeFields.to}`,
        cc ? `Cc: ${composeFields.cc}` : null,
        `Subject: ${composeFields.subject}`,
        `Date: ${new Date().toUTCString()}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=UTF-8`,
        ``,
        composeFields.body,
      ].filter(Boolean).join("\r\n");

      // For now, open compose window in draft mode
      const composeParams = Cc["@mozilla.org/messengercompose/composeparams;1"]
        .createInstance(Ci.nsIMsgComposeParams);
      composeParams.type = Ci.nsIMsgCompType.Draft;
      composeParams.format = Ci.nsIMsgCompFormat.PlainText;
      composeParams.composeFields = composeFields;
      composeParams.identity = sendIdentity;

      MailServices.compose.OpenComposeWindowWithParams(null, composeParams);
      return { success: true, message: "Draft compose window opened" };
    }
  } catch (e) {
    return { error: `Failed to compose: ${e.message}` };
  }
}

/**
 * Update message flags or move messages
 */
export function updateMessages(params, MailServices, Ci) {
  const { ids, add_flags, remove_flags, move_to } = params;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return { error: "ids array is required" };
  }

  let updated = 0;
  let moved = 0;

  const destFolder = move_to ? findFolder(move_to, MailServices, Ci) : null;
  if (move_to && !destFolder) {
    return { error: `Destination folder not found: ${move_to}` };
  }

  for (const folder of getAllFolders(MailServices)) {
    try {
      const db = folder.msgDatabase;
      if (!db) continue;

      for (const msgHdr of db.enumerateMessages()) {
        if (!ids.includes(msgHdr.messageId)) continue;

        // Handle move
        if (destFolder && folder !== destFolder) {
          MailServices.copy.copyMessages(
            folder,
            [msgHdr],
            destFolder,
            true, // isMove
            null,
            null,
            false
          );
          moved++;
          continue;
        }

        // Handle flag changes
        if (add_flags) {
          for (const flag of add_flags) {
            const lower = flag.toLowerCase();
            if (lower === "read") msgHdr.markRead(true);
            else if (lower === "flagged") msgHdr.markFlagged(true);
          }
        }

        if (remove_flags) {
          for (const flag of remove_flags) {
            const lower = flag.toLowerCase();
            if (lower === "read") msgHdr.markRead(false);
            else if (lower === "flagged") msgHdr.markFlagged(false);
          }
        }

        updated++;
      }
    } catch {}
  }

  if (moved > 0) {
    return { success: true, message: `Moved ${moved} message(s)` };
  }
  return { success: true, message: `Updated ${updated} message(s)` };
}

/**
 * List all mailboxes/folders
 */
export function listMailboxes(MailServices, Ci) {
  const results = [];

  function addFolder(folder, parentId) {
    // Skip root folders
    if (!folder.parent) return;

    results.push({
      id: folder.URI,
      name: folder.prettyName,
      role: getFolderRole(folder, Ci),
      parent_id: parentId,
      unread: folder.getNumUnread(false),
      total: folder.getTotalMessages(false),
    });

    if (folder.hasSubFolders) {
      for (const sub of folder.subFolders) {
        addFolder(sub, folder.URI);
      }
    }
  }

  for (const account of MailServices.accounts.accounts) {
    const root = account.incomingServer.rootFolder;
    if (root.hasSubFolders) {
      for (const folder of root.subFolders) {
        addFolder(folder, null);
      }
    }
  }

  return { mailboxes: results };
}

/**
 * List all sending identities
 */
export function listIdentities(MailServices) {
  const results = [];
  for (const account of MailServices.accounts.accounts) {
    for (const identity of account.identities) {
      results.push({
        id: identity.key,
        name: identity.fullName,
        email: identity.email,
        reply_to: identity.replyTo || null,
      });
    }
  }
  return { identities: results };
}
```

**Step 2: Verify syntax**

Check file loads without error.

**Step 3: Commit**

```bash
git add mcp_server/email.sys.mjs
git commit -m "feat: add email module with search, show, compose, update"
```

---

## Task 3: Create calendar.sys.mjs

**Files:**
- Create: `mcp_server/calendar.sys.mjs`

**Step 1: Create the calendar module**

```javascript
/* exported calendar */
"use strict";

/**
 * List all calendars
 */
export function listCalendars(cal) {
  if (!cal) {
    return { error: "Calendar not available" };
  }

  try {
    const calendars = cal.manager.getCalendars().map(c => ({
      id: c.id,
      name: c.name,
      type: c.type,
      color: c.getProperty("color") || null,
      readOnly: c.readOnly,
    }));
    return { calendars };
  } catch (e) {
    return { error: `Failed to list calendars: ${e.message}` };
  }
}

/**
 * Find calendar by ID
 */
function findCalendar(calendarId, cal) {
  if (!cal) return null;
  for (const calendar of cal.manager.getCalendars()) {
    if (calendar.id === calendarId) {
      return calendar;
    }
  }
  return null;
}

/**
 * Convert calendar item to event object
 */
function itemToEvent(item, calendarId) {
  const startMs = item.startDate?.nativeTime ? item.startDate.nativeTime / 1000 : null;
  const endMs = item.endDate?.nativeTime ? item.endDate.nativeTime / 1000 : null;

  return {
    id: item.id,
    calendar: calendarId,
    title: item.title,
    start: startMs ? new Date(startMs).toISOString() : null,
    end: endMs ? new Date(endMs).toISOString() : null,
    location: item.getProperty("LOCATION") || null,
    description: item.getProperty("DESCRIPTION") || null,
  };
}

/**
 * List events with optional filters
 */
export async function listEvents(params, cal, Ci) {
  if (!cal) {
    return { error: "Calendar not available" };
  }

  const { calendar: calendarId, start, end } = params;

  // Parse date range
  const startDate = start ? new Date(start) : new Date();
  const endDate = end ? new Date(end) : new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000); // Default 30 days

  if (isNaN(startDate.getTime())) {
    return { error: "Invalid start date" };
  }
  if (isNaN(endDate.getTime())) {
    return { error: "Invalid end date" };
  }

  const rangeStart = cal.createDateTime();
  rangeStart.nativeTime = startDate.getTime() * 1000;

  const rangeEnd = cal.createDateTime();
  rangeEnd.nativeTime = endDate.getTime() * 1000;

  const results = [];

  // Get calendars to search
  let calendars;
  if (calendarId) {
    const calendar = findCalendar(calendarId, cal);
    if (!calendar) {
      return { error: `Calendar not found: ${calendarId}` };
    }
    calendars = [calendar];
  } else {
    calendars = cal.manager.getCalendars();
  }

  for (const calendar of calendars) {
    try {
      const items = await calendar.getItemsAsArray(
        Ci.calICalendar.ITEM_FILTER_TYPE_EVENT,
        0,
        rangeStart,
        rangeEnd
      );

      for (const item of items) {
        results.push(itemToEvent(item, calendar.id));
      }
    } catch (e) {
      // Skip calendars that fail
    }
  }

  // Sort by start date
  results.sort((a, b) => new Date(a.start) - new Date(b.start));

  return { events: results };
}

/**
 * Create a new event
 */
export async function createEvent(params, cal, Ci) {
  if (!cal) {
    return { error: "Calendar not available" };
  }

  const { calendar: calendarId, title, start, end, location, description } = params;

  if (!calendarId) {
    return { error: "calendar field is required" };
  }
  if (!title) {
    return { error: "title field is required" };
  }
  if (!start) {
    return { error: "start field is required" };
  }
  if (!end) {
    return { error: "end field is required" };
  }

  const calendar = findCalendar(calendarId, cal);
  if (!calendar) {
    return { error: `Calendar not found: ${calendarId}` };
  }
  if (calendar.readOnly) {
    return { error: "Calendar is read-only" };
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (isNaN(startDate.getTime())) {
    return { error: "Invalid start date" };
  }
  if (isNaN(endDate.getTime())) {
    return { error: "Invalid end date" };
  }

  try {
    const event = cal.createEvent();
    event.id = cal.getUUID();
    event.title = title;

    event.startDate = cal.createDateTime();
    event.startDate.nativeTime = startDate.getTime() * 1000;

    event.endDate = cal.createDateTime();
    event.endDate.nativeTime = endDate.getTime() * 1000;

    if (location) event.setProperty("LOCATION", location);
    if (description) event.setProperty("DESCRIPTION", description);

    await calendar.addItem(event);

    return {
      success: true,
      message: "Event created",
      id: event.id,
    };
  } catch (e) {
    return { error: `Failed to create event: ${e.message}` };
  }
}

/**
 * Update an existing event
 */
export async function updateEvent(eventId, params, cal, Ci) {
  if (!cal) {
    return { error: "Calendar not available" };
  }

  const { calendar: calendarId, title, start, end, location, description } = params;

  if (!calendarId) {
    return { error: "calendar parameter is required" };
  }

  const calendar = findCalendar(calendarId, cal);
  if (!calendar) {
    return { error: `Calendar not found: ${calendarId}` };
  }
  if (calendar.readOnly) {
    return { error: "Calendar is read-only" };
  }

  try {
    const event = await calendar.getItem(eventId);
    if (!event) {
      return { error: `Event not found: ${eventId}` };
    }

    const newEvent = event.clone();

    if (title !== undefined) newEvent.title = title;
    if (start !== undefined) {
      const startDate = new Date(start);
      if (isNaN(startDate.getTime())) {
        return { error: "Invalid start date" };
      }
      newEvent.startDate = cal.createDateTime();
      newEvent.startDate.nativeTime = startDate.getTime() * 1000;
    }
    if (end !== undefined) {
      const endDate = new Date(end);
      if (isNaN(endDate.getTime())) {
        return { error: "Invalid end date" };
      }
      newEvent.endDate = cal.createDateTime();
      newEvent.endDate.nativeTime = endDate.getTime() * 1000;
    }
    if (location !== undefined) newEvent.setProperty("LOCATION", location);
    if (description !== undefined) newEvent.setProperty("DESCRIPTION", description);

    await calendar.modifyItem(newEvent, event);

    return { success: true, message: "Event updated" };
  } catch (e) {
    return { error: `Failed to update event: ${e.message}` };
  }
}

/**
 * Delete an event
 */
export async function deleteEvent(eventId, params, cal) {
  if (!cal) {
    return { error: "Calendar not available" };
  }

  const { calendar: calendarId } = params;

  if (!calendarId) {
    return { error: "calendar parameter is required" };
  }

  const calendar = findCalendar(calendarId, cal);
  if (!calendar) {
    return { error: `Calendar not found: ${calendarId}` };
  }
  if (calendar.readOnly) {
    return { error: "Calendar is read-only" };
  }

  try {
    const event = await calendar.getItem(eventId);
    if (!event) {
      return { error: `Event not found: ${eventId}` };
    }

    await calendar.deleteItem(event);

    return { success: true, message: "Event deleted" };
  } catch (e) {
    return { error: `Failed to delete event: ${e.message}` };
  }
}
```

**Step 2: Verify syntax**

Check file loads without error.

**Step 3: Commit**

```bash
git add mcp_server/calendar.sys.mjs
git commit -m "feat: add calendar module with CRUD operations"
```

---

## Task 4: Create contacts.sys.mjs

**Files:**
- Create: `mcp_server/contacts.sys.mjs`

**Step 1: Create the contacts module**

```javascript
/* exported contacts */
"use strict";

const MAX_RESULTS = 100;
const DEFAULT_LIMIT = 50;

/**
 * Find address book by ID or name
 */
function findAddressBook(idOrName, MailServices) {
  if (!idOrName) return null;
  
  for (const book of MailServices.ab.directories) {
    if (book.UID === idOrName || book.URI === idOrName || 
        book.dirName.toLowerCase() === idOrName.toLowerCase()) {
      return book;
    }
  }
  return null;
}

/**
 * List all address books
 */
export function listAddressBooks(MailServices) {
  const results = [];
  for (const book of MailServices.ab.directories) {
    results.push({
      id: book.UID,
      name: book.dirName,
      readOnly: book.readOnly,
    });
  }
  return { addressbooks: results };
}

/**
 * Search contacts with optional filters
 */
export function searchContacts(params, MailServices) {
  const { q, addressbook, limit = DEFAULT_LIMIT } = params;

  const results = [];
  const maxResults = Math.min(parseInt(limit, 10) || DEFAULT_LIMIT, MAX_RESULTS);
  const lowerQuery = q ? q.toLowerCase() : null;

  // Get address books to search
  let books;
  if (addressbook) {
    const book = findAddressBook(addressbook, MailServices);
    if (!book) {
      return { error: `Address book not found: ${addressbook}` };
    }
    books = [book];
  } else {
    books = Array.from(MailServices.ab.directories);
  }

  for (const book of books) {
    if (results.length >= maxResults) break;

    try {
      for (const card of book.childCards) {
        if (results.length >= maxResults) break;
        if (card.isMailList) continue;

        // Apply search filter
        if (lowerQuery) {
          const email = (card.primaryEmail || "").toLowerCase();
          const displayName = (card.displayName || "").toLowerCase();
          const firstName = (card.firstName || "").toLowerCase();
          const lastName = (card.lastName || "").toLowerCase();

          if (!email.includes(lowerQuery) &&
              !displayName.includes(lowerQuery) &&
              !firstName.includes(lowerQuery) &&
              !lastName.includes(lowerQuery)) {
            continue;
          }
        }

        results.push({
          id: card.UID,
          addressbook: book.UID,
          email: card.primaryEmail || null,
          displayName: card.displayName || null,
          firstName: card.firstName || null,
          lastName: card.lastName || null,
        });
      }
    } catch (e) {
      // Skip address books that fail
    }
  }

  return {
    contacts: results,
    total: results.length,
    has_more: results.length >= maxResults,
  };
}

/**
 * Create a new contact
 */
export function createContact(params, MailServices, Cc, Ci) {
  const { addressbook, email, displayName, firstName, lastName } = params;

  if (!addressbook) {
    return { error: "addressbook field is required" };
  }
  if (!email) {
    return { error: "email field is required" };
  }

  const book = findAddressBook(addressbook, MailServices);
  if (!book) {
    return { error: `Address book not found: ${addressbook}` };
  }
  if (book.readOnly) {
    return { error: "Address book is read-only" };
  }

  try {
    const card = Cc["@mozilla.org/addressbook/cardproperty;1"]
      .createInstance(Ci.nsIAbCard);

    card.primaryEmail = email;
    if (displayName) card.displayName = displayName;
    if (firstName) card.firstName = firstName;
    if (lastName) card.lastName = lastName;

    const newCard = book.addCard(card);

    return {
      success: true,
      message: "Contact created",
      id: newCard.UID,
    };
  } catch (e) {
    return { error: `Failed to create contact: ${e.message}` };
  }
}

/**
 * Update an existing contact
 */
export function updateContact(contactId, params, MailServices) {
  const { addressbook, email, displayName, firstName, lastName } = params;

  if (!addressbook) {
    return { error: "addressbook parameter is required" };
  }

  const book = findAddressBook(addressbook, MailServices);
  if (!book) {
    return { error: `Address book not found: ${addressbook}` };
  }
  if (book.readOnly) {
    return { error: "Address book is read-only" };
  }

  try {
    // Find the contact
    let card = null;
    for (const c of book.childCards) {
      if (c.UID === contactId) {
        card = c;
        break;
      }
    }

    if (!card) {
      return { error: `Contact not found: ${contactId}` };
    }

    // Update fields
    if (email !== undefined) card.primaryEmail = email;
    if (displayName !== undefined) card.displayName = displayName;
    if (firstName !== undefined) card.firstName = firstName;
    if (lastName !== undefined) card.lastName = lastName;

    book.modifyCard(card);

    return { success: true, message: "Contact updated" };
  } catch (e) {
    return { error: `Failed to update contact: ${e.message}` };
  }
}

/**
 * Delete a contact
 */
export function deleteContact(contactId, params, MailServices) {
  const { addressbook } = params;

  if (!addressbook) {
    return { error: "addressbook parameter is required" };
  }

  const book = findAddressBook(addressbook, MailServices);
  if (!book) {
    return { error: `Address book not found: ${addressbook}` };
  }
  if (book.readOnly) {
    return { error: "Address book is read-only" };
  }

  try {
    // Find the contact
    let card = null;
    for (const c of book.childCards) {
      if (c.UID === contactId) {
        card = c;
        break;
      }
    }

    if (!card) {
      return { error: `Contact not found: ${contactId}` };
    }

    book.deleteCards([card]);

    return { success: true, message: "Contact deleted" };
  } catch (e) {
    return { error: `Failed to delete contact: ${e.message}` };
  }
}
```

**Step 2: Verify syntax**

Check file loads without error.

**Step 3: Commit**

```bash
git add mcp_server/contacts.sys.mjs
git commit -m "feat: add contacts module with CRUD operations"
```

---

## Task 5: Rewrite api.js with modular routing

**Files:**
- Modify: `mcp_server/api.js` (complete rewrite)

**Step 1: Rewrite the main API file**

```javascript
/* global ExtensionCommon, Cc, Ci, ChromeUtils */
"use strict";

const API_PORT = 9595;

const resProto = Cc[
  "@mozilla.org/network/protocol;1?name=resource"
].getService(Ci.nsISubstitutingProtocolHandler);

let serverInstance = null;

function log(msg) {
  console.log("[tb-api]", msg);
}

function logError(msg, error) {
  console.error("[tb-api]", msg, error);
  if (error?.stack) {
    console.error("[tb-api] Stack:", error.stack);
  }
}

var mcpServer = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    log("getAPI called");

    const extensionRoot = context.extension.rootURI;
    const resourceName = "tb-api";

    try {
      resProto.setSubstitutionWithFlags(
        resourceName,
        extensionRoot,
        resProto.ALLOW_CONTENT_ACCESS
      );
      log(`Resource protocol registered: resource://${resourceName}/`);
    } catch (e) {
      logError("Failed to register resource protocol", e);
    }

    return {
      mcpServer: {
        async start() {
          log("start() called");

          if (serverInstance) {
            log("Stopping existing server...");
            try {
              await new Promise((resolve) => serverInstance.stop(resolve));
              log("Existing server stopped");
            } catch (e) {
              log("Error stopping existing server: " + e.message);
            }
            serverInstance = null;
          }

          try {
            // Import modules
            log("Importing modules...");

            const { HttpServer } = ChromeUtils.importESModule(
              `resource://${resourceName}/httpd.sys.mjs`
            );
            const { NetUtil } = ChromeUtils.importESModule(
              "resource://gre/modules/NetUtil.sys.mjs"
            );
            const { MailServices } = ChromeUtils.importESModule(
              "resource:///modules/MailServices.sys.mjs"
            );
            const { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
              "resource:///modules/gloda/MimeMessage.sys.mjs"
            );

            // Import our modules
            const utils = ChromeUtils.importESModule(
              `resource://${resourceName}/utils.sys.mjs`
            );
            const email = ChromeUtils.importESModule(
              `resource://${resourceName}/email.sys.mjs`
            );
            const calendar = ChromeUtils.importESModule(
              `resource://${resourceName}/calendar.sys.mjs`
            );
            const contacts = ChromeUtils.importESModule(
              `resource://${resourceName}/contacts.sys.mjs`
            );

            // Calendar (optional)
            let cal = null;
            try {
              const calModule = ChromeUtils.importESModule(
                "resource:///modules/calendar/calUtils.sys.mjs"
              );
              cal = calModule.cal;
              log("Calendar module imported");
            } catch (e) {
              log("Calendar not available: " + e.message);
            }

            log("All modules imported successfully");

            // Create server
            serverInstance = new HttpServer();

            // ============================================================
            // ROUTE: /
            // ============================================================
            serverInstance.registerPathHandler("/", (req, res) => {
              utils.sendJson(res, req.httpVersion, {
                name: "Thunderbird REST API",
                version: "1.0",
                endpoints: {
                  email: [
                    "GET /messages - Search messages",
                    "GET /messages/:id - Get message by Message-ID",
                    "POST /messages - Create draft or send",
                    "PATCH /messages - Update message flags/move",
                    "GET /mailboxes - List folders",
                    "GET /identities - List identities",
                  ],
                  calendar: [
                    "GET /calendars - List calendars",
                    "GET /events - List events",
                    "POST /events - Create event",
                    "PATCH /events/:id - Update event",
                    "DELETE /events/:id - Delete event",
                  ],
                  contacts: [
                    "GET /addressbooks - List address books",
                    "GET /contacts - Search contacts",
                    "POST /contacts - Create contact",
                    "PATCH /contacts/:id - Update contact",
                    "DELETE /contacts/:id - Delete contact",
                  ],
                },
              });
            });

            // ============================================================
            // ROUTE: /messages
            // ============================================================
            serverInstance.registerPrefixHandler("/messages", (req, res) => {
              const messageId = utils.extractPathParam(req.path, "/messages/");

              if (req.method === "GET" && messageId) {
                // GET /messages/:id
                log(`GET /messages/${messageId}`);
                res.processAsync();

                email.getMessage(messageId, MailServices, MsgHdrToMimeMessage, Ci)
                  .then((result) => {
                    if (result.error) {
                      utils.sendError(res, req.httpVersion, result.error, 404);
                    } else {
                      utils.sendJson(res, req.httpVersion, result);
                    }
                    res.finish();
                  })
                  .catch((e) => {
                    logError("Error in GET /messages/:id", e);
                    utils.sendError(res, req.httpVersion, e.message, 500);
                    res.finish();
                  });

              } else if (req.method === "GET") {
                // GET /messages (search)
                log(`GET /messages?${req.queryString}`);
                try {
                  const params = utils.parseQueryString(req.queryString);
                  const result = email.searchMessages(params, MailServices, Ci, utils.parseDate);
                  if (result.error) {
                    utils.sendError(res, req.httpVersion, result.error);
                  } else {
                    utils.sendJson(res, req.httpVersion, result);
                  }
                } catch (e) {
                  logError("Error in GET /messages", e);
                  utils.sendError(res, req.httpVersion, e.message, 500);
                }

              } else if (req.method === "POST") {
                // POST /messages (compose)
                log("POST /messages");
                try {
                  const params = utils.parseRequestBody(req, NetUtil);
                  const result = email.composeMessage(params, MailServices, Ci);
                  if (result.error) {
                    utils.sendError(res, req.httpVersion, result.error);
                  } else {
                    utils.sendJson(res, req.httpVersion, result);
                  }
                } catch (e) {
                  logError("Error in POST /messages", e);
                  utils.sendError(res, req.httpVersion, e.message, 500);
                }

              } else if (req.method === "PATCH") {
                // PATCH /messages (update)
                log("PATCH /messages");
                try {
                  const params = utils.parseRequestBody(req, NetUtil);
                  const result = email.updateMessages(params, MailServices, Ci);
                  if (result.error) {
                    utils.sendError(res, req.httpVersion, result.error);
                  } else {
                    utils.sendJson(res, req.httpVersion, result);
                  }
                } catch (e) {
                  logError("Error in PATCH /messages", e);
                  utils.sendError(res, req.httpVersion, e.message, 500);
                }

              } else {
                utils.sendError(res, req.httpVersion, "Method not allowed", 405);
              }
            });

            // ============================================================
            // ROUTE: /mailboxes
            // ============================================================
            serverInstance.registerPathHandler("/mailboxes", (req, res) => {
              log("GET /mailboxes");
              if (req.method !== "GET") {
                utils.sendError(res, req.httpVersion, "Method not allowed", 405);
                return;
              }
              try {
                const result = email.listMailboxes(MailServices, Ci);
                utils.sendJson(res, req.httpVersion, result);
              } catch (e) {
                logError("Error in GET /mailboxes", e);
                utils.sendError(res, req.httpVersion, e.message, 500);
              }
            });

            // ============================================================
            // ROUTE: /identities
            // ============================================================
            serverInstance.registerPathHandler("/identities", (req, res) => {
              log("GET /identities");
              if (req.method !== "GET") {
                utils.sendError(res, req.httpVersion, "Method not allowed", 405);
                return;
              }
              try {
                const result = email.listIdentities(MailServices);
                utils.sendJson(res, req.httpVersion, result);
              } catch (e) {
                logError("Error in GET /identities", e);
                utils.sendError(res, req.httpVersion, e.message, 500);
              }
            });

            // ============================================================
            // ROUTE: /calendars
            // ============================================================
            serverInstance.registerPathHandler("/calendars", (req, res) => {
              log("GET /calendars");
              if (req.method !== "GET") {
                utils.sendError(res, req.httpVersion, "Method not allowed", 405);
                return;
              }
              try {
                const result = calendar.listCalendars(cal);
                if (result.error) {
                  utils.sendError(res, req.httpVersion, result.error, 503);
                } else {
                  utils.sendJson(res, req.httpVersion, result);
                }
              } catch (e) {
                logError("Error in GET /calendars", e);
                utils.sendError(res, req.httpVersion, e.message, 500);
              }
            });

            // ============================================================
            // ROUTE: /events
            // ============================================================
            serverInstance.registerPrefixHandler("/events", (req, res) => {
              const eventId = utils.extractPathParam(req.path, "/events/");

              if (req.method === "GET" && !eventId) {
                // GET /events (list)
                log(`GET /events?${req.queryString}`);
                res.processAsync();

                const params = utils.parseQueryString(req.queryString);
                calendar.listEvents(params, cal, Ci)
                  .then((result) => {
                    if (result.error) {
                      utils.sendError(res, req.httpVersion, result.error, 
                        result.error.includes("not available") ? 503 : 400);
                    } else {
                      utils.sendJson(res, req.httpVersion, result);
                    }
                    res.finish();
                  })
                  .catch((e) => {
                    logError("Error in GET /events", e);
                    utils.sendError(res, req.httpVersion, e.message, 500);
                    res.finish();
                  });

              } else if (req.method === "POST" && !eventId) {
                // POST /events (create)
                log("POST /events");
                res.processAsync();

                const params = utils.parseRequestBody(req, NetUtil);
                calendar.createEvent(params, cal, Ci)
                  .then((result) => {
                    if (result.error) {
                      utils.sendError(res, req.httpVersion, result.error,
                        result.error.includes("not available") ? 503 : 400);
                    } else {
                      utils.sendJson(res, req.httpVersion, result);
                    }
                    res.finish();
                  })
                  .catch((e) => {
                    logError("Error in POST /events", e);
                    utils.sendError(res, req.httpVersion, e.message, 500);
                    res.finish();
                  });

              } else if (req.method === "PATCH" && eventId) {
                // PATCH /events/:id (update)
                log(`PATCH /events/${eventId}`);
                res.processAsync();

                const params = utils.parseRequestBody(req, NetUtil);
                calendar.updateEvent(eventId, params, cal, Ci)
                  .then((result) => {
                    if (result.error) {
                      const status = result.error.includes("not found") ? 404 :
                                    result.error.includes("not available") ? 503 : 400;
                      utils.sendError(res, req.httpVersion, result.error, status);
                    } else {
                      utils.sendJson(res, req.httpVersion, result);
                    }
                    res.finish();
                  })
                  .catch((e) => {
                    logError("Error in PATCH /events/:id", e);
                    utils.sendError(res, req.httpVersion, e.message, 500);
                    res.finish();
                  });

              } else if (req.method === "DELETE" && eventId) {
                // DELETE /events/:id
                log(`DELETE /events/${eventId}`);
                res.processAsync();

                const params = utils.parseQueryString(req.queryString);
                calendar.deleteEvent(eventId, params, cal)
                  .then((result) => {
                    if (result.error) {
                      const status = result.error.includes("not found") ? 404 :
                                    result.error.includes("not available") ? 503 : 400;
                      utils.sendError(res, req.httpVersion, result.error, status);
                    } else {
                      utils.sendJson(res, req.httpVersion, result);
                    }
                    res.finish();
                  })
                  .catch((e) => {
                    logError("Error in DELETE /events/:id", e);
                    utils.sendError(res, req.httpVersion, e.message, 500);
                    res.finish();
                  });

              } else {
                utils.sendError(res, req.httpVersion, "Method not allowed", 405);
              }
            });

            // ============================================================
            // ROUTE: /addressbooks
            // ============================================================
            serverInstance.registerPathHandler("/addressbooks", (req, res) => {
              log("GET /addressbooks");
              if (req.method !== "GET") {
                utils.sendError(res, req.httpVersion, "Method not allowed", 405);
                return;
              }
              try {
                const result = contacts.listAddressBooks(MailServices);
                utils.sendJson(res, req.httpVersion, result);
              } catch (e) {
                logError("Error in GET /addressbooks", e);
                utils.sendError(res, req.httpVersion, e.message, 500);
              }
            });

            // ============================================================
            // ROUTE: /contacts
            // ============================================================
            serverInstance.registerPrefixHandler("/contacts", (req, res) => {
              const contactId = utils.extractPathParam(req.path, "/contacts/");

              if (req.method === "GET" && !contactId) {
                // GET /contacts (search)
                log(`GET /contacts?${req.queryString}`);
                try {
                  const params = utils.parseQueryString(req.queryString);
                  const result = contacts.searchContacts(params, MailServices);
                  if (result.error) {
                    utils.sendError(res, req.httpVersion, result.error);
                  } else {
                    utils.sendJson(res, req.httpVersion, result);
                  }
                } catch (e) {
                  logError("Error in GET /contacts", e);
                  utils.sendError(res, req.httpVersion, e.message, 500);
                }

              } else if (req.method === "POST" && !contactId) {
                // POST /contacts (create)
                log("POST /contacts");
                try {
                  const params = utils.parseRequestBody(req, NetUtil);
                  const result = contacts.createContact(params, MailServices, Cc, Ci);
                  if (result.error) {
                    utils.sendError(res, req.httpVersion, result.error);
                  } else {
                    utils.sendJson(res, req.httpVersion, result);
                  }
                } catch (e) {
                  logError("Error in POST /contacts", e);
                  utils.sendError(res, req.httpVersion, e.message, 500);
                }

              } else if (req.method === "PATCH" && contactId) {
                // PATCH /contacts/:id (update)
                log(`PATCH /contacts/${contactId}`);
                try {
                  const params = utils.parseRequestBody(req, NetUtil);
                  const result = contacts.updateContact(contactId, params, MailServices);
                  if (result.error) {
                    const status = result.error.includes("not found") ? 404 : 400;
                    utils.sendError(res, req.httpVersion, result.error, status);
                  } else {
                    utils.sendJson(res, req.httpVersion, result);
                  }
                } catch (e) {
                  logError("Error in PATCH /contacts/:id", e);
                  utils.sendError(res, req.httpVersion, e.message, 500);
                }

              } else if (req.method === "DELETE" && contactId) {
                // DELETE /contacts/:id
                log(`DELETE /contacts/${contactId}`);
                try {
                  const params = utils.parseQueryString(req.queryString);
                  const result = contacts.deleteContact(contactId, params, MailServices);
                  if (result.error) {
                    const status = result.error.includes("not found") ? 404 : 400;
                    utils.sendError(res, req.httpVersion, result.error, status);
                  } else {
                    utils.sendJson(res, req.httpVersion, result);
                  }
                } catch (e) {
                  logError("Error in DELETE /contacts/:id", e);
                  utils.sendError(res, req.httpVersion, e.message, 500);
                }

              } else {
                utils.sendError(res, req.httpVersion, "Method not allowed", 405);
              }
            });

            // Start server
            serverInstance.start(API_PORT);
            log(`REST API server started on port ${API_PORT}`);

            return { success: true, port: API_PORT };
          } catch (e) {
            logError("Failed to start server", e);
            return { success: false, error: e.message };
          }
        },
      },
    };
  }

  onShutdown() {
    log("Extension shutting down, stopping server...");
    if (serverInstance) {
      try {
        serverInstance.stop(() => log("Server stopped on shutdown"));
      } catch (e) {
        logError("Error stopping server on shutdown", e);
      }
      serverInstance = null;
    }
  }
};
```

**Step 2: Commit**

```bash
git add mcp_server/api.js
git commit -m "refactor: rewrite api.js with modular routing"
```

---

## Task 6: Update manifest.json for new modules

**Files:**
- Modify: `manifest.json`

**Step 1: Add new modules to web_accessible_resources**

```json
{
  "manifest_version": 2,
  "name": "Thunderbird API",
  "version": "1.0",
  "description": "REST API for AI assistants to access email, contacts, and calendars",
  "browser_specific_settings": {
    "gecko": {
      "id": "tb-api@julianprester.com",
      "strict_min_version": "115.0"
    }
  },
  "background": {
    "scripts": ["background.js"]
  },
  "experiment_apis": {
    "mcpServer": {
      "schema": "mcp_server/schema.json",
      "parent": {
        "scopes": ["addon_parent"],
        "paths": [["mcpServer"]],
        "script": "mcp_server/api.js"
      }
    }
  },
  "permissions": [
    "accountsRead",
    "addressBooks",
    "messagesRead",
    "accountsFolders",
    "compose"
  ],
  "web_accessible_resources": [
    "httpd.sys.mjs",
    "mcp_server/utils.sys.mjs",
    "mcp_server/email.sys.mjs",
    "mcp_server/calendar.sys.mjs",
    "mcp_server/contacts.sys.mjs"
  ]
}
```

**Step 2: Commit**

```bash
git add manifest.json
git commit -m "chore: add new modules to web_accessible_resources"
```

---

## Task 7: Integration testing - Email endpoints

**Prerequisites:** Install extension in Thunderbird with at least one email account configured.

**Step 1: Test root endpoint**

```bash
curl http://localhost:9595/
```

Expected: JSON with API info and endpoint listing.

**Step 2: Test mailboxes**

```bash
curl http://localhost:9595/mailboxes
```

Expected: `{ "mailboxes": [...] }` with inbox, sent, etc.

**Step 3: Test identities**

```bash
curl http://localhost:9595/identities
```

Expected: `{ "identities": [...] }` with at least one identity.

**Step 4: Test message search**

```bash
curl "http://localhost:9595/messages?limit=5"
```

Expected: `{ "messages": [...], "total": N, "has_more": bool }`

**Step 5: Test message search with filters**

```bash
curl "http://localhost:9595/messages?mailbox=inbox&limit=3"
```

Expected: Messages from inbox only.

**Step 6: Test get message (use message_id from search)**

```bash
curl "http://localhost:9595/messages/<message-id-from-step-4>"
```

Expected: Full message with body, attachments, etc.

**Step 7: Commit test results**

Document any issues found and fixes applied.

---

## Task 8: Integration testing - Calendar endpoints

**Prerequisites:** Thunderbird with Lightning calendar add-on and at least one calendar.

**Step 1: Test list calendars**

```bash
curl http://localhost:9595/calendars
```

Expected: `{ "calendars": [...] }` or `{ "error": "Calendar not available" }` if no calendar support.

**Step 2: Test list events**

```bash
curl "http://localhost:9595/events?start=2026-01-01T00:00:00Z&end=2026-12-31T23:59:59Z"
```

Expected: `{ "events": [...] }`

**Step 3: Test create event (use calendar ID from step 1)**

```bash
curl -X POST http://localhost:9595/events \
  -H "Content-Type: application/json" \
  -d '{
    "calendar": "<calendar-id>",
    "title": "Test Event",
    "start": "2026-01-15T10:00:00Z",
    "end": "2026-01-15T11:00:00Z",
    "location": "Test Location"
  }'
```

Expected: `{ "success": true, "message": "Event created", "id": "..." }`

**Step 4: Test update event**

```bash
curl -X PATCH "http://localhost:9595/events/<event-id>" \
  -H "Content-Type: application/json" \
  -d '{
    "calendar": "<calendar-id>",
    "title": "Updated Test Event"
  }'
```

Expected: `{ "success": true, "message": "Event updated" }`

**Step 5: Test delete event**

```bash
curl -X DELETE "http://localhost:9595/events/<event-id>?calendar=<calendar-id>"
```

Expected: `{ "success": true, "message": "Event deleted" }`

---

## Task 9: Integration testing - Contacts endpoints

**Step 1: Test list address books**

```bash
curl http://localhost:9595/addressbooks
```

Expected: `{ "addressbooks": [...] }`

**Step 2: Test search contacts**

```bash
curl "http://localhost:9595/contacts?limit=10"
```

Expected: `{ "contacts": [...], "total": N, "has_more": bool }`

**Step 3: Test create contact (use addressbook ID from step 1)**

```bash
curl -X POST http://localhost:9595/contacts \
  -H "Content-Type: application/json" \
  -d '{
    "addressbook": "<addressbook-id>",
    "email": "test@example.com",
    "firstName": "Test",
    "lastName": "Contact"
  }'
```

Expected: `{ "success": true, "message": "Contact created", "id": "..." }`

**Step 4: Test update contact**

```bash
curl -X PATCH "http://localhost:9595/contacts/<contact-id>" \
  -H "Content-Type: application/json" \
  -d '{
    "addressbook": "<addressbook-id>",
    "firstName": "Updated"
  }'
```

Expected: `{ "success": true, "message": "Contact updated" }`

**Step 5: Test delete contact**

```bash
curl -X DELETE "http://localhost:9595/contacts/<contact-id>?addressbook=<addressbook-id>"
```

Expected: `{ "success": true, "message": "Contact deleted" }`

---

## Task 10: Final cleanup and documentation

**Step 1: Remove old docs file if no longer needed**

```bash
rm docs/TKasperczyk.js  # if not needed as reference
```

**Step 2: Update schema.json port reference**

```json
[
  {
    "namespace": "mcpServer",
    "description": "REST API HTTP server for AI integration",
    "functions": [
      {
        "name": "start",
        "type": "function",
        "async": true,
        "description": "Start the REST API HTTP server on localhost:9595",
        "parameters": []
      }
    ]
  }
]
```

**Step 3: Final commit**

```bash
git add -A
git commit -m "chore: final cleanup and documentation updates"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Create utils module | utils.sys.mjs |
| 2 | Create email module | email.sys.mjs |
| 3 | Create calendar module | calendar.sys.mjs |
| 4 | Create contacts module | contacts.sys.mjs |
| 5 | Rewrite api.js | api.js |
| 6 | Update manifest | manifest.json |
| 7 | Test email endpoints | curl commands |
| 8 | Test calendar endpoints | curl commands |
| 9 | Test contacts endpoints | curl commands |
| 10 | Final cleanup | schema.json, docs |
