import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ApiError,
  api,
  clearSession,
  downloadAuthenticatedFile,
  getStaff,
} from "../api";
import DeliveryPanel from "../components/DeliveryPanel.jsx";
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
  parseReportsSearch,
  previewMetricCards,
  reportTypeOptionsForRole,
  reportTypeSelectOptions,
  staleReportConflictMessage,
} from "../reportHelpers.mjs";

export default function ReportsPage() {
  const staff = getStaff();
  const manager = isManagerRole(staff?.role);
  const [searchParams, setSearchParams] = useSearchParams();
  const query = parseReportsSearch(searchParams);

  const [options, setOptions] = useState({ report_types: REPORT_TYPES });
  const [form, setForm] = useState(() => {
    const reportType = query.report_type || (manager ? "Completion Register" : "Staff Work Report");
    return {
      ...defaultReportRange(),
      report_type: reportType,
      group_by: query.group_by || defaultGroupByForReportType(REPORT_TYPES, reportType),
      customer: "",
      project: "",
      assigned_staff_id: "",
      completion_status: "",
      approval_status: "",
      job_sheet_id: query.job_sheet_id || "",
      billable: "",
      date_from: query.date_from || defaultReportRange().date_from,
      date_to: query.date_to || defaultReportRange().date_to,
    };
  });
  const [preview, setPreview] = useState(null);
  const [batches, setBatches] = useState([]);
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [batchItems, setBatchItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const availableTypes = useMemo(
    () => reportTypeOptionsForRole(staff?.role, options.report_types || REPORT_TYPES),
    [staff?.role, options.report_types]
  );
  const typeSelectOptions = useMemo(() => reportTypeSelectOptions(availableTypes), [availableTypes]);
  const groupByChoices = useMemo(
    () => groupByChoicesForReportType(availableTypes, form.report_type),
    [availableTypes, form.report_type]
  );
  const cards = useMemo(() => (preview ? previewMetricCards(preview) : []), [preview]);

  useEffect(() => {
    loadBootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Preserve deep-link job/report filters from the URL without auto-generating a PDF.
  useEffect(() => {
    const next = parseReportsSearch(searchParams);
    setForm((prev) => {
      const reportType = next.report_type || prev.report_type;
      const choices = groupByChoicesForReportType(options.report_types || REPORT_TYPES, reportType);
      const groupBy =
        next.group_by && choices.includes(next.group_by)
          ? next.group_by
          : choices.includes(prev.group_by)
            ? prev.group_by
            : defaultGroupByForReportType(options.report_types || REPORT_TYPES, reportType);
      return {
        ...prev,
        report_type: reportType,
        group_by: groupBy,
        job_sheet_id: next.job_sheet_id || prev.job_sheet_id,
        date_from: next.date_from || prev.date_from,
        date_to: next.date_to || prev.date_to,
      };
    });
  }, [searchParams, options.report_types]);

  async function loadBootstrap() {
    setLoading(true);
    setError("");
    try {
      const [opts, list] = await Promise.all([api("/reports/options"), api("/reports")]);
      setOptions(opts);
      setBatches(list.items || []);
      const types = reportTypeOptionsForRole(staff?.role, opts.report_types || REPORT_TYPES);
      setForm((prev) => {
        const reportType = types.some((t) => t.report_type === prev.report_type)
          ? prev.report_type
          : types[0]?.report_type || prev.report_type;
        const groupBy = groupByChoicesForReportType(types, reportType).includes(prev.group_by)
          ? prev.group_by
          : defaultGroupByForReportType(types, reportType);
        return { ...prev, report_type: reportType, group_by: groupBy };
      });
    } catch (err) {
      setError(err.message || "Failed to load reports");
    } finally {
      setLoading(false);
    }
  }

  function onFormChange(key, value) {
    setForm((prev) => {
      if (key !== "report_type") return { ...prev, [key]: value };
      const nextType = value;
      return {
        ...prev,
        report_type: nextType,
        group_by: defaultGroupByForReportType(availableTypes, nextType),
      };
    });
  }

  function syncQueryFromForm(nextForm = form) {
    const params = {};
    if (nextForm.report_type) params.report_type = nextForm.report_type;
    if (nextForm.job_sheet_id) params.job_sheet_id = nextForm.job_sheet_id;
    if (nextForm.date_from) params.date_from = nextForm.date_from;
    if (nextForm.date_to) params.date_to = nextForm.date_to;
    if (nextForm.group_by) params.group_by = nextForm.group_by;
    setSearchParams(params, { replace: true });
  }

  function describeError(err) {
    if (err instanceof ApiError && err.status === 409) return staleReportConflictMessage();
    return err.message || "Report request failed";
  }

  async function runPreview(event) {
    event?.preventDefault();
    setBusy("preview");
    setError("");
    setMessage("");
    syncQueryFromForm(form);
    try {
      const result = await api("/reports/preview", {
        method: "POST",
        json: buildReportPreviewBody(form),
      });
      setPreview(result);
      setMessage(
        result.job_count
          ? `Preview ready — ${result.job_count} job(s), ~${result.page_estimate} page(s).`
          : "Preview ready — no matching jobs."
      );
    } catch (err) {
      setPreview(null);
      setError(describeError(err));
    } finally {
      setBusy("");
    }
  }

  async function createBatch() {
    setBusy("create");
    setError("");
    setMessage("");
    try {
      const result = await api("/reports", {
        method: "POST",
        json: buildReportPreviewBody(form),
      });
      setSelectedBatch(result.report_batch);
      setBatchItems(result.items || []);
      setBatches((prev) => [result.report_batch, ...prev.filter((b) => b.report_batch_id !== result.report_batch.report_batch_id)]);
      setMessage(`Draft batch ${result.report_batch.report_batch_id} created.`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy("");
    }
  }

  async function openBatch(reportBatchId) {
    setBusy("open");
    setError("");
    try {
      const result = await api(`/reports/${encodeURIComponent(reportBatchId)}`);
      setSelectedBatch(result.report_batch);
      setBatchItems(result.items || []);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy("");
    }
  }

  async function validateBatch() {
    if (!selectedBatch) return;
    setBusy("validate");
    setError("");
    try {
      const result = await api(`/reports/${encodeURIComponent(selectedBatch.report_batch_id)}/validate`, {
        method: "POST",
        json: { expected_version: selectedBatch.version },
      });
      setSelectedBatch(result.report_batch);
      setBatchItems(result.items || []);
      setMessage(`Batch ${result.report_batch.report_batch_id} validated.`);
      await refreshBatches();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy("");
    }
  }

  async function generateBatch() {
    if (!selectedBatch) return;
    if (!window.confirm(confirmGenerateReportMessage(selectedBatch, preview || {}))) return;
    setBusy("generate");
    setError("");
    try {
      const result = await api(`/reports/${encodeURIComponent(selectedBatch.report_batch_id)}/generate`, {
        method: "POST",
        json: { expected_version: selectedBatch.version },
      });
      setSelectedBatch(result.report_batch);
      setBatchItems(result.items || []);
      setMessage(`Generated ${result.report_batch.file_name}. Ready to download.`);
      await refreshBatches();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy("");
    }
  }

  async function cancelBatch() {
    if (!selectedBatch) return;
    if (!window.confirm(`Cancel draft batch ${selectedBatch.report_batch_id}?`)) return;
    setBusy("cancel");
    setError("");
    try {
      const result = await api(`/reports/${encodeURIComponent(selectedBatch.report_batch_id)}/cancel`, {
        method: "POST",
        json: { expected_version: selectedBatch.version },
      });
      setSelectedBatch(result.report_batch);
      setMessage(`Batch ${result.report_batch.report_batch_id} cancelled.`);
      await refreshBatches();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy("");
    }
  }

  async function downloadBatch() {
    if (!selectedBatch) return;
    const reportBatchId = selectedBatch.report_batch_id;
    setBusy("download");
    setError("");
    setMessage("");
    try {
      const { fileName } = await downloadAuthenticatedFile(
        `/reports/${encodeURIComponent(reportBatchId)}/download`,
        selectedBatch.file_name || `nativegrace_report_${reportBatchId}.pdf`
      );
      setMessage(`Downloaded ${fileName}.`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy("");
    }
  }

  async function downloadJobPdf() {
    const id = String(form.job_sheet_id || "").trim();
    if (!id) {
      setError("Enter a job_sheet_id to download a single job PDF.");
      return;
    }
    setBusy("job-pdf");
    setError("");
    setMessage("");
    try {
      const { fileName } = await downloadAuthenticatedFile(
        jobSummaryPdfPath(id),
        `nativegrace_job_${id}.pdf`
      );
      setMessage(`Downloaded ${fileName}.`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy("");
    }
  }

  async function refreshBatches() {
    const list = await api("/reports");
    setBatches(list.items || []);
  }

  function logout() {
    clearSession();
    window.location.href = "/login";
  }

  return (
    <div className="dashboard-page">
      <div className="topbar">
        <div>
          <h1>Reports</h1>
          <p className="small muted" style={{ margin: 0 }}>
            {staff?.staff_name} · server-side PDFs · no email / Drive / Xero posting
          </p>
        </div>
        <div className="topbar-actions">
          <Link className="btn btn-ghost" style={{ width: "auto", textDecoration: "none" }} to="/">
            Jobs
          </Link>
          {manager && (
            <Link
              className="btn btn-ghost"
              style={{ width: "auto", textDecoration: "none" }}
              to="/completions"
            >
              Completions
            </Link>
          )}
          {manager && (
            <Link className="btn btn-ghost" style={{ width: "auto", textDecoration: "none" }} to="/rates">
              Rates &amp; Financial
            </Link>
          )}
          <button className="btn btn-ghost" style={{ width: "auto" }} onClick={logout} type="button">
            Log out
          </button>
        </div>
      </div>

      <form className="card filter-panel" onSubmit={runPreview}>
        <div className="filter-grid">
          <label className="field">
            <span>Report type</span>
            <select
              value={form.report_type}
              onChange={(e) => onFormChange("report_type", e.target.value)}
            >
              {typeSelectOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Group by</span>
            <select
              value={groupByChoices.includes(form.group_by) ? form.group_by : groupByChoices[0] || ""}
              onChange={(e) => onFormChange("group_by", e.target.value)}
              disabled={!groupByChoices.length}
            >
              {groupByChoices.length === 0 ? (
                <option value="">—</option>
              ) : (
                groupByChoices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="field">
            <span>Date from</span>
            <input
              type="date"
              value={form.date_from}
              onChange={(e) => onFormChange("date_from", e.target.value)}
            />
          </label>
          <label className="field">
            <span>Date to</span>
            <input
              type="date"
              value={form.date_to}
              onChange={(e) => onFormChange("date_to", e.target.value)}
            />
          </label>
          {manager && (
            <label className="field">
              <span>Assigned staff ID</span>
              <input
                value={form.assigned_staff_id}
                onChange={(e) => onFormChange("assigned_staff_id", e.target.value)}
              />
            </label>
          )}
          <label className="field">
            <span>Customer</span>
            <input
              value={form.customer}
              onChange={(e) => onFormChange("customer", e.target.value)}
              placeholder="Contains…"
            />
          </label>
          <label className="field">
            <span>Project</span>
            <input
              value={form.project}
              onChange={(e) => onFormChange("project", e.target.value)}
              placeholder="Contains…"
            />
          </label>
          <label className="field">
            <span>Completion status</span>
            <select
              value={form.completion_status}
              onChange={(e) => onFormChange("completion_status", e.target.value)}
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
              value={form.approval_status}
              onChange={(e) => onFormChange("approval_status", e.target.value)}
            >
              <option value="">Any</option>
              <option value="Approved">Approved</option>
              <option value="Pending">Pending</option>
              <option value="Returned">Returned</option>
            </select>
          </label>
          <label className="field">
            <span>Job sheet ID</span>
            <input
              value={form.job_sheet_id}
              onChange={(e) => onFormChange("job_sheet_id", e.target.value)}
              placeholder="21759f5d"
            />
          </label>
          <label className="field">
            <span>Billable labour</span>
            <select value={form.billable} onChange={(e) => onFormChange("billable", e.target.value)}>
              <option value="">Any</option>
              <option value="true">Has billable labour</option>
              <option value="false">No billable labour</option>
            </select>
          </label>
        </div>
        <div className="panel-actions">
          <button className="btn btn-primary" type="submit" disabled={loading || !!busy}>
            Preview report data
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            style={{ width: "auto" }}
            disabled={!!busy || !preview}
            onClick={createBatch}
          >
            Create draft batch
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            style={{ width: "auto" }}
            disabled={!!busy || !form.job_sheet_id}
            onClick={downloadJobPdf}
          >
            {busy === "job-pdf" ? "Downloading…" : "Download job PDF"}
          </button>
        </div>
        <p className="small muted">{emptyPreviewMessage()}</p>
      </form>

      {error && <div className="error-box">{error}</div>}
      {message && <div className="ok-box">{message}</div>}
      {loading && <p className="muted">Loading reports…</p>}

      {preview && (
        <>
          <div className="metric-grid">
            {cards.map((card) => (
              <div key={card.key} className="metric-card">
                <div className="metric-label">{card.label}</div>
                <div className="metric-value">{card.value}</div>
              </div>
            ))}
          </div>
          {(preview.blockers || []).length > 0 && (
            <div className="warn-box">
              <strong>Validation blockers</strong>
              <ul className="warning-list">
                {preview.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Preview jobs</h2>
            {!preview.items?.length ? (
              <p className="muted">No jobs match these filters.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Job</th>
                      <th>Customer / project</th>
                      <th>Blockers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.items.map((row) => (
                      <tr key={`${row.completion_id}-${row.job_sheet_id}`}>
                        <td>{row.job_date || "—"}</td>
                        <td>
                          <Link to={`/jobs/${encodeURIComponent(row.job_sheet_id)}`}>
                            {row.job_sheet_id}
                          </Link>
                          <div className="small muted">{row.completion_id}</div>
                        </td>
                        <td>
                          {row.customer_name || "—"}
                          <div className="small muted">{row.project_name || "—"}</div>
                        </td>
                        <td className="small">{row.blocker_summary || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <div className="card export-panel">
        <h2 style={{ marginTop: 0 }}>Report batches</h2>
        <p className="small muted">
          Draft → Validated → Generated. Generated batches are immutable; regenerate creates a new
          batch. Downloads are authenticated PDFs.
        </p>
        {!batches.length ? (
          <p className="muted">No report batches yet.</p>
        ) : (
          <ul className="batch-list">
            {batches.map((batch) => (
              <li key={batch.report_batch_id}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ width: "auto", textAlign: "left" }}
                  onClick={() => openBatch(batch.report_batch_id)}
                >
                  <strong>{batch.report_batch_id}</strong> · {batch.report_type} · {batch.status} ·{" "}
                  {batch.record_count} jobs
                </button>
              </li>
            ))}
          </ul>
        )}

        {selectedBatch && (
          <div style={{ marginTop: "1rem" }}>
            <h3 style={{ marginTop: 0 }}>
              {selectedBatch.report_batch_id} · {selectedBatch.status}
            </h3>
            <p className="small muted">
              {selectedBatch.report_type} · {selectedBatch.date_from} → {selectedBatch.date_to} · v
              {selectedBatch.version} · template {selectedBatch.template_version}
              {selectedBatch.file_name ? ` · ${selectedBatch.file_name}` : ""}
              {selectedBatch.checksum ? ` · ${String(selectedBatch.checksum).slice(0, 12)}…` : ""}
            </p>
            <div className="panel-actions">
              <button
                className="btn btn-ghost"
                type="button"
                style={{ width: "auto" }}
                disabled={!!busy || !canValidateReport(selectedBatch.status)}
                onClick={validateBatch}
              >
                Validate
              </button>
              <button
                className="btn btn-primary"
                type="button"
                style={{ width: "auto" }}
                disabled={!!busy || !canGenerateReport(selectedBatch.status)}
                onClick={generateBatch}
              >
                Generate PDF
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                style={{ width: "auto" }}
                disabled={!!busy || !canDownloadReport(selectedBatch.status)}
                onClick={downloadBatch}
              >
                {busy === "download" ? "Downloading…" : "Download PDF"}
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                style={{ width: "auto" }}
                disabled={!!busy || !canCancelReport(selectedBatch.status)}
                onClick={cancelBatch}
              >
                Cancel
              </button>
            </div>
            {batchItems.length > 0 && (
              <div className="table-scroll" style={{ marginTop: "0.75rem" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Completion</th>
                      <th>Status</th>
                      <th>Exclusion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchItems.map((item) => (
                      <tr key={item.report_batch_item_id || `${item.job_sheet_id}-${item.completion_id}`}>
                        <td>
                          <Link to={`/jobs/${encodeURIComponent(item.job_sheet_id)}`}>
                            {item.job_sheet_id}
                          </Link>
                        </td>
                        <td className="small">{item.completion_id}</td>
                        <td>{item.inclusion_status || item.item_status || "—"}</td>
                        <td className="small">{item.exclusion_reason || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {manager && (
              <DeliveryPanel
                reportBatchId={selectedBatch.report_batch_id}
                sourceType="report"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
