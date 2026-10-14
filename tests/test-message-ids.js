"use strict";

// Task 3.1: Message-ID normalisation and exact resolution.
//
// Thunderbird stores Message-IDs without angle brackets and compares
// headerMessageId exactly (plan Appendix A.1). These tests pin the single
// resolver's behaviour for GET and PATCH, including duplicates and the rule
// that numeric references are internal IDs, never Message-IDs.

const test = require("node:test");
const assert = require("node:assert/strict");
const { backgroundHarness } = require("./helpers/harness.js");

const INBOX = { id: "account1:/Inbox", name: "Inbox", accountId: "account1" };
const ARCHIVE = { id: "account1:/Archives", name: "Archives", accountId: "account1" };

function makeMessage(id, headerMessageId, folder, read = false) {
  return {
    id,
    headerMessageId,
    date: new Date("2026-10-03T10:00:00Z"),
    author: "Sender <sender@example.test>",
    recipients: ["Receiver <receiver@example.test>"],
    subject: `Synthetic ${headerMessageId}`,
    read,
    folder
  };
}

function harness() {
  const messages = [
    makeMessage(41, "shared@example.test", INBOX),   // first copy
    makeMessage(42, "shared@example.test", ARCHIVE), // duplicate copy
    makeMessage(7, "unique@example.test", INBOX),
    // A Message-ID that looks numeric must not be reachable as internal ID 999.
    makeMessage(100, "999", INBOX)
  ];
  const h = backgroundHarness({ messages, folders: [INBOX, ARCHIVE] });
  return { h, messages };
}

test("GET resolves Message-IDs with brackets, without brackets and with spaces", async () => {
  const { h } = harness();

  const cases = [
    ["HTTP route, URL-encoded %3Cid%3E", () => h.request("GET", "/messages/%3Cshared%40example.test%3E")],
    ["bare id", () => h.Email.getMessage("shared@example.test")],
    ["bracketed <id>", () => h.Email.getMessage("<shared@example.test>")],
    ["spaced  <id> ", () => h.Email.getMessage(" <shared@example.test> ")]
  ];

  for (const [label, run] of cases) {
    const raw = await run();
    const body = raw.status !== undefined ? raw.body : raw; // HTTP wrapper vs direct Email call
    assert.equal(body.message_id, "shared@example.test", label);
    assert.equal(body.id, 41, `${label}: first match wins`);
    assert.equal(body.matches, 2, `${label}: match count is reported`);
    assert.equal(h.queries.at(-1).headerMessageId, "shared@example.test", `${label}: query uses the bare id`);
  }

  assert.equal(
    h.queries.every(query => query.headerMessageId === undefined || query.headerMessageId === "shared@example.test"),
    true,
    "no query ever uses a bracketed Message-ID"
  );
});

test("GET resolves internal numeric IDs (number and numeric string), with no Message-ID fallback", async () => {
  const { h } = harness();

  for (const ref of [7, "7"]) {
    const body = await h.Email.getMessage(ref);
    assert.equal(body.id, 7, `internal ID ${JSON.stringify(ref)}`);
    assert.equal(body.message_id, "unique@example.test");
    assert.equal(body.matches, 1);
  }

  const overTheWire = await h.request("GET", "/messages/7");
  assert.equal(overTheWire.status, 200);
  assert.equal(overTheWire.body.id, 7);

  // 999 is a Message-ID of another message, but as a reference it is an
  // internal ID that does not exist: the resolver must not fall back.
  const direct = await h.Email.getMessage(999);
  assert.equal(direct.statusCode, 404);
  assert.equal(direct.code, "not_found");

  const http = await h.request("GET", "/messages/999");
  assert.equal(http.status, 404);
  assert.equal(h.queries.every(query => query.headerMessageId !== "999"), true,
    "numeric references are never queried as Message-IDs");
});

test("PATCH resolves bracketed, bare, spaced and numeric internal IDs", async () => {
  const cases = [
    ["bracketed", ["<unique@example.test>"]],
    ["bare", ["unique@example.test"]],
    ["spaced", [" <unique@example.test> "]],
    ["numeric number", [7]],
    ["numeric string", ["7"]]
  ];

  for (const [label, ids] of cases) {
    const { h } = harness();
    const result = await h.request("PATCH", "/messages", "", JSON.stringify({ ids, add_flags: ["read"] }));
    assert.equal(result.status, 200, label);
    assert.equal(result.body.success, true, label);
    assert.equal(h.updates.length, 1, `${label}: exactly one message updated`);
    assert.equal(h.updates[0].id, 7, label);
    assert.equal(h.updates[0].properties.read, true, label);
    assert.equal(h.messages[2].read, true, label);
  }
});

test("duplicate Message-ID: GET returns the first copy with matches, PATCH changes only that copy", async () => {
  const { h, messages } = harness();

  const before = await h.request("GET", "/messages/%3Cshared%40example.test%3E");
  assert.equal(before.status, 200);
  assert.equal(before.body.id, 41, "Inbox copy comes first");
  assert.equal(before.body.mailbox, "Inbox");
  assert.equal(before.body.matches, 2);

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: ["<shared@example.test>"],
    add_flags: ["read"]
  }));
  assert.equal(patch.status, 200);
  assert.equal(patch.body.success, true);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].id, 41);
  assert.equal(messages[0].read, true, "first copy updated");
  assert.equal(messages[1].read, false, "archive copy untouched");

  const after = await h.request("GET", "/messages/shared%40example.test");
  assert.equal(after.status, 200);
  assert.equal(after.body.id, 41);
  assert.equal(after.body.read, true);
  assert.equal(after.body.matches, 2);
});
