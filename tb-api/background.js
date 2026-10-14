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
          meta: {
            "GET /": "This API description: name, version, tips, and the endpoint list below"
          },
          email: {
            "GET /messages": "Search messages, newest first by default (sort=date_desc; date_asc oldest first). Params: text/q/query/search/keyword, from/sender/author, to/recipient, subject/subj, mailbox/folder (ID, name, or role), after/since (default none), before/until, read/seen/opened, unread/unseen, flagged/starred, junk/spam, limit (default 50, max 100), refresh (default false; requires mailbox), timeoutMs (default 30000, max 60000), include_preview (default true; false omits preview/has_attachment and reads no bodies). Responses include matched/complete/has_more/warnings, resolved_mailbox {id,name,matched_by} when a mailbox was given, boolean read status, and honest draft/answered/forwarded facts when known",
            "GET /messages/:id": "Get message by Message-ID (with or without angle brackets) or internal ID. Response includes matches (copies found), boolean read status, draft, flags, body and attachments",
            "POST /messages": "Compose/reply/forward (saves as draft). Params: to, subject, body, identity, in_reply_to (reply), forward_of (forward)",
            "PATCH /messages": "Update flags and/or move messages. Params: ids[] (Message-IDs with or without angle brackets, or internal IDs), add_flags/remove_flags (read/seen/opened, unread/unseen, flagged/starred, junk/spam; unknown or conflicting flags are 400), move_to/folder (resolved exactly). Response: 200 {updated, moved, results}; 207 partial (includes not_found when some ids did not resolve); 502 update_failed when no message was fully updated (see updated/results)",
            "GET /mailboxes": "List all mail folders",
            "POST /mailboxes/refresh": "Refresh a concrete folder before reading it. Params: mailbox/folder (ID, name, or role; required), timeoutMs (default 30000, max 60000). Response includes resolved_mailbox {id,name,matched_by} (fuzzy names are reported). 504 refresh_timeout on the caller deadline; 504 refresh_stalled when no completion signal arrives within five minutes",
            "GET /identities": "List send-from identities"
          },
          calendar: {
            "GET /calendars": "List all calendars",
            "GET /events": "List events. Params: calendar/calendarId/cal (optional), start (default: now), end (default: +30 days). Returns organizer/attendees if present; occurrences carry recurrenceId and occurrence:true; resolved_calendar {id,name,matched_by} when calendar was given",
            "GET /upcoming": "Events from now until the end of today, earliest first. Param: calendar/calendarId/cal (optional). Response: events, resolved_calendar {id,name,matched_by} when a calendar was given, from, until, hints",
            "POST /events": "Create event (201 Created). Params: title/summary/name, start, end, calendar, location, description, organizer (must be one of your identities), attendees, allDay (strict boolean; date-only start/end), sendInvites (strict boolean alias for inviteMode=draft), inviteMode (draft default, or send with TB_API_ALLOW_SEND=1). Response carries invitations: {status: draft_saved|sent|queued|failed, error?} when invitations were requested",
            "PATCH /events/:id": "Update event. Params: calendar (required), title, start, end, allDay, location, description, organizer, attendees (replaces all), recurrenceId (one occurrence), scope=series (whole series). A recurring event without recurrenceId/scope is 409 ambiguous_recurrence",
            "DELETE /events/:id": "Delete event. Params: calendar (required), recurrenceId (one occurrence), scope=series (whole series). A recurring event without recurrenceId/scope is 409 ambiguous_recurrence"
          },
          contacts: {
            "GET /addressbooks": "List all address books",
            "GET /contacts": "Search contacts. Params: query/q/search (contact search), addressbook/book (optional), limit (default 50, max 100). Resolved address book reported as resolved_addressbook {id,name,matched_by} when addressbook was given",
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

// Listen for invitation sending requests from experiment. The listener
// returns its outcome ({ status: "draft_saved" | "sent" | "queued" |
// "failed", error? }); the experiment awaits it and reports it in the
// POST /events response. The invitation is always a compose-based mail with
// invite.ics attached (native iMIP is deliberately out of scope).
browser.httpServer.onSendInvitation.addListener(async (invitation) => {
  console.log(`[tb-api] Preparing calendar invitation for: ${invitation.eventTitle}`);
  
  try {
    // Find the identity matching the organizer. The experiment validates this
    // already; never fall back to a different account (the old identities[0]
    // fallback silently sent from the wrong address).
    const identities = await messenger.identities.list();
    const organizerEmail = String(invitation.organizerEmail || "").toLowerCase();
    const sendIdentity = identities.find(id =>
      id.email && String(id.email).toLowerCase() === organizerEmail
    );
    if (!sendIdentity) {
      return {
        status: "failed",
        error: `No identity matches organizer ${invitation.organizerEmail}`
      };
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

    // Draft mode (default): save the compose window as a draft and close it,
    // exactly like POST /messages does.
    if (invitation.mode !== "send") {
      await messenger.compose.saveMessage(tab.id, { mode: "draft" });
      await messenger.tabs.remove(tab.id);
      return { status: "draft_saved" };
    }

    // Send mode: send now and map what Thunderbird reports (sent/queued).
    const sendResult = await messenger.compose.sendMessage(tab.id, { mode: "sendNow" });
    const status = sendResult && sendResult.mode === "queued" ? "queued" : "sent";
    console.log(`[tb-api] Invitation email ${status} to: ${invitation.recipients.join(", ")}`);
    return { status };
  } catch (e) {
    console.error("[tb-api] Failed to prepare invitation email:", e);
    return { status: "failed", error: e.message };
  }
});

// Start server
browser.httpServer.start(PORT).then(() => {
  console.log(`[tb-api] REST API server listening at http://127.0.0.1:${PORT}`);
}).catch(error => {
  console.error("[tb-api] Failed to start server:", error);
});
