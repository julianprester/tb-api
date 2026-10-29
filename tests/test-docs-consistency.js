"use strict";

// Documentation consistency: every route the extension actually handles must be
// described by GET / (driven through the real background handler) and appear in
// README.md. The routes are extracted from the source instead of hard-coded, so
// a new endpoint cannot ship without being documented in both surfaces.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { backgroundHarness } = require("./helpers/harness.js");

const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Non-empty path segments: "/messages/:id" -> ["messages", ":id"]. */
function routeSegments(route) {
  return route.split("/").filter(Boolean);
}

/** Shape comparison, tolerating different dynamic-segment names. */
function sameRoute(a, b) {
  const left = routeSegments(a);
  const right = routeSegments(b);
  if (left.length !== right.length) return false;
  return left.every((segment, index) =>
    segment === right[index] ||
    (segment.startsWith(":") && right[index].startsWith(":"))
  );
}

/**
 * Literal paths background.js dispatches on: equality checks plus prefix
 * checks whose tail is a dynamic path parameter.
 */
function backgroundRoutes(source) {
  const routes = new Set();
  for (const match of source.matchAll(/path === "(\/[^"]*)"/g)) routes.add(match[1]);
  for (const match of source.matchAll(/path\.startsWith\("(\/[^"]*)\/"\)/g)) routes.add(`${match[1]}/:id`);
  // The attachment route is matched with a regular expression rather than an
  // equality/prefix check, so the sweep names it explicitly.
  if (source.includes("/^\\/messages\\/([^/]+)\\/attachments\\/([^/]+)$/")) {
    routes.add("/messages/:id/attachments/:partName");
  }
  return routes;
}

/** Literal paths handled by experiment/api.js's isCalendarRoute. */
function calendarRoutes(source) {
  const body = source.match(/function isCalendarRoute\(path\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(body, "isCalendarRoute(path) not found in experiment/api.js");
  const routes = new Set();
  for (const match of body[1].matchAll(/path === "(\/[^"]*)"/g)) routes.add(match[1]);
  for (const match of body[1].matchAll(/path\.startsWith\("(\/[^"]*)\/"\)/g)) routes.add(`${match[1]}/:id`);
  return routes;
}

const background = backgroundRoutes(read("tb-api/background.js"));
const calendar = calendarRoutes(read("tb-api/experiment/api.js"));
const routes = new Set([...background, ...calendar]);

/** Paths described by the GET / payload (keys look like "GET /messages"). */
function apiRoutes(info) {
  const paths = new Set();
  for (const group of Object.values(info.endpoints)) {
    for (const key of Object.keys(group)) {
      paths.add(key.slice(key.indexOf(" ") + 1));
    }
  }
  return paths;
}

/**
 * Regex matching a route in README.md while tolerating markdown around it and
 * different dynamic-segment spellings (`:id`, `:message_id`).
 */
function readmePattern(route) {
  if (route === "/") {
    // The README documents the root endpoint as `GET /` in a code block.
    return /(?:^|[`\s(])GET \/(?=\s|$|`)/m;
  }

  const segments = routeSegments(route);
  let pattern = "(?:^|[^\\w/])";
  for (const segment of segments) {
    pattern += segment.startsWith(":")
      ? "\\/[:<]?[\\w-]+>?"
      : `\\/${escapeRegExp(segment)}`;
  }

  // An exact route must not be satisfied by a longer path that merely starts
  // with it (`/messages` is not documented by `GET /messages/:message_id`).
  // A dynamic route may be followed by a query string or punctuation.
  const last = segments[segments.length - 1];
  pattern += last.startsWith(":") ? "(?![\\w-])" : "(?![\\w/:-])";
  return new RegExp(pattern, "m");
}

test("route extraction finds every route the extension handles", () => {
  assert.deepEqual([...background].sort(), [
    "/",
    "/addressbooks",
    "/contacts",
    "/contacts/:id",
    "/identities",
    "/mailboxes",
    "/mailboxes/refresh",
    "/messages",
    "/messages/:id",
    "/messages/:id/attachments/:partName"
  ], "background.js routes changed; update the docs sweep if this is intentional");

  assert.deepEqual([...calendar].sort(), [
    "/calendars",
    "/events",
    "/events/:id",
    "/upcoming"
  ], "isCalendarRoute routes changed; update the docs sweep if this is intentional");
});

test("every handled route is described by GET /", async () => {
  const h = backgroundHarness();
  const { status, body } = await h.request("GET", "/");
  assert.equal(status, 200);

  const documented = apiRoutes(body);
  for (const route of routes) {
    assert.ok(
      [...documented].some(candidate => sameRoute(candidate, route)),
      `GET / does not describe ${route}; add it to the endpoints in background.js`
    );
  }
});

test("every handled route appears in README.md", () => {
  const readme = read("README.md");
  for (const route of routes) {
    assert.match(
      readme,
      readmePattern(route),
      `README.md does not document ${route}; add it to the API reference`
    );
  }
});
