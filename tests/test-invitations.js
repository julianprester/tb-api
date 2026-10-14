"use strict";

// Task 5.4: invitations (D8).
//
// Invitations are prepared as drafts by default. `inviteMode: "send"` sends
// immediately, but only with TB_API_ALLOW_SEND=1; without it the event is not
// created (403 sending_disabled). The organizer must be one of the user's own
// identities, checked through MailServices.accounts.allIdentities before
// addItem. The ICS is produced by Thunderbird's serializer from the item that
// addItem returns, so its UID is exactly the event id. The background
// listener's returned outcome is what the response reports; a missing or
// throwing listener is a warning on a created event, never a failed creation.
const test = require("node:test");
const assert = require("node:assert/strict");
const { experimentHarness } = require("./helpers/harness.js");

const json = { "Content-Type": "application/json" };

const ORGANIZER = "organizer@example.test";
const IDENTITIES = [{ id: "id1", email: ORGANIZER, name: "Organizer" }];
const EVENT = { title: "Standup", start: "2030-01-01T10:00:00", end: "2030-01-01T11:00:00" };
const INVITE = { ...EVENT, organizer: ORGANIZER, attendees: ["guest@example.test"] };

const post = (h, payload) =>
  h.request("POST", "/events", { headers: json, body: JSON.stringify(payload) });

/** Spy on the writable calendar's addItem while keeping its real behavior. */
function spyAddItem(h) {
  const calendar = h.cal.manager.getCalendars()[0];
  const calls = [];
  const original = calendar.addItem.bind(calendar);
  calendar.addItem = async item => {
    calls.push(item);
    return original(item);
  };
  return calls;
}

const items = h => h.cal.manager.getCalendars()[0].items;
const callsOf = (h, method) => h.composeCalls.filter(call => call.method === method);
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// Default: draft
// ---------------------------------------------------------------------------

test("sendInvites defaults to a saved draft and reports draft_saved", async t => {
  const h = experimentHarness({ t, identities: IDENTITIES });

  const created = await post(h, { ...INVITE, sendInvites: true });

  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.invitations.status, "draft_saved");
  assert.equal(created.body.invitesSent, undefined, "no assumed invite status");
  assert.equal(created.body.invitesPending, undefined);
  assert.equal(items(h).length, 1, "the event is created");

  // The draft flow mirrors POST /messages: compose, attach invite.ics, save as
  // draft, close the tab. The message is never sent.
  const begun = callsOf(h, "beginNew");
  assert.equal(begun.length, 1);
  assert.equal(begun[0].details.identityId, "id1", "the organizer's own identity is used");
  assert.deepEqual(Array.from(begun[0].details.to), ["guest@example.test"]);
  assert.equal(begun[0].details.subject, "Invitation: Standup");

  const attached = callsOf(h, "addAttachment");
  assert.equal(attached.length, 1);
  assert.equal(attached[0].attachment.name, "invite.ics");

  const saved = callsOf(h, "saveMessage");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].options.mode, "draft");
  assert.equal(callsOf(h, "removeTab").length, 1, "the compose tab is closed like POST /messages does");
  assert.equal(callsOf(h, "sendMessage").length, 0, "draft mode must not send");
});

test("inviteMode: draft works on its own and sendInvites is its alias", async t => {
  for (const payload of [
    { ...INVITE, inviteMode: "draft" },
    { ...INVITE, invite_mode: "draft" },
    { ...INVITE, sendInvites: true }
  ]) {
    const h = experimentHarness({ t, identities: IDENTITIES });
    const created = await post(h, payload);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.invitations.status, "draft_saved");
  }
});

test("invalid inviteMode is 400 invalid_parameter and creates nothing", async t => {
  const h = experimentHarness({ t, identities: IDENTITIES });
  const addCalls = spyAddItem(h);

  for (const value of ["later", "now", "SEND", "Draft", true, 1, null, {}]) {
    const result = await post(h, { ...INVITE, sendInvites: false, inviteMode: value });
    assert.equal(result.status, 400, `inviteMode=${JSON.stringify(value)}`);
    assert.equal(result.body.code, "invalid_parameter");
    assert.equal(addCalls.length, 0, "no event may be created");
    assert.equal(h.icsSerializers.length, 0, "no ICS may be built");
  }
});

// ---------------------------------------------------------------------------
// Sending needs the environment opt-in
// ---------------------------------------------------------------------------

test("inviteMode: send without TB_API_ALLOW_SEND is 403 and creates nothing", async t => {
  const h = experimentHarness({ t, identities: IDENTITIES });
  const addCalls = spyAddItem(h);

  const refused = await post(h, { ...INVITE, inviteMode: "send" });

  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "sending_disabled");
  assert.equal(addCalls.length, 0, "addItem must never be called");
  assert.equal(items(h).length, 0, "the event does not exist");
  assert.equal(h.composeCalls.length, 0, "nothing may be composed");
});

test("inviteMode: send with TB_API_ALLOW_SEND=1 sends and reports sent", async t => {
  const h = experimentHarness({
    t,
    identities: IDENTITIES,
    env: { TB_API_ALLOW_SEND: "1" }
  });

  const created = await post(h, { ...INVITE, inviteMode: "send" });

  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.invitations.status, "sent");
  assert.equal(callsOf(h, "sendMessage").length, 1);
  assert.equal(callsOf(h, "sendMessage")[0].options.mode, "sendNow");
  assert.equal(callsOf(h, "saveMessage").length, 0, "send mode must not save a draft");
  assert.equal(callsOf(h, "removeTab").length, 0, "a sent message leaves no draft tab to close");
  assert.equal(items(h).length, 1);
});

test("a queued send is reported as queued", async t => {
  const h = experimentHarness({
    t,
    identities: IDENTITIES,
    env: { TB_API_ALLOW_SEND: "1" },
    messenger: { compose: { sendMessage: async () => ({ mode: "queued" }) } }
  });

  const created = await post(h, { ...INVITE, inviteMode: "send" });
  assert.equal(created.status, 201);
  assert.equal(created.body.invitations.status, "queued");
});

// ---------------------------------------------------------------------------
// Organizer identity
// ---------------------------------------------------------------------------

test("an organizer that is not an identity is 400 and addItem is never called", async t => {
  const h = experimentHarness({ t, identities: IDENTITIES });
  const addCalls = spyAddItem(h);

  const refused = await post(h, {
    ...EVENT,
    organizer: "stranger@example.test",
    attendees: ["guest@example.test"],
    sendInvites: true
  });

  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "invalid_parameter");
  assert.match(refused.body.error, /not one of your identities/);
  assert.equal(addCalls.length, 0, "addItem must never be called");
  assert.equal(items(h).length, 0);
  assert.equal(h.composeCalls.length, 0);
});

test("the organizer matches an identity case-insensitively", async t => {
  const h = experimentHarness({ t, identities: [{ id: "id1", email: "Organizer@Example.Test" }] });

  const created = await post(h, { ...INVITE, inviteMode: "draft" });

  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(callsOf(h, "beginNew")[0].details.identityId, "id1");
});

test("with no identities configured an organizer is refused", async t => {
  const h = experimentHarness({ t });
  const addCalls = spyAddItem(h);

  const refused = await post(h, { ...INVITE, inviteMode: "draft" });

  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "invalid_parameter");
  assert.match(refused.body.error, /not one of your identities/);
  assert.equal(addCalls.length, 0);
});

test("invitations without an organizer warn and create the event without inviting", async t => {
  const h = experimentHarness({ t, identities: IDENTITIES });

  const created = await post(h, { ...EVENT, attendees: ["guest@example.test"], sendInvites: true });

  assert.equal(created.status, 201);
  assert.match(created.body.warning, /no organizer/);
  assert.equal(created.body.invitations, undefined);
  assert.equal(h.icsSerializers.length, 0);
  assert.equal(items(h).length, 1);
});

// ---------------------------------------------------------------------------
// ICS: serialized from the item addItem returned
// ---------------------------------------------------------------------------

test("the ICS is serialized from the saved item and its UID is the event id", async t => {
  const h = experimentHarness({ t, identities: IDENTITIES });

  const created = await post(h, { ...INVITE, sendInvites: true });

  const savedItem = items(h)[0];
  assert.equal(h.icsSerializers.length, 1);
  const serializer = h.icsSerializers[0];
  assert.equal(serializer.items.length, 1);
  assert.equal(serializer.items[0], savedItem, "serializer.addItems receives the item addItem returned");
  assert.notEqual(serializer.items[0], addCalls[0], "the pre-save object is not what was serialized");
  assert.deepEqual(
    serializer.properties.map(property => [property.propertyName, property.value]),
    [["METHOD", "REQUEST"]]
  );

  const ics = serializer.serializeToString();
  assert.match(ics, new RegExp(`^UID:${escapeRegExp(created.body.id)}$`, "m"));
  assert.equal(created.body.id, savedItem.id);

  // The attachment carries the serialized content, not a second rendering.
  const attachment = callsOf(h, "addAttachment")[0].attachment;
  assert.equal(attachment.file.parts[0].parts[0], ics);
});

// ---------------------------------------------------------------------------
// The listener's outcome is what the response reports
// ---------------------------------------------------------------------------

test("the listener's returned status is reported verbatim", async t => {
  const h = experimentHarness({
    t,
    identities: IDENTITIES,
    invitationListener: () => ({ status: "sent" })
  });

  const created = await post(h, { ...INVITE, sendInvites: true });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.invitations, { status: "sent" });
});

test("a listener that throws becomes invitations failed, and the event still exists", async t => {
  const h = experimentHarness({
    t,
    identities: IDENTITIES,
    invitationListener: () => {
      throw new Error("listener exploded");
    }
  });

  const created = await post(h, { ...INVITE, sendInvites: true });

  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.invitations.status, "failed");
  assert.match(created.body.invitations.error, /listener exploded/);
  assert.equal(items(h).length, 1, "the event was created before the listener ran");
});

test("a listener returning nothing is reported as failed, not assumed", async t => {
  const h = experimentHarness({
    t,
    identities: IDENTITIES,
    invitationListener: () => undefined
  });

  const created = await post(h, { ...INVITE, sendInvites: true });
  assert.equal(created.status, 201);
  assert.equal(created.body.invitations.status, "failed");
});

test("without a listener the event is still created, with a warning and failed status", async t => {
  const h = experimentHarness({ t, identities: IDENTITIES, noInvitationListener: true });

  const created = await post(h, { ...INVITE, sendInvites: true });

  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.invitations.status, "failed");
  assert.equal(created.body.invitations.error, "background not ready");
  assert.match(created.body.warning, /background not ready/);
  assert.equal(items(h).length, 1, "the event exists");
  assert.equal(h.cal.manager.getCalendars()[0].items[0].getAttendees().length, 1);
});

test("a background failure is reported without failing the event", async t => {
  const h = experimentHarness({
    t,
    identities: IDENTITIES,
    messenger: { compose: { beginNew: async () => { throw new Error("compose unavailable"); } } }
  });

  const created = await post(h, { ...INVITE, sendInvites: true });

  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.invitations.status, "failed");
  assert.match(created.body.invitations.error, /compose unavailable/);
  assert.equal(items(h).length, 1);
});

test("the background never falls back to a different identity", async t => {
  const h = experimentHarness({
    t,
    identities: [{ id: "id1", email: "other@example.test" }],
    // The experiment's own identity list matches the organizer; the background
    // sees a different list and must fail instead of using it.
    mailServices: {
      MailServices: {
        accounts: { allIdentities: [{ email: ORGANIZER }] }
      }
    }
  });

  const created = await post(h, { ...INVITE, sendInvites: true });

  assert.equal(created.status, 201);
  assert.equal(created.body.invitations.status, "failed");
  assert.match(created.body.invitations.error, /No identity matches organizer/);
  assert.equal(callsOf(h, "beginNew").length, 0);
});

// ---------------------------------------------------------------------------
// Updates and cancellations are not sent (Appendix C)
// ---------------------------------------------------------------------------

test("PATCH and DELETE do not prepare or send invitations", async t => {
  const h = experimentHarness({ t, identities: IDENTITIES });

  const created = await post(h, { ...INVITE, sendInvites: true });
  assert.equal(created.body.invitations.status, "draft_saved");
  const callsAfterCreate = h.composeCalls.length;
  const serializersAfterCreate = h.icsSerializers.length;

  const patched = await h.request("PATCH", `/events/${created.body.id}`, {
    queryString: "calendar=test-calendar",
    headers: json,
    body: JSON.stringify({ title: "Moved standup" })
  });
  assert.equal(patched.status, 200);

  const deleted = await h.request("DELETE", `/events/${created.body.id}`, {
    queryString: "calendar=test-calendar"
  });
  assert.equal(deleted.status, 200);

  assert.equal(h.composeCalls.length, callsAfterCreate, "no invitation mail on update/delete");
  assert.equal(h.icsSerializers.length, serializersAfterCreate, "no ICS built on update/delete");
  assert.equal(items(h).length, 0, "the event is deleted");
});
