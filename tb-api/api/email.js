"use strict";

/**
 * Email operations using WebExtension APIs
 * Designed for LLM consumption with flexible inputs and helpful errors
 */

// Cache for mailbox list (for suggestions)
let mailboxCache = null;

function parseRefreshTimeout(value = 30000) {
  const timeoutMs = typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value.trim()) : value;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    return Utils.fail(
      "invalid_timeout",
      "timeoutMs must be an integer between 1 and 60000",
      400,
      ["Use timeoutMs=30000 (milliseconds); the maximum is 60000"]
    );
  }
  return { timeoutMs };
}

/**
 * Reusable refresh primitive. The caller must resolve the search target once
 * and pass its exact folder ID, rather than resolving the mailbox again here.
 */
async function refresh_folder(folderId, { timeoutMs } = {}) {
  if (typeof folderId !== "string" || !folderId.trim()) {
    return Utils.fail("invalid_folder", "A folder ID is required", 400);
  }
  const timeout = parseRefreshTimeout(timeoutMs);
  if (timeout.error) return timeout;

  try {
    return await browser.httpServer.refreshFolder(folderId, timeout.timeoutMs);
  } catch (e) {
    return Utils.fail("refresh_failed", `Could not refresh folder: ${e.message}`, 500);
  }
}

/**
 * Explicit refresh endpoint, accepting the same mailbox aliases as search.
 */
async function refreshMailbox(params) {
  const normalized = Utils.normalizeParams(params, Utils.ALIASES.emailSearch);
  if (!normalized.mailbox) {
    return Utils.fail(
      "missing_mailbox",
      "mailbox is required for folder refresh",
      400,
      ["Specify a folder ID, name, or role, e.g. mailbox=sent", "Use GET /mailboxes to find folder IDs"]
    );
  }
  const resolved = await resolveMailboxWithSuggestions(normalized.mailbox);
  if (resolved.error) return resolved;
  const result = await refresh_folder(resolved.id, { timeoutMs: normalized.timeoutMs });
  if (result.error) return result;
  // Read-mode resolution may have picked a fuzzy target; report what was used
  // so a typo cannot silently refresh an unexpected folder.
  return { ...result, resolved_mailbox: resolved };
}

/**
 * Search messages with flexible parameter handling
 */
async function searchMessages(params) {
  // Normalize parameters - accept common aliases
  const normalized = Utils.normalizeParams(params, Utils.ALIASES.emailSearch);
  const { text, from, to, subject, mailbox, after, before, limit = 50 } = normalized;
  const parsedLimit = parseInt(limit, 10);
  const maxResults = Math.min(Math.max(parsedLimit > 0 ? parsedLimit : 50, 1), 100);

  // Resolve flag filters using the same aliases as PATCH /messages
  // "unread"/"unseen" -> unread=true, "read"/"seen"/"opened" -> unread=false
  // "flagged"/"starred"/"important" -> flagged=true/false
  // "junk"/"spam" -> junk=true/false
  function parseBool(val) {
    if (val === true || val === 1 || val === "true" || val === "1") return true;
    if (val === false || val === 0 || val === "false" || val === "0") return false;
    return undefined;
  }
  const refreshRequested = normalized.refresh === undefined ? false : parseBool(normalized.refresh);
  if (refreshRequested === undefined) {
    return Utils.fail("invalid_refresh", "refresh must be true, false, 1, or 0", 400);
  }
  if (refreshRequested && !mailbox) {
    return Utils.fail(
      "missing_mailbox",
      "mailbox is required when refresh=true",
      400,
      ["Specify the folder to refresh and search, e.g. mailbox=inbox&refresh=true"]
    );
  }
  const flagFilters = {};
  if (normalized.unread !== undefined) {
    const v = parseBool(normalized.unread);
    if (v !== undefined) flagFilters.unread = v;
  }
  if (normalized.read !== undefined) {
    const v = parseBool(normalized.read);
    if (v !== undefined) flagFilters.unread = !v;
  }
  if (normalized.flagged !== undefined) {
    const v = parseBool(normalized.flagged);
    if (v !== undefined) flagFilters.flagged = v;
  }
  if (normalized.junk !== undefined) {
    const v = parseBool(normalized.junk);
    if (v !== undefined) flagFilters.junk = v;
  }

  const queryInfo = {};

  if (text) queryInfo.fullText = text;
  if (from) queryInfo.author = from;
  if (to) queryInfo.recipients = to;
  if (subject) queryInfo.subject = subject;
  if (flagFilters.unread !== undefined) queryInfo.unread = flagFilters.unread;
  if (flagFilters.flagged !== undefined) queryInfo.flagged = flagFilters.flagged;
  if (flagFilters.junk !== undefined) queryInfo.junk = flagFilters.junk;

  // Flexible date parsing
  if (after) {
    const date = Utils.parseDate(after);
    if (date) {
      queryInfo.fromDate = date;
    } else {
      return Utils.fail("invalid_date", `Could not parse date: "${after}"`, 400, Utils.DATE_SUGGESTIONS);
    }
  }
  if (before) {
    const date = Utils.parseDate(before);
    if (date) {
      queryInfo.toDate = date;
    } else {
      return Utils.fail("invalid_date", `Could not parse date: "${before}"`, 400, Utils.DATE_SUGGESTIONS);
    }
  }

  // Resolve mailbox with helpful error. Read mode keeps fuzzy matching but
  // reports the chosen folder as `resolved_mailbox` in the response.
  let resolvedMailbox = null;
  if (mailbox) {
    const resolved = await resolveMailboxWithSuggestions(mailbox);
    if (resolved.error) return resolved;
    resolvedMailbox = resolved;
    queryInfo.folderId = resolved.id;
  }

  // Refresh the very same folder that the query will search, and never silently
  // fall back to potentially stale results when a requested refresh fails.
  let refreshResult;
  if (refreshRequested) {
    refreshResult = await refresh_folder(queryInfo.folderId, { timeoutMs: normalized.timeoutMs });
    if (refreshResult.error) return refreshResult;
  }

  const result = await messenger.messages.query(queryInfo);
  let messages = result.messages || [];

  // If no results but we have filters, provide helpful feedback
  if (messages.length === 0) {
    const hints = [];
    if (text) hints.push(`No messages contain "${text}"`);
    if (from) hints.push(`No messages from "${from}"`);
    if (mailbox) hints.push(`Try searching in a different mailbox`);
    if (after || before) hints.push(`Try adjusting the date range`);
    
    return {
      messages: [],
      total: 0,
      has_more: false,
      hints: hints.length > 0 ? hints : ["No messages match your search criteria"],
      ...(resolvedMailbox ? { resolved_mailbox: resolvedMailbox } : {}),
      ...(refreshResult ? { refresh: refreshResult } : {})
    };
  }

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
          preview = plainPart.content.substring(0, 500);
        } else {
          // Fall back to HTML part if no plain text available
          const htmlPart = parts.find(p => p.contentType === "text/html");
          if (htmlPart && htmlPart.content) {
            const plainText = await messenger.messengerUtilities.convertToPlainText(htmlPart.content);
            preview = plainText.substring(0, 500);
          }
        }
      }
    } catch (e) {}

    return {
      id: msg.id,
      message_id: msg.headerMessageId,
      date: msg.date ? new Date(msg.date).toISOString() : null,
      from: msg.author,
      to: cleanAddressList(msg.recipients),
      subject: msg.subject,
      read: !!msg.read,
      flags: getFlags(msg),
      mailbox: msg.folder?.name || "",
      has_attachment: msg.attachments?.length > 0 || false,
      preview
    };
  }));

  return {
    messages: formatted,
    total: formatted.length,
    has_more: hasMore,
    ...(resolvedMailbox ? { resolved_mailbox: resolvedMailbox } : {}),
    ...(refreshResult ? { refresh: refreshResult } : {})
  };
}

/**
 * Get single message by Message-ID with helpful errors
 */
async function getMessage(messageId) {
  const resolved = await resolveMessageRef(messageId);
  if (resolved.error) {
    return Utils.fail(
      resolved.code || "not_found",
      resolved.error,
      resolved.statusCode || 404,
      [
        "Verify the Message-ID is correct (check email headers)",
        "The message may have been deleted or moved",
        "Try searching by subject or sender instead: GET /messages?from=sender@example.com"
      ]
    );
  }

  const msg = await messenger.messages.get(resolved.id);
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
    to: cleanAddressList(msg.recipients),
    cc: cleanAddressList(msg.ccList),
    subject: msg.subject,
    read: !!msg.read,
    flags: getFlags(msg),
    mailbox: msg.folder?.name || "",
    matches: resolved.matches,
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
 * Normalize a Message-ID reference to the form Thunderbird stores.
 * Thunderbird strips angle brackets and compares Message-IDs exactly
 * (plan Appendix A.1), so ` <id@example.com> ` and `id@example.com` both
 * become `id@example.com`.
 */
function normalizeMessageId(ref) {
  let id = String(ref).trim();
  if (id.startsWith("<") && id.endsWith(">")) id = id.slice(1, -1).trim();
  return id;
}

/**
 * Resolve a message reference to internal Thunderbird ID.
 * Accepts an internal ID (number or numeric string) or a Message-ID header
 * string with or without angle brackets. Returns { id, matches } on success
 * (matches is the number of messages sharing a Message-ID) or a Utils.fail
 * result on failure.
 */
async function resolveMessageRef(ref) {
  const id = normalizeMessageId(ref);

  // Numbers and numeric strings are internal Thunderbird IDs, never
  // Message-IDs: verify them with messages.get() and do not fall back.
  const asInt = parseInt(id, 10);
  if (!isNaN(asInt) && String(asInt) === id) {
    try {
      await messenger.messages.get(asInt);
      return { id: asInt, matches: 1 };
    } catch {
      return Utils.fail("not_found", `Message not found with ID: ${ref}`, 404);
    }
  }

  // Everything else is an exact Message-ID header lookup. Thunderbird stores
  // Message-IDs without angle brackets, so query the normalized value only.
  const result = await messenger.messages.query({ headerMessageId: id });
  if (!result.messages || result.messages.length === 0) {
    return Utils.fail("not_found", `Message not found with Message-ID: "${ref}"`, 404);
  }
  return { id: result.messages[0].id, matches: result.messages.length };
}

/**
 * Prepend user text to compose body (handles both plain text and HTML)
 */
async function prependBodyToCompose(tabId, userText) {
  const currentDetails = await messenger.compose.getComposeDetails(tabId);

  if (currentDetails.isPlainText) {
    // Plain text: simple prepend with separator
    const separator = "\n\n";
    const existingBody = currentDetails.plainTextBody || "";
    await messenger.compose.setComposeDetails(tabId, {
      plainTextBody: userText + separator + existingBody
    });
  } else {
    // HTML: wrap user text in paragraph, prepend to HTML body
    const separator = "<br><br>";
    const existingBody = currentDetails.body || "";
    // Escape HTML in user text to prevent injection
    const escapedText = userText
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");

    // Find body tag and insert after it, or prepend to content
    let newBody;
    const bodyMatch = existingBody.match(/(<body[^>]*>)/i);
    if (bodyMatch) {
      const insertPos = bodyMatch.index + bodyMatch[0].length;
      newBody = existingBody.slice(0, insertPos) +
                "<p>" + escapedText + "</p>" + separator +
                existingBody.slice(insertPos);
    } else {
      newBody = "<p>" + escapedText + "</p>" + separator + existingBody;
    }

    await messenger.compose.setComposeDetails(tabId, {
      body: newBody
    });
  }
}

/**
 * Compose message (draft or send) with auto-recovery
 * Supports new messages, replies (in_reply_to), and forwards (forward_of)
 */
async function composeMessage(params) {
  // Normalize parameters
  const normalized = Utils.normalizeParams(params, Utils.ALIASES.compose);
  let { to, cc, bcc, subject, body, identity, in_reply_to, forward_of } = normalized;

  // Validate: for new messages, 'to' is required; for replies/forwards it's optional
  if (!in_reply_to && !forward_of && !to) {
    return Utils.fail("invalid_parameter", "Recipient (to) is required for new messages", 400, [
      'Provide a "to" field with an email address',
      'Example: POST /messages {"to": "user@example.com", "subject": "Hello", "body": "Message content"}',
      'For replies, use "in_reply_to" with the message_id',
      'For forwards, use "forward_of" with the message_id'
    ]);
  }

  // Find identity - auto-select if not specified
  const identities = await messenger.identities.list();
  let identityId = null;
  let selectedIdentity = null;

  if (identity) {
    // D4: choosing a sender identity is a write. Match the identity ID or the
    // exact email only; the display name is not a write target. The resolver's
    // "identity" kind uses the email as the matchable name.
    const resolved = Utils.resolveTarget("identity", identity, {
      mode: "write",
      candidates: identities.map(id => ({ id: id.id, name: id.email })),
      hints: ["You can omit the identity field to use the default"]
    });
    if (resolved.error) return resolved;
    identityId = resolved.id;
    selectedIdentity = resolved.name;
  }
  
  // Auto-select first identity if none specified
  if (!identityId && identities.length > 0) {
    identityId = identities[0].id;
    selectedIdentity = identities[0].email;
  }

  // Build compose details
  const composeDetails = {};
  if (to) composeDetails.to = Array.isArray(to) ? to : [to];
  if (cc) composeDetails.cc = Array.isArray(cc) ? cc : [cc];
  if (bcc) composeDetails.bcc = Array.isArray(bcc) ? bcc : [bcc];
  if (subject) composeDetails.subject = subject;
  if (identityId) composeDetails.identityId = identityId;

  let tab;
  let mode = "new";

  try {
    if (in_reply_to) {
      // Reply to existing message
      mode = "reply";
      const resolved = await resolveMessageRef(in_reply_to);
      if (resolved.error) {
        return Utils.fail(
          resolved.code || "not_found",
          resolved.error,
          resolved.statusCode || 404,
          [
            "Verify the message_id is correct",
            "Use GET /messages to search for the message first",
            "The message may have been deleted"
          ]
        );
      }
      
      tab = await messenger.compose.beginReply(resolved.id, "replyToAll", composeDetails);
      
      // If user provided body, prepend it to the reply
      if (body) {
        await prependBodyToCompose(tab.id, body);
      }
    } else if (forward_of) {
      // Forward existing message
      mode = "forward";
      const resolved = await resolveMessageRef(forward_of);
      if (resolved.error) {
        return Utils.fail(
          resolved.code || "not_found",
          resolved.error,
          resolved.statusCode || 404,
          [
            "Verify the message_id is correct",
            "Use GET /messages to search for the message first",
            "The message may have been deleted"
          ]
        );
      }
      
      // For forward, 'to' is required
      if (!to) {
        return Utils.fail("invalid_parameter", "Recipient (to) is required for forwarding", 400, [
          'Provide a "to" field with the email address to forward to',
          'Example: POST /messages {"forward_of": "message_id", "to": "recipient@example.com"}'
        ]);
      }
      
      tab = await messenger.compose.beginForward(resolved.id, "forwardInline", composeDetails);
      
      // If user provided body, prepend it to the forward
      if (body) {
        await prependBodyToCompose(tab.id, body);
      }
    } else {
      // New message - set body directly
      mode = "new";
      composeDetails.plainTextBody = body || "";
      composeDetails.isPlainText = true;
      tab = await messenger.compose.beginNew(composeDetails);
    }

    // Always save as draft (sending disabled for safety)
    await messenger.compose.saveMessage(tab.id, { mode: "draft" });
    await messenger.tabs.remove(tab.id);
    return { 
      success: true, 
      message: mode === "reply" ? "Reply draft saved" : mode === "forward" ? "Forward draft saved" : "Draft saved",
      from: selectedIdentity,
      note: "Message saved as draft. Open Thunderbird to review and send."
    };
  } catch (e) {
    if (tab) {
      try { await messenger.tabs.remove(tab.id); } catch {}
    }
    return Utils.fail("compose_failed", `Failed to save draft: ${e.message}`, 500, [
      "Check that the recipient email address is valid",
      in_reply_to ? "Verify the original message still exists" : null,
      forward_of ? "Verify the original message still exists" : null
    ].filter(Boolean));
  }
}

/**
 * Update messages (flags, move) with flexible flag names.
 *
 * Everything is validated before anything is changed: unknown flags and
 * add/remove conflicts are 400, and a move destination must resolve exactly
 * (write mode) before the first update or move.
 *
 * Flags are applied first by stable internal ID, then the move (moving can
 * change folder-relative state). Each message gets its own outcome in
 * `results`, and the status tells the truth: 200 when every resolved message
 * fully succeeded, 207 when some succeeded and some failed (including
 * unresolved refs, which stay in `not_found`), and 502 when no message could
 * be updated or moved.
 */
async function updateMessages(params) {
  // Normalize parameters
  const normalized = Utils.normalizeParams(params, {
    ids: ["id", "messageIds", "message_ids"],
    add_flags: ["addFlags", "add", "flags"],
    remove_flags: ["removeFlags", "remove"],
    move_to: ["moveTo", "destination", "folder", "mailbox"]
  });
  
  let { ids, add_flags, remove_flags, move_to } = normalized;

  // Accept single ID as well as array
  if (ids && !Array.isArray(ids)) {
    ids = [ids];
  }

  if (!ids || ids.length === 0) {
    return Utils.fail("invalid_parameter", "Message ID(s) required", 400, [
      'Provide "ids" as an array of message IDs',
      'Example: PATCH /messages {"ids": ["<msg-id@example.com>"], "add_flags": ["read"]}'
    ]);
  }

  // Normalize flags before touching anything. Unknown flags are listed in the
  // error, never silently dropped. "unread"/"unseen" are inverse aliases:
  // adding them clears `read`, removing them sets `read`.
  const flagAliases = {
    read: ["read", "seen", "opened"],
    flagged: ["flagged", "starred", "important", "flag"],
    junk: ["junk", "spam"]
  };
  const inverseAliases = { unread: "read", unseen: "read" };

  function normalizeFlag(flag) {
    const lower = typeof flag === "string" ? flag.trim().toLowerCase() : "";
    if (inverseAliases[lower]) return { property: inverseAliases[lower], inverse: true };
    for (const [canonical, aliases] of Object.entries(flagAliases)) {
      if (aliases.includes(lower)) return { property: canonical, inverse: false };
    }
    return null;
  }

  const updates = {};
  const unknownFlags = [];
  const conflicts = [];

  function applyFlags(flags, adding) {
    if (flags === undefined || flags === null) return;
    const flagList = Array.isArray(flags) ? flags : [flags];
    for (const flag of flagList) {
      const normalizedFlag = normalizeFlag(flag);
      if (!normalizedFlag) {
        unknownFlags.push(flag);
        continue;
      }
      const value = adding ? !normalizedFlag.inverse : normalizedFlag.inverse;
      if (Object.prototype.hasOwnProperty.call(updates, normalizedFlag.property) &&
          updates[normalizedFlag.property] !== value) {
        conflicts.push(`${normalizedFlag.property} (${adding ? "add" : "remove"} ${JSON.stringify(flag)})`);
        continue;
      }
      updates[normalizedFlag.property] = value;
    }
  }

  applyFlags(add_flags, true);
  applyFlags(remove_flags, false);

  if (unknownFlags.length > 0) {
    return Utils.fail(
      "invalid_parameter",
      `Unknown flag(s): ${unknownFlags.map(flag => JSON.stringify(flag)).join(", ")}`,
      400,
      [
        'Valid flags: "read", "unread", "flagged", "junk"',
        'Aliases: "seen"/"opened"="read", "unseen"="unread", "starred"/"important"/"flag"="flagged", "spam"="junk"'
      ]
    );
  }

  if (conflicts.length > 0) {
    return Utils.fail(
      "invalid_parameter",
      `Conflicting flags: ${conflicts.join(", ")}`,
      400,
      ['Do not add and remove the same flag (or its inverse) in one request']
    );
  }

  // Resolve the destination before any update. Moving mail is a write, so the
  // destination must resolve exactly (ID, role, or case-insensitive name;
  // never fuzzy).
  let destination = null;
  if (move_to) {
    destination = await resolveMailboxWithSuggestions(move_to, "write");
    if (destination.error) return destination;
  }

  if (Object.keys(updates).length === 0 && !destination) {
    return Utils.fail("invalid_parameter", "No valid action specified", 400, [
      'Use "add_flags" to add flags: ["read", "unread", "flagged", "junk"]',
      'Use "remove_flags" to remove flags',
      'Use "move_to" to move messages to another folder',
      'Flag aliases: "unread"/"unseen" (inverse of read), "starred"="flagged", "spam"="junk"'
    ]);
  }

  // Resolve every message reference (Message-ID headers or internal IDs)
  // through the single resolver before changing anything.
  const targets = [];
  const notFound = [];

  for (const id of ids) {
    const resolved = await resolveMessageRef(id);
    if (resolved.error) {
      notFound.push(id);
    } else {
      targets.push({ ref: id, id: resolved.id });
    }
  }

  if (targets.length === 0) {
    return {
      ...Utils.fail("not_found", "No valid message IDs found", 404, [
        "Check that the Message-IDs are correct",
        "Use GET /messages to find valid message IDs"
      ]),
      not_found: notFound
    };
  }

  // Flags first, then the move; each message is independent so one failure
  // does not stop the others and `results` records exactly what happened.
  const flagsRequested = Object.keys(updates).length > 0;
  const results = [];
  let updatedCount = 0;
  let movedCount = 0;

  for (const target of targets) {
    const outcome = { ref: target.ref, id: target.id, updated: false, moved: false };

    if (flagsRequested) {
      try {
        await messenger.messages.update(target.id, updates);
        outcome.updated = true;
        updatedCount++;
      } catch (e) {
        outcome.error = `Failed to update flags: ${e && e.message ? e.message : String(e)}`;
      }
    }

    if (destination) {
      try {
        await messenger.messages.move([target.id], destination.id);
        outcome.moved = true;
        movedCount++;
      } catch (e) {
        const reason = `Failed to move: ${e && e.message ? e.message : String(e)}`;
        outcome.error = outcome.error ? `${outcome.error}; ${reason}` : reason;
      }
    }

    results.push(outcome);
  }

  const body = { updated: updatedCount, moved: movedCount, results };
  if (notFound.length > 0) body.not_found = notFound;

  const failures = results.filter(outcome => outcome.error).length + notFound.length;
  const successes = results.filter(outcome => !outcome.error).length;

  if (failures === 0) {
    return { success: true, ...body };
  }

  if (successes > 0) {
    // Partial success is a real outcome: some messages were changed and some
    // were not. 207 says so without pretending the request fully succeeded.
    return { success: false, partial: true, statusCode: 207, ...body };
  }

  return {
    ...Utils.fail("update_failed", `Failed to update or move ${results.length} message(s)`, 502, [
      "Check that the messages still exist and that the destination folder is available",
      "Use GET /messages to verify the message IDs"
    ]),
    ...body
  };
}

/**
 * List mailboxes (also updates cache for suggestions)
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

  // Update cache for suggestions
  mailboxCache = mailboxes;

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

/**
 * Strip unnecessary quotes from email address display names
 * e.g., '"Julian.prester" <j@example.com>' -> 'Julian.prester <j@example.com>'
 */
function cleanAddress(addr) {
  return addr.replace(/^"([^"]*)"(\s*<)/, "$1$2");
}

function cleanAddressList(addrs) {
  if (!addrs) return [];
  return addrs.map(cleanAddress);
}

function getFlags(msg) {
  const flags = [];
  if (msg.read) flags.push("read");
  if (msg.flagged) flags.push("flagged");
  if (msg.draft) flags.push("draft");
  if (msg.answered) flags.push("answered");
  if (msg.forwarded) flags.push("forwarded");
  return flags;
}

/**
 * Load every folder as a resolver candidate: ID, name, special-use role and
 * account ID. `folders.query({ accountId })` is the same source listMailboxes
 * uses, so names and roles resolve across all accounts.
 */
async function loadMailboxCandidates() {
  const accounts = await messenger.accounts.list();
  const candidates = [];
  for (const account of accounts) {
    const folders = await messenger.folders.query({ accountId: account.id });
    for (const folder of folders) {
      candidates.push({
        id: folder.id,
        name: folder.name,
        role: folder.specialUse?.[0] || null,
        account: account.id
      });
    }
  }
  return candidates;
}

/**
 * Resolve a mailbox reference through the shared resolver.
 *
 * `mode: "read"` keeps the fuzzy chain and picks the first of several exact
 * matches (reported by the caller); `mode: "write"` requires an exact ID,
 * role, or name and answers ambiguous references with 409 ambiguous_target.
 */
async function resolveMailboxWithSuggestions(mailbox, mode = "read") {
  if (typeof mailbox !== "string" || !mailbox.trim()) {
    return Utils.fail("invalid_mailbox", "mailbox must be a non-empty folder ID, name, or role", 400);
  }

  // Exact IDs (which may contain spaces/Unicode) resolve in one folders.get()
  // call, without listing every folder of every account. This is the same
  // precedence the resolver applies first, just cheaper; everything else goes
  // through the shared matcher.
  try {
    const folder = await messenger.folders.get(mailbox);
    if (folder && folder.id === mailbox) {
      return { id: folder.id, name: folder.name, matched_by: "id" };
    }
  } catch (e) {}

  return Utils.resolveTarget("mailbox", mailbox, {
    mode,
    candidates: await loadMailboxCandidates(),
    hints: [
      "Valid roles: archives, drafts, inbox, junk, outbox, sent, templates, trash",
      "Use GET /mailboxes to see all available folders"
    ]
  });
}

// Export
var Email = {
  refresh_folder,
  refreshMailbox,
  searchMessages,
  getMessage,
  composeMessage,
  updateMessages,
  listMailboxes,
  listIdentities
};
