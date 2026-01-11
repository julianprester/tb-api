/* global ExtensionCommon, Cc, Ci, ChromeUtils */
"use strict";

const API_PORT = 9595;

const resProto = Cc[
  "@mozilla.org/network/protocol;1?name=resource"
].getService(Ci.nsISubstitutingProtocolHandler);

let serverInstance = null;

function log(msg) {
  console.log("[tb-api]", msg);
}

function logError(msg, error) {
  console.error("[tb-api]", msg, error);
  if (error?.stack) {
    console.error("[tb-api] Stack:", error.stack);
  }
}

var mcpServer = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    log("getAPI called");

    const extensionRoot = context.extension.rootURI;
    const resourceName = "tb-api";

    try {
      resProto.setSubstitutionWithFlags(
        resourceName,
        extensionRoot,
        resProto.ALLOW_CONTENT_ACCESS
      );
      log(`Resource protocol registered: resource://${resourceName}/`);
    } catch (e) {
      logError("Failed to register resource protocol", e);
    }

    return {
      mcpServer: {
        async start() {
          log("start() called");

          if (serverInstance) {
            log("Stopping existing server...");
            try {
              await new Promise((resolve) => serverInstance.stop(resolve));
              log("Existing server stopped");
            } catch (e) {
              log("Error stopping existing server: " + e.message);
            }
            serverInstance = null;
          }

          try {
            // Import modules
            log("Importing HttpServer...");
            const { HttpServer } = ChromeUtils.importESModule(
              `resource://${resourceName}/httpd.sys.mjs`
            );
            log("HttpServer imported");

            log("Importing NetUtil...");
            const { NetUtil } = ChromeUtils.importESModule(
              "resource://gre/modules/NetUtil.sys.mjs"
            );
            log("NetUtil imported");

            log("Importing MailServices...");
            const { MailServices } = ChromeUtils.importESModule(
              "resource:///modules/MailServices.sys.mjs"
            );
            log("MailServices imported");

            log("Importing MsgHdrToMimeMessage...");
            const { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
              "resource:///modules/gloda/MimeMessage.sys.mjs"
            );
            log("MsgHdrToMimeMessage imported");

            // Import our modules
            log("Importing utils...");
            const utils = ChromeUtils.importESModule(
              `resource://${resourceName}/mcp_server/utils.sys.mjs`
            );
            log("utils imported");

            log("Importing email...");
            const email = ChromeUtils.importESModule(
              `resource://${resourceName}/mcp_server/email.sys.mjs`
            );
            log("email imported");

            log("Importing calendar...");
            const calendar = ChromeUtils.importESModule(
              `resource://${resourceName}/mcp_server/calendar.sys.mjs`
            );
            log("calendar imported");

            log("Importing contacts...");
            const contacts = ChromeUtils.importESModule(
              `resource://${resourceName}/mcp_server/contacts.sys.mjs`
            );
            log("contacts imported");

            // Calendar (optional)
            let cal = null;
            try {
              const calModule = ChromeUtils.importESModule(
                "resource:///modules/calendar/calUtils.sys.mjs"
              );
              cal = calModule.cal;
              log("Calendar module imported");
            } catch (e) {
              log("Calendar not available: " + e.message);
            }

            log("All modules imported successfully");

            // Create server
            serverInstance = new HttpServer();

            // ============================================================
            // ROUTE: /
            // ============================================================
            serverInstance.registerPathHandler("/", (req, res) => {
              utils.sendJson(res, req.httpVersion, {
                name: "Thunderbird REST API",
                version: "1.0",
                endpoints: {
                  email: [
                    "GET /messages - Search messages",
                    "GET /messages/:id - Get message by Message-ID",
                    "POST /messages - Create draft or send",
                    "PATCH /messages - Update message flags/move",
                    "GET /mailboxes - List folders",
                    "GET /identities - List identities",
                  ],
                  calendar: [
                    "GET /calendars - List calendars",
                    "GET /events - List events",
                    "POST /events - Create event",
                    "PATCH /events/:id - Update event",
                    "DELETE /events/:id - Delete event",
                  ],
                  contacts: [
                    "GET /addressbooks - List address books",
                    "GET /contacts - Search contacts",
                    "POST /contacts - Create contact",
                    "PATCH /contacts/:id - Update contact",
                    "DELETE /contacts/:id - Delete contact",
                  ],
                },
              });
            });

            // ============================================================
            // ROUTE: /messages
            // ============================================================
            serverInstance.registerPrefixHandler("/messages", (req, res) => {
              const messageId = utils.extractPathParam(req.path, "/messages/");

              if (req.method === "GET" && messageId) {
                // GET /messages/:id
                log(`GET /messages/${messageId}`);
                res.processAsync();

                email.getMessage(messageId, MailServices, MsgHdrToMimeMessage, Ci)
                  .then((result) => {
                    if (result.error) {
                      utils.sendError(res, req.httpVersion, result.error, 404);
                    } else {
                      utils.sendJson(res, req.httpVersion, result);
                    }
                    res.finish();
                  })
                  .catch((e) => {
                    logError("Error in GET /messages/:id", e);
                    utils.sendError(res, req.httpVersion, e.message, 500);
                    res.finish();
                  });

              } else if (req.method === "GET") {
                // GET /messages (search)
                log(`GET /messages?${req.queryString}`);
                try {
                  const params = utils.parseQueryString(req.queryString);
                  const result = email.searchMessages(params, MailServices, Ci, utils.parseDate);
                  if (result.error) {
                    utils.sendError(res, req.httpVersion, result.error);
                  } else {
                    utils.sendJson(res, req.httpVersion, result);
                  }
                } catch (e) {
                  logError("Error in GET /messages", e);
                  utils.sendError(res, req.httpVersion, e.message, 500);
                }

              } else if (req.method === "POST") {
                // POST /messages (compose)
                log("POST /messages");
                try {
                  const params = utils.parseRequestBody(req, NetUtil);
                  const result = email.composeMessage(params, MailServices, Ci);
                  if (result.error) {
                    utils.sendError(res, req.httpVersion, result.error);
                  } else {
                    utils.sendJson(res, req.httpVersion, result);
                  }
                } catch (e) {
                  logError("Error in POST /messages", e);
                  utils.sendError(res, req.httpVersion, e.message, 500);
                }

              } else if (req.method === "PATCH") {
                // PATCH /messages (update)
                log("PATCH /messages");
                try {
                  const params = utils.parseRequestBody(req, NetUtil);
                  const result = email.updateMessages(params, MailServices, Ci);
                  if (result.error) {
                    utils.sendError(res, req.httpVersion, result.error);
                  } else {
                    utils.sendJson(res, req.httpVersion, result);
                  }
                } catch (e) {
                  logError("Error in PATCH /messages", e);
                  utils.sendError(res, req.httpVersion, e.message, 500);
                }

              } else {
                utils.sendError(res, req.httpVersion, "Method not allowed", 405);
              }
            });

            // ============================================================
            // ROUTE: /mailboxes
            // ============================================================
            serverInstance.registerPathHandler("/mailboxes", (req, res) => {
              log("GET /mailboxes");
              if (req.method !== "GET") {
                utils.sendError(res, req.httpVersion, "Method not allowed", 405);
                return;
              }
              try {
                const result = email.listMailboxes(MailServices, Ci);
                utils.sendJson(res, req.httpVersion, result);
              } catch (e) {
                logError("Error in GET /mailboxes", e);
                utils.sendError(res, req.httpVersion, e.message, 500);
              }
            });

            // ============================================================
            // ROUTE: /identities
            // ============================================================
            serverInstance.registerPathHandler("/identities", (req, res) => {
              log("GET /identities");
              if (req.method !== "GET") {
                utils.sendError(res, req.httpVersion, "Method not allowed", 405);
                return;
              }
              try {
                const result = email.listIdentities(MailServices);
                utils.sendJson(res, req.httpVersion, result);
              } catch (e) {
                logError("Error in GET /identities", e);
                utils.sendError(res, req.httpVersion, e.message, 500);
              }
            });

            // ============================================================
            // ROUTE: /calendars
            // ============================================================
            serverInstance.registerPathHandler("/calendars", (req, res) => {
              log("GET /calendars");
              if (req.method !== "GET") {
                utils.sendError(res, req.httpVersion, "Method not allowed", 405);
                return;
              }
              try {
                const result = calendar.listCalendars(cal);
                if (result.error) {
                  utils.sendError(res, req.httpVersion, result.error, 503);
                } else {
                  utils.sendJson(res, req.httpVersion, result);
                }
              } catch (e) {
                logError("Error in GET /calendars", e);
                utils.sendError(res, req.httpVersion, e.message, 500);
              }
            });

            // ============================================================
            // ROUTE: /events
            // ============================================================
            serverInstance.registerPrefixHandler("/events", (req, res) => {
              const eventId = utils.extractPathParam(req.path, "/events/");

              if (req.method === "GET" && !eventId) {
                // GET /events (list)
                log(`GET /events?${req.queryString}`);
                res.processAsync();

                const params = utils.parseQueryString(req.queryString);
                calendar.listEvents(params, cal, Ci)
                  .then((result) => {
                    if (result.error) {
                      utils.sendError(res, req.httpVersion, result.error, 
                        result.error.includes("not available") ? 503 : 400);
                    } else {
                      utils.sendJson(res, req.httpVersion, result);
                    }
                    res.finish();
                  })
                  .catch((e) => {
                    logError("Error in GET /events", e);
                    utils.sendError(res, req.httpVersion, e.message, 500);
                    res.finish();
                  });

              } else if (req.method === "POST" && !eventId) {
                // POST /events (create)
                log("POST /events");
                res.processAsync();

                const params = utils.parseRequestBody(req, NetUtil);
                calendar.createEvent(params, cal, Ci)
                  .then((result) => {
                    if (result.error) {
                      utils.sendError(res, req.httpVersion, result.error,
                        result.error.includes("not available") ? 503 : 400);
                    } else {
                      utils.sendJson(res, req.httpVersion, result);
                    }
                    res.finish();
                  })
                  .catch((e) => {
                    logError("Error in POST /events", e);
                    utils.sendError(res, req.httpVersion, e.message, 500);
                    res.finish();
                  });

              } else if (req.method === "PATCH" && eventId) {
                // PATCH /events/:id (update)
                log(`PATCH /events/${eventId}`);
                res.processAsync();

                const params = utils.parseRequestBody(req, NetUtil);
                calendar.updateEvent(eventId, params, cal, Ci)
                  .then((result) => {
                    if (result.error) {
                      const status = result.error.includes("not found") ? 404 :
                                    result.error.includes("not available") ? 503 : 400;
                      utils.sendError(res, req.httpVersion, result.error, status);
                    } else {
                      utils.sendJson(res, req.httpVersion, result);
                    }
                    res.finish();
                  })
                  .catch((e) => {
                    logError("Error in PATCH /events/:id", e);
                    utils.sendError(res, req.httpVersion, e.message, 500);
                    res.finish();
                  });

              } else if (req.method === "DELETE" && eventId) {
                // DELETE /events/:id
                log(`DELETE /events/${eventId}`);
                res.processAsync();

                const params = utils.parseQueryString(req.queryString);
                calendar.deleteEvent(eventId, params, cal)
                  .then((result) => {
                    if (result.error) {
                      const status = result.error.includes("not found") ? 404 :
                                    result.error.includes("not available") ? 503 : 400;
                      utils.sendError(res, req.httpVersion, result.error, status);
                    } else {
                      utils.sendJson(res, req.httpVersion, result);
                    }
                    res.finish();
                  })
                  .catch((e) => {
                    logError("Error in DELETE /events/:id", e);
                    utils.sendError(res, req.httpVersion, e.message, 500);
                    res.finish();
                  });

              } else {
                utils.sendError(res, req.httpVersion, "Method not allowed", 405);
              }
            });

            // ============================================================
            // ROUTE: /addressbooks
            // ============================================================
            serverInstance.registerPathHandler("/addressbooks", (req, res) => {
              log("GET /addressbooks");
              if (req.method !== "GET") {
                utils.sendError(res, req.httpVersion, "Method not allowed", 405);
                return;
              }
              try {
                const result = contacts.listAddressBooks(MailServices);
                utils.sendJson(res, req.httpVersion, result);
              } catch (e) {
                logError("Error in GET /addressbooks", e);
                utils.sendError(res, req.httpVersion, e.message, 500);
              }
            });

            // ============================================================
            // ROUTE: /contacts
            // ============================================================
            serverInstance.registerPrefixHandler("/contacts", (req, res) => {
              const contactId = utils.extractPathParam(req.path, "/contacts/");

              if (req.method === "GET" && !contactId) {
                // GET /contacts (search)
                log(`GET /contacts?${req.queryString}`);
                try {
                  const params = utils.parseQueryString(req.queryString);
                  const result = contacts.searchContacts(params, MailServices);
                  if (result.error) {
                    utils.sendError(res, req.httpVersion, result.error);
                  } else {
                    utils.sendJson(res, req.httpVersion, result);
                  }
                } catch (e) {
                  logError("Error in GET /contacts", e);
                  utils.sendError(res, req.httpVersion, e.message, 500);
                }

              } else if (req.method === "POST" && !contactId) {
                // POST /contacts (create)
                log("POST /contacts");
                try {
                  const params = utils.parseRequestBody(req, NetUtil);
                  const result = contacts.createContact(params, MailServices, Cc, Ci);
                  if (result.error) {
                    utils.sendError(res, req.httpVersion, result.error);
                  } else {
                    utils.sendJson(res, req.httpVersion, result);
                  }
                } catch (e) {
                  logError("Error in POST /contacts", e);
                  utils.sendError(res, req.httpVersion, e.message, 500);
                }

              } else if (req.method === "PATCH" && contactId) {
                // PATCH /contacts/:id (update)
                log(`PATCH /contacts/${contactId}`);
                try {
                  const params = utils.parseRequestBody(req, NetUtil);
                  const result = contacts.updateContact(contactId, params, MailServices);
                  if (result.error) {
                    const status = result.error.includes("not found") ? 404 : 400;
                    utils.sendError(res, req.httpVersion, result.error, status);
                  } else {
                    utils.sendJson(res, req.httpVersion, result);
                  }
                } catch (e) {
                  logError("Error in PATCH /contacts/:id", e);
                  utils.sendError(res, req.httpVersion, e.message, 500);
                }

              } else if (req.method === "DELETE" && contactId) {
                // DELETE /contacts/:id
                log(`DELETE /contacts/${contactId}`);
                try {
                  const params = utils.parseQueryString(req.queryString);
                  const result = contacts.deleteContact(contactId, params, MailServices);
                  if (result.error) {
                    const status = result.error.includes("not found") ? 404 : 400;
                    utils.sendError(res, req.httpVersion, result.error, status);
                  } else {
                    utils.sendJson(res, req.httpVersion, result);
                  }
                } catch (e) {
                  logError("Error in DELETE /contacts/:id", e);
                  utils.sendError(res, req.httpVersion, e.message, 500);
                }

              } else {
                utils.sendError(res, req.httpVersion, "Method not allowed", 405);
              }
            });

            // Start server
            serverInstance.start(API_PORT);
            log(`REST API server started on port ${API_PORT}`);

            return { success: true, port: API_PORT };
          } catch (e) {
            logError("Failed to start server", e);
            return { success: false, error: e.message };
          }
        },
      },
    };
  }

  onShutdown() {
    log("Extension shutting down, stopping server...");
    if (serverInstance) {
      try {
        serverInstance.stop(() => log("Server stopped on shutdown"));
      } catch (e) {
        logError("Error stopping server on shutdown", e);
      }
      serverInstance = null;
    }
  }
};
