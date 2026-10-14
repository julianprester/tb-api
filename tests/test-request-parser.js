"use strict";

// Task 2.1: one correct request parser.
// Covers api/utils.js parseQueryString / RequestError / parseRequestParams and
// the background route's status mapping for malformed percent-encodings and for
// JSON bodies that are not objects.

const test = require("node:test");
const assert = require("node:assert/strict");
const { backgroundHarness } = require("./helpers/harness.js");

// Utils returns values created in the harness vm realm, so their prototypes
// differ from the test realm's. Clone them before deep comparisons.
const plain = value => JSON.parse(JSON.stringify(value));

test("parseQueryString splits at the first '=' so values may contain '='", () => {
  const h = backgroundHarness();
  assert.deepEqual(plain(h.Utils.parseQueryString("q=a=b")), { q: "a=b" });
  assert.deepEqual(plain(h.Utils.parseQueryString("q===")), { q: "==" });
  assert.deepEqual(plain(h.Utils.parseQueryString("a=1=b&c=2")), { a: "1=b", c: "2" });
});

test("parseQueryString decodes '+' as a space in keys and values", () => {
  const h = backgroundHarness();
  assert.deepEqual(plain(h.Utils.parseQueryString("end=next+week")), { end: "next week" });
  assert.deepEqual(plain(h.Utils.parseQueryString("a+b=c+d")), { "a b": "c d" });
});

test("parseQueryString leaves explicitly encoded %2B as a literal '+'", () => {
  const h = backgroundHarness();
  assert.deepEqual(plain(h.Utils.parseQueryString("q=a%2Bb")), { q: "a+b" });
  assert.deepEqual(plain(h.Utils.parseQueryString("q=%2B")), { q: "+" });
});

test("parseQueryString keeps empty-query and bare-key behaviour", () => {
  const h = backgroundHarness();
  assert.deepEqual(plain(h.Utils.parseQueryString("")), {});
  assert.deepEqual(plain(h.Utils.parseQueryString(null)), {});
  assert.deepEqual(plain(h.Utils.parseQueryString(undefined)), {});
  assert.deepEqual(plain(h.Utils.parseQueryString("flag")), { flag: "" });
  assert.deepEqual(plain(h.Utils.parseQueryString("a=&b=1&")), { a: "", b: "1" });
  assert.deepEqual(plain(h.Utils.parseQueryString("a=1&&b=2")), { a: "1", b: "2" });
});

test("malformed percent-encoding throws URIError at parse time", () => {
  const h = backgroundHarness();
  assert.throws(() => h.Utils.parseQueryString("q=%"), { name: "URIError" });
  assert.throws(() => h.Utils.parseQueryString("q=%zz"), { name: "URIError" });
  assert.throws(() => h.Utils.parseQueryString("%=1"), { name: "URIError" });
  assert.throws(() => h.Utils.parseRequestParams("q=%", ""), { name: "URIError" });
});

test("background route answers 400 for a malformed query string", async () => {
  const h = backgroundHarness();
  const result = await h.request("GET", "/messages", "q=%");
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "URI malformed");
  assert.equal(h.queries.length, 0, "the route must not run with a malformed query");
});

test("RequestError is an Error subclass carrying code and statusCode", () => {
  const h = backgroundHarness();
  const error = new h.Utils.RequestError("nope", "invalid_body");
  assert.ok(error instanceof h.Utils.RequestError);
  // Cross-realm safe: walk the prototype chain of the vm-realm error.
  assert.equal(error.name, "RequestError");
  assert.equal(Object.getPrototypeOf(error).constructor.name, "RequestError");
  assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(error)).constructor.name, "Error",
    "RequestError must extend Error");
  assert.equal(error.message, "nope");
  assert.equal(error.code, "invalid_body");
  assert.equal(error.statusCode, 400, "default statusCode is 400");
  assert.equal(new h.Utils.RequestError("x", "custom", 409).statusCode, 409);
});

test("parseRequestParams merges query and body, body wins", () => {
  const h = backgroundHarness();
  assert.deepEqual(
    plain(h.Utils.parseRequestParams("a=1&b=query", '{"b":"body","c":true}')),
    { a: "1", b: "body", c: true }
  );
  assert.deepEqual(plain(h.Utils.parseRequestParams("a=1", "")), { a: "1" });
  assert.deepEqual(plain(h.Utils.parseRequestParams("", '{"a":1}')), { a: 1 });
  assert.deepEqual(plain(h.Utils.parseRequestParams("", "")), {});
});

test("parseRequestParams lets a JSON SyntaxError propagate", () => {
  const h = backgroundHarness();
  assert.throws(() => h.Utils.parseRequestParams("", "{oops"), { name: "SyntaxError" });
});

test("parseRequestParams rejects JSON bodies that are not objects", () => {
  const h = backgroundHarness();
  for (const body of ["[]", "1", '"x"', "null", "true"]) {
    assert.throws(
      () => h.Utils.parseRequestParams("", body),
      error => error.code === "invalid_body" &&
        error.statusCode === 400 &&
        error.message === "Request body must be a JSON object",
      `body ${body} must be rejected as invalid_body`
    );
  }
});

test("background route answers 400 invalid_body for non-object JSON bodies", async () => {
  for (const body of ["[]", "1", '"x"', "null"]) {
    const h = backgroundHarness();
    const result = await h.request("POST", "/messages", "", body);
    assert.equal(result.status, 400, `body ${body} must be a 400`);
    assert.equal(result.body.code, "invalid_body", `body ${body} must carry invalid_body`);
    assert.equal(result.body.error, "Request body must be a JSON object");
  }
});

test("background route decodes '=' and '+' end to end", async () => {
  const h = backgroundHarness();

  const equals = await h.request("GET", "/messages", "q=a=b");
  assert.equal(equals.status, 200);
  assert.equal(h.queries.at(-1).fullText, "a=b");

  const plus = await h.request("GET", "/messages", "q=a%2Bb");
  assert.equal(plus.status, 200);
  assert.equal(h.queries.at(-1).fullText, "a+b");
});

test("background route lets JSON body params win over query params", async () => {
  const h = backgroundHarness();
  const result = await h.request("GET", "/messages", "q=from-query", '{"q":"from-body"}');
  assert.equal(result.status, 200);
  assert.equal(h.queries.at(-1).fullText, "from-body");
});
