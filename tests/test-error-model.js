"use strict";

// Task 2.3 — consistent error model: every error result carries a stable
// machine-readable `code` and an internal `statusCode` that becomes the HTTP
// status (background via Utils.resultResponse, calendar via
// sendCalendarResponse) but is never serialized into the JSON body.
const test = require("node:test");
const assert = require("node:assert/strict");
const { experimentHarness } = require("./helpers/harness.js");

// Harness values come from a vm realm, so their prototypes differ from this
// realm's. Clone before deep comparisons.
const plain = value => JSON.parse(JSON.stringify(value));

test("Utils.fail builds { error, code, statusCode, suggestions? }", async t => {
  const h = experimentHarness({ t });

  assert.deepEqual(plain(h.Utils.fail("invalid_parameter", "bad value", 400)), {
    error: "bad value",
    code: "invalid_parameter",
    statusCode: 400
  });
  assert.deepEqual(
    plain(h.Utils.fail("not_found", "missing", 404, ["Try GET /messages"])),
    { error: "missing", code: "not_found", statusCode: 404, suggestions: ["Try GET /messages"] }
  );

  // The message-guessing helper is gone: status comes from the result itself.
  assert.equal(h.Utils.getErrorStatusFromMessage, undefined);
});

test("email errors carry the right statusCode and code", async t => {
  const h = experimentHarness({ t });

  const missingFolder = await h.Email.searchMessages({ mailbox: "does-not-exist" });
  assert.equal(missingFolder.code, "folder_not_found");
  assert.equal(missingFolder.statusCode, 404);
  assert.match(missingFolder.error, /Mailbox not found/);

  const badDate = await h.Email.searchMessages({ after: "not-a-date" });
  assert.equal(badDate.code, "invalid_date");
  assert.equal(badDate.statusCode, 400);

  const missingMessage = await h.request("GET", "/messages/missing%40example.test");
  assert.equal(missingMessage.status, 404);
  assert.equal(missingMessage.body.code, "not_found");
  assert.equal(missingMessage.body.statusCode, undefined, "statusCode is internal metadata");

  const badParameter = await h.request("POST", "/messages", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject: "No recipient" })
  });
  assert.equal(badParameter.status, 400);
  assert.equal(badParameter.body.code, "invalid_parameter");

  const unknownIds = await h.Email.updateMessages({ ids: ["nope@example.test"] });
  assert.equal(unknownIds.code, "not_found");
  assert.equal(unknownIds.statusCode, 404);
  assert.deepEqual([...unknownIds.not_found], ["nope@example.test"]);
});

test("contact errors carry the right statusCode and code", async t => {
  const h = experimentHarness({
    t,
    messenger: {
      addressBooks: {
        async list() {
          return [
            { id: "book1", name: "Personal", readOnly: false },
            { id: "book2", name: "Archive", readOnly: true }
          ];
        }
      },
      contacts: {
        async list() { return []; },
        async get(id) {
          if (id === "nope") return null;
          if (id === "thrower") throw new Error("synthetic get failure");
          return { id, properties: { PrimaryEmail: "old@example.test" } };
        },
        async update(id) {
          if (id === "boom") throw new Error("synthetic update failure");
        },
        async delete() {},
        async create() { return "created-id"; }
      }
    }
  });

  const missingBook = await h.Contacts.searchContacts({ addressbook: "No Such Book" });
  assert.equal(missingBook.code, "not_found");
  assert.equal(missingBook.statusCode, 404);

  const readOnly = await h.Contacts.createContact({ addressbook: "Archive", email: "a@example.test" });
  assert.equal(readOnly.code, "read_only");
  assert.equal(readOnly.statusCode, 403);

  const badEmail = await h.Contacts.createContact({ addressbook: "Personal", email: "not-an-email" });
  assert.equal(badEmail.code, "invalid_parameter");
  assert.equal(badEmail.statusCode, 400);

  const missingContact = await h.Contacts.updateContact("nope", {});
  assert.equal(missingContact.code, "not_found");
  assert.equal(missingContact.statusCode, 404);

  const updateFailed = await h.Contacts.updateContact("boom", { firstName: "X" });
  assert.equal(updateFailed.code, "update_failed");
  assert.equal(updateFailed.statusCode, 500);

  // The background route uses result.statusCode instead of message guessing.
  const httpMissing = await h.request("DELETE", "/contacts/thrower");
  assert.equal(httpMissing.status, 404);
  assert.equal(httpMissing.body.code, "not_found");
  assert.equal(httpMissing.body.statusCode, undefined);

  // "Failed to update contact" has no "not found"/"not available" text, so the
  // removed message guesser would have answered 400; the result says 500.
  const httpUpdateFailed = await h.request("PATCH", "/contacts/boom", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ firstName: "X" })
  });
  assert.equal(httpUpdateFailed.status, 500);
  assert.equal(httpUpdateFailed.body.code, "update_failed");
});

test("calendar errors carry the right statusCode and code", async t => {
  const h = experimentHarness({
    t,
    calendars: [
      { id: "cal1", name: "Work", readOnly: false },
      { id: "cal2", name: "Personal", readOnly: false }
    ]
  });

  const badDate = await h.request("GET", "/events", { queryString: "end=garbage" });
  assert.equal(badDate.status, 400);
  assert.equal(badDate.body.code, "invalid_date");
  assert.equal(badDate.body.statusCode, undefined, "statusCode is internal metadata");

  const missingCalendar = await h.request("GET", "/events", { queryString: "calendar=Nope" });
  assert.equal(missingCalendar.status, 404);
  assert.equal(missingCalendar.body.code, "not_found");

  const badParameter = await h.request("POST", "/events", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start: "2030-01-01T10:00:00", end: "2030-01-01T11:00:00" })
  });
  assert.equal(badParameter.status, 400);
  assert.equal(badParameter.body.code, "invalid_parameter");

  const ambiguous = await h.request("POST", "/events", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Standup", start: "2030-01-01T10:00:00", end: "2030-01-01T11:00:00" })
  });
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.body.code, "ambiguous_target");

  const missingEvent = await h.request("DELETE", "/events/missing-id", { queryString: "calendar=Work" });
  assert.equal(missingEvent.status, 404);
  assert.equal(missingEvent.body.code, "not_found");

  const readOnly = await experimentHarness({
    t,
    calendars: [{ id: "ro", name: "Holidays", readOnly: true }]
  });
  const refused = await readOnly.request("POST", "/events", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Holiday", start: "2030-01-01T10:00:00", end: "2030-01-01T11:00:00", calendar: "Holidays"
    })
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "read_only");
});
