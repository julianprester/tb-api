"use strict";

// Task 2.4: per-domain parameter aliases.
//
// The previous global PARAM_ALIASES renamed `q` to `text` for every endpoint,
// so GET /contacts?q= filtered on nothing (plan review item 4), and `start`
// meant "search after this date" for email but "event start" for calendar.
// Each endpoint now uses the table for its own domain.

const test = require("node:test");
const assert = require("node:assert/strict");
const { backgroundHarness } = require("./helpers/harness.js");

// Utils values come from the harness vm realm, so clone them before deep
// comparisons (same helper as tests/test-regressions.js).
const plain = value => JSON.parse(JSON.stringify(value));

const BOOK = { id: "book1", name: "Personal", readOnly: false };

const CONTACTS = [
  {
    id: "alice",
    parentId: "book1",
    properties: {
      PrimaryEmail: "alice@example.test",
      DisplayName: "Alice Anderson",
      FirstName: "Alice",
      LastName: "Anderson"
    }
  },
  {
    id: "bob",
    parentId: "book1",
    properties: {
      PrimaryEmail: "bob@example.test",
      DisplayName: "Bob Brown",
      FirstName: "Bob",
      LastName: "Brown"
    }
  }
];

function contactsHarness() {
  const created = [];
  const h = backgroundHarness({
    messenger: {
      addressBooks: {
        async list() { return [BOOK]; }
      },
      contacts: {
        async list() {
          // Deep copy: searchContacts never mutates, but a shared fixture
          // would leak between harness instances if it did.
          return CONTACTS.map(contact => ({ ...contact, properties: { ...contact.properties } }));
        },
        async create(addressbook, id, properties) {
          created.push({ addressbook, id, properties });
          return "created-id";
        }
      }
    }
  });
  return { h, created };
}

test("GET /contacts?q=, ?query= and ?search= each filter contacts", async () => {
  const { h } = contactsHarness();

  for (const alias of ["q", "query", "search"]) {
    const result = await h.request("GET", "/contacts", `${alias}=alice`);
    assert.equal(result.status, 200, `${alias} should be an accepted contact query alias`);
    assert.equal(result.body.total, 1, `${alias}=alice should match one contact`);
    assert.deepEqual(result.body.contacts.map(contact => contact.id), ["alice"], `${alias}=alice`);
  }

  // The aliases are filters, not just accepted-and-ignored parameters.
  const noMatch = await h.request("GET", "/contacts", "q=nobody");
  assert.equal(noMatch.status, 200);
  assert.deepEqual(noMatch.body.contacts, []);
  assert.equal(noMatch.body.total, 0);
});

test("POST /contacts with name= sets displayName", async () => {
  const { h, created } = contactsHarness();

  const result = await h.request("POST", "/contacts", "", JSON.stringify({
    email: "carol@example.test",
    name: "Carol Clark"
  }));

  assert.equal(result.status, 200);
  assert.equal(created.length, 1);
  assert.equal(created[0].addressbook, "book1");
  assert.equal(created[0].properties.PrimaryEmail, "carol@example.test");
  assert.equal(created[0].properties.DisplayName, "Carol Clark");
  assert.equal(result.body.contact.displayName, "Carol Clark");
});

test("PATCH /contacts/:id resolves the contact alias table too", async () => {
  const updates = [];
  const h = backgroundHarness({
    messenger: {
      addressBooks: {
        async list() { return [BOOK]; }
      },
      contacts: {
        async get(id) {
          return { id, parentId: "book1", properties: { PrimaryEmail: "alice@example.test" } };
        },
        async update(id, properties) {
          updates.push({ id, properties });
        }
      }
    }
  });

  const result = await h.request("PATCH", "/contacts/alice", "", JSON.stringify({ name: "Alice A." }));
  assert.equal(result.status, 200);
  assert.deepEqual(plain(updates[0].properties), { DisplayName: "Alice A." });
  assert.equal(result.body.contact.displayName, "Alice A.");
});

test("email search still maps q -> text and start -> after", async () => {
  const h = backgroundHarness();

  const byText = await h.request("GET", "/messages", "q=hello");
  assert.equal(byText.status, 200);
  assert.equal(h.queries[0].fullText, "hello");

  const byStart = await h.request("GET", "/messages", "start=2024-01-15");
  assert.equal(byStart.status, 200);
  // Date-only input means LOCAL midnight (decision D9, Task 2.5).
  assert.equal(h.queries[1].fromDate.getTime(), new Date(2024, 0, 15).getTime());
});

test("normalizeParams applies the table for the endpoint's domain", () => {
  const { h } = contactsHarness();
  const { Utils } = h;

  assert.deepEqual(
    plain(Utils.normalizeParams({ q: "hello", start: "2024-01-15" }, Utils.ALIASES.emailSearch)),
    { text: "hello", after: "2024-01-15" }
  );
  assert.deepEqual(
    plain(Utils.normalizeParams({ q: "alice" }, Utils.ALIASES.contacts)),
    { query: "alice" }
  );
  assert.deepEqual(
    plain(Utils.normalizeParams({ name: "Carol" }, Utils.ALIASES.contacts)),
    { displayName: "Carol" }
  );
  assert.deepEqual(
    plain(Utils.normalizeParams({ content: "hi", replyTo: "msg-1" }, Utils.ALIASES.compose)),
    { body: "hi", in_reply_to: "msg-1" }
  );

  // Same input, different domain: `from` is a start-date alias for calendar
  // but the canonical sender field for email search.
  assert.deepEqual(
    plain(Utils.normalizeParams({ from: "2024-01-15" }, Utils.ALIASES.calendar)),
    { start: "2024-01-15" }
  );
  assert.deepEqual(
    plain(Utils.normalizeParams({ from: "alice@example.test" }, Utils.ALIASES.emailSearch)),
    { from: "alice@example.test" }
  );

  // normalizeParams semantics: canonical wins when already present, and the
  // alternate key is removed only when it was consumed.
  assert.deepEqual(
    plain(Utils.normalizeParams({ text: "kept", q: "dropped" }, Utils.ALIASES.emailSearch)),
    { text: "kept", q: "dropped" }
  );
});
