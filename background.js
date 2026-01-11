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
        version: "2.0",
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
