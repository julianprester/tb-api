"use strict";

// Security hardening of the experiment HTTP handler:
// D1 origin rejection / no wildcard CORS, D2 JSON-only bodies, D3 fail-closed start.
// All requests go through the real prefix handler; the harness records every
// experiment -> background dispatch as a "background-request" event.
const test = require("node:test");
const assert = require("node:assert/strict");
const { experimentHarness } = require("./helpers/harness.js");

const APP_ORIGIN = "https://app.example";

test("disallowed Origin is rejected with 403 and never reaches the background", async t => {
  const h = experimentHarness({ t });
  const response = await h.request("GET", "/messages", { headers: { Origin: "https://evil.example" } });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "origin_not_allowed");
  assert.equal(h.count("background-request"), 0, "a rejected request must not fire a background event");
  assert.equal(h.count("message-query"), 0);
});

test("cross-site/same-site Sec-Fetch-Site without Origin is rejected with 403", async t => {
  const h = experimentHarness({ t });
  for (const site of ["cross-site", "same-site", "CROSS-SITE"]) {
    const response = await h.request("GET", "/messages", { headers: { "Sec-Fetch-Site": site } });
    assert.equal(response.status, 403, `${site} must be rejected`);
    assert.equal(response.body.code, "cross_site_request");
  }
  assert.equal(h.count("background-request"), 0);

  const sameOrigin = await h.request("GET", "/messages", { headers: { "Sec-Fetch-Site": "same-origin" } });
  assert.equal(sameOrigin.status, 200);
  assert.equal(h.count("background-request"), 1);
});

test("allowlisted Origin is echoed exactly and other origins stay rejected", async t => {
  const h = experimentHarness({
    t,
    env: { TB_API_ALLOWED_ORIGINS: ` ${APP_ORIGIN} , https://admin.example ` }
  });

  const allowed = await h.request("GET", "/", { headers: { Origin: APP_ORIGIN } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers["Access-Control-Allow-Origin"], APP_ORIGIN);
  assert.equal(allowed.headers["Vary"], "Origin");

  const second = await h.request("GET", "/", { headers: { Origin: "https://admin.example" } });
  assert.equal(second.status, 200);
  assert.equal(second.headers["Access-Control-Allow-Origin"], "https://admin.example");

  // Exact match only: no suffix/substring matching.
  const nearMiss = await h.request("GET", "/", { headers: { Origin: "https://evil.app.example" } });
  assert.equal(nearMiss.status, 403);
  assert.equal(nearMiss.body.code, "origin_not_allowed");
  assert.equal(nearMiss.headers["Access-Control-Allow-Origin"], undefined);
});

test("OPTIONS preflights are answered for allowlisted origins and refused otherwise", async t => {
  const h = experimentHarness({ t, env: { TB_API_ALLOWED_ORIGINS: APP_ORIGIN } });

  const preflight = await h.request("OPTIONS", "/messages", {
    headers: {
      Origin: APP_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type"
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["Access-Control-Allow-Origin"], APP_ORIGIN);
  assert.equal(preflight.headers["Vary"], "Origin");
  assert.equal(preflight.headers["Allow-Methods"], "GET, POST, PATCH, DELETE");
  assert.equal(preflight.headers["Allow-Headers"], "Authorization, Content-Type");

  const evil = await h.request("OPTIONS", "/messages", { headers: { Origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  assert.equal(evil.body.code, "origin_not_allowed");

  const bare = await h.request("OPTIONS", "/messages");
  assert.equal(bare.status, 403, "OPTIONS without an allowlisted Origin is not served");

  assert.equal(h.count("background-request"), 0, "preflights never reach the background");
});

test("curl-style requests without Origin/Sec-Fetch headers still work", async t => {
  const h = experimentHarness({ t });
  const root = await h.request("GET", "/");
  assert.equal(root.status, 200);
  assert.equal(root.headers["Access-Control-Allow-Origin"], undefined);
  assert.equal(h.count("background-request"), 1);
});

test("no response ever advertises a wildcard CORS policy", async t => {
  const h = experimentHarness({ t, env: { TB_API_ALLOWED_ORIGINS: APP_ORIGIN } });
  const responses = [
    await h.request("GET", "/", { headers: { Origin: APP_ORIGIN } }),
    await h.request("GET", "/", { headers: { Origin: "https://evil.example" } }),
    await h.request("GET", "/"),
    await h.request("OPTIONS", "/", { headers: { Origin: APP_ORIGIN } }),
    await h.request("POST", "/mailboxes/refresh", {
      body: "{}", headers: { "Content-Type": "text/plain" }
    })
  ];
  for (const response of responses) {
    assert.notEqual(response.headers["Access-Control-Allow-Origin"], "*");
  }
});

test("non-JSON bodies are rejected with 415; JSON and empty bodies are allowed", async t => {
  const h = experimentHarness({ t, folders: [{ id: "account1:/Inbox", autoComplete: 0 }] });

  const nonJson = [
    ["text/plain", '{"mailbox":"account1:/Inbox"}'],
    ["application/x-www-form-urlencoded", "mailbox=account1:/Inbox"],
    ["", '{"mailbox":"account1:/Inbox"}'] // no Content-Type header at all
  ];
  for (const [type, body] of nonJson) {
    const headers = type ? { "Content-Type": type } : {};
    const response = await h.request("POST", "/mailboxes/refresh", { body, headers });
    assert.equal(response.status, 415, `Content-Type ${type || "(missing)"} must be refused`);
    assert.equal(response.body.code, "unsupported_media_type");
  }
  assert.equal(h.count("background-request"), 0, "refused bodies never reach the background");
  assert.equal(h.count("native-update"), 0);

  const json = await h.request("POST", "/mailboxes/refresh", {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: '{"mailbox":"account1:/Inbox"}'
  });
  assert.equal(json.status, 200);
  assert.equal(json.body.refreshed, true);

  const empty = await h.request("POST", "/mailboxes/refresh", { queryString: "mailbox=account1:/Inbox" });
  assert.equal(empty.status, 200, "an empty POST (curl query-string style) stays allowed");
  assert.equal(empty.body.refreshed, true);
});

test("the body rule also covers PATCH and DELETE, but only when a body is sent", async t => {
  const h = experimentHarness({ t });

  const patch = await h.request("PATCH", "/messages", {
    body: '{"ids":["synthetic@example.test"]}', headers: { "Content-Type": "text/plain" }
  });
  assert.equal(patch.status, 415);
  assert.equal(patch.body.code, "unsupported_media_type");

  const remove = await h.request("DELETE", "/", {
    body: '{"unexpected":true}', headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
  assert.equal(remove.status, 415);
  assert.equal(h.count("background-request"), 0);

  const emptyDelete = await h.request("DELETE", "/");
  assert.equal(emptyDelete.status, 404, "an empty DELETE reaches normal routing");
  assert.equal(h.count("background-request"), 1);
});

test("Bearer authentication rejects missing, short and wrong tokens; correct token passes", async t => {
  const token = "synthetic-token-0123456789";
  const h = experimentHarness({ t, token });

  const missing = await h.request("GET", "/");
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error, "Unauthorized");
  assert.equal(missing.headers["WWW-Authenticate"], "Bearer");

  const wrongLength = await h.request("GET", "/", { token: "short" });
  assert.equal(wrongLength.status, 401);

  const wrongChars = await h.request("GET", "/", { token: "synthetic-token-0123456788" });
  assert.equal(wrongChars.status, 401);

  const correct = await h.request("GET", "/", { token });
  assert.equal(correct.status, 200);
  assert.equal(h.count("background-request"), 1, "only the authenticated request is dispatched");
});

test("origin rejection runs before token authentication", async t => {
  const h = experimentHarness({ t, token: "synthetic-token", env: { TB_API_ALLOWED_ORIGINS: APP_ORIGIN } });

  const evil = await h.request("GET", "/", { headers: { Origin: "https://evil.example" } });
  assert.equal(evil.status, 403, "origin rules must not depend on authentication");
  assert.equal(evil.body.code, "origin_not_allowed");

  const allowedButUnauthenticated = await h.request("GET", "/", { headers: { Origin: APP_ORIGIN } });
  assert.equal(allowedButUnauthenticated.status, 401);
  assert.equal(allowedButUnauthenticated.headers["Access-Control-Allow-Origin"], APP_ORIGIN,
    "the allowlisted origin is echoed even on auth failures");
  assert.equal(h.count("background-request"), 0);
});

test("start() fails closed on a non-loopback host without a token", async () => {
  const noToken = experimentHarness({ env: { TB_API_HOST: "0.0.0.0" } });
  assert.equal(noToken.instance.server, null, "background startup must not bind");
  await assert.rejects(
    noToken.api.start(9595),
    /TB_API_TOKEN is required when TB_API_HOST is not loopback/
  );

  const withToken = experimentHarness({ token: "synthetic-token", env: { TB_API_HOST: "0.0.0.0" } });
  assert.ok(withToken.instance.server, "a non-loopback bind with a token is allowed");

  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    const loopback = experimentHarness({ env: { TB_API_HOST: host } });
    assert.ok(loopback.instance.server, `${host} is loopback and needs no token`);
  }
});
