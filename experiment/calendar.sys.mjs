/* exported calendar */
"use strict";

/**
 * List all calendars
 */
export function listCalendars(cal) {
  if (!cal) {
    return { error: "Calendar not available" };
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
 * Find calendar by ID
 */
function findCalendar(calendarId, cal) {
  if (!cal) return null;
  for (const calendar of cal.manager.getCalendars()) {
    if (calendar.id === calendarId) {
      return calendar;
    }
  }
  return null;
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
 */
export async function listEvents(params, cal, Ci) {
  if (!cal) {
    return { error: "Calendar not available" };
  }

  const { calendar: calendarId, start, end } = params;

  // Parse date range
  const startDate = start ? new Date(start) : new Date();
  const endDate = end ? new Date(end) : new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000); // Default 30 days

  if (isNaN(startDate.getTime())) {
    return { error: "Invalid start date" };
  }
  if (isNaN(endDate.getTime())) {
    return { error: "Invalid end date" };
  }

  const rangeStart = cal.createDateTime();
  rangeStart.nativeTime = startDate.getTime() * 1000;

  const rangeEnd = cal.createDateTime();
  rangeEnd.nativeTime = endDate.getTime() * 1000;

  const results = [];

  // Get calendars to search
  let calendars;
  if (calendarId) {
    const calendar = findCalendar(calendarId, cal);
    if (!calendar) {
      return { error: `Calendar not found: ${calendarId}` };
    }
    calendars = [calendar];
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

  return { events: results };
}

/**
 * Create a new event
 */
export async function createEvent(params, cal, Ci) {
  if (!cal) {
    return { error: "Calendar not available" };
  }

  const { calendar: calendarId, title, start, end, location, description } = params;

  if (!calendarId) {
    return { error: "calendar field is required" };
  }
  if (!title) {
    return { error: "title field is required" };
  }
  if (!start) {
    return { error: "start field is required" };
  }
  if (!end) {
    return { error: "end field is required" };
  }

  const calendar = findCalendar(calendarId, cal);
  if (!calendar) {
    return { error: `Calendar not found: ${calendarId}` };
  }
  if (calendar.readOnly) {
    return { error: "Calendar is read-only" };
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (isNaN(startDate.getTime())) {
    return { error: "Invalid start date" };
  }
  if (isNaN(endDate.getTime())) {
    return { error: "Invalid end date" };
  }

  try {
    const event = cal.createEvent();
    event.id = cal.getUUID();
    event.title = title;

    event.startDate = cal.createDateTime();
    event.startDate.nativeTime = startDate.getTime() * 1000;

    event.endDate = cal.createDateTime();
    event.endDate.nativeTime = endDate.getTime() * 1000;

    if (location) event.setProperty("LOCATION", location);
    if (description) event.setProperty("DESCRIPTION", description);

    await calendar.addItem(event);

    return {
      success: true,
      message: "Event created",
      id: event.id,
    };
  } catch (e) {
    return { error: `Failed to create event: ${e.message}` };
  }
}

/**
 * Update an existing event
 */
export async function updateEvent(eventId, params, cal, Ci) {
  if (!cal) {
    return { error: "Calendar not available" };
  }

  const { calendar: calendarId, title, start, end, location, description } = params;

  if (!calendarId) {
    return { error: "calendar parameter is required" };
  }

  const calendar = findCalendar(calendarId, cal);
  if (!calendar) {
    return { error: `Calendar not found: ${calendarId}` };
  }
  if (calendar.readOnly) {
    return { error: "Calendar is read-only" };
  }

  try {
    const event = await calendar.getItem(eventId);
    if (!event) {
      return { error: `Event not found: ${eventId}` };
    }

    const newEvent = event.clone();

    if (title !== undefined) newEvent.title = title;
    if (start !== undefined) {
      const startDate = new Date(start);
      if (isNaN(startDate.getTime())) {
        return { error: "Invalid start date" };
      }
      newEvent.startDate = cal.createDateTime();
      newEvent.startDate.nativeTime = startDate.getTime() * 1000;
    }
    if (end !== undefined) {
      const endDate = new Date(end);
      if (isNaN(endDate.getTime())) {
        return { error: "Invalid end date" };
      }
      newEvent.endDate = cal.createDateTime();
      newEvent.endDate.nativeTime = endDate.getTime() * 1000;
    }
    if (location !== undefined) newEvent.setProperty("LOCATION", location);
    if (description !== undefined) newEvent.setProperty("DESCRIPTION", description);

    await calendar.modifyItem(newEvent, event);

    return { success: true, message: "Event updated" };
  } catch (e) {
    return { error: `Failed to update event: ${e.message}` };
  }
}

/**
 * Delete an event
 */
export async function deleteEvent(eventId, params, cal) {
  if (!cal) {
    return { error: "Calendar not available" };
  }

  const { calendar: calendarId } = params;

  if (!calendarId) {
    return { error: "calendar parameter is required" };
  }

  const calendar = findCalendar(calendarId, cal);
  if (!calendar) {
    return { error: `Calendar not found: ${calendarId}` };
  }
  if (calendar.readOnly) {
    return { error: "Calendar is read-only" };
  }

  try {
    const event = await calendar.getItem(eventId);
    if (!event) {
      return { error: `Event not found: ${eventId}` };
    }

    await calendar.deleteItem(event);

    return { success: true, message: "Event deleted" };
  } catch (e) {
    return { error: `Failed to delete event: ${e.message}` };
  }
}
