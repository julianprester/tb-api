"use strict";

// Regression tests for the twelve bugs reproduced during the review (plan 0.2).
// Each case is added by the task that fixes it; this file was created by Task
// 2.1. Cases not yet present, with their owning task:
//
//   2.4  GET /contacts?q=alice returns only Alice
//   2.5  before=next week parses for email (and the end-to-end date parsing for
//        end=next+week / start=next monday, which needs Utils.parseDate)
//   3.1  GET /messages/%3Cid%3E and PATCH ids:["<id>"] find the message
//   3.2  PATCH move_to + add_flags applies both; all moves failing -> not
//        success; flags: ["unread"] marks unread
//   3.3  move_to "Archive 2023" with only "Archive 2022" -> 404, nothing moved
//   3.4  unread=yes -> 400 invalid_filter
//   5.2  GET /events?start=garbage -> 400

const test = require("node:test");
const assert = require("node:assert/strict");
const { backgroundHarness, experimentHarness } = require("./helpers/harness.js");

// Utils returns values created in the harness vm realm, so their prototypes
// differ from the test realm's. Clone them before deep comparisons.
const plain = value => JSON.parse(JSON.stringify(value));

test("2.1: end=next+week decodes to \"next week\"", () => {
  const h = backgroundHarness();
  assert.deepEqual(plain(h.Utils.parseQueryString("end=next+week")), { end: "next week" });
  assert.deepEqual(plain(h.Utils.parseRequestParams("end=next+week", "")), { end: "next week" });
});

test("Malformed JSON / bad % on /events → 400 (no hang, no pending leak)", async t => {
  const h = experimentHarness({ t });

  const invalidBody = await h.request("POST", "/events", {
    body: "{not json",
    headers: { "Content-Type": "application/json" }
  });
  assert.equal(invalidBody.status, 400);
  assert.equal(h.instance.pendingRequests.size, 0);

  const invalidQuery = await h.request("GET", "/events", { queryString: "start=%E0%A4%A" });
  assert.equal(invalidQuery.status, 400);
  assert.equal(h.instance.pendingRequests.size, 0);
});
