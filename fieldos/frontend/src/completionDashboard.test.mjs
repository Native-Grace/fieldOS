/**
 * Phase 3D completion dashboard helper tests.
 * Run: node --test fieldos/frontend/src/completionDashboard.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXPORT_TYPES,
  buildDashboardQuery,
  canCancelBatch,
  canDownloadBatch,
  canGenerateBatch,
  canValidateBatch,
  confirmGenerateMessage,
  defaultDashboardRange,
  isManagerRole,
  isWideLayout,
  readinessBadge,
  summaryCards,
} from "./completionDashboardHelpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("manager role gate", () => {
  assert.equal(isManagerRole("manager"), true);
  assert.equal(isManagerRole("admin"), true);
  assert.equal(isManagerRole("staff"), false);
});

test("default range is 30 days inclusive", () => {
  const range = defaultDashboardRange(new Date("2026-07-26T12:00:00Z"));
  assert.equal(range.date_to, "2026-07-26");
  assert.equal(range.date_from, "2026-06-27");
});

test("dashboard query omits blanks", () => {
  assert.equal(buildDashboardQuery({ date_from: "2026-01-01", q: "", customer: "Acme" }), "?date_from=2026-01-01&customer=Acme");
});

test("summary cards and readiness badges", () => {
  const cards = summaryCards({
    job_count: 2,
    finalised_jobs: 1,
    jobs_ready_for_invoice_export: 1,
  });
  assert.ok(cards.some((c) => c.key === "job_count" && c.value === 2));
  assert.equal(readinessBadge({ invoice_ready: true, payroll_ready: false, completion_status: "Finalised" }).label, "Invoice ready");
  assert.equal(readinessBadge({ invoice_ready: false, payroll_ready: false, completion_status: "Finalised" }).tone, "warn");
  assert.equal(readinessBadge({ completion_status: "Draft" }).label, "Not finalised");
});

test("batch action gates", () => {
  assert.equal(canValidateBatch("Draft"), true);
  assert.equal(canGenerateBatch("Validated"), true);
  assert.equal(canGenerateBatch("Draft"), false);
  assert.equal(canDownloadBatch("Exported"), true);
  assert.equal(canCancelBatch("Exported"), false);
});

test("generate confirmation lists included jobs", () => {
  const msg = confirmGenerateMessage(
    { export_type: "Payroll CSV" },
    [{ job_sheet_id: "JS-1" }, { job_sheet_id: "JS-2" }]
  );
  assert.match(msg, /Payroll CSV/);
  assert.match(msg, /JS-1/);
  assert.match(msg, /no Xero/i);
});

test("responsive helper", () => {
  assert.equal(isWideLayout(719), false);
  assert.equal(isWideLayout(720), true);
});

test("export types are stable", () => {
  assert.deepEqual(EXPORT_TYPES, [
    "Completion Summary CSV",
    "Invoice CSV",
    "Payroll CSV",
    "Machinery CSV",
    "Materials CSV",
  ]);
});

test("dashboard page wires filters, export panel, and download helpers", () => {
  const page = fs.readFileSync(path.join(__dirname, "pages", "CompletionsDashboardPage.jsx"), "utf8");
  const api = fs.readFileSync(path.join(__dirname, "api.js"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "App.jsx"), "utf8");
  assert.match(page, /date_from/);
  assert.match(page, /Create draft batch/);
  assert.match(page, /Validate/);
  assert.match(page, /Generate CSV/);
  assert.match(page, /window\.confirm/);
  assert.match(page, /downloadAuthenticatedFile/);
  assert.match(page, /status === 409/);
  assert.match(page, /Navigate to="\/"/);
  assert.match(api, /downloadAuthenticatedFile/);
  assert.match(api, /Authorization/);
  assert.match(api, /createObjectURL|triggerBrowserDownload/);
  assert.match(app, /\/completions/);
  assert.ok(!api.includes("?token="));
});
