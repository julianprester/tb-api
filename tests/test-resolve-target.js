"use strict";

// Task 3.3 — exact resolution for write targets (D4).
//
// `Utils.resolveTarget` is a pure matcher over caller-supplied candidates:
// exact ID -> exact role (mailboxes) -> exact name -> fuzzy (read mode only).
// Write mode refuses ambiguous matches with 409 ambiguous_target; read mode
// picks the first and the message searches report it as `resolved_mailbox`.
//
// These tests cover the matcher itself plus every call site: PATCH move_to,
// GET /messages, POST /mailboxes/refresh, compose identity, calendar
// create/update/delete/list and address-book create/search.

const test = require("node:test");
const assert = require("node:assert/strict");
const { backgroundHarness, experimentHarness } = require("./helpers/harness.js");

// Harness values come from a vm realm, so their prototypes differ from this
// realm's. Clone before deep comparisons.
const plain = value => JSON.parse(JSON.stringify(value));

const json = { "Content-Type": "application/json" };

// ---------------------------------------------------------------------------
// resolveTarget, in isolation
// ---------------------------------------------------------------------------

const MAILBOXES = [
  { id: "account1:/Inbox", name: "Inbox", role: "inbox", account: "account1" },
  { id: "account1:/Archive 2022", name: "Archive 2022", role: null, account: "account1" },
  { id: "account1:/Sent", name: "Sent", role: "sent", account: "account1" },
  { id: "account2:/Sent", name: "Sent", role: "sent", account: "account2" }
];

test("resolveTarget matches exact ID first, then role, then name", () => {
  const { Utils } = backgroundHarness();

  assert.deepEqual(
    plain(Utils.resolveTarget("mailbox", "account1:/Archive 2022", { candidates: MAILBOXES })),
    { id: "account1:/Archive 2022", name: "Archive 2022", matched_by: "id" }
  );

  // Exact ID wins over the exact-name candidate that shares the same text.
  const shadowed = [{ id: "odd", name: "Sent" }, { id: "Sent", name: "Archive" }];
  assert.deepEqual(
    plain(Utils.resolveTarget("mailbox", "Sent", { candidates: shadowed })),
    { id: "Sent", name: "Archive", matched_by: "id" }
  );

  // Roles are case-insensitive and the first matching candidate wins a read.
  assert.deepEqual(
    plain(Utils.resolveTarget("mailbox", "SENT", { candidates: MAILBOXES })),
    { id: "account1:/Sent", name: "Sent", matched_by: "role" }
  );

  // Names are case-insensitive.
  assert.deepEqual(
    plain(Utils.resolveTarget("mailbox", "archive 2022", { candidates: MAILBOXES })),
    { id: "account1:/Archive 2022", name: "Archive 2022", matched_by: "name" }
  );
});

test("resolveTarget: several exact matches are a read choice but a write refusal", () => {
  const { Utils } = backgroundHarness();
  const duplicates = [
    { id: "b1", name: "Projects", account: "a1" },
    { id: "b2", name: "Projects", account: "a2" }
  ];

  // Read mode: first candidate.
  assert.deepEqual(
    plain(Utils.resolveTarget("calendar", "projects", { candidates: duplicates })),
    { id: "b1", name: "Projects", matched_by: "name" }
  );

  // Write mode: 409 with a machine-readable match list.
  const ambiguous = plain(Utils.resolveTarget("calendar", "Projects", { mode: "write", candidates: duplicates }));
  assert.equal(ambiguous.code, "ambiguous_target");
  assert.equal(ambiguous.statusCode, 409);
  assert.deepEqual(ambiguous.matches, [
    { id: "b1", name: "Projects", account: "a1" },
    { id: "b2", name: "Projects", account: "a2" }
  ]);

  // Same for roles: two Sent folders.
  const sent = plain(Utils.resolveTarget("mailbox", "sent", { mode: "write", candidates: MAILBOXES }));
  assert.equal(sent.code, "ambiguous_target");
  assert.deepEqual(sent.matches, [
    { id: "account1:/Sent", name: "Sent", account: "account1" },
    { id: "account2:/Sent", name: "Sent", account: "account2" }
  ]);
});

test("resolveTarget: fuzzy matching is read-only and reports matched_by fuzzy", () => {
  const { Utils } = backgroundHarness();

  // "Archive 2023" is a typo for the only archive that exists.
  const read = plain(Utils.resolveTarget("mailbox", "Archive 2023", { candidates: MAILBOXES }));
  assert.deepEqual(read, { id: "account1:/Archive 2022", name: "Archive 2022", matched_by: "fuzzy" });

  // A write must refuse it instead of moving mail into the wrong folder.
  // Mailbox misses keep the historical `folder_not_found` code (Task 2.3).
  const write = plain(Utils.resolveTarget("mailbox", "Archive 2023", { mode: "write", candidates: MAILBOXES }));
  assert.equal(write.code, "folder_not_found");
  assert.equal(write.statusCode, 404);
  assert.match(write.suggestions[0], /Archive 2022/);

  // Fuzzy roles are read-only too.
  assert.equal(Utils.resolveTarget("mailbox", "sen", { candidates: MAILBOXES }).matched_by, "fuzzy");
  assert.equal(Utils.resolveTarget("mailbox", "sen", { mode: "write", candidates: MAILBOXES }).code, "folder_not_found");
});

test("resolveTarget identity kind matches the email, never the display name", () => {
  const { Utils } = backgroundHarness();
  const identities = [{ id: "id1", name: "julian@example.test", displayName: "Julian Prester" }];

  assert.deepEqual(
    plain(Utils.resolveTarget("identity", "JULIAN@EXAMPLE.TEST", { mode: "write", candidates: identities })),
    { id: "id1", name: "julian@example.test", matched_by: "name" }
  );
  assert.deepEqual(
    plain(Utils.resolveTarget("identity", "id1", { mode: "write", candidates: identities })),
    { id: "id1", name: "julian@example.test", matched_by: "id" }
  );

  const byDisplayName = plain(Utils.resolveTarget("identity", "Jul", { mode: "write", candidates: identities }));
  assert.equal(byDisplayName.code, "not_found");
  assert.equal(byDisplayName.statusCode, 404);
});

test("resolveTarget rejects empty or non-string input and still suggests on 404", () => {
  const { Utils } = backgroundHarness();
  const calendars = [{ id: "cal1", name: "Work" }];

  for (const bad of ["", "   ", 123, null, undefined]) {
    assert.equal(
      Utils.resolveTarget("calendar", bad, { candidates: calendars }).code,
      "invalid_target",
      `${JSON.stringify(bad)} is not a target`
    );
  }

  const missing = plain(Utils.resolveTarget("calendar", "Wor", { mode: "write", candidates: calendars, hints: ["Use GET /calendars"] }));
  assert.equal(missing.code, "not_found");
  assert.match(missing.error, /Calendar not found/);
  assert.deepEqual(missing.suggestions, [
    'Did you mean "Work"?',
    "Available calendars: Work",
    "Use GET /calendars"
  ]);
});

// ---------------------------------------------------------------------------
// Mailboxes: move, search and refresh
// ---------------------------------------------------------------------------

function mailboxHarness() {
  const inbox = { id: "account1:/Inbox", name: "Inbox", role: "inbox" };
  const archive = { id: "account1:/Archive 2022", name: "Archive 2022" };
  const moved = [];
  const h = backgroundHarness({
    folders: [
      inbox,
      archive,
      { id: "account1:/Sent", name: "Sent", role: "sent", accountId: "account1" },
      { id: "account2:/Sent", name: "Sent", role: "sent", accountId: "account2" }
    ],
    messages: [
      { id: 1, headerMessageId: "one@example.test", folder: inbox },
      { id: 2, headerMessageId: "two@example.test", folder: archive }
    ],
    messenger: {
      messages: {
        async move(ids, folderId) { moved.push({ ids, folderId }); }
      }
    }
  });
  return { h, moved, inbox, archive };
}

test("move_to: \"Archive 2023\" with only \"Archive 2022\" -> 404 and nothing moved; search fuzzies", async () => {
  const { h, moved } = mailboxHarness();

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1],
    move_to: "Archive 2023"
  }));
  assert.equal(patch.status, 404);
  assert.equal(patch.body.code, "folder_not_found", "mailbox misses keep the mailbox-specific code");
  assert.equal(moved.length, 0, "a fuzzy destination must never move mail");
  assert.equal(h.messages[0].folder.id, "account1:/Inbox");

  // The same input is allowed for a read, and the response says which folder
  // the fuzzy match used.
  const search = await h.request("GET", "/messages", "mailbox=Archive+2023");
  assert.equal(search.status, 200);
  assert.deepEqual(plain(search.body.resolved_mailbox), {
    id: "account1:/Archive 2022",
    name: "Archive 2022",
    matched_by: "fuzzy"
  });
  assert.equal(h.queries.at(-1).folderId, "account1:/Archive 2022");
  assert.equal(search.body.total, 1, "the fuzzy folder's message is returned");
  assert.equal(search.body.messages[0].mailbox, "Archive 2022");
});

test("searchMessages reports exact ID and case-insensitive name matches", async () => {
  const { h } = mailboxHarness();

  const byId = await h.request("GET", "/messages", `mailbox=${encodeURIComponent("account1:/Archive 2022")}`);
  assert.equal(byId.status, 200);
  assert.deepEqual(plain(byId.body.resolved_mailbox), {
    id: "account1:/Archive 2022",
    name: "Archive 2022",
    matched_by: "id"
  });
  assert.equal(h.count("folder-query"), 0, "an exact ID resolves without listing folders");

  const byName = await h.request("GET", "/messages", "mailbox=archive%202022");
  assert.equal(byName.status, 200);
  assert.deepEqual(plain(byName.body.resolved_mailbox), {
    id: "account1:/Archive 2022",
    name: "Archive 2022",
    matched_by: "name"
  });
});

test("two Sent folders: move is 409, search picks and reports the first", async () => {
  const { h, moved } = mailboxHarness();

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1],
    move_to: "Sent"
  }));
  assert.equal(patch.status, 409);
  assert.equal(patch.body.code, "ambiguous_target");
  assert.deepEqual(plain(patch.body.matches), [
    { id: "account1:/Sent", name: "Sent", account: "account1" },
    { id: "account2:/Sent", name: "Sent", account: "account2" }
  ]);
  assert.equal(moved.length, 0);

  const search = await h.request("GET", "/messages", "mailbox=Sent");
  assert.equal(search.status, 200);
  assert.deepEqual(plain(search.body.resolved_mailbox), {
    id: "account1:/Sent",
    name: "Sent",
    matched_by: "role"
  });
  assert.equal(h.queries.at(-1).folderId, "account1:/Sent");
});

test("a move to an exact name still works", async () => {
  const { h, moved } = mailboxHarness();

  const patch = await h.request("PATCH", "/messages", "", JSON.stringify({
    ids: [1],
    move_to: "archive 2022"
  }));
  assert.equal(patch.status, 200);
  assert.equal(patch.body.success, true);
  assert.deepEqual(plain(moved), [{ ids: [1], folderId: "account1:/Archive 2022" }]);
});

test("refreshMailbox resolves in read mode and reports the fuzzy choice", async t => {
  const h = experimentHarness({
    t,
    folders: [
      { id: "account1:/Inbox", name: "Inbox", role: "inbox" },
      { id: "account1:/Archive 2022", name: "Archive 2022", autoComplete: 0 }
    ]
  });

  const result = await h.request("POST", "/mailboxes/refresh", {
    headers: json,
    body: JSON.stringify({ mailbox: "Archive 2023" })
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.folder_id, "account1:/Archive 2022");
  assert.deepEqual(result.body.resolved_mailbox, {
    id: "account1:/Archive 2022",
    name: "Archive 2022",
    matched_by: "fuzzy"
  });
});

// ---------------------------------------------------------------------------
// Compose identity
// ---------------------------------------------------------------------------

function identityHarness(identities) {
  const composed = [];
  const h = backgroundHarness({
    identities,
    messenger: {
      compose: {
        async beginNew(details) { composed.push(details); return { id: 7 }; },
        async saveMessage() {}
      },
      tabs: { async remove() {} }
    }
  });
  return { h, composed };
}

test("compose identity \"Jul\" 404s instead of matching the Julian display name", async () => {
  const { h, composed } = identityHarness([
    { id: "id1", name: "Julian Prester", email: "julian@example.test" },
    { id: "id2", name: "Work", email: "work@example.test" }
  ]);

  const result = await h.request("POST", "/messages", "", JSON.stringify({
    to: "someone@example.test",
    identity: "Jul",
    subject: "Hello",
    body: "Text"
  }));
  assert.equal(result.status, 404);
  assert.equal(result.body.code, "not_found");
  assert.match(result.body.error, /Identity not found/);
  assert.equal(composed.length, 0);
});

test("compose identity resolves by exact email (case-insensitive) and by ID", async () => {
  const { h, composed } = identityHarness([
    { id: "id1", name: "Julian Prester", email: "julian@example.test" },
    { id: "id2", name: "Work", email: "work@example.test" }
  ]);

  const byEmail = await h.request("POST", "/messages", "", JSON.stringify({
    to: "someone@example.test", identity: "JULIAN@EXAMPLE.TEST", body: "Text"
  }));
  assert.equal(byEmail.status, 200);
  assert.equal(byEmail.body.from, "julian@example.test");
  assert.equal(composed[0].identityId, "id1");

  const byId = await h.request("POST", "/messages", "", JSON.stringify({
    to: "someone@example.test", identity: "id2", body: "Text"
  }));
  assert.equal(byId.status, 200);
  assert.equal(byId.body.from, "work@example.test");
  assert.equal(composed[1].identityId, "id2");
});

test("compose identity refuses ambiguous duplicate emails in write mode", async () => {
  const { h, composed } = identityHarness([
    { id: "a", name: "One", email: "dup@example.test" },
    { id: "b", name: "Two", email: "dup@example.test" }
  ]);

  const result = await h.request("POST", "/messages", "", JSON.stringify({
    to: "someone@example.test", identity: "dup@example.test", body: "Text"
  }));
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "ambiguous_target");
  assert.deepEqual(plain(result.body.matches), [
    { id: "a", name: "dup@example.test", account: null },
    { id: "b", name: "dup@example.test", account: null }
  ]);
  assert.equal(composed.length, 0);
});

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

const EVENT = { title: "Standup", start: "2030-01-01T10:00:00", end: "2030-01-01T11:00:00" };

test("calendar writes require exact matches; reads keep fuzzy matching", async t => {
  const h = experimentHarness({
    t,
    calendars: [
      { id: "cal1", name: "Archive 2022", readOnly: false },
      { id: "cal2", name: "Work", readOnly: false }
    ]
  });

  const refused = await h.request("POST", "/events", {
    headers: json,
    body: JSON.stringify({ ...EVENT, calendar: "Archive 2023" })
  });
  assert.equal(refused.status, 404);
  assert.equal(refused.body.code, "not_found");
  assert.equal(h.cal.manager.getCalendars()[0].items.length, 0, "no event was created");

  const created = await h.request("POST", "/events", {
    headers: json,
    body: JSON.stringify({ ...EVENT, calendar: "work" })
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.calendar, "Work");
  assert.equal(h.cal.manager.getCalendars()[1].items.length, 1);

  // Listing is a read, so the typo resolves the same way a search does.
  const read = await h.request("GET", "/events", {
    queryString: "calendar=Archive+2023&start=2030-01-01&end=2030-01-02"
  });
  assert.equal(read.status, 200);
  assert.ok(Array.isArray(read.body.events));

  // Delete and update are writes too.
  const del = await h.request("DELETE", "/events/missing", { queryString: "calendar=Archive+2023" });
  assert.equal(del.status, 404);
  assert.equal(del.body.code, "not_found");
  const patch = await h.request("PATCH", "/events/missing", {
    queryString: "calendar=Archive+2023",
    headers: json,
    body: JSON.stringify({ title: "Changed" })
  });
  assert.equal(patch.status, 404);
  assert.equal(patch.body.code, "not_found");
});

test("two calendars with the same name: writes are 409 with matches, reads pick the first", async t => {
  const h = experimentHarness({
    t,
    calendars: [
      { id: "team1", name: "Team", readOnly: false },
      { id: "team2", name: "Team", readOnly: false }
    ]
  });

  const ambiguous = await h.request("POST", "/events", {
    headers: json,
    body: JSON.stringify({ ...EVENT, calendar: "team" })
  });
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.body.code, "ambiguous_target");
  assert.deepEqual(plain(ambiguous.body.matches), [
    { id: "team1", name: "Team", account: null },
    { id: "team2", name: "Team", account: null }
  ]);
  assert.equal(h.cal.manager.getCalendars()[0].items.length, 0);
  assert.equal(h.cal.manager.getCalendars()[1].items.length, 0);

  const read = await h.request("GET", "/events", { queryString: "calendar=Team" });
  assert.equal(read.status, 200);
});

// ---------------------------------------------------------------------------
// Address books
// ---------------------------------------------------------------------------

test("address-book writes require exact matches; reads keep fuzzy matching", async () => {
  const created = [];
  const h = backgroundHarness({
    messenger: {
      addressBooks: {
        async list() {
          return [
            { id: "book1", name: "Personal", readOnly: false },
            { id: "book2", name: "Archive", readOnly: false }
          ];
        }
      },
      contacts: {
        async list() { return []; },
        async create(addressbook, id, properties) {
          created.push({ addressbook, id, properties });
          return "new-id";
        }
      }
    }
  });

  const refused = await h.request("POST", "/contacts", "", JSON.stringify({
    email: "a@example.test",
    addressbook: "Personel"
  }));
  assert.equal(refused.status, 404);
  assert.equal(refused.body.code, "not_found");
  assert.equal(created.length, 0, "a fuzzy address book must not create a contact");

  const named = await h.request("POST", "/contacts", "", JSON.stringify({
    email: "a@example.test",
    addressbook: "personal"
  }));
  assert.equal(named.status, 200);
  assert.equal(created[0].addressbook, "book1");

  const read = await h.request("GET", "/contacts", "addressbook=Personel");
  assert.equal(read.status, 200);
});

test("two address books with the same name refuse a write with 409", async () => {
  const h = backgroundHarness({
    messenger: {
      addressBooks: {
        async list() {
          return [
            { id: "b1", name: "Shared", readOnly: false },
            { id: "b2", name: "Shared", readOnly: false }
          ];
        }
      }
    }
  });

  const result = await h.request("POST", "/contacts", "", JSON.stringify({
    email: "a@example.test",
    addressbook: "Shared"
  }));
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "ambiguous_target");
  assert.deepEqual(plain(result.body.matches), [
    { id: "b1", name: "Shared", account: null },
    { id: "b2", name: "Shared", account: null }
  ]);
});
