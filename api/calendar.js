/* exported calendar */
"use strict";

// =============================================================================
// Helper functions (calendar runs in experiment context, no Utils access)
// =============================================================================

/**
 * Parse date string flexibly - accepts many formats:
 * - Relative: "today", "yesterday", "tomorrow", "last week", "2 days ago"
 * - ISO 8601: "2024-01-15", "2024-01-15T10:30:00"
 * - Natural: "Jan 15", "January 15 2024"
 */
function parseFlexibleDate(dateStr) {
  if (!dateStr) return null;
  
  const lower = dateStr.toLowerCase().trim();
  const now = new Date();
  
  // Relative dates
  if (lower === "now") return now;
  if (lower === "today") {
    now.setHours(0, 0, 0, 0);
    return now;
  }
  if (lower === "yesterday") {
    now.setDate(now.getDate() - 1);
    now.setHours(0, 0, 0, 0);
    return now;
  }
  if (lower === "tomorrow") {
    now.setDate(now.getDate() + 1);
    now.setHours(0, 0, 0, 0);
    return now;
  }
  if (lower === "last week" || lower === "a week ago") {
    now.setDate(now.getDate() - 7);
    now.setHours(0, 0, 0, 0);
    return now;
  }
  if (lower === "next week") {
    now.setDate(now.getDate() + 7);
    now.setHours(0, 0, 0, 0);
    return now;
  }
  if (lower === "last month" || lower === "a month ago") {
    now.setMonth(now.getMonth() - 1);
    now.setHours(0, 0, 0, 0);
    return now;
  }
  if (lower === "next month") {
    now.setMonth(now.getMonth() + 1);
    now.setHours(0, 0, 0, 0);
    return now;
  }
  
  // "N days/weeks/months ago" pattern
  const agoMatch = lower.match(/^(\d+)\s*(day|days|week|weeks|month|months)\s*ago$/);
  if (agoMatch) {
    const n = parseInt(agoMatch[1], 10);
    const unit = agoMatch[2];
    if (unit.startsWith("day")) {
      now.setDate(now.getDate() - n);
    } else if (unit.startsWith("week")) {
      now.setDate(now.getDate() - n * 7);
    } else if (unit.startsWith("month")) {
      now.setMonth(now.getMonth() - n);
    }
    now.setHours(0, 0, 0, 0);
    return now;
  }
  
  // "in N days/weeks" pattern
  const inMatch = lower.match(/^in\s*(\d+)\s*(day|days|week|weeks|month|months)$/);
  if (inMatch) {
    const n = parseInt(inMatch[1], 10);
    const unit = inMatch[2];
    if (unit.startsWith("day")) {
      now.setDate(now.getDate() + n);
    } else if (unit.startsWith("week")) {
      now.setDate(now.getDate() + n * 7);
    } else if (unit.startsWith("month")) {
      now.setMonth(now.getMonth() + n);
    }
    now.setHours(0, 0, 0, 0);
    return now;
  }
  
  // Try standard Date parsing (handles ISO 8601 and many other formats)
  const parsed = new Date(dateStr);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Normalize parameter names - accept common aliases
 */
function normalizeCalendarParams(params) {
  const aliases = {
    calendar: ["calendarId", "calendar_id", "cal"],
    title: ["summary", "name", "eventName", "event_name"],
    start: ["startDate", "start_date", "startTime", "start_time", "from", "begin"],
    end: ["endDate", "end_date", "endTime", "end_time", "to", "until"],
    location: ["place", "where", "loc"],
    description: ["desc", "details", "notes", "body", "content"]
  };
  
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
 * Fuzzy match a string against a list of candidates
 */
function fuzzyMatchCalendar(input, candidates) {
  if (!input || !candidates || candidates.length === 0) return null;
  
  const lower = input.toLowerCase();
  
  // Exact match first
  const exact = candidates.find(c => c.name.toLowerCase() === lower || c.id === input);
  if (exact) return exact;
  
  // Starts with
  const startsWith = candidates.find(c => c.name.toLowerCase().startsWith(lower));
  if (startsWith) return startsWith;
  
  // Contains
  const contains = candidates.find(c => c.name.toLowerCase().includes(lower));
  if (contains) return contains;
  
  return null;
}

// =============================================================================
// Calendar API functions
// =============================================================================

/**
 * List all calendars
 */
function listCalendars(cal) {
  if (!cal) {
    return { 
      error: "Calendar not available",
      suggestions: ["Ensure Thunderbird's calendar component is enabled"]
    };
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
    return { error: `Failed to list calendars: ${e.message}` };
  }
}

/**
 * Find calendar by ID or name (with fuzzy matching)
 * Returns { calendar, error, suggestions } object
 */
function findCalendar(calendarId, cal) {
  if (!cal) return { calendar: null, error: "Calendar not available" };
  
  const calendars = cal.manager.getCalendars();
  
  // Try exact ID match first
  for (const calendar of calendars) {
    if (calendar.id === calendarId) {
      return { calendar };
    }
  }
  
  // Try fuzzy match by name
  const calendarList = calendars.map(c => ({ id: c.id, name: c.name, calendar: c }));
  const match = fuzzyMatchCalendar(calendarId, calendarList);
  if (match) {
    return { calendar: match.calendar };
  }
  
  // Not found - provide helpful error
  const calendarNames = calendars.map(c => c.name);
  return { 
    calendar: null, 
    error: `Calendar not found: "${calendarId}"`,
    suggestions: [
      `Available calendars: ${calendarNames.join(", ") || "none"}`,
      "Use GET /calendars to see all available calendars with their IDs"
    ]
  };
}

/**
 * Convert calendar item to event object
 */
function itemToEvent(item, calendarId) {
  const startMs = item.startDate?.nativeTime ? item.startDate.nativeTime / 1000 : null;
  const endMs = item.endDate?.nativeTime ? item.endDate.nativeTime / 1000 : null;

  return {
    id: item.id,
    calendar: calendarId,
    title: item.title,
    start: startMs ? new Date(startMs).toISOString() : null,
    end: endMs ? new Date(endMs).toISOString() : null,
    location: item.getProperty("LOCATION") || null,
    description: item.getProperty("DESCRIPTION") || null,
  };
}

/**
 * List events with optional filters
 * Accepts flexible date formats: "today", "tomorrow", "next week", "2024-01-15", etc.
 */
async function listEvents(params, cal, Ci) {
  if (!cal) {
    return { 
      error: "Calendar not available",
      suggestions: ["Ensure Thunderbird's calendar component is enabled"]
    };
  }

  // Normalize parameter names
  const normalized = normalizeCalendarParams(params);
  const { calendar: calendarId, start, end } = normalized;

  // Parse date range with flexible parsing
  const startDate = start ? parseFlexibleDate(start) : new Date();
  const endDate = end ? parseFlexibleDate(end) : new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000); // Default 30 days

  if (start && !startDate) {
    return { 
      error: `Invalid start date: "${start}"`,
      suggestions: [
        "Use ISO format: 2024-01-15 or 2024-01-15T10:30:00",
        "Or relative: today, tomorrow, yesterday, next week, 2 days ago"
      ]
    };
  }
  if (end && !endDate) {
    return { 
      error: `Invalid end date: "${end}"`,
      suggestions: [
        "Use ISO format: 2024-01-15 or 2024-01-15T10:30:00",
        "Or relative: today, tomorrow, in 2 weeks, next month"
      ]
    };
  }

  const rangeStart = cal.createDateTime();
  rangeStart.nativeTime = startDate.getTime() * 1000;

  const rangeEnd = cal.createDateTime();
  rangeEnd.nativeTime = endDate.getTime() * 1000;

  const results = [];

  // Get calendars to search
  let calendars;
  if (calendarId) {
    const found = findCalendar(calendarId, cal);
    if (!found.calendar) {
      return { error: found.error, suggestions: found.suggestions };
    }
    calendars = [found.calendar];
  } else {
    calendars = cal.manager.getCalendars();
  }

  for (const calendar of calendars) {
    try {
      const items = await calendar.getItemsAsArray(
        Ci.calICalendar.ITEM_FILTER_TYPE_EVENT,
        0,
        rangeStart,
        rangeEnd
      );

      for (const item of items) {
        results.push(itemToEvent(item, calendar.id));
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
 * Create a new event
 * Accepts flexible date formats and auto-selects calendar if only one writable exists
 */
async function createEvent(params, cal, Ci, Cc) {
  if (!cal) {
    return { 
      error: "Calendar not available",
      suggestions: ["Ensure Thunderbird's calendar component is enabled"]
    };
  }

  // Normalize parameter names
  const normalized = normalizeCalendarParams(params);
  let { calendar: calendarId, title, start, end, location, description } = normalized;

  // Validate required fields with helpful errors
  if (!title) {
    return { 
      error: "title is required",
      suggestions: ["Provide a title/summary for the event"]
    };
  }
  if (!start) {
    return { 
      error: "start date/time is required",
      suggestions: [
        "Use ISO format: 2024-01-15T10:00:00",
        "Or relative: tomorrow, next monday"
      ]
    };
  }
  if (!end) {
    return { 
      error: "end date/time is required",
      suggestions: [
        "Use ISO format: 2024-01-15T11:00:00",
        "Or relative: tomorrow"
      ]
    };
  }

  // Auto-select calendar if not specified
  const allCalendars = cal.manager.getCalendars();
  const writableCalendars = allCalendars.filter(c => !c.readOnly);
  
  if (!calendarId) {
    if (writableCalendars.length === 1) {
      calendarId = writableCalendars[0].id;
    } else if (writableCalendars.length === 0) {
      return { 
        error: "No writable calendars available",
        suggestions: ["Create a local calendar in Thunderbird first"]
      };
    } else {
      return { 
        error: "calendar is required when multiple writable calendars exist",
        suggestions: [
          `Available writable calendars: ${writableCalendars.map(c => c.name).join(", ")}`,
          "Use GET /calendars to see calendar IDs"
        ]
      };
    }
  }

  const found = findCalendar(calendarId, cal);
  if (!found.calendar) {
    return { error: found.error, suggestions: found.suggestions };
  }
  if (found.calendar.readOnly) {
    return { 
      error: `Calendar "${found.calendar.name}" is read-only`,
      suggestions: [
        `Writable calendars: ${writableCalendars.map(c => c.name).join(", ") || "none"}`
      ]
    };
  }

  // Parse dates with flexible parsing
  const startDate = parseFlexibleDate(start);
  const endDate = parseFlexibleDate(end);

  if (!startDate) {
    return { 
      error: `Invalid start date: "${start}"`,
      suggestions: [
        "Use ISO format: 2024-01-15T10:00:00",
        "Or relative: tomorrow, next monday, in 2 days"
      ]
    };
  }
  if (!endDate) {
    return { 
      error: `Invalid end date: "${end}"`,
      suggestions: [
        "Use ISO format: 2024-01-15T11:00:00",
        "Or relative: tomorrow"
      ]
    };
  }

  // Validate end is after start
  if (endDate <= startDate) {
    return {
      error: "End date must be after start date",
      suggestions: [`Start: ${startDate.toISOString()}, End: ${endDate.toISOString()}`]
    };
  }

  try {
    // Use XPCOM to create event
    const event = Cc["@mozilla.org/calendar/event;1"].createInstance(Ci.calIEvent);
    event.id = cal.getUUID();
    event.title = title;

    event.startDate = cal.createDateTime();
    event.startDate.nativeTime = startDate.getTime() * 1000;

    event.endDate = cal.createDateTime();
    event.endDate.nativeTime = endDate.getTime() * 1000;

    if (location) event.setProperty("LOCATION", location);
    if (description) event.setProperty("DESCRIPTION", description);

    await found.calendar.addItem(event);

    return {
      success: true,
      message: "Event created",
      id: event.id,
      calendar: found.calendar.name,
      title: title,
      start: startDate.toISOString(),
      end: endDate.toISOString()
    };
  } catch (e) {
    return { error: `Failed to create event: ${e.message}` };
  }
}

/**
 * Update an existing event
 * Accepts flexible date formats and helpful error messages
 */
async function updateEvent(eventId, params, cal, Ci, Cc) {
  if (!cal) {
    return { 
      error: "Calendar not available",
      suggestions: ["Ensure Thunderbird's calendar component is enabled"]
    };
  }

  // Normalize parameter names
  const normalized = normalizeCalendarParams(params);
  const { calendar: calendarId, title, start, end, location, description } = normalized;

  if (!calendarId) {
    // Try to help by listing calendars
    const calendars = cal.manager.getCalendars();
    return { 
      error: "calendar parameter is required to identify which calendar contains the event",
      suggestions: [
        `Available calendars: ${calendars.map(c => c.name).join(", ") || "none"}`,
        "Use GET /calendars to see calendar IDs"
      ]
    };
  }

  const found = findCalendar(calendarId, cal);
  if (!found.calendar) {
    return { error: found.error, suggestions: found.suggestions };
  }
  if (found.calendar.readOnly) {
    const writableCalendars = cal.manager.getCalendars().filter(c => !c.readOnly);
    return { 
      error: `Calendar "${found.calendar.name}" is read-only`,
      suggestions: [
        `Writable calendars: ${writableCalendars.map(c => c.name).join(", ") || "none"}`
      ]
    };
  }

  try {
    const event = await found.calendar.getItem(eventId);
    if (!event) {
      return { 
        error: `Event not found: "${eventId}"`,
        suggestions: [
          `Event ID was not found in calendar "${found.calendar.name}"`,
          "Use GET /events to list events and get valid event IDs"
        ]
      };
    }

    const newEvent = event.clone();

    if (title !== undefined) newEvent.title = title;
    if (start !== undefined) {
      const startDate = parseFlexibleDate(start);
      if (!startDate) {
        return { 
          error: `Invalid start date: "${start}"`,
          suggestions: [
            "Use ISO format: 2024-01-15T10:00:00",
            "Or relative: tomorrow, next monday"
          ]
        };
      }
      newEvent.startDate = cal.createDateTime();
      newEvent.startDate.nativeTime = startDate.getTime() * 1000;
    }
    if (end !== undefined) {
      const endDate = parseFlexibleDate(end);
      if (!endDate) {
        return { 
          error: `Invalid end date: "${end}"`,
          suggestions: [
            "Use ISO format: 2024-01-15T11:00:00",
            "Or relative: tomorrow"
          ]
        };
      }
      newEvent.endDate = cal.createDateTime();
      newEvent.endDate.nativeTime = endDate.getTime() * 1000;
    }
    if (location !== undefined) newEvent.setProperty("LOCATION", location);
    if (description !== undefined) newEvent.setProperty("DESCRIPTION", description);

    await found.calendar.modifyItem(newEvent, event);

    return { 
      success: true, 
      message: "Event updated",
      id: eventId,
      title: newEvent.title
    };
  } catch (e) {
    return { error: `Failed to update event: ${e.message}` };
  }
}

/**
 * Delete an event
 * Accepts calendar by ID or name with fuzzy matching
 */
async function deleteEvent(eventId, params, cal) {
  if (!cal) {
    return { 
      error: "Calendar not available",
      suggestions: ["Ensure Thunderbird's calendar component is enabled"]
    };
  }

  // Normalize parameter names
  const normalized = normalizeCalendarParams(params);
  const { calendar: calendarId } = normalized;

  if (!calendarId) {
    const calendars = cal.manager.getCalendars();
    return { 
      error: "calendar parameter is required to identify which calendar contains the event",
      suggestions: [
        `Available calendars: ${calendars.map(c => c.name).join(", ") || "none"}`,
        "Use GET /calendars to see calendar IDs"
      ]
    };
  }

  const found = findCalendar(calendarId, cal);
  if (!found.calendar) {
    return { error: found.error, suggestions: found.suggestions };
  }
  if (found.calendar.readOnly) {
    const writableCalendars = cal.manager.getCalendars().filter(c => !c.readOnly);
    return { 
      error: `Calendar "${found.calendar.name}" is read-only`,
      suggestions: [
        `Writable calendars: ${writableCalendars.map(c => c.name).join(", ") || "none"}`
      ]
    };
  }

  try {
    const event = await found.calendar.getItem(eventId);
    if (!event) {
      return { 
        error: `Event not found: "${eventId}"`,
        suggestions: [
          `Event ID was not found in calendar "${found.calendar.name}"`,
          "Use GET /events to list events and get valid event IDs"
        ]
      };
    }

    const eventTitle = event.title;
    await found.calendar.deleteItem(event);

    return { 
      success: true, 
      message: "Event deleted",
      title: eventTitle
    };
  } catch (e) {
    return { error: `Failed to delete event: ${e.message}` };
  }
}

// Export for loadSubScript usage
this.listCalendars = listCalendars;
this.listEvents = listEvents;
this.createEvent = createEvent;
this.updateEvent = updateEvent;
this.deleteEvent = deleteEvent;
