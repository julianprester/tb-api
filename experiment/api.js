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
      context.extension.rootURI.resolve("experiment/httpd.js"),
      httpdScope
    );
    const { HttpServer } = httpdScope;

    // Import calendar module
    const calendarScope = {};
    Services.scriptloader.loadSubScript(
      context.extension.rootURI.resolve("experiment/calendar.js"),
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
     * Send JSON response
     */
    function sendJsonResponse(requestId, data, statusCode = 200) {
      const pending = pendingRequests.get(requestId);
      if (!pending) return;

      pendingRequests.delete(requestId);
      const { response, httpVersion } = pending;

      response.setStatusLine(httpVersion, statusCode, "OK");
      response.setHeader("Content-Type", "application/json; charset=utf-8", false);
      response.setHeader("Access-Control-Allow-Origin", "*", false);

      const body = JSON.stringify(data);
      const cos = Cc["@mozilla.org/intl/converter-output-stream;1"]
        .createInstance(Ci.nsIConverterOutputStream);
      cos.init(response.bodyOutputStream, "UTF-8");
      cos.writeString(body);
      cos.close();

      response.finish();
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
     * Parse JSON body
     */
    function parseBody(bodyStr) {
      if (!bodyStr) return {};
      try {
        return JSON.parse(bodyStr);
      } catch (e) {
        return {};
      }
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
     * Handle calendar routes directly
     */
    async function handleCalendarRoute(requestId, method, path, queryString, body) {
      const params = { ...parseQueryString(queryString), ...parseBody(body) };

      try {
        // GET /calendars
        if (path === "/calendars" && method === "GET") {
          const result = calendar.listCalendars(cal);
          if (result.error) {
            sendJsonResponse(requestId, result, 503);
          } else {
            sendJsonResponse(requestId, result);
          }
          return;
        }

        // GET /events
        if (path === "/events" && method === "GET") {
          const result = await calendar.listEvents(params, cal, Ci);
          if (result.error) {
            sendJsonResponse(requestId, result, result.error.includes("not available") ? 503 : 400);
          } else {
            sendJsonResponse(requestId, result);
          }
          return;
        }

        // POST /events
        if (path === "/events" && method === "POST") {
          const result = await calendar.createEvent(params, cal, Ci, Cc);
          if (result.error) {
            sendJsonResponse(requestId, result, result.error.includes("not available") ? 503 : 400);
          } else {
            sendJsonResponse(requestId, result);
          }
          return;
        }

        // PATCH /events/:id
        if (path.startsWith("/events/") && method === "PATCH") {
          const eventId = extractPathParam(path, "/events/");
          if (eventId) {
            const result = await calendar.updateEvent(eventId, params, cal, Ci, Cc);
            const status = result.error 
              ? (result.error.includes("not found") ? 404 : result.error.includes("not available") ? 503 : 400)
              : 200;
            sendJsonResponse(requestId, result, status);
            return;
          }
        }

        // DELETE /events/:id
        if (path.startsWith("/events/") && method === "DELETE") {
          const eventId = extractPathParam(path, "/events/");
          if (eventId) {
            const result = await calendar.deleteEvent(eventId, params, cal);
            const status = result.error
              ? (result.error.includes("not found") ? 404 : result.error.includes("not available") ? 503 : 400)
              : 200;
            sendJsonResponse(requestId, result, status);
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
                method: method,
                path: path,
                queryString: queryString || "",
                body: body
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
          const pending = pendingRequests.get(requestId);
          if (!pending) {
            console.error(`[tb-api] No pending request with id ${requestId}`);
            return;
          }

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
