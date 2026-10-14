"use strict";

// Task 3.5 — newest-first bounded search (D6).
//
// Thunderbird's messages.query pages through matches in database order (oldest
// first) and keeps scanning in the background, so the newest matches can only
// be found by reading every page. These tests pin the collection order, the
// deadline/abort behaviour, and the additive response metadata.

const test = require("node:test");
const assert = require("node:assert/strict");
const { backgroundHarness, Clock, flush } = require("./helpers/harness.js");

const TIMEOUT_WARNING = "Search stopped after 20 s; add after=/before= or a mailbox to narrow it";

// Harness values come from a vm realm, so clone arrays/objects before
// deep comparisons.
const plain = value => JSON.parse(JSON.stringify(value));

// `messages` arrives in database (insertion) order, oldest first: id 1 is the
// oldest and the highest id is the newest.
function makeMessages(count, { folderId = "account1:/Inbox" } = {}) {
  const folder = { id: folderId, name: "Inbox" };
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    headerMessageId: `msg-${index + 1}@example.test`,
    date: new Date(Date.UTC(2026, 0, 1) + index * 60000),
    author: `Sender ${index + 1} <sender${index + 1}@example.test>`,
    recipients: ["Receiver <receiver@example.test>"],
    subject: `Message ${index + 1}`,
    read: index % 2 === 0,
    folder
  }));
}

const ids = result => Array.from(result.messages, message => message.id);
const descending = (from, count) => Array.from({ length: count }, (_, i) => from - i);
const ascending = count => Array.from({ length: count }, (_, i) => i + 1);

test("search scans all pages and returns the newest matches first", async () => {
  const h = backgroundHarness({ messages: makeMessages(250) });

  const result = await h.Email.searchMessages({ limit: 10 });

  assert.equal(result.complete, true);
  assert.equal(result.matched, 250);
  assert.equal(result.has_more, true);
  assert.equal(result.total, 10);
  assert.deepEqual(ids(result), descending(250, 10));
  assert.equal(Object.hasOwn(result, "warnings"), false, "a complete search does not warn");
  assert.equal(h.queries.length, 1);
  assert.equal(h.queries[0].messagesPerPage, 500);
  assert.equal(h.queries[0].autoPaginationTimeout, 0);
  assert.deepEqual(h.abortedLists, [], "a completed list must never be aborted");
});

test("has_more is exact when the matches equal the limit (100 matches, limit 100)", async () => {
  const h = backgroundHarness({ messages: makeMessages(100) });

  const result = await h.Email.searchMessages({ limit: 100 });

  assert.equal(result.complete, true);
  assert.equal(result.matched, 100);
  assert.equal(result.has_more, false, "exactly limit matches are not 'more'");
  assert.equal(result.total, 100);
  assert.deepEqual(ids(result), descending(100, 100));
});

test("one match over the limit sets has_more (101 matches, limit 100)", async () => {
  const h = backgroundHarness({ messages: makeMessages(101) });

  const result = await h.Email.searchMessages({ limit: 100 });

  assert.equal(result.matched, 101);
  assert.equal(result.has_more, true);
  assert.deepEqual(ids(result), descending(101, 100));
});

test("paging continues to the end and a completed list is not aborted", async () => {
  const h = backgroundHarness({ messages: makeMessages(600) });

  const result = await h.Email.searchMessages({ limit: 10 });

  assert.equal(result.complete, true);
  assert.equal(result.matched, 600);
  assert.equal(result.has_more, true);
  assert.deepEqual(ids(result), descending(600, 10));
  assert.deepEqual(h.continuedLists, ["message-list-1"], "the second page was read with continueList");
  assert.deepEqual(h.abortedLists, []);
});

test("sort=date_asc returns the oldest matches, date_desc the newest", async () => {
  const h = backgroundHarness({ messages: makeMessages(250) });

  const asc = await h.Email.searchMessages({ limit: 10, sort: "date_asc" });
  assert.equal(asc.complete, true);
  assert.equal(asc.matched, 250);
  assert.equal(asc.has_more, true);
  assert.deepEqual(ids(asc), ascending(10), "the oldest matches, oldest first");

  const desc = await h.Email.searchMessages({ limit: 10, sort: "date_desc" });
  assert.deepEqual(ids(desc), descending(250, 10));
});

test("an unknown sort is 400 invalid_parameter before any query", async () => {
  const h = backgroundHarness({ messages: makeMessages(3) });

  const direct = await h.Email.searchMessages({ sort: "oldest" });
  assert.equal(direct.statusCode, 400);
  assert.equal(direct.code, "invalid_parameter");
  assert.match(direct.error, /Unknown sort/);

  const http = await h.request("GET", "/messages", "sort=sideways");
  assert.equal(http.status, 400);
  assert.equal(http.body.code, "invalid_parameter");
  assert.match(http.body.error, /sideways/);

  assert.equal(h.queries.length, 0, "an unknown sort must never reach messages.query");
});

test("the budget returns the partial newest results and aborts the scan", async () => {
  const clock = new Clock();
  const h = backgroundHarness({ messages: makeMessages(600), clock, hangContinueList: true });

  const pending = h.Email.searchMessages({ limit: 10 });
  await flush();
  assert.equal(h.continuedLists.length, 1, "the first page arrived and the next one is pending");
  clock.tick(20000);

  const result = await pending;
  assert.equal(result.complete, false);
  assert.equal(result.has_more, true, "an unfinished scan may always have more matches");
  assert.equal(Object.hasOwn(result, "matched"), false, "matched is only exact when complete");
  assert.deepEqual(Array.from(result.warnings), [TIMEOUT_WARNING]);
  assert.deepEqual(ids(result), descending(500, 10), "only pages read so far are considered");
  assert.deepEqual(h.abortedLists, ["message-list-1"]);
  assert.equal(clock.timers.size, 0, "the deadline timer is cleared");
});

test("a deadline before any page is a 504 search_timeout, not an empty list", async () => {
  const clock = new Clock();
  const h = backgroundHarness({ messages: makeMessages(10), clock, hangQuery: true });

  const pending = h.Email.searchMessages({ mailbox: "account1:/Inbox" });
  await flush();
  clock.tick(20000);

  const result = await pending;
  assert.equal(result.statusCode, 504);
  assert.equal(result.code, "search_timeout");
  assert.match(result.error, /did not return a page within 20 s/);
  assert.deepEqual(Array.from(result.suggestions), [TIMEOUT_WARNING]);
  assert.equal(result.messages, undefined, "a timeout is not an empty result list");
  assert.equal(result.resolved_mailbox.id, "account1:/Inbox", "resolved_mailbox survives the 504");
  assert.equal(result.resolved_mailbox.matched_by, "id");
  assert.deepEqual(h.abortedLists, [], "no page ever arrived, so there is no list to abort");
  assert.equal(clock.timers.size, 0);
});

test("a failed page aborts the list and surfaces the error", async () => {
  const h = backgroundHarness({
    messages: makeMessages(600),
    messenger: {
      messages: {
        async continueList() { throw new Error("synthetic page failure"); }
      }
    }
  });

  await assert.rejects(h.Email.searchMessages({ limit: 10 }), /synthetic page failure/);
  assert.deepEqual(h.abortedLists, ["message-list-1"]);

  const http = await h.request("GET", "/messages", "limit=10");
  assert.equal(http.status, 500);
  assert.equal(http.body.error, "synthetic page failure");
  assert.deepEqual(h.abortedLists, ["message-list-1", "message-list-2"]);
});

test("an abortList failure does not replace the partial result", async () => {
  const clock = new Clock();
  const aborts = [];
  const h = backgroundHarness({
    messages: makeMessages(600),
    clock,
    hangContinueList: true,
    messenger: {
      messages: {
        async abortList(id) {
          aborts.push(id);
          throw new Error("list already gone");
        }
      }
    }
  });

  const pending = h.Email.searchMessages({ limit: 10 });
  await flush();
  clock.tick(20000);

  const result = await pending;
  assert.equal(result.complete, false);
  assert.deepEqual(Array.from(result.warnings), [TIMEOUT_WARNING]);
  assert.deepEqual(aborts, ["message-list-1"]);
  assert.equal(clock.timers.size, 0);
});

test("previews are built only for the returned matches", async () => {
  const bodies = [];
  const h = backgroundHarness({
    messages: makeMessages(250),
    messenger: {
      messages: {
        async listInlineTextParts(id) {
          bodies.push(id);
          return [{ contentType: "text/plain", content: "Synthetic body" }];
        }
      }
    }
  });

  const result = await h.Email.searchMessages({ limit: 10 });

  assert.deepEqual(bodies, descending(250, 10), "only the newest 10 messages open MIME parts");
  assert.equal(result.messages[0].preview, "Synthetic body");
});

test("preview MIME calls are capped at 8 in flight", async () => {
  let active = 0;
  let maxActive = 0;
  const h = backgroundHarness({
    messages: makeMessages(20),
    messenger: {
      messages: {
        async listInlineTextParts() {
          active++;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active--;
          return [{ contentType: "text/plain", content: "Synthetic body" }];
        }
      }
    }
  });

  const result = await h.Email.searchMessages({ limit: 20 });

  assert.equal(result.total, 20);
  assert.equal(maxActive, 8, "at most 8 MIME parsers run at once");
});

test("partial results keep resolved_mailbox and refresh metadata", async () => {
  const clock = new Clock();
  const h = backgroundHarness({ messages: makeMessages(600), clock, hangContinueList: true });

  const pending = h.Email.searchMessages({ mailbox: "account1:/Inbox", refresh: "true", limit: 5 });
  await flush();
  clock.tick(20000);

  const result = await pending;
  assert.equal(result.complete, false);
  assert.equal(result.resolved_mailbox.id, "account1:/Inbox");
  assert.equal(result.resolved_mailbox.matched_by, "id");
  assert.deepEqual(plain(result.refresh), { folder_id: "account1:/Inbox", refreshed: true });
  assert.deepEqual(ids(result), descending(500, 5));
});

test("a completed search with no matches is complete and warns about nothing", async () => {
  const h = backgroundHarness({ messages: [] });

  const result = await h.Email.searchMessages({});

  assert.equal(result.total, 0);
  assert.equal(result.matched, 0);
  assert.equal(result.complete, true);
  assert.equal(result.has_more, false);
  assert.equal(Object.hasOwn(result, "warnings"), false);
  assert.equal(result.hints.length, 1);
  assert.deepEqual(h.abortedLists, []);
});
