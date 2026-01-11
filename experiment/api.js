/* global ExtensionCommon, Cc, Ci, Cu, Services, ChromeUtils */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

var httpServer = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
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

    let server = null;
    let pendingRequests = new Map();
    let requestCounter = 0;
    let onRequestFire = null;

    /**
     * Write response body and finish the HTTP response
     */
    function writeResponse(requestId, statusCode, body) {
      const pending = pendingRequests.get(requestId);
      if (!pending) return false;

      pendingRequests.delete(requestId);
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
             path.startsWith("/events/");
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

        // POST /events
        if (path === "/events" && method === "POST") {
          sendCalendarResponse(requestId, await calendar.createEvent(params, cal, Ci, Cc));
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
          if (server) {
            throw new Error("Server already running");
          }

          server = new HttpServer();

          // Catch-all handler
          server.registerPrefixHandler("/", (request, response) => {
            const requestId = String(++requestCounter);
            response.processAsync();

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

            pendingRequests.set(requestId, {
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

          server._identity._primaryHost = "127.0.0.1";
          server.start(port);
          console.log(`[tb-api] HTTP server started on port ${port}`);
        },

        async stop() {
          if (server) {
            await new Promise(resolve => server.stop(resolve));
            server = null;
            pendingRequests.clear();
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
        }).api()
      }
    };
  }

  close() {
    // Cleanup
  }
};
