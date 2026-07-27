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
  defaultGroupByForReportType,
  defaultReportRange,
  emptyPreviewMessage,
  groupByChoicesForReportType,
  isManagerRole,
  jobSummaryPdfPath,
  normalizeReportTypeOption,
  normalizeReportTypeOptions,
  parseReportsSearch,
  previewMetricCards,
  reportTypeLabel,
  reportTypeOptionsForRole,
  reportTypeSelectOptions,
  reportTypesForRole,
  reportsPath,
  staffAllowedReportTypes,
} from "./reportHelpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LIVE_REPORT_TYPES = [
  {
    report_type: "Job Sheet Summary",
    default_group_by: "job_sheet_id",
    allowed_group_by: ["job_sheet_id"],
  },
  {
    report_type: "Staff Work Report",
    default_group_by: "staff_id",
    allowed_group_by: ["staff_id", "job_sheet_id"],
  },
  {
    report_type: "Client Job Report",
    default_group_by: "customer",
    allowed_group_by: ["customer", "project", "job_sheet_id"],
  },
  {
    report_type: "Project Activity Report",
    default_group_by: "project",
    allowed_group_by: ["project", "customer", "job_month"],
  },
  {
    report_type: "Completion Register",
    default_group_by: "job_month",
    allowed_group_by: ["job_month", "customer", "project", "none"],
  },
];

test("manager role gate and staff-limited report types", () => {
  assert.equal(isManagerRole("manager"), true);
  assert.equal(isManagerRole("staff"), false);
  assert.deepEqual(staffAllowedReportTypes(), ["Staff Work Report"]);
  assert.deepEqual(reportTypesForRole("admin"), REPORT_TYPES);
  assert.deepEqual(reportTypesForRole("staff"), ["Staff Work Report"]);
});

test("normalises rich Apps Script report type objects and legacy strings", () => {
  const rich = normalizeReportTypeOption(LIVE_REPORT_TYPES[2]);
  assert.equal(rich.report_type, "Client Job Report");
  assert.deepEqual(rich.group_by, ["customer", "project", "job_sheet_id"]);
  assert.equal(rich.default_group_by, "customer");
  assert.equal(rich.label, "Client Job Report");

  const legacy = normalizeReportTypeOption("Staff Work Report");
  assert.equal(legacy.report_type, "Staff Work Report");
  assert.deepEqual(legacy.group_by, ["staff_id", "job_sheet_id"]);
  assert.equal(legacy.default_group_by, "staff_id");

  const empty = normalizeReportTypeOption({
    report_type: "Experimental",
    allowed_group_by: [],
    group_by: [],
  });
  assert.equal(empty.report_type, "Experimental");
  assert.deepEqual(empty.group_by, []);
  assert.equal(empty.default_group_by, "");

  const allFive = normalizeReportTypeOptions(LIVE_REPORT_TYPES);
  assert.equal(allFive.length, 5);
  assert.deepEqual(
    allFive.map((opt) => opt.report_type),
    REPORT_TYPES
  );
  assert.ok(allFive.every((opt) => Array.isArray(opt.group_by)));
});

test("group_by choices and labels drive the select UI", () => {
  const options = reportTypeOptionsForRole("manager", LIVE_REPORT_TYPES);
  assert.deepEqual(groupByChoicesForReportType(options, "Completion Register"), [
    "job_month",
    "customer",
    "project",
    "none",
  ]);
  assert.equal(defaultGroupByForReportType(options, "Staff Work Report"), "staff_id");
  assert.equal(reportTypeLabel(options[0]), "Job Sheet Summary");
  assert.equal(reportTypeLabel({ report_type: "X", label: "Friendly" }), "Friendly");

  const selects = reportTypeSelectOptions(LIVE_REPORT_TYPES);
  assert.deepEqual(
    selects.map((row) => row.value),
    REPORT_TYPES
  );
  assert.deepEqual(
    selects.map((row) => row.label),
    REPORT_TYPES
  );
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
  assert.deepEqual(parseReportsSearch("?job_sheet_id=21759f5d&report_type=Staff%20Work%20Report&group_by=staff_id"), {
    report_type: "Staff Work Report",
    job_sheet_id: "21759f5d",
    date_from: "",
    date_to: "",
    group_by: "staff_id",
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
    group_by: "customer",
  });
  assert.equal(body.report_type, "Client Job Report");
  assert.deepEqual(body.job_sheet_ids, ["21759f5d"]);
  assert.equal(body.filters.customer, "Dykes");
  assert.equal(body.filters.billable, true);
  assert.equal(body.filters.project, undefined);
  assert.equal(body.group_by, "customer");
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
  assert.match(page, /reportTypeSelectOptions|typeSelectOptions/);
  assert.match(page, /groupByChoices/);
  assert.match(page, /Group by/);
  assert.match(emptyPreviewMessage(), /never created automatically|PDFs are never created automatically/i);
  assert.match(page, /reportTypeOptionsForRole/);
});
