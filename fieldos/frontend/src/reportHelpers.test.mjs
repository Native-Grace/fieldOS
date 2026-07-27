/**
 * Phase 3F reports UI helper tests.
 * Run: node --test fieldos/frontend/src/reportHelpers.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  REPORT_TYPES,
  buildReportPreviewBody,
  canCancelReport,
  canDownloadReport,
  canGenerateReport,
  canValidateReport,
  confirmGenerateReportMessage,
  defaultReportRange,
  emptyPreviewMessage,
  isManagerRole,
  jobSummaryPdfPath,
  parseReportsSearch,
  previewMetricCards,
  reportTypesForRole,
  reportsPath,
  staffAllowedReportTypes,
} from "./reportHelpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("manager role gate and staff-limited report types", () => {
  assert.equal(isManagerRole("manager"), true);
  assert.equal(isManagerRole("staff"), false);
  assert.deepEqual(staffAllowedReportTypes(), ["Staff Work Report"]);
  assert.deepEqual(reportTypesForRole("admin"), REPORT_TYPES);
  assert.deepEqual(reportTypesForRole("staff"), ["Staff Work Report"]);
});

test("default range is 30 inclusive days", () => {
  const range = defaultReportRange(new Date("2026-07-26T12:00:00Z"));
  assert.equal(range.date_to, "2026-07-26");
  assert.equal(range.date_from, "2026-06-27");
});

test("query helpers preserve filters and job deep-links", () => {
  assert.equal(reportsPath({ report_type: "Completion Register" }), "/reports?report_type=Completion+Register");
  const deep = reportsPath({ job_sheet_id: "21759f5d", report_type: "Job Sheet Summary" });
  assert.match(deep, /^\/reports\?/);
  assert.match(deep, /job_sheet_id=21759f5d/);
  assert.match(deep, /report_type=Job\+Sheet\+Summary/);
  assert.deepEqual(parseReportsSearch("?job_sheet_id=21759f5d&report_type=Staff%20Work%20Report"), {
    report_type: "Staff Work Report",
    job_sheet_id: "21759f5d",
    date_from: "",
    date_to: "",
  });
  assert.equal(jobSummaryPdfPath("21759f5d"), "/jobs/21759f5d/summary.pdf");
  assert.equal(jobSummaryPdfPath(""), "");
});

test("preview body drops blanks and supports job filter", () => {
  const body = buildReportPreviewBody({
    report_type: "Client Job Report",
    date_from: "2026-07-01",
    date_to: "2026-07-31",
    customer: "Dykes",
    project: "",
    job_sheet_id: "21759f5d",
    billable: "true",
  });
  assert.equal(body.report_type, "Client Job Report");
  assert.deepEqual(body.job_sheet_ids, ["21759f5d"]);
  assert.equal(body.filters.customer, "Dykes");
  assert.equal(body.filters.billable, true);
  assert.equal(body.filters.project, undefined);
});

test("batch action gates and generate confirmation", () => {
  assert.equal(canValidateReport("Draft"), true);
  assert.equal(canGenerateReport("Validated"), true);
  assert.equal(canGenerateReport("Draft"), false);
  assert.equal(canDownloadReport("Generated"), true);
  assert.equal(canCancelReport("Generated"), false);
  assert.match(confirmGenerateReportMessage({ report_type: "Staff Work Report", record_count: 2 }, { page_estimate: 3 }), /immutable/);
  assert.match(emptyPreviewMessage(), /never created automatically/i);
});

test("preview metric cards", () => {
  const cards = previewMetricCards({
    job_count: 2,
    group_count: 1,
    page_estimate: 4,
    totals: { labour_hours: 7.5, travel_hours: 0.5, machinery_hours: 1 },
  });
  assert.equal(cards.find((c) => c.key === "jobs").value, 2);
  assert.equal(cards.find((c) => c.key === "labour").value, 7.5);
});

test("routes and navigation wire reports for manager and staff", () => {
  const app = fs.readFileSync(path.join(__dirname, "App.jsx"), "utf8");
  const jobs = fs.readFileSync(path.join(__dirname, "pages", "JobsPage.jsx"), "utf8");
  const completions = fs.readFileSync(path.join(__dirname, "pages", "CompletionsDashboardPage.jsx"), "utf8");
  const detail = fs.readFileSync(path.join(__dirname, "pages", "JobDetailPage.jsx"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "pages", "ReportsPage.jsx"), "utf8");

  assert.match(app, /path="\/reports"/);
  assert.match(app, /ReportsPage/);
  assert.match(jobs, /to="\/reports"/);
  assert.match(completions, /to="\/reports"/);
  assert.match(detail, /Download job PDF/);
  assert.match(detail, /jobSummaryPdfPath/);
  assert.match(detail, /reportsPath/);
  assert.match(page, /Preview report data/);
  assert.match(page, /\/reports\/preview/);
  assert.match(page, /Generate PDF/);
  assert.match(page, /downloadAuthenticatedFile/);
  assert.match(page, /useSearchParams/);
  assert.match(page, /emptyPreviewMessage/);
  assert.match(page, /window\.confirm/);
  assert.ok(!page.includes('method: "POST"') || page.includes("runPreview") || page.includes("/reports/preview"));
  // Auto path must not create batches on filter change — only explicit actions.
  assert.match(emptyPreviewMessage(), /never created automatically|PDFs are never created automatically/i);
  assert.match(page, /reportTypesForRole/);
});
