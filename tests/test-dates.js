"use strict";

// Task 2.5: one date parser shared by the background (email) and experiment
// (calendar) scopes. `now` is injected so every expectation is deterministic;
// the suite runs under two TZs in CI, so the local-midnight assertions here
// are timezone-sensitive on purpose.

const test = require("node:test");
const assert = require("node:assert/strict");
const { backgroundHarness, experimentHarness } = require("./helpers/harness.js");

// Harness values come from a vm realm, so clone before deep comparisons.
const plain = value => JSON.parse(JSON.stringify(value));

// Wednesday 2024-06-12 15:45:30 local.
const NOW = new Date(2024, 5, 12, 15, 45, 30);
const MONDAY = new Date(2024, 0, 1, 15); // Monday 2024-01-01
const SUNDAY = new Date(2024, 0, 7, 9); // Sunday 2024-01-07

const h = backgroundHarness();
const parse = (input, now = NOW) => h.Utils.parseDate(input, { now });

/** Local midnight (or the given local time) with 1-based months. */
const local = (y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) => new Date(y, m - 1, d, hh, mm, ss, ms);

function assertAt(actual, expected, message) {
  assert.ok(actual, `${message}: expected a Date, got ${actual}`);
  assert.equal(actual.getTime(), expected.getTime(), message);
}

test("date-only input is local midnight (D9)", () => {
  const date = parse("2024-01-15");
  assertAt(date, local(2024, 1, 15), "2024-01-15");
  assert.equal(date.getFullYear(), 2024, "local year");
  assert.equal(date.getMonth(), 0, "local month");
  assert.equal(date.getDate(), 15, "local day");
  assert.equal(date.getHours(), 0, "local midnight");
  assert.equal(date.getMinutes(), 0, "local midnight");
});

test("ISO datetimes are local unless they carry an offset", () => {
  assertAt(parse("2024-01-15T10:30:00"), local(2024, 1, 15, 10, 30, 0), "local datetime");
  assertAt(parse("2024-01-15T10:30:45.123"), local(2024, 1, 15, 10, 30, 45, 123), "local ms");
  assertAt(parse("2024-01-15T10:30:00Z"), new Date(Date.UTC(2024, 0, 15, 10, 30, 0)), "Z instant");
  assertAt(parse("2024-01-15T10:30:00+02:00"), new Date(Date.UTC(2024, 0, 15, 8, 30, 0)), "+02:00 instant");
  assertAt(parse("2024-01-15T10:30:00+0200"), new Date(Date.UTC(2024, 0, 15, 8, 30, 0)), "+0200 instant");
});

test("relative words resolve to local midnight (except now)", () => {
  const cases = [
    ["now", new Date(NOW.getTime())],
    ["today", local(2024, 6, 12)],
    ["yesterday", local(2024, 6, 11)],
    ["tomorrow", local(2024, 6, 13)],
    ["last week", local(2024, 6, 5)],
    ["next week", local(2024, 6, 19)],
    ["last month", local(2024, 5, 12)],
    ["next month", local(2024, 7, 12)],
    ["a week ago", local(2024, 6, 5)],
    ["a month ago", local(2024, 5, 12)],
    ["2 days ago", local(2024, 6, 10)],
    ["in 3 days", local(2024, 6, 15)],
    ["2 weeks ago", local(2024, 5, 29)],
    ["in 2 weeks", local(2024, 6, 26)],
    ["3 months ago", local(2024, 3, 12)],
    ["in 3 months", local(2024, 9, 12)]
  ];
  for (const [input, expected] of cases) {
    assertAt(parse(input), expected, input);
  }
});

test("weekdays follow the R2.5 ruling (Monday-based)", () => {
  const cases = [
    // Wednesday: next/bare are strictly after today, last is strictly before,
    // "this" is the current ISO week.
    [NOW, "next monday", local(2024, 6, 17)],
    [NOW, "monday", local(2024, 6, 17)],
    [NOW, "last monday", local(2024, 6, 10)],
    [NOW, "this monday", local(2024, 6, 10)],
    [NOW, "next friday", local(2024, 6, 14)],
    [NOW, "this friday", local(2024, 6, 14)],
    [NOW, "last friday", local(2024, 6, 7)],
    [NOW, "next wednesday", local(2024, 6, 19)],
    // On a Monday, "next monday" is +7 days because today is excluded.
    [MONDAY, "next monday", local(2024, 1, 8)],
    [MONDAY, "monday", local(2024, 1, 8)],
    [MONDAY, "last monday", local(2023, 12, 25)],
    [MONDAY, "this monday", local(2024, 1, 1)],
    // On a Sunday, bare "monday" is tomorrow and "this monday" is the past
    // Monday that opened the current ISO week.
    [SUNDAY, "next monday", local(2024, 1, 8)],
    [SUNDAY, "monday", local(2024, 1, 8)],
    [SUNDAY, "last monday", local(2024, 1, 1)],
    [SUNDAY, "this monday", local(2024, 1, 1)],
    [SUNDAY, "this sunday", local(2024, 1, 7)],
    [SUNDAY, "next sunday", local(2024, 1, 14)]
  ];
  for (const [now, input, expected] of cases) {
    assertAt(parse(input, now), expected, `${input} on ${now.toDateString()}`);
  }
});

test("parseDate copies the injected now and never mutates it", () => {
  const caller = new Date(2024, 0, 1, 15, 30, 45, 123);
  const frozen = caller.getTime();

  assertAt(parse("today", caller), local(2024, 1, 1), "today");
  assertAt(parse("yesterday", caller), local(2023, 12, 31), "yesterday");
  assert.equal(caller.getTime(), frozen, "caller's Date must not be mutated");

  const nowCopy = parse("now", caller);
  assert.equal(nowCopy.getTime(), frozen, "now keeps the time of day");
});

test("natural formats parse only with a four-digit year", () => {
  assert.equal(parse("Jan 15"), null, "no year -> refused instead of 2001");
  assert.equal(parse("next fortnight"), null);
  assert.equal(parse("garbage"), null);
  assert.equal(parse(""), null);
  assert.equal(parse(null), null);
  assert.equal(parse(undefined), null);
  assert.equal(parse("2024-02-31"), null, "impossible calendar date");

  const cases = [
    ["Jan 15 2024", local(2024, 1, 15)],
    ["January 15 2024", local(2024, 1, 15)],
    ["15/01/2024", local(2024, 1, 15)],
    ["01-15-2024", local(2024, 1, 15)],
    ["31-12-2024", local(2024, 12, 31)],
    ["01/05/2024", local(2024, 5, 1)],
    ["01-05-2024", local(2024, 1, 5)]
  ];
  for (const [input, expected] of cases) {
    assertAt(parse(input), expected, input);
  }
});

test("plus is a space except in an ISO timezone offset", () => {
  assertAt(parse("next+monday", MONDAY), local(2024, 1, 8), "next+monday");
  assertAt(parse("in+2+weeks"), local(2024, 6, 26), "in+2+weeks");
  assertAt(parse("Jan+15+2024"), local(2024, 1, 15), "Jan+15+2024");
  assertAt(
    parse("2024-01-15T10:30:00+02:00"),
    new Date(Date.UTC(2024, 0, 15, 8, 30, 0)),
    "+02:00 must survive"
  );
});

test("prototype keys are not weekdays and overflowing numbers are rejected", () => {
  // `WEEKDAYS[key]` used to walk the prototype chain: "constructor" resolved to
  // `Object` and returned a truthy Date, while "this constructor" returned a
  // truthy Invalid Date.
  assert.equal(parse("constructor"), null, "prototype key must not be a weekday");
  assert.equal(parse("this constructor"), null, "this + prototype key");
  assert.equal(parse("next constructor"), null, "next + prototype key");
  assert.equal(parse("last constructor"), null, "last + prototype key");

  // Unbounded N used to overflow the Date constructor and yield a truthy
  // Invalid Date instead of null.
  assert.equal(parse("99999999999999999999 days ago"), null, "overflowing days ago");
  assert.equal(parse("in 99999999999999999999 days"), null, "overflowing in N days");
  assert.equal(parse("99999999999999999999 weeks ago"), null, "overflowing weeks ago");
  assert.equal(parse("in 99999999999999999999 months"), null, "overflowing in N months");
});

test("every DATE_SUGGESTIONS example parses to a valid Date", () => {
  const suggestions = h.Utils.DATE_SUGGESTIONS;
  assert.ok(Array.isArray(suggestions) && suggestions.length > 0, "non-empty list");
  for (const example of suggestions) {
    const result = parse(example);
    assert.ok(result, `suggestion does not parse: ${example}`);
    assert.ok(Number.isFinite(result?.getTime()), `suggestion parses to an Invalid Date: ${example}`);
  }
});

test("GET / tips list only date forms covered by tests", async () => {
  const response = await h.request("GET", "/");
  const tip = response.body.tips.find(text => text.startsWith("Dates accept: "));
  assert.ok(tip, "GET / must advertise the date forms");
  for (const example of h.Utils.DATE_SUGGESTIONS) {
    assert.ok(tip.includes(example), `tip is missing suggestion: ${example}`);
  }
});

test("email and calendar accept identical date inputs (one parser)", async t => {
  const h = experimentHarness({ t });

  const accepted = [
    "2024-01-15",
    "2024-01-15T10:30:00",
    "today",
    "tomorrow",
    "yesterday",
    "next week",
    "last week",
    "in 2 weeks",
    "2 weeks ago",
    "next monday",
    "last friday",
    "Jan 15 2024",
    "15/01/2024"
  ];
  for (const input of accepted) {
    const email = await h.request("GET", "/messages", { queryString: `after=${encodeURIComponent(input)}` });
    assert.equal(email.status, 200, `email rejected ${input}: ${JSON.stringify(email.body)}`);
    const calendar = await h.request("GET", "/events", { queryString: `start=${encodeURIComponent(input)}` });
    assert.equal(calendar.status, 200, `calendar rejected ${input}: ${JSON.stringify(calendar.body)}`);
  }

  const rejected = ["Jan 15", "garbage", "next fortnight", "constructor", "99999999999999999999 days ago"];
  for (const input of rejected) {
    const email = await h.request("GET", "/messages", { queryString: `after=${encodeURIComponent(input)}` });
    assert.equal(email.status, 400, `email accepted ${input}`);
    assert.equal(email.body.code, "invalid_date", input);

    // `end` (not `start`): GET /events?start=<unparseable> hits the range
    // defaulting order fixed by Task 5.2, so the null check is not reachable.
    const calendar = await h.request("GET", "/events", { queryString: `end=${encodeURIComponent(input)}` });
    assert.equal(calendar.status, 400, `calendar accepted ${input}`);
    assert.equal(calendar.body.code, "invalid_date", input);
  }
});

test("parse errors suggest only date forms that parse", async t => {
  const bg = backgroundHarness();
  const email = await bg.request("GET", "/messages", "after=Jan+15");
  assert.equal(email.status, 400);
  assert.equal(email.body.code, "invalid_date");
  assert.equal(email.body.error, 'Could not parse date: "Jan 15"');
  assert.deepEqual(plain(email.body.suggestions), plain(bg.Utils.DATE_SUGGESTIONS));

  const cal = experimentHarness({ t });
  const events = await cal.request("GET", "/events", { queryString: "end=Jan+15" });
  assert.equal(events.status, 400);
  assert.equal(events.body.code, "invalid_date");
  assert.equal(events.body.error, 'Could not parse date: "Jan 15"');
  assert.deepEqual(plain(events.body.suggestions), plain(cal.Utils.DATE_SUGGESTIONS));
});
