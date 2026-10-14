"use strict";

// Regression tests for the twelve bugs reproduced during the review (plan 0.2).
// Each case is added by the task that fixes it; this file was created by Task
// 2.1. The 2.1/2.4/2.5/3.1/3.3 cases are present below; the remaining cases,
// with their owning task:
//
//   3.2  PATCH move_to + add_flags applies both; all moves failing -> not
//        success; flags: ["unread"] marks unread
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

test("2.4: GET /contacts?q=alice returns only Alice", async () => {
  const h = backgroundHarness({
    messenger: {
      addressBooks: {
        async list() { return [{ id: "book1", name: "Personal", readOnly: false }]; }
      },
      contacts: {
        async list() {
          return [
            { id: "alice", parentId: "book1", properties: { PrimaryEmail: "alice@example.test", DisplayName: "Alice Anderson" } },
            { id: "bob", parentId: "book1", properties: { PrimaryEmail: "bob@example.test", DisplayName: "Bob Brown" } }
          ];
        }
      }
    }
  });

  const result = await h.request("GET", "/contacts", "q=alice");
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 1);
  assert.deepEqual(result.body.contacts.map(contact => contact.id), ["alice"]);
});

test("2.5: end=next week, before=next week and start=next monday parse end-to-end", async t => {
  const h = experimentHarness({ t });

  // Email aliases map end -> before. Both used to fail because the shared
  // Utils.parseDate did not know "next week".
  const emailEnd = await h.request("GET", "/messages", { queryString: "end=next+week" });
  assert.equal(emailEnd.status, 200);
  assert.equal(h.queries[0].toDate.getHours(), 0, "next week is local midnight");

  const emailBefore = await h.request("GET", "/messages", { queryString: "before=next+week" });
  assert.equal(emailBefore.status, 200);
  assert.equal(h.queries[1].toDate.getHours(), 0, "next week is local midnight");

  // Calendar's local parser knew "next week" but not "next monday".
  const calendarStart = await h.request("GET", "/events", { queryString: "start=next+monday" });
  assert.equal(calendarStart.status, 200);
  const calendarEnd = await h.request("GET", "/events", { queryString: "end=next+week" });
  assert.equal(calendarEnd.status, 200);
});

test("3.1: GET /messages/%3Cid%3E and PATCH ids:[\"<id>\"] find the message", async () => {
  const folder = { id: "account1:/Inbox", name: "Inbox", accountId: "account1" };
  const h = backgroundHarness({
    messages: [{ id: 1, headerMessageId: "bracketed@example.test", read: false, folder }],
    folders: [folder]
  });

  const get = await h.request("GET", "/messages/%3Cbracketed%40example.test%3E");
  assert.equal(get.status, 200);
  assert.equal(get.body.id, 1);
  assert.equal(get.body.message_id, "bracketed@example.test");
  assert.equal(h.queries.at(-1).headerMessageId, "bracketed@example.test",
    "the bracketed path is normalized before querying");

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: ["<bracketed@example.test>"],
    add_flags: ["read"]
  }));
  assert.equal(patch.status, 200);
  assert.equal(patch.body.success, true);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].id, 1);
  assert.equal(h.updates[0].properties.read, true);
  assert.equal(h.messages[0].read, true);
});

test("3.3: move_to \"Archive 2023\" with only \"Archive 2022\" -> 404, nothing moved", async () => {
  const inbox = { id: "account1:/Inbox", name: "Inbox", role: "inbox" };
  const moved = [];
  const h = backgroundHarness({
    folders: [inbox, { id: "account1:/Archive 2022", name: "Archive 2022" }],
    messages: [{ id: 1, headerMessageId: "regression@example.test", folder: inbox }],
    messenger: {
      messages: {
        async move(ids, folderId) { moved.push({ ids, folderId }); }
      }
    }
  });

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1],
    move_to: "Archive 2023"
  }));
  assert.equal(patch.status, 404);
  assert.equal(patch.body.code, "not_found");
  assert.equal(moved.length, 0, "a fuzzy destination must never move mail");
  assert.equal(h.messages[0].folder.id, "account1:/Inbox");
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
