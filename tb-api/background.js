"use strict";

const PORT = 9595;

/**
 * Handle HTTP request from experiment
 */
async function handleRequest(request) {
  const { method, path, queryString, body } = request;

  console.log(`[tb-api] ${method} ${path}`);

  try {
    const params = Utils.parseRequestParams(queryString, body);
    // Root endpoint - LLM-friendly API description
    if (path === "/" && method === "GET") {
      return Utils.jsonResponse({
        name: "Thunderbird REST API",
        version: browser.runtime.getManifest().version,
        description: "REST API for Thunderbird email, calendar, and contacts. Designed for AI/LLM consumption with flexible inputs and helpful error messages.",
        tips: [
          `Dates accept: ${Utils.DATE_SUGGESTIONS.join(", ")}`,
          "Parameters have aliases: 'q'/'query'/'search', 'folder'/'mailbox', etc.",
          "Errors include 'suggestions' array with actionable fixes",
          "Calendar/addressbook can be specified by name (fuzzy matched) or ID"
        ],
        endpoints: {
          email: {
            "GET /messages": "Search messages. Params: text/q, from, to, subject, mailbox/folder, after/since, before/until, read/seen/opened, unread/unseen, limit, refresh (default false; requires mailbox), timeoutMs (default 30000, max 60000). Messages include boolean read status",
            "GET /messages/:id": "Get message by Message-ID (with or without angle brackets). Includes boolean read status",
            "POST /messages": "Compose/reply/forward (saves as draft). Params: to, subject, body, identity, in_reply_to (reply), forward_of (forward)",
            "PATCH /messages": "Update flags or move. Params: ids[], flags (read/unread/starred/flagged/junk), mailbox (to move)",
            "GET /mailboxes": "List all mail folders",
            "POST /mailboxes/refresh": "Refresh a concrete folder before reading it. Params: mailbox/folder (ID, name, or role; required), timeoutMs (default 30000, max 60000)",
            "GET /identities": "List send-from identities"
          },
          calendar: {
            "GET /calendars": "List all calendars",
            "GET /events": "List events. Params: calendar (optional), start (default: now), end (default: +30 days). Returns organizer/attendees if present.",
            "POST /events": "Create event. Params: title, start, end, calendar, location, description, organizer, attendees, sendInvites (bool: send invitation emails)",
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

    if (path === "/mailboxes/refresh") {
      if (method !== "POST") return Utils.errorResponse("Method not allowed", 405);
      return Utils.resultResponse(await Email.refreshMailbox(params));
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
      return Utils.resultResponse(result);
    }

    if (path.startsWith("/contacts/") && method === "DELETE") {
      const contactId = decodeURIComponent(path.slice("/contacts/".length));
      const result = await Contacts.deleteContact(contactId);
      return Utils.resultResponse(result);
    }

    // Not found
    return Utils.errorResponse("Not found", 404);

  } catch (e) {
    console.error("[tb-api] Error:", e);
    const statusCode = e.statusCode || (e instanceof SyntaxError || e instanceof URIError ? 400 : 500);
    return Utils.errorResponse(e.message, statusCode, null, e.code);
  }
}

// Listen for HTTP requests from experiment. Every request must reach
// sendResponse: a throwing handler (or one whose serialisation fails) still
// gets a 500 body instead of leaving the request unanswered.
const FALLBACK_500_BODY = '{"error":"Internal server error"}';

browser.httpServer.onRequest.addListener(async (request) => {
  let response = null;
  try {
    response = await handleRequest(request);
  } catch (e) {
    console.error("[tb-api] Request handler failed:", e);
  }

  if (!response || typeof response.body !== "string" || !Number.isInteger(response.statusCode)) {
    response = { statusCode: 500, body: FALLBACK_500_BODY };
  }

  browser.httpServer.sendResponse(request.id, response.statusCode, response.body);
});

// Listen for invitation sending requests from experiment
browser.httpServer.onSendInvitation.addListener(async (invitation) => {
  console.log(`[tb-api] Sending calendar invitations for: ${invitation.eventTitle}`);
  
  try {
    // Find an identity to send from (prefer one matching organizer email)
    const identities = await messenger.identities.list();
    let sendIdentity = identities.find(id => id.email === invitation.organizerEmail);
    if (!sendIdentity && identities.length > 0) {
      sendIdentity = identities[0];
      console.log(`[tb-api] Organizer email ${invitation.organizerEmail} not found in identities, using ${sendIdentity.email}`);
    }
    
    if (!sendIdentity) {
      console.error("[tb-api] No email identity available to send invitations");
      return;
    }

    // Create the invitation email body
    const bodyText = `You have been invited to: ${invitation.eventTitle}

Please find the calendar invitation attached.

This invitation was sent via Thunderbird REST API.`;

    // Create compose details
    const composeDetails = {
      identityId: sendIdentity.id,
      to: invitation.recipients,
      subject: invitation.subject,
      body: bodyText,
      type: "new"
    };

    // Create the compose window
    const tab = await messenger.compose.beginNew(composeDetails);
    
    // Add the ICS attachment
    // Create a File-like object from the ICS content
    const icsBlob = new Blob([invitation.icsContent], { type: "text/calendar; method=REQUEST" });
    const icsFile = new File([icsBlob], "invite.ics", { type: "text/calendar" });
    
    await messenger.compose.addAttachment(tab.id, {
      file: icsFile,
      name: "invite.ics"
    });

    // Send the message
    const sendResult = await messenger.compose.sendMessage(tab.id, { mode: "sendNow" });
    
    if (sendResult.mode === "sendNow") {
      console.log(`[tb-api] Invitation emails sent to: ${invitation.recipients.join(", ")}`);
    } else {
      console.log(`[tb-api] Invitation email queued (mode: ${sendResult.mode})`);
    }
  } catch (e) {
    console.error("[tb-api] Failed to send invitation emails:", e);
  }
});

// Start server
browser.httpServer.start(PORT).then(() => {
  console.log(`[tb-api] REST API server listening at http://127.0.0.1:${PORT}`);
}).catch(error => {
  console.error("[tb-api] Failed to start server:", error);
});
