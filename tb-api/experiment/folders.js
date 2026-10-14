/* global ChromeUtils, Services, Ci, Components, MailServices */
"use strict";

var { setTimeout, clearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

// Use Thunderbird's own resolver, not display names or guessed folder paths.
// Older versions without this resolver can still use the other API endpoints.
var getNativeFolder = null;
try {
  ({ getFolder: getNativeFolder } = ChromeUtils.importESModule(
    "resource:///modules/ExtensionAccounts.sys.mjs"
  ));
} catch (e) {
  console.warn("[tb-api] Native folder-ID resolution is not available:", e);
}

// An update that never reports back must not pin its operation in flight
// forever: every later refresh of that folder would join the dead operation
// and time out. Five minutes is far beyond a normal IMAP update.
const MAX_OPERATION_MS = 5 * 60 * 1000;

// The mail session delivers folder events (Appendix A.3). api.js injects
// MailServices through the shared experiment scope; older Thunderbird versions
// and unit tests may omit it, in which case the per-request nsIUrlListener
// remains the only completion signal.
var mailSession = null;
try {
  if (typeof MailServices !== "undefined" && MailServices) {
    mailSession = MailServices.mailSession || null;
  }
} catch (e) {
  console.warn("[tb-api] Folder events are not available:", e);
}

function refreshError(code, message, statusCode = 400) {
  return { error: message, code, statusCode };
}

/**
 * Refresh a concrete folder. Each caller has its own deadline, but concurrent
 * requests for the same native folder share a single IMAP update.
 */
var FolderRefresher = class {
  constructor() {
    this.inFlight = new Map();
    this.closed = false;
    this.folderListenerRegistered = false;
    // One session-wide listener covers every folder. It is registered lazily
    // because most installations never refresh a folder at all.
    this.folderListener = {
      QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),
      onFolderEvent: (folder, event) => this.handleFolderEvent(folder, event)
    };
  }

  async refreshFolder(folderId, timeoutMs = 30000) {
    if (typeof folderId !== "string" || !folderId.trim()) {
      return refreshError("invalid_folder", "A folder ID is required");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
      return refreshError("invalid_timeout", "timeoutMs must be an integer between 1 and 60000");
    }
    if (this.closed) {
      return refreshError("refresh_cancelled", "Folder refresh is shutting down", 503);
    }
    if (typeof getNativeFolder !== "function") {
      return refreshError("refresh_unavailable", "Folder refresh is not available in this Thunderbird version", 503);
    }

    let details;
    try {
      details = getNativeFolder(folderId);
      if (!details.folder) throw new Error("Folder not found");
    } catch (e) {
      return refreshError("folder_not_found", `Folder not found: "${folderId}"`, 404);
    }

    const { folder, isUnified, isTag } = details;
    if (folder.isServer || isUnified || isTag || (folder.flags & Ci.nsMsgFolderFlags.Virtual)) {
      return refreshError("unsupported_folder", "Refresh requires a concrete message folder, not a root or virtual folder");
    }

    const serverType = folder.server.type;
    if (serverType === "none") {
      return {
        folder_id: folderId,
        mailbox: folder.prettyName,
        refreshed: false,
        skipped: true,
        reason: "local_folder"
      };
    }
    if (serverType !== "imap") {
      return refreshError("unsupported_protocol", `Per-folder refresh is not supported for ${serverType} folders`);
    }
    if (Services.io.offline) {
      return refreshError("thunderbird_offline", "Thunderbird is offline; the folder was not refreshed", 503);
    }

    let imapFolder;
    try {
      imapFolder = folder.QueryInterface(Ci.nsIMsgImapMailFolder);
      if (!imapFolder.canOpenFolder) {
        return refreshError("unsupported_folder", "This IMAP folder cannot be selected for refresh");
      }
    } catch (e) {
      return refreshError("refresh_unavailable", "The IMAP folder refresh interface is not available", 503);
    }

    // From here on a native update may actually be issued, so folder events
    // become relevant. Registration failure is non-fatal.
    this.ensureFolderListener();

    let operation = this.inFlight.get(folder.URI);
    if (!operation) {
      operation = {
        key: folder.URI,
        mailbox: folder.prettyName,
        startedAt: Date.now(),
        waiters: new Set(),
        done: false,
        result: null,
        ceiling: null
      };
      this.inFlight.set(operation.key, operation);

      operation.ceiling = setTimeout(() => {
        this.complete(operation, refreshError(
          "refresh_stalled",
          `Refresh of "${operation.mailbox}" did not report completion within ${MAX_OPERATION_MS / 60000} minutes`,
          504
        ));
      }, MAX_OPERATION_MS);

      const listener = {
        QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
        OnStartRunningUrl() {},
        OnStopRunningUrl: (url, exitCode) => {
          if (Components.isSuccessCode(exitCode)) {
            this.complete(operation, {
              mailbox: operation.mailbox,
              refreshed: true,
              elapsed_ms: Date.now() - operation.startedAt
            });
          } else {
            this.complete(operation, refreshError(
              "refresh_failed",
              `Refresh of "${operation.mailbox}" failed (0x${(exitCode >>> 0).toString(16)})`,
              502
            ));
          }
        }
      };

      try {
        imapFolder.updateFolderWithListener(null, listener);
      } catch (e) {
        this.complete(operation, refreshError(
          "refresh_failed", `Could not refresh "${operation.mailbox}": ${e.message}`, 502
        ));
      }
    }

    const result = await this.waitFor(operation, timeoutMs);
    return { ...result, folder_id: folderId };
  }

  /**
   * Subscribe to session-wide folder events the first time a refresh is about
   * to issue a native update. Missing MailServices, a session that refuses the
   * listener, or an older Thunderbird must all leave refresh working through
   * the per-request nsIUrlListener.
   */
  ensureFolderListener() {
    if (this.folderListenerRegistered || this.closed || !mailSession) return;
    try {
      mailSession.AddFolderListener(this.folderListener, Ci.nsIFolderListener.event);
      this.folderListenerRegistered = true;
    } catch (e) {
      console.warn("[tb-api] Could not subscribe to folder events:", e);
    }
  }

  /**
   * Thunderbird drops the listener passed to updateFolderWithListener when a
   * URL is already running, but it still announces kFolderLoaded when that
   * update finishes (Appendix A.3). An operation that started before the event
   * is therefore complete: the update finished after the request was made.
   */
  handleFolderEvent(folder, event) {
    if (event !== "FolderLoaded" || !folder) return;
    const uri = folder.URI;
    if (typeof uri !== "string" || !uri) return;
    const operation = this.inFlight.get(uri);
    if (!operation || operation.done) return;
    // Events are delivered synchronously, so an event that happened before the
    // request could not reach this handler afterwards. The explicit check also
    // rejects an event observed at a time earlier than the operation started.
    const eventAt = Date.now();
    if (operation.startedAt > eventAt) return;
    this.complete(operation, {
      mailbox: operation.mailbox,
      refreshed: true,
      via: "folder_loaded",
      elapsed_ms: eventAt - operation.startedAt
    });
  }

  waitFor(operation, timeoutMs) {
    if (operation.done) return Promise.resolve(operation.result);

    return new Promise(resolve => {
      const finish = result => {
        clearTimeout(timer);
        operation.waiters.delete(finish);
        resolve(result);
      };
      const timer = setTimeout(() => {
        // A caller deadline is not native cancellation. Keep the operation in
        // flight until its listener finishes, so a retry cannot start a second
        // update while the first may still be running.
        finish(refreshError(
          "refresh_timeout", `Refresh of "${operation.mailbox}" timed out after ${timeoutMs} ms`, 504
        ));
      }, timeoutMs);
      operation.waiters.add(finish);
    });
  }

  complete(operation, result) {
    if (operation.done) return;
    operation.done = true;
    operation.result = result;
    // Clearing the ceiling here covers every completion path, including
    // cancelAll()/close() and the caller timeouts that keep the operation
    // alive for other waiters.
    if (operation.ceiling !== null) {
      clearTimeout(operation.ceiling);
      operation.ceiling = null;
    }
    if (this.inFlight.get(operation.key) === operation) {
      this.inFlight.delete(operation.key);
    }
    for (const finish of operation.waiters) finish(result);
  }

  cancelAll() {
    for (const operation of this.inFlight.values()) {
      this.complete(operation, refreshError("refresh_cancelled", "Folder refresh was stopped", 503));
    }
  }

  close() {
    this.closed = true;
    this.cancelAll();
    if (this.folderListenerRegistered) {
      // Clear the flag first so a second close cannot remove twice.
      this.folderListenerRegistered = false;
      try {
        mailSession.RemoveFolderListener(this.folderListener);
      } catch (e) {
        console.warn("[tb-api] Could not remove the folder listener:", e);
      }
    }
  }
};
