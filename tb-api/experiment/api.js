/* global ExtensionCommon, Cc, Ci, Cu, Services, ChromeUtils */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

var httpServer = class extends ExtensionCommon.ExtensionAPI {
  constructor(extension) {
    super(extension);
    this.server = null;
    this.pendingRequests = new Map();
    this.apiToken = null;
    
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
      
      // Host to bind to (default: 127.0.0.1, use 0.0.0.0 for Docker)
      this.apiHost = env.get("TB_API_HOST") || "127.0.0.1";
      console.log(`[tb-api] API will bind to ${this.apiHost}`);
    } catch (e) {
      console.error("[tb-api] Failed to read environment variables:", e);
      this.apiHost = "127.0.0.1";
    }
  }

  getAPI(context) {
    // Store reference to this for use in API methods
    const self = this;

    // Load HttpServer via loadSubScript (httpd.js is not an ES module)
    const httpdScope = {};
    Services.scriptloader.loadSubScript(
      context.extension.rootURI.resolve("lib/httpd.js"),
      httpdScope
    );
    const { HttpServer } = httpdScope;

    // Import calendar module
    const calendarScope = {};
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
      const { response, httpVersion } = pending;

      response.setStatusLine(httpVersion, statusCode, "OK");
      response.setHeader("Content-Type", "application/json; charset=utf-8", false);
      response.setHeader("Access-Control-Allow-Origin", "*", false);

      const cos = Cc["@mozilla.org/intl/converter-output-stream;1"]
        .createInstance(Ci.nsIConverterOutputStream);
      cos.init(response.bodyOutputStream, "UTF-8");
      cos.writeString(body);
      cos.close();

      response.finish();
      return true;
    }

    /**
     * Send JSON response
     */
    function sendJsonResponse(requestId, data, statusCode = 200) {
      writeResponse(requestId, statusCode, JSON.stringify(data));
    }

    /**
     * Parse query string
     */
    function parseQueryString(qs) {
      if (!qs) return {};
      const params = {};
      for (const part of qs.split("&")) {
        const [key, value] = part.split("=");
        if (key) {
          params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : "";
        }
      }
      return params;
    }

    /**
     * Determine HTTP status code from error message
     */
    function getErrorStatus(errorMessage) {
      if (errorMessage.includes("not found")) return 404;
      if (errorMessage.includes("not available")) return 503;
      return 400;
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
     * Send calendar response with appropriate status code
     */
    function sendCalendarResponse(requestId, result) {
      const status = result.error ? getErrorStatus(result.error) : 200;
      sendJsonResponse(requestId, result, status);
    }

    /**
     * Handle calendar routes directly
     */
    async function handleCalendarRoute(requestId, method, path, queryString, body) {
      const bodyObj = body ? JSON.parse(body) : {};
      const params = { ...parseQueryString(queryString), ...bodyObj };

      try {
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
          
          // Check if invitations need to be sent
          if (result._invitationData && onSendInvitationFire) {
            const invData = result._invitationData;
            // Fire event for background script to send invitations
            onSendInvitationFire.async({
              recipients: invData.recipients,
              subject: invData.subject,
              icsContent: invData.icsContent,
              organizerEmail: invData.organizerEmail,
              eventTitle: result.title
            });
            // Update response to indicate invites are being sent
            delete result._invitationData;
            result.invitesSent = true;
            delete result.invitesPending;
          } else if (result._invitationData) {
            // No listener registered
            delete result._invitationData;
            result.warning = "Invitation sending not available (no listener)";
            delete result.invitesPending;
          }
          
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
        sendJsonResponse(requestId, { error: e.message }, 500);
      }
    }

    return {
      httpServer: {
        async start(port) {
          if (self.server) {
            throw new Error("Server already running");
          }

          self.server = new HttpServer();

          // Catch-all handler
          self.server.registerPrefixHandler("/", (request, response) => {
            const requestId = String(++requestCounter);
            response.processAsync();

            // Check authentication if token is configured
            if (self.apiToken) {
              let authHeader = "";
              try {
                authHeader = request.getHeader("Authorization") || "";
              } catch (e) {
                // Header not present
              }
              
              const expectedToken = `Bearer ${self.apiToken}`;
              if (authHeader !== expectedToken) {
                response.setStatusLine(request.httpVersion, 401, "Unauthorized");
                response.setHeader("Content-Type", "application/json; charset=utf-8", false);
                response.setHeader("WWW-Authenticate", "Bearer", false);
                
                const cos = Cc["@mozilla.org/intl/converter-output-stream;1"]
                  .createInstance(Ci.nsIConverterOutputStream);
                cos.init(response.bodyOutputStream, "UTF-8");
                cos.writeString(JSON.stringify({
                  error: "Unauthorized",
                  message: "Valid Bearer token required in Authorization header"
                }));
                cos.close();
                response.finish();
                return;
              }
            }

            // Read body for POST/PATCH
            let body = "";
            if ((request.method === "POST" || request.method === "PATCH") && request.bodyInputStream) {
              const sis = Cc["@mozilla.org/scriptableinputstream;1"]
                .createInstance(Ci.nsIScriptableInputStream);
              sis.init(request.bodyInputStream);
              const available = sis.available();
              if (available > 0) {
                body = sis.read(available);
              }
            }

            self.pendingRequests.set(requestId, {
              response,
              httpVersion: request.httpVersion
            });

            const path = request.path;
            const method = request.method;
            const queryString = request.queryString;

            // Handle calendar routes directly in experiment context
            if (isCalendarRoute(path)) {
              handleCalendarRoute(requestId, method, path, queryString, body);
              return;
            }

            // Fire event for background script to handle
            if (onRequestFire) {
              onRequestFire.async({
                id: requestId,
                method,
                path,
                queryString: queryString || "",
                body
              });
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

        async stop() {
          if (self.server) {
            await new Promise(resolve => self.server.stop(resolve));
            self.server = null;
            self.pendingRequests.clear();
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
    // Stop the HTTP server when extension is unloaded
    if (this.server) {
      console.log("[tb-api] Shutting down HTTP server...");
      this.server.stop(() => {
        console.log("[tb-api] HTTP server stopped on extension close");
      });
      this.server = null;
      this.pendingRequests.clear();
    }
  }
};
