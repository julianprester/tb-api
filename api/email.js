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
  const maxResults = Math.min(parseInt(limit, 10) || 50, 100);

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
 * Compose message (draft or send) with auto-recovery
 */
async function composeMessage(params) {
  // Normalize parameters
  const normalized = Utils.normalizeParams(params, Utils.PARAM_ALIASES);
  let { to, cc, bcc, subject, body, identity, send = false } = normalized;
  
  // Accept send as string "true"/"false" as well
  if (typeof send === "string") {
    send = send.toLowerCase() === "true";
  }

  if (!to) {
    return { 
      error: "Recipient (to) is required",
      suggestions: [
        'Provide a "to" field with an email address',
        'Example: POST /messages {"to": "user@example.com", "subject": "Hello", "body": "Message content"}'
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
          message_id: sendResult.messages[0].headerMessageId,
          from: selectedIdentity
        };
      }
      return { success: true, message: "Message sent", from: selectedIdentity };
    } else {
      await messenger.compose.saveMessage(tab.id, { mode: "draft" });
      await messenger.tabs.remove(tab.id);
      return { 
        success: true, 
        message: "Draft saved",
        from: selectedIdentity,
        hint: 'To send immediately, add "send": true to your request'
      };
    }
  } catch (e) {
    try { await messenger.tabs.remove(tab.id); } catch {}
    return { 
      error: `Failed to ${send ? "send" : "save draft"}: ${e.message}`,
      suggestions: [
        "Check that the recipient email address is valid",
        send ? "Try saving as draft first (omit 'send' or set to false)" : null
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
