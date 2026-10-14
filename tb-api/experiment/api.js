/* global ExtensionCommon, Cc, Ci, Cu, Services, ChromeUtils, Components */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

// Shared with folders.js so every timer in the experiment can be controlled
// from one place (and faked in tests).
var { setTimeout, clearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

// MailServices.mailSession delivers folder events, the second completion
// signal used by experiment/folders.js. The module is missing on older
// Thunderbird versions; folder refresh then relies on the per-request URL
// listener alone.
var MailServices = null;
try {
  ({ MailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  ));
} catch (e) {
  console.warn("[tb-api] MailServices is not available; folder events are disabled:", e);
}

// Maximum time a request may stay unanswered before the watchdog replies 504.
// Above the 60 s refresh maximum plus the 20 s email-search budget.
const REQUEST_TIMEOUT_MS = 120000;

/**
 * Write a JSON body to a stored pending response and finish it. The watchdog
 * timer is cleared first so a request can never receive two responses.
 */
function finishPendingResponse(pending, statusCode, body) {
  if (pending.timer !== undefined) clearTimeout(pending.timer);

  const { response, httpVersion } = pending;
  response.setStatusLine(httpVersion, statusCode, "OK");
  response.setHeader("Content-Type", "application/json; charset=utf-8", false);

  const cos = Cc["@mozilla.org/intl/converter-output-stream;1"]
    .createInstance(Ci.nsIConverterOutputStream);
  cos.init(response.bodyOutputStream, "UTF-8");
  cos.writeString(body);
  cos.close();

  response.finish();
}

/**
 * Answer every pending request with 503 and clear its watchdog. Used on
 * shutdown so no client waits for a response that will never come.
 */
function failPendingRequests(pendingRequests) {
  const body = JSON.stringify({ error: "Server is shutting down", code: "api_not_ready" });
  for (const [requestId, pending] of [...pendingRequests]) {
    pendingRequests.delete(requestId);
    try {
      finishPendingResponse(pending, 503, body);
    } catch (e) {
      console.error(`[tb-api] Failed to finish pending request ${requestId}:`, e);
    }
  }
}

var httpServer = class extends ExtensionCommon.ExtensionAPI {
  constructor(extension) {
    super(extension);
    this.server = null;
    this.pendingRequests = new Map();
    this.folderRefresher = null;
    this.apiToken = null;
    this.apiHost = "127.0.0.1";
    this.allowedOrigins = [];
    
    // Read configuration from environment variables
    try {
      const env = Cc["@mozilla.org/process/environment;1"]
        .getService(Ci.nsIEnvironment);
      
      // API token for authentication
      this.apiToken = env.get("TB_API_TOKEN") || null;
      if (this.apiToken) {
        console.log("[tb-api] API token configured from TB_API_TOKEN environment variable");
      } else {
        console.log("[tb-api] No TB_API_TOKEN set - authentication disabled");
      }
      
      // Browser origins allowed to call the API (comma-separated, default: none)
      this.allowedOrigins = (env.get("TB_API_ALLOWED_ORIGINS") || "")
        .split(",")
        .map(origin => origin.trim())
        .filter(Boolean);
      if (this.allowedOrigins.length > 0) {
        console.log(`[tb-api] Allowed browser origins: ${this.allowedOrigins.join(", ")}`);
      }
      
      // Host to bind to (default: 127.0.0.1, use 0.0.0.0 for Docker)
      this.apiHost = env.get("TB_API_HOST") || "127.0.0.1";
      console.log(`[tb-api] API will bind to ${this.apiHost}`);
    } catch (e) {
      console.error("[tb-api] Failed to read environment variables:", e);
      this.apiHost = "127.0.0.1";
      this.allowedOrigins = [];
    }
  }

  getAPI(context) {
    // Store reference to this for use in API methods
    const self = this;
    context.callOnClose(self);

    if (!self.folderRefresher) {
      const folderScope = { Services, Ci, Components, ChromeUtils, console, MailServices };
      Services.scriptloader.loadSubScript(
        context.extension.rootURI.resolve("experiment/folders.js"),
        folderScope
      );
      self.folderRefresher = new folderScope.FolderRefresher();
    }

    // Load HttpServer via loadSubScript (httpd.js is not an ES module)
    const httpdScope = {};
    Services.scriptloader.loadSubScript(
      context.extension.rootURI.resolve("lib/httpd.js"),
      httpdScope
    );
    const { HttpServer } = httpdScope;

    // Import calendar module. utils.js is loaded into the same scope first so
    // calendar.js can share the background's parameter parsing helpers.
    // MailServices is shared so createEvent can validate the organizer against
    // the user's own identities (D8).
    const calendarScope = { MailServices };
    Services.scriptloader.loadSubScript(
      context.extension.rootURI.resolve("api/utils.js"),
      calendarScope
    );
    Services.scriptloader.loadSubScript(
      context.extension.rootURI.resolve("api/calendar.js"),
      calendarScope
    );
    const calendar = calendarScope;

    // Calendar API (optional - try to load Thunderbird's calendar module)
    let cal = null;
    try {
      const calModule = ChromeUtils.importESModule(
        "resource:///modules/calendar/calUtils.sys.mjs"
      );
      cal = calModule.cal;
    } catch (e) {
      console.log("[tb-api] Calendar not available");
    }

    let requestCounter = 0;
    let onRequestFire = null;
    let onSendInvitationFire = null;

    /**
     * Write response body and finish the HTTP response
     */
    function writeResponse(requestId, statusCode, body) {
      const pending = self.pendingRequests.get(requestId);
      if (!pending) return false;

      self.pendingRequests.delete(requestId);
      finishPendingResponse(pending, statusCode, body);
      return true;
    }

    /**
     * Read a request header, returning "" when the header is absent
     */
    function header(request, name) {
      return request.hasHeader(name) ? request.getHeader(name) : "";
    }

    /**
     * Reason a request must be rejected as browser-originated, or null when it
     * is a plain non-browser request (curl, server-side clients).
     */
    function rejectReason(request) {
      const origin = header(request, "Origin");
      if (origin && !self.allowedOrigins.includes(origin)) return "origin_not_allowed";
      const site = header(request, "Sec-Fetch-Site").toLowerCase();
      if ((site === "cross-site" || site === "same-site") && !origin) return "cross_site_request";
      return null;
    }

    /**
     * Constant-time string comparison (length is not secret), used for tokens
     */
    function secretsEqual(a, b) {
      if (a.length !== b.length) return false;
      let difference = 0;
      for (let i = 0; i < a.length; i++) {
        difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
      }
      return difference === 0;
    }

    /**
     * Write an error response directly and finish it (no pending request needed)
     */
    function writeError(response, httpVersion, status, body, extraHeaders = {}) {
      const reason = { 401: "Unauthorized", 403: "Forbidden", 415: "Unsupported Media Type" }[status] || "Error";
      response.setStatusLine(httpVersion, status, reason);
      response.setHeader("Content-Type", "application/json; charset=utf-8", false);
      for (const [name, value] of Object.entries(extraHeaders)) {
        response.setHeader(name, value, false);
      }

      const cos = Cc["@mozilla.org/intl/converter-output-stream;1"]
        .createInstance(Ci.nsIConverterOutputStream);
      cos.init(response.bodyOutputStream, "UTF-8");
      cos.writeString(JSON.stringify(body));
      cos.close();

      response.finish();
    }

    /**
     * Send JSON response
     */
    function sendJsonResponse(requestId, data, statusCode = 200) {
      writeResponse(requestId, statusCode, JSON.stringify(data));
    }

    /**
     * Extract path parameter
     */
    function extractPathParam(path, prefix) {
      if (!path.startsWith(prefix)) return null;
      const param = path.slice(prefix.length).split("?")[0];
      return param ? decodeURIComponent(param) : null;
    }

    /**
     * Check if path is a calendar route
     */
    function isCalendarRoute(path) {
      return path === "/calendars" || 
             path === "/events" || 
             path.startsWith("/events/") ||
             path === "/upcoming";
    }

    /**
     * Answer a request whose background handler failed with 500. Reached both
     * when the handler rejects and when it throws before returning a promise.
     */
    function failBackgroundRequest(requestId, error) {
      console.error("[tb-api] Background request failed:", error);
      sendJsonResponse(requestId, { error: error.message }, 500);
    }

    /**
     * HTTP status for an error raised while handling a calendar route.
     *
     * Calendar code runs in its own script realm, so errors thrown there are
     * not `instanceof` this realm's SyntaxError/URIError; the error name is
     * stable across realms. RequestError is exported by Utils and both sides
     * live in that realm, so instanceof is safe for it.
     */
    function calendarErrorStatus(error) {
      if (error && calendarScope.Utils && error instanceof calendarScope.Utils.RequestError) {
        return error.statusCode || 400;
      }
      if (error && (error.name === "SyntaxError" || error.name === "URIError")) return 400;
      return 500;
    }

    /**
     * Send calendar response with appropriate status code. `statusCode` is
     * internal metadata (like the background's resultResponse), so it drives
     * the HTTP status but is not serialized into the JSON body.
     */
    function sendCalendarResponse(requestId, result) {
      const { statusCode, ...body } = result;
      sendJsonResponse(requestId, body, statusCode || (result.error ? 400 : 200));
    }

    /**
     * Handle calendar routes directly
     */
    async function handleCalendarRoute(requestId, method, path, queryString, body) {
      try {
        // Parsing happens inside the try: a malformed body or query string
        // must become a 400 response, never an unhandled rejection.
        const params = calendarScope.Utils.parseRequestParams(queryString, body);

        // GET /calendars
        if (path === "/calendars" && method === "GET") {
          sendCalendarResponse(requestId, calendar.listCalendars(cal));
          return;
        }

        // GET /events
        if (path === "/events" && method === "GET") {
          sendCalendarResponse(requestId, await calendar.listEvents(params, cal, Ci));
          return;
        }

        // GET /upcoming
        if (path === "/upcoming" && method === "GET") {
          sendCalendarResponse(requestId, await calendar.upcomingEvents(params, cal, Ci));
          return;
        }

        // POST /events
        if (path === "/events" && method === "POST") {
          const result = await calendar.createEvent(params, cal, Ci, Cc);

          // The background prepares or sends the invitation. `fire.async()`
          // resolves to the listener's outcome (Appendix A.5), so the response
          // reports the real status instead of assuming the invite was sent.
          if (result._invitationData) {
            const { mode, ...invitation } = result._invitationData;
            delete result._invitationData;
            if (onSendInvitationFire) {
              try {
                const outcome = await onSendInvitationFire.async({ ...invitation, mode });
                result.invitations = outcome && typeof outcome.status === "string"
                  ? outcome
                  : { status: "failed", error: "background returned no invitation outcome" };
              } catch (e) {
                // A listener that throws or rejects must not fail the created
                // event: report the invitation outcome instead.
                result.invitations = { status: "failed", error: e.message };
              }
            } else {
              // The event exists by now: this is a success with a warning, not
              // an error response.
              result.invitations = { status: "failed", error: "background not ready" };
              result.warning = "Invitations were not prepared: background not ready";
            }
          }

          // The event was created (POST is not an error): 201 Created.
          if (!result.error) result.statusCode = 201;
          sendCalendarResponse(requestId, result);
          return;
        }

        // PATCH /events/:id
        if (path.startsWith("/events/") && method === "PATCH") {
          const eventId = extractPathParam(path, "/events/");
          if (eventId) {
            sendCalendarResponse(requestId, await calendar.updateEvent(eventId, params, cal, Ci, Cc));
            return;
          }
        }

        // DELETE /events/:id
        if (path.startsWith("/events/") && method === "DELETE") {
          const eventId = extractPathParam(path, "/events/");
          if (eventId) {
            sendCalendarResponse(requestId, await calendar.deleteEvent(eventId, params, cal));
            return;
          }
        }

        // Method not allowed
        sendJsonResponse(requestId, { error: "Method not allowed" }, 405);

      } catch (e) {
        console.error("[tb-api] Calendar error:", e);
        const error = { error: e.message };
        if (e.code) error.code = e.code;
        sendJsonResponse(requestId, error, calendarErrorStatus(e));
      }
    }

    return {
      httpServer: {
        async start(port) {
          if (self.server) {
            throw new Error("Server already running");
          }

          // Fail closed: a server reachable beyond loopback must be authenticated
          const loopbackHosts = ["127.0.0.1", "localhost", "::1"];
          if (!loopbackHosts.includes(self.apiHost) && !self.apiToken) {
            throw new Error("TB_API_TOKEN is required when TB_API_HOST is not loopback");
          }

          self.server = new HttpServer();

          // Catch-all handler
          self.server.registerPrefixHandler("/", (request, response) => {
            const requestId = String(++requestCounter);
            response.processAsync();

            // Reject browser-originated requests before authentication so the
            // rule applies whether or not a token is configured. Non-browser
            // clients (curl, server-side) send neither Origin nor Sec-Fetch-Site.
            const reason = rejectReason(request);
            if (reason) {
              writeError(response, request.httpVersion, 403, {
                error: reason === "origin_not_allowed"
                  ? "Origin is not allowed by TB_API_ALLOWED_ORIGINS"
                  : "Cross-site browser requests are not allowed",
                code: reason
              });
              return;
            }

            // Echo CORS headers for allowlisted origins (never a wildcard), so
            // browsers may read the response. Vary: Origin keeps caches honest.
            const origin = header(request, "Origin");
            if (origin) {
              response.setHeader("Access-Control-Allow-Origin", origin, false);
              response.setHeader("Vary", "Origin", false);
            }

            // OPTIONS is only answered as a CORS preflight for allowlisted origins
            if (request.method === "OPTIONS") {
              if (!origin) {
                writeError(response, request.httpVersion, 403, {
                  error: "OPTIONS requires an allowlisted Origin",
                  code: "origin_not_allowed"
                });
                return;
              }
              response.setStatusLine(request.httpVersion, 204, "No Content");
              // Browsers only honour the Access-Control-* spellings; the bare
              // names are kept for compatibility with the documented contract.
              response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE", false);
              response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type", false);
              response.setHeader("Allow-Methods", "GET, POST, PATCH, DELETE", false);
              response.setHeader("Allow-Headers", "Authorization, Content-Type", false);
              response.finish();
              return;
            }

            // Check authentication if token is configured
            if (self.apiToken) {
              const expectedToken = `Bearer ${self.apiToken}`;
              if (!secretsEqual(header(request, "Authorization"), expectedToken)) {
                writeError(response, request.httpVersion, 401, {
                  error: "Unauthorized",
                  message: "Valid Bearer token required in Authorization header"
                }, { "WWW-Authenticate": "Bearer" });
                return;
              }
            }

            // Read body for POST/PATCH/DELETE
            // nsIScriptableInputStream.read() is used because it respects available()
            // and won't block waiting for EOF (unlike nsIConverterInputStream in a loop).
            // The raw bytes are then decoded from UTF-8 via escape/decodeURIComponent so
            // multi-byte characters (em dashes, smart quotes, emoji, etc.) are preserved.
            let body = "";
            const method = request.method;
            if ((method === "POST" || method === "PATCH" || method === "DELETE") && request.bodyInputStream) {
              const sis = Cc["@mozilla.org/scriptableinputstream;1"]
                .createInstance(Ci.nsIScriptableInputStream);
              sis.init(request.bodyInputStream);
              const available = sis.available();
              if (available > 0) {
                const rawBytes = sis.read(available);
                // rawBytes is a Latin-1 string (one char per byte). Re-interpret as UTF-8:
                // escape() percent-encodes each byte > 0x7F as %XX, then
                // decodeURIComponent() interprets the %XX sequences as UTF-8 code units.
                try {
                  body = decodeURIComponent(escape(rawBytes));
                } catch (e) {
                  // Fall back to raw bytes if the body isn't valid UTF-8
                  body = rawBytes;
                }
              }
            }

            // A body must be JSON: this blocks "simple" cross-site POSTs that
            // browsers send without a preflight. Empty bodies stay allowed.
            if ((method === "POST" || method === "PATCH" || method === "DELETE") &&
                body !== "" && !header(request, "Content-Type").startsWith("application/json")) {
              writeError(response, request.httpVersion, 415, {
                error: "Content-Type must be application/json when a body is sent",
                code: "unsupported_media_type"
              });
              return;
            }

            const path = request.path;
            const queryString = request.queryString;

            // A stored request that is never answered must not hang forever:
            // the watchdog finishes it with 504 and clears itself in
            // writeResponse when any other path answers first.
            const watchdog = setTimeout(() => {
              console.error(`[tb-api] Request ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS} ms`);
              sendJsonResponse(requestId, {
                error: "Request timed out",
                code: "request_timeout"
              }, 504);
            }, REQUEST_TIMEOUT_MS);

            self.pendingRequests.set(requestId, {
              response,
              httpVersion: request.httpVersion,
              timer: watchdog
            });

            // Handle calendar routes directly in experiment context. The
            // promise must never reject unhandled: without the catch a
            // rejection would leave the request pending until the watchdog.
            if (isCalendarRoute(path)) {
              handleCalendarRoute(requestId, method, path, queryString, body)
                .catch(e => sendJsonResponse(requestId, { error: e.message }, 500));
              return;
            }

            // The background listener may not be registered (yet): answer
            // instead of leaving the request pending forever.
            if (!onRequestFire) {
              sendJsonResponse(requestId, {
                error: "API is not ready to handle this request",
                code: "api_not_ready"
              }, 503);
              return;
            }

            // Fire event for background script to handle. A rejected handler
            // still produces exactly one response, and the try also covers a
            // handler that throws before returning a promise.
            try {
              onRequestFire.async({
                id: requestId,
                method,
                path,
                queryString: queryString || "",
                body
              }).catch(e => failBackgroundRequest(requestId, e));
            } catch (e) {
              failBackgroundRequest(requestId, e);
            }
          });

          // Use _start directly to control the bind host
          // "localhost" or "127.0.0.1" = loopback only
          // anything else (e.g., "0.0.0.0") = accept connections from anywhere
          self.server._start(port, self.apiHost);
          self.server._identity._primaryHost = self.apiHost;
          
          // Add common hostnames to server identity so Host header validation passes
          // This is needed because httpd.js validates the Host header against known identities
          // and rejects requests with HTTP 400 if the hostname isn't recognized
          self.server._identity.add("http", "localhost", port);
          
          // Allow configuring additional hostnames via TB_API_HOSTS environment variable
          // (comma-separated list, e.g., "thunderbird,myservice,192.168.1.100")
          try {
            const env = Cc["@mozilla.org/process/environment;1"]
              .getService(Ci.nsIEnvironment);
            const additionalHosts = env.get("TB_API_HOSTS");
            if (additionalHosts) {
              for (const host of additionalHosts.split(",").map(h => h.trim()).filter(Boolean)) {
                self.server._identity.add("http", host, port);
                console.log(`[tb-api] Added "${host}" to server identity`);
              }
            }
          } catch (e) {
            console.error("[tb-api] Failed to read TB_API_HOSTS:", e);
          }
          
          console.log(`[tb-api] HTTP server started on ${self.apiHost}:${port}`);
        },

        refreshFolder(folderId, timeoutMs) {
          return self.folderRefresher.refreshFolder(folderId, timeoutMs);
        },

        /**
         * Read Replied/Forwarded state for internal message IDs.
         *
         * MessageHeader (what the background sees) has no answered/forwarded
         * fields, but Thunderbird's own nsIMsgDBHdr does: Replied = 0x2,
         * Forwarded = 0x1000 (Appendix A.5). One entry is returned per ID the
         * message manager knows. When the manager is unreachable the result
         * is empty, and callers must omit the flags rather than report a
         * fabricated false.
         */
        async getMessageFlags(messageIds) {
          const result = {};
          const manager = context.extension && context.extension.messageManager;
          if (!manager || typeof manager.get !== "function") return result;
          for (const id of messageIds || []) {
            try {
              const msgHdr = manager.get(id);
              if (!msgHdr) continue;
              result[id] = {
                answered: !!(msgHdr.flags & 0x2),
                forwarded: !!(msgHdr.flags & 0x1000)
              };
            } catch (e) {
              // A vanished or unknown message must not abort the whole page;
              // its flags are simply unknown and stay absent.
            }
          }
          return result;
        },

        async stop() {
          self.folderRefresher.cancelAll();
          // Finish requests still waiting: stopping the server must not leave
          // clients hanging on a response that can no longer arrive.
          failPendingRequests(self.pendingRequests);
          if (self.server) {
            await new Promise(resolve => self.server.stop(resolve));
            self.server = null;
            console.log("[tb-api] HTTP server stopped");
          }
        },

        sendResponse(requestId, statusCode, body) {
          if (!writeResponse(requestId, statusCode, body)) {
            console.error(`[tb-api] No pending request with id ${requestId}`);
          }
        },

        onRequest: new ExtensionCommon.EventManager({
          context,
          name: "httpServer.onRequest",
          register: fire => {
            onRequestFire = fire;
            return () => {
              onRequestFire = null;
            };
          }
        }).api(),

        onSendInvitation: new ExtensionCommon.EventManager({
          context,
          name: "httpServer.onSendInvitation",
          register: fire => {
            onSendInvitationFire = fire;
            return () => {
              onSendInvitationFire = null;
            };
          }
        }).api()
      }
    };
  }

  close() {
    if (this.folderRefresher) this.folderRefresher.close();
    // Finish requests still waiting before tearing the server down, so no
    // client is left without a response and no watchdog outlives the API.
    failPendingRequests(this.pendingRequests);
    // Stop the HTTP server when extension is unloaded
    if (this.server) {
      console.log("[tb-api] Shutting down HTTP server...");
      this.server.stop(() => {
        console.log("[tb-api] HTTP server stopped on extension close");
      });
      this.server = null;
    }
  }
};
