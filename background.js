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
    // Root endpoint - LLM-friendly API description
    if (path === "/" && method === "GET") {
      return Utils.jsonResponse({
        name: "Thunderbird REST API",
        version: "2.0",
        description: "REST API for Thunderbird email, calendar, and contacts. Designed for AI/LLM consumption with flexible inputs and helpful error messages.",
        tips: [
          "Dates accept: ISO 8601, 'today', 'tomorrow', 'yesterday', '2 days ago', 'next week'",
          "Parameters have aliases: 'q'/'query'/'search', 'folder'/'mailbox', etc.",
          "Errors include 'suggestions' array with actionable fixes",
          "Calendar/addressbook can be specified by name (fuzzy matched) or ID"
        ],
        endpoints: {
          email: {
            "GET /messages": "Search messages. Params: text/q, from, to, subject, mailbox/folder, after/since, before/until, limit",
            "GET /messages/:id": "Get message by Message-ID (with or without angle brackets)",
            "POST /messages": "Compose/reply/forward. Params: to, subject, body, identity, send, in_reply_to (message_id to reply), forward_of (message_id to forward)",
            "PATCH /messages": "Update flags or move. Params: ids[], flags (read/unread/starred/flagged/junk), mailbox (to move)",
            "GET /mailboxes": "List all mail folders",
            "GET /identities": "List send-from identities"
          },
          calendar: {
            "GET /calendars": "List all calendars",
            "GET /events": "List events. Params: calendar (optional), start (default: now), end (default: +30 days). Returns organizer/attendees if present.",
            "POST /events": "Create event. Params: title, start, end, calendar, location, description, organizer (email or {email,name}), attendees ([{email,name,role,status}] or [emails])",
            "PATCH /events/:id": "Update event. Params: calendar (required), title, start, end, location, description, organizer, attendees (replaces all)",
            "DELETE /events/:id": "Delete event. Params: calendar (required)"
          },
          contacts: {
            "GET /addressbooks": "List all address books",
            "GET /contacts": "Search contacts. Params: q/query, addressbook/book (optional)",
            "POST /contacts": "Create contact. Params: email (required), firstName, lastName, displayName, addressbook",
            "PATCH /contacts/:id": "Update contact. Params: email, firstName, lastName, displayName",
            "DELETE /contacts/:id": "Delete contact"
          }
        }
      });
    }

    // Email routes
    if (path === "/messages" && method === "GET") {
      return Utils.resultResponse(await Email.searchMessages(params));
    }

    if (path.startsWith("/messages/") && method === "GET") {
      const messageId = decodeURIComponent(path.slice("/messages/".length));
      return Utils.resultResponse(await Email.getMessage(messageId), 404);
    }

    if (path === "/messages" && method === "POST") {
      return Utils.resultResponse(await Email.composeMessage(params));
    }

    if (path === "/messages" && method === "PATCH") {
      return Utils.resultResponse(await Email.updateMessages(params));
    }

    if (path === "/mailboxes" && method === "GET") {
      return Utils.jsonResponse(await Email.listMailboxes());
    }

    if (path === "/identities" && method === "GET") {
      return Utils.jsonResponse(await Email.listIdentities());
    }

    // Contacts routes
    if (path === "/addressbooks" && method === "GET") {
      return Utils.jsonResponse(await Contacts.listAddressBooks());
    }

    if (path === "/contacts" && method === "GET") {
      return Utils.resultResponse(await Contacts.searchContacts(params));
    }

    if (path === "/contacts" && method === "POST") {
      return Utils.resultResponse(await Contacts.createContact(params));
    }

    if (path.startsWith("/contacts/") && method === "PATCH") {
      const contactId = decodeURIComponent(path.slice("/contacts/".length));
      const result = await Contacts.updateContact(contactId, params);
      return Utils.resultResponse(result, Utils.getErrorStatusFromMessage(result.error || ""));
    }

    if (path.startsWith("/contacts/") && method === "DELETE") {
      const contactId = decodeURIComponent(path.slice("/contacts/".length));
      const result = await Contacts.deleteContact(contactId);
      return Utils.resultResponse(result, Utils.getErrorStatusFromMessage(result.error || ""));
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
