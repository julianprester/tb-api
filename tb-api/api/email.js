"use strict";

/**
 * Email operations using WebExtension APIs
 * Designed for LLM consumption with flexible inputs and helpful errors
 */

// Thunderbird's messages.query returns one page per call in database order
// (oldest first) and keeps scanning in the background until the list is
// finished or aborted (Appendix A.1). A search therefore has to read pages
// until the result set is exhausted to find the newest matches, so it does so
// in large pages under a fixed budget.
const SEARCH_PAGE_SIZE = 500;
const SEARCH_BUDGET_MS = 20000;
// Opening every MIME parser of a full 100-message page at once is wasteful;
// the final page's bodies are read in small concurrent batches.
const SEARCH_MIME_CONCURRENCY = 8;
const SEARCH_TIMEOUT_WARNING =
  "Search stopped after 20 s; add after=/before= or a mailbox to narrow it";

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
  if (normalized.mailbox === undefined || normalized.mailbox === null) {
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
 * Timestamp used to order matches. Missing or unparseable dates sort as 0 so a
 * message without a usable date never breaks the binary insert.
 */
function messageTimestamp(msg) {
  const time = msg && msg.date ? new Date(msg.date).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Insert one message into a small sorted window using a binary search.
 *
 * `top` holds at most `limit + 1` messages, ordered newest -> oldest by default
 * or oldest -> newest when `ascending` is set, so memory stays O(limit) however
 * many messages match. The extra slot lets the caller report `matched > limit`
 * without keeping every match.
 */
function insertNewest(top, msg, limit, ascending = false) {
  const time = messageTimestamp(msg);
  let low = 0;
  let high = top.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const pivot = messageTimestamp(top[mid]);
    // Insert after equal timestamps so ties keep Thunderbird's database order.
    if (ascending ? pivot <= time : pivot >= time) low = mid + 1;
    else high = mid;
  }
  top.splice(low, 0, msg);
  if (top.length > limit + 1) top.length = limit + 1;
}

/**
 * Race a Thunderbird call against an absolute deadline.
 *
 * Resolves to `null` when the deadline passes first. Underlying rejections are
 * propagated so a failed page is not mistaken for a slow one. The timer is
 * always cleared, including on success, so no work is left scheduled.
 */
function withDeadline(promise, deadline) {
  const remaining = deadline - Date.now();
  if (!(remaining > 0)) {
    // The call was already started; consume a late rejection so it never
    // becomes an unhandled rejection.
    Promise.resolve(promise).catch(() => {});
    return Promise.resolve(null);
  }
  // The background test harness can run without a timer global; there is then
  // nothing to race and the promise's own settlement is the only outcome.
  if (typeof setTimeout !== "function") return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), remaining);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Read every page of a message query, keeping only the `limit` newest (or
 * oldest) matches.
 *
 * Thunderbird scans in database order (oldest first) and keeps working in the
 * background after returning a page, so this walks `continueList` until the
 * list is exhausted or the budget expires, then aborts the list. Aborting also
 * stops Thunderbird from parsing message bodies for a full-text `q` search.
 *
 * Returns `{ messages, matched, complete }`; `complete` means the whole result
 * set was scanned and `matched` is the exact number of matches.
 */
async function collectNewest(queryInfo, limit, ascending = false) {
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const top = [];
  let matched = 0;
  let complete = false;
  let listId = null;
  try {
    let page = await withDeadline(
      messenger.messages.query({
        ...queryInfo,
        messagesPerPage: SEARCH_PAGE_SIZE,
        autoPaginationTimeout: 0
      }),
      deadline
    );
    while (page) {
      listId = page.id || null;
      for (const msg of page.messages || []) {
        matched++;
        insertNewest(top, msg, limit, ascending);
      }
      if (!listId) {
        complete = true;
        break;
      }
      page = await withDeadline(messenger.messages.continueList(listId), deadline);
    }
  } finally {
    // Every early exit (budget, exception, cancellation) must stop the
    // background scan. abortList can reject when the list is already gone;
    // that must not mask the real result or error.
    if (!complete && listId) {
      try {
        await messenger.messages.abortList(listId);
      } catch (e) {}
    }
  }
  return { messages: top, matched, complete };
}

/**
 * Ask the experiment for Replied/Forwarded state of one page of messages.
 *
 * MessageHeader does not expose those flags, but the experiment can read
 * Thunderbird's own message manager through `getMessageFlags`. Returns null
 * when that path is unavailable or fails, so the caller omits `answered` and
 * `forwarded` rather than claiming a false value.
 */
async function loadHeaderFlags(ids) {
  if (ids.length === 0) return null;
  try {
    const result = await browser.httpServer.getMessageFlags(ids);
    return result && typeof result === "object" ? result : null;
  } catch (e) {
    return null;
  }
}

/**
 * Merge one experiment flag result into a formatted message. An unknown flag
 * stays absent; only a boolean is reported, and a true bit joins `flags`.
 */
function applyHeaderFlags(message, derived) {
  if (!derived) return;
  if (typeof derived.answered === "boolean") {
    message.answered = derived.answered;
    if (derived.answered) message.flags.push("answered");
  }
  if (typeof derived.forwarded === "boolean") {
    message.forwarded = derived.forwarded;
    if (derived.forwarded) message.flags.push("forwarded");
  }
}

/**
 * Search messages with flexible parameter handling
 */
async function searchMessages(params) {
  // Normalize parameters - accept common aliases
  const normalized = Utils.normalizeParams(params, Utils.ALIASES.emailSearch);
  const { text, from, to, subject, mailbox, after, before, limit = 50, sort = "date_desc" } = normalized;
  const parsedLimit = parseInt(limit, 10);
  const maxResults = Math.min(Math.max(parsedLimit > 0 ? parsedLimit : 50, 1), 100);

  // Ordering is explicit instead of accidental: an unknown value must not
  // silently fall back to a different order than the caller asked for.
  if (sort !== "date_desc" && sort !== "date_asc") {
    return Utils.fail("invalid_parameter", `Unknown sort: "${sort}"`, 400, [
      "Use sort=date_desc (newest first) or sort=date_asc (oldest first)"
    ]);
  }

  // Resolve flag filters using the same aliases as PATCH /messages
  // "unread"/"unseen" -> unread=true, "read"/"seen"/"opened" -> unread=false
  // "flagged"/"starred"/"important" -> flagged=true/false
  // "junk"/"spam" -> junk=true/false
  function parseBool(val) {
    if (val === true || val === 1 || val === "true" || val === "1") return true;
    if (val === false || val === 0 || val === "false" || val === "0") return false;
    return undefined;
  }
  // include_preview defaults to true so the response shape is unchanged unless
  // a caller explicitly opts out of reading message bodies.
  const includePreview = normalized.include_preview === undefined
    ? true
    : parseBool(normalized.include_preview);
  if (includePreview === undefined) {
    return Utils.fail("invalid_filter", "include_preview must be true, false, 1 or 0", 400, [
      "Use include_preview=true or include_preview=false"
    ]);
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
  // A supplied boolean filter must be parseable. Silently dropping it would
  // widen the search and return messages the caller asked to exclude.
  const flagFilters = {};
  for (const name of ["unread", "read", "flagged", "junk"]) {
    if (normalized[name] === undefined) continue;
    const value = parseBool(normalized[name]);
    if (value === undefined) {
      return Utils.fail("invalid_filter", `${name} must be true, false, 1 or 0`, 400, [
        `Use ${name}=true or ${name}=false`
      ]);
    }
    flagFilters[name] = value;
  }
  // read and unread describe the same flag (read=true means unread=false), so
  // a contradictory pair must fail instead of letting the last one win.
  if (flagFilters.read !== undefined) {
    if (flagFilters.unread !== undefined && flagFilters.read === flagFilters.unread) {
      return Utils.fail("invalid_filter", "read and unread filters contradict each other", 400, [
        "read=true means unread=false; use only one of read or unread"
      ]);
    }
    flagFilters.unread = !flagFilters.read;
    delete flagFilters.read;
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
  // A supplied-but-empty mailbox is not "no mailbox": resolving it reports
  // invalid_mailbox instead of silently widening the search (M13).
  if (mailbox !== undefined && mailbox !== null) {
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
    if (refreshResult.error) {
      return {
        ...refreshResult,
        ...(resolvedMailbox ? { resolved_mailbox: resolvedMailbox } : {})
      };
    }
  }

  // Metadata that every response branch must preserve (Task 3.3): which folder
  // was searched and, when requested, the refresh outcome.
  const meta = {
    ...(resolvedMailbox ? { resolved_mailbox: resolvedMailbox } : {}),
    ...(refreshResult ? { refresh: refreshResult } : {})
  };

  // Read every page under the budget and keep only the newest (or oldest)
  // `maxResults` matches in memory. A page failure propagates after the
  // collector has aborted Thunderbird's background scan.
  const collected = await collectNewest(queryInfo, maxResults, sort === "date_asc");

  // The budget expired before any page arrived: an empty list would look like
  // "no matches" and hide the timeout.
  if (!collected.complete && collected.matched === 0) {
    return {
      ...Utils.fail(
        "search_timeout",
        `Search did not return a page within ${SEARCH_BUDGET_MS / 1000} s`,
        504,
        [SEARCH_TIMEOUT_WARNING]
      ),
      ...meta
    };
  }

  const matches = collected.messages.slice(0, maxResults);

  // Format messages. This runs only on the final page, not on every match, so
  // an abandoned scan does not open MIME parsers for messages it will not
  // return. The MIME calls are batched so a full page never opens every parser
  // at once.
  const formatted = [];
  for (let start = 0; start < matches.length; start += SEARCH_MIME_CONCURRENCY) {
    formatted.push(...await Promise.all(
      matches.slice(start, start + SEARCH_MIME_CONCURRENCY).map(async (msg) => {
        let preview = "";
        // null means unknown: the key is omitted when the MIME call fails,
        // exactly like answered/forwarded. Only a successful
        // listAttachments call may report true or false (M9).
        let hasAttachment = null;
        if (includePreview) {
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
          // Whether a message has attachments also lives in the MIME tree,
          // so it is discovered in the same task (and concurrency slot) as
          // the preview instead of a second pass over the page.
          try {
            const attachments = await messenger.messages.listAttachments(msg.id);
            hasAttachment = Array.isArray(attachments) && attachments.length > 0;
          } catch (e) {}
        }

        // MessageHeader has no draft field (Appendix A.2); the folder's
        // special use is the honest source.
        const draft = isDraftFolder(msg.folder);
        return {
          id: msg.id,
          message_id: msg.headerMessageId,
          date: msg.date ? new Date(msg.date).toISOString() : null,
          from: msg.author,
          to: cleanAddressList(msg.recipients),
          subject: msg.subject,
          read: !!msg.read,
          draft,
          flags: getFlags(msg, draft),
          mailbox: msg.folder?.name || "",
          // Omitting both keys (rather than returning empty values) is the
          // contract of include_preview=false: no body was read, so the
          // response claims nothing about preview or attachments. With
          // include_preview=true, has_attachment is omitted only when its
          // MIME call failed, because then the value is unknown.
          ...(includePreview
            ? { ...(hasAttachment === null ? {} : { has_attachment: hasAttachment }), preview }
            : {})
        };
      })
    ));
  }

  // If no results but we have filters, provide helpful feedback
  if (formatted.length === 0) {
    const hints = [];
    if (text) hints.push(`No messages contain "${text}"`);
    if (from) hints.push(`No messages from "${from}"`);
    if (mailbox) hints.push(`Try searching in a different mailbox`);
    if (after || before) hints.push(`Try adjusting the date range`);

    return {
      messages: [],
      total: 0,
      matched: collected.matched,
      complete: collected.complete,
      has_more: false,
      hints: hints.length > 0 ? hints : ["No messages match your search criteria"],
      ...meta
    };
  }

  // Replied/Forwarded live only on Thunderbird's message manager, and one
  // experiment call covers the whole page. When that path is unavailable the
  // keys stay absent: an unknown flag must never be reported as false.
  const headerFlags = await loadHeaderFlags(matches.map(msg => String(msg.id)));
  if (headerFlags) {
    for (const message of formatted) {
      applyHeaderFlags(message, headerFlags[String(message.id)]);
    }
  }

  return {
    messages: formatted,
    total: formatted.length,
    // `matched` is only exact once the whole result set was scanned; while
    // incomplete, `has_more` says "there may be more" instead of guessing.
    ...(collected.complete ? { matched: collected.matched } : {}),
    complete: collected.complete,
    has_more: collected.complete ? collected.matched > maxResults : true,
    ...(collected.complete ? {} : { warnings: [SEARCH_TIMEOUT_WARNING] }),
    ...meta
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
  const draft = isDraftFolder(msg.folder);

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

  const message = {
    id: msg.id,
    message_id: msg.headerMessageId,
    date: msg.date ? new Date(msg.date).toISOString() : null,
    from: msg.author,
    to: cleanAddressList(msg.recipients),
    cc: cleanAddressList(msg.ccList),
    subject: msg.subject,
    read: !!msg.read,
    draft,
    flags: getFlags(msg, draft),
    mailbox: msg.folder?.name || "",
    matches: resolved.matches,
    body,
    attachments: attachments.map(a => {
      const attachment = {
        name: a.name,
        size: a.size,
        contentType: a.contentType,
        partName: a.partName
      };
      if (a.contentId) attachment.content_id = a.contentId;
      // contentDisposition is absent on Thunderbird 128; an unknown value must
      // stay absent instead of being reported as "not inline".
      if (typeof a.contentDisposition === "string") {
        attachment.inline = a.contentDisposition === "inline";
      }
      if (typeof a.partName === "string") {
        attachment.download_url = `/messages/${msg.id}/attachments/${encodeURIComponent(a.partName)}`;
      }
      return attachment;
    }),
    in_reply_to: full.headers?.["in-reply-to"]?.[0] || null,
    references: full.headers?.["references"]?.[0]?.split(/\s+/) || []
  };

  // Replied/Forwarded live on Thunderbird's message manager, same as the
  // search path. When it is unavailable the keys stay absent rather than
  // being reported as false.
  const headerFlags = await loadHeaderFlags([String(msg.id)]);
  if (headerFlags) {
    applyHeaderFlags(message, headerFlags[String(msg.id)]);
  }

  return message;
}

/**
 * Download one attachment by MIME part name, as raw bytes or base64 JSON.
 *
 * `format` is absent for raw bytes or "json" for the envelope. The message
 * reference goes through the same resolver as GET /messages/:id, and the part
 * name is validated before any native call.
 */
async function downloadAttachment(messageRef, partName, { format } = {}) {
  if (format !== undefined && format !== "json") {
    return Utils.fail("invalid_parameter", 'format must be "json" when supplied', 400, [
      "Omit format for raw bytes, or use format=json"
    ]);
  }
  if (!Attachments.isValidPartName(partName)) {
    return Utils.fail("invalid_part_name", `Invalid attachment part name: "${partName}"`, 400, [
      "Use the partName value from GET /messages/:id"
    ]);
  }

  const resolved = await resolveMessageRef(messageRef);
  if (resolved.error) return resolved;

  let message;
  let attachments;
  try {
    message = await messenger.messages.get(resolved.id);
    attachments = await messenger.messages.listAttachments(resolved.id);
  } catch (e) {
    return Utils.fail("attachment_failed", `Could not read attachments: ${e.message}`, 500, [
      "Verify the message still exists and its attachments are available offline"
    ]);
  }

  const attachment = (attachments || []).find(candidate =>
    candidate && candidate.partName === partName
  );
  if (!attachment) {
    return Utils.fail("attachment_not_found", `Attachment not found: "${partName}"`, 404, [
      "Use GET /messages/:id to list attachment part names"
    ]);
  }

  let bytes;
  try {
    const file = await messenger.messages.getAttachmentFile(resolved.id, partName);
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    return Utils.fail("attachment_failed", `Failed to read attachment: ${e.message}`, 500, [
      "The attachment may not be downloaded for offline use",
      "Try again after Thunderbird finishes synchronizing the message"
    ]);
  }

  const contentType = Attachments.safeContentType(attachment.contentType);
  if (format === "json") {
    return {
      message_id: message.headerMessageId || null,
      partName,
      name: attachment.name || partName,
      content_type: contentType,
      size: bytes.length,
      data_base64: Attachments.encodeBase64(bytes)
    };
  }

  return Utils.binaryResponse(Attachments.encodeBase64(bytes), {
    "Content-Type": contentType,
    "Content-Length": String(bytes.length),
    "Content-Disposition": Attachments.contentDisposition(attachment.name || partName),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  });
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
 * Read the first present field from an attachment object. `Object.hasOwn`
 * keeps an explicit empty string distinct from a missing field.
 */
function attachmentField(item, names) {
  for (const name of names) {
    if (Object.hasOwn(item, name)) return item[name];
  }
  return undefined;
}

/**
 * Parse the `attachments` request field into File objects for compose.
 * Everything is validated before a compose window opens, and the decoded
 * sizes are checked against the per-file and total limits.
 */
function parseAttachments(value) {
  if (value === undefined || value === null) return { attachments: [] };
  if (!Array.isArray(value)) {
    return { error: Utils.fail("invalid_attachment", "attachments must be an array", 400, [
      'Provide attachments as [{"name": "file.txt", "data_base64": "..."}]'
    ]) };
  }
  if (value.length > Attachments.MAX_ATTACHMENTS) {
    return { error: Utils.fail(
      "too_many_attachments",
      `At most ${Attachments.MAX_ATTACHMENTS} attachments are allowed`,
      400,
      ["Send fewer files in one draft"]
    ) };
  }

  const attachments = [];
  const sizes = [];
  let totalBytes = 0;
  const maxEncodedLength = Math.ceil(Attachments.MAX_ATTACHMENT_BYTES * 4 / 3) + 4;
  const totalLimit = Math.round(Attachments.MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024));

  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: Utils.fail("invalid_attachment", "Each attachment must be an object", 400, [
        'Provide each attachment as {"name": "file.txt", "data_base64": "..."}'
      ]) };
    }

    const name = attachmentField(item, ["name", "filename", "fileName"]);
    const nameError = Attachments.validateName(name);
    if (nameError) {
      return { error: Utils.fail("invalid_attachment", nameError, 400, [
        'Use a plain filename such as "report.pdf"'
      ]) };
    }

    const contentTypeValue = attachmentField(item, ["content_type", "contentType", "mime_type", "mimeType"]);
    if (contentTypeValue !== undefined) {
      const contentTypeError = Attachments.validateContentType(contentTypeValue);
      if (contentTypeError) {
        return { error: Utils.fail("invalid_attachment", contentTypeError, 400, [
          "Use a single MIME type such as application/pdf"
        ]) };
      }
    }
    const contentType = Attachments.safeContentType(contentTypeValue);

    const data = attachmentField(item, ["data_base64", "dataBase64", "data", "content", "base64"]);
    if (typeof data !== "string") {
      return { error: Utils.fail(
        "invalid_attachment",
        "Attachment data_base64 must be a base64 string",
        400,
        ['Include "data_base64" with standard base64 content; an empty string is a zero-byte file']
      ) };
    }

    // Reject an obviously oversized payload before allocating the decoded
    // copy. The exact size is checked again after decoding.
    const strippedLength = data.replace(/\s+/g, "").length;
    if (strippedLength > maxEncodedLength) {
      return { error: Utils.fail(
        "attachment_too_large",
        `Attachment exceeds the ${Math.round(Attachments.MAX_ATTACHMENT_BYTES / (1024 * 1024))} MiB limit`,
        413,
        ["Reduce the file size or split it across messages"]
      ) };
    }

    // Stop before decoding a file that would push the running total over the
    // limit. The decoded-size check below is the exact guard.
    const paddingLength = (data.match(/=+$/) || [""])[0].length;
    const approximateBytes = Math.floor(Math.max(0, strippedLength - paddingLength) * 3 / 4);
    if (totalBytes + approximateBytes > Attachments.MAX_TOTAL_ATTACHMENT_BYTES) {
      return { error: Utils.fail(
        "attachment_too_large",
        `Attachments exceed the ${totalLimit} MiB total limit`,
        413,
        ["Reduce the total size or split the files across messages"]
      ) };
    }

    let bytes;
    try {
      bytes = Attachments.decodeBase64(data);
    } catch (e) {
      return { error: Utils.fail("invalid_attachment", "Attachment data is not valid base64", 400, [
        "Use the standard base64 alphabet; whitespace is ignored and padding is optional",
        "The URL-safe - and _ characters are not accepted"
      ]) };
    }

    totalBytes += bytes.length;
    if (totalBytes > Attachments.MAX_TOTAL_ATTACHMENT_BYTES) {
      return { error: Utils.fail(
        "attachment_too_large",
        `Attachments exceed the ${totalLimit} MiB total limit`,
        413,
        ["Reduce the total size or split the files across messages"]
      ) };
    }

    sizes.push(bytes.length);
    attachments.push({
      file: new File([bytes], name, { type: contentType }),
      name,
      contentType,
      size: bytes.length
    });
  }

  const limit = Attachments.limitError(sizes);
  if (limit) {
    return { error: Utils.fail(limit.code, limit.message, limit.statusCode, [
      "The limits are 10 MiB per file and 25 MiB total"
    ]) };
  }

  return { attachments };
}

/**
 * Compose message (draft or send) with auto-recovery
 * Supports new messages, replies (in_reply_to), and forwards (forward_of)
 */
async function composeMessage(params) {
  // Normalize parameters
  const normalized = Utils.normalizeParams(params, Utils.ALIASES.compose);
  let { to, cc, bcc, subject, body, identity, in_reply_to, forward_of, attachments } = normalized;

  // Validate: for new messages, 'to' is required; for replies/forwards it's optional
  if (!in_reply_to && !forward_of && !to) {
    return Utils.fail("invalid_parameter", "Recipient (to) is required for new messages", 400, [
      'Provide a "to" field with an email address',
      'Example: POST /messages {"to": "user@example.com", "subject": "Hello", "body": "Message content"}',
      'For replies, use "in_reply_to" with the message_id',
      'For forwards, use "forward_of" with the message_id'
    ]);
  }

  // Parse attachments before opening a compose window. A validation failure
  // must not leave a stray tab behind.
  const parsed = parseAttachments(attachments);
  if (parsed.error) return parsed.error;

  // Find identity - auto-select if not specified
  const identities = await messenger.identities.list();
  let identityId = null;
  let selectedIdentity = null;

  if (identity !== undefined && identity !== null) {
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
  let attachmentFailure = null;

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

    // Attach files before saving the draft. Any failure here aborts the whole
    // request and closes the tab in the catch below.
    for (const attachment of parsed.attachments) {
      try {
        await messenger.compose.addAttachment(tab.id, {
          file: attachment.file,
          name: attachment.name
        });
      } catch (e) {
        attachmentFailure = e;
        throw e;
      }
    }

    // Always save as draft (sending disabled for safety)
    await messenger.compose.saveMessage(tab.id, { mode: "draft" });
    await messenger.tabs.remove(tab.id);
    return { 
      success: true, 
      message: mode === "reply" ? "Reply draft saved" : mode === "forward" ? "Forward draft saved" : "Draft saved",
      from: selectedIdentity,
      ...(parsed.attachments.length > 0
        ? { attachments: parsed.attachments.map(({ name, contentType, size }) => ({ name, content_type: contentType, size })) }
        : {}),
      note: "Message saved as draft. Open Thunderbird to review and send."
    };
  } catch (e) {
    if (tab) {
      try { await messenger.tabs.remove(tab.id); } catch {}
    }
    if (attachmentFailure) {
      return Utils.fail("attachment_failed", `Failed to attach file: ${attachmentFailure.message}`, 500, [
        "Check that the attachment content and name are valid",
        "No draft was saved"
      ]);
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
  // "" is an explicit move target, not an absent one: resolving it reports
  // invalid_mailbox instead of silently applying only the flags (M13).
  if (move_to !== undefined && move_to !== null) {
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

/**
 * True when a folder is a drafts or templates mailbox.
 *
 * `MessageHeader` has no draft field (Appendix A.2), so `draft` is derived
 * from the folder's special use, which is part of the same header.
 */
function isDraftFolder(folder) {
  const specialUse = folder && folder.specialUse;
  return Array.isArray(specialUse) &&
    (specialUse.includes("drafts") || specialUse.includes("templates"));
}

/**
 * Build the legacy `flags` array. `draft` is passed in because it is derived
 * from the folder rather than carried by MessageHeader. The search path
 * appends `answered`/`forwarded` after this returns, once the experiment has
 * reported them.
 */
function getFlags(msg, draft = false) {
  const flags = [];
  if (msg.read) flags.push("read");
  if (msg.flagged) flags.push("flagged");
  if (msg.junk) flags.push("junk");
  if (draft) flags.push("draft");
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
  downloadAttachment,
  composeMessage,
  updateMessages,
  listMailboxes,
  listIdentities
};
