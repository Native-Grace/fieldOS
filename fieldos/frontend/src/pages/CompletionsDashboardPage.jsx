import { useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  ApiError,
  api,
  clearSession,
  downloadAuthenticatedFile,
  getStaff,
} from "../api";
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
  readinessBadge,
  summaryCards,
} from "../completionDashboardHelpers.mjs";
import {
  isPricingReadinessEligible,
  ratesPricingPath,
} from "../ratesFinancialHelpers.mjs";

const EMPTY_FILTERS = {
  ...defaultDashboardRange(),
  completion_status: "",
  approval_status: "",
  customer: "",
  project: "",
  assigned_staff_id: "",
  billable: "",
  q: "",
};

export default function CompletionsDashboardPage() {
  const staff = getStaff();
  const manager = isManagerRole(staff?.role);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState({});
  const [batches, setBatches] = useState([]);
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [batchItems, setBatchItems] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [exportType, setExportType] = useState(EXPORT_TYPES[0]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function loadDashboard(nextFilters = applied) {
    setLoading(true);
    setError("");
    try {
      const qs = buildDashboardQuery(nextFilters);
      const [dash, list] = await Promise.all([
        api(`/completions/dashboard${qs}`),
        api("/exports"),
      ]);
      setItems(dash.items || []);
      setSummary(dash.summary || {});
      setBatches(list.items || []);
      setSelectedIds((prev) =>
        prev.filter((id) => (dash.items || []).some((row) => row.completion_id === id))
      );
    } catch (err) {
      setItems([]);
      setSummary({});
      setError(err.message || "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!manager) return;
    loadDashboard(applied);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager]);

  const cards = useMemo(() => summaryCards(summary), [summary]);

  if (!manager) {
    return <Navigate to="/" replace />;
  }

  function onFilterChange(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function applyFilters(event) {
    event.preventDefault();
    setApplied(filters);
    loadDashboard(filters);
  }

  function toggleSelected(completionId) {
    setSelectedIds((prev) =>
      prev.includes(completionId) ? prev.filter((id) => id !== completionId) : [...prev, completionId]
    );
  }

  function selectAllVisible() {
    setSelectedIds(items.map((row) => row.completion_id).filter(Boolean));
  }

  async function createBatch() {
    setBusy("create");
    setError("");
    setMessage("");
    try {
      const body = {
        export_type: exportType,
        date_from: applied.date_from,
        date_to: applied.date_to,
        filters: { ...applied },
      };
      if (selectedIds.length) body.completion_ids = selectedIds;
      const result = await api("/exports", { method: "POST", json: body });
      setSelectedBatch(result.export_batch);
      setBatchItems(result.items || []);
      setMessage(`Draft batch ${result.export_batch.export_batch_id} created with ${result.items.length} job(s).`);
      await loadDashboard(applied);
    } catch (err) {
      setError(err.message || "Failed to create export batch");
    } finally {
      setBusy("");
    }
  }

  async function openBatch(batchId) {
    setBusy("open");
    setError("");
    try {
      const result = await api(`/exports/${encodeURIComponent(batchId)}`);
      setSelectedBatch(result.export_batch);
      setBatchItems(result.items || []);
    } catch (err) {
      setError(err.message || "Failed to load batch");
    } finally {
      setBusy("");
    }
  }

  async function validateBatch() {
    if (!selectedBatch) return;
    setBusy("validate");
    setError("");
    setMessage("");
    try {
      const result = await api(`/exports/${encodeURIComponent(selectedBatch.export_batch_id)}/validate`, {
        method: "POST",
        json: { expected_version: selectedBatch.version },
      });
      setSelectedBatch(result.export_batch);
      setBatchItems(result.items || []);
      const blocked = (result.items || []).filter((i) => i.item_status === "Blocked");
      setMessage(
        blocked.length
          ? `Validated with ${blocked.length} blocker(s).`
          : `Batch ${result.export_batch.export_batch_id} validated.`
      );
      await loadDashboard(applied);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("Batch changed elsewhere (409). Reload the batch and try again.");
      } else {
        setError(err.message || "Validation failed");
      }
    } finally {
      setBusy("");
    }
  }

  async function generateBatch() {
    if (!selectedBatch) return;
    if (!window.confirm(confirmGenerateMessage(selectedBatch, batchItems))) return;
    setBusy("generate");
    setError("");
    setMessage("");
    try {
      const result = await api(`/exports/${encodeURIComponent(selectedBatch.export_batch_id)}/generate`, {
        method: "POST",
        json: { expected_version: selectedBatch.version },
      });
      setSelectedBatch(result.export_batch);
      setBatchItems(result.items || []);
      setMessage(`Generated ${result.export_batch.file_name}. Ready to download.`);
      await loadDashboard(applied);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("Batch changed elsewhere (409). Reload the batch and try again.");
      } else {
        setError(err.message || "Generate failed");
      }
    } finally {
      setBusy("");
    }
  }

  async function cancelBatch() {
    if (!selectedBatch) return;
    if (!window.confirm(`Cancel draft batch ${selectedBatch.export_batch_id}?`)) return;
    setBusy("cancel");
    setError("");
    try {
      const result = await api(`/exports/${encodeURIComponent(selectedBatch.export_batch_id)}/cancel`, {
        method: "POST",
        json: { expected_version: selectedBatch.version },
      });
      setSelectedBatch(result.export_batch);
      setBatchItems(result.items || []);
      setMessage(`Batch ${result.export_batch.export_batch_id} cancelled.`);
      await loadDashboard(applied);
    } catch (err) {
      setError(err.message || "Cancel failed");
    } finally {
      setBusy("");
    }
  }

  async function downloadBatch() {
    if (!selectedBatch) return;
    setBusy("download");
    setError("");
    try {
      const { fileName } = await downloadAuthenticatedFile(
        `/exports/${encodeURIComponent(selectedBatch.export_batch_id)}/download`,
        { fallbackName: selectedBatch.file_name || "export.csv", expectPdf: false }
      );
      setMessage(`Downloaded ${fileName}.`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/login";
        return;
      }
      setError(err.message || "Download failed");
    } finally {
      setBusy("");
    }
  }

  function logout() {
    clearSession();
    window.location.href = "/login";
  }

  return (
    <div className="dashboard-page">
      <div className="topbar">
        <div>
          <h1>Completion Dashboard</h1>
          <p className="small muted" style={{ margin: 0 }}>
            {staff?.staff_name} · staging exports only (no Xero / payroll posting)
          </p>
        </div>
        <div className="topbar-actions">
          <Link className="btn btn-ghost" style={{ width: "auto", textDecoration: "none" }} to="/">
            Jobs
          </Link>
          <Link className="btn btn-ghost" style={{ width: "auto", textDecoration: "none" }} to="/rates">
            Rates &amp; Financial
          </Link>
          <Link className="btn btn-ghost" style={{ width: "auto", textDecoration: "none" }} to="/reports">
            Reports
          </Link>
          <button className="btn btn-ghost" style={{ width: "auto" }} onClick={logout} type="button">
            Log out
          </button>
        </div>
      </div>

      <form className="card filter-panel" onSubmit={applyFilters}>
        <div className="filter-grid">
          <label className="field">
            <span>Date from</span>
            <input
              type="date"
              value={filters.date_from}
              onChange={(e) => onFilterChange("date_from", e.target.value)}
            />
          </label>
          <label className="field">
            <span>Date to</span>
            <input
              type="date"
              value={filters.date_to}
              onChange={(e) => onFilterChange("date_to", e.target.value)}
            />
          </label>
          <label className="field">
            <span>Completion status</span>
            <select
              value={filters.completion_status}
              onChange={(e) => onFilterChange("completion_status", e.target.value)}
            >
              <option value="">Any</option>
              <option value="Draft">Draft</option>
              <option value="Finalised">Finalised</option>
              <option value="Reopened">Reopened</option>
            </select>
          </label>
          <label className="field">
            <span>Approval status</span>
            <select
              value={filters.approval_status}
              onChange={(e) => onFilterChange("approval_status", e.target.value)}
            >
              <option value="">Any</option>
              <option value="Approved">Approved</option>
              <option value="Pending">Pending</option>
              <option value="Returned">Returned</option>
            </select>
          </label>
          <label className="field">
            <span>Customer</span>
            <input
              value={filters.customer}
              onChange={(e) => onFilterChange("customer", e.target.value)}
              placeholder="Contains…"
            />
          </label>
          <label className="field">
            <span>Project</span>
            <input
              value={filters.project}
              onChange={(e) => onFilterChange("project", e.target.value)}
              placeholder="Contains…"
            />
          </label>
          <label className="field">
            <span>Assigned staff ID</span>
            <input
              value={filters.assigned_staff_id}
              onChange={(e) => onFilterChange("assigned_staff_id", e.target.value)}
            />
          </label>
          <label className="field">
            <span>Billable</span>
            <select value={filters.billable} onChange={(e) => onFilterChange("billable", e.target.value)}>
              <option value="">Any</option>
              <option value="true">Has billable labour</option>
              <option value="false">No billable labour</option>
            </select>
          </label>
          <label className="field" style={{ gridColumn: "1 / -1" }}>
            <span>Search</span>
            <input
              value={filters.q}
              onChange={(e) => onFilterChange("q", e.target.value)}
              placeholder="Job, customer, project, summary…"
            />
          </label>
        </div>
        <button className="btn btn-primary" type="submit" disabled={loading || !!busy}>
          Apply filters
        </button>
      </form>

      {error && <div className="error-box">{error}</div>}
      {message && <div className="ok-box">{message}</div>}
      {loading && <p className="muted">Loading completions…</p>}

      {!loading && (
        <div className="metric-grid">
          {cards.map((card) => (
            <div key={card.key} className="metric-card">
              <div className="metric-label">{card.label}</div>
              <div className="metric-value">{card.value}</div>
            </div>
          ))}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="card">No completions match the selected filters.</div>
      )}

      {!loading && items.length > 0 && (
        <div className="card">
          <div className="panel-actions">
            <button className="btn btn-ghost" type="button" onClick={selectAllVisible} style={{ width: "auto" }}>
              Select all visible
            </button>
            <span className="small muted">{selectedIds.length} selected</span>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th />
                  <th>Date</th>
                  <th>Job</th>
                  <th>Customer / project</th>
                  <th>Status</th>
                  <th>Hours</th>
                  <th>Readiness</th>
                  <th>Pricing</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => {
                  const badge = readinessBadge(row);
                  return (
                    <tr key={row.completion_id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(row.completion_id)}
                          onChange={() => toggleSelected(row.completion_id)}
                          aria-label={`Select ${row.job_sheet_id}`}
                        />
                      </td>
                      <td>{row.job_date || "—"}</td>
                      <td>
                        <Link to={`/jobs/${encodeURIComponent(row.job_sheet_id)}`}>{row.job_sheet_id}</Link>
                        <div className="small muted">{row.completion_id}</div>
                      </td>
                      <td>
                        {row.customer_name || "—"}
                        <div className="small muted">{row.project_name || "—"}</div>
                      </td>
                      <td>
                        <span className="badge">{row.completion_status || "—"}</span>{" "}
                        <span className="badge">{row.approval_status || "—"}</span>
                      </td>
                      <td className="small">
                        L {row.total_labour_hours} · T {row.total_travel_hours} · M {row.total_machinery_hours}
                        <div className="muted">
                          Billable {row.billable_labour_hours} / Non {row.non_billable_labour_hours}
                        </div>
                        <div className="muted">Warnings {row.unresolved_warning_count}</div>
                      </td>
                      <td>
                        <span className={`badge ${badge.tone}`}>{badge.label}</span>
                        <div className="small muted">{row.export_status}</div>
                      </td>
                      <td>
                        {isPricingReadinessEligible(row) ? (
                          <Link
                            className="btn btn-ghost"
                            style={{ width: "auto", textDecoration: "none", padding: "0.25rem 0.5rem" }}
                            to={ratesPricingPath(row.completion_id)}
                          >
                            Pricing Readiness
                          </Link>
                        ) : (
                          <span className="small muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card export-panel">
        <h2 style={{ marginTop: 0 }}>Export batches</h2>
        <p className="small muted">
          Staging only. Downloads are authenticated Blob files — nothing is posted externally.
        </p>
        <div className="panel-actions">
          <label className="field" style={{ margin: 0, minWidth: 220 }}>
            <span>Export type</span>
            <select value={exportType} onChange={(e) => setExportType(e.target.value)}>
              {EXPORT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-primary"
            type="button"
            style={{ width: "auto" }}
            disabled={!!busy || loading}
            onClick={createBatch}
          >
            Create draft batch
          </button>
        </div>

        {batches.length === 0 ? (
          <p className="muted">No export batches yet.</p>
        ) : (
          <ul className="batch-list">
            {batches.map((batch) => (
              <li key={batch.export_batch_id}>
                <button
                  type="button"
                  className="batch-link"
                  onClick={() => openBatch(batch.export_batch_id)}
                  disabled={!!busy}
                >
                  <strong>{batch.export_batch_id}</strong> · {batch.export_type} · {batch.status} ·{" "}
                  {batch.record_count} records
                </button>
              </li>
            ))}
          </ul>
        )}

        {selectedBatch && (
          <div className="selected-batch">
            <h3>
              {selectedBatch.export_batch_id} · {selectedBatch.status}
            </h3>
            <p className="small muted">
              {selectedBatch.export_type} · {selectedBatch.date_from} → {selectedBatch.date_to} · v
              {selectedBatch.version}
              {selectedBatch.file_name ? ` · ${selectedBatch.file_name}` : ""}
              {selectedBatch.checksum ? ` · checksum ${selectedBatch.checksum}` : ""}
            </p>
            <div className="panel-actions">
              <button
                className="btn btn-ghost"
                type="button"
                style={{ width: "auto" }}
                disabled={!!busy || !canValidateBatch(selectedBatch.status)}
                onClick={validateBatch}
              >
                Validate
              </button>
              <button
                className="btn btn-primary"
                type="button"
                style={{ width: "auto" }}
                disabled={!!busy || !canGenerateBatch(selectedBatch.status)}
                onClick={generateBatch}
              >
                Generate CSV
              </button>
              <button
                className="btn btn-dark"
                type="button"
                style={{ width: "auto" }}
                disabled={!!busy || !canDownloadBatch(selectedBatch.status)}
                onClick={downloadBatch}
              >
                Download
              </button>
              <button
                className="btn btn-danger"
                type="button"
                style={{ width: "auto" }}
                disabled={!!busy || !canCancelBatch(selectedBatch.status)}
                onClick={cancelBatch}
              >
                Cancel draft
              </button>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Completion</th>
                    <th>Item status</th>
                    <th>Blockers</th>
                  </tr>
                </thead>
                <tbody>
                  {batchItems.map((item) => (
                    <tr key={item.export_batch_item_id}>
                      <td>{item.job_sheet_id}</td>
                      <td>{item.completion_id}</td>
                      <td>{item.item_status}</td>
                      <td className="small">{item.blocker_summary || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
