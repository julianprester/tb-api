"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function harness() {
  const folder = { id: "account1://INBOX", name: "Inbox" };
  const messages = [true, false].map((read, index) => ({
    id: index + 1,
    headerMessageId: `${read ? "read" : "unread"}@example.test`,
    date: new Date("2026-10-03T10:00:00Z"),
    author: "Sender <sender@example.test>",
    recipients: ["Receiver <receiver@example.test>"],
    subject: `Synthetic ${read ? "read" : "unread"} message`,
    read,
    flagged: !read,
    folder
  }));
  const queries = [];
  const updates = [];
  const messenger = {
    messages: {
      async query(info) {
        queries.push(info);
        return { messages: messages.filter(message =>
          (info.headerMessageId === undefined || message.headerMessageId === info.headerMessageId) &&
          (info.folderId === undefined || message.folder.id === info.folderId) &&
          (info.unread === undefined || !message.read === info.unread)
        ).map(message => ({ ...message })) };
      },
      async getFull() { return { headers: {} }; },
      async listAttachments() { return []; },
      async listInlineTextParts() { return [{ contentType: "text/plain", content: "Synthetic body" }]; },
      async update(id, properties) {
        updates.push({ id, properties });
        Object.assign(messages.find(message => message.id === id), properties);
      }
    },
    folders: {
      async get(id) {
        if (id !== folder.id) throw new Error("Folder not found");
        return folder;
      }
    }
  };
  const context = vm.createContext({
    messenger,
    browser: {
      runtime: { getManifest: () => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "tb-api", "manifest.json"), "utf8")) },
      httpServer: {
        start: async () => {},
        onRequest: { addListener() {} },
        onSendInvitation: { addListener() {} },
        refreshFolder: async id => ({ folder_id: id, refreshed: true })
      }
    },
    console: { log() {}, error() {} }
  });
  for (const name of ["api/utils.js", "api/email.js", "background.js"]) {
    const file = path.join(__dirname, "..", "tb-api", name);
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: name });
  }

  async function request(method, pathname, queryString = "", body = "") {
    const result = await context.handleRequest({ method, path: pathname, queryString, body });
    return { status: result.statusCode, body: JSON.parse(result.body) };
  }
  return { Email: context.Email, messages, queries, updates, request, folder };
}

function assertReadState(message, expected) {
  assert.equal(Object.hasOwn(message, "read"), true, "read must be present in the serialized payload");
  assert.equal(typeof message.read, "boolean", "read must never be null or undefined");
  assert.equal(message.read, expected);
  assert.equal(message.flags.includes("read"), expected, "legacy flags must remain consistent");
}

test("API discovery advertises boolean read status", async () => {
  const h = harness();
  const result = await h.request("GET", "/");
  assert.equal(result.status, 200);
  assert.match(result.body.endpoints.email["GET /messages"], /boolean read status/);
  assert.match(result.body.endpoints.email["GET /messages/:id"], /boolean read status/);
});

test("GET /messages serializes read and unread states as explicit booleans", async () => {
  const h = harness();
  const result = await h.request("GET", "/messages");
  assert.equal(result.status, 200);
  assert.equal(result.body.messages.length, 2);
  assertReadState(result.body.messages[0], true);
  assertReadState(result.body.messages[1], false);
  assert.deepEqual(result.body.messages[1].flags, ["flagged"]);
  assert.equal(h.updates.length, 0, "retrieving a message must not mark it read");
});

test("GET /messages/:id serializes the same boolean state as message lists", async () => {
  const h = harness();
  for (const message of h.messages) {
    const detail = await h.request("GET", `/messages/${encodeURIComponent(message.headerMessageId)}`);
    const list = await h.request("GET", "/messages");
    assert.equal(detail.status, 200);
    assertReadState(detail.body, message.read);
    assert.equal(detail.body.read, list.body.messages.find(item => item.message_id === message.headerMessageId).read);
    assert.equal(detail.body.body, "Synthetic body");
  }
  assert.equal(h.updates.length, 0);
});

test("read/unread search filters and aliases preserve true and false correctly", async () => {
  const h = harness();
  const cases = [
    ["read", true, true], ["read", false, false],
    ["seen", true, true], ["seen", false, false],
    ["opened", true, true], ["opened", false, false],
    ["unread", true, false], ["unread", false, true],
    ["unseen", true, false], ["unseen", false, true]
  ];
  for (const [key, value, expectedRead] of cases) {
    const result = await h.request("GET", "/messages", `${key}=${value}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.messages.length, 1, `${key}=${value} should select one state`);
    assertReadState(result.body.messages[0], expectedRead);
    assert.equal(h.queries.at(-1).unread, !expectedRead);
  }
});

test("numeric/string flag filters also serialize boolean read status", async () => {
  const h = harness();
  for (const [value, expected] of [[1, true], [0, false], ["1", true], ["0", false]]) {
    const result = await h.Email.searchMessages({ read: value });
    assert.equal(result.messages.length, 1);
    assertReadState(result.messages[0], expected);
  }
});

test("refreshed searches include read status without changing refresh metadata", async () => {
  const h = harness();
  const result = await h.request("GET", "/messages", `mailbox=${encodeURIComponent(h.folder.id)}&refresh=true`);
  assert.equal(result.status, 200);
  assert.equal(result.body.refresh.refreshed, true);
  assertReadState(result.body.messages[0], true);
  assertReadState(result.body.messages[1], false);
});

test("PATCH read flag changes are reflected by both GET endpoints", async () => {
  const h = harness();
  const id = "unread@example.test";
  for (const [action, flag, expected] of [["add_flags", "read", true], ["remove_flags", "seen", false]]) {
    const result = await h.request("PATCH", "/messages", "", JSON.stringify({ ids: [id], [action]: [flag] }));
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    const detail = await h.request("GET", `/messages/${encodeURIComponent(id)}`);
    const list = await h.request("GET", "/messages");
    assertReadState(detail.body, expected);
    assertReadState(list.body.messages.find(message => message.message_id === id), expected);
    assert.equal(h.updates.at(-1).properties.read, expected);
  }
});

test("empty results and missing-message errors do not invent read status", async () => {
  const h = harness();
  h.messages.length = 0;
  const empty = await h.request("GET", "/messages");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.messages, []);
  const missing = await h.request("GET", "/messages/missing%40example.test");
  assert.equal(missing.status, 404);
  assert.equal(typeof missing.body.error, "string");
  assert.equal(Object.hasOwn(missing.body, "read"), false);
});
