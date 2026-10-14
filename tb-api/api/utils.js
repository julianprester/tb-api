"use strict";

/**
 * Parse query string into object
 *
 * Splits on "&", splits each part at the first "=" (so values may contain
 * "="), and treats "+" as a space in both keys and values. Malformed
 * percent-encoding makes decodeURIComponent throw URIError, which the caller
 * maps to HTTP 400.
 */
function parseQueryString(qs) {
  const params = {};
  if (!qs) return params;
  for (const part of qs.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? "" : part.slice(eq + 1);
    const decode = s => decodeURIComponent(s.replace(/\+/g, " "));
    params[decode(rawKey)] = decode(rawValue);
  }
  return params;
}

/**
 * Error carrying a stable `code` and an HTTP `statusCode`, so request-level
 * failures (malformed body, bad query) reach the route handler's catch with
 * their intended status instead of a generic 500.
 */
class RequestError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = "RequestError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Parse a query string and an optional JSON body into one params object.
 * Body params win over query params. A malformed JSON body throws SyntaxError;
 * a JSON body that is not an object (null, array, scalar) throws RequestError
 * with code "invalid_body".
 */
function parseRequestParams(queryString, body) {
  let bodyParams = {};
  if (body) {
    bodyParams = JSON.parse(body);
    if (bodyParams === null || typeof bodyParams !== "object" || Array.isArray(bodyParams)) {
      throw new RequestError("Request body must be a JSON object", "invalid_body", 400);
    }
  }
  return { ...parseQueryString(queryString), ...bodyParams };
}

/**
 * Weekday names accepted in relative dates, mapped to ISO weekday numbers
 * (Monday = 1 .. Sunday = 7).
 */
const WEEKDAYS = {
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
  sunday: 7, sun: 7
};

/** Local midnight of `date` (returns a new Date, never mutates the input). */
function localMidnight(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Local midnight `days` days away from `date` (never mutates the input). */
function shiftDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Local time `months` months away from `date` (never mutates the input). */
function shiftMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
}

/** ISO weekday of `date`: Monday = 1 .. Sunday = 7. */
function isoWeekday(date) {
  return ((date.getDay() + 6) % 7) + 1;
}

/**
 * Local Date for y-m-d at midnight, or null when the calendar date does not
 * exist. JS would otherwise roll impossible dates over (2024-02-31 -> Mar 2).
 */
function validLocalDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

/**
 * Parse a date string into a Date, returning null for input that is not
 * recognizably a date.
 *
 * `now` is injectable so tests are deterministic; it is copied and never
 * mutated.
 *
 * Accepted forms (all relative forms resolve to LOCAL midnight except "now"):
 * - `YYYY-MM-DD`                   -> local midnight (decision D9)
 * - `YYYY-MM-DDTHH:MM[:SS[.sss]]`  -> local time; with `Z`/`+HH:MM` -> that instant
 * - `now`, `today`, `yesterday`, `tomorrow`
 * - `last|next week`, `last|next month`, `a week|month ago`
 * - `N days|weeks|months ago`, `in N days|weeks|months`
 * - `next|last|this <weekday>`, bare `<weekday>`
 * - anything else containing a four-digit year that `new Date` understands
 *   (`Jan 15 2024`, `January 15 2024`, `01-15-2024`, `15/01/2024`, ...).
 *   Without a four-digit year the input is rejected rather than letting
 *   `new Date("Jan 15")` silently invent the year 2001.
 *
 * Weekdays are Monday-based:
 * - `next <weekday>` and bare `<weekday>` mean the next occurrence strictly
 *   after today (today excluded), so `next monday` on a Monday is +7 days.
 * - `last <weekday>` is the most recent occurrence strictly before today.
 * - `this <weekday>` is the occurrence in the current ISO week (starting
 *   Monday), which may be today, in the past, or still ahead.
 *
 * A `+` is treated as a space (clients sometimes double-encode spaces), except
 * when it introduces a timezone offset in an ISO datetime, so
 * `2024-01-15T10:30:00+02:00` keeps its offset.
 */
function parseDate(input, { now = new Date() } = {}) {
  const result = parseDateImpl(input, { now });
  // Overflow ("99999999999999999999 days ago") and impossible arithmetic can
  // still yield an Invalid Date; report those as unparseable like any other
  // bad input instead of returning a truthy Invalid Date.
  return Number.isFinite(result?.getTime()) ? result : null;
}

/**
 * Internal implementation behind `parseDate`. Callers must use `parseDate`,
 * which additionally rejects Invalid Dates produced by arithmetic overflow.
 */
function parseDateImpl(input, { now = new Date() } = {}) {
  if (input === null || input === undefined) return null;

  const raw = String(input).trim();
  if (!raw) return null;

  const isoWithOffset = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;
  const source = isoWithOffset.test(raw) ? raw : raw.replace(/\+/g, " ");
  const lower = source.toLowerCase();

  const base = new Date(now.getTime());
  const midnight = localMidnight(base);

  // Single-word relative dates
  if (lower === "now") return base;
  if (lower === "today") return midnight;
  if (lower === "yesterday") return shiftDays(midnight, -1);
  if (lower === "tomorrow") return shiftDays(midnight, 1);

  if (lower === "last week" || lower === "a week ago") return shiftDays(midnight, -7);
  if (lower === "next week") return shiftDays(midnight, 7);
  if (lower === "last month" || lower === "a month ago") return shiftMonths(midnight, -1);
  if (lower === "next month") return shiftMonths(midnight, 1);

  // "N days|weeks|months ago" and "in N days|weeks|months"
  const agoMatch = lower.match(/^(\d+)\s*(day|days|week|weeks|month|months)\s*ago$/);
  if (agoMatch) {
    const n = Number(agoMatch[1]);
    if (agoMatch[2].startsWith("day")) return shiftDays(midnight, -n);
    if (agoMatch[2].startsWith("week")) return shiftDays(midnight, -n * 7);
    return shiftMonths(midnight, -n);
  }
  const inMatch = lower.match(/^in\s*(\d+)\s*(day|days|week|weeks|month|months)$/);
  if (inMatch) {
    const n = Number(inMatch[1]);
    if (inMatch[2].startsWith("day")) return shiftDays(midnight, n);
    if (inMatch[2].startsWith("week")) return shiftDays(midnight, n * 7);
    return shiftMonths(midnight, n);
  }

  // Weekdays: "monday", "next monday", "last monday", "this monday"
  const weekdayMatch = lower.match(/^(?:(next|last|this)\s+)?([a-z]+)$/);
  // Own-property lookup: plain `WEEKDAYS[key]` would walk the prototype chain
  // and accept words like "constructor" (-> Object) as weekdays.
  if (weekdayMatch && Object.hasOwn(WEEKDAYS, weekdayMatch[2])) {
    const target = WEEKDAYS[weekdayMatch[2]];
    const today = isoWeekday(midnight);
    if (weekdayMatch[1] === "this") {
      const thisMonday = shiftDays(midnight, -(today - 1));
      return shiftDays(thisMonday, target - 1);
    }
    if (weekdayMatch[1] === "last") {
      return shiftDays(midnight, -(((today - target + 7) % 7) || 7));
    }
    // "next <weekday>" and bare "<weekday>": strictly after today.
    return shiftDays(midnight, ((target - today + 7) % 7) || 7);
  }

  // Calendar date, local midnight (D9). `new Date("2024-01-15")` is UTC.
  const isoDate = source.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) {
    return validLocalDate(Number(isoDate[1]), Number(isoDate[2]), Number(isoDate[3]));
  }

  // Numeric dates with the year last. Slash is day-first (international),
  // dash is month-first (US); an out-of-range month/day swaps the fields
  // ("31-12-2024", "01/15/2024").
  const numeric = source.match(/^(\d{1,2})([\/-])(\d{1,2})\2(\d{4})$/);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[3]);
    let day, month;
    if (first > 12 && second <= 12) {
      day = first; month = second;
    } else if (second > 12 && first <= 12) {
      day = second; month = first;
    } else if (numeric[2] === "-") {
      month = first; day = second;
    } else {
      day = first; month = second;
    }
    return validLocalDate(Number(numeric[4]), month, day);
  }

  // Anything else is trusted only when it carries a four-digit year, because
  // without one `new Date` silently invents a year ("Jan 15" -> 2001).
  if (/\d{4}/.test(source)) {
    const parsed = new Date(source);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

/**
 * Examples that `parseDate` is guaranteed to accept. Every "could not parse
 * date" error and the `GET /` tips use this list, so they cannot suggest a
 * form that does not parse. `tests/test-dates.js` asserts each entry parses.
 */
const DATE_SUGGESTIONS = [
  "2024-01-15",
  "2024-01-15T10:30:00",
  "now",
  "today",
  "tomorrow",
  "yesterday",
  "next week",
  "last week",
  "in 3 days",
  "2 weeks ago",
  "next monday",
  "last friday",
  "Jan 15 2024"
];

/**
 * Normalize parameter names - accept common aliases
 * This makes the API more forgiving for LLMs
 */
function normalizeParams(params, aliases) {
  const normalized = { ...params };
  for (const [canonical, alternates] of Object.entries(aliases)) {
    for (const alt of alternates) {
      if (normalized[alt] !== undefined && normalized[canonical] === undefined) {
        normalized[canonical] = normalized[alt];
        delete normalized[alt];
      }
    }
  }
  return normalized;
}

/**
 * Per-domain parameter aliases.
 *
 * A single global table renamed conflicting names for every endpoint: `q`
 * became `text` even for contacts, so GET /contacts?q= filtered on nothing,
 * and `start` meant both "search after this date" (email) and "event start"
 * (calendar). Each endpoint now picks the table matching its domain.
 */
const ALIASES = {
  // GET /messages, POST /mailboxes/refresh
  emailSearch: {
    text: ["q", "query", "search", "keyword", "keywords"],
    from: ["sender", "author"],
    to: ["recipient", "recipients"],
    subject: ["subj"],
    mailbox: ["folder", "mailboxId", "folderId", "box"],
    after: ["since", "from_date", "fromDate", "start", "startDate"],
    before: ["until", "to_date", "toDate", "end", "endDate"],
    limit: ["max", "count", "size", "maxResults"],
    timeoutMs: ["timeout_ms", "timeout"],
    unread: ["unseen"],
    read: ["seen", "opened"],
    flagged: ["starred", "important", "flag"],
    junk: ["spam"],
    include_preview: ["includePreview"],
  },
  // POST /messages (note: "text" is not a body alias, to avoid the search
  // conflict the global table had)
  compose: {
    body: ["content", "message"],
    subject: ["title", "subj"],
    in_reply_to: ["inReplyTo", "reply_to", "replyTo"],
    forward_of: ["forwardOf", "forward"],
  },
  // GET/POST /contacts, PATCH /contacts/:id. `query` is canonical here: `q`
  // previously became `text`, which searchContacts never read.
  contacts: {
    query: ["q", "search", "text"],
    addressbook: ["addressBook", "book", "bookId", "addressBookId"],
    firstName: ["first_name", "givenName", "given_name", "first"],
    lastName: ["last_name", "familyName", "family_name", "last", "surname"],
    displayName: ["display_name", "name", "fullName", "full_name"],
    email: ["emailAddress", "email_address", "mail"],
    limit: ["max", "count", "size", "maxResults"],
  },
  // Calendar events. Moved verbatim from normalizeCalendarParams in
  // calendar.js; Task 2.5 wires calendar.js onto this table.
  calendar: {
    calendar: ["calendarId", "calendar_id", "cal"],
    title: ["summary", "name", "eventName", "event_name"],
    start: ["startDate", "start_date", "startTime", "start_time", "from", "begin"],
    end: ["endDate", "end_date", "endTime", "end_time", "to", "until"],
    location: ["place", "where", "loc"],
    description: ["desc", "details", "notes", "body", "content"],
    organizer: ["host", "owner", "creator"],
    attendees: ["participants", "invitees", "guests", "people"],
    sendInvites: ["send_invites", "sendInvitations", "send_invitations", "notify"],
    allDay: ["all_day"]
  }
};

/**
 * Fuzzy match a string against a list of candidates
 * Returns the best match or null if no good match found
 */
function fuzzyMatch(input, candidates, threshold = 0.7) {
  if (!input || !candidates || candidates.length === 0) return null;
  
  const lower = input.toLowerCase();
  
  // Exact match first
  const exact = candidates.find(c => c.toLowerCase() === lower);
  if (exact) return exact;
  
  // Starts with
  const startsWith = candidates.find(c => c.toLowerCase().startsWith(lower));
  if (startsWith) return startsWith;
  
  // Contains
  const contains = candidates.find(c => c.toLowerCase().includes(lower));
  if (contains) return contains;
  
  // Levenshtein distance for typos (simple version)
  let bestMatch = null;
  let bestScore = 0;
  
  for (const candidate of candidates) {
    const candidateLower = candidate.toLowerCase();
    const maxLen = Math.max(lower.length, candidateLower.length);
    if (maxLen === 0) continue;
    
    // Simple similarity: count matching characters
    let matches = 0;
    for (let i = 0; i < Math.min(lower.length, candidateLower.length); i++) {
      if (lower[i] === candidateLower[i]) matches++;
    }
    const score = matches / maxLen;
    
    if (score > bestScore && score >= threshold) {
      bestScore = score;
      bestMatch = candidate;
    }
  }
  
  return bestMatch;
}

/**
 * Format JSON response
 */
function jsonResponse(data, statusCode = 200) {
  return {
    statusCode,
    body: JSON.stringify(data)
  };
}

/**
 * Format error response with helpful suggestions
 *
 * `extra` is merged into the JSON body last; used to carry machine-readable
 * error payloads such as the conflicting targets of `ambiguous_target`.
 */
function errorResponse(message, statusCode = 400, suggestions = null, code = null, extra = null) {
  const response = { error: message };
  if (suggestions) {
    response.suggestions = suggestions;
  }
  if (code) response.code = code;
  if (extra) Object.assign(response, extra);
  return {
    statusCode,
    body: JSON.stringify(response)
  };
}

/**
 * Format result as JSON or error response based on result.error.
 *
 * Error results may carry machine-readable extras (ambiguous_target's
 * `matches`, update_failed's per-message `results`/`not_found`); everything
 * except `statusCode` is merged into the body. `statusCode` stays internal
 * metadata. A non-error result may carry an internal `statusCode` too (e.g.
 * 207 for a partial update); it then drives the HTTP status without being
 * serialized into the body, exactly like the error path.
 */
function resultResponse(result, errorStatusCode = 400) {
  if (result.error) {
    const { error, code, statusCode, suggestions, ...extra } = result;
    return errorResponse(
      error,
      statusCode || errorStatusCode,
      suggestions,
      code,
      Object.keys(extra).length > 0 ? extra : null
    );
  }
  if (result.statusCode) {
    const { statusCode, ...body } = result;
    return jsonResponse(body, statusCode);
  }
  return jsonResponse(result);
}

/**
 * Build the standard error result shape shared by every domain module:
 * { error, code, statusCode, suggestions? }.
 *
 * `code` is stable and machine-readable, `error` is human-readable, and
 * `suggestions` is only present when a caller provides one. `statusCode` is
 * internal metadata: `resultResponse` (background) and `sendCalendarResponse`
 * (experiment) turn it into the HTTP status without serializing it.
 */
function fail(code, message, statusCode = 400, suggestions) {
  const result = { error: message, code, statusCode };
  if (suggestions) result.suggestions = suggestions;
  return result;
}

/**
 * Create a helpful "did you mean" suggestion
 */
function didYouMean(input, candidates) {
  const match = fuzzyMatch(input, candidates);
  if (match && match.toLowerCase() !== input.toLowerCase()) {
    return `Did you mean "${match}"?`;
  }
  return null;
}

/**
 * Resolve a user-supplied target against caller-supplied candidates (D4).
 *
 * Pure by construction: each domain loads its own candidates (folders.query,
 * identities.list, addressBooks.list, cal.manager) and passes them in, so the
 * same resolver runs in the background and calendar scopes without touching
 * messenger/cal globals.
 *
 * Candidates are `{ id, name, role?, account? }`:
 * - mailboxes: `role` is the folder's special-use role, `account` the account ID.
 * - identities: `name` is the identity's EMAIL address. Identity writes match
 *   the ID or the exact email only (D4), so mapping the email onto `name`
 *   reuses the exact-name rule and never matches the display name.
 *
 * Matching order (first hit wins):
 * 1. exact ID (string comparison, untrimmed: folder IDs may contain spaces)
 * 2. exact role, case-insensitive (mailboxes only)
 * 3. exact name, case-insensitive (exact email for identities)
 * 4. read mode only: fuzzy chain (prefix, contains, similarity) -> "fuzzy"
 * 5. nothing -> 404 `folder_not_found` for mailboxes, `not_found` for every
 *    other kind, with didYouMean + the caller's hints
 *
 * Several matches: read mode picks the first candidate (the caller reports
 * the choice, e.g. searchMessages's `resolved_mailbox`); write mode refuses
 * with 409 ambiguous_target carrying `matches: [{ id, name, account }]`.
 *
 * `hints` are optional extra suggestion strings supplied by the caller (e.g.
 * "Use GET /mailboxes to see all available folders") so this shared helper
 * does not need to know route names.
 *
 * Returns `{ id, name, matched_by: "id"|"role"|"name"|"fuzzy" }` or a
 * `Utils.fail` result (`invalid_target` 400, `folder_not_found` 404 for
 * mailboxes, `not_found` 404 otherwise, `ambiguous_target` 409).
 */
function resolveTarget(kind, input, { mode = "read", candidates = [], hints = [] } = {}) {
  const labels = { mailbox: "Mailbox", calendar: "Calendar", addressbook: "Address book", identity: "Identity" };
  const plurals = { mailbox: "mailboxes", calendar: "calendars", addressbook: "address books", identity: "identities" };
  const label = labels[kind] || "Target";
  const plural = plurals[kind] || "targets";

  const list = (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => candidate && candidate.id !== undefined && candidate.id !== null);
  const names = list.map(candidate => candidate.name).filter(name => typeof name === "string" && name);
  const roles = kind === "mailbox"
    ? [...new Set(list.map(candidate => candidate.role).filter(role => typeof role === "string" && role))]
    : [];

  if (typeof input !== "string" || !input.trim()) {
    return fail("invalid_target", `${label} must be a non-empty ID, name, or role`, 400);
  }

  const target = (candidate, matched_by) => ({ id: candidate.id, name: candidate.name, matched_by });

  const ambiguous = (matched, matchedBy) => {
    const matches = matched.map(candidate => ({ id: candidate.id, name: candidate.name, account: candidate.account ?? null }));
    const described = matches.map(m => m.account ? `${m.name} (${m.id}, account ${m.account})` : `${m.name} (${m.id})`);
    const result = fail(
      "ambiguous_target",
      `Multiple ${plural} match "${input}"; specify one by ID`,
      409,
      [`Exact ${matchedBy} matches: ${described.join(", ")}`, ...hints].filter(Boolean)
    );
    result.matches = matches;
    return result;
  };

  // One hit -> that target. Several hits -> first in read mode, 409 in write mode.
  const settle = (matched, matchedBy) => {
    if (matched.length === 0) return null;
    if (matched.length > 1 && mode === "write") return ambiguous(matched, matchedBy);
    return target(matched[0], matchedBy);
  };

  // 1. Exact ID. Compared untrimmed so folder IDs keep their exact spelling.
  const byId = settle(list.filter(candidate => String(candidate.id) === input), "id");
  if (byId) return byId;

  const needle = input.trim().toLowerCase();

  // 2. Exact role (mailboxes only).
  const byRole = settle(
    list.filter(candidate => typeof candidate.role === "string" && candidate.role.toLowerCase() === needle),
    "role"
  );
  if (byRole) return byRole;

  // 3. Exact name (the exact email for identities).
  const byName = settle(
    list.filter(candidate => typeof candidate.name === "string" && candidate.name.toLowerCase() === needle),
    "name"
  );
  if (byName) return byName;

  // 4. Fuzzy chain, read mode only: a typo must never choose a write target.
  if (mode !== "write") {
    const roleMatch = roles.length > 0 ? fuzzyMatch(needle, roles) : null;
    if (roleMatch) {
      const candidate = list.find(item => item.role === roleMatch);
      if (candidate) return target(candidate, "fuzzy");
    }
    const nameMatch = fuzzyMatch(needle, names);
    if (nameMatch) {
      const candidate = list.find(item => item.name === nameMatch);
      if (candidate) return target(candidate, "fuzzy");
    }
  }

  // 5. Nothing matched. Keep didYouMean, then list what is available.
  // Mailbox misses keep the historical `folder_not_found` code (documented in
  // Task 2.3 and declared stable by the README); all other kinds report the
  // shared `not_found`.
  return fail(
    kind === "mailbox" ? "folder_not_found" : "not_found",
    `${label} not found: "${input}"`,
    404,
    [
      didYouMean(input.trim(), [...roles, ...names]),
      `Available ${plural}: ${names.join(", ") || "none"}`,
      ...hints
    ].filter(Boolean)
  );
}

// Export for use in background script
var Utils = {
  parseQueryString,
  RequestError,
  parseRequestParams,
  parseDate,
  DATE_SUGGESTIONS,
  normalizeParams,
  ALIASES,
  fuzzyMatch,
  resolveTarget,
  jsonResponse,
  errorResponse,
  fail,
  resultResponse,
  didYouMean
};
