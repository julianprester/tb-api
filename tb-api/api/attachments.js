"use strict";

/**
 * Pure helpers shared by the background and experiment scopes.
 *
 * This file must not depend on `Utils`, `browser`, `messenger`, or DOM APIs:
 * the experiment loads it with `Services.scriptloader.loadSubScript`, and the
 * background loads it as a normal manifest script.
 */
var Attachments = {
  MAX_ATTACHMENT_BYTES: 10 * 1024 * 1024,
  MAX_TOTAL_ATTACHMENT_BYTES: 25 * 1024 * 1024,
  MAX_ATTACHMENTS: 20,

  /** Encode bytes as standard base64 with `=` padding. */
  encodeBase64(bytes) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let output = "";
    let index = 0;

    for (; index + 2 < bytes.length; index += 3) {
      const value = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
      output += alphabet[(value >> 18) & 63]
        + alphabet[(value >> 12) & 63]
        + alphabet[(value >> 6) & 63]
        + alphabet[value & 63];
    }

    const remaining = bytes.length - index;
    if (remaining === 1) {
      const value = bytes[index] << 16;
      output += alphabet[(value >> 18) & 63] + alphabet[(value >> 12) & 63] + "==";
    } else if (remaining === 2) {
      const value = (bytes[index] << 16) | (bytes[index + 1] << 8);
      output += alphabet[(value >> 18) & 63]
        + alphabet[(value >> 12) & 63]
        + alphabet[(value >> 6) & 63]
        + "=";
    }
    return output;
  },

  /**
   * Decode standard base64. Whitespace is ignored; `=` padding is optional but
   * must be correct when present. The URL-safe alphabet is rejected.
   */
  decodeBase64(text) {
    if (typeof text !== "string") throw new Error("Invalid base64");
    const clean = text.replace(/\s+/g, "");
    const match = clean.match(/^([A-Za-z0-9+/]*)(={0,2})$/);
    if (!match) throw new Error("Invalid base64");

    const data = match[1];
    const padding = match[2];
    if (data.length % 4 === 1) throw new Error("Invalid base64");
    if (padding.length > 0) {
      if ((data.length + padding.length) % 4 !== 0) throw new Error("Invalid base64");
      if (padding.length !== (4 - (data.length % 4)) % 4) throw new Error("Invalid base64");
    }

    const padded = data + "=".repeat((4 - (data.length % 4)) % 4);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const lookup = Object.create(null);
    for (let i = 0; i < alphabet.length; i++) lookup[alphabet[i]] = i;

    const bytes = [];
    for (let i = 0; i < padded.length; i += 4) {
      const a = lookup[padded[i]];
      const b = lookup[padded[i + 1]];
      const c = padded[i + 2] === "=" ? 0 : lookup[padded[i + 2]];
      const d = padded[i + 3] === "=" ? 0 : lookup[padded[i + 3]];
      if (a === undefined || b === undefined || c === undefined || d === undefined) {
        throw new Error("Invalid base64");
      }
      const value = (a << 18) | (b << 12) | (c << 6) | d;
      bytes.push((value >> 16) & 255);
      if (padded[i + 2] !== "=") bytes.push((value >> 8) & 255);
      if (padded[i + 3] !== "=") bytes.push(value & 255);
    }
    return Uint8Array.from(bytes);
  },

  /** Thunderbird's own MIME part-name shape. */
  isValidPartName(value) {
    return typeof value === "string" && /^\d+(\.\d+\$?)*$/.test(value);
  },

  /** Return null when the filename is safe to put in a header. */
  validateName(name) {
    if (typeof name !== "string") return "Attachment name must be a string";
    if (!name.trim()) return "Attachment name must not be empty";
    if (/[\/\\\u0000-\u001f\u007f]/.test(name)) {
      return "Attachment name must not contain path separators or control characters";
    }
    return null;
  },

  /** Return null when the content type is safe to put in a header. */
  validateContentType(value) {
    if (typeof value !== "string" || !value.trim()) return "Attachment content type is invalid";
    if (/[\r\n\u0000-\u001f\u007f]/.test(value)) return "Attachment content type is invalid";
    return null;
  },

  /** A safe content type: the supplied one, or the generic fallback. */
  safeContentType(value) {
    return this.validateContentType(value) === null ? value : "application/octet-stream";
  },

  /**
   * Build a Content-Disposition value with an ASCII fallback and an RFC 5987
   * UTF-8 filename. The fallback is intentionally lossy but always quotable.
   */
  contentDisposition(filename) {
    const name = typeof filename === "string" && filename ? filename : "attachment";
    const fallback = name
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_");
    const encoded = encodeURIComponent(name)
      .replace(/['()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
  },

  /**
   * Return the first limit violation for decoded attachment sizes, or null.
   * `limits` exists so tests can exercise the checks without allocating real
   * 10/25 MiB payloads.
   */
  limitError(sizes, limits = {}) {
    const maxPerFile = limits.maxPerFile ?? this.MAX_ATTACHMENT_BYTES;
    const maxTotal = limits.maxTotal ?? this.MAX_TOTAL_ATTACHMENT_BYTES;
    const maxCount = limits.maxCount ?? this.MAX_ATTACHMENTS;

    if (sizes.length > maxCount) {
      return {
        code: "too_many_attachments",
        message: `At most ${maxCount} attachments are allowed`,
        statusCode: 400
      };
    }
    if (sizes.some(size => size > maxPerFile)) {
      return {
        code: "attachment_too_large",
        message: `Attachment exceeds the ${Math.round(maxPerFile / (1024 * 1024))} MiB limit`,
        statusCode: 413
      };
    }
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (total > maxTotal) {
      return {
        code: "attachment_too_large",
        message: `Attachments exceed the ${Math.round(maxTotal / (1024 * 1024))} MiB total limit`,
        statusCode: 413
      };
    }
    return null;
  }
};
