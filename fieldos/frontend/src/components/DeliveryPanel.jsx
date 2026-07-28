import { useEffect, useState } from "react";
import { ApiError, api } from "../api";
import {
  DELIVERY_METHODS,
  MISSING_DELIVERY_SOURCE_MESSAGE,
  PDF_PROFILES,
  buildCreateDeliveryDraftPayload,
  canCancelDelivery,
  canEditDelivery,
  canRetryDelivery,
  canSendDelivery,
  canSupersedeDelivery,
  canValidateDelivery,
  confirmSendMessage,
  deliveryDraftRequestBody,
  deliveryStatusTone,
  emptyDeliveryMessage,
  providerDisabledMessage,
} from "../deliveryHelpers.mjs";

/**
 * Manager-only PDF delivery panel for a job and/or report batch.
 * Never auto-sends — confirm_send is always required.
 *
 * Pass exactly one source:
 * - Job Detail: jobSheetId (reportBatchId omitted)
 * - Reports: reportBatchId (jobSheetId omitted)
 */
export default function DeliveryPanel({
  jobSheetId = "",
  reportBatchId = "",
  completionId = "",
  customerName = "",
  projectName = "",
  sourceType = "",
}) {
  const [options, setOptions] = useState({ profiles: PDF_PROFILES, delivery_methods: DELIVERY_METHODS });
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    document_type: "Client Job Summary",
    recipient_email: "",
    recipient_type: "client",
    delivery_method: "email",
    drive_filing: false,
  });

  const resolvedJobId = String(jobSheetId || "").trim();
  const resolvedBatchId = String(reportBatchId || "").trim();
  const draftSource = buildCreateDeliveryDraftPayload({
    document_type: form.document_type,
    jobSheetId: resolvedJobId,
    reportBatchId: resolvedBatchId,
    sourceType,
  });
  const canCreateDraft = draftSource.ok;

  async function refresh() {
    const q = new URLSearchParams();
    if (resolvedJobId) q.set("job_sheet_id", resolvedJobId);
    if (resolvedBatchId) q.set("report_batch_id", resolvedBatchId);
    const suffix = q.toString() ? `?${q}` : "";
    const [opts, list] = await Promise.all([
      api("/deliveries/options"),
      api(`/deliveries${suffix}`),
    ]);
    setOptions(opts);
    setItems(list.items || []);
    if (resolvedJobId) {
      const att = await api(`/jobs/${encodeURIComponent(resolvedJobId)}/attachments`);
      setAttachments(att.items || []);
    } else {
      setAttachments([]);
    }
  }

  useEffect(() => {
    // Drop stale selection when switching jobs/reports.
    setSelected(null);
    setPreview(null);
    setItems([]);
    setAttachments([]);
    setError("");
    setMessage("");
    let cancelled = false;
    (async () => {
      try {
        await refresh();
      } catch (err) {
        if (!cancelled) setError(err.message || "Failed to load deliveries");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedJobId, resolvedBatchId, sourceType]);

  function describeError(err) {
    return err.message || "Delivery request failed";
  }

  function logDraftDebug(meta) {
    if (typeof import.meta === "undefined" || !import.meta.env?.DEV) return;
    // Safe diagnostics only — never recipients, tokens, notes, or PDF content.
    console.debug("[FieldOS delivery draft]", {
      source_type: meta.source_type,
      has_job_sheet_id: meta.has_job_sheet_id,
      has_report_batch_id: meta.has_report_batch_id,
    });
  }

  async function createDraft() {
    setBusy("create");
    setError("");
    setMessage("");
    try {
      const method = form.drive_filing
        ? form.delivery_method === "email"
          ? "email_and_drive"
          : form.delivery_method
        : form.delivery_method;
      const built = buildCreateDeliveryDraftPayload({
        document_type: form.document_type,
        recipient_email: form.recipient_email,
        recipient_type: form.recipient_type,
        delivery_method: method,
        jobSheetId: resolvedJobId,
        reportBatchId: resolvedBatchId,
        completionId,
        customerName,
        projectName,
        attachment_ids: attachments.filter((a) => a.client_visible).map((a) => a.attachment_id),
        sourceType,
      });
      logDraftDebug(built);
      if (!built.ok) {
        setError(built.error || MISSING_DELIVERY_SOURCE_MESSAGE);
        return;
      }
      const result = await api("/deliveries", {
        method: "POST",
        json: deliveryDraftRequestBody(built.payload),
      });
      setSelected(result.delivery);
      setPreview(result.email_preview);
      setMessage(`Draft ${result.delivery.delivery_id} created.`);
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy("");
    }
  }

  async function runAction(action, needsConfirm = false) {
    if (!selected) return;
    if (needsConfirm && !window.confirm(confirmSendMessage(selected))) return;
    setBusy(action);
    setError("");
    setMessage("");
    try {
      const path =
        action === "preview"
          ? `/deliveries/${encodeURIComponent(selected.delivery_id)}/preview`
          : action === "validate"
            ? `/deliveries/${encodeURIComponent(selected.delivery_id)}/validate`
            : action === "send"
              ? `/deliveries/${encodeURIComponent(selected.delivery_id)}/send`
              : action === "retry"
                ? `/deliveries/${encodeURIComponent(selected.delivery_id)}/retry`
                : action === "cancel"
                  ? `/deliveries/${encodeURIComponent(selected.delivery_id)}/cancel`
                  : `/deliveries/${encodeURIComponent(selected.delivery_id)}/supersede`;
      const json =
        action === "send" || action === "retry"
          ? {
              expected_version: selected.version,
              confirm_send: true,
              customer_name: customerName || undefined,
              project_name: projectName || undefined,
            }
          : action === "preview"
            ? {
                customer_name: customerName || undefined,
                project_name: projectName || undefined,
              }
            : { expected_version: selected.version };
      const result = await api(path, { method: "POST", json });
      setSelected(result.delivery);
      if (result.replacement) setSelected(result.replacement);
      if (result.email_preview) setPreview(result.email_preview);
      if (result.delivery?.status === "Failed" && result.delivery?.failure_reason) {
        setMessage(`${action} → Failed: ${result.delivery.failure_reason}`);
      } else {
        setMessage(`${action} → ${result.delivery.status}`);
      }
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError("Your session has expired. Please sign in again.");
      } else {
        setError(describeError(err));
      }
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="export-panel" style={{ marginTop: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Deliver PDF</h2>
      <p className="small muted">
        Manager-confirmed email / optional private Drive filing. Never automatic.{" "}
        {providerDisabledMessage(options)}
      </p>

      <div className="filter-panel" style={{ marginBottom: "0.75rem" }}>
        <label>
          Profile
          <select
            value={form.document_type}
            onChange={(e) => setForm({ ...form, document_type: e.target.value })}
          >
            {(options.profiles || PDF_PROFILES).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          Recipient email
          <input
            type="email"
            value={form.recipient_email}
            onChange={(e) => setForm({ ...form, recipient_email: e.target.value })}
            placeholder="client@example.com"
          />
        </label>
        <label>
          Method
          <select
            value={form.delivery_method}
            onChange={(e) => setForm({ ...form, delivery_method: e.target.value })}
          >
            {(options.delivery_methods || DELIVERY_METHODS).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          <input
            type="checkbox"
            checked={form.drive_filing}
            onChange={(e) => setForm({ ...form, drive_filing: e.target.checked })}
          />{" "}
          Also file to private Drive (disabled by default)
        </label>
        <div className="panel-actions">
          <button
            className="btn btn-primary"
            type="button"
            disabled={!!busy || !canCreateDraft}
            onClick={createDraft}
            title={canCreateDraft ? undefined : MISSING_DELIVERY_SOURCE_MESSAGE}
          >
            {busy === "create" ? "Creating…" : "Create delivery draft"}
          </button>
        </div>
        {!canCreateDraft ? (
          <p className="small muted" style={{ marginTop: "0.5rem" }}>
            {MISSING_DELIVERY_SOURCE_MESSAGE}
          </p>
        ) : (
          <p className="small muted" style={{ marginTop: "0.5rem" }}>
            Source:{" "}
            {draftSource.source_type === "report"
              ? `report ${resolvedBatchId}`
              : `job ${resolvedJobId}`}
          </p>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}
      {message && <div className="success-box">{message}</div>}

      {preview && (
        <div className="card" style={{ marginBottom: "0.75rem" }}>
          <h3 style={{ marginTop: 0 }}>Email preview</h3>
          <p className="small">
            <strong>To:</strong> {preview.to}
          </p>
          <p className="small">
            <strong>Subject:</strong> {preview.subject}
          </p>
          <pre className="small" style={{ whiteSpace: "pre-wrap" }}>
            {preview.body}
          </pre>
        </div>
      )}

      {selected && (
        <div className="panel-actions" style={{ marginBottom: "0.75rem" }}>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={!!busy}
            onClick={() => runAction("preview")}
          >
            {busy === "preview" ? "Preview…" : "Preview"}
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={!!busy || !canValidateDelivery(selected.status)}
            onClick={() => runAction("validate")}
          >
            Validate
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={!!busy || !canSendDelivery(selected.status)}
            onClick={() => runAction("send", true)}
          >
            {busy === "send" ? "Sending…" : "Confirm send"}
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={!!busy || !canRetryDelivery(selected.status)}
            onClick={() => runAction("retry", true)}
          >
            Retry
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={!!busy || !canCancelDelivery(selected.status)}
            onClick={() => runAction("cancel")}
          >
            Cancel
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={!!busy || !canSupersedeDelivery(selected.status)}
            onClick={() => runAction("supersede")}
          >
            Supersede
          </button>
          {!canEditDelivery(selected.status) ? null : (
            <span className="small muted">Editing allowed while Draft/Failed</span>
          )}
        </div>
      )}

      <h3>Delivery history</h3>
      {items.length === 0 ? (
        <p className="small muted">{emptyDeliveryMessage()}</p>
      ) : (
        <ul className="plain-list">
          {items.map((row) => (
            <li key={row.delivery_id}>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "auto" }}
                onClick={() => {
                  setSelected(row);
                  setPreview({ to: row.recipient_email, subject: row.subject, body: row.body_preview });
                }}
              >
                {row.delivery_id} · {row.document_type} ·{" "}
                <span data-tone={deliveryStatusTone(row.status)}>{row.status}</span>
                {row.recipient_email ? ` → ${row.recipient_email}` : ""}
              </button>
            </li>
          ))}
        </ul>
      )}

      {resolvedJobId ? (
        <>
          <h3>Job attachments</h3>
          <p className="small muted">
            Photos, plans, receipts, signed docs. Client-visible requires manager approval. No
            executables. {options.antivirus_boundary || ""}
          </p>
          {attachments.length === 0 ? (
            <p className="small muted">No attachments uploaded for this job.</p>
          ) : (
            <ul className="plain-list">
              {attachments.map((a) => (
                <li key={a.attachment_id} className="small">
                  {a.file_name} · {a.attachment_type} · {a.client_visible ? "client-visible" : "internal"} ·{" "}
                  {a.status}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
