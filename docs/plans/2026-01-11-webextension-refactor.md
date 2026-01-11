# WebExtension API Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor tb-api to use WebExtension APIs for email/contacts (enabling proper draft save/close) while keeping calendar in Experiment context.

**Architecture:** 
- Experiment API handles HTTP server only + calendar routes directly
- Background script routes email/contacts requests to lib modules
- Lib modules use WebExtension APIs (`messenger.messages`, `messenger.compose`, `browser.contacts`)

**Tech Stack:** Thunderbird WebExtension APIs, Experiment API, Mozilla httpd.js

**Reference:** `/home/julian/Development/email-mcp` - working implementation of this pattern

---

## Task 1: Create New Directory Structure

**Files:**
- Create: `experiment/` directory
- Create: `lib/` directory

**Step 1: Create directories**

```bash
mkdir -p experiment lib
```

**Step 2: Verify structure**

```bash
ls -la experiment lib
```

Expected: Empty directories created

**Step 3: Commit**

```bash
git add experiment lib
git commit -m "chore: create new directory structure for refactor"
```

---

## Task 2: Create Experiment Schema (httpServer API)

**Files:**
- Create: `experiment/schema.json`

**Step 1: Create schema file**

Create `experiment/schema.json`:

```json
[
  {
    "namespace": "httpServer",
    "functions": [
      {
        "name": "start",
        "type": "function",
        "async": true,
        "parameters": [
          {
            "name": "port",
            "type": "integer",
            "description": "Port to listen on"
          }
        ]
      },
      {
        "name": "stop",
        "type": "function",
        "async": true,
        "parameters": []
      },
      {
        "name": "sendResponse",
        "type": "function",
        "async": false,
        "parameters": [
          {
            "name": "requestId",
            "type": "string"
          },
          {
            "name": "statusCode",
            "type": "integer"
          },
          {
            "name": "body",
            "type": "string"
          }
        ]
      }
    ],
    "events": [
      {
        "name": "onRequest",
        "type": "function",
        "parameters": [
          {
            "name": "request",
            "type": "object",
            "properties": {
              "id": { "type": "string" },
              "method": { "type": "string" },
              "path": { "type": "string" },
              "queryString": { "type": "string" },
              "body": { "type": "string" }
            }
          }
        ]
      }
    ]
  }
]
```

**Step 2: Verify JSON is valid**

```bash
python3 -m json.tool experiment/schema.json > /dev/null && echo "Valid JSON"
```

Expected: "Valid JSON"

**Step 3: Commit**

```bash
git add experiment/schema.json
git commit -m "feat: add httpServer experiment API schema"
```

---

## Task 3: Move and Adapt Calendar Module

**Files:**
- Move: `mcp_server/calendar.sys.mjs` → `experiment/calendar.sys.mjs`
- Keep existing implementation (already works)

**Step 1: Copy calendar module**

```bash
cp mcp_server/calendar.sys.mjs experiment/calendar.sys.mjs
```

**Step 2: Verify file exists**

```bash
head -20 experiment/calendar.sys.mjs
```

Expected: Calendar module content

**Step 3: Commit**

```bash
git add experiment/calendar.sys.mjs
git commit -m "feat: move calendar module to experiment directory"
```

---

## Task 4: Copy httpd.js to Experiment Directory

**Files:**
- Copy: `httpd.sys.mjs` → `experiment/httpd.js`

The email-mcp uses `httpd.js` loaded via `Services.scriptloader.loadSubScript`. We'll use the same approach.

**Step 1: Copy and rename httpd**

```bash
cp httpd.sys.mjs experiment/httpd.js
```

**Step 2: Verify file exists**

```bash
head -5 experiment/httpd.js
```

**Step 3: Commit**

```bash
git add experiment/httpd.js
git commit -m "feat: copy httpd to experiment directory"
```

---

## Task 5: Create Experiment api.js (HTTP Server + Calendar Routing)

**Files:**
- Create: `experiment/api.js`

**Step 1: Create api.js**

Create `experiment/api.js` that:
1. Provides httpServer.start/stop/sendResponse/onRequest
2. Routes calendar paths directly (using calendar.sys.mjs)
3. Fires onRequest event for all other paths

```javascript
/* global ExtensionCommon, Cc, Ci, Cu, Services, ChromeUtils */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

var httpServer = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    // Load httpd.js into a scope object
    const httpdScope = {};
    Services.scriptloader.loadSubScript(
      context.extension.rootURI.resolve("experiment/httpd.js"),
      httpdScope
    );
    const { HttpServer } = httpdScope;

    // Import calendar module
    const calendar = ChromeUtils.importESModule(
      context.extension.rootURI.resolve("experiment/calendar.sys.mjs")
    );

    // Calendar API (optional)
    let cal = null;
    try {
      const calModule = ChromeUtils.importESModule(
        "resource:///modules/calendar/calUtils.sys.mjs"
      );
      cal = calModule.cal;
    } catch (e) {
      console.log("[tb-api] Calendar not available");
    }

    let server = null;
    let pendingRequests = new Map();
    let requestCounter = 0;
    let onRequestFire = null;

    /**
     * Send JSON response
     */
    function sendJsonResponse(requestId, data, statusCode = 200) {
      const pending = pendingRequests.get(requestId);
      if (!pending) return;

      pendingRequests.delete(requestId);
      const { response, httpVersion } = pending;

      response.setStatusLine(httpVersion, statusCode, "OK");
      response.setHeader("Content-Type", "application/json; charset=utf-8", false);
      response.setHeader("Access-Control-Allow-Origin", "*", false);

      const body = JSON.stringify(data);
      const cos = Cc["@mozilla.org/intl/converter-output-stream;1"]
        .createInstance(Ci.nsIConverterOutputStream);
      cos.init(response.bodyOutputStream, "UTF-8");
      cos.writeString(body);
      cos.close();

      response.finish();
    }

    /**
     * Parse query string
     */
    function parseQueryString(qs) {
      if (!qs) return {};
      const params = {};
      for (const part of qs.split("&")) {
        const [key, value] = part.split("=");
        if (key) {
          params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : "";
        }
      }
      return params;
    }

    /**
     * Parse JSON body
     */
    function parseBody(bodyStr) {
      if (!bodyStr) return {};
      try {
        return JSON.parse(bodyStr);
      } catch (e) {
        return {};
      }
    }

    /**
     * Extract path parameter
     */
    function extractPathParam(path, prefix) {
      if (!path.startsWith(prefix)) return null;
      const param = path.slice(prefix.length).split("?")[0];
      return param ? decodeURIComponent(param) : null;
    }

    /**
     * Check if path is a calendar route
     */
    function isCalendarRoute(path) {
      return path === "/calendars" || 
             path === "/events" || 
             path.startsWith("/events/");
    }

    /**
     * Handle calendar routes directly
     */
    async function handleCalendarRoute(requestId, method, path, queryString, body) {
      const params = { ...parseQueryString(queryString), ...parseBody(body) };

      try {
        // GET /calendars
        if (path === "/calendars" && method === "GET") {
          const result = calendar.listCalendars(cal);
          if (result.error) {
            sendJsonResponse(requestId, result, 503);
          } else {
            sendJsonResponse(requestId, result);
          }
          return;
        }

        // GET /events
        if (path === "/events" && method === "GET") {
          const result = await calendar.listEvents(params, cal, Ci);
          if (result.error) {
            sendJsonResponse(requestId, result, result.error.includes("not available") ? 503 : 400);
          } else {
            sendJsonResponse(requestId, result);
          }
          return;
        }

        // POST /events
        if (path === "/events" && method === "POST") {
          const result = await calendar.createEvent(params, cal, Ci);
          if (result.error) {
            sendJsonResponse(requestId, result, result.error.includes("not available") ? 503 : 400);
          } else {
            sendJsonResponse(requestId, result);
          }
          return;
        }

        // PATCH /events/:id
        if (path.startsWith("/events/") && method === "PATCH") {
          const eventId = extractPathParam(path, "/events/");
          if (eventId) {
            const result = await calendar.updateEvent(eventId, params, cal, Ci);
            const status = result.error 
              ? (result.error.includes("not found") ? 404 : result.error.includes("not available") ? 503 : 400)
              : 200;
            sendJsonResponse(requestId, result, status);
            return;
          }
        }

        // DELETE /events/:id
        if (path.startsWith("/events/") && method === "DELETE") {
          const eventId = extractPathParam(path, "/events/");
          if (eventId) {
            const result = await calendar.deleteEvent(eventId, params, cal);
            const status = result.error
              ? (result.error.includes("not found") ? 404 : result.error.includes("not available") ? 503 : 400)
              : 200;
            sendJsonResponse(requestId, result, status);
            return;
          }
        }

        // Method not allowed
        sendJsonResponse(requestId, { error: "Method not allowed" }, 405);

      } catch (e) {
        console.error("[tb-api] Calendar error:", e);
        sendJsonResponse(requestId, { error: e.message }, 500);
      }
    }

    return {
      httpServer: {
        async start(port) {
          if (server) {
            throw new Error("Server already running");
          }

          server = new HttpServer();

          // Catch-all handler
          server.registerPrefixHandler("/", (request, response) => {
            const requestId = String(++requestCounter);
            response.processAsync();

            // Read body for POST/PATCH
            let body = "";
            if ((request.method === "POST" || request.method === "PATCH") && request.bodyInputStream) {
              const sis = Cc["@mozilla.org/scriptableinputstream;1"]
                .createInstance(Ci.nsIScriptableInputStream);
              sis.init(request.bodyInputStream);
              const available = sis.available();
              if (available > 0) {
                body = sis.read(available);
              }
            }

            pendingRequests.set(requestId, {
              response,
              httpVersion: request.httpVersion
            });

            const path = request.path;
            const method = request.method;
            const queryString = request.queryString;

            // Handle calendar routes directly in experiment context
            if (isCalendarRoute(path)) {
              handleCalendarRoute(requestId, method, path, queryString, body);
              return;
            }

            // Fire event for background script to handle
            if (onRequestFire) {
              onRequestFire.async({
                id: requestId,
                method: method,
                path: path,
                queryString: queryString || "",
                body: body
              });
            }
          });

          server._identity._primaryHost = "127.0.0.1";
          server.start(port);
          console.log(`[tb-api] HTTP server started on port ${port}`);
        },

        async stop() {
          if (server) {
            await new Promise(resolve => server.stop(resolve));
            server = null;
            pendingRequests.clear();
            console.log("[tb-api] HTTP server stopped");
          }
        },

        sendResponse(requestId, statusCode, body) {
          const pending = pendingRequests.get(requestId);
          if (!pending) {
            console.error(`[tb-api] No pending request with id ${requestId}`);
            return;
          }

          pendingRequests.delete(requestId);

          const { response, httpVersion } = pending;
          response.setStatusLine(httpVersion, statusCode, "OK");
          response.setHeader("Content-Type", "application/json; charset=utf-8", false);
          response.setHeader("Access-Control-Allow-Origin", "*", false);

          const cos = Cc["@mozilla.org/intl/converter-output-stream;1"]
            .createInstance(Ci.nsIConverterOutputStream);
          cos.init(response.bodyOutputStream, "UTF-8");
          cos.writeString(body);
          cos.close();

          response.finish();
        },

        onRequest: new ExtensionCommon.EventManager({
          context,
          name: "httpServer.onRequest",
          register: fire => {
            onRequestFire = fire;
            return () => {
              onRequestFire = null;
            };
          }
        }).api()
      }
    };
  }

  close() {
    // Cleanup
  }
};
```

**Step 2: Verify syntax**

```bash
node --check experiment/api.js 2>&1 || echo "Note: May show errors due to Thunderbird globals - that's OK"
```

**Step 3: Commit**

```bash
git add experiment/api.js
git commit -m "feat: create experiment api.js with HTTP server and calendar routing"
```

---

## Task 6: Create lib/utils.js

**Files:**
- Create: `lib/utils.js`

**Step 1: Create utils module**

Create `lib/utils.js`:

```javascript
"use strict";

/**
 * Parse query string into object
 */
function parseQueryString(qs) {
  if (!qs) return {};
  const params = {};
  for (const part of qs.split("&")) {
    const [key, value] = part.split("=");
    if (key) {
      params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : "";
    }
  }
  return params;
}

/**
 * Parse date string (ISO 8601 or relative like "today", "yesterday")
 */
function parseDate(dateStr) {
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
 * Format JSON response
 */
function jsonResponse(data, statusCode = 200) {
  return {
    statusCode,
    body: JSON.stringify(data)
  };
}

/**
 * Format error response
 */
function errorResponse(message, statusCode = 400) {
  return {
    statusCode,
    body: JSON.stringify({ error: message })
  };
}

// Export for use in background script
var Utils = {
  parseQueryString,
  parseDate,
  jsonResponse,
  errorResponse
};
```

**Step 2: Commit**

```bash
git add lib/utils.js
git commit -m "feat: add lib/utils.js with parsing and response helpers"
```

---

## Task 7: Create lib/email.js (WebExtension API)

**Files:**
- Create: `lib/email.js`

**Step 1: Create email module**

Create `lib/email.js` using WebExtension APIs (`messenger.messages`, `messenger.compose`, `messenger.folders`, `messenger.identities`):

```javascript
"use strict";

/**
 * Email operations using WebExtension APIs
 */

/**
 * Search messages
 */
async function searchMessages(params) {
  const { text, from, to, subject, mailbox, after, before, limit = 50 } = params;
  const maxResults = Math.min(parseInt(limit, 10) || 50, 100);

  const queryInfo = {};

  if (text) queryInfo.fullText = text;
  if (from) queryInfo.author = from;
  if (to) queryInfo.recipients = to;
  if (subject) queryInfo.subject = subject;

  if (after) {
    const date = Utils.parseDate(after);
    if (date) queryInfo.fromDate = date;
  }
  if (before) {
    const date = Utils.parseDate(before);
    if (date) queryInfo.toDate = date;
  }

  if (mailbox) {
    const folderId = await resolveMailbox(mailbox);
    if (!folderId) {
      return { error: `Mailbox not found: ${mailbox}` };
    }
    queryInfo.folderId = folderId;
  }

  const result = await messenger.messages.query(queryInfo);
  let messages = result.messages || [];

  const hasMore = messages.length > maxResults;
  messages = messages.slice(0, maxResults);

  // Format messages
  const formatted = await Promise.all(messages.map(async (msg) => {
    let preview = "";
    try {
      const parts = await messenger.messages.listInlineTextParts(msg.id);
      if (parts && parts.length > 0) {
        const plainPart = parts.find(p => p.contentType === "text/plain");
        if (plainPart && plainPart.content) {
          preview = plainPart.content.substring(0, 300);
        }
      }
    } catch (e) {}

    return {
      id: msg.id,
      message_id: msg.headerMessageId,
      date: msg.date ? new Date(msg.date).toISOString() : null,
      from: msg.author,
      subject: msg.subject,
      flags: getFlags(msg),
      mailbox: msg.folder?.name || "",
      has_attachment: (msg.attachments && msg.attachments.length > 0) || false,
      preview
    };
  }));

  return {
    messages: formatted,
    total: formatted.length,
    has_more: hasMore
  };
}

/**
 * Get single message by Message-ID
 */
async function getMessage(messageId) {
  const result = await messenger.messages.query({ headerMessageId: messageId });
  if (!result.messages || result.messages.length === 0) {
    return { error: `Message not found: ${messageId}` };
  }

  const msg = result.messages[0];
  const full = await messenger.messages.getFull(msg.id);
  const attachments = await messenger.messages.listAttachments(msg.id);

  // Extract body
  let body = "";
  try {
    const parts = await messenger.messages.listInlineTextParts(msg.id);
    if (parts && parts.length > 0) {
      const plainPart = parts.find(p => p.contentType === "text/plain");
      if (plainPart) {
        body = plainPart.content || "";
      } else {
        const htmlPart = parts.find(p => p.contentType === "text/html");
        if (htmlPart) {
          body = await messenger.messengerUtilities.convertToPlainText(htmlPart.content);
        }
      }
    }
  } catch (e) {}

  return {
    id: msg.id,
    message_id: msg.headerMessageId,
    date: msg.date ? new Date(msg.date).toISOString() : null,
    from: msg.author,
    to: msg.recipients || [],
    cc: msg.ccList || [],
    subject: msg.subject,
    flags: getFlags(msg),
    mailbox: msg.folder?.name || "",
    body,
    attachments: attachments.map(a => ({
      name: a.name,
      size: a.size,
      contentType: a.contentType
    })),
    in_reply_to: full.headers?.["in-reply-to"]?.[0] || null,
    references: full.headers?.["references"]?.[0]?.split(/\s+/) || []
  };
}

/**
 * Compose message (draft or send)
 */
async function composeMessage(params) {
  const { to, cc, bcc, subject, body, identity, send = false } = params;

  if (!to) {
    return { error: "to field is required" };
  }

  // Find identity
  let identityId = null;
  if (identity) {
    const identities = await messenger.identities.list();
    const match = identities.find(id =>
      id.email.toLowerCase() === identity.toLowerCase() || id.id === identity
    );
    if (match) identityId = match.id;
  }
  if (!identityId) {
    const identities = await messenger.identities.list();
    if (identities.length > 0) identityId = identities[0].id;
  }

  const composeDetails = {
    to: Array.isArray(to) ? to : [to],
    subject: subject || "",
    plainTextBody: body || "",
    isPlainText: true
  };

  if (cc) composeDetails.cc = Array.isArray(cc) ? cc : [cc];
  if (bcc) composeDetails.bcc = Array.isArray(bcc) ? bcc : [bcc];
  if (identityId) composeDetails.identityId = identityId;

  const tab = await messenger.compose.beginNew(composeDetails);

  try {
    if (send) {
      const sendResult = await messenger.compose.sendMessage(tab.id, { mode: "sendNow" });
      if (sendResult.messages && sendResult.messages.length > 0) {
        return {
          success: true,
          message: "Message sent",
          message_id: sendResult.messages[0].headerMessageId
        };
      }
      return { success: true, message: "Message sent" };
    } else {
      await messenger.compose.saveMessage(tab.id, { mode: "draft" });
      await messenger.tabs.remove(tab.id);
      return { success: true, message: "Draft saved" };
    }
  } catch (e) {
    try { await messenger.tabs.remove(tab.id); } catch {}
    return { error: `Failed to ${send ? "send" : "save draft"}: ${e.message}` };
  }
}

/**
 * Update messages (flags, move)
 */
async function updateMessages(params) {
  const { ids, add_flags, remove_flags, move_to } = params;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return { error: "ids array is required" };
  }

  // Resolve message IDs (could be headerMessageId strings or internal IDs)
  const messageIds = [];
  for (const id of ids) {
    if (typeof id === "number") {
      messageIds.push(id);
    } else {
      const result = await messenger.messages.query({ headerMessageId: id });
      if (result.messages && result.messages.length > 0) {
        messageIds.push(result.messages[0].id);
      }
    }
  }

  if (messageIds.length === 0) {
    return { error: "No valid message IDs found" };
  }

  let count = 0;

  // Handle move
  if (move_to) {
    const folderId = await resolveMailbox(move_to);
    if (!folderId) {
      return { error: `Destination folder not found: ${move_to}` };
    }
    for (const msgId of messageIds) {
      try {
        await messenger.messages.move([msgId], folderId);
        count++;
      } catch (e) {}
    }
    return { success: true, message: `Moved ${count} message(s)` };
  }

  // Handle flags
  const updates = {};
  if (add_flags) {
    for (const flag of add_flags) {
      const lower = flag.toLowerCase();
      if (lower === "read") updates.read = true;
      else if (lower === "flagged") updates.flagged = true;
      else if (lower === "junk") updates.junk = true;
    }
  }
  if (remove_flags) {
    for (const flag of remove_flags) {
      const lower = flag.toLowerCase();
      if (lower === "read") updates.read = false;
      else if (lower === "flagged") updates.flagged = false;
      else if (lower === "junk") updates.junk = false;
    }
  }

  if (Object.keys(updates).length > 0) {
    for (const msgId of messageIds) {
      try {
        await messenger.messages.update(msgId, updates);
        count++;
      } catch (e) {}
    }
  }

  return { success: true, message: `Updated ${count} message(s)` };
}

/**
 * List mailboxes
 */
async function listMailboxes() {
  const accounts = await messenger.accounts.list();
  const mailboxes = [];

  for (const account of accounts) {
    const folders = await messenger.folders.query({ accountId: account.id });
    for (const folder of folders) {
      let info = { unreadMessageCount: 0, totalMessageCount: 0 };
      try {
        info = await messenger.folders.getFolderInfo(folder.id);
      } catch (e) {}

      mailboxes.push({
        id: folder.id,
        name: folder.name,
        role: folder.specialUse?.[0] || null,
        parent_id: folder.parentId || null,
        unread: info.unreadMessageCount || 0,
        total: info.totalMessageCount || 0
      });
    }
  }

  return { mailboxes };
}

/**
 * List identities
 */
async function listIdentities() {
  const identities = await messenger.identities.list();
  return {
    identities: identities.map(id => ({
      id: id.id,
      name: id.name,
      email: id.email,
      reply_to: id.replyTo || null
    }))
  };
}

// Helper functions

function getFlags(msg) {
  const flags = [];
  if (msg.read) flags.push("read");
  if (msg.flagged) flags.push("flagged");
  if (msg.draft) flags.push("draft");
  if (msg.answered) flags.push("answered");
  if (msg.forwarded) flags.push("forwarded");
  return flags;
}

async function resolveMailbox(mailbox) {
  const normalized = mailbox.toLowerCase();
  const validRoles = ["archives", "drafts", "inbox", "junk", "outbox", "sent", "templates", "trash"];

  // Try as role
  if (validRoles.includes(normalized)) {
    const byRole = await messenger.folders.query({ specialUse: [normalized] });
    if (byRole.length > 0) return byRole[0].id;
  }

  // Try as name
  const accounts = await messenger.accounts.list();
  for (const account of accounts) {
    const folders = await messenger.folders.query({ accountId: account.id });
    const byName = folders.find(f => f.name.toLowerCase() === normalized);
    if (byName) return byName.id;
  }

  // Try as ID
  try {
    const folder = await messenger.folders.get(mailbox);
    if (folder) return mailbox;
  } catch (e) {}

  return null;
}

// Export
var Email = {
  searchMessages,
  getMessage,
  composeMessage,
  updateMessages,
  listMailboxes,
  listIdentities
};
```

**Step 2: Commit**

```bash
git add lib/email.js
git commit -m "feat: add lib/email.js with WebExtension API operations"
```

---

## Task 8: Create lib/contacts.js (WebExtension API)

**Files:**
- Create: `lib/contacts.js`

**Step 1: Create contacts module**

Create `lib/contacts.js` using WebExtension APIs (`browser.addressBooks`, `browser.contacts`):

```javascript
"use strict";

/**
 * Contacts operations using WebExtension APIs
 */

/**
 * List address books
 */
async function listAddressBooks() {
  const books = await browser.addressBooks.list();
  return {
    addressbooks: books.map(book => ({
      id: book.id,
      name: book.name,
      readOnly: book.readOnly || false
    }))
  };
}

/**
 * Search contacts
 */
async function searchContacts(params) {
  const { q, addressbook, limit = 50 } = params;
  const maxResults = Math.min(parseInt(limit, 10) || 50, 100);

  let contacts = [];

  if (addressbook) {
    // Search specific address book
    contacts = await browser.contacts.list(addressbook);
  } else {
    // Search all address books
    const books = await browser.addressBooks.list();
    for (const book of books) {
      const bookContacts = await browser.contacts.list(book.id);
      contacts.push(...bookContacts);
    }
  }

  // Filter by query
  if (q) {
    const lower = q.toLowerCase();
    contacts = contacts.filter(c => {
      const props = c.properties || {};
      return (props.PrimaryEmail || "").toLowerCase().includes(lower) ||
             (props.DisplayName || "").toLowerCase().includes(lower) ||
             (props.FirstName || "").toLowerCase().includes(lower) ||
             (props.LastName || "").toLowerCase().includes(lower);
    });
  }

  const hasMore = contacts.length > maxResults;
  contacts = contacts.slice(0, maxResults);

  return {
    contacts: contacts.map(c => formatContact(c)),
    total: contacts.length,
    has_more: hasMore
  };
}

/**
 * Create contact
 */
async function createContact(params) {
  const { addressbook, email, firstName, lastName, displayName } = params;

  if (!addressbook) {
    return { error: "addressbook field is required" };
  }
  if (!email) {
    return { error: "email field is required" };
  }

  // Build vCard
  const vCardLines = [
    "BEGIN:VCARD",
    "VERSION:4.0",
    `EMAIL:${email}`
  ];

  if (firstName || lastName) {
    vCardLines.push(`N:${lastName || ""};${firstName || ""};;;`);
  }
  
  const fn = displayName || [firstName, lastName].filter(Boolean).join(" ") || email;
  vCardLines.push(`FN:${fn}`);
  vCardLines.push("END:VCARD");

  const vCard = vCardLines.join("\r\n");

  try {
    const id = await browser.contacts.create(addressbook, vCard);
    return { success: true, message: "Contact created", id };
  } catch (e) {
    return { error: `Failed to create contact: ${e.message}` };
  }
}

/**
 * Update contact
 */
async function updateContact(contactId, params) {
  const { email, firstName, lastName, displayName } = params;

  try {
    const contact = await browser.contacts.get(contactId);
    if (!contact) {
      return { error: `Contact not found: ${contactId}` };
    }

    const props = contact.properties || {};
    const newEmail = email !== undefined ? email : props.PrimaryEmail || "";
    const newFirstName = firstName !== undefined ? firstName : props.FirstName || "";
    const newLastName = lastName !== undefined ? lastName : props.LastName || "";
    const newDisplayName = displayName !== undefined ? displayName : props.DisplayName || "";

    // Build updated vCard
    const vCardLines = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      `EMAIL:${newEmail}`
    ];

    if (newFirstName || newLastName) {
      vCardLines.push(`N:${newLastName};${newFirstName};;;`);
    }

    const fn = newDisplayName || [newFirstName, newLastName].filter(Boolean).join(" ") || newEmail;
    vCardLines.push(`FN:${fn}`);
    vCardLines.push("END:VCARD");

    const vCard = vCardLines.join("\r\n");
    await browser.contacts.update(contactId, vCard);

    return { success: true, message: "Contact updated" };
  } catch (e) {
    return { error: `Failed to update contact: ${e.message}` };
  }
}

/**
 * Delete contact
 */
async function deleteContact(contactId) {
  try {
    await browser.contacts.delete(contactId);
    return { success: true, message: "Contact deleted" };
  } catch (e) {
    return { error: `Failed to delete contact: ${e.message}` };
  }
}

// Helper functions

function formatContact(contact) {
  const props = contact.properties || {};
  return {
    id: contact.id,
    addressbook: contact.parentId,
    email: props.PrimaryEmail || null,
    displayName: props.DisplayName || null,
    firstName: props.FirstName || null,
    lastName: props.LastName || null
  };
}

// Export
var Contacts = {
  listAddressBooks,
  searchContacts,
  createContact,
  updateContact,
  deleteContact
};
```

**Step 2: Commit**

```bash
git add lib/contacts.js
git commit -m "feat: add lib/contacts.js with WebExtension API operations"
```

---

## Task 9: Create New background.js (Request Router)

**Files:**
- Replace: `background.js`

**Step 1: Create new background.js**

Replace `background.js`:

```javascript
"use strict";

const PORT = 9595;

/**
 * Handle HTTP request from experiment
 */
async function handleRequest(request) {
  const { method, path, queryString, body } = request;
  const params = { ...Utils.parseQueryString(queryString), ...(body ? JSON.parse(body) : {}) };

  console.log(`[tb-api] ${method} ${path}`);

  try {
    // Root endpoint
    if (path === "/" && method === "GET") {
      return Utils.jsonResponse({
        name: "Thunderbird REST API",
        version: "1.0",
        endpoints: {
          email: [
            "GET /messages - Search messages",
            "GET /messages/:id - Get message by Message-ID",
            "POST /messages - Create draft or send",
            "PATCH /messages - Update message flags/move",
            "GET /mailboxes - List folders",
            "GET /identities - List identities"
          ],
          calendar: [
            "GET /calendars - List calendars",
            "GET /events - List events",
            "POST /events - Create event",
            "PATCH /events/:id - Update event",
            "DELETE /events/:id - Delete event"
          ],
          contacts: [
            "GET /addressbooks - List address books",
            "GET /contacts - Search contacts",
            "POST /contacts - Create contact",
            "PATCH /contacts/:id - Update contact",
            "DELETE /contacts/:id - Delete contact"
          ]
        }
      });
    }

    // Email routes
    if (path === "/messages" && method === "GET") {
      const result = await Email.searchMessages(params);
      return result.error ? Utils.errorResponse(result.error) : Utils.jsonResponse(result);
    }

    if (path.startsWith("/messages/") && method === "GET") {
      const messageId = decodeURIComponent(path.slice("/messages/".length));
      const result = await Email.getMessage(messageId);
      return result.error ? Utils.errorResponse(result.error, 404) : Utils.jsonResponse(result);
    }

    if (path === "/messages" && method === "POST") {
      const result = await Email.composeMessage(params);
      return result.error ? Utils.errorResponse(result.error) : Utils.jsonResponse(result);
    }

    if (path === "/messages" && method === "PATCH") {
      const result = await Email.updateMessages(params);
      return result.error ? Utils.errorResponse(result.error) : Utils.jsonResponse(result);
    }

    if (path === "/mailboxes" && method === "GET") {
      const result = await Email.listMailboxes();
      return Utils.jsonResponse(result);
    }

    if (path === "/identities" && method === "GET") {
      const result = await Email.listIdentities();
      return Utils.jsonResponse(result);
    }

    // Contacts routes
    if (path === "/addressbooks" && method === "GET") {
      const result = await Contacts.listAddressBooks();
      return Utils.jsonResponse(result);
    }

    if (path === "/contacts" && method === "GET") {
      const result = await Contacts.searchContacts(params);
      return result.error ? Utils.errorResponse(result.error) : Utils.jsonResponse(result);
    }

    if (path === "/contacts" && method === "POST") {
      const result = await Contacts.createContact(params);
      return result.error ? Utils.errorResponse(result.error) : Utils.jsonResponse(result);
    }

    if (path.startsWith("/contacts/") && method === "PATCH") {
      const contactId = decodeURIComponent(path.slice("/contacts/".length));
      const result = await Contacts.updateContact(contactId, params);
      return result.error ? Utils.errorResponse(result.error, result.error.includes("not found") ? 404 : 400) : Utils.jsonResponse(result);
    }

    if (path.startsWith("/contacts/") && method === "DELETE") {
      const contactId = decodeURIComponent(path.slice("/contacts/".length));
      const result = await Contacts.deleteContact(contactId);
      return result.error ? Utils.errorResponse(result.error, result.error.includes("not found") ? 404 : 400) : Utils.jsonResponse(result);
    }

    // Not found
    return Utils.errorResponse("Not found", 404);

  } catch (e) {
    console.error("[tb-api] Error:", e);
    return Utils.errorResponse(e.message, 500);
  }
}

// Listen for HTTP requests from experiment
browser.httpServer.onRequest.addListener(async (request) => {
  const response = await handleRequest(request);
  browser.httpServer.sendResponse(request.id, response.statusCode, response.body);
});

// Start server
browser.httpServer.start(PORT).then(() => {
  console.log(`[tb-api] REST API server listening at http://127.0.0.1:${PORT}`);
}).catch(error => {
  console.error("[tb-api] Failed to start server:", error);
});
```

**Step 2: Commit**

```bash
git add background.js
git commit -m "feat: rewrite background.js as request router using WebExtension APIs"
```

---

## Task 10: Update manifest.json

**Files:**
- Modify: `manifest.json`

**Step 1: Update manifest**

Update `manifest.json`:

```json
{
  "manifest_version": 2,
  "name": "Thunderbird API",
  "version": "1.1",
  "description": "REST API for AI assistants to access email, contacts, and calendars",
  "browser_specific_settings": {
    "gecko": {
      "id": "tb-api@julianprester.com",
      "strict_min_version": "115.0"
    }
  },
  "permissions": [
    "accountsRead",
    "addressBooks",
    "messagesRead",
    "messagesUpdate",
    "messagesMove",
    "accountsFolders",
    "compose",
    "compose.send",
    "compose.save"
  ],
  "background": {
    "scripts": [
      "lib/utils.js",
      "lib/email.js",
      "lib/contacts.js",
      "background.js"
    ]
  },
  "experiment_apis": {
    "httpServer": {
      "schema": "experiment/schema.json",
      "parent": {
        "scopes": ["addon_parent"],
        "paths": [["httpServer"]],
        "script": "experiment/api.js"
      }
    }
  }
}
```

**Step 2: Verify JSON**

```bash
python3 -m json.tool manifest.json > /dev/null && echo "Valid JSON"
```

**Step 3: Commit**

```bash
git add manifest.json
git commit -m "feat: update manifest for new architecture"
```

---

## Task 11: Clean Up Old Files

**Files:**
- Remove: `mcp_server/` directory (old implementation)

**Step 1: Remove old directory**

```bash
rm -rf mcp_server
```

**Step 2: Verify removal**

```bash
ls mcp_server 2>&1 | grep -q "No such file" && echo "Removed"
```

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove old mcp_server directory"
```

---

## Task 12: Test Read Endpoints

**Step 1: Restart Thunderbird and load extension**

Manual step: Restart Thunderbird, load extension from Debug Add-ons

**Step 2: Run read endpoint tests**

```bash
./test-api.sh
```

Expected: All 12 read tests pass

**Step 3: If tests fail, debug and fix**

Check Thunderbird console for errors. Common issues:
- Missing permissions in manifest
- Incorrect API usage
- Module loading errors

---

## Task 13: Test Write Endpoints

**Step 1: Run write tests**

```bash
./test-write-api.sh
```

**Step 2: Verify draft saves and closes window**

The key test: POST /messages with send:false should save draft and NOT leave a compose window open.

**Step 3: Fix any issues and commit**

```bash
git add -A
git commit -m "fix: address issues found in write tests"
```

---

## Task 14: Final Cleanup and Documentation

**Step 1: Update README if needed**

Ensure README reflects new architecture.

**Step 2: Final commit**

```bash
git add -A
git commit -m "docs: finalize WebExtension refactor"
```

---

## Summary

After completing all tasks:
- Email/Contacts use WebExtension APIs (proper draft save/close)
- Calendar uses Experiment API (no WebExtension available)
- HTTP server is minimal, just routing
- Modular architecture matching email-mcp pattern
