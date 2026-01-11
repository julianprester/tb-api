/* exported email */
"use strict";

import { sanitizeForJson } from "resource://tb-api/mcp_server/utils.sys.mjs";

const MAX_RESULTS = 100;

/**
 * Parse email address list, respecting quoted strings
 * Handles: "Name, With Comma" <email@example.com>, Another <another@example.com>
 */
function parseAddressList(addressString) {
  if (!addressString) return [];
  
  const addresses = [];
  let current = "";
  let inQuotes = false;
  let inAngleBrackets = false;
  
  for (let i = 0; i < addressString.length; i++) {
    const char = addressString[i];
    
    if (char === '"' && addressString[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === '<' && !inQuotes) {
      inAngleBrackets = true;
      current += char;
    } else if (char === '>' && !inQuotes) {
      inAngleBrackets = false;
      current += char;
    } else if (char === ',' && !inQuotes && !inAngleBrackets) {
      const trimmed = current.trim();
      if (trimmed) addresses.push(trimmed);
      current = "";
    } else {
      current += char;
    }
  }
  
  const trimmed = current.trim();
  if (trimmed) addresses.push(trimmed);
  
  return addresses;
}
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
                  to: parseAddressList(msgHdr.mime2DecodedRecipients || msgHdr.recipients),
                  cc: parseAddressList(msgHdr.ccList),
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
