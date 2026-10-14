"use strict";

// Regression tests for the twelve bugs reproduced during the review (plan 0.2).
// Each case is added by the task that fixes it; this file was created by Task
// 2.1. All twelve cases are present below; the last one (5.2) was added by the
// 5.1+5.2 batch.

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

test("5.2: GET /events?start=garbage -> 400 invalid_date (was a 500)", async t => {
  const h = experimentHarness({ t });
  const result = await h.request("GET", "/events", { queryString: "start=garbage" });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "invalid_date");
  assert.equal(h.instance.pendingRequests.size, 0, "no request may be left pending");
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
  assert.equal(patch.body.code, "folder_not_found");
  assert.equal(moved.length, 0, "a fuzzy destination must never move mail");
  assert.equal(h.messages[0].folder.id, "account1:/Inbox");
});

test("3.2: PATCH move_to + add_flags applies both to the same message", async () => {
  const inbox = { id: "account1:/Inbox", name: "Inbox", role: "inbox" };
  const moved = [];
  const h = backgroundHarness({
    folders: [inbox, { id: "account1:/Archive", name: "Archive" }],
    messages: [{ id: 1, headerMessageId: "both@example.test", read: false, folder: inbox }],
    messenger: {
      messages: {
        async move(ids, folderId) { moved.push({ ids, folderId }); }
      }
    }
  });

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1],
    add_flags: ["read"],
    move_to: "Archive"
  }));
  assert.equal(patch.status, 200);
  assert.equal(patch.body.success, true);
  assert.equal(patch.body.updated, 1);
  assert.equal(patch.body.moved, 1);
  assert.equal(h.updates.length, 1, "the flags must not be lost to the move");
  assert.equal(h.updates[0].id, 1);
  assert.equal(h.updates[0].properties.read, true);
  assert.deepEqual(plain(moved), [{ ids: [1], folderId: "account1:/Archive" }]);
});

test("3.2: PATCH with every move failing is not success: true", async () => {
  const inbox = { id: "account1:/Inbox", name: "Inbox", role: "inbox" };
  const h = backgroundHarness({
    folders: [inbox, { id: "account1:/Archive", name: "Archive" }],
    messages: [
      { id: 1, headerMessageId: "fail1@example.test", folder: inbox },
      { id: 2, headerMessageId: "fail2@example.test", folder: inbox }
    ],
    messenger: {
      messages: {
        async move() { throw new Error("synthetic move failure"); }
      }
    }
  });

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1, 2],
    move_to: "Archive"
  }));
  assert.equal(patch.status, 502);
  assert.equal(patch.body.code, "update_failed");
  assert.notEqual(patch.body.success, true, "a failed move must never report success");
  assert.equal(patch.body.results.length, 2);
});

test("3.2: PATCH flags: [\"unread\"] marks the message unread", async () => {
  const inbox = { id: "account1:/Inbox", name: "Inbox", role: "inbox" };
  const h = backgroundHarness({
    folders: [inbox],
    messages: [{ id: 1, headerMessageId: "unread-regression@example.test", read: true, folder: inbox }]
  });

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1],
    flags: ["unread"]
  }));
  assert.equal(patch.status, 200);
  assert.equal(patch.body.success, true);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].properties.read, false);
  assert.equal(h.messages[0].read, false);
});

test("3.4: unread=yes -> 400 invalid_filter (no silently widened search)", async () => {
  const h = backgroundHarness();

  const result = await h.request("GET", "/messages", "unread=yes");
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "invalid_filter");
  assert.match(result.body.error, /unread/);
  assert.equal(h.queries.length, 0, "an invalid filter must never be dropped into a query");
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

// C1: PATCH /events/:id used to removeAllAttendees() first, persist the
// attendee-less clone and only then fail (500) while building the response for
// a non-array `attendees`. The input is now rejected up front, exactly like
// createEvent does, with nothing modified.
test("C1: PATCH attendees with a non-array is 400 invalid_parameter and changes nothing", async t => {
  const h = experimentHarness({
    t,
    items: [{
      id: "c1-event",
      title: "Standup",
      start: "2030-01-01T10:00:00",
      end: "2030-01-01T11:00:00",
      attendees: ["alice@example.test", "bob@example.test"]
    }]
  });
  const calendar = h.cal.manager.getCalendars()[0];
  const modifies = [];
  const originalModify = calendar.modifyItem.bind(calendar);
  calendar.modifyItem = async (newItem, oldItem) => {
    modifies.push({ newItem, oldItem });
    return originalModify(newItem, oldItem);
  };

  for (const attendees of ["alice@example.test", { email: "alice@example.test" }]) {
    const result = await h.request("PATCH", "/events/c1-event", {
      queryString: "calendar=test-calendar",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attendees })
    });
    assert.equal(result.status, 400, JSON.stringify(attendees));
    assert.equal(result.body.code, "invalid_parameter", JSON.stringify(attendees));
    assert.match(result.body.error, /Attendees must be an array/);
    assert.equal(modifies.length, 0, "nothing may be persisted");
    assert.equal(calendar.items[0].getAttendees().length, 2, "attendees must still be two");
  }

  // The valid array form still replaces every attendee; null (like []) keeps
  // the documented "replaces all" meaning of removing them.
  const replaced = await h.request("PATCH", "/events/c1-event", {
    queryString: "calendar=test-calendar",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attendees: ["carol@example.test"] })
  });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.equal(calendar.items[0].getAttendees().length, 1);
  assert.equal(calendar.items[0].getAttendees()[0].id, "mailto:carol@example.test");

  const removed = await h.request("PATCH", "/events/c1-event", {
    queryString: "calendar=test-calendar",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attendees: null })
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(calendar.items[0].getAttendees().length, 0);
});
