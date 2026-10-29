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
    h.messenger.messages.query = async () => ({ messages: [{ id: 1 }] });
    h.messenger.messages.get = async () => messageFixture();
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

test("total limit stops decoding once the running total is exceeded", async () => {
  const h = uploadHarness();
  h.Attachments.MAX_TOTAL_ATTACHMENT_BYTES = 5;
  let decoded = 0;
  const original = h.Attachments.decodeBase64;
  h.Attachments.decodeBase64 = text => {
    decoded++;
    return original(text);
  };

  const res = await h.request("POST", "/messages", "", JSON.stringify({
    to: "to@example.test",
    attachments: [
      { name: "a.bin", data_base64: B64("abcd") },
      { name: "b.bin", data_base64: B64("abcd") },
      { name: "c.bin", data_base64: B64("abcd") }
    ]
  }));

  assert.equal(res.status, 413);
  assert.equal(res.body.code, "attachment_too_large");
  assert.equal(decoded, 1, "the second file must be rejected before it is decoded");
});
