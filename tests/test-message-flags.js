"use strict";

// Task 3.6 — honest attachment and message flags.
//
// MessageHeader has no attachment, draft, answered or forwarded fields
// (Appendix A.2), so `has_attachment` is discovered through the MIME tree and
// `answered`/`forwarded` through the experiment's message manager. These tests
// pin the per-message batching, the `include_preview` opt-out, the derived
// `draft` flag, the `junk` flag, and the fallback that omits unknown flags
// rather than fabricating false.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { backgroundHarness, experimentHarness } = require("./helpers/harness.js");

// Harness values come from a vm realm, so clone arrays/objects before
// deep comparisons.
const plain = value => JSON.parse(JSON.stringify(value));

const INBOX = { id: "account1:/Inbox", name: "Inbox", specialUse: ["inbox"] };

function makeMessage(id, overrides = {}) {
  return {
    id,
    headerMessageId: `msg-${id}@example.test`,
    date: new Date(Date.UTC(2026, 0, 1) + id * 60000),
    author: `Sender ${id} <sender${id}@example.test>`,
    recipients: ["Receiver <receiver@example.test>"],
    subject: `Message ${id}`,
    read: false,
    folder: INBOX,
    ...overrides
  };
}

const byId = messages => Object.fromEntries(messages.map(message => [message.id, message]));

test("has_attachment is true exactly when listAttachments returns entries", async () => {
  const opened = [];
  const h = backgroundHarness({
    folders: [INBOX],
    messages: [makeMessage(1), makeMessage(2), makeMessage(3)],
    messenger: {
      messages: {
        async listAttachments(id) {
          opened.push(id);
          return id === 2
            ? [{ name: "report.pdf", size: 42, contentType: "application/pdf" }]
            : [];
        }
      }
    }
  });

  const result = await h.Email.searchMessages({ limit: 10 });
  const messages = byId(result.messages);

  assert.equal(messages[1].has_attachment, false);
  assert.equal(messages[2].has_attachment, true);
  assert.equal(messages[3].has_attachment, false);
  assert.deepEqual(opened.sort(), [1, 2, 3], "every returned message is checked once");
});

test("has_attachment is omitted when the attachment check throws (M9)", async () => {
  const h = backgroundHarness({
    folders: [INBOX],
    messages: [makeMessage(1)],
    messenger: {
      messages: {
        async listAttachments() { throw new Error("synthetic MIME failure"); }
      }
    }
  });

  const result = await h.Email.searchMessages({ limit: 10 });
  assert.equal(result.messages.length, 1);
  assert.equal(
    Object.hasOwn(result.messages[0], "has_attachment"),
    false,
    "an unavailable MIME tree is unknown, not has_attachment: false"
  );
  assert.equal(Object.hasOwn(result.messages[0], "preview"), true, "the preview key is still reported");
});

test("attachment checks run only for returned matches and share the 8-slot batch", async () => {
  let active = 0;
  let maxActive = 0;
  const opened = [];
  const h = backgroundHarness({
    messages: Array.from({ length: 25 }, (_, index) => makeMessage(index + 1)),
    messenger: {
      messages: {
        async listAttachments(id) {
          opened.push(id);
          active++;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active--;
          return [];
        }
      }
    }
  });

  const result = await h.Email.searchMessages({ limit: 10 });

  assert.equal(result.total, 10);
  assert.deepEqual(opened.sort((a, b) => a - b), [16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
    "only the newest 10 messages open their MIME tree");
  assert.equal(maxActive, 8, "attachment checks are batched at 8");
});

test("include_preview=false skips both MIME calls and omits preview/has_attachment", async () => {
  const inline = [];
  const attachments = [];
  const h = experimentHarness({
    messages: [makeMessage(1), makeMessage(2)],
    messenger: {
      messages: {
        async listInlineTextParts(id) {
          inline.push(id);
          return [{ contentType: "text/plain", content: "Synthetic body" }];
        },
        async listAttachments(id) {
          attachments.push(id);
          return id === 2 ? [{ name: "a.txt", size: 1, contentType: "text/plain" }] : [];
        }
      }
    },
    messageManager: { get: () => ({ flags: 0x2 }) }
  });

  const cheap = await h.Email.searchMessages({ limit: 10, include_preview: false });
  assert.equal(cheap.statusCode, undefined);
  assert.equal(inline.length, 0, "no body parts are read");
  assert.equal(attachments.length, 0, "no attachment lists are read");
  for (const message of cheap.messages) {
    assert.equal(Object.hasOwn(message, "preview"), false, "preview must be omitted, not empty");
    assert.equal(Object.hasOwn(message, "has_attachment"), false, "has_attachment must be omitted");
    assert.equal(typeof message.draft, "boolean", "header facts are still reported");
    assert.equal(message.answered, true, "header flags still come from the experiment");
  }

  const full = await h.Email.searchMessages({ limit: 10 });
  assert.deepEqual(inline.sort(), [1, 2]);
  assert.deepEqual(attachments.sort(), [1, 2]);
  for (const message of full.messages) {
    assert.equal(typeof message.preview, "string");
    assert.equal(typeof message.has_attachment, "boolean");
  }

  // The HTTP query-string path parses the same boolean spellings.
  const http = await h.request("GET", "/messages", { queryString: "include_preview=false" });
  assert.equal(http.status, 200);
  assert.equal(Object.hasOwn(http.body.messages[0], "preview"), false);
  assert.equal(inline.length, 2, "the header-only HTTP search reads no bodies either");
  assert.equal(attachments.length, 2);
});

test("include_preview accepts boolean spellings and rejects unknown values", async () => {
  const h = backgroundHarness({ messages: [makeMessage(1)] });

  for (const value of ["false", "0", 0, false]) {
    const result = await h.Email.searchMessages({ include_preview: value });
    assert.equal(Object.hasOwn(result.messages[0], "preview"), false, `include_preview=${value}`);
  }
  for (const value of ["true", "1", 1, true, undefined]) {
    const result = await h.Email.searchMessages({ include_preview: value });
    assert.equal(Object.hasOwn(result.messages[0], "preview"), true, `include_preview=${value}`);
  }

  // The camelCase alternate keeps the parameter table's alias convention.
  const aliased = await h.Email.searchMessages({ includePreview: "false" });
  assert.equal(Object.hasOwn(aliased.messages[0], "preview"), false);

  const direct = await h.Email.searchMessages({ include_preview: "maybe" });
  assert.equal(direct.statusCode, 400);
  assert.equal(direct.code, "invalid_filter");

  const http = await h.request("GET", "/messages", "include_preview=sideways");
  assert.equal(http.status, 400);
  assert.equal(http.body.code, "invalid_filter");
});

test("answered/forwarded come from the experiment's Replied/Forwarded bits", async () => {
  const flagsById = { 1: 0x2, 2: 0x1000, 3: 0x2 | 0x1000, 4: 0 };
  const requested = [];
  const h = experimentHarness({
    messages: [makeMessage(1), makeMessage(2), makeMessage(3), makeMessage(4)],
    messageManager: {
      get(id) {
        requested.push(id);
        return { flags: flagsById[id] ?? 0 };
      }
    }
  });

  const calls = [];
  const experiment = h.browser.httpServer.getMessageFlags;
  h.browser.httpServer.getMessageFlags = ids => {
    calls.push(Array.from(ids));
    return experiment(ids);
  };

  const result = await h.Email.searchMessages({ limit: 10 });
  const messages = byId(result.messages);

  assert.equal(messages[1].answered, true);
  assert.equal(messages[1].forwarded, false);
  assert.deepEqual(plain(messages[1].flags), ["answered"]);
  assert.equal(messages[2].answered, false);
  assert.equal(messages[2].forwarded, true);
  assert.deepEqual(plain(messages[2].flags), ["forwarded"]);
  assert.equal(messages[3].answered, true);
  assert.equal(messages[3].forwarded, true);
  assert.deepEqual(plain(messages[3].flags), ["answered", "forwarded"]);
  assert.equal(messages[4].answered, false, "a clear bit is reported as false, not omitted");
  assert.equal(messages[4].forwarded, false);
  assert.deepEqual(plain(messages[4].flags), []);

  assert.equal(calls.length, 1, "one call carries the whole final page");
  assert.deepEqual(calls[0].slice().sort(), ["1", "2", "3", "4"]);
  assert.deepEqual(requested.sort(), ["1", "2", "3", "4"], "the experiment reads string IDs");
});

test("answered/forwarded are omitted when the message manager is unavailable", async () => {
  const h = experimentHarness({ messages: [makeMessage(1)] }); // no messageManager option

  const direct = await h.browser.httpServer.getMessageFlags(["1"]);
  assert.deepEqual(plain(direct), {}, "the experiment reports nothing it cannot read");

  const result = await h.Email.searchMessages({ limit: 10 });
  const message = result.messages[0];
  assert.equal(Object.hasOwn(message, "answered"), false);
  assert.equal(Object.hasOwn(message, "forwarded"), false);
  assert.deepEqual(plain(message.flags), [], "unknown flags never appear in flags");
});

test("a throwing message manager lookup omits only that message's flags", async () => {
  const h = experimentHarness({
    messages: [makeMessage(1), makeMessage(2)],
    messageManager: {
      get(id) {
        if (id === "1") throw new Error("message vanished");
        return { flags: 0x2 };
      }
    }
  });

  const result = await h.Email.searchMessages({ limit: 10 });
  const messages = byId(result.messages);

  assert.equal(Object.hasOwn(messages[1], "answered"), false);
  assert.equal(Object.hasOwn(messages[1], "forwarded"), false);
  assert.deepEqual(plain(messages[1].flags), []);
  assert.equal(messages[2].answered, true);
  assert.equal(messages[2].forwarded, false);
});

test("messages in Drafts or Templates folders report draft: true", async () => {
  const drafts = { id: "account1:/Drafts", name: "Drafts", specialUse: ["drafts"] };
  const templates = { id: "account1:/Templates", name: "Templates", specialUse: ["templates"] };
  const h = backgroundHarness({
    folders: [INBOX, drafts, templates],
    messages: [
      makeMessage(1, { folder: INBOX }),
      makeMessage(2, { folder: drafts, read: true }),
      makeMessage(3, { folder: templates })
    ]
  });

  const result = await h.Email.searchMessages({ limit: 10 });
  const messages = byId(result.messages);

  assert.equal(messages[1].draft, false);
  assert.deepEqual(plain(messages[1].flags), []);
  assert.equal(messages[2].draft, true);
  assert.deepEqual(plain(messages[2].flags), ["read", "draft"]);
  assert.equal(messages[3].draft, true);
  assert.deepEqual(plain(messages[3].flags), ["draft"]);

  const detail = await h.Email.getMessage("msg-2@example.test");
  assert.equal(detail.draft, true, "single-message responses agree about draft");
  assert.deepEqual(plain(detail.flags), ["read", "draft"]);
});

test("junk messages report junk in flags", async () => {
  const h = backgroundHarness({
    messages: [
      makeMessage(1, { junk: true, read: true }),
      makeMessage(2, { junk: false }),
      makeMessage(3)
    ]
  });

  const result = await h.Email.searchMessages({ limit: 10 });
  const messages = byId(result.messages);

  assert.deepEqual(plain(messages[1].flags), ["read", "junk"]);
  assert.deepEqual(plain(messages[2].flags), []);
  assert.deepEqual(plain(messages[3].flags), []);
});

test("schema.json declares httpServer.getMessageFlags for the page IDs", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "tb-api", "experiment", "schema.json"), "utf8"));
  const httpServer = schema.find(entry => entry.namespace === "httpServer");
  const fn = httpServer.functions.find(entry => entry.name === "getMessageFlags");

  assert.ok(fn, "getMessageFlags must be declared");
  assert.equal(fn.type, "function");
  assert.equal(fn.async, true);
  assert.equal(fn.parameters.length, 1);
  assert.equal(fn.parameters[0].name, "messageIds");
  assert.equal(fn.parameters[0].type, "array");
  assert.equal(fn.parameters[0].items.type, "string");
});
