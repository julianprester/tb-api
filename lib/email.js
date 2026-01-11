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
  const identities = await messenger.identities.list();
  let identityId = null;

  if (identity) {
    const match = identities.find(id =>
      id.email.toLowerCase() === identity.toLowerCase() || id.id === identity
    );
    if (match) identityId = match.id;
  }
  if (!identityId && identities.length > 0) {
    identityId = identities[0].id;
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
  const validFlags = ["read", "flagged", "junk"];

  function applyFlags(flags, value) {
    if (!flags) return;
    for (const flag of flags) {
      const lower = flag.toLowerCase();
      if (validFlags.includes(lower)) {
        updates[lower] = value;
      }
    }
  }

  applyFlags(add_flags, true);
  applyFlags(remove_flags, false);

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
