"use strict";

// Task 3.4 — strict boolean filters (D5).
//
// A supplied boolean filter must be true/false/1/0. Before this task an
// unrecognized value (`unread=yes`) parsed to `undefined` and was silently
// dropped, widening the search to everything. `read` and `unread` both wrote
// the same underlying flag, so contradictory input was last-write-wins, and
// calendar `sendInvites` treated every unrecognized value as false.
//
// Valid inputs must behave exactly as before: these tests pin both the new
// 400 invalid_filter rejections and the unchanged filtering semantics.

const test = require("node:test");
const assert = require("node:assert/strict");
const { backgroundHarness, experimentHarness } = require("./helpers/harness.js");

const json = { "Content-Type": "application/json" };

// Four messages covering every combination of the three filters:
//   1 unread, flagged, not junk      3 read, flagged, junk
//   2 read, not flagged, not junk    4 unread, not flagged, junk
function emailHarness() {
  const folder = { id: "account1://INBOX", name: "Inbox" };
  const messages = [
    { id: 1, headerMessageId: "unread-flagged@example.test", date: new Date("2026-10-03T10:00:00Z"), read: false, flagged: true, junk: false, folder },
    { id: 2, headerMessageId: "read-flagged@example.test", date: new Date("2026-10-03T11:00:00Z"), read: true, flagged: false, junk: false, folder },
    { id: 3, headerMessageId: "read-junk@example.test", date: new Date("2026-10-03T12:00:00Z"), read: true, flagged: true, junk: true, folder },
    { id: 4, headerMessageId: "unread-junk@example.test", date: new Date("2026-10-03T13:00:00Z"), read: false, flagged: false, junk: true, folder }
  ];
  return backgroundHarness({ messages, folders: [folder] });
}

// Harness values come from a vm realm, so normalize arrays before comparing.
// Expected ID lists are newest first (Task 3.5 / D6), matching the fixture
// dates 13:00, 12:00, 11:00, 10:00 for IDs 4, 3, 2, 1.
const ids = body => Array.from(body.messages, message => message.id);

// ---------------------------------------------------------------------------
// Email search filters
// ---------------------------------------------------------------------------

test("a supplied but invalid boolean filter is 400 invalid_filter, before any query", async () => {
  const h = emailHarness();
  const invalid = [
    ["unread", "unread=yes"],
    ["unread", "unread="],
    ["read", "read=maybe"],
    ["read", "read="],
    ["flagged", "flagged=maybe"],
    ["flagged", "flagged=2"],
    ["junk", "junk="],
    ["junk", "junk=yes"]
  ];
  for (const [name, queryString] of invalid) {
    const result = await h.request("GET", "/messages", queryString);
    assert.equal(result.status, 400, `${queryString} must be rejected`);
    assert.equal(result.body.code, "invalid_filter");
    assert.match(result.body.error, new RegExp(`^${name} `), `${queryString} names the offending parameter`);
    assert.match(result.body.error, /true, false, 1 or 0/);
  }
  assert.equal(h.queries.length, 0, "an invalid filter must never be silently dropped into a query");
});

test("invalid filter values behind aliases are rejected under the canonical name", async () => {
  const h = emailHarness();
  const aliases = [
    ["unread", "unseen=yes"],
    ["read", "seen=maybe"],
    ["read", "opened=2"],
    ["flagged", "starred=maybe"],
    ["flagged", "important=yes"],
    ["flagged", "flag="],
    ["junk", "spam=maybe"]
  ];
  for (const [name, queryString] of aliases) {
    const result = await h.request("GET", "/messages", queryString);
    assert.equal(result.status, 400, `${queryString} must be rejected`);
    assert.equal(result.body.code, "invalid_filter");
    assert.match(result.body.error, new RegExp(`^${name} `));
  }
  assert.equal(h.queries.length, 0);
});

test("contradictory read/unread filters are 400 invalid_filter before any query", async () => {
  const h = emailHarness();
  const contradictions = [
    "read=true&unread=true",
    "read=false&unread=false",
    "read=1&unread=1",
    "read=0&unread=0",
    "seen=true&unseen=true",
    "read=true&unseen=true",
    "read=false&unseen=false"
  ];
  for (const queryString of contradictions) {
    const result = await h.request("GET", "/messages", queryString);
    assert.equal(result.status, 400, `${queryString} contradicts itself`);
    assert.equal(result.body.code, "invalid_filter");
    assert.match(result.body.error, /contradict/);
  }
  assert.equal(h.queries.length, 0, "a contradictory filter must never reach messages.query");
});

test("consistent read/unread pairs are accepted and select the same state", async () => {
  const h = emailHarness();
  const cases = [
    ["read=true&unread=false", false, [3, 2]],
    ["read=false&unread=true", true, [4, 1]],
    ["read=1&unseen=0", false, [3, 2]],
    ["read=0&unseen=1", true, [4, 1]]
  ];
  for (const [queryString, expectedUnread, expectedIds] of cases) {
    const result = await h.request("GET", "/messages", queryString);
    assert.equal(result.status, 200, `${queryString} must be accepted`);
    assert.deepEqual(ids(result.body), expectedIds);
    assert.equal(h.queries.at(-1).unread, expectedUnread, `${queryString} normalizes to unread=${expectedUnread}`);
  }
});

test("true/false/1/0 still filter unread, read, flagged and junk exactly as before", async () => {
  const h = emailHarness();
  const expectations = {
    unread: { true: [4, 1], false: [3, 2] },
    read: { true: [3, 2], false: [4, 1] },
    flagged: { true: [3, 1], false: [4, 2] },
    junk: { true: [4, 3], false: [2, 1] }
  };
  for (const [name, byValue] of Object.entries(expectations)) {
    for (const [expectedKey, expectedIds] of Object.entries(byValue)) {
      const expected = expectedKey === "true";
      for (const value of [expectedKey, expected ? 1 : 0, expected ? "1" : "0"]) {
        const result = await h.request("GET", "/messages", `${name}=${value}`);
        assert.equal(result.status, 200, `${name}=${value}`);
        assert.deepEqual(ids(result.body), expectedIds, `${name}=${value}`);
        const expectedUnread = name === "unread" ? expected : name === "read" ? !expected : undefined;
        assert.equal(h.queries.at(-1).unread, expectedUnread, `${name}=${value} query filter`);
      }
    }
  }
});

test("programmatic boolean values are accepted unchanged", async () => {
  const h = emailHarness();
  assert.deepEqual(ids(await h.Email.searchMessages({ unread: true })), [4, 1]);
  assert.deepEqual(ids(await h.Email.searchMessages({ unread: false })), [3, 2]);
  assert.deepEqual(ids(await h.Email.searchMessages({ read: false })), [4, 1]);
  assert.deepEqual(ids(await h.Email.searchMessages({ flagged: 1 })), [3, 1]);
  assert.deepEqual(ids(await h.Email.searchMessages({ junk: 0 })), [2, 1]);
});

test("invalid refresh keeps its existing invalid_refresh error and never searches", async () => {
  const h = emailHarness();
  const result = await h.request("GET", "/messages", "mailbox=Inbox&refresh=yes");
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "invalid_refresh");
  assert.equal(h.queries.length, 0, "an invalid refresh must not fall back to a search");
});

// ---------------------------------------------------------------------------
// Calendar sendInvites
// ---------------------------------------------------------------------------

const EVENT = { title: "Standup", start: "2030-01-01T10:00:00", end: "2030-01-01T11:00:00" };
const ORGANIZER = "organizer@example.test";
const IDENTITIES = [{ id: "id1", email: ORGANIZER, name: "Organizer" }];
const INVITE = { ...EVENT, organizer: ORGANIZER, attendees: ["guest@example.test"] };

async function postEvent(h, sendInvites) {
  const payload = sendInvites === undefined ? INVITE : { ...INVITE, sendInvites };
  return h.request("POST", "/events", { headers: json, body: JSON.stringify(payload) });
}

// Task 5.4: sendInvites stays the strict boolean alias (3.4), but true now
// means "prepare an invitation draft" (inviteMode default), not "send now".
test("calendar sendInvites absent or valid keeps its old meaning", async t => {
  for (const [value, expected] of [
    [undefined, false], [false, false], ["false", false], [0, false], ["0", false],
    [true, true], ["true", true], [1, true], ["1", true]
  ]) {
    const h = experimentHarness({ t, identities: IDENTITIES });
    const result = await postEvent(h, value);
    assert.equal(result.status, 201, `sendInvites=${String(value)}`);
    assert.equal(result.body.success, true);
    assert.equal(result.body.invitesSent, undefined, "no assumed invite status");
    assert.equal(result.body.invitesPending, undefined);
    if (expected) {
      assert.equal(result.body.invitations.status, "draft_saved", `sendInvites=${String(value)}`);
    } else {
      assert.equal(result.body.invitations, undefined);
    }
    assert.equal(h.cal.manager.getCalendars()[0].items.length, 1, "the event is created either way");
  }
});

test("calendar sendInvites with an invalid supplied value is 400 invalid_filter, event not created", async t => {
  for (const value of ["yes", "maybe", "TRUE", 2, -1, "", null, {}, []]) {
    const h = experimentHarness({ t });
    const result = await postEvent(h, value);
    assert.equal(result.status, 400, `sendInvites=${JSON.stringify(value)} must be rejected`);
    assert.equal(result.body.code, "invalid_filter");
    assert.match(result.body.error, /sendInvites must be true, false, 1 or 0/);
    assert.equal(h.cal.manager.getCalendars()[0].items.length, 0, "no event may be created");
  }
});
