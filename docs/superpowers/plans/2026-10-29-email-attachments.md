# Email Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add raw/base64 attachment downloads and JSON-base64 attachments on draft creation to the Thunderbird REST API.

**Architecture:** `api/attachments.js` supplies pure base64, name, header, and limit helpers. The background resolves messages, reads `File` objects through `messages.getAttachmentFile`, and either returns JSON or a `binaryBodyBase64` envelope. A new experiment function writes that envelope as real bytes. `POST /messages` decodes base64 into `File` objects and calls `compose.addAttachment` before saving the draft.

**Tech Stack:** Thunderbird WebExtension APIs (Manifest V2), vanilla JavaScript, privileged experiment API, Node `node:test` harness.

**Spec:** `docs/superpowers/specs/2026-10-29-email-attachments-design.md`

## Global Constraints

- Thunderbird minimum is 128.0; do not add new manifest permissions.
- Raw bytes are the download default. `?format=json` is the opt-in base64 form.
- Download route: `GET /messages/:id/attachments/:partName`.
- Upload shape: `attachments: [{ name, content_type?, data_base64 }]`; `name` and `data_base64` are required.
- Limits: `MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024`, `MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024`, `MAX_ATTACHMENTS = 20`.
- Base64: standard `A-Z a-z 0-9 + /` alphabet; whitespace stripped; `=` padding optional; URL-safe `-`/`_` rejected; `""` is a valid zero-byte file.
- Any attachment failure fails the whole draft; no partial draft is saved.
- `inline` is reported only when the native attachment has `contentDisposition` (Thunderbird 140+); on 128 it is omitted.
- No global request-body cap is added; attachment limits are the bound for this feature.
- Existing auth, browser-origin rejection, `Content-Type: application/json`, and the 120-second watchdog are unchanged.
- Each task runs its targeted tests. Task 7 runs the full suite under both `TZ=Australia/Sydney` and `TZ=America/New_York`.
- Every new route must be described by `GET /` and appear in `README.md`.

## Review Focus

1. A Message-ID containing `+`, `%`, `/`, or angle brackets must resolve through the new download route rather than being swallowed by the generic message route.
2. A part name ending in `$` (for example `1.2$`) must survive URL encoding and match the native attachment exactly.
3. A non-ASCII attachment filename must produce a valid `Content-Disposition` header with both an ASCII fallback and an RFC 5987 `filename*` value.
4. A zero-byte attachment must upload and download successfully instead of being treated as missing data.
5. A failing `compose.addAttachment` must close the compose tab and save no draft, even though the tab was already created.

Each line has a test in the task that owns the code.

---

### Task 1: Shared attachment helpers

**Files:**
- Create: `tb-api/api/attachments.js`
- Modify: `tb-api/manifest.json` (`background.scripts`)
- Modify: `tests/helpers/harness.js` (load the file, expose `Attachments` and `File`)
- Test: `tests/test-attachments.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Attachments.MAX_ATTACHMENT_BYTES`, `Attachments.MAX_TOTAL_ATTACHMENT_BYTES`, `Attachments.MAX_ATTACHMENTS`
  - `Attachments.encodeBase64(bytes: Uint8Array): string`
  - `Attachments.decodeBase64(text: string): Uint8Array` (throws `Error("Invalid base64")`)
  - `Attachments.isValidPartName(value: string): boolean`
  - `Attachments.validateName(name: string): string | null` (null means valid)
  - `Attachments.validateContentType(value: string): string | null` (null means valid)
  - `Attachments.safeContentType(value: string | undefined): string`
  - `Attachments.contentDisposition(filename: string): string`
  - `Attachments.limitError(sizes: number[], limits?: object): { code, message, statusCode } | null`

- [ ] **Step 1: Write the failing helper tests**

Create `tests/test-attachments.js` with:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { backgroundHarness } = require("./helpers/harness.js");

const bytesOf = value => Array.from(value);

test("base64 helpers round-trip bytes, whitespace, and optional padding", () => {
  const h = backgroundHarness();
  const A = h.Attachments;
  const bytes = Uint8Array.from([0, 1, 2, 255]);
  assert.equal(A.encodeBase64(bytes), "AAEC/w==");
  assert.deepEqual(bytesOf(A.decodeBase64("AAEC/w==")), [0, 1, 2, 255]);
  assert.deepEqual(bytesOf(A.decodeBase64("AAEC\n/w")), [0, 1, 2, 255]);
  assert.deepEqual(bytesOf(A.decodeBase64("")), []);
});

test("decodeBase64 rejects URL-safe input and impossible lengths", () => {
  const h = backgroundHarness();
  const A = h.Attachments;
  assert.throws(() => A.decodeBase64("AAEC_w=="), /Invalid base64/);
  assert.throws(() => A.decodeBase64("A"), /Invalid base64/);
  assert.throws(() => A.decodeBase64("AA=A"), /Invalid base64/);
});

test("part names accept Thunderbird's numeric dotted shape", () => {
  const h = backgroundHarness();
  const A = h.Attachments;
  assert.equal(A.isValidPartName("1"), true);
  assert.equal(A.isValidPartName("1.2"), true);
  assert.equal(A.isValidPartName("1.2$"), true);
  assert.equal(A.isValidPartName("1.2.3$"), true);
  assert.equal(A.isValidPartName("../1.2"), false);
  assert.equal(A.isValidPartName("1.2/3"), false);
  assert.equal(A.isValidPartName(""), false);
});

test("attachment names reject path separators, controls, and blanks", () => {
  const h = backgroundHarness();
  const A = h.Attachments;
  assert.equal(A.validateName("report.pdf"), null);
  assert.match(A.validateName("../report.pdf"), /path/i);
  assert.match(A.validateName("a/b.pdf"), /path/i);
  assert.match(A.validateName("a\\b.pdf"), /path/i);
  assert.match(A.validateName("bad\u0000.pdf"), /character/i);
  assert.match(A.validateName("   "), /empty/i);
  assert.match(A.validateName(42), /string/i);
});

test("content types reject header injection and fall back when absent", () => {
  const h = backgroundHarness();
  const A = h.Attachments;
  assert.equal(A.validateContentType("application/pdf"), null);
  assert.match(A.validateContentType("text/plain\r\nX-Evil: 1"), /content type/i);
  assert.equal(A.safeContentType(undefined), "application/octet-stream");
  assert.equal(A.safeContentType("text/plain"), "text/plain");
  assert.equal(A.safeContentType("bad\r\nX: y"), "application/octet-stream");
});

test("contentDisposition provides an ASCII fallback and RFC 5987 filename", () => {
  const h = backgroundHarness();
  const header = h.Attachments.contentDisposition("résumé.pdf");
  assert.match(header, /^attachment; filename="r_sum_.pdf"; filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf$/);
});

test("attachment limits are the documented defaults", () => {
  const h = backgroundHarness();
  assert.equal(h.Attachments.MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024);
  assert.equal(h.Attachments.MAX_TOTAL_ATTACHMENT_BYTES, 25 * 1024 * 1024);
  assert.equal(h.Attachments.MAX_ATTACHMENTS, 20);
});

test("limitError reports per-file, total, and count violations", () => {
  const h = backgroundHarness();
  const A = h.Attachments;
  const limits = { maxPerFile: 2, maxTotal: 3, maxCount: 2 };
  assert.equal(A.limitError([1, 1], limits), null);
  assert.equal(A.limitError([3], limits).code, "attachment_too_large");
  assert.equal(A.limitError([2, 2], limits).code, "attachment_too_large");
  assert.equal(A.limitError([1, 1, 1], limits).code, "too_many_attachments");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/test-attachments.js`
Expected: FAIL because `h.Attachments` is undefined.

- [ ] **Step 3: Implement `tb-api/api/attachments.js`**

Create the file with `"use strict";` and `var Attachments = { ... }`. Implement:

- `encodeBase64(bytes)`: standard base64, `=` padded.
- `decodeBase64(text)`: strip whitespace; split trailing `=` padding from the
  data part; require the data part to match `[A-Za-z0-9+/]*` and the padding to
  be at most two `=`; reject a data length `% 4 === 1`; reject padding that does
  not complete a 4-character group; add missing padding; decode to `Uint8Array`;
  throw `Error("Invalid base64")` on any bad input.
- `isValidPartName(value)`: `typeof value === "string" && /^\d+(\.\d+\$?)*$/.test(value)`.
- `validateName(name)`: return `"Attachment name must be a string"`, `"Attachment name must not be empty"`, or `"Attachment name must not contain path separators or control characters"`; otherwise `null`.
- `validateContentType(value)`: return `"Attachment content type is invalid"` for a string containing CR/LF or control characters; otherwise `null`.
- `safeContentType(value)`: return the value when `validateContentType` returns null; otherwise `"application/octet-stream"`.
- `contentDisposition(filename)`: ASCII fallback by replacing anything outside `\x20-\x7e`, `"`, and `\` with `_`; percent-encode the real name with `encodeURIComponent`, then percent-encode `'()*` for RFC 5987; return `attachment; filename="<fallback>"; filename*=UTF-8''<encoded>`.
- `limitError(sizes, limits = {})`: merge defaults from the constants; return `Utils`-free plain objects:
  - per file: `{ code: "attachment_too_large", message: "Attachment exceeds the 10 MiB limit", statusCode: 413 }`
  - total: `{ code: "attachment_too_large", message: "Attachments exceed the 25 MiB total limit", statusCode: 413 }`
  - count: `{ code: "too_many_attachments", message: "At most 20 attachments are allowed", statusCode: 400 }`

Add `"api/attachments.js"` to `tb-api/manifest.json` background scripts before `"api/email.js"`.

In `tests/helpers/harness.js`, load `"api/attachments.js"` in the background file list before `"api/email.js"` and add `Attachments: context.Attachments` and `File: FakeFile` to the returned object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/test-attachments.js`
Expected: PASS for the helper tests.

- [ ] **Step 5: Commit**

```bash
git add tb-api/api/attachments.js tb-api/manifest.json tests/helpers/harness.js tests/test-attachments.js
git commit -m "feat: add shared attachment encoding helpers"
```

---

### Task 2: Expose attachment identity in `GET /messages/:id`

**Files:**
- Modify: `tb-api/api/email.js` (`getMessage` attachment mapping)
- Test: `tests/test-attachments.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `GET /messages/:id` attachment entries with `partName`, `content_id`, conditional `inline`, and `download_url`.

- [ ] **Step 1: Write the failing listing test**

Append to `tests/test-attachments.js`:

```js
function messageFixture(overrides = {}) {
  return {
    id: 1,
    headerMessageId: "msg-1@example.test",
    date: new Date(Date.UTC(2026, 0, 1)),
    author: "Sender <sender@example.test>",
    recipients: ["Receiver <receiver@example.test>"],
    subject: "Hello",
    read: false,
    folder: { id: "account1:/Inbox", name: "Inbox", specialUse: [] },
    ...overrides
  };
}

test("GET /messages/:id exposes partName, content_id, inline, and download_url", async () => {
  const h = backgroundHarness({
    messages: [messageFixture()],
    messenger: {
      messages: {
        async listAttachments() {
          return [
            {
              name: "report.pdf",
              size: 12,
              contentType: "application/pdf",
              partName: "1.2",
              contentId: "cid-1",
              contentDisposition: "inline"
            },
            { name: "plain.txt", size: 3, contentType: "text/plain", partName: "1.3" }
          ];
        }
      }
    }
  });

  const { status, body } = await h.request("GET", "/messages/1", "");
  assert.equal(status, 200);
  assert.deepEqual(body.attachments[0], {
    name: "report.pdf",
    size: 12,
    contentType: "application/pdf",
    partName: "1.2",
    content_id: "cid-1",
    inline: true,
    download_url: "/messages/1/attachments/1.2"
  });
  assert.equal(Object.hasOwn(body.attachments[1], "inline"), false);
  assert.equal(Object.hasOwn(body.attachments[1], "content_id"), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/test-attachments.js`
Expected: FAIL because `partName`, `content_id`, `inline`, and `download_url` are missing.

- [ ] **Step 3: Implement the mapping**

In `getMessage`, replace the attachment map with an object that always includes `name`, `size`, `contentType`, and `partName`; adds `content_id` only when `a.contentId` is truthy; adds `inline` only when `typeof a.contentDisposition === "string"`; and adds `download_url` as `/messages/${msg.id}/attachments/${encodeURIComponent(a.partName)}` when `a.partName` is a string.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/test-attachments.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb-api/api/email.js tests/test-attachments.js
git commit -m "feat: report attachment part names and download URLs"
```

---

### Task 3: Download endpoint end-to-end

**Files:**
- Modify: `tb-api/api/utils.js` (`binaryResponse`, export)
- Modify: `tb-api/api/email.js` (`downloadAttachment`, exports)
- Modify: `tb-api/background.js` (route, listener, `GET /` description)
- Modify: `tb-api/experiment/schema.json` (`sendBinaryResponse`)
- Modify: `tb-api/experiment/api.js` (load `api/attachments.js`, binary writer, API method)
- Modify: `tests/helpers/harness.js` (binary request/response support)
- Modify: `tests/test-docs-consistency.js` (new route extraction/expectation)
- Modify: `README.md` (download section and route mention)
- Test: `tests/test-attachments.js`

**Interfaces:**
- Consumes: `Attachments.encodeBase64`, `isValidPartName`, `safeContentType`, `contentDisposition`.
- Produces:
  - `Utils.binaryResponse(bodyBase64: string, headers?: object, statusCode?: number): { statusCode, headers, binaryBodyBase64 }`
  - `Email.downloadAttachment(messageRef: string, partName: string, { format }?: { format?: string }): Promise<object>`
  - `browser.httpServer.sendBinaryResponse(requestId, statusCode, headers, bodyBase64)`

- [ ] **Step 1: Write the failing download tests**

Append to `tests/test-attachments.js`:

```js
const PDF_BYTES = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

function attachmentHarness(overrides = {}) {
  return backgroundHarness({
    messages: [messageFixture()],
    messenger: {
      messages: {
        async listAttachments() {
          return [{
            name: "résumé.pdf",
            size: PDF_BYTES.length,
            contentType: "application/pdf",
            partName: "1.2$",
            contentId: "cid-1",
            contentDisposition: "attachment"
          }];
        },
        async getAttachmentFile(id, partName) {
          assert.equal(id, 1);
          assert.equal(partName, "1.2$");
          return { arrayBuffer: async () => Uint8Array.from(PDF_BYTES).buffer };
        }
      }
    },
    ...overrides
  });
}

test("raw download returns exact bytes and safe headers", async () => {
  const h = attachmentHarness();
  const res = await h.request("GET", "/messages/1/attachments/1.2%24", "");
  assert.equal(res.status, 200);
  assert.deepEqual(Array.from(res.rawBytes), PDF_BYTES);
  assert.equal(res.headers["Content-Type"], "application/pdf");
  assert.equal(res.headers["Content-Length"], String(PDF_BYTES.length));
  assert.match(res.headers["Content-Disposition"], /filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/);
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("format=json returns the base64 envelope", async () => {
  const h = attachmentHarness();
  const res = await h.request("GET", "/messages/1/attachments/1.2%24", "format=json");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    message_id: "msg-1@example.test",
    partName: "1.2$",
    name: "résumé.pdf",
    content_type: "application/pdf",
    size: PDF_BYTES.length,
    data_base64: "JVBERg=="
  });
});

test("download rejects an unknown part name and an invalid part name", async () => {
  const h = attachmentHarness();
  const unknown = await h.request("GET", "/messages/1/attachments/9.9", "");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "attachment_not_found");

  const invalid = await h.request("GET", "/messages/1/attachments/..%2Fx", "");
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "invalid_part_name");
});

test("zero-byte download returns an empty body, not an empty-file error", async () => {
  const h = backgroundHarness({
    messages: [messageFixture()],
    messenger: {
      messages: {
        async listAttachments() {
          return [{ name: "empty.txt", size: 0, contentType: "text/plain", partName: "1.3" }];
        },
        async getAttachmentFile() {
          return { arrayBuffer: async () => new ArrayBuffer(0) };
        }
      }
    }
  });
  const res = await h.request("GET", "/messages/1/attachments/1.3", "");
  assert.equal(res.status, 200);
  assert.equal(res.rawBytes.length, 0);
  assert.equal(res.headers["Content-Length"], "0");
});

test("download resolves a Message-ID that needs URL encoding", async () => {
  let queried = null;
  const h = backgroundHarness({
    messages: [messageFixture({ headerMessageId: "msg+tag@example.test" })],
    messenger: {
      messages: {
        async query(info) {
          queried = info.headerMessageId;
          return { messages: [{ id: 1 }] };
        },
        async get() {
          return messageFixture({ headerMessageId: "msg+tag@example.test" });
        },
        async listAttachments() {
          return [{ name: "x.txt", size: 1, contentType: "text/plain", partName: "1.2" }];
        },
        async getAttachmentFile() {
          return { arrayBuffer: async () => Uint8Array.from([0x78]).buffer };
        }
      }
    }
  });
  const res = await h.request("GET", "/messages/%3Cmsg%2Btag%40example.test%3E/attachments/1.2", "");
  assert.equal(res.status, 200);
  assert.equal(queried, "msg+tag@example.test");
});

test("download surfaces native read failures", async () => {
  const h = backgroundHarness({
    messages: [messageFixture()],
    messenger: {
      messages: {
        async listAttachments() {
          return [{ name: "x.txt", size: 1, contentType: "text/plain", partName: "1.2" }];
        },
        async getAttachmentFile() {
          throw new Error("synthetic MIME failure");
        }
      }
    }
  });
  const res = await h.request("GET", "/messages/1/attachments/1.2", "");
  assert.equal(res.status, 500);
  assert.equal(res.body.code, "attachment_failed");
});

test("the experiment server writes raw download bytes", async () => {
  const { experimentHarness } = require("./helpers/harness.js");
  const h = experimentHarness({
    messages: [messageFixture()],
    messenger: {
      messages: {
        async listAttachments() {
          return [{ name: "file.bin", size: 3, contentType: "application/octet-stream", partName: "1.2" }];
        },
        async getAttachmentFile() {
          return { arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
        }
      }
    }
  });
  const res = await h.request("GET", "/messages/1/attachments/1.2");
  assert.equal(res.status, 200);
  assert.deepEqual(Array.from(res.rawBytes), [1, 2, 3]);
  assert.equal(res.headers["Content-Type"], "application/octet-stream");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/test-attachments.js`
Expected: FAIL because the route and `binaryBodyBase64` handling do not exist.

- [ ] **Step 3: Implement the background download logic**

In `api/utils.js`, add:

```js
function binaryResponse(bodyBase64, headers = {}, statusCode = 200) {
  return { statusCode, headers, binaryBodyBase64: bodyBase64 };
}
```

Export it as `binaryResponse`. Also change `resultResponse` so a binary envelope
is returned untouched before the normal success/error branching:

```js
if (result && result.binaryBodyBase64 !== undefined) return result;
```

In `api/email.js`, add:

```js
async function downloadAttachment(messageRef, partName, { format } = {}) { ... }
```

Behavior:

- If `format` is neither `undefined` nor `"json"`, return `Utils.fail("invalid_parameter", 'format must be "json" when supplied', 400, ["Omit format for raw bytes, or use format=json"])`.
- If `!Attachments.isValidPartName(partName)`, return `Utils.fail("invalid_part_name", ... , 400, ["Use the partName value from GET /messages/:id"])`.
- Resolve with `resolveMessageRef(messageRef)`; on error return its result.
- `const message = await messenger.messages.get(resolved.id)`.
- Wrap `const attachments = await messenger.messages.listAttachments(resolved.id)` in a `try`; on failure return `Utils.fail("attachment_failed", `Could not read attachments: ${e.message}`, 500, [...])`.
- Find `attachment.partName === partName`; if none, return `Utils.fail("attachment_not_found", ..., 404, ["Use GET /messages/:id to list attachment part names"])`.
- Call `messenger.messages.getAttachmentFile(resolved.id, partName)` inside `try`; on failure return `Utils.fail("attachment_failed", `Failed to read attachment: ${e.message}`, 500, [...])`.
- `const bytes = new Uint8Array(await file.arrayBuffer())`.
- If `format === "json"`, return `{ message_id: message.headerMessageId || null, partName, name: attachment.name || partName, content_type: Attachments.safeContentType(attachment.contentType), size: bytes.length, data_base64: Attachments.encodeBase64(bytes) }`.
- Otherwise return `Utils.binaryResponse(Attachments.encodeBase64(bytes), { "Content-Type": Attachments.safeContentType(attachment.contentType), "Content-Length": String(bytes.length), "Content-Disposition": Attachments.contentDisposition(attachment.name || partName), "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" })`.

Add `downloadAttachment` to the `Email` export.

In `background.js`, add the route **before** the generic `path.startsWith("/messages/") && method === "GET"` branch:

```js
const attachmentMatch = path.match(/^\/messages\/([^/]+)\/attachments\/([^/]+)$/);
if (attachmentMatch && method === "GET") {
  const messageRef = decodeURIComponent(attachmentMatch[1]);
  const partName = decodeURIComponent(attachmentMatch[2]);
  return Utils.resultResponse(await Email.downloadAttachment(messageRef, partName, { format: params.format }));
}
```

In the request listener, before the fallback check, add:

```js
if (response && typeof response.binaryBodyBase64 === "string" && Number.isInteger(response.statusCode)) {
  browser.httpServer.sendBinaryResponse(
    request.id,
    response.statusCode,
    response.headers || {},
    response.binaryBodyBase64
  );
  return;
}
```

- [ ] **Step 4: Implement the experiment binary writer**

In `experiment/schema.json`, add a `sendBinaryResponse` function with parameters `requestId` (string), `statusCode` (integer), `headers` (object with string additional properties), and `bodyBase64` (string), `async: false`.

In `experiment/api.js`:

- Load `api/attachments.js` into a new `attachmentScope` via `Services.scriptloader.loadSubScript`.
- Add `finishPendingBinaryResponse(pending, statusCode, headers, bodyBase64)`: clear the watchdog, set the status line, set every header, decode with `attachmentScope.Attachments.decodeBase64`, write with `nsIBinaryOutputStream` from `Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream)`, and finish. On decode failure, call `finishPendingResponse(pending, 500, JSON.stringify({ error: "Internal server error" }))` instead.
- Add a `sendBinaryResponse(requestId, statusCode, headers, bodyBase64)` method that removes the pending request and calls the writer.
- Keep `close()`/`stop()` behavior unchanged.

- [ ] **Step 5: Update the harness for binary responses**

In `tests/helpers/harness.js`:

- Add `nsIBinaryOutputStream: {}` to the experiment `Ci`.
- Add a `"@mozilla.org/binaryoutputstream;1"` fake whose `writeByteArray(bytes)` appends to `stream.bytes`.
- Give the fake response `bodyOutputStream: { text: "", bytes: null }`; `finish()` returns `rawBytes` when `bytes` is present, otherwise parses `text` as JSON.
- In `backgroundHarness.request`, if `result.binaryBodyBase64` is a string, return `{ status, headers, rawBytes: Uint8Array.from(Buffer.from(result.binaryBodyBase64, "base64")), body: null }`.

- [ ] **Step 6: Update the docs route sweep**

In `tests/test-docs-consistency.js`, add detection for the nested route (for example, when the source contains the attachment regex, add `/messages/:id/attachments/:partName`) and add it to the expected background route list.

In `background.js`, add `"GET /messages/:id/attachments/:partName"` to the `endpoints.email` map with a short description. In `README.md`, add a `#### Download Attachment` section under Email containing the literal `GET /messages/:message_id/attachments/:part_name` and the route behavior. This is enough for the docs-consistency test; Task 6 completes the prose.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/test-attachments.js tests/test-docs-consistency.js`
Expected: PASS.

Then run: `node --test tests/test-*.js`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add tb-api/api/utils.js tb-api/api/email.js tb-api/background.js tb-api/experiment/schema.json tb-api/experiment/api.js tests/helpers/harness.js tests/test-docs-consistency.js tests/test-attachments.js README.md
git commit -m "feat: download message attachments as bytes or base64 JSON"
```

---

### Task 4: Attach files to new, reply, and forward drafts

**Files:**
- Modify: `tb-api/api/utils.js` (`ALIASES.compose.attachments`)
- Modify: `tb-api/api/email.js` (`composeMessage`, helper)
- Modify: `tests/helpers/harness.js` (`beginReply`, `beginForward`)
- Test: `tests/test-attachments.js`

**Interfaces:**
- Consumes: `Attachments.decodeBase64`, `validateName`, `validateContentType`, `safeContentType`, `limitError`; `Email.downloadAttachment` from Task 3 is not used here.
- Produces: `POST /messages` accepts `attachments` and reports the added files.

- [ ] **Step 1: Write the failing happy-path tests**

Append to `tests/test-attachments.js`:

```js
const B64 = value => Buffer.from(value).toString("base64");

function uploadHarness(overrides = {}) {
  return backgroundHarness({
    identities: [{ id: "id1", email: "me@example.test" }],
    ...overrides
  });
}

test("new message attachments are added before the draft is saved", async () => {
  const h = uploadHarness();
  const res = await h.request("POST", "/messages", "", JSON.stringify({
    to: "to@example.test",
    subject: "Report",
    body: "See attached",
    attachments: [{
      name: "report.pdf",
      content_type: "application/pdf",
      data_base64: B64("hello")
    }]
  }));

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.attachments, [
    { name: "report.pdf", content_type: "application/pdf", size: 5 }
  ]);

  const methods = h.composeCalls.map(call => call.method);
  assert.deepEqual(methods, ["beginNew", "addAttachment", "saveMessage", "removeTab"]);
  const added = h.composeCalls.find(call => call.method === "addAttachment").attachment;
  assert.equal(added.name, "report.pdf");
  assert.equal(added.file.type, "application/pdf");
  assert.deepEqual(Array.from(added.file.parts[0]), [104, 101, 108, 108, 111]);
});

test("reply and forward drafts accept attachments", async () => {
  for (const mode of ["reply", "forward"]) {
    const h = uploadHarness();
    if (mode === "reply") {
      h.messenger.messages.query = async () => ({ messages: [{ id: 1 }] });
      h.messenger.messages.get = async () => messageFixture();
    } else {
      h.messenger.messages.query = async () => ({ messages: [{ id: 1 }] });
      h.messenger.messages.get = async () => messageFixture();
    }
    const payload = mode === "reply"
      ? { in_reply_to: "msg-1@example.test", body: "reply", attachments: [{ name: "r.txt", data_base64: B64("r") }] }
      : { forward_of: "msg-1@example.test", to: "to@example.test", body: "fwd", attachments: [{ name: "f.txt", data_base64: B64("f") }] };
    const res = await h.request("POST", "/messages", "", JSON.stringify(payload));
    assert.equal(res.status, 200);
    assert.equal(h.composeCalls[0].method, mode === "reply" ? "beginReply" : "beginForward");
    assert.ok(h.composeCalls.some(call => call.method === "addAttachment"));
  }
});

test("zero-byte and Unicode attachments are preserved", async () => {
  const h = uploadHarness();
  const res = await h.request("POST", "/messages", "", JSON.stringify({
    to: "to@example.test",
    body: "files",
    attachments: [
      { name: "empty.txt", data_base64: "" },
      { name: "résumé.pdf", data_base64: B64("x") }
    ]
  }));
  assert.equal(res.status, 200);
  const added = h.composeCalls.filter(call => call.method === "addAttachment").map(call => call.attachment);
  assert.equal(added[0].file.parts[0].length, 0);
  assert.equal(added[1].name, "résumé.pdf");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/test-attachments.js`
Expected: FAIL because `attachments` is ignored.

- [ ] **Step 3: Implement upload parsing and attachment insertion**

In `api/utils.js`, add `attachments: ["attachment", "files"]` to `ALIASES.compose`.

In `api/email.js`, add a helper `parseAttachments(value)` that returns `{ attachments }` or `{ error }`:

- `undefined`/`null` -> `{ attachments: [] }`.
- Non-array -> `Utils.fail("invalid_attachment", "attachments must be an array", 400, [...])`.
- More than `Attachments.MAX_ATTACHMENTS` -> `Utils.fail("too_many_attachments", ..., 400, [...])`.
- For each item: require an object; read `name` from `name`/`filename`/`fileName`, `content_type` from `content_type`/`contentType`/`mime_type`/`mimeType`, and `data_base64` from `data_base64`/`dataBase64`/`data`/`content`/`base64` using `Object.hasOwn`.
- Validate `name` with `Attachments.validateName`; validate `content_type` with `Attachments.validateContentType`; default with `Attachments.safeContentType`.
- Require `data_base64` to be a string; `""` is allowed.
- Decode with `Attachments.decodeBase64`; catch and return `Utils.fail("invalid_attachment", "Attachment data is not valid base64", 400, [...])`.
- Build `{ file: new File([bytes], name, { type: contentType }), name, contentType, size: bytes.length }`.
- After parsing, call `Attachments.limitError(sizes)`; on error return `Utils.fail(error.code, error.message, error.statusCode, [...])`.

In `composeMessage`, destructure `attachments` from the normalized params, then after the recipient validation and before the identity lookup, call `parseAttachments(attachments)` and return the error when present. After `beginNew`/`beginReply`/`beginForward` and after `prependBodyToCompose` (if any), loop over the parsed attachments:

```js
for (const attachment of parsed.attachments) {
  await messenger.compose.addAttachment(tab.id, {
    file: attachment.file,
    name: attachment.name
  });
}
```

before `saveMessage`. On success, add `attachments: parsed.attachments.map(({ name, contentType, size }) => ({ name, content_type: contentType, size }))` when the array is non-empty.

In `tests/helpers/harness.js`, add `beginReply`, `beginForward`, `getComposeDetails`, and `setComposeDetails` to the fake `compose` namespace. `beginReply`/`beginForward` record the call and return a compose tab; `getComposeDetails` returns `{ isPlainText: true, plainTextBody: "" }`; `setComposeDetails` records the call.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/test-attachments.js`
Expected: PASS for the happy-path tests.

- [ ] **Step 5: Commit**

```bash
git add tb-api/api/utils.js tb-api/api/email.js tests/helpers/harness.js tests/test-attachments.js
git commit -m "feat: attach base64 files to message drafts"
```

---

### Task 5: Reject invalid attachments and failed adds

**Files:**
- Modify: `tb-api/api/email.js` (`parseAttachments`, `composeMessage` error path)
- Test: `tests/test-attachments.js`

**Interfaces:**
- Consumes: Task 4 `parseAttachments` and the upload flow.
- Produces: `invalid_attachment`, `attachment_too_large`, `too_many_attachments`, and `attachment_failed` responses with no draft saved on failure.

- [ ] **Step 1: Write the failing rejection tests**

Append to `tests/test-attachments.js`:

```js
test("invalid attachment input is rejected before a compose window opens", async () => {
  const cases = [
    { payload: { to: "to@example.test", attachments: "nope" }, code: "invalid_attachment" },
    { payload: { to: "to@example.test", attachments: [{ name: "x.txt" }] }, code: "invalid_attachment" },
    { payload: { to: "to@example.test", attachments: [{ name: "../x", data_base64: "" }] }, code: "invalid_attachment" },
    { payload: { to: "to@example.test", attachments: [{ name: "x.txt", data_base64: "AAEC_w==" }] }, code: "invalid_attachment" },
    { payload: { to: "to@example.test", attachments: [{ name: "x.txt", content_type: "text/plain\r\nX: y", data_base64: "" }] }, code: "invalid_attachment" }
  ];

  for (const { payload, code } of cases) {
    const h = uploadHarness();
    const res = await h.request("POST", "/messages", "", JSON.stringify(payload));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, code);
    assert.equal(h.composeCalls.length, 0);
  }
});

test("too many attachments is rejected", async () => {
  const h = uploadHarness();
  const attachments = Array.from({ length: 21 }, (_, index) => ({
    name: `file-${index}.txt`,
    data_base64: ""
  }));
  const res = await h.request("POST", "/messages", "", JSON.stringify({
    to: "to@example.test",
    attachments
  }));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "too_many_attachments");
  assert.equal(h.composeCalls.length, 0);
});

test("per-file and total attachment limits are enforced", async () => {
  const h = uploadHarness();
  h.Attachments.MAX_ATTACHMENT_BYTES = 3;
  const perFile = await h.request("POST", "/messages", "", JSON.stringify({
    to: "to@example.test",
    attachments: [{ name: "big.bin", data_base64: B64("abcd") }]
  }));
  assert.equal(perFile.status, 413);
  assert.equal(perFile.body.code, "attachment_too_large");

  const h2 = uploadHarness();
  h2.Attachments.MAX_TOTAL_ATTACHMENT_BYTES = 5;
  const total = await h2.request("POST", "/messages", "", JSON.stringify({
    to: "to@example.test",
    attachments: [
      { name: "a.bin", data_base64: B64("abcd") },
      { name: "b.bin", data_base64: B64("abcd") }
    ]
  }));
  assert.equal(total.status, 413);
  assert.equal(total.body.code, "attachment_too_large");
});

test("a failed addAttachment closes the tab and saves no draft", async () => {
  const h = uploadHarness({
    messenger: {
      compose: {
        async addAttachment() {
          throw new Error("synthetic attachment failure");
        }
      }
    }
  });
  const res = await h.request("POST", "/messages", "", JSON.stringify({
    to: "to@example.test",
    attachments: [{ name: "x.txt", data_base64: B64("x") }]
  }));
  assert.equal(res.status, 500);
  assert.equal(res.body.code, "attachment_failed");
  assert.equal(h.composeCalls.some(call => call.method === "saveMessage"), false);
  assert.equal(h.composeCalls.some(call => call.method === "removeTab"), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/test-attachments.js`
Expected: FAIL on the missing validation and failure mapping.

- [ ] **Step 3: Implement validation and failure handling**

Ensure `parseAttachments` returns the exact codes/messages above and runs before any compose call. Use `Attachments.limitError` for the per-file, total, and count checks. For the per-file pre-check, compare the stripped base64 length to the limit before decoding; decode and check exact byte length afterward.

In `composeMessage`, track whether the failure came from attachment insertion:

```js
let attachmentFailure = null;
try {
  // ... existing compose flow ...
  for (const attachment of parsed.attachments) {
    try {
      await messenger.compose.addAttachment(tab.id, { file: attachment.file, name: attachment.name });
    } catch (e) {
      attachmentFailure = e;
      throw e;
    }
  }
  await messenger.compose.saveMessage(tab.id, { mode: "draft" });
  // ...
} catch (e) {
  if (tab) { try { await messenger.tabs.remove(tab.id); } catch {} }
  if (attachmentFailure) {
    return Utils.fail("attachment_failed", `Failed to attach file: ${e.message}`, 500, [
      "Check that the attachment content and name are valid",
      "No draft was saved"
    ]);
  }
  return Utils.fail("compose_failed", `Failed to save draft: ${e.message}`, 500, [...]);
}
```

Do not call `saveMessage` when an attachment fails.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/test-attachments.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb-api/api/email.js tests/test-attachments.js
git commit -m "fix: reject invalid attachments and failed adds"
```

---

### Task 6: Documentation and docs consistency

**Files:**
- Modify: `README.md`
- Modify: `SKILL.md`
- Modify: `CHANGELOG.md`
- Modify: `tb-api/background.js` (`GET /` endpoint descriptions)
- Modify: `tests/test-docs-consistency.js` if the route description needs adjustment
- Test: `tests/test-docs-consistency.js`

**Interfaces:**
- Consumes: the final behavior from Tasks 3–5.
- Produces: complete user-facing docs for the new route, field, headers, limits, and errors.

- [ ] **Step 1: Update `README.md`**

Add a `#### Download Attachment` subsection under Email with:

- `GET /messages/:message_id/attachments/:part_name`
- Raw response headers: `Content-Type`, `Content-Length`, `Content-Disposition`, `X-Content-Type-Options`, `Cache-Control`.
- `?format=json` envelope with `message_id`, `partName`, `name`, `content_type`, `size`, `data_base64`.
- `partName` discovery through `GET /messages/:id`.
- Error codes `invalid_part_name`, `attachment_not_found`, `attachment_failed`.

Update the `GET /messages/:id` section to show `partName`, `content_id`, conditional `inline`, and `download_url`.

Update the Compose Message section: add an `attachments` example and table row; document `name`, `content_type`, `data_base64`, aliases, zero-byte files, limits (10 MiB / 25 MiB / 20 files), and that any failure saves no draft.

Add the new codes to the Email codes table and `413` to the HTTP status table.

- [ ] **Step 2: Update `SKILL.md`**

Add quick-reference `curl` examples for raw download and draft attachment. Add a key point covering attachment identity, limits, base64 rules, and the fact that failed attachments save no draft. Add the download endpoint to the endpoint table.

- [ ] **Step 3: Update `CHANGELOG.md`**

Add an `## [Unreleased]` section at the top with `### Added` entries for raw/base64 attachment downloads and draft attachments.

- [ ] **Step 4: Update `GET /` descriptions**

In `background.js`, ensure the new download route is in `endpoints.email` and that the `GET /messages/:id` and `POST /messages` descriptions mention `partName`/`download_url` and `attachments`.

- [ ] **Step 5: Run the docs and full tests**

Run: `node --test tests/test-docs-consistency.js`
Expected: PASS.

Run: `node --test tests/test-*.js`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add README.md SKILL.md CHANGELOG.md tb-api/background.js tests/test-docs-consistency.js
git commit -m "docs: document attachment download and draft upload"
```

---

### Task 7: Final verification

**Files:**
- No code changes expected.
- Test: full suite.

- [ ] **Step 1: Run the full suite in both CI timezones**

Run:

```bash
TZ=Australia/Sydney node --test tests/test-*.js
TZ=America/New_York node --test tests/test-*.js
```

Expected: all tests pass in both runs.

- [ ] **Step 2: Build the extension**

Run: `./build.sh`
Expected: `tb-api.xpi` is created and the listing includes `api/attachments.js`.

The repository tracks `tb-api.xpi`, so the build modifies a tracked file. Unless
this branch is intended to publish a release artifact, restore it before
checking the tree:

```bash
git checkout -- tb-api.xpi
```

- [ ] **Step 3: Check the working tree**

Run: `git status --short`
Expected: only the untracked `.pi/` directory from the local agent setup; no unfinished implementation files.

- [ ] **Step 4: Commit any final changes**

If the verification produced no changes, skip. Otherwise:

```bash
git add <changed-files>
git commit -m "chore: finish attachment support verification"
```
