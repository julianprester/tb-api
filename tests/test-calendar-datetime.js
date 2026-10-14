"use strict";

// Tasks 5.1 + 5.2: datetime conversion in both directions and range
// validation order.
//
// The fake cal follows Appendix A.4: floating and all-day values are read as
// UTC, so an all-day event must report the same calendar date no matter the
// host timezone. CI runs the whole suite under TZ=Australia/Sydney and
// TZ=America/New_York, and every assertion here is host-timezone independent:
// absolute inputs carry an offset, and the calendar's default zone is a fixed
// offset configured on the fake.
const test = require("node:test");
const assert = require("node:assert/strict");
const { experimentHarness } = require("./helpers/harness.js");

const json = { "Content-Type": "application/json" };

// The calendar reports in UTC+2; items may be stored in another zone to prove
// the conversion happens.
const DEFAULT_ZONE = { tzid: "Test/Default", offsetMinutes: 120 };
const STORED_ZONE = { tzid: "Test/Stored", offsetMinutes: -300 };

const list = (h, queryString) => h.request("GET", "/events", { queryString });
const create = (h, payload) =>
  h.request("POST", "/events", { headers: json, body: JSON.stringify(payload) });
const patch = (h, id, payload) =>
  h.request("PATCH", `/events/${id}`, {
    queryString: "calendar=test-calendar",
    headers: json,
    body: JSON.stringify(payload)
  });

// ---------------------------------------------------------------------------
// 5.1 Output: itemToEvent
// ---------------------------------------------------------------------------

test("all-day events report the calendar date, not a UTC-shifted datetime", async t => {
  const h = experimentHarness({
    t,
    timezone: DEFAULT_ZONE,
    items: [
      { id: "holiday", title: "Holiday", start: "2026-10-14", end: "2026-10-15", allDay: true }
    ]
  });

  const result = await list(h, "start=2026-10-01&end=2026-11-01");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const [event] = result.body.events;
  assert.ok(event, "the all-day event is in range");
  assert.equal(event.start, "2026-10-14", "all-day start is the calendar date");
  assert.equal(event.end, "2026-10-15", "all-day end is the EXCLUSIVE end date");
  assert.equal(event.allDay, true);
  assert.equal(event.timezone, "Test/Default");
});

test("timed events are converted from their stored zone to the calendar's default zone", async t => {
  const h = experimentHarness({
    t,
    timezone: DEFAULT_ZONE,
    items: [
      // 07:00Z is 02:00 in the stored zone and 09:00 in UTC+2.
      {
        id: "standup",
        title: "Standup",
        start: "2026-10-14T07:00:00Z",
        end: "2026-10-14T09:00:00Z",
        timezone: STORED_ZONE
      }
    ]
  });

  const result = await list(h, "start=2026-10-01T00:00:00Z&end=2026-11-01T00:00:00Z");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const [event] = result.body.events;
  assert.equal(event.start, "2026-10-14T09:00:00", "reported in the default zone");
  assert.equal(event.end, "2026-10-14T11:00:00");
  assert.equal(event.allDay, false);
  assert.equal(event.timezone, "Test/Default");
});

test("floating timed events are reported as stored, not shifted into the default zone", async t => {
  const h = experimentHarness({
    t,
    timezone: DEFAULT_ZONE,
    items: [
      {
        id: "floating",
        title: "Floating",
        start: "2026-10-14T07:00:00Z",
        end: "2026-10-14T08:00:00Z",
        timezone: { tzid: "floating", isFloating: true }
      }
    ]
  });

  const result = await list(h, "start=2026-10-01T00:00:00Z&end=2026-11-01T00:00:00Z");
  const [event] = result.body.events;
  assert.equal(event.start, "2026-10-14T07:00:00", "a floating value keeps its own wall time");
  assert.equal(event.end, "2026-10-14T08:00:00");
});

test("range queries build their limits in the calendar's default timezone", async t => {
  const h = experimentHarness({ t, timezone: DEFAULT_ZONE });
  const calendar = h.cal.manager.getCalendars()[0];
  const original = calendar.getItemsAsArray.bind(calendar);
  const ranges = [];
  calendar.getItemsAsArray = (filter, count, from, to) => {
    ranges.push({ from, to });
    return original(filter, count, from, to);
  };

  const listed = await list(h, "start=2026-10-01T00:00:00Z&end=2026-11-01T00:00:00Z");
  assert.equal(listed.status, 200);
  const upcoming = await h.request("GET", "/upcoming");
  assert.equal(upcoming.status, 200);

  assert.equal(ranges.length, 2, "listEvents and upcomingEvents each query one calendar");
  assert.equal(ranges[0].from.nativeTime, Date.parse("2026-10-01T00:00:00Z") * 1000);
  assert.equal(ranges[0].to.nativeTime, Date.parse("2026-11-01T00:00:00Z") * 1000);
  for (const { from, to } of ranges) {
    assert.equal(from.timezone.tzid, "Test/Default");
    assert.equal(to.timezone.tzid, "Test/Default");
  }
});

// ---------------------------------------------------------------------------
// 5.1 Input: create/update
// ---------------------------------------------------------------------------

test("create -> list round trip keeps the wall time of the default zone", async t => {
  const h = experimentHarness({ t, timezone: DEFAULT_ZONE });

  const created = await create(h, {
    title: "Review",
    start: "2026-10-14T09:30:00+02:00",
    end: "2026-10-14T10:30:00+02:00"
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.start, "2026-10-14T09:30:00");
  assert.equal(created.body.end, "2026-10-14T10:30:00");
  assert.equal(created.body.allDay, false);

  const result = await list(h, "start=2026-10-01T00:00:00Z&end=2026-11-01T00:00:00Z");
  const [event] = result.body.events;
  assert.equal(event.start, "2026-10-14T09:30:00", "the stored wall time comes back unchanged");
  assert.equal(event.end, "2026-10-14T10:30:00");
  assert.equal(event.timezone, "Test/Default");
  assert.equal(event.allDay, false);
});

test("allDay create stores an isDate event and keeps the exclusive end", async t => {
  const h = experimentHarness({ t, timezone: DEFAULT_ZONE });

  const created = await create(h, {
    title: "Holiday",
    start: "2026-10-14",
    end: "2026-10-17",
    allDay: true
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.allDay, true);
  assert.equal(created.body.start, "2026-10-14");
  assert.equal(created.body.end, "2026-10-17");

  const item = h.cal.manager.getCalendars()[0].items[0];
  assert.equal(item.startDate.isDate, true, "all-day start is a DATE, not a datetime");
  assert.equal(item.endDate.isDate, true);
  assert.equal(item.startDate.nativeTime, Date.UTC(2026, 9, 14) * 1000);
  assert.equal(item.endDate.nativeTime, Date.UTC(2026, 9, 17) * 1000);

  const listed = await list(h, "start=2026-10-01&end=2026-11-01");
  const [event] = listed.body.events;
  assert.equal(event.start, "2026-10-14");
  assert.equal(event.end, "2026-10-17", "end is the exclusive end date");
  assert.equal(event.allDay, true);
});

test("allDay create without end covers exactly one day", async t => {
  const h = experimentHarness({ t, timezone: DEFAULT_ZONE });

  const created = await create(h, { title: "Day off", start: "2026-12-24", allDay: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const item = h.cal.manager.getCalendars()[0].items[0];
  assert.equal(item.startDate.nativeTime, Date.UTC(2026, 11, 24) * 1000);
  assert.equal(item.endDate.nativeTime, Date.UTC(2026, 11, 25) * 1000);

  const listed = await list(h, "start=2026-12-01&end=2027-01-01");
  assert.equal(listed.body.events[0].start, "2026-12-24");
  assert.equal(listed.body.events[0].end, "2026-12-25");
});

test("allDay takes the strict boolean spellings and defaults to false", async t => {
  const cases = [
    [undefined, false], [false, false], [0, false], ["false", false], ["0", false],
    [true, true], [1, true], ["1", true], ["true", true]
  ];
  for (const [value, expected] of cases) {
    const h = experimentHarness({ t });
    const payload = { title: "Standup", start: "2026-10-14", end: "2026-10-15" };
    if (value !== undefined) payload.allDay = value;
    const result = await create(h, payload);
    assert.equal(result.status, 201, `allDay=${JSON.stringify(value)}: ${JSON.stringify(result.body)}`);
    const item = h.cal.manager.getCalendars()[0].items[0];
    assert.equal(item.startDate.isDate, expected, `allDay=${JSON.stringify(value)}`);
  }

  // The snake_case alias is accepted too.
  const h = experimentHarness({ t });
  const aliased = await create(h, { title: "Holiday", start: "2026-10-14", all_day: true });
  assert.equal(aliased.status, 201);
  assert.equal(h.cal.manager.getCalendars()[0].items[0].startDate.isDate, true);
});

test("invalid allDay is 400 invalid_filter and creates nothing", async t => {
  for (const value of ["yes", "maybe", "TRUE", 2, -1, "", null, {}, []]) {
    const h = experimentHarness({ t });
    const result = await create(h, {
      title: "Standup",
      start: "2026-10-14",
      end: "2026-10-15",
      allDay: value
    });
    assert.equal(result.status, 400, `allDay=${JSON.stringify(value)}`);
    assert.equal(result.body.code, "invalid_filter");
    assert.match(result.body.error, /allDay must be true, false, 1 or 0/);
    assert.equal(h.cal.manager.getCalendars()[0].items.length, 0, "no event may be created");
  }
});

test("allDay create refuses relative, timed and impossible dates", async t => {
  const h = experimentHarness({ t });
  const cases = [
    [{ title: "E", start: "tomorrow", allDay: true }, "relative start"],
    [{ title: "E", start: "2026-10-14T09:00:00", allDay: true }, "timed start"],
    [{ title: "E", start: "2026-10-14", end: "tomorrow", allDay: true }, "relative end"],
    [{ title: "E", start: "2026-10-14", end: "2026-10-14", allDay: true }, "end == start"],
    [{ title: "E", start: "2026-10-14", end: "2026-10-13", allDay: true }, "end < start"],
    [{ title: "E", start: "2026-02-31", allDay: true }, "impossible date"],
    // start + 1 day would leave the four-digit-year range
    [{ title: "E", start: "9999-12-31", allDay: true }, "year overflow"]
  ];
  for (const [payload, label] of cases) {
    const result = await create(h, payload);
    assert.equal(result.status, 400, label);
    assert.equal(result.body.code, "invalid_date", label);
    assert.equal(h.cal.manager.getCalendars()[0].items.length, 0, label);
  }

  // A missing start keeps the existing invalid_parameter contract.
  const missing = await create(h, { title: "E", allDay: true });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "invalid_parameter");
});

test("allDay PATCH stores date-only values; omitted end covers one day", async t => {
  const h = experimentHarness({
    t,
    timezone: DEFAULT_ZONE,
    items: [
      { id: "e1", title: "Standup", start: "2026-10-14T09:00:00Z", end: "2026-10-14T10:00:00Z" }
    ]
  });

  const invalid = await patch(h, "e1", { allDay: "yes" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "invalid_filter");

  const moved = await patch(h, "e1", { start: "2026-12-24", allDay: true });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const item = h.cal.manager.getCalendars()[0].items[0];
  assert.equal(item.startDate.isDate, true);
  assert.equal(item.startDate.nativeTime, Date.UTC(2026, 11, 24) * 1000);
  assert.equal(item.endDate.isDate, true);
  assert.equal(item.endDate.nativeTime, Date.UTC(2026, 11, 25) * 1000);

  const refused = await patch(h, "e1", { end: "tomorrow", allDay: true });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "invalid_date");
});

// ---------------------------------------------------------------------------
// 5.2 Validation order
// ---------------------------------------------------------------------------

test("GET /events validates start before defaulting the end (no 500)", async t => {
  const h = experimentHarness({ t });

  const garbage = await list(h, "start=garbage");
  assert.equal(garbage.status, 400);
  assert.equal(garbage.body.code, "invalid_date");
  assert.equal(garbage.body.error, 'Could not parse date: "garbage"');
  assert.equal(h.instance.pendingRequests.size, 0, "the request is answered, not left pending");
});

test("GET /events with end <= start is 400 invalid_date", async t => {
  const h = experimentHarness({ t });

  for (const query of [
    "start=2030-01-02&end=2030-01-01",
    "start=2030-01-01&end=2030-01-01",
    "start=2030-01-01T10:00:00Z&end=2030-01-01T09:00:00Z"
  ]) {
    const result = await list(h, query);
    assert.equal(result.status, 400, query);
    assert.equal(result.body.code, "invalid_date", query);
  }

  const valid = await list(h, "start=2030-01-01&end=2030-01-02");
  assert.equal(valid.status, 200);
  assert.ok(Array.isArray(valid.body.events));
});
