/**
 * Authenticated binary download helper tests.
 * Run: node --test fieldos/frontend/src/api.download.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ApiError,
  clearSession,
  downloadAuthenticatedFile,
  getToken,
  parseContentDispositionFilename,
  setSession,
} from "./api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function installBrowserMocks({ revokeImmediate = false } = {}) {
  const store = new Map();
  const clicks = [];
  const revoked = [];
  const createdUrls = [];
  const timers = [];

  globalThis.localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };

  globalThis.URL = {
    createObjectURL(blob) {
      const url = `blob:mock-${createdUrls.length}-${blob?.size || 0}`;
      createdUrls.push(url);
      return url;
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };

  globalThis.document = {
    body: {
      appendChild() {},
    },
    createElement(tag) {
      assert.equal(tag, "a");
      const el = {
        href: "",
        download: "",
        rel: "",
        click() {
          clicks.push({ href: el.href, download: el.download });
        },
        remove() {},
      };
      return el;
    },
  };

  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => {
    timers.push({ fn, ms });
    if (revokeImmediate) return realSetTimeout(fn, 0);
    return 0;
  };

  return {
    clicks,
    revoked,
    createdUrls,
    timers,
    flushRevoke() {
      for (const t of timers.splice(0)) t.fn();
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
    },
  };
}

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        const map = Object.fromEntries(
          Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
        );
        return map[key] || null;
      },
    },
    async json() {
      return body;
    },
    async blob() {
      return { size: 0, type: "application/json" };
    },
  };
}

function pdfResponse({
  bytes = "%PDF-1.4 mock",
  filename = "nativegrace_report_RPT-1.pdf",
  contentType = "application/pdf",
} = {}) {
  const blob = {
    size: bytes.length,
    type: contentType,
  };
  return {
    status: 200,
    ok: true,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === "content-type") return contentType;
        if (key === "content-disposition") return `attachment; filename="${filename}"`;
        return null;
      },
    },
    async json() {
      throw new Error("not json");
    },
    async blob() {
      return blob;
    },
  };
}

test("parseContentDispositionFilename supports quoted and utf-8 forms", () => {
  assert.equal(
    parseContentDispositionFilename('attachment; filename="report.pdf"'),
    "report.pdf"
  );
  assert.equal(
    parseContentDispositionFilename("attachment; filename*=UTF-8''nativegrace%20job.pdf"),
    "nativegrace job.pdf"
  );
  assert.equal(parseContentDispositionFilename(""), "");
});

test("downloadAuthenticatedFile sends Authorization and never puts token in URL", async () => {
  const browser = installBrowserMocks();
  setSession("test-bearer-token", { staff_id: "STAFF-1", role: "manager" });
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return pdfResponse();
  };

  const result = await downloadAuthenticatedFile(
    "/reports/RPT-DDF729D8/download",
    "nativegrace_report_RPT-DDF729D8.pdf"
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/v1/reports/RPT-DDF729D8/download");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-bearer-token");
  assert.ok(!String(calls[0].url).includes("token"));
  assert.ok(!String(calls[0].url).includes("test-bearer-token"));
  assert.equal(result.fileName, "nativegrace_report_RPT-1.pdf");
  assert.equal(result.blob.size > 0, true);
  assert.equal(browser.clicks.length, 1);
  assert.equal(browser.clicks[0].download, "nativegrace_report_RPT-1.pdf");
  assert.match(browser.clicks[0].href, /^blob:/);
  assert.equal(browser.timers[0]?.ms, 1000);
  browser.flushRevoke();
  assert.deepEqual(browser.revoked, browser.createdUrls);
  browser.restore();
});

test("downloadAuthenticatedFile uses fallback filename when disposition missing", async () => {
  const browser = installBrowserMocks();
  setSession("tok", { staff_id: "S1" });
  globalThis.fetch = async () => {
    const res = pdfResponse({ filename: "" });
    res.headers.get = (name) =>
      String(name).toLowerCase() === "content-type" ? "application/pdf" : null;
    return res;
  };

  const result = await downloadAuthenticatedFile(
    "/reports/RPT-FALLBACK/download",
    "nativegrace_report_RPT-FALLBACK.pdf"
  );
  assert.equal(result.fileName, "nativegrace_report_RPT-FALLBACK.pdf");
  assert.equal(browser.clicks[0].download, "nativegrace_report_RPT-FALLBACK.pdf");
  browser.restore();
});

test("downloadAuthenticatedFile clears session on 401", async () => {
  const browser = installBrowserMocks();
  setSession("expired-token", { staff_id: "S1" });
  globalThis.fetch = async () => jsonResponse(401, { detail: "Unauthorized" });

  await assert.rejects(
    () => downloadAuthenticatedFile("/reports/RPT-1/download", "x.pdf"),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 401);
      assert.match(err.message, /session has expired/i);
      return true;
    }
  );
  assert.equal(getToken(), null);
  assert.equal(browser.clicks.length, 0);
  browser.restore();
});

test("downloadAuthenticatedFile surfaces backend 422 detail", async () => {
  const browser = installBrowserMocks();
  setSession("tok", { staff_id: "S1" });
  globalThis.fetch = async () =>
    jsonResponse(422, { detail: "Report snapshot is missing or empty." });

  await assert.rejects(
    () => downloadAuthenticatedFile("/reports/RPT-1/download", "x.pdf"),
    (err) => {
      assert.equal(err.status, 422);
      assert.match(err.message, /Report snapshot is missing or empty/);
      return true;
    }
  );
  assert.equal(browser.clicks.length, 0);
  browser.restore();
});

test("downloadAuthenticatedFile rejects non-PDF and empty blobs", async () => {
  const browser = installBrowserMocks();
  setSession("tok", { staff_id: "S1" });

  globalThis.fetch = async () =>
    pdfResponse({ bytes: "not-a-pdf", contentType: "text/plain", filename: "x.pdf" });
  await assert.rejects(
    () => downloadAuthenticatedFile("/reports/RPT-1/download", "x.pdf"),
    /did not return a PDF/i
  );

  globalThis.fetch = async () => pdfResponse({ bytes: "" });
  await assert.rejects(
    () => downloadAuthenticatedFile("/reports/RPT-1/download", "x.pdf"),
    /empty/i
  );
  assert.equal(browser.clicks.length, 0);
  browser.restore();
});

test("Reports page wires authenticated download with loading state", () => {
  const page = fs.readFileSync(path.join(__dirname, "pages", "ReportsPage.jsx"), "utf8");
  const api = fs.readFileSync(path.join(__dirname, "api.js"), "utf8");

  assert.match(page, /downloadAuthenticatedFile\(/);
  assert.match(page, /\/reports\/\$\{encodeURIComponent\(reportBatchId\)\}\/download/);
  assert.match(page, /nativegrace_report_\$\{reportBatchId\}\.pdf/);
  assert.match(page, /busy === "download" \? "Downloading…"/);
  assert.match(page, /setBusy\("download"\)/);
  assert.match(page, /setBusy\(""\)/);
  assert.ok(!page.includes("window.open"));
  assert.ok(!/window\.location\s*=/.test(page));
  assert.ok(!page.includes('href={`/api'));
  assert.ok(!page.includes("?token="));

  assert.match(api, /Authorization/);
  assert.match(api, /createObjectURL/);
  assert.match(api, /revokeObjectURL/);
  assert.match(api, /parseContentDispositionFilename/);
  assert.ok(!api.includes("?token="));
  assert.ok(!/console\.log\([^)]*token/i.test(api));
  assert.ok(!/Authorization=`Bearer \$\{.*\}`/.test(api)); // template must stay in headers object
});

test("clearSession removes auth without leaving token in storage", () => {
  const browser = installBrowserMocks();
  setSession("secret-token", { staff_id: "S1" });
  assert.equal(getToken(), "secret-token");
  clearSession();
  assert.equal(getToken(), null);
  browser.restore();
});
