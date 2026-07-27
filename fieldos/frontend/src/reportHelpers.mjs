/** Pure helpers for Phase 3F job PDF reports UI (no React). */

export const REPORT_TYPES = [
  "Job Sheet Summary",
  "Staff Work Report",
  "Client Job Report",
  "Project Activity Report",
  "Completion Register",
];

export const REPORT_STATUSES = ["Draft", "Validated", "Generated", "Cancelled"];

/** Fallback groupings when options API is unavailable — mirrors Apps Script. */
export const REPORT_GROUPINGS = {
  "Job Sheet Summary": { default_group_by: "job_sheet_id", group_by: ["job_sheet_id"] },
  "Staff Work Report": { default_group_by: "staff_id", group_by: ["staff_id", "job_sheet_id"] },
  "Client Job Report": {
    default_group_by: "customer",
    group_by: ["customer", "project", "job_sheet_id"],
  },
  "Project Activity Report": {
    default_group_by: "project",
    group_by: ["project", "customer", "job_month"],
  },
  "Completion Register": {
    default_group_by: "job_month",
    group_by: ["job_month", "customer", "project", "none"],
  },
};

export function isManagerRole(role) {
  const r = String(role || "").trim().toLowerCase();
  return r === "manager" || r === "admin" || r === "administrator";
}

export function staffAllowedReportTypes() {
  return ["Staff Work Report"];
}

/** Accept string or rich Apps Script option object. */
export function normalizeReportTypeOption(entry) {
  if (typeof entry === "string") {
    const name = entry.trim();
    const fallback = REPORT_GROUPINGS[name] || { default_group_by: "", group_by: [] };
    return {
      report_type: name,
      label: name,
      description: null,
      default_group_by: fallback.default_group_by || "",
      allowed_group_by: [...(fallback.group_by || [])],
      group_by: [...(fallback.group_by || [])],
      supports_landscape: name === "Completion Register",
    };
  }
  if (!entry || typeof entry !== "object") {
    return {
      report_type: "",
      label: "",
      description: null,
      default_group_by: "",
      allowed_group_by: [],
      group_by: [],
      supports_landscape: null,
    };
  }
  const reportType = String(entry.report_type || entry.type || "").trim();
  let allowed = entry.allowed_group_by ?? entry.group_by ?? [];
  if (typeof allowed === "string") allowed = allowed.trim() ? [allowed.trim()] : [];
  if (!Array.isArray(allowed)) allowed = [];
  allowed = allowed.map((item) => String(item).trim()).filter(Boolean);
  if (!allowed.length && REPORT_GROUPINGS[reportType]) {
    allowed = [...REPORT_GROUPINGS[reportType].group_by];
  }
  const defaultGroup =
    String(entry.default_group_by || "").trim() ||
    allowed[0] ||
    REPORT_GROUPINGS[reportType]?.default_group_by ||
    "";
  return {
    report_type: reportType,
    label: String(entry.label || reportType || ""),
    description: entry.description == null ? null : String(entry.description),
    default_group_by: defaultGroup,
    allowed_group_by: allowed,
    group_by: allowed,
    supports_landscape:
      entry.supports_landscape == null ? reportType === "Completion Register" : !!entry.supports_landscape,
  };
}

export function normalizeReportTypeOptions(available = []) {
  return (available || []).map(normalizeReportTypeOption).filter((opt) => opt.report_type);
}

/** Role-filtered rich options (objects). */
export function reportTypeOptionsForRole(role, available = REPORT_TYPES) {
  const normalized = normalizeReportTypeOptions(available.length ? available : REPORT_TYPES);
  if (isManagerRole(role)) return normalized;
  const allowed = new Set(staffAllowedReportTypes());
  return normalized.filter((opt) => allowed.has(opt.report_type));
}

/** @deprecated Prefer reportTypeOptionsForRole — returns report_type strings. */
export function reportTypesForRole(role, available = REPORT_TYPES) {
  return reportTypeOptionsForRole(role, available).map((opt) => opt.report_type);
}

export function reportTypeLabel(option) {
  if (typeof option === "string") return option;
  return String(option?.label || option?.report_type || "");
}

export function groupByChoicesForReportType(options, reportType) {
  const normalized = normalizeReportTypeOptions(options);
  const match = normalized.find((opt) => opt.report_type === reportType);
  if (match) return match.group_by || match.allowed_group_by || [];
  return REPORT_GROUPINGS[reportType]?.group_by || [];
}

export function defaultGroupByForReportType(options, reportType) {
  const normalized = normalizeReportTypeOptions(options);
  const match = normalized.find((opt) => opt.report_type === reportType);
  if (match?.default_group_by) return match.default_group_by;
  const choices = groupByChoicesForReportType(options, reportType);
  return choices[0] || REPORT_GROUPINGS[reportType]?.default_group_by || "";
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
    group_by: String(params.get("group_by") || "").trim(),
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
  const groupBy = String(form.group_by || "").trim();
  if (groupBy) body.group_by = groupBy;
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

/** Options for a <select> of report types. */
export function reportTypeSelectOptions(options) {
  return normalizeReportTypeOptions(options).map((opt) => ({
    value: opt.report_type,
    label: reportTypeLabel(opt),
  }));
}
