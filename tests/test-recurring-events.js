"use strict";

// Task 5.3: recurring events -- occurrence vs series (D7).
//
// One occurrence is addressed with the exact `recurrenceId` returned by
// GET /events (timed: UTC instant; all-day: YYYY-MM-DD); the whole series
// with `scope=series`. Without either, a recurring event is 409
// ambiguous_recurrence so a whole series cannot be deleted by accident.
//
// The fake recurrence info follows Appendix A.4: exceptions are matched by
// UTC rid, and cancelling an occurrence adds a negative RDATE (EXDATE) --
// deleteItem must never be used on an occurrence. Every assertion is
// host-timezone independent (the fake's default zone is floating and all
// absolute times carry a zone).
const test = require("node:test");
const assert = require("node:assert/strict");
const { experimentHarness } = require("./helpers/harness.js");

const json = { "Content-Type": "application/json" };

const list = (h, queryString = "start=2026-10-01&end=2026-11-01") =>
  h.request("GET", "/events", { queryString });
const patch = (h, id, payload, queryString = "calendar=test-calendar") =>
  h.request("PATCH", `/events/${id}`, { queryString, headers: json, body: JSON.stringify(payload) });
const del = (h, id, queryString = "calendar=test-calendar") =>
  h.request("DELETE", `/events/${id}`, { queryString });
const ridQuery = rid => `calendar=test-calendar&recurrenceId=${encodeURIComponent(rid)}`;

const timedSeries = () => ({
  id: "series",
  title: "Weekly standup",
  start: "2026-10-14T07:00:00Z",
  end: "2026-10-14T08:00:00Z",
  recurrence: { occurrences: ["2026-10-14T07:00:00Z", "2026-10-21T07:00:00Z"] }
});

const allDaySeries = () => ({
  id: "holidays",
  title: "Day off",
  start: "2026-10-14",
  end: "2026-10-15",
  allDay: true,
  recurrence: { allDay: true, occurrences: ["2026-10-14", "2026-10-21"] }
});

/** Spy on modifyItem/deleteItem while keeping the fake's real behavior. */
function spyCalendar(h) {
  const calendar = h.cal.manager.getCalendars()[0];
  const modifyCalls = [];
  const deleteCalls = [];
  const originalModify = calendar.modifyItem.bind(calendar);
  calendar.modifyItem = async (next, old) => {
    modifyCalls.push({ next, old });
    return originalModify(next, old);
  };
  const originalDelete = calendar.deleteItem.bind(calendar);
  calendar.deleteItem = async item => {
    deleteCalls.push(item);
    return originalDelete(item);
  };
  return { calendar, modifyCalls, deleteCalls };
}

// ---------------------------------------------------------------------------
// Output: itemToEvent
// ---------------------------------------------------------------------------

test("timed occurrences report the series id and the exact UTC recurrenceId", async t => {
  const h = experimentHarness({ t, items: [timedSeries()] });

  const result = await list(h);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.events.length, 2);

  const first = result.body.events[0];
  assert.equal(first.id, "series", "the occurrence id is the series id");
  assert.equal(first.recurrenceId, "2026-10-14T07:00:00Z", "exact UTC instant, not a local string");
  assert.equal(first.occurrence, true);
  assert.ok(!("parentId" in first), "parentId is dropped (it always equalled id)");
  assert.equal(first.start, "2026-10-14T07:00:00");

  assert.equal(result.body.events[1].recurrenceId, "2026-10-21T07:00:00Z");
  assert.equal(result.body.events[1].id, "series");
});

test("all-day occurrences report a date-only recurrenceId", async t => {
  const h = experimentHarness({ t, items: [allDaySeries()] });

  const result = await list(h);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const [first, second] = result.body.events;
  assert.equal(first.id, "holidays");
  assert.equal(first.recurrenceId, "2026-10-14");
  assert.equal(first.occurrence, true);
  assert.equal(first.allDay, true);
  assert.ok(!("parentId" in first));
  assert.equal(first.end, "2026-10-15", "exclusive end is unchanged");
  assert.equal(second.recurrenceId, "2026-10-21");
});

// ---------------------------------------------------------------------------
// Ambiguity guard
// ---------------------------------------------------------------------------

test("a recurring event without recurrenceId or scope=series is 409 ambiguous_recurrence", async t => {
  const h = experimentHarness({ t, items: [timedSeries()] });

  const deleted = await del(h, "series");
  assert.equal(deleted.status, 409);
  assert.equal(deleted.body.code, "ambiguous_recurrence");
  assert.match(deleted.body.error, /recurring/i);
  assert.ok(deleted.body.suggestions.some(s => s.includes("recurrenceId")), "suggests the occurrence option");
  assert.ok(deleted.body.suggestions.some(s => s.includes("scope=series")), "suggests the series option");
  assert.equal(h.cal.manager.getCalendars()[0].items.length, 1, "nothing was deleted");

  const patched = await patch(h, "series", { title: "Nope" });
  assert.equal(patched.status, 409);
  assert.equal(patched.body.code, "ambiguous_recurrence");
  assert.equal(h.cal.manager.getCalendars()[0].items[0].title, "Weekly standup", "nothing was updated");
});

// ---------------------------------------------------------------------------
// Delete: occurrence vs series
// ---------------------------------------------------------------------------

test("DELETE recurrenceId cancels that occurrence and never calls deleteItem", async t => {
  const h = experimentHarness({ t, items: [timedSeries()] });
  const { calendar, modifyCalls, deleteCalls } = spyCalendar(h);

  const result = await del(h, "series", ridQuery("2026-10-21T07:00:00Z"));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.recurrenceId, "2026-10-21T07:00:00Z");
  assert.equal(result.body.scope, "occurrence");
  assert.equal(result.body.message, "Occurrence deleted");

  assert.equal(deleteCalls.length, 0, "deleteItem must never be used for an occurrence");
  assert.equal(modifyCalls.length, 1, "cancelling rewrites the parent with an EXDATE");
  const { next, old } = modifyCalls[0];
  assert.equal(old.id, "series");
  assert.equal(next.recurrenceInfo.removedOccurrences.length, 1);
  assert.equal(
    next.recurrenceInfo.removedOccurrences[0].nativeTime,
    Date.parse("2026-10-21T07:00:00Z") * 1000
  );

  // The cancelled occurrence is gone from the listing; the series survives.
  const listed = await list(h);
  assert.deepEqual(
    listed.body.events.map(event => event.recurrenceId),
    ["2026-10-14T07:00:00Z"]
  );
  assert.equal(calendar.items.length, 1, "the parent item is still there");
});

test("DELETE scope=series deletes the recurring parent", async t => {
  const h = experimentHarness({ t, items: [timedSeries()] });
  const { calendar, deleteCalls } = spyCalendar(h);

  const result = await del(h, "series", "calendar=test-calendar&scope=series");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.scope, "series");
  assert.equal(result.body.message, "Event deleted");

  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0].id, "series");
  assert.ok(deleteCalls[0].recurrenceInfo, "the whole series item is deleted");
  assert.equal(calendar.items.length, 0);
});

test("an all-day occurrence is cancelled with its date-only recurrenceId", async t => {
  const h = experimentHarness({ t, items: [allDaySeries()] });
  const { modifyCalls } = spyCalendar(h);

  const result = await del(h, "holidays", ridQuery("2026-10-21"));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.recurrenceId, "2026-10-21");
  assert.equal(result.body.scope, "occurrence");

  assert.equal(modifyCalls.length, 1);
  assert.equal(modifyCalls[0].next.recurrenceInfo.removedOccurrences[0].isDate, true);

  const listed = await list(h);
  assert.deepEqual(listed.body.events.map(event => event.recurrenceId), ["2026-10-14"]);
});

// ---------------------------------------------------------------------------
// Modified (moved) exceptions
// ---------------------------------------------------------------------------

test("a moved exception is still found by its original recurrenceId", async t => {
  const h = experimentHarness({
    t,
    items: [{
      ...timedSeries(),
      recurrence: {
        occurrences: ["2026-10-14T07:00:00Z", "2026-10-21T07:00:00Z"],
        exceptions: [{
          recurrenceId: "2026-10-21T07:00:00Z",
          start: "2026-11-05T09:00:00Z",
          end: "2026-11-05T10:00:00Z",
          title: "Moved standup"
        }]
      }
    }]
  });
  const { modifyCalls } = spyCalendar(h);

  // The listing applies the exception but keeps the original recurrenceId.
  const listed = await list(h, "start=2026-10-01&end=2026-12-01");
  const moved = listed.body.events.find(event => event.recurrenceId === "2026-10-21T07:00:00Z");
  assert.ok(moved, "the moved occurrence keeps its original recurrenceId");
  assert.equal(moved.start, "2026-11-05T09:00:00");
  assert.equal(moved.title, "Moved standup");

  const result = await patch(h, "series", {
    recurrenceId: "2026-10-21T07:00:00Z",
    title: "Moved again"
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.recurrenceId, "2026-10-21T07:00:00Z");
  assert.equal(result.body.scope, "occurrence");

  assert.equal(modifyCalls.length, 1);
  const { next, old } = modifyCalls[0];
  assert.equal(old.title, "Moved standup");
  assert.equal(
    old.startDate.nativeTime,
    Date.parse("2026-11-05T09:00:00Z") * 1000,
    "the exception was resolved at its moved time"
  );
  assert.equal(next.title, "Moved again");
  assert.equal(
    next.startDate.nativeTime,
    Date.parse("2026-11-05T09:00:00Z") * 1000,
    "the moved time is preserved by the edit"
  );
});

// ---------------------------------------------------------------------------
// Errors: unknown rid, non-recurring target, contradictory parameters
// ---------------------------------------------------------------------------

test("an unknown recurrenceId is 404 occurrence_not_found", async t => {
  const h = experimentHarness({ t, items: [timedSeries()] });
  const { modifyCalls, deleteCalls } = spyCalendar(h);

  const deleted = await del(h, "series", ridQuery("2026-10-28T07:00:00Z"));
  assert.equal(deleted.status, 404);
  assert.equal(deleted.body.code, "occurrence_not_found");

  const patched = await patch(h, "series", { recurrenceId: "2026-10-28T07:00:00Z", title: "No" });
  assert.equal(patched.status, 404);
  assert.equal(patched.body.code, "occurrence_not_found");

  const malformed = await del(h, "series", ridQuery("garbage"));
  assert.equal(malformed.status, 404);
  assert.equal(malformed.body.code, "occurrence_not_found");

  assert.equal(modifyCalls.length, 0);
  assert.equal(deleteCalls.length, 0, "an unknown rid changes nothing");
});

test("a non-recurring event with recurrenceId is 400 and otherwise behaves as before", async t => {
  const h = experimentHarness({
    t,
    items: [{ id: "single", title: "One-off", start: "2026-10-14T07:00:00Z", end: "2026-10-14T08:00:00Z" }]
  });
  const { calendar } = spyCalendar(h);

  const deleted = await del(h, "single", ridQuery("2026-10-14T07:00:00Z"));
  assert.equal(deleted.status, 400);
  assert.equal(deleted.body.code, "not_recurring");
  assert.match(deleted.body.error, /not recurring/i);
  assert.equal(calendar.items.length, 1);

  const patched = await patch(h, "single", { recurrenceId: "2026-10-14T07:00:00Z", title: "No" });
  assert.equal(patched.status, 400);
  assert.equal(patched.body.code, "not_recurring");
  assert.equal(calendar.items[0].title, "One-off");

  // scope=series on a non-recurring event is "as today": no scope in the
  // response, and the item is deleted like any other event.
  const seriesScoped = await del(h, "single", "calendar=test-calendar&scope=series");
  assert.equal(seriesScoped.status, 200, JSON.stringify(seriesScoped.body));
  assert.equal(seriesScoped.body.scope, undefined);
  assert.equal(calendar.items.length, 0);
});

test("recurrenceId and scope=series together, or a bad scope, are 400", async t => {
  const h = experimentHarness({ t, items: [timedSeries()] });
  const { calendar } = spyCalendar(h);

  const both = await patch(h, "series", {
    recurrenceId: "2026-10-21T07:00:00Z",
    scope: "series",
    title: "Nope"
  });
  assert.equal(both.status, 400);
  assert.equal(both.body.code, "invalid_parameter");

  const badScope = await del(h, "series", "calendar=test-calendar&scope=occurrence");
  assert.equal(badScope.status, 400);
  assert.equal(badScope.body.code, "invalid_parameter");

  const emptyRid = await del(h, "series", "calendar=test-calendar&recurrenceId=");
  assert.equal(emptyRid.status, 400);
  assert.equal(emptyRid.body.code, "invalid_parameter");

  assert.equal(calendar.items[0].title, "Weekly standup");
});

// ---------------------------------------------------------------------------
// Update: occurrence vs series
// ---------------------------------------------------------------------------

test("PATCH recurrenceId updates only that occurrence", async t => {
  const h = experimentHarness({ t, items: [timedSeries()] });
  const { modifyCalls } = spyCalendar(h);
  const parent = h.cal.manager.getCalendars()[0].items[0];

  const result = await patch(h, "series", {
    recurrenceId: "2026-10-21T07:00:00Z",
    title: "This week only"
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.id, "series");
  assert.equal(result.body.title, "This week only");
  assert.equal(result.body.recurrenceId, "2026-10-21T07:00:00Z");
  assert.equal(result.body.scope, "occurrence");
  assert.equal(result.body.message, "Occurrence updated");

  assert.equal(modifyCalls.length, 1);
  assert.equal(modifyCalls[0].old.recurrenceId.nativeTime, Date.parse("2026-10-21T07:00:00Z") * 1000);
  assert.equal(modifyCalls[0].next.title, "This week only");
  assert.equal(parent.title, "Weekly standup", "the series title is untouched");

  const listed = await list(h);
  const updated = listed.body.events.find(event => event.recurrenceId === "2026-10-21T07:00:00Z");
  assert.equal(updated.title, "This week only");
  assert.equal(updated.start, "2026-10-21T07:00:00");
  const untouched = listed.body.events.find(event => event.recurrenceId === "2026-10-14T07:00:00Z");
  assert.equal(untouched.title, "Weekly standup");
});

test("PATCH scope=series updates the parent", async t => {
  const h = experimentHarness({ t, items: [timedSeries()] });
  const { modifyCalls } = spyCalendar(h);
  const parent = h.cal.manager.getCalendars()[0].items[0];

  const result = await patch(h, "series", { scope: "series", title: "Renamed series" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.scope, "series");
  assert.equal(result.body.title, "Renamed series");
  assert.ok(!("recurrenceId" in result.body));

  assert.equal(modifyCalls.length, 1);
  assert.equal(modifyCalls[0].old, parent, "the parent is the modified item");
  assert.equal(modifyCalls[0].next.title, "Renamed series");

  const listed = await list(h);
  for (const occurrence of listed.body.events) {
    assert.equal(occurrence.title, "Renamed series");
  }
});

// ---------------------------------------------------------------------------
// Update: start/end type consistency (5.1 review carry-over) + 5.2 validation
// ---------------------------------------------------------------------------

test("an update never leaves a date-only end beside a timed start", async t => {
  const h = experimentHarness({
    t,
    items: [{ id: "single", title: "Standup", start: "2026-10-14T07:00:00Z", end: "2026-10-14T08:00:00Z" }]
  });

  // Timed -> all-day with only an all-day end supplied: the start follows.
  const converted = await patch(h, "single", { end: "2026-10-15", allDay: true });
  assert.equal(converted.status, 200, JSON.stringify(converted.body));
  const item = h.cal.manager.getCalendars()[0].items[0];
  assert.equal(item.startDate.isDate, true, "the timed start became date-only");
  assert.equal(item.endDate.isDate, true);
  assert.equal(item.startDate.nativeTime, Date.UTC(2026, 9, 14) * 1000);
  assert.equal(item.endDate.nativeTime, Date.UTC(2026, 9, 15) * 1000);
});

test("an all-day event can be converted back to timed with both values", async t => {
  const h = experimentHarness({
    t,
    items: [{ id: "day", title: "Day off", start: "2026-10-14", end: "2026-10-15", allDay: true }]
  });

  const converted = await patch(h, "day", {
    allDay: false,
    start: "2026-10-14T09:00:00Z",
    end: "2026-10-14T10:00:00Z"
  });
  assert.equal(converted.status, 200, JSON.stringify(converted.body));
  const item = h.cal.manager.getCalendars()[0].items[0];
  assert.equal(item.startDate.isDate, false);
  assert.equal(item.endDate.isDate, false);
  assert.equal(item.startDate.nativeTime, Date.parse("2026-10-14T09:00:00Z") * 1000);
  assert.equal(item.endDate.nativeTime, Date.parse("2026-10-14T10:00:00Z") * 1000);
});

test("PATCH rejects end <= start when the update leaves both values known", async t => {
  const h = experimentHarness({
    t,
    items: [{ id: "single", title: "Standup", start: "2026-10-14T07:00:00Z", end: "2026-10-14T08:00:00Z" }]
  });

  // The stored end (08:00Z) is now before the requested start.
  const invalid = await patch(h, "single", { start: "2026-10-14T09:00:00Z" });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.equal(invalid.body.code, "invalid_date");
  assert.equal(h.cal.manager.getCalendars()[0].items[0].startDate.nativeTime, Date.parse("2026-10-14T07:00:00Z") * 1000);

  const equal = await patch(h, "single", {
    start: "2026-10-14T07:00:00Z",
    end: "2026-10-14T07:00:00Z"
  });
  assert.equal(equal.status, 400);
  assert.equal(equal.body.code, "invalid_date");
});

test("an occurrence update rejects end <= start too", async t => {
  const h = experimentHarness({ t, items: [timedSeries()] });
  const { modifyCalls } = spyCalendar(h);

  const invalid = await patch(h, "series", {
    recurrenceId: "2026-10-21T07:00:00Z",
    start: "2026-10-21T10:00:00Z",
    end: "2026-10-21T09:00:00Z"
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "invalid_date");
  assert.equal(modifyCalls.length, 0, "nothing may be stored on a validation failure");

  const valid = await patch(h, "series", {
    recurrenceId: "2026-10-21T07:00:00Z",
    start: "2026-10-21T09:00:00Z",
    end: "2026-10-21T10:00:00Z"
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
  assert.equal(modifyCalls.length, 1);
  assert.equal(modifyCalls[0].next.startDate.nativeTime, Date.parse("2026-10-21T09:00:00Z") * 1000);
  assert.equal(modifyCalls[0].next.endDate.nativeTime, Date.parse("2026-10-21T10:00:00Z") * 1000);

  const listed = await list(h);
  const moved = listed.body.events.find(event => event.recurrenceId === "2026-10-21T07:00:00Z");
  assert.equal(moved.start, "2026-10-21T09:00:00");
  assert.equal(moved.end, "2026-10-21T10:00:00");
});
