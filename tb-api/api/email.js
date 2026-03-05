"use strict";

/**
 * Email operations using WebExtension APIs
 * Designed for LLM consumption with flexible inputs and helpful errors
 */

// Cache for mailbox list (for suggestions)
let mailboxCache = null;

/**
 * Search messages with flexible parameter handling
 */
async function searchMessages(params) {
  // Normalize parameters - accept common aliases
  const normalized = Utils.normalizeParams(params, Utils.PARAM_ALIASES);
  const { text, from, to, subject, mailbox, after, before, limit = 50 } = normalized;
  const parsedLimit = parseInt(limit, 10);
  const maxResults = Math.min(Math.max(parsedLimit > 0 ? parsedLimit : 50, 1), 100);

  const queryInfo = {};

  if (text) queryInfo.fullText = text;
  if (from) queryInfo.author = from;
  if (to) queryInfo.recipients = to;
  if (subject) queryInfo.subject = subject;

  // Flexible date parsing
  if (after) {
    const date = Utils.parseDate(after);
    if (date) {
      queryInfo.fromDate = date;
    } else {
      return { 
        error: `Could not parse date: "${after}"`,
        suggestions: [
          'Try formats like: "today", "yesterday", "2024-01-15", "2 days ago", "last week"'
        ]
      };
    }
  }
  if (before) {
    const date = Utils.parseDate(before);
    if (date) {
      queryInfo.toDate = date;
    } else {
      return { 
        error: `Could not parse date: "${before}"`,
        suggestions: [
          'Try formats like: "today", "tomorrow", "2024-01-15", "in 3 days"'
        ]
      };
    }
  }

  // Resolve mailbox with helpful error
  if (mailbox) {
    const resolved = await resolveMailboxWithSuggestions(mailbox);
    if (resolved.error) return resolved;
    queryInfo.folderId = resolved.id;
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
      hints: hints.length > 0 ? hints : ["No messages match your search criteria"]
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
      flags: getFlags(msg),
      mailbox: msg.folder?.name || "",
      has_attachment: msg.attachments?.length > 0 || false,
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
 * Get single message by Message-ID with helpful errors
 */
async function getMessage(messageId) {
  // Try to be flexible with message ID format
  let searchId = messageId;
  
  // If it looks like a bare ID without angle brackets, try adding them
  if (!messageId.startsWith("<") && messageId.includes("@")) {
    searchId = `<${messageId}>`;
  }
  
  // Try original first
  let result = await messenger.messages.query({ headerMessageId: messageId });
  
  // If not found and we modified it, try the modified version
  if ((!result.messages || result.messages.length === 0) && searchId !== messageId) {
    result = await messenger.messages.query({ headerMessageId: searchId });
  }
  
  if (!result.messages || result.messages.length === 0) {
    return { 
      error: `Message not found: ${messageId}`,
      suggestions: [
        "Verify the Message-ID is correct (check email headers)",
        "The message may have been deleted or moved",
        "Try searching by subject or sender instead: GET /messages?from=sender@example.com"
      ]
    };
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
    to: cleanAddressList(msg.recipients),
    cc: cleanAddressList(msg.ccList),
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
 * Resolve a message reference to internal Thunderbird ID
 * Accepts either an internal ID (number) or a Message-ID header string
 */
async function resolveMessageRef(ref) {
  // If it's a number or numeric string, use directly
  const asInt = parseInt(ref, 10);
  if (!isNaN(asInt) && String(asInt) === String(ref)) {
    // Verify the message exists
    try {
      await messenger.messages.get(asInt);
      return { id: asInt };
    } catch {
      return { error: `Message not found with ID: ${ref}` };
    }
  }

  // Otherwise, treat as Message-ID header and query
  // Handle angle brackets and URL encoding
  let searchId = ref;
  if (searchId.startsWith("<") && searchId.endsWith(">")) {
    searchId = searchId.slice(1, -1);
  }
  
  const result = await messenger.messages.query({ headerMessageId: searchId });
  if (!result.messages || result.messages.length === 0) {
    // Try with original if we modified it
    if (searchId !== ref) {
      const result2 = await messenger.messages.query({ headerMessageId: ref });
      if (result2.messages && result2.messages.length > 0) {
        return { id: result2.messages[0].id };
      }
    }
    return { error: `Message not found with Message-ID: "${ref}"` };
  }
  return { id: result.messages[0].id };
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
  const normalized = Utils.normalizeParams(params, {
    ...Utils.PARAM_ALIASES,
    in_reply_to: ["inReplyTo", "reply_to", "replyTo"],
    forward_of: ["forwardOf", "forward"]
  });
  let { to, cc, bcc, subject, body, identity, in_reply_to, forward_of } = normalized;

  // Validate: for new messages, 'to' is required; for replies/forwards it's optional
  if (!in_reply_to && !forward_of && !to) {
    return { 
      error: "Recipient (to) is required for new messages",
      suggestions: [
        'Provide a "to" field with an email address',
        'Example: POST /messages {"to": "user@example.com", "subject": "Hello", "body": "Message content"}',
        'For replies, use "in_reply_to" with the message_id',
        'For forwards, use "forward_of" with the message_id'
      ]
    };
  }

  // Find identity - auto-select if not specified
  const identities = await messenger.identities.list();
  let identityId = null;
  let selectedIdentity = null;

  if (identity) {
    // Try to match by email or ID
    const match = identities.find(id =>
      id.email.toLowerCase() === identity.toLowerCase() || 
      id.id === identity ||
      id.name.toLowerCase().includes(identity.toLowerCase())
    );
    if (match) {
      identityId = match.id;
      selectedIdentity = match.email;
    } else {
      // Provide helpful suggestions
      const availableIdentities = identities.map(id => id.email);
      const suggestion = Utils.didYouMean(identity, availableIdentities);
      return {
        error: `Identity not found: "${identity}"`,
        suggestions: [
          suggestion || `Available identities: ${availableIdentities.join(", ")}`,
          "You can omit the identity field to use the default"
        ]
      };
    }
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
        return {
          error: resolved.error,
          suggestions: [
            "Verify the message_id is correct",
            "Use GET /messages to search for the message first",
            "The message may have been deleted"
          ]
        };
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
        return {
          error: resolved.error,
          suggestions: [
            "Verify the message_id is correct",
            "Use GET /messages to search for the message first",
            "The message may have been deleted"
          ]
        };
      }
      
      // For forward, 'to' is required
      if (!to) {
        return {
          error: "Recipient (to) is required for forwarding",
          suggestions: [
            'Provide a "to" field with the email address to forward to',
            'Example: POST /messages {"forward_of": "message_id", "to": "recipient@example.com"}'
          ]
        };
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
    return { 
      error: `Failed to save draft: ${e.message}`,
      suggestions: [
        "Check that the recipient email address is valid",
        in_reply_to ? "Verify the original message still exists" : null,
        forward_of ? "Verify the original message still exists" : null
      ].filter(Boolean)
    };
  }
}

/**
 * Update messages (flags, move) with flexible flag names
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
    return { 
      error: "Message ID(s) required",
      suggestions: [
        'Provide "ids" as an array of message IDs',
        'Example: PATCH /messages {"ids": ["<msg-id@example.com>"], "add_flags": ["read"]}'
      ]
    };
  }

  // Resolve message IDs (could be headerMessageId strings or internal IDs)
  const messageIds = [];
  const notFound = [];
  
  for (const id of ids) {
    if (typeof id === "number") {
      messageIds.push(id);
    } else {
      const result = await messenger.messages.query({ headerMessageId: id });
      if (result.messages && result.messages.length > 0) {
        messageIds.push(result.messages[0].id);
      } else {
        notFound.push(id);
      }
    }
  }

  if (messageIds.length === 0) {
    return { 
      error: "No valid message IDs found",
      not_found: notFound,
      suggestions: [
        "Check that the Message-IDs are correct",
        "Use GET /messages to find valid message IDs"
      ]
    };
  }

  let count = 0;

  // Handle move
  if (move_to) {
    const resolved = await resolveMailboxWithSuggestions(move_to);
    if (resolved.error) return resolved;
    
    for (const msgId of messageIds) {
      try {
        await messenger.messages.move([msgId], resolved.id);
        count++;
      } catch (e) {}
    }
    
    const result = { success: true, message: `Moved ${count} message(s) to ${resolved.name}` };
    if (notFound.length > 0) {
      result.warnings = [`${notFound.length} message(s) not found and skipped`];
    }
    return result;
  }

  // Handle flags - normalize flag names
  const updates = {};
  const validFlags = ["read", "flagged", "junk"];
  const flagAliases = {
    read: ["read", "seen", "opened"],
    flagged: ["flagged", "starred", "important", "flag"],
    junk: ["junk", "spam"]
  };

  function normalizeFlag(flag) {
    const lower = flag.toLowerCase();
    for (const [canonical, aliases] of Object.entries(flagAliases)) {
      if (aliases.includes(lower)) return canonical;
    }
    return null;
  }

  function applyFlags(flags, value) {
    if (!flags) return;
    const flagList = Array.isArray(flags) ? flags : [flags];
    for (const flag of flagList) {
      const normalized = normalizeFlag(flag);
      if (normalized) {
        updates[normalized] = value;
      }
    }
  }

  applyFlags(add_flags, true);
  applyFlags(remove_flags, false);

  if (Object.keys(updates).length === 0 && !move_to) {
    return {
      error: "No valid action specified",
      suggestions: [
        'Use "add_flags" to add flags: ["read", "flagged", "junk"]',
        'Use "remove_flags" to remove flags',
        'Use "move_to" to move messages to another folder',
        'Flag aliases: "starred"="flagged", "seen"="read", "spam"="junk"'
      ]
    };
  }

  for (const msgId of messageIds) {
    try {
      await messenger.messages.update(msgId, updates);
      count++;
    } catch (e) {}
  }

  const result = { success: true, message: `Updated ${count} message(s)` };
  if (notFound.length > 0) {
    result.warnings = [`${notFound.length} message(s) not found and skipped`];
  }
  return result;
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
 * Resolve mailbox with helpful suggestions on failure
 */
async function resolveMailboxWithSuggestions(mailbox) {
  const normalized = mailbox.toLowerCase().trim();
  const validRoles = ["archives", "drafts", "inbox", "junk", "outbox", "sent", "templates", "trash"];

  // Try as role (case-insensitive)
  const roleMatch = Utils.fuzzyMatch(normalized, validRoles);
  if (roleMatch) {
    const byRole = await messenger.folders.query({ specialUse: [roleMatch] });
    if (byRole.length > 0) return { id: byRole[0].id, name: byRole[0].name };
  }

  // Get all folders for matching
  const accounts = await messenger.accounts.list();
  const allFolders = [];
  for (const account of accounts) {
    const folders = await messenger.folders.query({ accountId: account.id });
    allFolders.push(...folders);
  }
  
  const folderNames = allFolders.map(f => f.name);

  // Try exact name match (case-insensitive)
  const exactMatch = allFolders.find(f => f.name.toLowerCase() === normalized);
  if (exactMatch) return { id: exactMatch.id, name: exactMatch.name };

  // Try fuzzy match on name
  const fuzzyName = Utils.fuzzyMatch(mailbox, folderNames);
  if (fuzzyName) {
    const fuzzyFolder = allFolders.find(f => f.name === fuzzyName);
    if (fuzzyFolder) return { id: fuzzyFolder.id, name: fuzzyFolder.name };
  }

  // Try as ID
  try {
    const folder = await messenger.folders.get(mailbox);
    if (folder) return { id: mailbox, name: folder.name };
  } catch (e) {}

  // Not found - provide helpful suggestions
  const suggestion = Utils.didYouMean(mailbox, [...validRoles, ...folderNames]);
  return {
    error: `Mailbox not found: "${mailbox}"`,
    suggestions: [
      suggestion,
      `Valid roles: ${validRoles.join(", ")}`,
      `Use GET /mailboxes to see all available folders`
    ].filter(Boolean)
  };
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
