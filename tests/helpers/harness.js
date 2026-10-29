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

/** Minimal Blob/File stand-ins for the invitation attachment (web globals). */
class FakeBlob {
  constructor(parts = [], options = {}) {
    this.parts = parts;
    this.type = options.type || "";
  }
}

class FakeFile extends FakeBlob {
  constructor(parts = [], name = "", options = {}) {
    super(parts, options);
    this.name = name;
  }
}

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
  const composeCalls = [];
  let nextComposeTab = 0;
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
    },
    // Compose windows used by the invitation listener (and POST /messages).
    // Every call is recorded in `composeCalls` so tests can assert the draft
    // save / send flow without a real Thunderbird. Tests override single
    // methods through the `messenger` option seam, e.g.
    // { compose: { sendMessage: async () => ({ mode: "queued" }) } }.
    compose: {
      async beginNew(details) {
        composeCalls.push({ method: "beginNew", details });
        return { id: `compose-tab-${++nextComposeTab}` };
      },
      async beginReply(messageId, type, details) {
        composeCalls.push({ method: "beginReply", messageId, type, details });
        return { id: `compose-tab-${++nextComposeTab}` };
      },
      async beginForward(messageId, type, details) {
        composeCalls.push({ method: "beginForward", messageId, type, details });
        return { id: `compose-tab-${++nextComposeTab}` };
      },
      async getComposeDetails() {
        return { isPlainText: true, plainTextBody: "" };
      },
      async setComposeDetails(tabId, details) {
        composeCalls.push({ method: "setComposeDetails", tabId, details });
      },
      async addAttachment(tabId, attachment) {
        composeCalls.push({ method: "addAttachment", tabId, attachment });
      },
      async saveMessage(tabId, options = {}) {
        composeCalls.push({ method: "saveMessage", tabId, options });
        return { mode: options.mode || "draft" };
      },
      async sendMessage(tabId, options = {}) {
        composeCalls.push({ method: "sendMessage", tabId, options });
        // Thunderbird reports the outcome of a sendNow as sent (or queued when
        // the message is handed to the outgoing queue).
        return { mode: options.mode === "sendNow" ? "sent" : "queued" };
      }
    },
    tabs: {
      async remove(tabId) {
        composeCalls.push({ method: "removeTab", tabId });
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
      refreshFolder: async id => ({ folder_id: id, refreshed: true }),
      // Message-manager flags are best-effort: the default page has none.
      getMessageFlags: async () => ({})
    }
  };

  const sandbox = { browser, messenger, console: silentConsole, Blob: FakeBlob, File: FakeFile };
  if (options.clock) {
    // Production code that schedules work against Date.now()/setTimeout() can
    // be driven deterministically by passing the harness Clock.
    sandbox.setTimeout = options.clock.setTimeout.bind(options.clock);
    sandbox.clearTimeout = options.clock.clearTimeout.bind(options.clock);
    sandbox.Date = createClockDate(options.clock);
  }
  const context = vm.createContext(sandbox);
  for (const file of ["api/utils.js", "api/attachments.js", "api/email.js", "api/contacts.js", "background.js"]) {
    vm.runInContext(source(file), context, { filename: file });
  }

  async function request(method, pathname, queryString = "", body = "") {
    const result = await context.handleRequest({ method, path: pathname, queryString, body });
    if (result && typeof result.binaryBodyBase64 === "string") {
      return {
        status: result.statusCode,
        headers: result.headers || {},
        rawBytes: Uint8Array.from(Buffer.from(result.binaryBodyBase64, "base64")),
        body: null
      };
    }
    return { status: result.statusCode, body: JSON.parse(result.body) };
  }

  return {
    browser, context, events, messenger, messages, queries, updates, continuedLists, abortedLists, folders,
    composeCalls,
    Email: context.Email, Utils: context.Utils, Contacts: context.Contacts,
    Attachments: context.Attachments, File: FakeFile,
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

/**
 * A CalTimezone fake, faithful to Appendix A.4: floating (and UTC) zones read
 * nativeTime as UTC, other zones apply a fixed offset. Tests configure the
 * shape, e.g. `{ tzid: "Test/Zone", offsetMinutes: 120 }`.
 */
function fakeTimezone(spec = {}) {
  const isFloating = !!spec.isFloating;
  const tzid = spec.tzid || spec.id || (isFloating ? "floating" : "UTC");
  const offsetMinutes = Number.isFinite(spec.offsetMinutes) ? spec.offsetMinutes : 0;
  return {
    id: spec.id || tzid,
    tzid,
    isFloating,
    isUTC: spec.isUTC ?? (!isFloating && offsetMinutes === 0),
    offsetMinutes
  };
}

const FLOATING_TIMEZONE = fakeTimezone({ tzid: "floating", isFloating: true });

/** Wall-clock fields of a nativeTime (µs) in the date-time's timezone. */
function wallClock(nativeTime, isDate, timezone) {
  const tz = timezone || FLOATING_TIMEZONE;
  // All-day dates and floating times are read as UTC (utcOffset() is 0);
  // zone-attached values are the exact instant shifted into the zone.
  const offsetMs = isDate || tz.isFloating ? 0 : (tz.offsetMinutes || 0) * 60000;
  const date = new Date(Math.round(nativeTime / 1000) + offsetMs);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds()
  };
}

function fakeDateTime(nativeTime = 0, { isDate = false, timezone = null } = {}) {
  const dateTime = {
    nativeTime,
    isDate,
    timezone: timezone || FLOATING_TIMEZONE,
    getInTimezone(tz) {
      return fakeDateTime(this.nativeTime, { isDate: this.isDate, timezone: tz });
    },
    clone() {
      return fakeDateTime(this.nativeTime, { isDate: this.isDate, timezone: this.timezone });
    },
    toString() {
      return new Date(this.nativeTime / 1000).toISOString();
    }
  };
  // CalDateTime exposes wall-clock fields; month is 0-based.
  for (const field of ["year", "month", "day", "hour", "minute", "second"]) {
    Object.defineProperty(dateTime, field, {
      get() { return wallClock(this.nativeTime, this.isDate, this.timezone)[field]; },
      enumerable: true
    });
  }
  return dateTime;
}

/**
 * nativeTime (µs) for a calendar item. All-day dates are stored at UTC
 * midnight of the calendar date (iCalendar DATE): a `YYYY-MM-DD` string is
 * taken verbatim so the calendar date never depends on the host timezone;
 * a Date is read in local time, like the UI would.
 */
function toNativeTime(value, allDay) {
  if (value === undefined || value === null || value === "") return null;
  if (allDay) {
    if (typeof value === "string") {
      const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (match) return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) * 1000;
    }
    const date = toDate(value);
    return date ? Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) * 1000 : null;
  }
  const date = toDate(value);
  return date ? date.getTime() * 1000 : null;
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

function createOccurrence(parentItem, rid, overrides = {}) {
  const duration = parentItem?.startDate && parentItem?.endDate
    ? parentItem.endDate.nativeTime - parentItem.startDate.nativeTime
    : 0;
  const startNative = overrides.startNative ?? rid.nativeTime;
  const endNative = overrides.endNative ?? startNative + duration;
  // An occurrence inherits the parent's zone; an exception may override it.
  const timezone = overrides.timezone ?? parentItem?.startDate?.timezone ?? rid.timezone;
  // Exceptions start from the parent and may override properties/attendees.
  const properties = { ...(overrides.properties || {}) };
  let attendees = overrides.attendees ? [...overrides.attendees] : null;
  return {
    id: parentItem?.id,
    title: overrides.title ?? parentItem?.title ?? "",
    recurrenceId: rid,
    parentItem,
    startDate: fakeDateTime(startNative, { isDate: rid.isDate, timezone }),
    endDate: fakeDateTime(endNative, { isDate: rid.isDate, timezone }),
    getProperty(name) {
      return properties[name] ?? parentItem?.getProperty?.(name) ?? null;
    },
    setProperty(name, value) {
      properties[name] = value;
    },
    getAttendees() {
      return attendees || parentItem?.getAttendees?.() || [];
    },
    addAttendee(attendee) {
      if (!attendees) attendees = [...(parentItem?.getAttendees?.() || [])];
      attendees.push(attendee);
    },
    removeAllAttendees() {
      attendees = [];
    },
    clone() {
      return createOccurrence(parentItem, rid.clone(), {
        startNative: this.startDate.nativeTime,
        endNative: this.endDate.nativeTime,
        title: this.title,
        properties: { ...properties },
        attendees: attendees ? [...attendees] : null
      });
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
      let item = exception.item || null;
      if (!item) {
        // An exception may be moved: `start`/`end` describe where it went,
        // while `recurrenceId` stays the original series slot.
        const isDate = exception.allDay ?? spec.allDay ?? rid.isDate;
        const overrides = {};
        if (exception.start !== undefined) {
          overrides.startNative = toNativeTime(exception.start, isDate);
          overrides.endNative = exception.end !== undefined
            ? toNativeTime(exception.end, isDate)
            : overrides.startNative + (parentItem?.startDate && parentItem?.endDate
              ? parentItem.endDate.nativeTime - parentItem.startDate.nativeTime
              : 0);
        }
        if (exception.title !== undefined) overrides.title = exception.title;
        if (exception.location !== undefined) overrides.properties = { LOCATION: exception.location };
        item = createOccurrence(parentItem, rid, overrides);
      }
      this.exceptions.set(ridKey(rid), { rid, item });
    }
    this.removedOccurrences = [];
  }

  getOccurrenceFor(ridInput) {
    // Thunderbird returns a proxy for any rid, existing or not (Appendix A.4).
    return createOccurrence(this.parentItem, toRid(ridInput, this.parentItem?.startDate?.isDate));
  }

  getExceptionFor(ridInput) {
    return this.exceptions.get(ridKey(toRid(ridInput, this.parentItem?.startDate?.isDate)))?.item || null;
  }

  getExceptionIds() {
    return [...this.exceptions.values()].map(exception => exception.rid);
  }

  addException(rid, item) {
    this.exceptions.set(ridKey(rid), { rid: rid.clone ? rid.clone() : rid, item });
  }

  removeOccurrenceAt(ridInput) {
    this.removedOccurrences.push(ridInput);
  }

  isRemoved(rid) {
    const key = ridKey(rid);
    return this.removedOccurrences.some(removed => ridKey(removed) === key);
  }

  getOccurrences(from, to, count) {
    return this.occurrences
      // Cancelled occurrences are excluded, like an EXDATE in iCalendar.
      .filter(rid => !this.isRemoved(rid))
      .filter(rid => rid.nativeTime >= from.nativeTime && rid.nativeTime <= to.nativeTime)
      .slice(0, count > 0 ? count : undefined)
      // A modified occurrence is returned in place of its original slot.
      .map(rid => this.getExceptionFor(rid) || createOccurrence(this.parentItem, rid));
  }

  clone() {
    const copy = new FakeRecurrenceInfo();
    copy.parentItem = this.parentItem;
    copy.occurrences = this.occurrences.map(rid => rid.clone());
    copy.exceptions = new Map([...this.exceptions].map(([key, exception]) => [key, {
      rid: exception.rid.clone(), item: exception.item
    }]));
    copy.removedOccurrences = [...this.removedOccurrences];
    return copy;
  }
}

function createCalendarItem(spec = {}) {
  const allDay = !!spec.allDay;
  const timezone = spec.timezone ? fakeTimezone(spec.timezone) : null;
  const startNative = toNativeTime(spec.start, allDay);
  const endNative = toNativeTime(spec.end, allDay);
  const item = {
    id: spec.id || "",
    title: spec.title || "",
    startDate: startNative === null ? null : fakeDateTime(startNative, { isDate: allDay, timezone }),
    endDate: endNative === null ? null : fakeDateTime(endNative, { isDate: allDay, timezone }),
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
      // A clone keeps the whole item, like Thunderbird's own item clone: a
      // provider round-trip must not silently drop dates or the organizer.
      copy.startDate = this.startDate ? this.startDate.clone() : null;
      copy.endDate = this.endDate ? this.endDate.clone() : null;
      copy.organizer = this.organizer;
      copy.recurrenceId = this.recurrenceId
        ? (this.recurrenceId.clone ? this.recurrenceId.clone() : this.recurrenceId)
        : null;
      copy.recurrenceInfo = this.recurrenceInfo?.clone?.() || this.recurrenceInfo;
      // Occurrences inherit from the parent they end up attached to.
      if (copy.recurrenceInfo) copy.recurrenceInfo.parentItem = copy;
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

/**
 * Minimal calIIcsSerializer: records the items and properties it receives and
 * emits a small but valid VCALENDAR, so tests can assert that the item saved
 * by addItem (and not the pre-save object) was serialized and that the UID in
 * the ICS content is the event id.
 */
function createFakeIcsSerializer() {
  return {
    items: [],
    properties: [],
    addItems(items) {
      this.items.push(...items);
    },
    addProperty(property) {
      this.properties.push(property);
    },
    serializeToString() {
      const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test ICS serializer//EN"];
      for (const property of this.properties) {
        lines.push(`${property.propertyName}:${property.value}`);
      }
      for (const item of this.items) {
        lines.push("BEGIN:VEVENT");
        lines.push(`UID:${item.id}`);
        lines.push(`SUMMARY:${item.title}`);
        lines.push("END:VEVENT");
      }
      lines.push("END:VCALENDAR");
      return lines.join("\r\n");
    }
  };
}

function createFakeCal(options = {}) {
  let uuidCounter = 0;
  // The calendar's default timezone is configurable so tests can prove that
  // events are reported in it instead of the host zone (Task 5.1).
  const defaultTimezone = fakeTimezone(options.timezone || { tzid: "floating", isFloating: true });
  const zones = options.timezones || {};
  const dtz = {
    defaultTimezone,
    UTC: fakeTimezone({ tzid: "UTC", isUTC: true }),
    floating: FLOATING_TIMEZONE,
    getTimezone(id) {
      if (!id) return defaultTimezone;
      if (id === "UTC") return dtz.UTC;
      if (id === "floating") return FLOATING_TIMEZONE;
      return fakeTimezone({ ...(zones[id] || {}), tzid: id });
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
        // Thunderbird returns the item it saved, which is a distinct object
        // from the pre-save one (and may carry a provider-assigned id). The
        // fake returns a real clone so a caller that serializes the wrong
        // object cannot pass the invitation UID test by accident (M11).
        const saved = item.clone();
        if (!saved.id) saved.id = `item-${++uuidCounter}`;
        this.items.push(saved);
        return saved;
      },
      async modifyItem(newItem, oldItem) {
        const at = this.items.indexOf(oldItem);
        if (at >= 0) {
          this.items[at] = newItem;
          return newItem;
        }
        // A modified occurrence rewrites its parent series with the exception
        // (Appendix A.4).
        const parent = oldItem?.parentItem;
        const parentAt = parent ? this.items.indexOf(parent) : -1;
        if (parentAt >= 0) {
          const newParent = parent.clone();
          newParent.recurrenceInfo.addException(newItem.recurrenceId, newItem);
          this.items[parentAt] = newParent;
          return newItem;
        }
        this.items.push(newItem);
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
    createDateTime(value = 0) {
      // All-day create/update builds isDate values from "YYYYMMDD" (Task 5.1).
      if (typeof value === "string") {
        const dateOnly = value.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
        if (dateOnly) {
          const [year, month, day] = dateOnly.slice(1).map(Number);
          return fakeDateTime(Date.UTC(year, month - 1, day) * 1000, {
            isDate: true,
            timezone: FLOATING_TIMEZONE
          });
        }
        const parsed = new Date(value);
        return fakeDateTime(parsed.getTime() * 1000, { timezone: defaultTimezone });
      }
      return fakeDateTime(value, { timezone: defaultTimezone });
    },
    getUUID() {
      return `fake-uuid-${++uuidCounter}`;
    },
    // Thunderbird's ICS machinery (Task 5.4): createEvent builds the iTIP
    // METHOD property through it and serializes the saved item.
    icsService: {
      createIcalProperty(propertyName) {
        return { propertyName, value: null };
      }
    }
  };
}

function createFakeMailSession() {
  const listeners = new Map();
  const removed = [];
  return {
    listeners,
    removed,
    AddFolderListener(listener, flags) {
      listeners.set(listener, flags);
    },
    RemoveFolderListener(listener) {
      listeners.delete(listener);
      removed.push(listener);
    },
    // Test helper: emit a folder event to every registered listener.
    emitFolderEvent(folder, event) {
      for (const listener of [...listeners.keys()]) listener.onFolderEvent(folder, event);
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
    calIAttendee: {},
    calIIcsSerializer: {},
    nsIMsgIdentity: {},
    nsIBinaryOutputStream: {}
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
          // Likewise for invitations: options.noInvitationListener models a
          // background that has not registered the listener yet, and
          // options.invitationListener replaces the background's listener so a
          // test can control the returned outcome (or make it throw).
          if (this.name === "httpServer.onSendInvitation") {
            if (options.noInvitationListener) return;
            if (options.invitationListener) listener = options.invitationListener;
          }
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
    recurrenceInfo: options.recurrenceInfo,
    timezone: options.timezone,
    timezones: options.timezones
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
        if (options.mailServices) return options.mailServices;
        return {
          MailServices: {
            mailSession,
            // The user's own identities, shared with background.js's
            // messenger.identities.list().
            accounts: { allIdentities: options.identities || [] }
          }
        };
      }
      throw new Error(`Unavailable module: ${name}`);
    }
  };
  const icsSerializers = [];
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
    "@mozilla.org/binaryoutputstream;1": {
      createInstance() {
        return {
          setOutputStream(stream) { this.stream = stream; },
          writeByteArray(bytes) {
            this.stream.bytes = this.stream.bytes || [];
            this.stream.bytes.push(...bytes);
          },
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
    },
    "@mozilla.org/calendar/ics-serializer;1": {
      createInstance() {
        const serializer = createFakeIcsSerializer();
        icsSerializers.push(serializer);
        return serializer;
      }
    }
  };
  const privileged = vm.createContext({
    ChromeUtils, Services, Ci, Cc, console: silentConsole, Components
  });
  vm.runInContext(source("experiment/api.js"), privileged, { filename: "experiment/api.js" });
  const instance = new privileged.httpServer();
  const api = instance.getAPI({
    extension: {
      rootURI: { resolve: name => name },
      // Only present when a test provides one: without it, getMessageFlags
      // exercises the "message manager unavailable" fallback.
      ...(options.messageManager ? { messageManager: options.messageManager } : {})
    },
    callOnClose: closer => closers.add(closer)
  }).httpServer;
  if (options.t) {
    options.t.after(() => {
      instance.close();
      assert.equal(clock.timers.size, 0, "shutdown must clean up all caller timers");
      assert.equal(instance.folderRefresher.inFlight.size, 0);
      if (mailSession.listeners) {
        assert.equal(mailSession.listeners.size, 0, "shutdown must remove the folder listener");
      }
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
        bodyOutputStream: { text: "", bytes: null },
        headers: {},
        processAsync() {},
        setStatusLine(version, status) { this.status = status; },
        setHeader(name, value) { this.headers[name] = value; },
        finish() {
          if (Array.isArray(this.bodyOutputStream.bytes)) {
            finish({
              status: this.status,
              headers: this.headers,
              rawBytes: Uint8Array.from(this.bodyOutputStream.bytes)
            });
            return;
          }
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
    cal, mailSession, request, composeCalls: background.composeCalls, icsSerializers,
    count: event => events.filter(([name]) => name === event).length
  };
}

module.exports = { Clock, backgroundHarness, experimentHarness, flush };
