/* exported calendar */
"use strict";

// =============================================================================
// Helpers shared with the background scope (utils.js is loaded first; see
// experiment/api.js)
// =============================================================================

/**
 * Format date in local timezone as ISO-like string (YYYY-MM-DDTHH:MM:SS)
 * Unlike toISOString() which returns UTC, this returns local time
 */
function formatLocalDate(date) {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  
  const pad = (n) => String(n).padStart(2, '0');
  
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Format a CalDateTime for the API (Task 5.1).
 *
 * `nativeTime` is a UTC instant only for zone-attached date-times: floating
 * and all-day values are read as UTC (`Ical.sys.mjs`'s utcOffset() returns 0),
 * so `new Date(nativeTime / 1000)` interpreted them in the host timezone and
 * shifted them by the host's UTC offset. Read the CalDateTime's own
 * wall-clock fields instead:
 * - all-day (`isDate`) dates are reported as `YYYY-MM-DD`; their `end` is the
 *   EXCLUSIVE end date, as in iCalendar
 * - floating values are reported as stored
 * - zone-attached values are converted to the calendar's default timezone so
 *   `start`/`end` can be interpreted
 *
 * `cal` is passed explicitly: calendar.js runs in the calendar scope where
 * `cal` is a per-request argument, not a global.
 */
function formatCalDateTime(dt, cal) {
  if (!dt) return null;
  const pad = (n) => String(n).padStart(2, '0');
  if (dt.isDate) {
    // CalDateTime.month is 0-based.
    return `${dt.year}-${pad(dt.month + 1)}-${pad(dt.day)}`;
  }
  const local = dt.timezone.isFloating ? dt : dt.getInTimezone(cal.dtz.defaultTimezone);
  return `${local.year}-${pad(local.month + 1)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}`;
}

/**
 * Build a CalDateTime at an exact UTC instant, attached to the calendar's
 * default timezone, so created/updated events are stored in the user's zone
 * (as the Thunderbird UI does) instead of UTC (Task 5.1).
 */
function toCalDateTime(jsDate, cal) {
  return cal.dtz.jsDateToDateTime(jsDate).getInTimezone(cal.dtz.defaultTimezone);
}

/**
 * Exact `recurrenceId` for an occurrence (Task 5.3): all-day occurrences are
 * `YYYY-MM-DD`; timed occurrences are the UTC instant
 * (`2026-10-14T07:00:00Z`). The old local, second-truncated string could not
 * be matched back to a CalRecurrenceInfo rid.
 */
function formatRecurrenceId(rid) {
  if (!rid) return null;
  if (rid.isDate) return formatCalDateTime(rid);
  if (!Number.isFinite(rid.nativeTime)) return null;
  // nativeTime is µs; `Date.parse` reads the value back exactly.
  return new Date(rid.nativeTime / 1000).toISOString().replace(/\.000Z$/, "Z");
}

/**
 * Normalize a date-only value to `YYYY-MM-DD`, or return null. Relative
 * inputs ("tomorrow") and datetimes are refused: an all-day event has no time
 * of day to fall back to.
 */
function parseDateOnly(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  if (!Utils.parseDate(raw)) return null;
  return raw;
}

/**
 * Shift a `YYYY-MM-DD` date by whole days without going through the host
 * timezone. Returns null when the result leaves the four-digit-year range.
 */
function shiftDateOnly(dateOnly, days) {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(shifted) ? shifted : null;
}

/** Build an all-day (`isDate`) CalDateTime from a `YYYY-MM-DD` date. */
function dateOnlyCalDateTime(dateOnly, cal) {
  return cal.createDateTime(dateOnly.replace(/-/g, ""));
}

/**
 * Strictly parse a boolean parameter (decision D5): a supplied value that is
 * neither a boolean nor 0/1/"true"/"false"/"0"/"1" is invalid.
 */
function parseStrictBoolean(value) {
  if (value === true || value === 1 || value === "true" || value === "1") return true;
  if (value === false || value === 0 || value === "false" || value === "0") return false;
  return undefined;
}

/**
 * Parse the `allDay` parameter. Returns `{ allDay }` (undefined when absent)
 * or `{ error }` for a supplied value that is not a boolean.
 */
function parseAllDay(value) {
  if (value === undefined) return { allDay: undefined };
  const parsed = parseStrictBoolean(value);
  if (parsed === undefined) {
    return { error: Utils.fail("invalid_filter", "allDay must be true, false, 1 or 0", 400, [
      "Use allDay=true for a date-only event, or omit it"
    ]) };
  }
  return { allDay: parsed };
}

/**
 * Resolve a `recurrenceId` against a recurring parent item (Task 5.3).
 *
 * `getOccurrenceFor` is deliberately not used: it returns a proxy for ANY
 * rid, even one that does not exist, so existence is checked instead -- first
 * against modified occurrences (exceptions may have been moved outside any
 * date window), then against regular occurrences in a ±1 day window.
 *
 * `ridInput` is the API's recurrence id, exactly as `itemToEvent` returns it:
 * `YYYY-MM-DD` for all-day series, the UTC instant
 * (`2026-10-14T07:00:00Z`) for timed ones. Returns the matching item or null.
 */
function resolveOccurrence(parent, ridInput, cal) {
  const info = parent.recurrenceInfo;
  if (!info || typeof ridInput !== "string") return null;

  const dateOnly = parseDateOnly(ridInput);
  if (!dateOnly && Number.isNaN(Date.parse(ridInput))) return null;

  const matches = rid => dateOnly
    ? rid.isDate && formatCalDateTime(rid) === dateOnly
    : !rid.isDate && rid.nativeTime === Date.parse(ridInput) * 1000;

  // 1) Modified occurrences (exceptions) first: a moved occurrence sits
  //    outside the window around its original recurrence id.
  const exceptionIds = info.getExceptionIds ? info.getExceptionIds() : [];
  for (const rid of exceptionIds) {
    if (!matches(rid)) continue;
    const exception = info.getExceptionFor(rid);
    if (exception) return exception;
  }

  // 2) Regular occurrences in a ±1 day window around the requested rid.
  const center = dateOnly ? Utils.parseDate(dateOnly) : new Date(ridInput);
  const from = toCalDateTime(new Date(center.getTime() - 86400000), cal);
  const to = toCalDateTime(new Date(center.getTime() + 86400000), cal);
  const occurrences = info.getOccurrences(from, to, 0) || [];
  return occurrences.find(occurrence => matches(occurrence.recurrenceId)) || null;
}

/**
 * Validate the `recurrenceId` / `scope` targeting parameters shared by PATCH
 * and DELETE (Task 5.3). Returns `{ mode: "occurrence"|"series"|null,
 * recurrenceId }` or `{ error }`; `mode: null` means neither target was
 * supplied and the caller decides (non-recurring events proceed, recurring
 * ones answer 409 ambiguous_recurrence).
 */
function parseRecurrenceTarget(recurrenceId, scope) {
  if (scope !== undefined && scope !== null && scope !== "series") {
    return { error: Utils.fail("invalid_parameter", `Invalid scope: "${scope}"`, 400, [
      'scope must be "series" to target the whole recurring series',
      "Use recurrenceId to target a single occurrence"
    ]) };
  }
  if (recurrenceId !== undefined && recurrenceId !== null) {
    if (typeof recurrenceId !== "string") {
      return { error: Utils.fail("invalid_parameter", "recurrenceId must be a string", 400, [
        "Use the exact recurrenceId value returned by GET /events",
        'Timed occurrences use a UTC instant like "2026-10-14T07:00:00Z"; all-day ones use "2026-10-14"'
      ]) };
    }
    const rid = recurrenceId.trim();
    if (!rid) {
      return { error: Utils.fail("invalid_parameter", "recurrenceId must not be empty", 400, [
        "Use the exact recurrenceId value returned by GET /events"
      ]) };
    }
    if (scope === "series") {
      return { error: Utils.fail("invalid_parameter", "recurrenceId and scope=series are mutually exclusive", 400, [
        "Use recurrenceId to target one occurrence, or scope=series to target the whole series"
      ]) };
    }
    return { mode: "occurrence", recurrenceId: rid };
  }
  return { mode: scope === "series" ? "series" : null };
}

/**
 * Apply PATCH start/end/allDay to `target` (already a clone of `oldItem`).
 *
 * Carry-over from the 5.1 review: an update must not leave a date-only end
 * beside a timed start (or the other way round). `allDay` -- or the item's
 * existing type when it is absent -- selects the representation for BOTH
 * values: each supplied value is parsed in that representation and each
 * untouched value is converted from its old type. An all-day start supplied
 * without an end covers exactly one day, as in create. When the update leaves
 * a known start/end pair, `end <= start` is rejected in the spirit of 5.2.
 *
 * Returns a `Utils.fail` result on validation failure, else null.
 */
function applyDateFields(target, oldItem, { start, end, allDay }, cal) {
  const wantsAllDay = allDay !== undefined
    ? allDay === true
    : !!(oldItem.startDate && oldItem.startDate.isDate);

  const convert = dt => {
    if (!dt) return null;
    if (!!dt.isDate === wantsAllDay) return dt.clone();
    if (wantsAllDay) {
      // Timed -> all-day: the calendar date in the default zone.
      return dateOnlyCalDateTime(formatCalDateTime(dt, cal).slice(0, 10), cal);
    }
    // All-day -> timed: reuse the date-only convention (local midnight).
    const parsed = Utils.parseDate(formatCalDateTime(dt, cal));
    return parsed ? toCalDateTime(parsed, cal) : null;
  };

  let newStart = convert(oldItem.startDate);
  let newEnd = convert(oldItem.endDate);

  if (start !== undefined) {
    if (wantsAllDay) {
      const startDateOnly = parseDateOnly(start);
      if (!startDateOnly) {
        return Utils.fail("invalid_date", `Could not parse date: "${start}"`, 400, Utils.DATE_SUGGESTIONS);
      }
      newStart = dateOnlyCalDateTime(startDateOnly, cal);
    } else {
      const startDate = Utils.parseDate(start);
      if (!startDate) {
        return Utils.fail("invalid_date", `Could not parse date: "${start}"`, 400, Utils.DATE_SUGGESTIONS);
      }
      newStart = toCalDateTime(startDate, cal);
    }
  }

  if (end !== undefined) {
    if (wantsAllDay) {
      const endDateOnly = parseDateOnly(end);
      if (!endDateOnly) {
        return Utils.fail("invalid_date", `Could not parse date: "${end}"`, 400, Utils.DATE_SUGGESTIONS);
      }
      newEnd = dateOnlyCalDateTime(endDateOnly, cal);
    } else {
      const endDate = Utils.parseDate(end);
      if (!endDate) {
        return Utils.fail("invalid_date", `Could not parse date: "${end}"`, 400, Utils.DATE_SUGGESTIONS);
      }
      newEnd = toCalDateTime(endDate, cal);
    }
  }

  // Moving an all-day start without an end covers exactly one day (the
  // create convention, kept as-is by the 5.1 update behavior).
  if (wantsAllDay && start !== undefined && end === undefined && newStart) {
    const nextDay = shiftDateOnly(formatCalDateTime(newStart, cal), 1);
    if (!nextDay) {
      return Utils.fail("invalid_date", `Could not parse date: "${start}"`, 400, Utils.DATE_SUGGESTIONS);
    }
    newEnd = dateOnlyCalDateTime(nextDay, cal);
  }

  // A type conversion of a same-day timed event to all-day would otherwise
  // collapse to a zero-length day; cover one day instead.
  if (wantsAllDay && start === undefined && end === undefined &&
      newStart && newEnd && newEnd.nativeTime <= newStart.nativeTime) {
    const nextDay = shiftDateOnly(formatCalDateTime(newStart, cal), 1);
    if (nextDay) newEnd = dateOnlyCalDateTime(nextDay, cal);
  }

  if (newStart && newEnd && newEnd.nativeTime <= newStart.nativeTime) {
    return Utils.fail("invalid_date", "End date must be after start date", 400, [
      `Start: ${formatCalDateTime(newStart, cal)}`,
      `End: ${formatCalDateTime(newEnd, cal)}`
    ]);
  }

  target.startDate = newStart;
  target.endDate = newEnd;
  return null;
}

/**
 * Format date as iCalendar datetime (YYYYMMDDTHHMMSSZ)
 */
function formatIcsDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Escape text for iCalendar format
 */
function escapeIcsText(text) {
  if (!text) return "";
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * Generate iCalendar (ICS) content for an event invitation
 * @param {Object} eventData - Event details
 * @param {string} method - iTIP method (REQUEST, CANCEL, etc.)
 * @returns {string} ICS content
 */
function generateIcsInvitation(eventData, method = "REQUEST") {
  const { id, title, start, end, location, description, organizer, attendees } = eventData;
  
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Thunderbird REST API//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${id}@thunderbird-api`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    `DTSTART:${formatIcsDate(new Date(start))}`,
    `DTEND:${formatIcsDate(new Date(end))}`,
    `SUMMARY:${escapeIcsText(title)}`,
    "SEQUENCE:0",
    "STATUS:CONFIRMED"
  ];
  
  if (location) {
    lines.push(`LOCATION:${escapeIcsText(location)}`);
  }
  
  if (description) {
    lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  }
  
  // Add organizer
  if (organizer) {
    const orgEmail = typeof organizer === "string" ? organizer : organizer.email;
    const orgName = typeof organizer === "string" ? null : organizer.name;
    if (orgName) {
      lines.push(`ORGANIZER;CN=${escapeIcsText(orgName)}:mailto:${orgEmail}`);
    } else {
      lines.push(`ORGANIZER:mailto:${orgEmail}`);
    }
  }
  
  // Add attendees
  if (attendees && Array.isArray(attendees)) {
    for (const att of attendees) {
      const attEmail = typeof att === "string" ? att : att.email;
      const attName = typeof att === "string" ? null : att.name;
      const attRole = typeof att === "string" ? "REQ-PARTICIPANT" : (att.role || "REQ-PARTICIPANT");
      const attStatus = typeof att === "string" ? "NEEDS-ACTION" : (att.status || "NEEDS-ACTION");
      
      let attendeeLine = "ATTENDEE";
      attendeeLine += `;ROLE=${attRole}`;
      attendeeLine += `;PARTSTAT=${attStatus}`;
      attendeeLine += ";RSVP=TRUE";
      if (attName) {
        attendeeLine += `;CN=${escapeIcsText(attName)}`;
      }
      attendeeLine += `:mailto:${attEmail}`;
      lines.push(attendeeLine);
    }
  }
  
  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");
  
  return lines.join("\r\n");
}

// =============================================================================
// Calendar API functions
// =============================================================================

/**
 * List all calendars
 */
function listCalendars(cal) {
  if (!cal) {
    return Utils.fail("calendar_unavailable", "Calendar not available", 503, [
      "Ensure Thunderbird's calendar component is enabled"
    ]);
  }

  try {
    const calendars = cal.manager.getCalendars().map(c => ({
      id: c.id,
      name: c.name,
      type: c.type,
      color: c.getProperty("color") || null,
      readOnly: c.readOnly,
    }));
    return { calendars };
  } catch (e) {
    return Utils.fail("list_failed", `Failed to list calendars: ${e.message}`, 500);
  }
}

/**
 * Find a calendar by ID or name through the shared resolver (Task 3.3).
 *
 * `mode: "read"` (listing) keeps fuzzy matching; `mode: "write"`
 * (create/update/delete) requires an exact ID or name and answers ambiguous
 * references with 409 ambiguous_target.
 *
 * Returns `{ calendar }` on success or `{ error }` (a Utils.fail result) on
 * failure. The error result is returned unchanged so fields such as
 * `matches` survive into the HTTP response.
 */
function findCalendar(calendarId, cal, mode = "read") {
  if (!cal) {
    return { error: Utils.fail("calendar_unavailable", "Calendar not available", 503, [
      "Ensure Thunderbird's calendar component is enabled"
    ]) };
  }

  const calendars = cal.manager.getCalendars();
  const resolved = Utils.resolveTarget("calendar", calendarId, {
    mode,
    candidates: calendars.map(calendar => ({ id: calendar.id, name: calendar.name })),
    hints: ["Use GET /calendars to see all available calendars with their IDs"]
  });
  if (resolved.error) return { error: resolved };

  const calendar = calendars.find(candidate => candidate.id === resolved.id);
  return { calendar };
}

/**
 * Convert attendee object to API format
 */
function attendeeToObject(attendee) {
  return {
    email: (attendee.id || "").replace(/^mailto:/i, ""),
    name: attendee.commonName || null,
    role: attendee.role || "REQ-PARTICIPANT",
    status: attendee.participationStatus || "NEEDS-ACTION",
    type: attendee.userType || "INDIVIDUAL",
    rsvp: attendee.rsvp === "TRUE"
  };
}

/**
 * Convert calendar item to event object
 */
function itemToEvent(item, calendarId, cal) {
  // Get organizer
  let organizer = null;
  if (item.organizer) {
    organizer = {
      email: (item.organizer.id || "").replace(/^mailto:/i, ""),
      name: item.organizer.commonName || null
    };
  }

  // Get attendees
  let attendees = null;
  try {
    const attendeeList = item.getAttendees ? item.getAttendees() : [];
    if (attendeeList && attendeeList.length > 0) {
      attendees = attendeeList.map(attendeeToObject);
    }
  } catch (e) {
    // Ignore errors getting attendees
  }

  // For recurring occurrences, include the exact recurrence id (Task 5.3).
  // `id` is already the series id (parentId always equalled it, so it is
  // gone); `occurrence` marks the item as one occurrence of that series.
  let recurrenceId = null;
  if (item.recurrenceId) {
    recurrenceId = formatRecurrenceId(item.recurrenceId);
  }

  const event = {
    id: item.id,
    calendar: calendarId,
    title: item.title,
    start: formatCalDateTime(item.startDate, cal),
    // For all-day events this is the EXCLUSIVE end date (iCalendar semantics).
    end: formatCalDateTime(item.endDate, cal),
    allDay: item.startDate ? !!item.startDate.isDate : false,
    timezone: cal.dtz.defaultTimezone.tzid,
    location: item.getProperty("LOCATION") || null,
    description: item.getProperty("DESCRIPTION") || null,
    organizer,
    attendees
  };

  if (recurrenceId !== null) {
    event.recurrenceId = recurrenceId;
    event.occurrence = true;
  }

  return event;
}

/**
 * List events with optional filters
 * Accepts flexible date formats: "today", "tomorrow", "next week", "2024-01-15", etc.
 */
async function listEvents(params, cal, Ci) {
  if (!cal) {
    return Utils.fail("calendar_unavailable", "Calendar not available", 503, [
      "Ensure Thunderbird's calendar component is enabled"
    ]);
  }

  // Normalize parameter names
  const normalized = Utils.normalizeParams(params, Utils.ALIASES.calendar);
  const { calendar: calendarId, start, end } = normalized;

  // Parse and validate the range before defaulting anything: an unparseable
  // `start` used to reach `new Date(startDate.getTime() + ...)` with
  // startDate === null and raised an unhandled TypeError (500) instead of a
  // 400 (Task 5.2).
  const startDate = start ? Utils.parseDate(start) : new Date();
  if (start && !startDate) {
    return Utils.fail("invalid_date", `Could not parse date: "${start}"`, 400, Utils.DATE_SUGGESTIONS);
  }

  const endDate = end ? Utils.parseDate(end) : new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000); // Default 30 days
  if (end && !endDate) {
    return Utils.fail("invalid_date", `Could not parse date: "${end}"`, 400, Utils.DATE_SUGGESTIONS);
  }
  if (endDate <= startDate) {
    return Utils.fail("invalid_date", "End date must be after start date", 400, [
      `Start: ${startDate.toISOString()}, End: ${endDate.toISOString()}`
    ]);
  }

  const rangeStart = toCalDateTime(startDate, cal);
  const rangeEnd = toCalDateTime(endDate, cal);

  const results = [];

  // Get calendars to search. Listing is a read: fuzzy names are allowed.
  let calendars;
  if (calendarId) {
    const found = findCalendar(calendarId, cal);
    if (found.error) return found.error;
    calendars = [found.calendar];
  } else {
    calendars = cal.manager.getCalendars();
  }

  for (const calendar of calendars) {
    try {
      const items = await calendar.getItemsAsArray(
        Ci.calICalendar.ITEM_FILTER_TYPE_EVENT | Ci.calICalendar.ITEM_FILTER_CLASS_OCCURRENCES,
        0,
        rangeStart,
        rangeEnd
      );

      for (const item of items) {
        results.push(itemToEvent(item, calendar.name, cal));
      }
    } catch (e) {
      // Skip calendars that fail
    }
  }

  // Sort by start date
  results.sort((a, b) => new Date(a.start) - new Date(b.start));

  // Include helpful hints when no results
  const response = { events: results };
  if (results.length === 0) {
    response.hints = [
      `No events found between ${startDate.toISOString().split('T')[0]} and ${endDate.toISOString().split('T')[0]}`,
      "Try expanding the date range or checking a different calendar"
    ];
  }

  return response;
}

/**
 * List upcoming events from now until end of today
 */
async function upcomingEvents(params, cal, Ci) {
  if (!cal) {
    return Utils.fail("calendar_unavailable", "Calendar not available", 503, [
      "Ensure Thunderbird's calendar component is enabled"
    ]);
  }

  const normalized = Utils.normalizeParams(params, Utils.ALIASES.calendar);
  const { calendar: calendarId } = normalized;

  const now = new Date();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const rangeStart = toCalDateTime(now, cal);
  const rangeEnd = toCalDateTime(endOfDay, cal);

  // Listing upcoming events is a read, so fuzzy calendar names are allowed.
  let calendars;
  if (calendarId) {
    const found = findCalendar(calendarId, cal);
    if (found.error) return found.error;
    calendars = [found.calendar];
  } else {
    calendars = cal.manager.getCalendars();
  }

  const results = [];

  for (const calendar of calendars) {
    try {
      const items = await calendar.getItemsAsArray(
        Ci.calICalendar.ITEM_FILTER_TYPE_EVENT | Ci.calICalendar.ITEM_FILTER_CLASS_OCCURRENCES,
        0,
        rangeStart,
        rangeEnd
      );
      for (const item of items) {
        results.push(itemToEvent(item, calendar.name, cal));
      }
    } catch (e) {
      // Skip calendars that fail
    }
  }

  // Sort by start date
  results.sort((a, b) => new Date(a.start) - new Date(b.start));

  const response = {
    events: results,
    from: formatLocalDate(now),
    until: formatLocalDate(endOfDay)
  };

  if (results.length === 0) {
    response.hints = ["No more events scheduled for today"];
  }

  return response;
}

/**
 * Create a new event
 * Accepts flexible date formats and auto-selects calendar if only one writable exists
 */
async function createEvent(params, cal, Ci, Cc) {
  if (!cal) {
    return Utils.fail("calendar_unavailable", "Calendar not available", 503, [
      "Ensure Thunderbird's calendar component is enabled"
    ]);
  }

  // Normalize parameter names
  const normalized = Utils.normalizeParams(params, Utils.ALIASES.calendar);
  let { calendar: calendarId, title, start, end, location, description, organizer, attendees, sendInvites } = normalized;
  // Parse sendInvites strictly: an unrecognized supplied value must not
  // silently behave like false and skip the invitations. Absent stays false.
  if (sendInvites === undefined) {
    sendInvites = false;
  } else if (sendInvites === true || sendInvites === "true" || sendInvites === 1 || sendInvites === "1") {
    sendInvites = true;
  } else if (sendInvites === false || sendInvites === "false" || sendInvites === 0 || sendInvites === "0") {
    sendInvites = false;
  } else {
    return Utils.fail("invalid_filter", "sendInvites must be true, false, 1 or 0", 400, [
      "Use sendInvites=true to send invitations, or omit it"
    ]);
  }

  // allDay is a boolean filter too (D5): an unrecognized supplied value must
  // not silently behave like false (a timed event at midnight). Absent = false.
  const allDayParam = parseAllDay(normalized.allDay);
  if (allDayParam.error) return allDayParam.error;
  const allDay = allDayParam.allDay === true;

  // Validate required fields with helpful errors
  if (!title) {
    return Utils.fail("invalid_parameter", "title is required", 400, [
      "Provide a title/summary for the event"
    ]);
  }
  if (!start) {
    return Utils.fail("invalid_parameter", "start date/time is required", 400, allDay ? [
      "Use a date-only start: 2024-01-15"
    ] : [
      "Use ISO format: 2024-01-15T10:00:00",
      "Or relative: tomorrow, next monday"
    ]);
  }
  // An all-day event defaults to exactly one day, so `end` is optional.
  if (!end && !allDay) {
    return Utils.fail("invalid_parameter", "end date/time is required", 400, [
      "Use ISO format: 2024-01-15T11:00:00",
      "Or relative: tomorrow"
    ]);
  }

  // Auto-select calendar if not specified
  const allCalendars = cal.manager.getCalendars();
  const writableCalendars = allCalendars.filter(c => !c.readOnly);
  
  if (!calendarId) {
    if (writableCalendars.length === 1) {
      calendarId = writableCalendars[0].id;
    } else if (writableCalendars.length === 0) {
      return Utils.fail("read_only", "No writable calendars available", 403, [
        "Create a local calendar in Thunderbird first"
      ]);
    } else {
      return Utils.fail("ambiguous_target", "calendar is required when multiple writable calendars exist", 409, [
        `Available writable calendars: ${writableCalendars.map(c => c.name).join(", ")}`,
        "Use GET /calendars to see calendar IDs"
      ]);
    }
  }

  // Creating an event is a write: the calendar must resolve exactly.
  const found = findCalendar(calendarId, cal, "write");
  if (found.error) return found.error;
  if (found.calendar.readOnly) {
    return Utils.fail("read_only", `Calendar "${found.calendar.name}" is read-only`, 403, [
      `Writable calendars: ${writableCalendars.map(c => c.name).join(", ") || "none"}`
    ]);
  }

  // Parse dates with flexible parsing. All-day events take date-only values
  // (YYYY-MM-DD) and are built as isDate CalDateTimes; their `end` is the
  // exclusive end date, as in iCalendar, and defaults to start + 1 day.
  let startDateTime;
  let endDateTime;

  if (allDay) {
    const startDateOnly = parseDateOnly(start);
    if (!startDateOnly) {
      return Utils.fail("invalid_date", `Could not parse date: "${start}"`, 400, Utils.DATE_SUGGESTIONS);
    }
    const endDateOnly = end ? parseDateOnly(end) : shiftDateOnly(startDateOnly, 1);
    if (!endDateOnly) {
      return Utils.fail("invalid_date", `Could not parse date: "${end}"`, 400, Utils.DATE_SUGGESTIONS);
    }
    if (endDateOnly <= startDateOnly) {
      return Utils.fail("invalid_date", "End date must be after start date", 400, [
        `Start: ${startDateOnly}, End (exclusive): ${endDateOnly}`
      ]);
    }
    startDateTime = dateOnlyCalDateTime(startDateOnly, cal);
    endDateTime = dateOnlyCalDateTime(endDateOnly, cal);
  } else {
    const startDate = Utils.parseDate(start);
    const endDate = Utils.parseDate(end);

    if (!startDate) {
      return Utils.fail("invalid_date", `Could not parse date: "${start}"`, 400, Utils.DATE_SUGGESTIONS);
    }
    if (!endDate) {
      return Utils.fail("invalid_date", `Could not parse date: "${end}"`, 400, Utils.DATE_SUGGESTIONS);
    }

    // Validate end is after start
    if (endDate <= startDate) {
      return Utils.fail("invalid_date", "End date must be after start date", 400, [
        `Start: ${startDate.toISOString()}, End: ${endDate.toISOString()}`
      ]);
    }

    startDateTime = toCalDateTime(startDate, cal);
    endDateTime = toCalDateTime(endDate, cal);
  }

  try {
    // Use XPCOM to create event
    const event = Cc["@mozilla.org/calendar/event;1"].createInstance(Ci.calIEvent);
    event.id = cal.getUUID();
    event.title = title;

    event.startDate = startDateTime;
    event.endDate = endDateTime;

    if (location) event.setProperty("LOCATION", location);
    if (description) event.setProperty("DESCRIPTION", description);

    // Add organizer if provided
    if (organizer) {
      const org = Cc["@mozilla.org/calendar/attendee;1"].createInstance(Ci.calIAttendee);
      const orgEmail = typeof organizer === "string" ? organizer : organizer.email;
      const orgName = typeof organizer === "string" ? null : (organizer.name || null);
      
      if (!orgEmail) {
        return Utils.fail("invalid_parameter", "Organizer email is required", 400, [
          'Provide organizer as string "email@example.com" or object {"email": "...", "name": "..."}'
        ]);
      }
      
      org.id = "mailto:" + orgEmail;
      if (orgName) org.commonName = orgName;
      org.isOrganizer = true;
      org.role = "CHAIR";
      event.organizer = org;
    }

    // Add attendees if provided
    if (attendees) {
      if (!Array.isArray(attendees)) {
        return Utils.fail("invalid_parameter", "Attendees must be an array", 400, [
          'Provide attendees as array: [{"email": "...", "name": "..."}, ...]',
          'Or simplified: ["email1@example.com", "email2@example.com"]'
        ]);
      }

      for (const att of attendees) {
        const attendee = Cc["@mozilla.org/calendar/attendee;1"].createInstance(Ci.calIAttendee);
        
        // Support both string (just email) and object format
        const attEmail = typeof att === "string" ? att : att.email;
        const attName = typeof att === "string" ? null : (att.name || null);
        const attRole = typeof att === "string" ? "REQ-PARTICIPANT" : (att.role || "REQ-PARTICIPANT");
        const attStatus = typeof att === "string" ? "NEEDS-ACTION" : (att.status || "NEEDS-ACTION");
        const attRsvp = typeof att === "string" ? true : (att.rsvp !== false);
        
        if (!attEmail) {
          return Utils.fail("invalid_parameter", "Each attendee must have an email address", 400, [
            'Provide attendee as string "email@example.com" or object {"email": "...", "name": "..."}'
          ]);
        }
        
        attendee.id = "mailto:" + attEmail;
        if (attName) attendee.commonName = attName;
        attendee.role = attRole;
        attendee.participationStatus = attStatus;
        attendee.userType = "INDIVIDUAL";
        attendee.rsvp = attRsvp ? "TRUE" : "FALSE";
        
        event.addAttendee(attendee);
      }
    }

    await found.calendar.addItem(event);

    // Build response
    const response = {
      success: true,
      message: "Event created",
      id: event.id,
      calendar: found.calendar.name,
      title: title,
      // Report the stored values the same way GET /events does.
      start: formatCalDateTime(event.startDate, cal),
      end: formatCalDateTime(event.endDate, cal),
      allDay
    };

    if (organizer) {
      response.organizer = typeof organizer === "string" 
        ? { email: organizer } 
        : { email: organizer.email, name: organizer.name || null };
    }

    if (attendees && attendees.length > 0) {
      response.attendees = attendees.map(att => {
        if (typeof att === "string") {
          return { email: att, status: "NEEDS-ACTION" };
        }
        return { 
          email: att.email, 
          name: att.name || null,
          status: att.status || "NEEDS-ACTION"
        };
      });
      
      // If sendInvites is requested, include invitation data for the background script to send
      if (sendInvites) {
        if (!organizer) {
          response.warning = "sendInvites requested but no organizer specified. Invitations not sent.";
        } else {
          // Generate ICS content for the invitation (invitation formatting for
          // all-day events is Task 5.4's scope; here the stored instant is kept)
          const eventData = {
            id: event.id,
            title,
            start: cal.dtz.dateTimeToJSDate(event.startDate).toISOString(),
            end: cal.dtz.dateTimeToJSDate(event.endDate).toISOString(),
            location,
            description,
            organizer,
            attendees
          };
          
          response._invitationData = {
            icsContent: generateIcsInvitation(eventData, "REQUEST"),
            recipients: attendees.map(att => typeof att === "string" ? att : att.email),
            subject: `Invitation: ${title}`,
            organizerEmail: typeof organizer === "string" ? organizer : organizer.email
          };
          response.invitesPending = true;
        }
      } else {
        response.note = "Invitation emails are NOT automatically sent. Use sendInvites:true to send invitations.";
      }
    }

    return response;
  } catch (e) {
    return Utils.fail("create_failed", `Failed to create event: ${e.message}`, 500);
  }
}

/**
 * Update an existing event
 * Accepts flexible date formats and helpful error messages
 */
async function updateEvent(eventId, params, cal, Ci, Cc) {
  if (!cal) {
    return Utils.fail("calendar_unavailable", "Calendar not available", 503, [
      "Ensure Thunderbird's calendar component is enabled"
    ]);
  }

  // Normalize parameter names
  const normalized = Utils.normalizeParams(params, Utils.ALIASES.calendar);
  const { calendar: calendarId, title, start, end, location, description, organizer, attendees } = normalized;

  // recurrenceId / scope select one occurrence or the whole series (Task 5.3).
  const recurrenceTarget = parseRecurrenceTarget(normalized.recurrenceId, normalized.scope);
  if (recurrenceTarget.error) return recurrenceTarget.error;

  // allDay is strict per D5; absent leaves the stored value untouched.
  const allDayParam = parseAllDay(normalized.allDay);
  if (allDayParam.error) return allDayParam.error;

  if (!calendarId) {
    // Try to help by listing calendars
    const calendars = cal.manager.getCalendars();
    return Utils.fail(
      "invalid_parameter",
      "calendar parameter is required to identify which calendar contains the event",
      400,
      [
        `Available calendars: ${calendars.map(c => c.name).join(", ") || "none"}`,
        "Use GET /calendars to see calendar IDs"
      ]
    );
  }

  // Updating an event is a write: the calendar must resolve exactly.
  const found = findCalendar(calendarId, cal, "write");
  if (found.error) return found.error;
  if (found.calendar.readOnly) {
    const writableCalendars = cal.manager.getCalendars().filter(c => !c.readOnly);
    return Utils.fail("read_only", `Calendar "${found.calendar.name}" is read-only`, 403, [
      `Writable calendars: ${writableCalendars.map(c => c.name).join(", ") || "none"}`
    ]);
  }

  try {
    const event = await found.calendar.getItem(eventId);
    if (!event) {
      return Utils.fail("not_found", `Event not found: "${eventId}"`, 404, [
        `Event ID was not found in calendar "${found.calendar.name}"`,
        "Use GET /events to list events and get valid event IDs"
      ]);
    }

    // Occurrence vs series targeting (Task 5.3). A non-recurring event keeps
    // its old behavior, even when scope=series is supplied.
    let oldEvent = event;
    let updatedScope = null;
    if (recurrenceTarget.mode === "occurrence") {
      if (!event.recurrenceInfo) {
        return Utils.fail("not_recurring", `Event is not recurring: "${eventId}"`, 400, [
          `Remove recurrenceId to update "${event.title}"`,
          "GET /events returns recurrenceId only for occurrences of a series"
        ]);
      }
      oldEvent = resolveOccurrence(event, recurrenceTarget.recurrenceId, cal);
      if (!oldEvent) {
        return Utils.fail(
          "occurrence_not_found",
          `Occurrence not found: "${recurrenceTarget.recurrenceId}"`,
          404,
          [
            `No occurrence of "${event.title}" matches recurrenceId "${recurrenceTarget.recurrenceId}"`,
            "Use the exact recurrenceId value returned by GET /events"
          ]
        );
      }
      updatedScope = "occurrence";
    } else if (event.recurrenceInfo) {
      if (recurrenceTarget.mode === "series") {
        updatedScope = "series";
      } else {
        return Utils.fail("ambiguous_recurrence", "Event is recurring: specify the target", 409, [
          "Use recurrenceId=<recurrenceId> to update a single occurrence",
          "Use scope=series to update the whole series"
        ]);
      }
    }

    const newEvent = oldEvent.clone();

    // Start/end/allDay first: validation happens before anything is stored
    // and keeps the start/end types consistent (5.3 carry-over from 5.1).
    // `allDayParam.allDay` is undefined when the parameter was absent, so the
    // item's stored type is kept then.
    const dateError = applyDateFields(newEvent, oldEvent, { start, end, allDay: allDayParam.allDay }, cal);
    if (dateError) return dateError;

    if (title !== undefined) newEvent.title = title;
    if (location !== undefined) newEvent.setProperty("LOCATION", location);
    if (description !== undefined) newEvent.setProperty("DESCRIPTION", description);

    // Update organizer if provided
    if (organizer !== undefined) {
      if (organizer === null) {
        // Remove organizer
        newEvent.organizer = null;
      } else {
        const org = Cc["@mozilla.org/calendar/attendee;1"].createInstance(Ci.calIAttendee);
        const orgEmail = typeof organizer === "string" ? organizer : organizer.email;
        const orgName = typeof organizer === "string" ? null : (organizer.name || null);
        
        if (!orgEmail) {
          return Utils.fail("invalid_parameter", "Organizer email is required", 400, [
            'Provide organizer as string "email@example.com" or object {"email": "...", "name": "..."}'
          ]);
        }
        
        org.id = "mailto:" + orgEmail;
        if (orgName) org.commonName = orgName;
        org.isOrganizer = true;
        org.role = "CHAIR";
        newEvent.organizer = org;
      }
    }

    // Update attendees if provided
    if (attendees !== undefined) {
      // Remove all existing attendees first
      try {
        newEvent.removeAllAttendees();
      } catch (e) {
        // Method might not exist in all versions
        const existing = newEvent.getAttendees ? newEvent.getAttendees() : [];
        for (const att of existing) {
          try { newEvent.removeAttendee(att); } catch (e2) { /* ignore */ }
        }
      }
      
      // Add new attendees (if not null/empty)
      if (attendees && Array.isArray(attendees) && attendees.length > 0) {
        for (const att of attendees) {
          const attendee = Cc["@mozilla.org/calendar/attendee;1"].createInstance(Ci.calIAttendee);
          
          const attEmail = typeof att === "string" ? att : att.email;
          const attName = typeof att === "string" ? null : (att.name || null);
          const attRole = typeof att === "string" ? "REQ-PARTICIPANT" : (att.role || "REQ-PARTICIPANT");
          const attStatus = typeof att === "string" ? "NEEDS-ACTION" : (att.status || "NEEDS-ACTION");
          const attRsvp = typeof att === "string" ? true : (att.rsvp !== false);
          
          if (!attEmail) continue;
          
          attendee.id = "mailto:" + attEmail;
          if (attName) attendee.commonName = attName;
          attendee.role = attRole;
          attendee.participationStatus = attStatus;
          attendee.userType = "INDIVIDUAL";
          attendee.rsvp = attRsvp ? "TRUE" : "FALSE";
          
          newEvent.addAttendee(attendee);
        }
      }
    }

    await found.calendar.modifyItem(newEvent, oldEvent);

    // Build response. Occurrence vs series is reported so a client can see
    // which target the edit landed on (Task 5.3).
    const response = { 
      success: true, 
      message: updatedScope === "occurrence" ? "Occurrence updated" : "Event updated",
      id: eventId,
      title: newEvent.title
    };

    if (updatedScope === "occurrence") {
      response.recurrenceId = formatRecurrenceId(oldEvent.recurrenceId);
      response.scope = "occurrence";
    } else if (updatedScope === "series") {
      response.scope = "series";
    }

    if (organizer !== undefined) {
      response.organizer = organizer === null ? null : (
        typeof organizer === "string" 
          ? { email: organizer } 
          : { email: organizer.email, name: organizer.name || null }
      );
    }

    if (attendees !== undefined) {
      response.attendees = (attendees || []).map(att => {
        if (typeof att === "string") return { email: att };
        return { email: att.email, name: att.name || null };
      });
    }

    return response;
  } catch (e) {
    return Utils.fail("update_failed", `Failed to update event: ${e.message}`, 500);
  }
}

/**
 * Delete an event
 * Accepts calendar by ID or exact name (deleting is a write, so no fuzzy)
 */
async function deleteEvent(eventId, params, cal) {
  if (!cal) {
    return Utils.fail("calendar_unavailable", "Calendar not available", 503, [
      "Ensure Thunderbird's calendar component is enabled"
    ]);
  }

  // Normalize parameter names
  const normalized = Utils.normalizeParams(params, Utils.ALIASES.calendar);
  const { calendar: calendarId } = normalized;

  // recurrenceId / scope select one occurrence or the whole series (Task 5.3).
  const recurrenceTarget = parseRecurrenceTarget(normalized.recurrenceId, normalized.scope);
  if (recurrenceTarget.error) return recurrenceTarget.error;

  if (!calendarId) {
    const calendars = cal.manager.getCalendars();
    return Utils.fail(
      "invalid_parameter",
      "calendar parameter is required to identify which calendar contains the event",
      400,
      [
        `Available calendars: ${calendars.map(c => c.name).join(", ") || "none"}`,
        "Use GET /calendars to see calendar IDs"
      ]
    );
  }

  // Deleting an event is a write: the calendar must resolve exactly.
  const found = findCalendar(calendarId, cal, "write");
  if (found.error) return found.error;
  if (found.calendar.readOnly) {
    const writableCalendars = cal.manager.getCalendars().filter(c => !c.readOnly);
    return Utils.fail("read_only", `Calendar "${found.calendar.name}" is read-only`, 403, [
      `Writable calendars: ${writableCalendars.map(c => c.name).join(", ") || "none"}`
    ]);
  }

  try {
    const event = await found.calendar.getItem(eventId);
    if (!event) {
      return Utils.fail("not_found", `Event not found: "${eventId}"`, 404, [
        `Event ID was not found in calendar "${found.calendar.name}"`,
        "Use GET /events to list events and get valid event IDs"
      ]);
    }

    const eventTitle = event.title;

    // One occurrence: cancel it by adding an EXDATE to the parent. Calling
    // deleteItem on an occurrence would only drop an exception, not cancel
    // the occurrence (Appendix A.4).
    if (recurrenceTarget.mode === "occurrence") {
      if (!event.recurrenceInfo) {
        return Utils.fail("not_recurring", `Event is not recurring: "${eventId}"`, 400, [
          `Remove recurrenceId to delete "${eventTitle}"`,
          "GET /events returns recurrenceId only for occurrences of a series"
        ]);
      }
      const occurrence = resolveOccurrence(event, recurrenceTarget.recurrenceId, cal);
      if (!occurrence) {
        return Utils.fail(
          "occurrence_not_found",
          `Occurrence not found: "${recurrenceTarget.recurrenceId}"`,
          404,
          [
            `No occurrence of "${eventTitle}" matches recurrenceId "${recurrenceTarget.recurrenceId}"`,
            "Use the exact recurrenceId value returned by GET /events"
          ]
        );
      }
      const newParent = event.clone();
      newParent.recurrenceInfo.removeOccurrenceAt(occurrence.recurrenceId);
      await found.calendar.modifyItem(newParent, event);
      return {
        success: true,
        message: "Occurrence deleted",
        title: eventTitle,
        recurrenceId: formatRecurrenceId(occurrence.recurrenceId),
        scope: "occurrence"
      };
    }

    // A recurring series needs an explicit target: deleting it by accident is
    // what D7 guards against.
    if (recurrenceTarget.mode === null && event.recurrenceInfo) {
      return Utils.fail("ambiguous_recurrence", "Event is recurring: specify the target", 409, [
        "Use recurrenceId=<recurrenceId> to delete a single occurrence",
        "Use scope=series to delete the whole series"
      ]);
    }

    await found.calendar.deleteItem(event);

    const response = { 
      success: true, 
      message: "Event deleted",
      title: eventTitle
    };
    // A non-recurring event with scope=series keeps the old response shape.
    if (recurrenceTarget.mode === "series" && event.recurrenceInfo) {
      response.scope = "series";
    }
    return response;
  } catch (e) {
    return Utils.fail("delete_failed", `Failed to delete event: ${e.message}`, 500);
  }
}

// Export for loadSubScript usage
this.listCalendars = listCalendars;
this.listEvents = listEvents;
this.createEvent = createEvent;
this.updateEvent = updateEvent;
this.deleteEvent = deleteEvent;
