/** Pure helpers for Completion Dashboard / export UI (no React). */

export const EXPORT_TYPES = [
  "Completion Summary CSV",
  "Invoice CSV",
  "Payroll CSV",
  "Machinery CSV",
  "Materials CSV",
];

export function isManagerRole(role) {
  const r = String(role || "").trim().toLowerCase();
  return r === "manager" || r === "admin" || r === "administrator";
}

export function defaultDashboardRange(today = new Date()) {
  const end = new Date(today);
  const start = new Date(today);
  start.setDate(start.getDate() - 29);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { date_from: iso(start), date_to: iso(end) };
}

export function buildDashboardQuery(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    params.set(key, String(value));
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function readinessBadge(item) {
  if (!item) return { label: "Unknown", tone: "muted" };
  if (item.invoice_ready && item.payroll_ready) return { label: "Invoice + Payroll ready", tone: "ok" };
  if (item.invoice_ready) return { label: "Invoice ready", tone: "ok" };
  if (item.payroll_ready) return { label: "Payroll ready", tone: "ok" };
  if (String(item.completion_status) === "Finalised") return { label: "Blocked", tone: "warn" };
  return { label: "Not finalised", tone: "muted" };
}

export function summaryCards(summary = {}) {
  return [
    { key: "job_count", label: "Jobs", value: summary.job_count || 0 },
    { key: "finalised_jobs", label: "Finalised", value: summary.finalised_jobs || 0 },
    { key: "draft_or_reopened_jobs", label: "Draft / reopened", value: summary.draft_or_reopened_jobs || 0 },
    { key: "total_labour_hours", label: "Labour hours", value: summary.total_labour_hours || 0 },
    { key: "total_travel_hours", label: "Travel hours", value: summary.total_travel_hours || 0 },
    { key: "total_machinery_hours", label: "Machinery hours", value: summary.total_machinery_hours || 0 },
    { key: "billable_labour_hours", label: "Billable labour", value: summary.billable_labour_hours || 0 },
    {
      key: "non_billable_labour_hours",
      label: "Non-billable labour",
      value: summary.non_billable_labour_hours || 0,
    },
    { key: "unresolved_warnings", label: "Unresolved warnings", value: summary.unresolved_warnings || 0 },
    {
      key: "jobs_ready_for_invoice_export",
      label: "Invoice-ready",
      value: summary.jobs_ready_for_invoice_export || 0,
    },
    {
      key: "jobs_ready_for_payroll_export",
      label: "Payroll-ready",
      value: summary.jobs_ready_for_payroll_export || 0,
    },
  ];
}

export function canCancelBatch(status) {
  return status === "Draft" || status === "Validated";
}

export function canValidateBatch(status) {
  return status === "Draft" || status === "Validated";
}

export function canGenerateBatch(status) {
  return status === "Validated";
}

export function canDownloadBatch(status) {
  return status === "Exported";
}

export function confirmGenerateMessage(batch, items = []) {
  const ids = items.map((i) => i.job_sheet_id).filter(Boolean);
  const listed = ids.slice(0, 8).join(", ");
  const more = ids.length > 8 ? ` (+${ids.length - 8} more)` : "";
  return `Generate ${batch?.export_type || "export"} for ${ids.length} job(s): ${listed}${more}? This freezes the batch as Exported. No Xero or payroll posting will occur.`;
}

export function isWideLayout(viewportWidth) {
  return Number(viewportWidth) >= 720;
}
