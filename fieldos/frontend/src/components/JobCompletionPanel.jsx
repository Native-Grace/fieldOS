import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, getStaff } from "../api";
import { isManagerRole } from "../managerReviewHelpers.mjs";
import {
  COMPLETION_STATUSES,
  ROW_CONFIRMATION,
  buildCompletionForm,
  canFinaliseClient,
  collectLabourValidationMessages,
  collectMaterialValidationMessages,
  completionHasUnsavedChanges,
  displayLabourHours,
  emptyLabourRow,
  emptyMachineryRow,
  emptyMaterialRow,
  EMPTY_COMPLETION_FORM,
  isBreakWarningResolved,
  isResolvableBreakWarning,
  findWarningResolution,
  labourFieldErrors,
  materialFieldErrors,
  needsOverrideReason,
  parseMaterialQuantityRowError,
  normaliseMaterialQuantity,
  upsertBreakWarningResolution,
  warningKey,
} from "../jobCompletionHelpers.mjs";
import {
  isPricingReadinessEligible,
  ratesPricingPath,
} from "../ratesFinancialHelpers.mjs";

export default function JobCompletionPanel({ jobSheetId, onUpdated }) {
  const staff = getStaff();
  const manager = isManagerRole(staff?.role);

  const [payload, setPayload] = useState(null);
  const [form, setForm] = useState(EMPTY_COMPLETION_FORM);
  const [baseline, setBaseline] = useState(EMPTY_COMPLETION_FORM);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [showReopen, setShowReopen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [resolveDrafts, setResolveDrafts] = useState({});
  const [showFieldErrors, setShowFieldErrors] = useState(false);
  const [materialErrorRow, setMaterialErrorRow] = useState(null);
  const [conflictLocalEdits, setConflictLocalEdits] = useState(null);
  const [needsReload, setNeedsReload] = useState(false);
  // Lazy: completion is a separate, heavier round-trip. Do NOT fetch on job open —
  // it must never block or slow down core job detail rendering.
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);

  const dirty = useMemo(() => completionHasUnsavedChanges(form, baseline), [form, baseline]);
  const completion = payload?.completion;

  async function load() {
    setError("");
    setLoading(true);
    try {
      const data = await api(`/jobs/${encodeURIComponent(jobSheetId)}/completion`);
      setPayload(data);
      if (data.completion) {
        const next = buildCompletionForm(data);
        setForm(next);
        setBaseline(next);
      } else {
        setForm(EMPTY_COMPLETION_FORM);
        setBaseline(EMPTY_COMPLETION_FORM);
      }
      return data;
    } finally {
      setLoading(false);
    }
  }

  // Reset when navigating between jobs so a stale panel never shows.
  useEffect(() => {
    setOpened(false);
    setPayload(null);
    setForm(EMPTY_COMPLETION_FORM);
    setBaseline(EMPTY_COMPLETION_FORM);
    setError("");
    setMessage("");
    setOverrideReason("");
    setResolveDrafts({});
    setShowFieldErrors(false);
    setMaterialErrorRow(null);
    setConflictLocalEdits(null);
    setNeedsReload(false);
  }, [jobSheetId]);

  function openPanel() {
    if (opened) return;
    setOpened(true);
    load().catch((err) => setError(String(err.message || err)));
  }

  useEffect(() => {
    function onBeforeUnload(event) {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function setLabour(index, patch) {
    setForm((prev) => {
      const labour_entries = prev.labour_entries.slice();
      labour_entries[index] = { ...labour_entries[index], ...patch };
      return { ...prev, labour_entries };
    });
  }

  function setMachinery(index, patch) {
    setForm((prev) => {
      const machinery_entries = prev.machinery_entries.slice();
      machinery_entries[index] = { ...machinery_entries[index], ...patch };
      return { ...prev, machinery_entries };
    });
  }

  function setMaterial(index, patch) {
    setForm((prev) => {
      const material_entries = prev.material_entries.slice();
      material_entries[index] = { ...material_entries[index], ...patch };
      return { ...prev, material_entries };
    });
  }

  async function runAction(path, method, body, options = {}) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const data = await api(path, { method, json: body });
      setPayload(data);
      const next = buildCompletionForm(data);
      setForm(next);
      setBaseline(next);
      setMaterialErrorRow(null);
      setNeedsReload(false);
      setConflictLocalEdits(null);
      setMessage(data.completion?.completion_status || "Saved");
      if (onUpdated) onUpdated(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Preserve unsaved edits for comparison — never overwrite blindly.
        setConflictLocalEdits(form);
        setNeedsReload(true);
        setError("This completion changed. Reload the latest version before saving.");
      } else if (err instanceof ApiError && err.status === 422) {
        const rowIdx = parseMaterialQuantityRowError(err.message);
        if (rowIdx != null) {
          setMaterialErrorRow(rowIdx);
          setShowFieldErrors(true);
        }
        // Keep all unsaved edits; do not regenerate.
        setError(String(err.message || err));
      } else {
        setError(String(err.message || err));
      }
      if (options.rethrow) throw err;
    } finally {
      setBusy(false);
    }
  }

  async function reloadLatestKeepingLocalCopy() {
    setConflictLocalEdits(form);
    try {
      await load();
      setNeedsReload(false);
      setMessage("Latest version loaded. Review your local edits before saving.");
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function generateDraft() {
    // Never auto-regenerate when editing — explicit button only; existing draft returns as-is.
    await runAction(`/jobs/${encodeURIComponent(jobSheetId)}/completion/generate`, "POST", {
      expected_version: completion?.version,
      staff_name: staff?.staff_name || "",
    });
  }

  async function createEmptyDraft() {
    await runAction(`/jobs/${encodeURIComponent(jobSheetId)}/completion`, "POST", {});
  }

  async function saveDraft(extra = {}) {
    const materialMessages = collectMaterialValidationMessages(form);
    if (materialMessages.length) {
      setShowFieldErrors(true);
      const first = parseMaterialQuantityRowError(materialMessages[0]);
      setMaterialErrorRow(first);
      setError(materialMessages.join(" "));
      return;
    }
    if (needsReload) {
      setError("This completion changed. Reload the latest version before saving.");
      return;
    }
    await runAction(`/jobs/${encodeURIComponent(jobSheetId)}/completion`, "PATCH", {
      ...form,
      material_entries: (form.material_entries || []).map((row) => {
        const n = normaliseMaterialQuantity(row.quantity, { unit: row.unit || "" });
        return {
          ...row,
          quantity: n.ok ? n.quantity : row.quantity,
          unit: n.ok ? n.unit : row.unit,
        };
      }),
      expected_version: completion?.version,
      ...extra,
    });
  }

  async function markReady() {
    await saveDraft({ completion_status: COMPLETION_STATUSES.READY });
  }

  async function finalise() {
    const labourMessages = collectLabourValidationMessages(form);
    if (labourMessages.length) {
      setShowFieldErrors(true);
      setError(labourMessages.join(" "));
      return;
    }
    if (!canFinaliseClient(form)) {
      setShowFieldErrors(true);
      setError("Confirm or exclude all suggested rows, complete times, and resolve lunch/break warnings before finalising.");
      return;
    }
    if (needsOverrideReason(form) && !String(overrideReason || "").trim()) {
      setError("Enter an override reason for remaining non-critical warnings, or clear them.");
      return;
    }
    if (!window.confirm("Finalise this job completion? It will become read-only.")) return;
    await runAction(`/jobs/${encodeURIComponent(jobSheetId)}/completion/finalise`, "POST", {
      expected_version: completion?.version,
      override_reason: String(overrideReason || "").trim() || undefined,
    });
  }

  function applyBreakResolution(warningText) {
    const key = warningKey(warningText);
    const draft = resolveDrafts[key] || {};
    const breakMinutes = Number(draft.break_minutes);
    if (!Number.isFinite(breakMinutes) || breakMinutes < 0) {
      setError("Enter verified break minutes (0 or more) to resolve this warning.");
      return;
    }
    setForm((prev) => {
      const labour_entries = prev.labour_entries.map((row) =>
        row.confirmation_status === ROW_CONFIRMATION.EXCLUDED
          ? row
          : { ...row, break_minutes: breakMinutes }
      );
      return {
        ...prev,
        labour_entries,
        warning_resolutions: upsertBreakWarningResolution(prev.warning_resolutions, warningText, {
          breakMinutes,
          resolutionNote: draft.resolution_note || "",
        }),
      };
    });
    setMessage("Lunch/break warning marked resolved. Save draft to persist.");
    setError("");
  }

  async function reopen() {
    if (!String(reopenReason || "").trim()) {
      setError("Reopen reason is required.");
      return;
    }
    await runAction(`/jobs/${encodeURIComponent(jobSheetId)}/completion/reopen`, "POST", {
      expected_version: completion?.version,
      reopen_reason: reopenReason.trim(),
    });
    setShowReopen(false);
    setReopenReason("");
  }

  const editable = Boolean(payload?.can_edit);
  const readOnly = !editable;

  if (!opened) {
    return (
      <section className="card completion-panel" aria-labelledby="completion-heading">
        <h2 id="completion-heading">Job completion</h2>
        <p className="small muted">
          Timesheets, labour, machinery, materials, and invoice-ready description. Loaded on demand
          so it never delays the job page.
        </p>
        <button className="btn btn-ghost" type="button" onClick={openPanel}>
          Show job completion
        </button>
      </section>
    );
  }

  return (
    <section className="card completion-panel" aria-labelledby="completion-heading">
      <h2 id="completion-heading">Job completion</h2>
      <p className="small muted">
        Timesheets, labour, machinery, materials, and invoice-ready description. Structured output
        only — no invoice or payroll posting.
      </p>
      {loading ? <p className="small muted">Loading completion…</p> : null}

      {completion ? (
        <div className="meta" style={{ marginBottom: 12 }}>
          <span className="badge">{completion.completion_status}</span>
          {completion.blocked ? <span className="badge failed">Blocked</span> : null}
          <span className="small muted">v{completion.version}</span>
          <span className="small muted">
            Labour {completion.total_labour_hours}h · Travel {completion.total_travel_hours}h ·
            Machinery {completion.total_machinery_hours}h
          </span>
        </div>
      ) : (
        <p className="small muted">No completion draft yet.</p>
      )}

      {error ? <div className="error" role="alert">{error}</div> : null}
      {needsReload ? (
        <div className="warn" role="status">
          <p className="small">
            A newer server version is available. Your unsaved edits are kept locally for comparison —
            reload before saving.
          </p>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={busy || loading}
            onClick={reloadLatestKeepingLocalCopy}
          >
            Reload latest version
          </button>
          {conflictLocalEdits ? (
            <p className="small muted">Local edits preserved ({Object.keys(conflictLocalEdits).length} form keys).</p>
          ) : null}
        </div>
      ) : null}
      {message ? <div className="ok small">{message}</div> : null}
      {dirty ? <div className="warn small">You have unsaved changes.</div> : null}

      {(form.warnings || []).length ? (
        <div className="warn" role="status">
          <strong>Warnings</strong>
          <ul className="warning-list">
            {form.warnings.map((w, i) => {
              const key = warningKey(w);
              const resolved = isBreakWarningResolved(form.warning_resolutions, w);
              const resolvable = isResolvableBreakWarning(w);
              const draft = resolveDrafts[key] || {};
              return (
                <li key={`w-${i}`}>
                  <div>{w}</div>
                  {resolvable ? (
                    resolved ? (
                      <p className="ok small">
                        Resolved — break{" "}
                        {findWarningResolution(form.warning_resolutions, w)?.break_minutes ?? "—"}{" "}
                        min
                        {findWarningResolution(form.warning_resolutions, w)?.resolution_note
                          ? ` · ${findWarningResolution(form.warning_resolutions, w).resolution_note}`
                          : ""}
                      </p>
                    ) : !readOnly ? (
                      <div className="warning-resolve">
                        <div className="field">
                          <label htmlFor={`resolve-break-${i}`}>Verified break (min)</label>
                          <input
                            id={`resolve-break-${i}`}
                            type="number"
                            min="0"
                            value={draft.break_minutes ?? ""}
                            disabled={busy}
                            onChange={(e) =>
                              setResolveDrafts((prev) => ({
                                ...prev,
                                [key]: {
                                  ...prev[key],
                                  break_minutes: e.target.value === "" ? "" : Number(e.target.value),
                                },
                              }))
                            }
                          />
                        </div>
                        <div className="field">
                          <label htmlFor={`resolve-note-${i}`}>Resolution note (optional)</label>
                          <input
                            id={`resolve-note-${i}`}
                            value={draft.resolution_note || ""}
                            disabled={busy}
                            onChange={(e) =>
                              setResolveDrafts((prev) => ({
                                ...prev,
                                [key]: { ...prev[key], resolution_note: e.target.value },
                              }))
                            }
                          />
                        </div>
                        <button
                          className="btn btn-ghost"
                          type="button"
                          disabled={busy}
                          onClick={() => applyBreakResolution(w)}
                        >
                          Mark resolved
                        </button>
                      </div>
                    ) : (
                      <p className="small muted">Unresolved — manager must confirm break minutes.</p>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
          {!readOnly && needsOverrideReason(form) ? (
            <div className="field" style={{ marginTop: 8 }}>
              <label htmlFor="override-reason">
                Override reason (for remaining non-critical warnings)
              </label>
              <textarea
                id="override-reason"
                rows={2}
                value={overrideReason}
                disabled={busy}
                onChange={(e) => setOverrideReason(e.target.value)}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {!completion && manager && payload?.can_generate ? (
        <div className="row-actions">
          <button className="btn" type="button" disabled={busy} onClick={generateDraft}>
            Generate draft from approved job
          </button>
          <button className="btn btn-ghost" type="button" disabled={busy} onClick={createEmptyDraft}>
            Create empty draft
          </button>
        </div>
      ) : null}

      {completion ? (
        <>
          {manager && isPricingReadinessEligible(completion) ? (
            <div className="panel-actions" style={{ marginBottom: "0.75rem" }}>
              <Link
                className="btn btn-ghost"
                style={{ width: "auto", textDecoration: "none" }}
                to={ratesPricingPath(completion.completion_id)}
              >
                Pricing Readiness
              </Link>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="work-summary">Work summary</label>
            <textarea
              id="work-summary"
              rows={3}
              value={form.work_summary}
              disabled={readOnly || busy}
              onChange={(e) => setForm({ ...form, work_summary: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="invoice-description">Invoice description</label>
            <textarea
              id="invoice-description"
              rows={3}
              value={form.invoice_description}
              disabled={readOnly || busy}
              onChange={(e) => setForm({ ...form, invoice_description: e.target.value })}
            />
          </div>
          {manager ? (
            <div className="field">
              <label htmlFor="internal-notes">Internal notes</label>
              <textarea
                id="internal-notes"
                rows={2}
                value={form.internal_notes}
                disabled={readOnly || busy}
                onChange={(e) => setForm({ ...form, internal_notes: e.target.value })}
              />
            </div>
          ) : null}

          <h3>Labour</h3>
          <div className="completion-table" role="table" aria-label="Labour entries">
            {form.labour_entries.map((row, index) => {
              const allErrors = labourFieldErrors(row);
              const fieldErrors = showFieldErrors
                ? allErrors
                : Object.fromEntries(
                    Object.entries(allErrors).filter(
                      ([field, message]) =>
                        field === "break_minutes" ||
                        message === "Use HH:MM."
                    )
                  );
              return (
              <div className="completion-row" role="row" key={row.labour_id || `lab-${index}`}>
                <div className="field">
                  <label htmlFor={`lab-staff-${index}`}>Staff</label>
                  <input
                    id={`lab-staff-${index}`}
                    value={row.staff_name || row.staff_id || ""}
                    disabled={readOnly || busy}
                    onChange={(e) => setLabour(index, { staff_name: e.target.value })}
                  />
                </div>
                <div className={`field${fieldErrors.start_time ? " has-error" : ""}`}>
                  <label htmlFor={`lab-start-${index}`}>Start</label>
                  <input
                    id={`lab-start-${index}`}
                    type="time"
                    value={row.start_time || ""}
                    disabled={readOnly || busy}
                    aria-invalid={!!fieldErrors.start_time}
                    onChange={(e) => setLabour(index, { start_time: e.target.value })}
                  />
                  {fieldErrors.start_time ? (
                    <span className="field-error" role="alert">{fieldErrors.start_time}</span>
                  ) : null}
                </div>
                <div className={`field${fieldErrors.finish_time ? " has-error" : ""}`}>
                  <label htmlFor={`lab-finish-${index}`}>Finish</label>
                  <input
                    id={`lab-finish-${index}`}
                    type="time"
                    value={row.finish_time || ""}
                    disabled={readOnly || busy}
                    aria-invalid={!!fieldErrors.finish_time}
                    onChange={(e) => setLabour(index, { finish_time: e.target.value })}
                  />
                  {fieldErrors.finish_time ? (
                    <span className="field-error" role="alert">{fieldErrors.finish_time}</span>
                  ) : null}
                </div>
                <div className={`field${fieldErrors.break_minutes ? " has-error" : ""}`}>
                  <label htmlFor={`lab-break-${index}`}>Break (min)</label>
                  <input
                    id={`lab-break-${index}`}
                    type="number"
                    min="0"
                    value={row.break_minutes ?? 0}
                    disabled={readOnly || busy}
                    aria-invalid={!!fieldErrors.break_minutes}
                    onChange={(e) => setLabour(index, { break_minutes: Number(e.target.value) })}
                  />
                  {fieldErrors.break_minutes ? (
                    <span className="field-error" role="alert">{fieldErrors.break_minutes}</span>
                  ) : null}
                </div>
                <div className="field">
                  <label htmlFor={`lab-travel-${index}`}>Travel (min)</label>
                  <input
                    id={`lab-travel-${index}`}
                    type="number"
                    min="0"
                    value={row.travel_minutes ?? 0}
                    disabled={readOnly || busy}
                    onChange={(e) => setLabour(index, { travel_minutes: Number(e.target.value) })}
                  />
                </div>
                <div className="small muted">
                  Net hours: {displayLabourHours(row) ?? "—"} · {row.confirmation_status}
                </div>
                {!readOnly ? (
                  <div className={`row-actions${fieldErrors.confirmation_status ? " has-error" : ""}`}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!row.billable}
                        disabled={busy}
                        onChange={(e) => setLabour(index, { billable: e.target.checked })}
                      />{" "}
                      Billable
                    </label>
                    <select
                      aria-label={`Labour confirmation ${index + 1}`}
                      aria-invalid={!!fieldErrors.confirmation_status}
                      value={row.confirmation_status || ROW_CONFIRMATION.SUGGESTED}
                      disabled={busy}
                      onChange={(e) => setLabour(index, { confirmation_status: e.target.value })}
                    >
                      <option value={ROW_CONFIRMATION.SUGGESTED}>Suggested</option>
                      <option value={ROW_CONFIRMATION.CONFIRMED}>Confirmed</option>
                      <option value={ROW_CONFIRMATION.EXCLUDED}>Excluded</option>
                    </select>
                    {fieldErrors.confirmation_status ? (
                      <span className="field-error" role="alert">
                        {fieldErrors.confirmation_status}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              );
            })}
          </div>
          {!readOnly ? (
            <button
              className="btn btn-ghost"
              type="button"
              disabled={busy}
              onClick={() =>
                setForm({ ...form, labour_entries: [...form.labour_entries, emptyLabourRow()] })
              }
            >
              Add labour row
            </button>
          ) : null}

          <h3>Machinery</h3>
          <div className="completion-table" role="table" aria-label="Machinery entries">
            {form.machinery_entries.map((row, index) => (
              <div className="completion-row" role="row" key={row.machinery_entry_id || `mch-${index}`}>
                <div className="field">
                  <label htmlFor={`mch-name-${index}`}>Equipment</label>
                  <input
                    id={`mch-name-${index}`}
                    value={row.equipment_name || ""}
                    disabled={readOnly || busy}
                    onChange={(e) => setMachinery(index, { equipment_name: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`mch-hours-${index}`}>Duration (h)</label>
                  <input
                    id={`mch-hours-${index}`}
                    type="number"
                    min="0"
                    step="0.25"
                    value={row.duration_hours ?? ""}
                    disabled={readOnly || busy}
                    onChange={(e) =>
                      setMachinery(index, {
                        duration_hours: e.target.value === "" ? "" : Number(e.target.value),
                      })
                    }
                  />
                </div>
                {!readOnly ? (
                  <div className="row-actions">
                    <label>
                      <input
                        type="checkbox"
                        checked={!!row.billable}
                        disabled={busy}
                        onChange={(e) => setMachinery(index, { billable: e.target.checked })}
                      />{" "}
                      Billable
                    </label>
                    <select
                      aria-label={`Machinery confirmation ${index + 1}`}
                      value={row.confirmation_status || ROW_CONFIRMATION.SUGGESTED}
                      disabled={busy}
                      onChange={(e) => setMachinery(index, { confirmation_status: e.target.value })}
                    >
                      <option value={ROW_CONFIRMATION.SUGGESTED}>Suggested</option>
                      <option value={ROW_CONFIRMATION.CONFIRMED}>Confirmed</option>
                      <option value={ROW_CONFIRMATION.EXCLUDED}>Excluded</option>
                    </select>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {!readOnly ? (
            <button
              className="btn btn-ghost"
              type="button"
              disabled={busy}
              onClick={() =>
                setForm({
                  ...form,
                  machinery_entries: [...form.machinery_entries, emptyMachineryRow()],
                })
              }
            >
              Add machinery row
            </button>
          ) : null}

          <h3>Materials</h3>
          <div className="completion-table" role="table" aria-label="Material entries">
            {form.material_entries.map((row, index) => {
              const fieldErrors =
                showFieldErrors || materialErrorRow === index ? materialFieldErrors(row) : {};
              const rowHighlighted = materialErrorRow === index || !!fieldErrors.quantity;
              return (
              <div
                className={`completion-row${rowHighlighted ? " has-error" : ""}`}
                role="row"
                key={row.material_entry_id || `mat-${index}`}
              >
                <div className="field">
                  <label htmlFor={`mat-name-${index}`}>Item</label>
                  <input
                    id={`mat-name-${index}`}
                    value={row.item_name || ""}
                    disabled={readOnly || busy}
                    onChange={(e) => setMaterial(index, { item_name: e.target.value })}
                  />
                </div>
                <div className={`field${fieldErrors.quantity ? " has-error" : ""}`}>
                  <label htmlFor={`mat-qty-${index}`}>Qty</label>
                  <input
                    id={`mat-qty-${index}`}
                    type="text"
                    inputMode="decimal"
                    value={row.quantity ?? ""}
                    disabled={readOnly || busy}
                    aria-invalid={!!fieldErrors.quantity}
                    onChange={(e) => setMaterial(index, { quantity: e.target.value })}
                  />
                  {fieldErrors.quantity ? (
                    <span className="field-error" role="alert">{fieldErrors.quantity}</span>
                  ) : null}
                </div>
                <div className="field">
                  <label htmlFor={`mat-unit-${index}`}>Unit</label>
                  <input
                    id={`mat-unit-${index}`}
                    value={row.unit || ""}
                    disabled={readOnly || busy}
                    onChange={(e) => setMaterial(index, { unit: e.target.value })}
                  />
                </div>
                {!readOnly ? (
                  <div className="row-actions">
                    <label>
                      <input
                        type="checkbox"
                        checked={!!row.billable}
                        disabled={busy}
                        onChange={(e) => setMaterial(index, { billable: e.target.checked })}
                      />{" "}
                      Billable
                    </label>
                    <select
                      aria-label={`Material confirmation ${index + 1}`}
                      value={row.confirmation_status || ROW_CONFIRMATION.SUGGESTED}
                      disabled={busy}
                      onChange={(e) => setMaterial(index, { confirmation_status: e.target.value })}
                    >
                      <option value={ROW_CONFIRMATION.SUGGESTED}>Suggested</option>
                      <option value={ROW_CONFIRMATION.CONFIRMED}>Confirmed</option>
                      <option value={ROW_CONFIRMATION.EXCLUDED}>Excluded</option>
                    </select>
                  </div>
                ) : null}
              </div>
              );
            })}
          </div>
          {!readOnly ? (
            <button
              className="btn btn-ghost"
              type="button"
              disabled={busy}
              onClick={() =>
                setForm({
                  ...form,
                  material_entries: [...form.material_entries, emptyMaterialRow()],
                })
              }
            >
              Add material row
            </button>
          ) : null}

          {manager ? (
            <div className="row-actions" style={{ marginTop: 16 }}>
              {payload?.can_generate && editable ? (
                <button className="btn btn-ghost" type="button" disabled={busy} onClick={generateDraft}>
                  Regenerate AI draft
                </button>
              ) : null}
              {editable ? (
                <>
                  <button className="btn" type="button" disabled={busy} onClick={() => saveDraft()}>
                    Save draft
                  </button>
                  <button className="btn btn-ghost" type="button" disabled={busy} onClick={markReady}>
                    Mark ready for final review
                  </button>
                </>
              ) : null}
              {payload?.can_finalise ? (
                <button className="btn" type="button" disabled={busy} onClick={finalise}>
                  Finalise
                </button>
              ) : null}
              {payload?.can_reopen ? (
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => setShowReopen(true)}
                >
                  Reopen
                </button>
              ) : null}
              <button
                className="btn btn-ghost"
                type="button"
                disabled={busy}
                onClick={() => load().catch((err) => setError(String(err.message || err)))}
              >
                Refresh
              </button>
            </div>
          ) : (
            <p className="small muted">Staff view is read-only for your labour allocation.</p>
          )}

          {showReopen ? (
            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="reopen-reason">Reopen reason</label>
              <textarea
                id="reopen-reason"
                rows={2}
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
              />
              <div className="row-actions">
                <button className="btn" type="button" disabled={busy} onClick={reopen}>
                  Confirm reopen
                </button>
                <button className="btn btn-ghost" type="button" onClick={() => setShowReopen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {completion.finalised_by ? (
            <p className="small muted">
              Finalised by {completion.finalised_by} at {completion.finalised_at}
            </p>
          ) : null}
          {completion.reopened_by ? (
            <p className="small muted">
              Reopened by {completion.reopened_by}: {completion.reopen_reason}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
