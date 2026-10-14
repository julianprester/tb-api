"use strict";

// Focused tests for PATCH /messages (Task 3.2): flags and move in one request,
// honest per-message results, and flag validation.
//
// The harness runs production code in a vm realm, so values it creates have
// foreign prototypes; clone them before deep comparisons.

const test = require("node:test");
const assert = require("node:assert/strict");
const { backgroundHarness } = require("./helpers/harness.js");

const plain = value => JSON.parse(JSON.stringify(value));

const INBOX = { id: "account1:/Inbox", name: "Inbox", role: "inbox" };
const ARCHIVE = { id: "account1:/Archive", name: "Archive", role: "archives" };

/**
 * Two read messages in the Inbox plus an Archive folder.
 *
 * `recordCalls` captures the fake messenger calls in order (flags first, then
 * move, per message). `failMove(id)` makes the move throw for that message.
 */
function harness({ recordCalls, failMove } = {}) {
  const messages = [
    { id: 1, headerMessageId: "one@example.test", read: true, flagged: false, junk: false, folder: INBOX },
    { id: 2, headerMessageId: "two@example.test", read: true, flagged: false, junk: false, folder: INBOX }
  ];
  const overrides = {
    async move(ids, folderId) {
      if (recordCalls) recordCalls.push({ op: "move", ids: [...ids], folderId });
      if (failMove && failMove(ids[0])) throw new Error("synthetic move failure");
      const moved = messages.filter(message => ids.includes(message.id));
      for (const message of moved) message.folder = { ...message.folder, id: folderId };
    }
  };
  if (recordCalls) {
    overrides.update = async (id, properties) => {
      recordCalls.push({ op: "update", id, properties: { ...properties } });
      const message = messages.find(candidate => candidate.id === id);
      if (message) Object.assign(message, properties);
    };
  }
  const h = backgroundHarness({ folders: [INBOX, ARCHIVE], messages, messenger: { messages: overrides } });
  return { h, messages };
}

test("flags and move in one request are applied to the same message, flags first", async () => {
  const calls = [];
  const { h, messages } = harness({ recordCalls: calls });

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1],
    add_flags: ["read", "starred"],
    move_to: "Archive"
  }));

  assert.equal(patch.status, 200);
  assert.equal(patch.body.success, true);
  assert.equal(patch.body.updated, 1);
  assert.equal(patch.body.moved, 1);
  assert.deepEqual(plain(patch.body.results), [
    { ref: 1, id: 1, updated: true, moved: true }
  ]);

  // Both operations, in that order, on the same internal ID.
  assert.deepEqual(calls, [
    { op: "update", id: 1, properties: { read: true, flagged: true } },
    { op: "move", ids: [1], folderId: "account1:/Archive" }
  ]);
  assert.equal(messages[0].read, true);
  assert.equal(messages[0].flagged, true, "the ignored-on-move bug must stay fixed");
});

test("a move failing for one of two messages returns 207 with per-message results", async () => {
  const calls = [];
  const { h, messages } = harness({ recordCalls: calls, failMove: id => id === 2 });

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1, 2],
    add_flags: ["read"],
    move_to: "Archive"
  }));

  assert.equal(patch.status, 207);
  assert.equal(patch.body.success, false);
  assert.equal(patch.body.partial, true);
  assert.equal(patch.body.statusCode, undefined, "statusCode drives the HTTP status, it is not serialized");
  assert.equal(patch.body.updated, 2, "flags are applied to both before the move");
  assert.equal(patch.body.moved, 1);

  const results = plain(patch.body.results);
  assert.deepEqual(results[0], { ref: 1, id: 1, updated: true, moved: true });
  assert.deepEqual(results[1], {
    ref: 2, id: 2, updated: true, moved: false, error: "Failed to move: synthetic move failure"
  });

  // Message 1 was updated then moved; message 2 was updated, its move threw.
  assert.deepEqual(calls, [
    { op: "update", id: 1, properties: { read: true } },
    { op: "move", ids: [1], folderId: "account1:/Archive" },
    { op: "update", id: 2, properties: { read: true } },
    { op: "move", ids: [2], folderId: "account1:/Archive" }
  ]);
  assert.equal(messages[0].folder.id, "account1:/Archive");
});

test("all moves failing is a 502 update_failed, never success: true", async () => {
  const { h } = harness({ failMove: () => true });

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1, 2],
    move_to: "Archive"
  }));

  assert.equal(patch.status, 502);
  assert.equal(patch.body.code, "update_failed");
  assert.notEqual(patch.body.success, true);
  assert.equal(patch.body.updated, 0);
  assert.equal(patch.body.moved, 0);
  assert.deepEqual(plain(patch.body.results), [
    { ref: 1, id: 1, updated: false, moved: false, error: "Failed to move: synthetic move failure" },
    { ref: 2, id: 2, updated: false, moved: false, error: "Failed to move: synthetic move failure" }
  ]);
});

test("add_flags unread marks read=false; remove_flags unread marks read=true", async () => {
  const { h, messages } = harness();

  const add = await h.request("PATCH", "/messages", "", JSON.stringify({ ids: [1], add_flags: ["unread"] }));
  assert.equal(add.status, 200);
  assert.equal(add.body.success, true);
  assert.deepEqual(plain(h.updates.at(-1).properties), { read: false });
  assert.equal(messages[0].read, false, "add unread => read=false");

  const remove = await h.request("PATCH", "/messages", "", JSON.stringify({ ids: [1], remove_flags: ["unseen"] }));
  assert.equal(remove.status, 200);
  assert.deepEqual(plain(h.updates.at(-1).properties), { read: true });
  assert.equal(messages[0].read, true, "remove unread/unseen => read=true");
});

test("an unknown flag is a 400 that changes nothing", async () => {
  const calls = [];
  const { h, messages } = harness({ recordCalls: calls });

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1],
    add_flags: ["read", "bogus"],
    move_to: "Archive"
  }));

  assert.equal(patch.status, 400);
  assert.equal(patch.body.code, "invalid_parameter");
  assert.match(patch.body.error, /bogus/, "the unknown flag is named");
  assert.deepEqual(calls, [], "validation happens before any update or move");
  assert.equal(h.updates.length, 0);
  assert.equal(messages[0].read, true);
  assert.equal(messages[0].folder.id, "account1:/Inbox");
});

test("a flag in both add_flags and remove_flags is a 400 that changes nothing", async () => {
  const { h } = harness();

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1],
    add_flags: ["read"],
    remove_flags: ["read"]
  }));

  assert.equal(patch.status, 400);
  assert.equal(patch.body.code, "invalid_parameter");
  assert.equal(h.updates.length, 0);

  // Same conflict through an alias: add read + remove seen.
  const inverse = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1],
    add_flags: ["read"],
    remove_flags: ["seen"]
  }));
  assert.equal(inverse.status, 400);
  assert.equal(inverse.body.code, "invalid_parameter");

  // And through the inverse alias against itself: add unread + remove unread.
  const inverseAlias = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1],
    add_flags: ["unread"],
    remove_flags: ["unread"]
  }));
  assert.equal(inverseAlias.status, 400);
  assert.equal(inverseAlias.body.code, "invalid_parameter");
  assert.equal(h.updates.length, 0);
});

test("flags-only and move-only requests still work", async () => {
  const { h, messages } = harness();

  const flagsOnly = await h.request("PATCH", "/messages", "", JSON.stringify({ ids: [1], flags: ["junk"] }));
  assert.equal(flagsOnly.status, 200);
  assert.equal(flagsOnly.body.success, true);
  assert.equal(flagsOnly.body.updated, 1);
  assert.equal(flagsOnly.body.moved, 0);
  assert.deepEqual(plain(flagsOnly.body.results), [{ ref: 1, id: 1, updated: true, moved: false }]);
  assert.deepEqual(plain(h.updates.at(-1).properties), { junk: true });

  const moveOnly = await h.request("PATCH", "/messages", "", JSON.stringify({ ids: [1], move_to: "Archive" }));
  assert.equal(moveOnly.status, 200);
  assert.equal(moveOnly.body.success, true);
  assert.equal(moveOnly.body.updated, 0);
  assert.equal(moveOnly.body.moved, 1);
  assert.deepEqual(plain(moveOnly.body.results), [{ ref: 1, id: 1, updated: false, moved: true }]);
  assert.equal(messages[0].folder.id, "account1:/Archive");
});

test("an unresolved ref alongside a successful one returns 207 with not_found", async () => {
  const { h } = harness();

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1, "missing@example.test"],
    add_flags: ["read"]
  }));

  assert.equal(patch.status, 207);
  assert.equal(patch.body.success, false);
  assert.equal(patch.body.partial, true);
  assert.equal(patch.body.updated, 1);
  assert.deepEqual(patch.body.not_found, ["missing@example.test"]);
  assert.deepEqual(plain(patch.body.results), [{ ref: 1, id: 1, updated: true, moved: false }]);
});

test("every id unresolved is still a 404 not_found that lists the refs", async () => {
  const { h } = harness();

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: ["missing@example.test"],
    add_flags: ["read"]
  }));

  assert.equal(patch.status, 404);
  assert.equal(patch.body.code, "not_found");
  assert.deepEqual(patch.body.not_found, ["missing@example.test"]);
  assert.equal(h.updates.length, 0);
});

test("an unresolvable destination is rejected before any flag update", async () => {
  const { h, messages } = harness();

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1],
    add_flags: ["read"],
    move_to: "No Such Folder"
  }));

  assert.equal(patch.status, 404);
  assert.equal(patch.body.code, "folder_not_found");
  assert.equal(h.updates.length, 0, "destination validation precedes the flag updates");
  assert.equal(messages[0].read, true);
  assert.equal(messages[0].folder.id, "account1:/Inbox");
});

test("no action at all is a 400 invalid_parameter", async () => {
  const { h } = harness();

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({ ids: [1] }));
  assert.equal(patch.status, 400);
  assert.equal(patch.body.code, "invalid_parameter");
  assert.equal(h.updates.length, 0);
});
