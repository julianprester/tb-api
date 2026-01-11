/* exported utils */
"use strict";

/**
 * Parse query string into object
 * @param {string} queryString - URL query string (without leading ?)
 * @returns {object} Parsed parameters
 */
export function parseQueryString(queryString) {
  const params = {};
  if (!queryString) return params;
  for (const part of queryString.split("&")) {
    const [key, value] = part.split("=").map(decodeURIComponent);
    if (key) params[key] = value ?? "";
  }
  return params;
}

/**
 * Parse JSON request body
 * @param {object} request - HTTP request object
 * @param {object} NetUtil - Mozilla NetUtil module
 * @returns {object} Parsed JSON body or empty object
 */
export function parseRequestBody(request, NetUtil) {
  try {
    const stream = request.bodyInputStream;
    if (!stream || !stream.available()) return {};
    const body = NetUtil.readInputStreamToString(
      stream,
      stream.available(),
      { charset: "UTF-8" }
    );
    return JSON.parse(body);
  } catch (e) {
    return {};
  }
}

/**
 * Send JSON response
 * @param {object} response - HTTP response object
 * @param {string} httpVersion - HTTP version string
 * @param {object} data - Data to serialize as JSON
 * @param {number} status - HTTP status code (default 200)
 */
export function sendJson(response, httpVersion, data, status = 200) {
  const statusText = status === 200 ? "OK" : status === 404 ? "Not Found" : "Error";
  response.setStatusLine(httpVersion, status, statusText);
  response.setHeader("Content-Type", "application/json; charset=utf-8", false);
  response.write(JSON.stringify(data, null, 2));
}

/**
 * Send error response
 * @param {object} response - HTTP response object
 * @param {string} httpVersion - HTTP version string
 * @param {string} message - Error message
 * @param {number} status - HTTP status code (default 400)
 */
export function sendError(response, httpVersion, message, status = 400) {
  sendJson(response, httpVersion, { error: message }, status);
}

/**
 * Parse date string with natural language support
 * @param {string} dateStr - Date string (ISO 8601, "today", "yesterday")
 * @returns {Date|null} Parsed date or null if invalid
 */
export function parseDate(dateStr) {
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
 * Extract path parameter from URL path
 * @param {string} path - Full URL path
 * @param {string} prefix - Path prefix to strip
 * @returns {string|null} Decoded parameter or null
 */
export function extractPathParam(path, prefix) {
  if (!path.startsWith(prefix)) return null;
  const param = path.slice(prefix.length);
  if (!param || param.includes("/")) return null;
  return decodeURIComponent(param);
}

/**
 * Sanitize string for JSON (remove control characters)
 * @param {string} text - Input text
 * @returns {string} Sanitized text
 */
export function sanitizeForJson(text) {
  if (!text) return text;
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
