import { useEffect, useMemo, useState } from "react";
import { api, ApiError, getStaff } from "../api";
import {
  buildReviewForm,
  escapeText,
  isManagerRole,
  reviewHasUnsavedChanges,
  EMPTY_REVIEW_FORM,
} from "../managerReviewHelpers.mjs";

export default function ManagerReviewPanel({ jobSheetId, onUpdated }) {
  const staff = getStaff();
  const manager = isManagerRole(staff?.role);

  const [review, setReview] = useState(null);
  const [form, setForm] = useState(EMPTY_REVIEW_FORM);
  const [baseline, setBaseline] = useState(EMPTY_REVIEW_FORM);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const [showReturn, setShowReturn] = useState(false);

  const dirty = useMemo(() => reviewHasUnsavedChanges(form, baseline), [form, baseline]);

  async function load(includeTranscript = false) {
    setError("");
    const path =
      `/jobs/${encodeURIComponent(jobSheetId)}/review` +
      (includeTranscript ? "?include_transcript=true" : "");
    const data = await api(path);
    setReview(data);
    const next = buildReviewForm(data.job);
    setForm(next);
    setBaseline(next);
    if (includeTranscript) setTranscript(data.job?.ai_transcript || "");
    return data;
  }

  useEffect(() => {
    load().catch((err) => setError(String(err.message || err)));
  }, [jobSheetId]);

  useEffect(() => {
    function onBeforeUnload(event) {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function concurrencyBody(extra = {}) {
    return {
      ...form,
      expected_approval_status: review?.job?.approval_status || "",
      expected_processing_completed_at: review?.job?.processing_completed_at || "",
      ...extra,
    };
  }

  async function runAction(path, method, body) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const data = await api(path, { method, json: body });
      setReview(data);
      const next = buildReviewForm(data.job);
      setForm(next);
      setBaseline(next);
      setMessage(data.job?.approval_status || "Saved");
      if (onUpdated) onUpdated(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("This review changed elsewhere. Refresh and try again.");
      } else {
        setError(String(err.message || err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    await runAction(
      `/jobs/${encodeURIComponent(jobSheetId)}/review`,
      "PATCH",
      concurrencyBody()
    );
  }

  async function approve() {
    if (!window.confirm("Approve this job sheet?")) return;
    await runAction(
      `/jobs/${encodeURIComponent(jobSheetId)}/approve`,
      "POST",
      concurrencyBody()
    );
  }

  async function reopen() {
    if (!window.confirm("Reopen this approved job for review?")) return;
    await runAction(`/jobs/${encodeURIComponent(jobSheetId)}/reopen`, "POST", {
      expected_approval_status: review?.job?.approval_status || "",
      expected_processing_completed_at: review?.job?.processing_completed_at || "",
    });
  }

  async function submitReturn() {
    const reason = returnReason.trim();
    if (!reason) {
      setError("Return reason is required.");
      return;
    }
    await runAction(
      `/jobs/${encodeURIComponent(jobSheetId)}/return`,
      "POST",
      concurrencyBody({ return_reason: reason })
    );
    setShowReturn(false);
    setReturnReason("");
  }

  async function expandTranscript() {
    if (!manager) return;
    setBusy(true);
    try {
      const data = await load(true);
      setTranscript(data.job?.ai_transcript || "");
      setTranscriptExpanded(true);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  if (!review) {
    return (
      <section className="card" aria-label="Manager review">
        <h2>Manager review</h2>
        {error ? <p className="error">{error}</p> : <p className="sub">Loading review…</p>}
      </section>
    );
  }

  const job = review.job;
  const readOnly = !manager || !review.can_edit;
  const approved = String(job.approval_status || "") === "Approved";

  function field(id, label, multiline = true) {
    return (
      <div className="field" key={id}>
        <label htmlFor={`review-${id}`}>{label}</label>
        {multiline ? (
          <textarea
            id={`review-${id}`}
            rows={id === "ai_summary" ? 4 : 3}
            value={form[id]}
            disabled={readOnly || busy}
            onChange={(e) => setForm((prev) => ({ ...prev, [id]: e.target.value }))}
          />
        ) : (
          <input
            id={`review-${id}`}
            value={form[id]}
            disabled={readOnly || busy}
            onChange={(e) => setForm((prev) => ({ ...prev, [id]: e.target.value }))}
          />
        )}
      </div>
    );
  }

  return (
    <section className="card" aria-label="Manager review">
      <h2>Manager review</h2>
      <p className="sub">
        Confidence:{" "}
        {job.ai_confidence_score == null ? "—" : Number(job.ai_confidence_score).toFixed(2)} ·{" "}
        Approval: <strong>{job.approval_status || "—"}</strong>
      </p>
      {job.return_reason ? (
        <p className="error" role="status">
          Return reason: {job.return_reason}
        </p>
      ) : null}
      {dirty ? <p className="sub">You have unsaved changes.</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="ok">{message}</p> : null}

      {field("ai_summary", "AI summary")}
      {field("client_requests", "Client requests")}
      {field("variations", "Variations")}
      {field("safety_issues", "Safety issues")}
      {field("manager_review_items", "Manager review items")}
      {field("weather", "Weather", false)}
      {field("travel_time", "Travel time", false)}
      {field("manager_notes", "Manager notes")}

      <div className="field">
        <label>Transcript preview</label>
        <p className="sub">{job.ai_transcript_character_count || 0} characters</p>
        {!transcriptExpanded ? (
          manager ? (
            <button type="button" className="secondary" disabled={busy} onClick={expandTranscript}>
              Expand transcript
            </button>
          ) : (
            <p className="sub">Transcript available to managers only.</p>
          )
        ) : (
          <pre
            className="transcript-preview"
            dangerouslySetInnerHTML={{ __html: escapeText(transcript) }}
          />
        )}
      </div>

      {manager ? (
        <div className="row gap">
          <button type="button" disabled={busy || approved} onClick={saveDraft}>
            Save changes
          </button>
          <button
            type="button"
            disabled={busy || !review.can_approve || String(job.processing_status) !== "Completed"}
            onClick={approve}
          >
            Approve
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setShowReturn(true)}>
            Return
          </button>
          {approved ? (
            <button type="button" className="secondary" disabled={busy} onClick={reopen}>
              Reopen review
            </button>
          ) : null}
          {error && error.includes("Refresh") ? (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => load().catch((err) => setError(String(err.message || err)))}
            >
              Refresh
            </button>
          ) : null}
        </div>
      ) : (
        <p className="sub">Staff view is read-only for review fields.</p>
      )}

      {showReturn ? (
        <div className="card nested" role="dialog" aria-label="Return for correction">
          <div className="field">
            <label htmlFor="return-reason">Return reason</label>
            <textarea
              id="return-reason"
              rows={3}
              value={returnReason}
              onChange={(e) => setReturnReason(e.target.value)}
            />
          </div>
          <div className="row gap">
            <button type="button" disabled={busy} onClick={submitReturn}>
              Confirm return
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setShowReturn(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
