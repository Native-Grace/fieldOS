import { useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { ApiError, api, clearSession, getStaff } from "../api";
import {
  RATE_SOURCE_PRECEDENCE,
  RATE_STATUSES,
  RATE_TABS,
  SNAPSHOT_STATUSES,
  buildRatesQuery,
  canApproveSnapshot,
  canSupersedeSnapshot,
  canValidateSnapshot,
  confirmApproveMessage,
  emptyRowsMessage,
  formatMoneyDisplay,
  isManagerRole,
  overlapWarningText,
  precedenceRank,
  pruneBlanks,
  rateSourceLabel,
  readinessCards,
  readinessTone,
  snapshotStatusTone,
  staleConflictMessage,
} from "../ratesFinancialHelpers.mjs";

const STATUS_FIELD = { key: "status", label: "Status", type: "select", options: RATE_STATUSES };

const EFFECTIVE_FIELDS = [
  { key: "effective_from", label: "Effective from", type: "date" },
  { key: "effective_to", label: "Effective to", type: "date" },
];

function statusIsActive(row, field = "status") {
  return String(row?.[field] || "").trim() === "Active";
}

function catalogIsActive(row) {
  return String(row?.active ?? "").trim().toUpperCase() !== "FALSE";
}

/**
 * One declarative entry per rate table: list/create path, create-form fields, table columns.
 * Financial snapshots are handled separately because they are a lifecycle, not a row editor.
 */
const TABS = {
  rate_cards: {
    path: "/rate-cards",
    idField: "rate_card_id",
    label: "Rate card",
    filters: ["on_date", "include_inactive"],
    statusField: "status",
    isActive: (row) => statusIsActive(row),
    fields: [
      { key: "card_name", label: "Card name" },
      { key: "currency", label: "Currency", placeholder: "AUD" },
      { key: "description", label: "Description" },
      STATUS_FIELD,
      ...EFFECTIVE_FIELDS,
      { key: "notes", label: "Notes" },
    ],
    columns: ["rate_card_id", "card_name", "currency", "effective_from", "effective_to"],
  },
  labour_rates: {
    path: "/rates/labour",
    idField: "labour_rate_id",
    label: "Labour rate",
    filters: ["on_date", "include_inactive", "rate_card_id", "customer_id", "staff_id"],
    statusField: "status",
    isActive: (row) => statusIsActive(row),
    money: ["sell_rate", "cost_rate", "travel_rate", "overtime_rate"],
    fields: [
      { key: "rate_card_id", label: "Rate card ID" },
      { key: "staff_id", label: "Staff ID" },
      { key: "customer_id", label: "Customer ID" },
      { key: "project_id", label: "Project ID" },
      { key: "role_code", label: "Role code" },
      { key: "activity_code", label: "Activity code" },
      { key: "unit", label: "Unit", placeholder: "hour" },
      { key: "sell_rate", label: "Sell rate", type: "money" },
      { key: "cost_rate", label: "Cost rate", type: "money" },
      { key: "travel_rate", label: "Travel rate", type: "money" },
      { key: "overtime_rate", label: "Overtime rate", type: "money" },
      STATUS_FIELD,
      ...EFFECTIVE_FIELDS,
      { key: "notes", label: "Notes" },
    ],
    columns: [
      "labour_rate_id",
      "rate_card_id",
      "staff_id",
      "customer_id",
      "project_id",
      "role_code",
      "unit",
      "sell_rate",
      "travel_rate",
      "overtime_rate",
      "effective_from",
      "effective_to",
    ],
  },
  machinery_rates: {
    path: "/rates/machinery",
    idField: "machinery_rate_id",
    label: "Machinery rate",
    filters: ["on_date", "include_inactive", "rate_card_id"],
    statusField: "status",
    isActive: (row) => statusIsActive(row),
    money: ["sell_rate", "cost_rate", "minimum_charge"],
    fields: [
      { key: "rate_card_id", label: "Rate card ID" },
      { key: "equipment_id", label: "Equipment ID" },
      { key: "equipment_name", label: "Equipment name" },
      { key: "charge_code", label: "Charge code" },
      { key: "unit", label: "Unit", placeholder: "hour" },
      { key: "sell_rate", label: "Sell rate", type: "money" },
      { key: "cost_rate", label: "Cost rate", type: "money" },
      { key: "minimum_charge", label: "Minimum charge", type: "money" },
      STATUS_FIELD,
      ...EFFECTIVE_FIELDS,
      { key: "notes", label: "Notes" },
    ],
    columns: [
      "machinery_rate_id",
      "rate_card_id",
      "equipment_id",
      "equipment_name",
      "charge_code",
      "unit",
      "sell_rate",
      "minimum_charge",
      "effective_from",
      "effective_to",
    ],
  },
  material_catalog: {
    path: "/materials/catalog",
    idField: "material_id",
    label: "Material",
    filters: ["include_inactive"],
    statusField: "active",
    activeValue: "TRUE",
    inactiveValue: "FALSE",
    isActive: catalogIsActive,
    money: ["cost_price", "sell_price"],
    note: "Catalog items are matched by material_id or item_code only — never by name.",
    fields: [
      { key: "item_code", label: "Item code" },
      { key: "item_name", label: "Item name" },
      { key: "description", label: "Description" },
      { key: "unit", label: "Unit" },
      { key: "cost_price", label: "Cost price", type: "money" },
      { key: "sell_price", label: "Sell price", type: "money" },
      { key: "tax_code", label: "Tax code" },
      { key: "account_code", label: "Account code" },
      { key: "supplier", label: "Supplier" },
      { key: "active", label: "Active", type: "select", options: ["TRUE", "FALSE"] },
      { key: "notes", label: "Notes" },
    ],
    columns: [
      "material_id",
      "item_code",
      "item_name",
      "unit",
      "cost_price",
      "sell_price",
      "tax_code",
      "account_code",
      "supplier",
    ],
  },
  customer_pricing: {
    path: "/pricing/customer",
    idField: "customer_pricing_id",
    label: "Customer pricing",
    filters: ["on_date", "include_inactive", "customer_id", "rate_card_id"],
    statusField: "status",
    isActive: (row) => statusIsActive(row),
    note: "Project-scoped pricing wins over customer-wide pricing for the same job date.",
    fields: [
      { key: "customer_id", label: "Customer ID" },
      { key: "project_id", label: "Project ID" },
      { key: "rate_card_id", label: "Rate card ID" },
      { key: "price_notes", label: "Price notes" },
      STATUS_FIELD,
      ...EFFECTIVE_FIELDS,
      { key: "notes", label: "Notes" },
    ],
    columns: [
      "customer_pricing_id",
      "customer_id",
      "project_id",
      "rate_card_id",
      "price_notes",
      "effective_from",
      "effective_to",
    ],
  },
  payroll_mappings: {
    path: "/mappings/payroll",
    idField: "payroll_mapping_id",
    label: "Payroll mapping",
    filters: ["on_date", "include_inactive", "staff_id"],
    statusField: "status",
    isActive: (row) => statusIsActive(row),
    note: "Staging only — FieldOS never posts to a payroll system.",
    fields: [
      { key: "staff_id", label: "Staff ID" },
      { key: "employee_reference", label: "Employee reference" },
      { key: "ordinary_hours_code", label: "Ordinary hours code" },
      { key: "overtime_hours_code", label: "Overtime hours code" },
      { key: "travel_hours_code", label: "Travel hours code" },
      { key: "allowance_code", label: "Allowance code" },
      { key: "cost_centre", label: "Cost centre" },
      { key: "pay_calendar", label: "Pay calendar" },
      STATUS_FIELD,
      ...EFFECTIVE_FIELDS,
      { key: "notes", label: "Notes" },
    ],
    columns: [
      "payroll_mapping_id",
      "staff_id",
      "employee_reference",
      "ordinary_hours_code",
      "overtime_hours_code",
      "travel_hours_code",
      "cost_centre",
      "pay_calendar",
      "effective_from",
      "effective_to",
    ],
  },
  xero_mappings: {
    path: "/mappings/xero",
    idField: "xero_mapping_id",
    label: "Xero mapping",
    filters: ["include_inactive", "entity_type"],
    statusField: "status",
    isActive: (row) => statusIsActive(row),
    note: "Tax type and rate come from this table only — GST is never assumed.",
    fields: [
      {
        key: "entity_type",
        label: "Entity type",
        type: "select",
        options: ["customer", "labour", "machinery", "material"],
      },
      { key: "local_reference", label: "Local reference" },
      { key: "xero_reference", label: "Xero reference" },
      { key: "account_code", label: "Account code" },
      { key: "tax_type", label: "Tax type" },
      { key: "tax_rate_percent", label: "Tax rate %", type: "number" },
      { key: "tracking_category", label: "Tracking category" },
      { key: "tracking_option", label: "Tracking option" },
      STATUS_FIELD,
      { key: "notes", label: "Notes" },
    ],
    columns: [
      "xero_mapping_id",
      "entity_type",
      "local_reference",
      "xero_reference",
      "account_code",
      "tax_type",
      "tax_rate_percent",
      "tracking_category",
    ],
  },
};

const FILTER_LABELS = {
  on_date: "Effective on date",
  include_inactive: "Include inactive",
  rate_card_id: "Rate card ID",
  customer_id: "Customer ID",
  staff_id: "Staff ID",
  entity_type: "Entity type",
};

function emptyForm(config) {
  const form = {};
  config.fields.forEach((field) => {
    form[field.key] = "";
  });
  return form;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function RatesFinancialPage() {
  const staff = getStaff();
  const manager = isManagerRole(staff?.role);
  const [activeTab, setActiveTab] = useState(RATE_TABS[0].key);
  const [filters, setFilters] = useState({ on_date: todayIso(), include_inactive: false });
  const [rows, setRows] = useState([]);
  const [overlaps, setOverlaps] = useState([]);
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [completionId, setCompletionId] = useState("");
  const [readiness, setReadiness] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [snapshotFilter, setSnapshotFilter] = useState("");
  const [snapshot, setSnapshot] = useState(null);
  const [lines, setLines] = useState([]);
  const [snapshotNotes, setSnapshotNotes] = useState("");

  const config = TABS[activeTab];
  const isSnapshotTab = activeTab === "financial_snapshots";

  useEffect(() => {
    if (!manager || !config) return;
    setForm(emptyForm(config));
    loadRows(activeTab, filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, activeTab]);

  const overlapText = useMemo(() => overlapWarningText(overlaps), [overlaps]);
  const cards = useMemo(() => (readiness ? readinessCards(readiness) : []), [readiness]);

  if (!manager) {
    return <Navigate to="/" replace />;
  }

  function describeError(err, label) {
    if (err instanceof ApiError && err.status === 409) return staleConflictMessage(label);
    return err.message || `${label} request failed`;
  }

  async function loadRows(tabKey, nextFilters) {
    const tab = TABS[tabKey];
    if (!tab) return;
    setLoading(true);
    setError("");
    try {
      const query = {};
      tab.filters.forEach((key) => {
        query[key] = nextFilters[key];
      });
      const result = await api(`${tab.path}${buildRatesQuery(query)}`);
      setRows(result.items || []);
      setOverlaps(result.overlaps || []);
    } catch (err) {
      setRows([]);
      setOverlaps([]);
      setError(describeError(err, tab.label));
    } finally {
      setLoading(false);
    }
  }

  function onFilterChange(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function applyFilters(event) {
    event.preventDefault();
    loadRows(activeTab, filters);
  }

  async function createRow(event) {
    event.preventDefault();
    setBusy("create");
    setError("");
    setMessage("");
    try {
      const result = await api(config.path, { method: "POST", json: pruneBlanks(form) });
      setMessage(`${config.label} ${result.item?.[config.idField] || ""} created.`);
      setForm(emptyForm(config));
      await loadRows(activeTab, filters);
    } catch (err) {
      setError(describeError(err, config.label));
    } finally {
      setBusy("");
    }
  }

  async function toggleRowStatus(row) {
    const field = config.statusField;
    const activeValue = config.activeValue || "Active";
    const inactiveValue = config.inactiveValue || "Inactive";
    const next = config.isActive(row) ? inactiveValue : activeValue;
    setBusy(`status-${row[config.idField]}`);
    setError("");
    setMessage("");
    try {
      await api(`${config.path}/${encodeURIComponent(row[config.idField])}`, {
        method: "PATCH",
        json: { [field]: next, expected_version: row.version },
      });
      setMessage(`${config.label} ${row[config.idField]} set to ${next}.`);
      await loadRows(activeTab, filters);
    } catch (err) {
      setError(describeError(err, config.label));
    } finally {
      setBusy("");
    }
  }

  async function loadReadiness() {
    const id = completionId.trim();
    if (!id) {
      setError("Enter a completion_id first.");
      return;
    }
    setBusy("readiness");
    setError("");
    setMessage("");
    try {
      const [ready, list] = await Promise.all([
        api(`/completions/${encodeURIComponent(id)}/pricing/readiness`),
        api(
          `/completions/${encodeURIComponent(id)}/financial-snapshots` +
            buildRatesQuery({ snapshot_status: snapshotFilter })
        ),
      ]);
      setReadiness(ready);
      setSnapshots(list.items || []);
      setSnapshot(null);
      setLines([]);
    } catch (err) {
      setReadiness(null);
      setSnapshots([]);
      setError(describeError(err, "Pricing readiness"));
    } finally {
      setBusy("");
    }
  }

  async function refreshSnapshots(id) {
    const list = await api(
      `/completions/${encodeURIComponent(id)}/financial-snapshots` +
        buildRatesQuery({ snapshot_status: snapshotFilter })
    );
    setSnapshots(list.items || []);
  }

  function applySnapshot(result, note) {
    setSnapshot(result.financial_snapshot || null);
    setLines(result.lines || []);
    if (note) setMessage(note);
  }

  async function createSnapshot() {
    const id = completionId.trim();
    if (!id) {
      setError("Enter a completion_id first.");
      return;
    }
    setBusy("create-snapshot");
    setError("");
    setMessage("");
    try {
      const result = await api(`/completions/${encodeURIComponent(id)}/financial-snapshots`, {
        method: "POST",
        json: pruneBlanks({ notes: snapshotNotes }),
      });
      applySnapshot(
        result,
        `Draft snapshot ${result.financial_snapshot?.financial_snapshot_id || ""} created.`
      );
      setSnapshotNotes("");
      await refreshSnapshots(id);
    } catch (err) {
      setError(describeError(err, "Financial snapshot"));
    } finally {
      setBusy("");
    }
  }

  async function openSnapshot(snapshotId) {
    setBusy("open-snapshot");
    setError("");
    try {
      const result = await api(`/financial-snapshots/${encodeURIComponent(snapshotId)}`);
      applySnapshot(result);
    } catch (err) {
      setError(describeError(err, "Financial snapshot"));
    } finally {
      setBusy("");
    }
  }

  async function snapshotAction(action, extra = {}, note = "") {
    if (!snapshot) return;
    setBusy(action);
    setError("");
    setMessage("");
    try {
      const result = await api(
        `/financial-snapshots/${encodeURIComponent(snapshot.financial_snapshot_id)}/${action}`,
        { method: "POST", json: { expected_version: snapshot.version, ...extra } }
      );
      applySnapshot(result, note);
      await refreshSnapshots(result.financial_snapshot?.completion_id || completionId.trim());
    } catch (err) {
      setError(describeError(err, "Financial snapshot"));
    } finally {
      setBusy("");
    }
  }

  async function validateSnapshot() {
    await snapshotAction("validate", {}, "Snapshot validated — check remaining blockers below.");
  }

  async function approveSnapshot() {
    if (!window.confirm(confirmApproveMessage(snapshot))) return;
    await snapshotAction("approve", {}, "Snapshot approved and frozen.");
  }

  async function supersedeSnapshot() {
    const reason = window.prompt("Reason for superseding this approved snapshot?");
    if (!reason || !reason.trim()) return;
    await snapshotAction("supersede", { reason: reason.trim() }, "Snapshot superseded.");
  }

  function logout() {
    clearSession();
    window.location.href = "/login";
  }

  function renderCell(row, column) {
    const value = row[column];
    if ((config.money || []).includes(column)) return formatMoneyDisplay(value, "");
    if (value === null || value === undefined || value === "") return "—";
    return String(value);
  }

  function renderField(field) {
    const value = form[field.key] ?? "";
    const onChange = (event) => setForm((prev) => ({ ...prev, [field.key]: event.target.value }));
    if (field.type === "select") {
      return (
        <select value={value} onChange={onChange}>
          <option value="">—</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
    return (
      <input
        type={field.type === "date" ? "date" : "text"}
        inputMode={field.type === "money" || field.type === "number" ? "decimal" : undefined}
        value={value}
        placeholder={field.placeholder || (field.type === "money" ? "0.00" : "")}
        onChange={onChange}
      />
    );
  }

  return (
    <div className="dashboard-page">
      <div className="topbar">
        <div>
          <h1>Rates &amp; Financial Staging</h1>
          <p className="small muted" style={{ margin: 0 }}>
            {staff?.staff_name} · staging only — no Xero or payroll posting
          </p>
        </div>
        <div className="topbar-actions">
          <Link className="btn btn-ghost" style={{ width: "auto", textDecoration: "none" }} to="/">
            Jobs
          </Link>
          <Link
            className="btn btn-ghost"
            style={{ width: "auto", textDecoration: "none" }}
            to="/completions"
          >
            Completions
          </Link>
          <button className="btn btn-ghost" style={{ width: "auto" }} onClick={logout} type="button">
            Log out
          </button>
        </div>
      </div>

      <div className="card">
        <div className="panel-actions" style={{ marginBottom: 0 }}>
          {RATE_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`btn ${activeTab === tab.key ? "btn-primary" : "btn-ghost"}`}
              style={{ width: "auto" }}
              onClick={() => {
                setActiveTab(tab.key);
                setError("");
                setMessage("");
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}
      {message && <div className="ok-box">{message}</div>}
      {overlapText && !isSnapshotTab && <div className="warn-box">{overlapText}</div>}

      {!isSnapshotTab && config && (
        <>
          <form className="card filter-panel" onSubmit={applyFilters}>
            <div className="filter-grid">
              {config.filters.map((key) =>
                key === "include_inactive" ? (
                  <label className="field" key={key}>
                    <span>{FILTER_LABELS[key]}</span>
                    <select
                      value={filters.include_inactive ? "true" : "false"}
                      onChange={(e) => onFilterChange("include_inactive", e.target.value === "true")}
                    >
                      <option value="false">Active only</option>
                      <option value="true">Include inactive</option>
                    </select>
                  </label>
                ) : (
                  <label className="field" key={key}>
                    <span>{FILTER_LABELS[key]}</span>
                    <input
                      type={key === "on_date" ? "date" : "text"}
                      value={filters[key] || ""}
                      onChange={(e) => onFilterChange(key, e.target.value)}
                    />
                  </label>
                )
              )}
            </div>
            <button className="btn btn-primary" type="submit" disabled={loading || !!busy}>
              Apply filters
            </button>
          </form>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>{config.label} rows</h2>
            {config.note && <p className="small muted">{config.note}</p>}
            {loading && <p className="muted">Loading {config.label.toLowerCase()} rows…</p>}
            {!loading && rows.length === 0 && <p className="muted">{emptyRowsMessage(activeTab)}</p>}
            {!loading && rows.length > 0 && (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      {config.columns.map((column) => (
                        <th key={column}>{column.replace(/_/g, " ")}</th>
                      ))}
                      <th>Active</th>
                      <th>Version</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const rowId = row[config.idField];
                      const active = config.isActive(row);
                      return (
                        <tr key={rowId}>
                          {config.columns.map((column) => (
                            <td key={column} className="small">
                              {renderCell(row, column)}
                            </td>
                          ))}
                          <td>
                            <span className={`badge ${active ? "ok" : "muted"}`}>
                              {active ? "Active" : "Inactive"}
                            </span>
                          </td>
                          <td className="small">v{row.version ?? 1}</td>
                          <td>
                            <button
                              className="btn btn-ghost"
                              type="button"
                              style={{ width: "auto" }}
                              disabled={!!busy}
                              onClick={() => toggleRowStatus(row)}
                            >
                              {active ? "Deactivate" : "Activate"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <form className="card" onSubmit={createRow}>
            <h2 style={{ marginTop: 0 }}>Add {config.label.toLowerCase()}</h2>
            <p className="small muted">
              Effective dates are inclusive; leave “Effective to” blank for an open-ended row.
            </p>
            <div className="filter-grid">
              {config.fields.map((field) => (
                <label className="field" key={field.key}>
                  <span>{field.label}</span>
                  {renderField(field)}
                </label>
              ))}
            </div>
            <button className="btn btn-primary" type="submit" disabled={!!busy || loading}>
              Create {config.label.toLowerCase()}
            </button>
          </form>
        </>
      )}

      {isSnapshotTab && (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Completion pricing</h2>
            <div className="filter-grid">
              <label className="field">
                <span>Completion ID</span>
                <input
                  value={completionId}
                  onChange={(e) => setCompletionId(e.target.value)}
                  placeholder="CMP-…"
                />
              </label>
              <label className="field">
                <span>Snapshot status filter</span>
                <select value={snapshotFilter} onChange={(e) => setSnapshotFilter(e.target.value)}>
                  <option value="">Any</option>
                  {SNAPSHOT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="panel-actions">
              <button
                className="btn btn-primary"
                type="button"
                style={{ width: "auto" }}
                disabled={!!busy}
                onClick={loadReadiness}
              >
                Load readiness
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                style={{ width: "auto" }}
                disabled={!!busy || !readiness}
                onClick={createSnapshot}
              >
                Create draft snapshot
              </button>
              <label className="field" style={{ margin: 0, minWidth: 220 }}>
                <span>Snapshot notes</span>
                <input
                  value={snapshotNotes}
                  onChange={(e) => setSnapshotNotes(e.target.value)}
                  placeholder="Optional"
                />
              </label>
            </div>
          </div>

          {!readiness && !busy && (
            <div className="card">
              Enter a completion_id and load readiness to see resolved rates, blockers, and
              snapshots.
            </div>
          )}

          {readiness && (
            <>
              <div className="metric-grid">
                {cards.map((card) => (
                  <div key={card.key} className="metric-card">
                    <div className="metric-label">{card.label}</div>
                    <div className="metric-value">{card.value}</div>
                  </div>
                ))}
              </div>

              <div className="card">
                <h2 style={{ marginTop: 0 }}>Identity &amp; blockers</h2>
                <p className="small muted">
                  Job {readiness.job_sheet_id || "—"} · customer {readiness.identity?.customer_id || "—"}{" "}
                  ({readiness.identity?.customer_name || "unnamed"}) · project{" "}
                  {readiness.identity?.project_id || "—"} · job date{" "}
                  {readiness.identity?.job_date || "unresolved"} · rate card{" "}
                  {readiness.identity?.rate_card_id || "default"} · identity match{" "}
                  {readiness.identity?.match || "none"}
                  {readiness.xero_customer_reference
                    ? ` · Xero contact ${readiness.xero_customer_reference}`
                    : ""}
                </p>
                <p className="small">
                  <span className={`badge ${readinessTone(readiness.invoice_pricing_ready)}`}>
                    Invoice {readiness.invoice_pricing_ready ? "ready" : "blocked"}
                  </span>{" "}
                  <span className={`badge ${readinessTone(readiness.payroll_mapping_ready)}`}>
                    Payroll {readiness.payroll_mapping_ready ? "ready" : "blocked"}
                  </span>
                </p>
                {(readiness.invoice_blockers || []).length > 0 && (
                  <div className="warn-box">
                    <strong>Invoice blockers</strong>
                    <ul className="warning-list">
                      {readiness.invoice_blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {(readiness.payroll_blockers || []).length > 0 && (
                  <div className="warn-box">
                    <strong>Payroll blockers</strong>
                    <ul className="warning-list">
                      {readiness.payroll_blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {(readiness.invoice_blockers || []).length === 0 &&
                  (readiness.payroll_blockers || []).length === 0 && (
                    <p className="muted">No blockers — this completion can be snapshotted.</p>
                  )}
              </div>

              {(readiness.sample_rates || []).length > 0 && (
                <div className="card">
                  <h2 style={{ marginTop: 0 }}>Resolved rates &amp; source precedence</h2>
                  <p className="small muted">
                    Labour precedence:{" "}
                    {RATE_SOURCE_PRECEDENCE.map((source, index) => (
                      <span key={source}>
                        {index + 1}. {rateSourceLabel(source)}
                        {index < RATE_SOURCE_PRECEDENCE.length - 1 ? " → " : ""}
                      </span>
                    ))}
                  </p>
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Description</th>
                          <th>Qty</th>
                          <th>Unit sell</th>
                          <th>Rate source</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {readiness.sample_rates.map((rate, index) => {
                          const rank = precedenceRank(rate.rate_source_type);
                          return (
                            <tr key={`${rate.source_row_id}-${index}`}>
                              <td className="small">{rate.line_type}</td>
                              <td className="small">
                                {rate.description}
                                <div className="muted">{rate.source_row_id || "—"}</div>
                              </td>
                              <td className="small">
                                {rate.quantity ?? "—"} {rate.unit}
                              </td>
                              <td className="small">{formatMoneyDisplay(rate.unit_sell, "")}</td>
                              <td className="small">
                                {rank ? `${rank}. ` : ""}
                                {rateSourceLabel(rate.rate_source_type)}
                                <div className="muted">{rate.rate_source_id || "—"}</div>
                              </td>
                              <td className="small">
                                <span className={`badge ${rate.resolved ? "ok" : "warn"}`}>
                                  {rate.resolved ? "Resolved" : "Blocked"}
                                </span>
                                {rate.non_billable_reason && (
                                  <div className="muted">{rate.non_billable_reason}</div>
                                )}
                                {(rate.blockers || []).map((blocker) => (
                                  <div className="muted" key={blocker}>
                                    {blocker}
                                  </div>
                                ))}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {(readiness.payroll_mappings || []).length > 0 && (
                <div className="card">
                  <h2 style={{ marginTop: 0 }}>Payroll mapping status</h2>
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Staff</th>
                          <th>Work date</th>
                          <th>Mapping</th>
                          <th>Blockers</th>
                        </tr>
                      </thead>
                      <tbody>
                        {readiness.payroll_mappings.map((row) => (
                          <tr key={`${row.staff_id}-${row.work_date}`}>
                            <td className="small">{row.staff_id}</td>
                            <td className="small">{row.work_date || "—"}</td>
                            <td className="small">
                              <span className={`badge ${row.resolved ? "ok" : "warn"}`}>
                                {row.resolved ? "Resolved" : "Missing"}
                              </span>
                              <div className="muted">{row.source_id || "—"}</div>
                            </td>
                            <td className="small">{(row.blockers || []).join("; ") || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {(readiness.material_suggestions || []).length > 0 && (
                <div className="card">
                  <h2 style={{ marginTop: 0 }}>Unmatched materials</h2>
                  <p className="small muted">
                    Suggestions are name similarity only — link a catalog item by code before
                    pricing.
                  </p>
                  <ul className="warning-list">
                    {readiness.material_suggestions.map((suggestion) => (
                      <li key={suggestion.source_row_id} className="small">
                        {suggestion.item_name || suggestion.source_row_id}:{" "}
                        {(suggestion.suggested_matches || [])
                          .map((match) => `${match.item_code || match.material_id} ${match.item_name}`)
                          .join(", ") || "no similar catalog items"}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          <div className="card">
            <h2 style={{ marginTop: 0 }}>Financial snapshots</h2>
            {snapshots.length === 0 ? (
              <p className="muted">No snapshots for this completion yet.</p>
            ) : (
              <ul className="batch-list">
                {snapshots.map((row) => (
                  <li key={row.financial_snapshot_id}>
                    <button
                      type="button"
                      className="batch-link"
                      disabled={!!busy}
                      onClick={() => openSnapshot(row.financial_snapshot_id)}
                    >
                      <strong>{row.financial_snapshot_id}</strong> · {row.snapshot_status} ·{" "}
                      {row.line_count} line(s) ·{" "}
                      {formatMoneyDisplay(row.total_inc_tax, "AUD")} · v{row.version}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {snapshot && (
              <div className="selected-batch">
                <h3>
                  {snapshot.financial_snapshot_id}{" "}
                  <span className={`badge ${snapshotStatusTone(snapshot.snapshot_status)}`}>
                    {snapshot.snapshot_status}
                  </span>
                </h3>
                <p className="small muted">
                  {snapshot.draft_reference || "no draft reference"} · job {snapshot.job_sheet_id} ·{" "}
                  {snapshot.job_date} · pricing {snapshot.pricing_status} · v{snapshot.version}
                  <br />
                  Subtotal {formatMoneyDisplay(snapshot.subtotal_ex_tax, snapshot.currency)} · tax{" "}
                  {formatMoneyDisplay(snapshot.tax_amount, snapshot.currency)} (
                  {snapshot.tax_type || "unresolved"}) · total{" "}
                  {formatMoneyDisplay(snapshot.total_inc_tax, snapshot.currency)}
                </p>
                {(snapshot.blockers || []).length > 0 && (
                  <div className="warn-box">
                    <strong>Snapshot blockers</strong>
                    <ul className="warning-list">
                      {snapshot.blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="panel-actions">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    style={{ width: "auto" }}
                    disabled={!!busy || !canValidateSnapshot(snapshot.snapshot_status)}
                    onClick={validateSnapshot}
                  >
                    Validate
                  </button>
                  <button
                    className="btn btn-primary"
                    type="button"
                    style={{ width: "auto" }}
                    disabled={!!busy || !canApproveSnapshot(snapshot.snapshot_status)}
                    onClick={approveSnapshot}
                  >
                    Approve
                  </button>
                  <button
                    className="btn btn-danger"
                    type="button"
                    style={{ width: "auto" }}
                    disabled={!!busy || !canSupersedeSnapshot(snapshot.snapshot_status)}
                    onClick={supersedeSnapshot}
                  >
                    Supersede
                  </button>
                </div>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Type</th>
                        <th>Description</th>
                        <th>Qty</th>
                        <th>Unit sell</th>
                        <th>Ex tax</th>
                        <th>Tax</th>
                        <th>Inc tax</th>
                        <th>Rate source</th>
                        <th>Blockers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line) => (
                        <tr key={line.financial_line_id || line.line_number}>
                          <td className="small">{line.line_number}</td>
                          <td className="small">{line.line_type}</td>
                          <td className="small">
                            {line.description}
                            {!line.billable && (
                              <div className="muted">{line.non_billable_reason || "Non-billable"}</div>
                            )}
                          </td>
                          <td className="small">
                            {line.quantity ?? "—"} {line.unit}
                          </td>
                          <td className="small">{formatMoneyDisplay(line.unit_sell, "")}</td>
                          <td className="small">{formatMoneyDisplay(line.line_amount_ex_tax, "")}</td>
                          <td className="small">
                            {formatMoneyDisplay(line.tax_amount, "")}
                            <div className="muted">{line.tax_type || "—"}</div>
                          </td>
                          <td className="small">
                            {formatMoneyDisplay(line.line_total_inc_tax, "")}
                          </td>
                          <td className="small">
                            {rateSourceLabel(line.rate_source_type)}
                            <div className="muted">{line.rate_source_id || "—"}</div>
                          </td>
                          <td className="small">{(line.blockers || []).join("; ") || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
