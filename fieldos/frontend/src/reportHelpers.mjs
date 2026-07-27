/** Pure helpers for Phase 3F job PDF reports UI (no React). */

export const REPORT_TYPES = [
  "Job Sheet Summary",
  "Staff Work Report",
  "Client Job Report",
  "Project Activity Report",
  "Completion Register",
];

export const REPORT_STATUSES = ["Draft", "Validated", "Generated", "Cancelled"];

export function isManagerRole(role) {
  const r = String(role || "").trim().toLowerCase();
  return r === "manager" || r === "admin" || r === "administrator";
}

export function staffAllowedReportTypes() {
  return ["Staff Work Report"];
}

export function reportTypesForRole(role, available = REPORT_TYPES) {
  if (isManagerRole(role)) return available.length ? available : REPORT_TYPES;
  const allowed = new Set(staffAllowedReportTypes());
  return (available.length ? available : REPORT_TYPES).filter((type) => allowed.has(type));
}

export function defaultReportRange(today = new Date()) {
  const end = new Date(today);
  const start = new Date(today);
  start.setDate(start.getDate() - 29);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { date_from: iso(start), date_to: iso(end) };
}

export function parseReportsSearch(searchOrParams) {
  let params;
  if (typeof searchOrParams === "string") {
    const qs = searchOrParams.startsWith("?") ? searchOrParams.slice(1) : searchOrParams;
    params = new URLSearchParams(qs);
  } else if (searchOrParams && typeof searchOrParams.get === "function") {
    params = searchOrParams;
  } else {
    params = new URLSearchParams();
  }
  return {
    report_type: String(params.get("report_type") || "").trim(),
    job_sheet_id: String(params.get("job_sheet_id") || "").trim(),
    date_from: String(params.get("date_from") || "").trim(),
    date_to: String(params.get("date_to") || "").trim(),
  };
}

export function reportsPath(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "" || value === false) return;
    params.set(key, String(value));
  });
  const qs = params.toString();
  return qs ? `/reports?${qs}` : "/reports";
}

export function jobSummaryPdfPath(jobSheetId) {
  const id = String(jobSheetId || "").trim();
  if (!id) return "";
  return `/jobs/${encodeURIComponent(id)}/summary.pdf`;
}

export function buildReportPreviewBody(form = {}) {
  const filters = {};
  ["customer", "project", "completion_status", "approval_status", "assigned_staff_id", "staff_id"].forEach(
    (key) => {
      const value = form[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        filters[key] = String(value).trim();
      }
    }
  );
  if (form.billable === true || form.billable === "true") filters.billable = true;
  if (form.billable === false || form.billable === "false") filters.billable = false;
  if (form.finalised_only) filters.finalised_only = true;

  const body = {
    report_type: form.report_type || "Completion Register",
    date_from: form.date_from || undefined,
    date_to: form.date_to || undefined,
    filters,
  };
  const jobId = String(form.job_sheet_id || "").trim();
  if (jobId) body.job_sheet_ids = [jobId];
  return body;
}

export function canValidateReport(status) {
  const value = String(status || "").trim();
  return value === "Draft" || value === "Validated";
}

export function canGenerateReport(status) {
  return String(status || "").trim() === "Validated";
}

export function canDownloadReport(status) {
  return String(status || "").trim() === "Generated";
}

export function canCancelReport(status) {
  const value = String(status || "").trim();
  return value === "Draft" || value === "Validated";
}

export function confirmGenerateReportMessage(batch = {}, preview = {}) {
  const count = batch.record_count ?? preview.job_count ?? 0;
  const pages = batch.page_estimate ?? preview.page_estimate ?? 0;
  return (
    `Generate PDF for ${batch.report_type || "report"} with ${count} job(s) ` +
    `(~${pages} page estimate)? The batch becomes immutable after generation. ` +
    "Nothing is emailed, uploaded to Drive, or posted externally."
  );
}

export function staleReportConflictMessage() {
  return "Report batch changed elsewhere (409). Reload it and try again.";
}

export function previewMetricCards(preview = {}) {
  const totals = preview.totals || {};
  return [
    { key: "jobs", label: "Matching jobs", value: preview.job_count ?? 0 },
    { key: "groups", label: "Groups", value: preview.group_count ?? 0 },
    { key: "pages", label: "Est. pages", value: preview.page_estimate ?? 0 },
    { key: "labour", label: "Labour hours", value: totals.labour_hours ?? 0 },
    { key: "travel", label: "Travel hours", value: totals.travel_hours ?? 0 },
    { key: "machinery", label: "Machinery hours", value: totals.machinery_hours ?? 0 },
  ];
}

export function emptyPreviewMessage() {
  return "No report generated yet. Adjust filters and click Preview — PDFs are never created automatically.";
}
