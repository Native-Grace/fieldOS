/** Pure helpers for the Phase 3E rates & financial staging UI (no React). */

export const RATE_STATUSES = ["Active", "Inactive"];

export const SNAPSHOT_STATUSES = ["Draft", "Validated", "Approved", "Superseded", "Cancelled"];

export const RATE_TABS = [
  { key: "rate_cards", label: "Rate cards" },
  { key: "labour_rates", label: "Labour rates" },
  { key: "machinery_rates", label: "Machinery rates" },
  { key: "material_catalog", label: "Material catalog" },
  { key: "customer_pricing", label: "Customer pricing" },
  { key: "payroll_mappings", label: "Payroll mappings" },
  { key: "xero_mappings", label: "Xero mappings" },
  { key: "financial_snapshots", label: "Financial snapshots" },
];

/** Labour rate resolution order — most specific match wins. */
export const RATE_SOURCE_PRECEDENCE = [
  "customer_project_override",
  "customer_override",
  "staff_specific",
  "role_activity",
  "default_rate_card",
];

export const RATE_SOURCE_LABELS = {
  customer_project_override: "Customer + project override",
  customer_override: "Customer override",
  staff_specific: "Staff specific",
  role_activity: "Role / activity",
  default_rate_card: "Default rate card",
  machinery_rate: "Machinery rate",
  material_catalog: "Material catalog",
  non_billable: "Non-billable (zero)",
  unresolved: "Unresolved",
};

export function isManagerRole(role) {
  const r = String(role || "").trim().toLowerCase();
  return r === "manager" || r === "admin" || r === "administrator";
}

export function tabLabel(key) {
  const tab = RATE_TABS.find((entry) => entry.key === key);
  return tab ? tab.label : "";
}

export function buildRatesQuery(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "" || value === false) return;
    params.set(key, String(value));
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Money strings arrive as decimal text ("85.00"). Never re-derive totals in the browser. */
export function formatMoneyDisplay(value, currency = "AUD") {
  if (value === null || value === undefined || value === "") return "—";
  const text = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return "—";
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace("-", "").split(".");
  const cents = `${fraction}00`.slice(0, 2);
  const prefix = currency ? `${currency} ` : "";
  return `${negative ? "-" : ""}${prefix}${whole}.${cents}`;
}

export function rateSourceLabel(sourceType) {
  const key = String(sourceType || "").trim();
  if (!key) return "—";
  return RATE_SOURCE_LABELS[key] || key;
}

/** 1-based position in the labour precedence chain, or null for non-labour sources. */
export function precedenceRank(sourceType) {
  const index = RATE_SOURCE_PRECEDENCE.indexOf(String(sourceType || "").trim());
  return index === -1 ? null : index + 1;
}

export function canValidateSnapshot(status) {
  const value = String(status || "").trim();
  return value === "Draft" || value === "Validated";
}

export function canApproveSnapshot(status) {
  return String(status || "").trim() === "Validated";
}

export function canSupersedeSnapshot(status) {
  return String(status || "").trim() === "Approved";
}

export function snapshotStatusTone(status) {
  const value = String(status || "").trim();
  if (value === "Approved" || value === "Validated") return "ok";
  if (value === "Superseded" || value === "Cancelled") return "warn";
  return "muted";
}

export function readinessTone(ready) {
  return ready ? "ok" : "warn";
}

export function confirmApproveMessage(snapshot = {}) {
  const total = formatMoneyDisplay(snapshot.total_inc_tax, snapshot.currency || "AUD");
  return (
    `Approve financial snapshot ${snapshot.financial_snapshot_id || "(unsaved)"} for completion ` +
    `${snapshot.completion_id || "(unknown)"}? Total ${total} across ${snapshot.line_count || 0} ` +
    "line(s) becomes immutable — you must supersede it to reprice. " +
    "Nothing is posted to Xero or payroll."
  );
}

export function overlapWarningText(overlaps = []) {
  const rows = (overlaps || []).filter(Boolean);
  if (!rows.length) return "";
  const pairs = rows
    .slice(0, 5)
    .map((row) => `${row.a_id || "?"} / ${row.b_id || "?"}`)
    .join(", ");
  const more = rows.length > 5 ? ` (+${rows.length - 5} more)` : "";
  const plural = rows.length === 1 ? "" : "s";
  return (
    `${rows.length} overlapping active effective-date range${plural}: ${pairs}${more}. ` +
    "Rate resolution may pick an unintended row — close one range before pricing."
  );
}

export function staleConflictMessage(label = "Record") {
  return `${label} changed elsewhere (409). Reload it and try again.`;
}

export function emptyRowsMessage(tabKey) {
  const label = tabLabel(tabKey) || "records";
  return `No ${label.toLowerCase()} yet. Add one below — effective dates decide which row prices a job.`;
}

/** Drop blanks so PATCH/POST bodies never overwrite stored values with empty strings. */
export function pruneBlanks(record = {}) {
  const out = {};
  Object.entries(record).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (typeof value === "string" && value.trim() === "") return;
    out[key] = typeof value === "string" ? value.trim() : value;
  });
  return out;
}

export function readinessCards(readiness = {}) {
  const totals = readiness.totals_preview || {};
  return [
    {
      key: "invoice",
      label: "Invoice pricing",
      value: readiness.invoice_pricing_ready ? "Ready" : "Blocked",
    },
    {
      key: "payroll",
      label: "Payroll mapping",
      value: readiness.payroll_mapping_ready ? "Ready" : "Blocked",
    },
    { key: "pricing_status", label: "Pricing status", value: readiness.pricing_status || "—" },
    {
      key: "subtotal",
      label: "Subtotal ex tax",
      value: formatMoneyDisplay(totals.subtotal_ex_tax, totals.currency || "AUD"),
    },
    {
      key: "tax",
      label: `Tax (${totals.tax_type || "unresolved"})`,
      value: formatMoneyDisplay(totals.tax_amount, totals.currency || "AUD"),
    },
    {
      key: "total",
      label: "Total inc tax",
      value: formatMoneyDisplay(totals.total_inc_tax, totals.currency || "AUD"),
    },
  ];
}

export function isWideLayout(viewportWidth) {
  return Number(viewportWidth) >= 720;
}
