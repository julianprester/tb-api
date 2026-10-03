"use strict";

// Dependency-free tests of the privileged implementation, background adapter,
// and HTTP routing. All Thunderbird APIs and network operations are synthetic.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = name => fs.readFileSync(path.join(root, "tb-api", name), "utf8");
const silentConsole = { log() {}, warn() {}, error() {} };

class Clock {
  constructor() {
    this.now = 0;
    this.nextId = 0;
    this.timers = new Map();
  }

  setTimeout(callback, delay) {
    const id = ++this.nextId;
    this.timers.set(id, { callback, at: this.now + delay });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  tick(ms) {
    const end = this.now + ms;
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}

async function flush() {
  // Drain the bridge's nested async handlers, without sleeping or real timers.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function harness(t, options = {}) {
  const clock = new Clock();
  const events = [];
  const nativeFolders = new Map();
  const webFolders = new Map();
  const closers = new Set();
  const Ci = { nsMsgFolderFlags: { Virtual: 0x20 }, nsIMsgImapMailFolder: {} };
  const fixtures = (options.folders || [{ id: "account1:/Inbox", name: "Inbox", role: "inbox" }]).map(spec => {
    const fixture = { spec, listeners: [], updates: 0 };
    fixture.imap = {
      canOpenFolder: spec.canOpen !== false,
      updateFolderWithListener(window, listener) {
        assert.equal(window, null);
        assert.equal(typeof listener.QueryInterface, "function");
        events.push(["native-update", spec.id]);
        fixture.updates++;
        if (spec.throwUpdate) throw new Error("synthetic update failure");
        fixture.listeners.push(listener);
        if (spec.autoComplete !== undefined) listener.OnStopRunningUrl(null, spec.autoComplete);
      }
    };
    fixture.native = {
      URI: spec.uri || `imap://test.invalid/${spec.id}`,
      prettyName: spec.name || spec.id,
      server: { type: spec.type || "imap" },
      flags: spec.virtual ? Ci.nsMsgFolderFlags.Virtual : 0,
      isServer: !!spec.root,
      supportsOffline: false,
      QueryInterface(iface) {
        assert.equal(iface, Ci.nsIMsgImapMailFolder);
        if (spec.throwQI) throw new Error("no IMAP interface");
        return fixture.imap;
      }
    };
    fixture.finish = (exitCode = 0, index = fixture.listeners.length - 1) => {
      fixture.listeners[index].OnStopRunningUrl(null, exitCode);
    };
    nativeFolders.set(spec.id, { folder: fixture.native, isUnified: spec.unified, isTag: spec.tag });
    webFolders.set(spec.id, {
      id: spec.id,
      name: spec.name || spec.id,
      accountId: spec.accountId || "account1",
      specialUse: spec.role ? [spec.role] : []
    });
    return fixture;
  });

  class Server {
    constructor() {
      this._identity = { add() {} };
    }
    registerPrefixHandler(prefix, handler) { this.handler = handler; }
    _start() {}
    stop(callback) { callback(); }
  }

  class EventManager {
    constructor({ register }) { this.register = register; }
    api() {
      return { addListener: listener => this.register({ async: payload => listener(payload) }) };
    }
  }

  const Services = {
    io: { offline: !!options.offline },
    scriptloader: {
      loadSubScript(name, scope) {
        if (name === "lib/httpd.js") {
          scope.HttpServer = Server;
        } else if (name === "api/calendar.js") {
          // Calendar operations are unrelated to these tests.
        } else {
          scope.Date = { now: () => clock.now };
          vm.runInNewContext(source(name), scope, { filename: name });
        }
      }
    }
  };
  const ChromeUtils = {
    generateQI() { return function() { return this; }; },
    importESModule(name) {
      if (name.endsWith("/ExtensionCommon.sys.mjs")) {
        return { ExtensionCommon: { ExtensionAPI: class {}, EventManager } };
      }
      if (name.endsWith("/Timer.sys.mjs")) {
        return { setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock) };
      }
      if (name.endsWith("/ExtensionAccounts.sys.mjs")) {
        if (options.noResolver) return {};
        return { getFolder(id) {
          events.push(["native-resolve", id]);
          if (!nativeFolders.has(id)) throw new Error("Folder not found");
          return nativeFolders.get(id);
        } };
      }
      throw new Error(`Unavailable module: ${name}`);
    }
  };
  const Cc = {
    "@mozilla.org/process/environment;1": {
      getService() { return { get: name => name === "TB_API_TOKEN" ? (options.token || "") : "" }; }
    },
    "@mozilla.org/intl/converter-output-stream;1": {
      createInstance() {
        return {
          init(stream) { this.stream = stream; },
          writeString(text) { this.stream.text += text; },
          close() {}
        };
      }
    },
    "@mozilla.org/scriptableinputstream;1": {
      createInstance() {
        return {
          init(stream) { this.stream = stream; },
          available() { return this.stream.text.length; },
          read(size) { return this.stream.text.slice(0, size); }
        };
      }
    }
  };
  const privileged = vm.createContext({
    ChromeUtils, Services, Ci, Cc, console: silentConsole,
    Components: { isSuccessCode: code => (code >>> 31) === 0 }
  });
  vm.runInContext(source("experiment/api.js"), privileged, { filename: "experiment/api.js" });
  const instance = new privileged.httpServer();
  const api = instance.getAPI({
    extension: { rootURI: { resolve: name => name } },
    callOnClose: closer => closers.add(closer)
  }).httpServer;
  t.after(() => {
    instance.close();
    assert.equal(clock.timers.size, 0, "shutdown must clean up all caller timers");
    assert.equal(instance.folderRefresher.inFlight.size, 0);
  });

  const browser = {
    runtime: { getManifest: () => JSON.parse(source("manifest.json")) },
    httpServer: {
      ...api,
      refreshFolder(id, timeout) {
        events.push(["bridge-refresh", id, timeout]);
        return api.refreshFolder(id, timeout);
      }
    }
  };
  const messenger = {
    folders: {
      async get(id) {
        events.push(["web-resolve", id]);
        if (!webFolders.has(id)) throw new Error("Folder not found");
        return webFolders.get(id);
      },
      async query(query) {
        events.push(["folder-query", query]);
        return [...webFolders.values()].filter(folder =>
          (!query.accountId || folder.accountId === query.accountId) &&
          (!query.specialUse || query.specialUse.some(role => folder.specialUse.includes(role)))
        );
      }
    },
    accounts: { async list() { return [...new Set([...webFolders.values()].map(f => f.accountId))].map(id => ({ id })); } },
    messages: {
      async query(query) {
        events.push(["message-query", query.folderId]);
        return { messages: options.messages || [] };
      },
      async listInlineTextParts() { return []; }
    }
  };
  const background = vm.createContext({ browser, messenger, console: silentConsole });
  for (const file of ["api/utils.js", "api/email.js", "background.js"]) {
    vm.runInContext(source(file), background, { filename: file });
  }

  async function request(method, pathname, { queryString = "", body = "", token } = {}) {
    return new Promise(resolve => {
      const response = {
        bodyOutputStream: { text: "" },
        processAsync() {},
        setStatusLine(version, status) { this.status = status; },
        setHeader() {},
        finish() { resolve({ status: this.status, body: JSON.parse(this.bodyOutputStream.text) }); }
      };
      instance.server.handler({
        method, path: pathname, queryString, httpVersion: "1.1",
        bodyInputStream: { text: Buffer.from(body, "utf8").toString("latin1") },
        getHeader(name) {
          if (name === "Authorization" && token) return `Bearer ${token}`;
          throw new Error("Missing header");
        }
      }, response);
    });
  }

  return {
    api, instance, fixtures, clock, events, Services, nativeFolders, closers, browser,
    Email: background.Email, Utils: background.Utils, request,
    count: event => events.filter(([name]) => name === event).length
  };
}

test("GET / reports the installed manifest version, not a hard-coded API version", async t => {
  const h = harness(t);
  const info = await h.request("GET", "/");
  assert.equal(info.status, 200);
  assert.equal(info.body.version, JSON.parse(source("manifest.json")).version);
  h.browser.runtime.getManifest = () => ({ version: "99.0" });
  assert.equal((await h.request("GET", "/")).body.version, "99.0");
});

test("schema and implementation agree on positional folder ID and timeout", () => {
  const schema = JSON.parse(source("experiment/schema.json"));
  const method = schema[0].functions.find(f => f.name === "refreshFolder");
  assert.equal(method.async, true);
  assert.deepEqual(method.parameters.map(p => p.name), ["folderId", "timeoutMs"]);
  assert.equal(method.parameters[1].optional, true);
  assert.equal(method.parameters[1].minimum, 1);
  assert.equal(method.parameters[1].maximum, 60000);
});

test("native refresh waits for the IMAP listener, not the method return", async t => {
  const h = harness(t);
  let settled = false;
  const pending = h.api.refreshFolder("account1:/Inbox").then(result => { settled = true; return result; });
  await flush();
  assert.equal(settled, false);
  assert.equal(h.fixtures[0].updates, 1);
  h.fixtures[0].listeners[0].OnStartRunningUrl(null);
  h.clock.tick(42);
  assert.equal(settled, false);
  h.fixtures[0].finish();
  const result = await pending;
  assert.equal(result.refreshed, true);
  assert.equal(result.folder_id, "account1:/Inbox");
  assert.equal(result.elapsed_ms, 42);
  assert.equal(result.uri, undefined);
  assert.equal(h.clock.timers.size, 0);
  assert.equal(h.instance.folderRefresher.inFlight.size, 0);
});

test("same native folder is coalesced even when IDs differ", async t => {
  const h = harness(t, { folders: [
    { id: "one", uri: "imap://test.invalid/shared" },
    { id: "alias", uri: "imap://test.invalid/shared" }
  ] });
  const first = h.api.refreshFolder("one");
  const second = h.api.refreshFolder("alias");
  assert.equal(h.count("native-update"), 1);
  h.fixtures[0].finish();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].folder_id, "one");
  assert.equal(results[1].folder_id, "alias");
  assert.ok(results.every(result => result.refreshed));
});

test("different folders refresh independently", async t => {
  const h = harness(t, { folders: [{ id: "one" }, { id: "two" }] });
  const first = h.api.refreshFolder("one");
  const second = h.api.refreshFolder("two");
  assert.equal(h.count("native-update"), 2);
  h.fixtures[1].finish();
  assert.equal((await second).refreshed, true);
  assert.equal(h.instance.folderRefresher.inFlight.size, 1);
  h.fixtures[0].finish();
  assert.equal((await first).refreshed, true);
});

test("each caller has its own timeout without cancelling a shared update", async t => {
  const h = harness(t);
  const first = h.api.refreshFolder("account1:/Inbox", 5);
  const second = h.api.refreshFolder("account1:/Inbox", 500);
  h.clock.tick(5);
  const timeout = await first;
  assert.equal(timeout.code, "refresh_timeout");
  assert.equal(timeout.statusCode, 504);
  assert.equal(h.instance.folderRefresher.inFlight.size, 1);
  assert.equal(h.clock.timers.size, 1);
  h.fixtures[0].finish();
  assert.equal((await second).refreshed, true);
  assert.equal(h.count("native-update"), 1);
  assert.equal(h.clock.timers.size, 0);
});

test("a retry after timeout waits for the existing update; late callbacks are safe", async t => {
  const h = harness(t);
  const first = h.api.refreshFolder("account1:/Inbox", 1);
  h.clock.tick(1);
  assert.equal((await first).code, "refresh_timeout");
  const retry = h.api.refreshFolder("account1:/Inbox", 100);
  assert.equal(h.count("native-update"), 1);
  h.fixtures[0].finish();
  assert.equal((await retry).refreshed, true);
  const next = h.api.refreshFolder("account1:/Inbox", 100);
  h.fixtures[0].finish(0x80004005, 0);
  assert.equal(h.instance.folderRefresher.inFlight.size, 1);
  h.fixtures[0].finish();
  assert.equal((await next).refreshed, true);
  assert.equal(h.count("native-update"), 2);
});

test("native failures settle all waiters and allow a later retry", async t => {
  const h = harness(t);
  const first = h.api.refreshFolder("account1:/Inbox");
  const second = h.api.refreshFolder("account1:/Inbox");
  h.fixtures[0].finish(0x80004005);
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.code, "refresh_failed");
    assert.equal(result.statusCode, 502);
    assert.match(result.error, /0x80004005/);
  }
  const retry = h.api.refreshFolder("account1:/Inbox");
  h.fixtures[0].finish();
  assert.equal((await retry).refreshed, true);
});

test("synchronous native exceptions and callbacks clean up correctly", async t => {
  const h = harness(t, { folders: [
    { id: "throws", throwUpdate: true }, { id: "sync", autoComplete: 0 }
  ] });
  assert.equal((await h.api.refreshFolder("throws")).statusCode, 502);
  assert.equal((await h.api.refreshFolder("sync")).refreshed, true);
  assert.equal(h.clock.timers.size, 0);
  assert.equal(h.instance.folderRefresher.inFlight.size, 0);
});

test("offline IMAP fails, but a local folder is an explicit no-op even offline", async t => {
  const h = harness(t, { offline: true, folders: [{ id: "imap" }, { id: "local", type: "none" }] });
  const offline = await h.api.refreshFolder("imap");
  assert.equal(offline.code, "thunderbird_offline");
  assert.equal(offline.statusCode, 503);
  const local = await h.api.refreshFolder("local");
  assert.equal(local.refreshed, false);
  assert.equal(local.skipped, true);
  assert.equal(local.reason, "local_folder");
  assert.equal(h.count("native-update"), 0);
});

test("roots, virtual folders, non-selectable folders and other protocols are rejected", async t => {
  const h = harness(t, { folders: [
    { id: "root", root: true }, { id: "virtual", virtual: true },
    { id: "unified", unified: true }, { id: "tag", tag: true },
    { id: "noselect", canOpen: false }, { id: "pop", type: "pop3" },
    { id: "rss", type: "rss" }, { id: "qi", throwQI: true }
  ] });
  for (const id of ["root", "virtual", "unified", "tag", "noselect"]) {
    assert.equal((await h.api.refreshFolder(id)).code, "unsupported_folder");
  }
  for (const id of ["pop", "rss"]) {
    assert.equal((await h.api.refreshFolder(id)).code, "unsupported_protocol");
  }
  assert.equal((await h.api.refreshFolder("qi")).code, "refresh_unavailable");
  assert.equal(h.count("native-update"), 0);
});

test("missing folders and unavailable version adapters are explicit errors", async t => {
  const h = harness(t);
  assert.equal((await h.api.refreshFolder("missing")).statusCode, 404);
  const old = harness(t, { noResolver: true });
  assert.equal((await old.api.refreshFolder("account1:/Inbox")).code, "refresh_unavailable");
  assert.equal(old.count("native-update"), 0);
});

test("native argument validation happens before folder lookup or network work", async t => {
  const h = harness(t);
  for (const id of [undefined, null, 1, "", " ", {}]) {
    assert.equal((await h.api.refreshFolder(id)).code, "invalid_folder");
  }
  for (const timeout of [0, -1, 60001, 1.5, "30000", null, true, Infinity, NaN]) {
    assert.equal((await h.api.refreshFolder("account1:/Inbox", timeout)).code, "invalid_timeout");
  }
  assert.equal(h.count("native-resolve"), 0);
});

test("server stop and extension close settle waiters and ignore late callbacks", async t => {
  const h = harness(t);
  assert.ok(h.closers.has(h.instance));
  const pending = h.api.refreshFolder("account1:/Inbox");
  await h.api.stop();
  assert.equal((await pending).code, "refresh_cancelled");
  const next = h.api.refreshFolder("account1:/Inbox");
  h.fixtures[0].finish(0, 0);
  assert.equal(h.instance.folderRefresher.inFlight.size, 1);
  h.instance.close();
  assert.equal((await next).code, "refresh_cancelled");
  h.fixtures[0].finish();
  assert.equal((await h.api.refreshFolder("account1:/Inbox")).statusCode, 503);
  assert.equal(h.clock.timers.size, 0);
});

test("search refreshes its exact resolved ID before querying, including nested Unicode folders", async t => {
  const id = "account2:/Projects/研究 & café+ = nested";
  const h = harness(t, { folders: [
    { id: "account1:/Inbox", name: "Inbox", role: "inbox" },
    { id, name: "研究 & café+ = nested", accountId: "account2" }
  ] });
  const pending = h.Email.searchMessages({ folder: id, refresh: "true", timeout_ms: "1000" });
  await flush();
  assert.equal(h.fixtures[0].updates, 0);
  assert.equal(h.fixtures[1].updates, 1);
  assert.equal(h.count("folder-query"), 0, "an exact ID must bypass role/name guesses");
  assert.equal(h.count("message-query"), 0);
  h.fixtures[1].finish();
  const result = await pending;
  assert.equal(result.refresh.folder_id, id);
  assert.equal(result.refresh.refreshed, true);
  assert.equal(result.total, 0);
  assert.deepEqual(h.events.find(([name]) => name === "bridge-refresh"), ["bridge-refresh", id, 1000]);
  assert.deepEqual(h.events.find(([name]) => name === "message-query"), ["message-query", id]);
});

test("refresh metadata is also returned for nonempty search results", async t => {
  const h = harness(t, { messages: [{
    id: 1, headerMessageId: "synthetic@example.test", subject: "Synthetic message", recipients: []
  }] });
  const pending = h.Email.searchMessages({ mailbox: "inbox", refresh: true });
  await flush();
  h.fixtures[0].finish();
  const result = await pending;
  assert.equal(result.total, 1);
  assert.equal(result.refresh.refreshed, true);
});

test("refresh is opt-in and false/0 never trigger network work", async t => {
  for (const refresh of [undefined, false, "false", 0, "0"]) {
    const h = harness(t);
    const result = await h.Email.searchMessages({ mailbox: "inbox", refresh });
    assert.equal(result.refresh, undefined);
    assert.equal(h.count("native-update"), 0);
    assert.equal(h.count("message-query"), 1);
  }
  const unscoped = harness(t);
  assert.equal((await unscoped.Email.searchMessages({})).error, undefined);
  assert.equal(unscoped.count("message-query"), 1);
});

test("true/1 are accepted, but invalid booleans and unscoped refresh are rejected", async t => {
  const h = harness(t, { folders: [{ id: "inbox-id", role: "inbox", autoComplete: 0 }] });
  for (const refresh of [true, "true", 1, "1"]) {
    assert.equal((await h.Email.searchMessages({ mailbox: "inbox", refresh })).refresh.refreshed, true);
  }
  const before = h.count("message-query");
  for (const refresh of ["yes", "False", 2, null, {}, []]) {
    assert.equal((await h.Email.searchMessages({ mailbox: "inbox", refresh })).code, "invalid_refresh");
  }
  assert.equal((await h.Email.searchMessages({ refresh: true })).code, "missing_mailbox");
  assert.equal(h.count("message-query"), before);
});

test("all timeout aliases accept integers; invalid timeouts never refresh or search", async t => {
  const h = harness(t, { folders: [{ id: "id", role: "inbox", autoComplete: 0 }] });
  for (const key of ["timeoutMs", "timeout_ms", "timeout"]) {
    assert.equal((await h.Email.searchMessages({ mailbox: "inbox", refresh: true, [key]: "60000" })).refresh.refreshed, true);
    assert.equal(h.events.filter(([name]) => name === "bridge-refresh").at(-1)[2], 60000);
  }
  const before = h.count("native-update");
  const queries = h.count("message-query");
  for (const timeoutMs of [0, -1, 60001, 1.5, "5ms", "", " ", null, true, {}, []]) {
    assert.equal((await h.Email.searchMessages({ mailbox: "inbox", refresh: true, timeoutMs })).code, "invalid_timeout");
  }
  assert.equal(h.count("native-update"), before);
  assert.equal(h.count("message-query"), queries);
});

test("requested refresh failure never silently falls back to a local query", async t => {
  const h = harness(t);
  const pending = h.Email.searchMessages({ mailbox: "inbox", refresh: true });
  await flush();
  h.fixtures[0].finish(0x80004005);
  assert.equal((await pending).statusCode, 502);
  assert.equal(h.count("message-query"), 0);
  h.browser.httpServer.refreshFolder = async () => { throw new Error("bridge unavailable"); };
  assert.equal((await h.Email.searchMessages({ mailbox: "inbox", refresh: true })).statusCode, 500);
  assert.equal(h.count("message-query"), 0);
});

test("local-folder searches proceed with explicit skipped refresh metadata", async t => {
  const h = harness(t, { folders: [{ id: "local", type: "none" }] });
  const result = await h.Email.searchMessages({ mailbox: "local", refresh: true });
  assert.equal(result.refresh.skipped, true);
  assert.equal(result.refresh.refreshed, false);
  assert.equal(h.count("message-query"), 1);
});

test("POST refresh supports JSON, aliases, body precedence, and Unicode folder IDs", async t => {
  const id = "account2:/Sent/研究+ =";
  const h = harness(t, { folders: [{ id, accountId: "account2", autoComplete: 0 }] });
  const result = await h.request("POST", "/mailboxes/refresh", {
    queryString: "mailbox=wrong",
    body: JSON.stringify({ mailbox: id, timeout: "123" })
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.folder_id, id);
  assert.equal(result.body.refreshed, true);
  assert.deepEqual(h.events.find(([name]) => name === "bridge-refresh"), ["bridge-refresh", id, 123]);
  const alias = await h.request("POST", "/mailboxes/refresh", { queryString: `folder=${encodeURIComponent(id)}` });
  assert.equal(alias.status, 200);
  assert.equal(alias.body.folder_id, id);
  const info = await h.request("GET", "/");
  assert.ok(info.body.endpoints.email["POST /mailboxes/refresh"]);
});

test("HTTP search returns 504 on timeout and does not query stale data", async t => {
  const h = harness(t);
  const pending = h.request("GET", "/messages", { queryString: "mailbox=inbox&refresh=true&timeoutMs=5" });
  await flush();
  h.clock.tick(5);
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal(response.body.code, "refresh_timeout");
  assert.equal(response.body.statusCode, undefined, "internal status metadata must not leak into JSON");
  assert.equal(h.count("message-query"), 0);
  h.fixtures[0].finish();
});

test("HTTP refresh errors have correct statuses and machine-readable codes", async t => {
  const h = harness(t, { offline: true });
  const offline = await h.request("POST", "/mailboxes/refresh", { body: '{"mailbox":"inbox"}' });
  assert.equal(offline.status, 503);
  assert.equal(offline.body.code, "thunderbird_offline");
  const missing = await h.request("POST", "/mailboxes/refresh", { body: '{"mailbox":"no-such-folder"}' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "folder_not_found");
  const scope = await h.request("POST", "/mailboxes/refresh", { body: "{}" });
  assert.equal(scope.status, 400);
  assert.equal(scope.body.code, "missing_mailbox");
  const invalid = await h.request("POST", "/mailboxes/refresh", { body: '{"mailbox":123}' });
  assert.equal(invalid.status, 400);
  const method = await h.request("GET", "/mailboxes/refresh");
  assert.equal(method.status, 405);
  const malformed = await h.request("POST", "/mailboxes/refresh", { body: "{invalid}" });
  assert.equal(malformed.status, 400);
  assert.equal(h.count("native-update"), 0);
});

test("existing Bearer authentication protects the refresh endpoint", async t => {
  const h = harness(t, { token: "synthetic-token", folders: [{ id: "id", autoComplete: 0 }] });
  const unauthorized = await h.request("POST", "/mailboxes/refresh", { body: '{"mailbox":"id"}' });
  assert.equal(unauthorized.status, 401);
  assert.equal(h.count("native-resolve"), 0);
  const authorized = await h.request("POST", "/mailboxes/refresh", {
    token: "synthetic-token", body: '{"folder":"id"}'
  });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.body.refreshed, true);
});
