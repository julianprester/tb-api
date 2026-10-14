"use strict";

// Shared test harness for tb-api.
//
// backgroundHarness(options)
//   Loads tb-api/api/utils.js, api/email.js, api/contacts.js and background.js
//   into a vm context with a fake `messenger`. `messages.query` follows
//   Thunderbird 140 (Appendix A.1): exact headerMessageId comparison against
//   IDs stored WITHOUT angle brackets, database (insertion) order, and
//   pagination through messagesPerPage / id / continueList / abortList.
//
// experimentHarness(options)
//   Loads tb-api/experiment/api.js with a fake HttpServer, a fake `cal`
//   (calendars, items, recurrence info, dtz) and an in-process background
//   context wired to the same HTTP bridge, so one harness covers the native
//   experiment, the background adapter and the HTTP routing.
//
// Both harnesses expose the deterministic `clock`, an `events` log and a
// `count(event)` helper. `experimentHarness` additionally exposes the
// background surface (`Email`, `Utils`, `messenger`, `messages`, ...) and,
// when given `options.t`, registers teardown assertions (no leaked clock
// timers, no in-flight refresh operations). `options.noRequestListener` skips
// registering the background request listener, modelling a request that
// arrives before the background is ready.
//
// Everything is dependency-free: no network, no Thunderbird, and no real
// timers except the request helper's hung-detection safety net.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..");
const source = name => fs.readFileSync(path.join(root, "tb-api", name), "utf8");
const silentConsole = { log() {}, warn() {}, error() {} };

/**
 * Deterministic clock for testing timers without real time delays.
 */
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

/**
 * Date whose now() follows the deterministic Clock. Used when a harness runs
 * production code that schedules work against Date.now() and setTimeout().
 */
function createClockDate(clock) {
  return class ClockDate extends Date {
    constructor(...args) {
      super(...(args.length > 0 ? args : [clock.now]));
    }

    static now() {
      return clock.now;
    }
  };
}

// ---------------------------------------------------------------------------
// Fake messenger (Thunderbird message queries, Appendix A.1)
// ---------------------------------------------------------------------------

// Pref extensions.webextensions.messagesPerPage default.
const DEFAULT_MESSAGE_PAGE_SIZE = 100;

const DEFAULT_FOLDERS = [{ id: "account1:/Inbox", name: "Inbox", role: "inbox" }];

function normalizeFolder(spec) {
  return {
    id: spec.id,
    name: spec.name || spec.id,
    accountId: spec.accountId || "account1",
    specialUse: spec.specialUse || (spec.role ? [spec.role] : [])
  };
}

function backgroundHarness(options = {}) {
  const events = options.events || [];
  const messages = options.messages || [];
  const queries = [];
  const updates = [];
  const continuedLists = [];
  const abortedLists = [];
  const folders = new Map();
  for (const spec of options.folders || DEFAULT_FOLDERS) {
    const folder = normalizeFolder(spec);
    folders.set(folder.id, folder);
  }

  // Pagination state: query() keeps the rest of a match set in a list that is
  // addressed by `id` and read page by page with continueList().
  const lists = new Map();
  let nextListId = 0;

  function matches(message, info) {
    if (info.headerMessageId !== undefined && message.headerMessageId !== info.headerMessageId) return false;
    if (info.folderId !== undefined && message.folder?.id !== info.folderId) return false;
    if (info.unread !== undefined && !!message.read === info.unread) return false;
    if (info.flagged !== undefined && !!message.flagged !== info.flagged) return false;
    if (info.junk !== undefined && !!message.junk !== info.junk) return false;
    return true;
  }

  function buildPage(info, offset) {
    // Thunderbird spends at most autoPaginationTimeout ms collecting a page and
    // then keeps scanning in the background. The fake has no scan cost, so a
    // page always closes at messagesPerPage; the query info (including
    // autoPaginationTimeout) is still recorded in `queries` for assertions.
    const pageSize = Number.isInteger(info.messagesPerPage) && info.messagesPerPage > 0
      ? info.messagesPerPage
      : DEFAULT_MESSAGE_PAGE_SIZE;
    const matched = messages.filter(message => matches(message, info));
    return {
      messages: matched.slice(offset, offset + pageSize).map(message => ({ ...message })),
      nextOffset: offset + pageSize,
      hasMore: offset + pageSize < matched.length
    };
  }

  const messenger = {
    messages: {
      // `hangQuery` / `hangContinueList` make a page fetch never resolve, so
      // tests can exercise search deadlines and abortList.
      async query(info = {}) {
        events.push(["message-query", info.folderId]);
        queries.push(info);
        if (options.hangQuery) return new Promise(() => {});
        const page = buildPage(info, 0);
        const result = { messages: page.messages };
        if (page.hasMore) {
          const id = `message-list-${++nextListId}`;
          lists.set(id, { info, offset: page.nextOffset });
          result.id = id;
        }
        return result;
      },
      async continueList(id) {
        continuedLists.push(id);
        if (options.hangContinueList) return new Promise(() => {});
        const list = lists.get(id);
        if (!list) throw new Error(`No message list with id "${id}"`);
        const page = buildPage(list.info, list.offset);
        const result = { messages: page.messages };
        if (page.hasMore) {
          list.offset = page.nextOffset;
          result.id = id;
        } else {
          // A list is removed only once it has been read completely.
          lists.delete(id);
        }
        return result;
      },
      async abortList(id) {
        abortedLists.push(id);
        if (!lists.delete(id)) throw new Error(`No message list with id "${id}"`);
      },
      async get(id) {
        const message = messages.find(candidate => candidate.id === id);
        if (!message) throw new Error(`Message not found: ${id}`);
        return { ...message };
      },
      async getFull() {
        return { headers: {} };
      },
      async listAttachments() {
        return [];
      },
      async listInlineTextParts() {
        return [{ contentType: "text/plain", content: "Synthetic body" }];
      },
      async update(id, properties) {
        updates.push({ id, properties });
        const message = messages.find(candidate => candidate.id === id);
        if (message) Object.assign(message, properties);
      }
    },
    folders: {
      async get(id) {
        events.push(["web-resolve", id]);
        if (!folders.has(id)) throw new Error("Folder not found");
        return folders.get(id);
      },
      async query(query = {}) {
        events.push(["folder-query", query]);
        return [...folders.values()].filter(folder =>
          (!query.accountId || folder.accountId === query.accountId) &&
          (!query.specialUse || query.specialUse.some(role => folder.specialUse.includes(role)))
        );
      }
    },
    accounts: {
      async list() {
        return [...new Set([...folders.values()].map(folder => folder.accountId))].map(id => ({ id }));
      }
    },
    identities: {
      async list() {
        return options.identities || [];
      }
    }
  };

  // Extension seam: tests can add or override one namespace at a time, e.g.
  // { messages: { listAttachments: async () => [...] } }.
  for (const [namespace, overrides] of Object.entries(options.messenger || {})) {
    messenger[namespace] = { ...(messenger[namespace] || {}), ...overrides };
  }

  const browser = options.browser || {
    runtime: { getManifest: () => JSON.parse(source("manifest.json")) },
    httpServer: {
      start: async () => {},
      onRequest: { addListener() {} },
      onSendInvitation: { addListener() {} },
      refreshFolder: async id => ({ folder_id: id, refreshed: true })
    }
  };

  const sandbox = { browser, messenger, console: silentConsole };
  if (options.clock) {
    // Production code that schedules work against Date.now()/setTimeout() can
    // be driven deterministically by passing the harness Clock.
    sandbox.setTimeout = options.clock.setTimeout.bind(options.clock);
    sandbox.clearTimeout = options.clock.clearTimeout.bind(options.clock);
    sandbox.Date = createClockDate(options.clock);
  }
  const context = vm.createContext(sandbox);
  for (const file of ["api/utils.js", "api/email.js", "api/contacts.js", "background.js"]) {
    vm.runInContext(source(file), context, { filename: file });
  }

  async function request(method, pathname, queryString = "", body = "") {
    const result = await context.handleRequest({ method, path: pathname, queryString, body });
    return { status: result.statusCode, body: JSON.parse(result.body) };
  }

  return {
    browser, context, events, messenger, messages, queries, updates, continuedLists, abortedLists, folders,
    Email: context.Email, Utils: context.Utils, Contacts: context.Contacts,
    request,
    count: event => events.filter(([name]) => name === event).length
  };
}

// ---------------------------------------------------------------------------
// Fake calendar (calendars, items, recurrence info, dtz)
// ---------------------------------------------------------------------------

function toDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function fakeDateTime(nativeTime = 0, { isDate = false, timezone = null } = {}) {
  return {
    nativeTime,
    isDate,
    timezone,
    clone() {
      return fakeDateTime(this.nativeTime, { isDate: this.isDate, timezone: this.timezone });
    },
    toString() {
      return new Date(this.nativeTime / 1000).toISOString();
    }
  };
}

function toRid(value, allDay = false) {
  if (value && typeof value === "object" && typeof value.nativeTime === "number") return value;
  const date = value instanceof Date ? value : new Date(value);
  return fakeDateTime(date.getTime() * 1000, { isDate: !!allDay });
}

// CalRecurrenceInfo keys rids by their UTC value (Appendix A.4).
function ridKey(rid) {
  return rid.isDate
    ? `date:${new Date(rid.nativeTime / 1000).toISOString().slice(0, 10)}`
    : `time:${rid.nativeTime}`;
}

function createOccurrence(parentItem, rid) {
  const duration = parentItem?.startDate && parentItem?.endDate
    ? parentItem.endDate.nativeTime - parentItem.startDate.nativeTime
    : 0;
  return {
    id: parentItem?.id,
    title: parentItem?.title || "",
    recurrenceId: rid,
    parentItem,
    startDate: fakeDateTime(rid.nativeTime, { isDate: rid.isDate, timezone: rid.timezone }),
    endDate: fakeDateTime(rid.nativeTime + duration, { isDate: rid.isDate, timezone: rid.timezone }),
    getProperty(name) {
      return parentItem?.getProperty?.(name) ?? null;
    },
    getAttendees() {
      return parentItem?.getAttendees?.() || [];
    },
    clone() {
      return createOccurrence(parentItem, rid.clone());
    }
  };
}

/**
 * Minimal CalRecurrenceInfo: enough for occurrence resolution tests. Tests can
 * inject their own via item specs (`recurrenceInfo`) or `options.recurrenceInfo`
 * (a factory `(spec, parentItem) => info`).
 */
class FakeRecurrenceInfo {
  constructor(spec = {}, parentItem = null) {
    this.parentItem = parentItem;
    this.occurrences = (spec.occurrences || []).map(rid => toRid(rid, spec.allDay));
    this.exceptions = new Map();
    for (const exception of spec.exceptions || []) {
      const rid = toRid(exception.recurrenceId ?? exception.rid, spec.allDay);
      this.exceptions.set(ridKey(rid), {
        rid,
        item: exception.item || createOccurrence(parentItem, rid)
      });
    }
    this.removedOccurrences = [];
  }

  getOccurrenceFor(ridInput) {
    // Thunderbird returns a proxy for any rid, existing or not (Appendix A.4).
    return createOccurrence(this.parentItem, toRid(ridInput, this.parentItem?.startDate?.isDate));
  }

  getExceptionFor(ridInput) {
    return this.exceptions.get(ridKey(toRid(ridInput)))?.item || null;
  }

  getExceptionIds() {
    return [...this.exceptions.values()].map(exception => exception.rid);
  }

  removeOccurrenceAt(ridInput) {
    this.removedOccurrences.push(ridInput);
  }

  getOccurrences(from, to, count) {
    return this.occurrences
      .filter(rid => rid.nativeTime >= from.nativeTime && rid.nativeTime <= to.nativeTime)
      .slice(0, count > 0 ? count : undefined)
      .map(rid => createOccurrence(this.parentItem, rid));
  }

  clone() {
    const copy = new FakeRecurrenceInfo();
    copy.parentItem = this.parentItem;
    copy.occurrences = this.occurrences.map(rid => rid.clone());
    copy.exceptions = new Map(this.exceptions);
    copy.removedOccurrences = [...this.removedOccurrences];
    return copy;
  }
}

function createCalendarItem(spec = {}) {
  const start = toDate(spec.start);
  const end = toDate(spec.end);
  const item = {
    id: spec.id || "",
    title: spec.title || "",
    startDate: start ? fakeDateTime(start.getTime() * 1000, { isDate: !!spec.allDay }) : null,
    endDate: end ? fakeDateTime(end.getTime() * 1000, { isDate: !!spec.allDay }) : null,
    recurrenceId: spec.recurrenceId ? toRid(spec.recurrenceId, spec.allDay) : null,
    parentItem: spec.parentItem || null,
    organizer: spec.organizer ? createCalendarAttendee(spec.organizer) : null,
    recurrenceInfo: spec.recurrenceInfo || null,
    _properties: {
      ...(spec.location ? { LOCATION: spec.location } : {}),
      ...(spec.description ? { DESCRIPTION: spec.description } : {})
    },
    _attendees: (spec.attendees || []).map(createCalendarAttendee),
    getProperty(name) {
      return this._properties[name] ?? null;
    },
    setProperty(name, value) {
      this._properties[name] = value;
    },
    getAttendees() {
      return this._attendees;
    },
    addAttendee(attendee) {
      this._attendees.push(attendee);
    },
    removeAllAttendees() {
      this._attendees = [];
    },
    clone() {
      const copy = createCalendarItem(spec);
      copy.id = this.id;
      copy.title = this.title;
      copy._properties = { ...this._properties };
      copy._attendees = [...this._attendees];
      copy.recurrenceInfo = this.recurrenceInfo?.clone?.() || this.recurrenceInfo;
      return copy;
    }
  };
  return item;
}

function createCalendarAttendee(spec = {}) {
  if (typeof spec === "string") {
    return { id: `mailto:${spec}`, commonName: null, role: "REQ-PARTICIPANT", participationStatus: "NEEDS-ACTION" };
  }
  return { commonName: null, role: "REQ-PARTICIPANT", participationStatus: "NEEDS-ACTION", ...spec };
}

function createFakeCal(options = {}) {
  let uuidCounter = 0;
  const defaultTimezone = { id: "floating", isFloating: true, isUTC: false };
  const dtz = {
    defaultTimezone,
    UTC: { id: "UTC", isUTC: true, isFloating: false },
    floating: defaultTimezone,
    getTimezone(id) {
      return id === "UTC" ? dtz.UTC : { ...defaultTimezone, id: id || defaultTimezone.id };
    },
    jsDateToDateTime(date, timezone) {
      return fakeDateTime(date.getTime() * 1000, { timezone: timezone || defaultTimezone });
    },
    dateTimeToJSDate(value) {
      return new Date(value.nativeTime / 1000);
    }
  };

  const recurrenceFactory = options.recurrenceInfo || ((spec, parentItem) => new FakeRecurrenceInfo(spec, parentItem));
  const calendarSpecs = options.calendars || [{ id: "test-calendar", name: "Test Calendar", type: "storage", readOnly: false }];

  const calendars = calendarSpecs.map((spec, index) => {
    const calendar = {
      id: spec.id || `calendar-${index + 1}`,
      name: spec.name || spec.id || `Calendar ${index + 1}`,
      type: spec.type || "storage",
      readOnly: !!spec.readOnly,
      items: [],
      getProperty(name) {
        return spec.properties?.[name] ?? (name === "color" ? spec.color ?? null : null);
      },
      async getItem(id) {
        return this.items.find(item => item.id === id) || null;
      },
      async getItemsAsArray(filter, count, rangeStart, rangeEnd) {
        const from = rangeStart?.nativeTime ?? -Infinity;
        const to = rangeEnd?.nativeTime ?? Infinity;
        const results = [];
        for (const item of this.items) {
          if (item.recurrenceInfo) {
            results.push(...item.recurrenceInfo.getOccurrences(
              rangeStart || fakeDateTime(-Infinity), rangeEnd || fakeDateTime(Infinity), 0));
          } else if (item.startDate && item.startDate.nativeTime >= from && item.startDate.nativeTime <= to) {
            results.push(item);
          }
        }
        return results;
      },
      async addItem(item) {
        if (!item.id) item.id = `item-${++uuidCounter}`;
        this.items.push(item);
        return item;
      },
      async modifyItem(newItem, oldItem) {
        const at = this.items.indexOf(oldItem);
        if (at >= 0) this.items[at] = newItem;
        else this.items.push(newItem);
        return newItem;
      },
      async deleteItem(item) {
        const at = this.items.indexOf(item);
        if (at >= 0) this.items.splice(at, 1);
      }
    };

    const globalItems = (options.items || []).filter(itemSpec =>
      itemSpec.calendarId ? itemSpec.calendarId === calendar.id : index === 0
    );
    for (const itemSpec of [...(spec.items || []), ...globalItems]) {
      const item = createCalendarItem(itemSpec);
      if (!item.recurrenceInfo && itemSpec.recurrence) {
        item.recurrenceInfo = recurrenceFactory(itemSpec.recurrence, item);
      }
      calendar.items.push(item);
    }
    return calendar;
  });

  return {
    manager: { getCalendars: () => calendars },
    dtz,
    createDateTime(nativeTime = 0) {
      return fakeDateTime(nativeTime, { timezone: defaultTimezone });
    },
    getUUID() {
      return `fake-uuid-${++uuidCounter}`;
    }
  };
}

function createFakeMailSession() {
  const listeners = new Map();
  return {
    listeners,
    AddFolderListener(listener, flags) {
      listeners.set(listener, flags);
    },
    RemoveFolderListener(listener) {
      listeners.delete(listener);
    },
    // Test helper: emit a folder event to every registered listener.
    emitFolderEvent(folder, event) {
      for (const listener of listeners.keys()) listener.onFolderEvent(folder, event);
    }
  };
}

// ---------------------------------------------------------------------------
// Experiment harness
// ---------------------------------------------------------------------------

function experimentHarness(options = {}) {
  const clock = new Clock();
  const events = [];
  const nativeFolders = new Map();
  const closers = new Set();
  const folderSpecs = options.folders || DEFAULT_FOLDERS;
  const Ci = {
    nsMsgFolderFlags: { Virtual: 0x20 },
    nsIMsgImapMailFolder: {},
    nsIFolderListener: { event: 0x80 },
    calICalendar: { ITEM_FILTER_TYPE_EVENT: 0x1, ITEM_FILTER_CLASS_OCCURRENCES: 0x2 },
    calIEvent: {},
    calIAttendee: {}
  };
  const fixtures = folderSpecs.map(spec => {
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
    constructor({ register, name }) { this.register = register; this.name = name; }
    api() {
      return {
        addListener: listener => {
          // options.noRequestListener models a server that is reachable before
          // the background has registered its listener: onRequestFire stays null.
          if (this.name === "httpServer.onRequest" && options.noRequestListener) return;
          this.register({
            async: payload => {
              // Observe experiment -> background dispatch so tests can assert that
              // a rejected request never fires a background event.
              if (this.name === "httpServer.onRequest") {
                events.push(["background-request", payload.method, payload.path]);
              }
              return listener(payload);
            }
          });
        }
      };
    }
  }

  const mailSession = options.mailSession || createFakeMailSession();
  const cal = options.cal || createFakeCal({
    calendars: options.calendars,
    items: options.items,
    recurrenceInfo: options.recurrenceInfo
  });
  const Components = { isSuccessCode: code => (code >>> 31) === 0 };

  const Services = {
    io: { offline: !!options.offline },
    scriptloader: {
      loadSubScript(name, scope) {
        if (name === "lib/httpd.js") {
          scope.HttpServer = Server;
          return;
        }
        if (name.endsWith("experiment/folders.js")) {
          scope.Date = { now: () => clock.now };
          vm.runInNewContext(source(name), scope, { filename: name });
          return;
        }
        // api/calendar.js (and api/utils.js once it is loaded alongside it)
        // runs in the privileged experiment scope.
        Object.assign(scope, { Cc, Ci, ChromeUtils, Services, Components, console: silentConsole });
        vm.runInNewContext(source(name), scope, { filename: name });
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
      if (name.endsWith("/calUtils.sys.mjs")) {
        return { cal };
      }
      if (name.endsWith("/MailServices.sys.mjs")) {
        return options.mailServices || { MailServices: { mailSession } };
      }
      throw new Error(`Unavailable module: ${name}`);
    }
  };
  const Cc = {
    "@mozilla.org/process/environment;1": {
      getService() {
        return {
          get: name => options.env?.[name] ?? (name === "TB_API_TOKEN" ? (options.token || "") : "")
        };
      }
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
    },
    "@mozilla.org/calendar/event;1": {
      createInstance() { return createCalendarItem(); }
    },
    "@mozilla.org/calendar/attendee;1": {
      createInstance() { return createCalendarAttendee(); }
    }
  };
  const privileged = vm.createContext({
    ChromeUtils, Services, Ci, Cc, console: silentConsole, Components
  });
  vm.runInContext(source("experiment/api.js"), privileged, { filename: "experiment/api.js" });
  const instance = new privileged.httpServer();
  const api = instance.getAPI({
    extension: { rootURI: { resolve: name => name } },
    callOnClose: closer => closers.add(closer)
  }).httpServer;
  if (options.t) {
    options.t.after(() => {
      instance.close();
      assert.equal(clock.timers.size, 0, "shutdown must clean up all caller timers");
      assert.equal(instance.folderRefresher.inFlight.size, 0);
    });
  }

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
  const background = backgroundHarness({
    browser,
    clock,
    events,
    folders: folderSpecs,
    messages: options.messages,
    identities: options.identities,
    messenger: options.messenger
  });

  /**
   * Drive one HTTP request through the experiment server handler. Resolves on
   * response.finish(), or with { hung: true } if the response never finishes
   * before `timeoutMs` (a real timer used only as a safety net).
   */
  async function request(method, pathname, {
    queryString = "", body = "", token, headers = {}, timeoutMs = 1000
  } = {}) {
    return new Promise(resolve => {
      let settled = false;
      let timer = null;
      const finish = result => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      const response = {
        bodyOutputStream: { text: "" },
        headers: {},
        processAsync() {},
        setStatusLine(version, status) { this.status = status; },
        setHeader(name, value) { this.headers[name] = value; },
        finish() {
          const text = this.bodyOutputStream.text;
          let parsed = null;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = text;
            }
          }
          finish({ status: this.status, body: parsed, headers: this.headers });
        }
      };
      const requestHeaders = new Map();
      if (token) requestHeaders.set("authorization", `Bearer ${token}`);
      for (const [name, value] of Object.entries(headers)) {
        requestHeaders.set(name.toLowerCase(), value);
      }
      if (timeoutMs > 0) {
        timer = setTimeout(() => finish({ hung: true }), timeoutMs);
        if (timer.unref) timer.unref();
      }
      instance.server.handler({
        method, path: pathname, queryString, httpVersion: "1.1",
        bodyInputStream: { text: Buffer.from(body, "utf8").toString("latin1") },
        hasHeader(name) {
          return requestHeaders.has(name.toLowerCase());
        },
        getHeader(name) {
          const key = name.toLowerCase();
          if (!requestHeaders.has(key)) throw new Error("Missing header");
          return requestHeaders.get(key);
        }
      }, response);
    });
  }

  return {
    api, instance, fixtures, clock, events, Services, nativeFolders, closers, browser,
    Email: background.Email, Utils: background.Utils, Contacts: background.Contacts,
    messenger: background.messenger, messages: background.messages, queries: background.queries,
    updates: background.updates, folders: background.folders,
    continuedLists: background.continuedLists, abortedLists: background.abortedLists,
    cal, mailSession, request,
    count: event => events.filter(([name]) => name === event).length
  };
}

module.exports = { Clock, backgroundHarness, experimentHarness, flush };
