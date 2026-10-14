"use strict";

// Task 2.2: every request gets exactly one response.
//
// Malformed calendar input is a 400 (not an unhandled rejection), a request
// with no background listener is a 503, an unanswered request is finished by
// the 120 s watchdog (504), and shutdown finishes what is still pending (503).
// All requests go through the real prefix handler with a deterministic clock.
const test = require("node:test");
const assert = require("node:assert/strict");
const { experimentHarness, flush } = require("./helpers/harness.js");

test("malformed JSON body on /events is answered 400 without a pending leak", async t => {
  const h = experimentHarness({ t });

  const invalid = await h.request("POST", "/events", {
    body: "{not json",
    headers: { "Content-Type": "application/json" }
  });
  assert.equal(invalid.status, 400);

  // A valid JSON value that is not an object is a RequestError: 400 plus code.
  const notAnObject = await h.request("POST", "/events", {
    body: "[]",
    headers: { "Content-Type": "application/json" }
  });
  assert.equal(notAnObject.status, 400);
  assert.equal(notAnObject.body.code, "invalid_body");

  assert.equal(h.instance.pendingRequests.size, 0, "no request may be left pending");
  assert.equal(h.clock.timers.size, 0, "the watchdog must be cleared with the response");
});

test("a malformed percent-escape on /events is answered 400 without a pending leak", async t => {
  const h = experimentHarness({ t });
  const response = await h.request("GET", "/events", { queryString: "start=%E0%A4%A" });
  assert.equal(response.status, 400);
  assert.equal(h.instance.pendingRequests.size, 0);
  assert.equal(h.clock.timers.size, 0);
});

test("a request with no background listener is answered 503 api_not_ready", async t => {
  const h = experimentHarness({ t, noRequestListener: true });
  const response = await h.request("GET", "/messages");
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "api_not_ready");
  assert.equal(h.count("background-request"), 0);
  assert.equal(h.instance.pendingRequests.size, 0);
  assert.equal(h.clock.timers.size, 0);
});

test("an unanswered request is finished with 504 exactly on the 120 s watchdog", async t => {
  const h = experimentHarness({ t });
  // Replace the background listener with one that never settles: only the
  // watchdog can answer this request.
  h.api.onRequest.addListener(() => new Promise(() => {}));

  const pending = h.request("GET", "/messages");
  await flush();
  assert.equal(h.instance.pendingRequests.size, 1, "the request is stored as pending");

  h.clock.tick(119999);
  assert.equal(h.instance.pendingRequests.size, 1, "the watchdog must not fire early");

  h.clock.tick(1);
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal(response.body.code, "request_timeout");
  assert.equal(h.instance.pendingRequests.size, 0);
  assert.equal(h.clock.timers.size, 0);
});

test("a rejecting background handler is answered 500 instead of hanging", async t => {
  const h = experimentHarness({ t });
  h.api.onRequest.addListener(() => {
    throw new Error("synthetic handler failure");
  });

  const response = await h.request("GET", "/messages");
  assert.equal(response.status, 500);
  assert.equal(response.body.error, "synthetic handler failure");
  assert.equal(h.instance.pendingRequests.size, 0);
  assert.equal(h.clock.timers.size, 0);
});

test("a background handler that cannot serialise its result still sends a 500", async t => {
  const h = experimentHarness({ t });
  // Handle.404 calls Utils.errorResponse, so making it throw forces
  // handleRequest() itself to reject.
  h.Utils.errorResponse = () => {
    throw new Error("synthetic serialisation failure");
  };

  const response = await h.request("GET", "/does-not-exist");
  assert.equal(response.status, 500);
  assert.equal(response.body.error, "Internal server error");
  assert.equal(h.instance.pendingRequests.size, 0);
  assert.equal(h.clock.timers.size, 0);
});

test("stop() finishes pending responses with 503", async t => {
  const h = experimentHarness({ t });
  h.api.onRequest.addListener(() => new Promise(() => {}));

  const pending = h.request("GET", "/messages");
  await flush();
  assert.equal(h.instance.pendingRequests.size, 1);

  await h.api.stop();
  const response = await pending;
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "api_not_ready");
  assert.equal(h.instance.pendingRequests.size, 0);
  assert.equal(h.clock.timers.size, 0);
});

test("close() finishes pending responses with 503", async t => {
  const h = experimentHarness({ t });
  h.api.onRequest.addListener(() => new Promise(() => {}));

  const pending = h.request("GET", "/messages");
  await flush();
  assert.equal(h.instance.pendingRequests.size, 1);

  h.instance.close();
  const response = await pending;
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "api_not_ready");
  assert.equal(h.instance.pendingRequests.size, 0);
  assert.equal(h.clock.timers.size, 0);
});
