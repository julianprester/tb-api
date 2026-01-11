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
 * Parse date string (ISO 8601 or relative like "today", "yesterday")
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  
  const lower = dateStr.toLowerCase();
  const now = new Date();
  
  if (lower === "today") {
    now.setHours(0, 0, 0, 0);
    return now;
  }
  if (lower === "yesterday") {
    now.setDate(now.getDate() - 1);
    now.setHours(0, 0, 0, 0);
    return now;
  }
  
  const parsed = new Date(dateStr);
  return isNaN(parsed.getTime()) ? null : parsed;
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
 * Format error response
 */
function errorResponse(message, statusCode = 400) {
  return {
    statusCode,
    body: JSON.stringify({ error: message })
  };
}

// Export for use in background script
var Utils = {
  parseQueryString,
  parseDate,
  jsonResponse,
  errorResponse
};
