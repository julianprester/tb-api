"use strict";

/**
 * Parse query string into object
 */
function parseQueryString(qs) {
  if (!qs) return {};
  const params = {};
  for (const part of qs.split("&")) {
    const [key, value] = part.split("=");
    if (key) {
      params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : "";
    }
  }
  return params;
}

/**
 * Parse date string flexibly - accepts many formats:
 * - Relative: "today", "yesterday", "tomorrow", "last week", "2 days ago", "next monday"
 * - ISO 8601: "2024-01-15", "2024-01-15T10:30:00"
 * - Natural: "Jan 15", "January 15 2024", "15/01/2024", "01-15-2024"
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  
  const lower = dateStr.toLowerCase().trim();
  const now = new Date();
  
  // Relative dates
  if (lower === "now") {
    return now;
  }
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
  if (lower === "last month" || lower === "a month ago") {
    now.setMonth(now.getMonth() - 1);
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
 * Common parameter aliases across the API
 */
const PARAM_ALIASES = {
  // Email search
  text: ["q", "query", "search", "keyword", "keywords"],
  from: ["sender", "author"],
  to: ["recipient", "recipients"],
  mailbox: ["folder", "mailboxId", "folderId", "box"],
  after: ["since", "from_date", "fromDate", "start", "startDate"],
  before: ["until", "to_date", "toDate", "end", "endDate"],
  limit: ["max", "count", "size", "maxResults"],
  
  // Message compose (note: "text" removed as alias to avoid conflict with email search)
  body: ["content", "message"],
  subject: ["title", "subj"],
  
  // Contacts
  addressbook: ["addressBook", "book", "bookId", "addressBookId"],
  firstName: ["first_name", "givenName", "given_name", "first"],
  lastName: ["last_name", "familyName", "family_name", "last", "surname"],
  displayName: ["display_name", "name", "fullName", "full_name"],
  email: ["emailAddress", "email_address", "mail"],
  
  // Calendar (note: "to" and "from" removed as aliases to avoid conflict with email)
  calendar: ["calendarId", "calendar_id", "cal"],
  title: ["summary", "eventName"],
  start: ["startDate", "start_date", "startTime", "start_time", "begin"],
  end: ["endDate", "end_date", "endTime", "end_time", "until", "finish"],
  location: ["place", "where"],
  description: ["desc", "details", "notes"]
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
 */
function errorResponse(message, statusCode = 400, suggestions = null) {
  const response = { error: message };
  if (suggestions) {
    response.suggestions = suggestions;
  }
  return {
    statusCode,
    body: JSON.stringify(response)
  };
}

/**
 * Format result as JSON or error response based on result.error
 */
function resultResponse(result, errorStatusCode = 400) {
  if (result.error) {
    return errorResponse(result.error, errorStatusCode, result.suggestions);
  }
  return jsonResponse(result);
}

/**
 * Determine error status code from error message
 */
function getErrorStatusFromMessage(errorMessage) {
  if (!errorMessage) return 400;
  const lower = errorMessage.toLowerCase();
  if (lower.includes("not found")) return 404;
  if (lower.includes("not available")) return 503;
  if (lower.includes("unauthorized") || lower.includes("permission")) return 403;
  return 400;
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

// Export for use in background script
var Utils = {
  parseQueryString,
  parseDate,
  normalizeParams,
  PARAM_ALIASES,
  fuzzyMatch,
  jsonResponse,
  errorResponse,
  resultResponse,
  getErrorStatusFromMessage,
  didYouMean
};
