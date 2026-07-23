import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, uploadRecording } from "../api";
import {
  ACCEPT_ATTR,
  buildFilePreview,
  isProcessingStatus,
  safeUserError,
  validateSelectedAudioFile,
} from "../recordingFileUpload";

function statusClass(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("fail")) return "badge failed";
  if (s === "invalid") return "badge failed";
  if (s.includes("queue") || s.includes("process")) return "badge queued";
  if (s.includes("complete") || s === "processed" || s === "saved") return "badge completed";
  return "badge";
}

export default function JobDetailPage() {
  const { jobSheetId } = useParams();
  const navigate = useNavigate();
  const fileInputRef = useRef(null);

  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [processMsg, setProcessMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutatingId, setMutatingId] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [filePreview, setFilePreview] = useState(null);
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const uploadLockRef = useRef(false);

  async function load() {
    setError("");
    try {
      const detail = await api(`/jobs/${encodeURIComponent(jobSheetId)}`);
      setData(detail);
    } catch (err) {
      setError(safeUserError(err));
    }
  }

  useEffect(() => {
    load();
  }, [jobSheetId]);

  const processing = isProcessingStatus(data?.job?.processing_status);
  const mutationBusy = busy || uploading || !!mutatingId;

  async function triggerProcess() {
    if (mutationBusy) return;
    setBusy(true);
    setProcessMsg("");
    try {
      const res = await api(`/jobs/${encodeURIComponent(jobSheetId)}/process`, {
        method: "POST",
        json: { force_reprocess: false },
      });
      setProcessMsg(`${res.status}: ${res.message}`);
      await load();
    } catch (err) {
      setProcessMsg(safeUserError(err));
    } finally {
      setBusy(false);
    }
  }

  function onFilePicked(event) {
    const file = event.target.files && event.target.files[0];
    setUploadError("");
    if (!file) {
      setSelectedFile(null);
      setFilePreview(null);
      return;
    }
    const validation = validateSelectedAudioFile(file);
    setSelectedFile(file);
    setFilePreview(buildFilePreview(file, validation));
    if (!validation.ok) setUploadError(validation.message);
  }

  function clearFileSelection() {
    setSelectedFile(null);
    setFilePreview(null);
    setUploadError("");
    setUploadProgress(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function uploadSelectedFile() {
    if (!selectedFile || uploadLockRef.current || uploading || processing) return;
    const validation = validateSelectedAudioFile(selectedFile);
    if (!validation.ok) {
      setUploadError(validation.message);
      setFilePreview(buildFilePreview(selectedFile, validation));
      return;
    }
    uploadLockRef.current = true;
    setUploading(true);
    setUploadError("");
    setUploadProgress(0);
    try {
      await uploadRecording(jobSheetId, selectedFile, {
        durationSeconds: 0,
        triggerProcessing: false,
        mimeType: selectedFile.type || validation.mimeType,
        filename: selectedFile.name,
        onProgress: setUploadProgress,
      });
      clearFileSelection();
      await load();
    } catch (err) {
      setUploadError(safeUserError(err));
    } finally {
      setUploading(false);
      uploadLockRef.current = false;
    }
  }

  async function markInvalid(recording) {
    if (mutationBusy || processing) return;
    const ok = window.confirm(
      `Mark recording #${recording.recording_order || recording.recording_id} as Invalid?\nIt will be skipped by voice processing.`
    );
    if (!ok) return;
    const reasonInput = window.prompt("Optional reason (leave blank for default):", "");
    if (reasonInput === null) return;
    const reason = String(reasonInput || "").trim() || "Marked invalid by user.";
    setMutatingId(recording.recording_id);
    setError("");
    try {
      await api(
        `/jobs/${encodeURIComponent(jobSheetId)}/recordings/${encodeURIComponent(recording.recording_id)}/invalidate`,
        { method: "POST", json: { reason } }
      );
      await load();
    } catch (err) {
      setError(safeUserError(err));
    } finally {
      setMutatingId("");
    }
  }

  async function deleteRecording(recording) {
    if (mutationBusy || processing) return;
    const ok = window.confirm("Delete this recording? This cannot be undone.");
    if (!ok) return;
    setMutatingId(recording.recording_id);
    setError("");
    try {
      await api(
        `/jobs/${encodeURIComponent(jobSheetId)}/recordings/${encodeURIComponent(recording.recording_id)}`,
        { method: "DELETE" }
      );
      await load();
    } catch (err) {
      setError(safeUserError(err));
    } finally {
      setMutatingId("");
    }
  }

  if (error && !data) {
    return (
      <div>
        <Link to="/">← Back</Link>
        <div className="error-box">{error}</div>
      </div>
    );
  }

  if (!data) return <p className="muted">Loading…</p>;

  const job = data.job;
  const canUpload = !!(filePreview && filePreview.ok) && !uploading && !processing && !mutationBusy;

  return (
    <div>
      <div className="topbar">
        <Link to="/" className="small">
          ← My Jobs
        </Link>
      </div>

      <div className="card">
        <div className="job-id">{job.job_sheet_id}</div>
        <h1 style={{ margin: "6px 0" }}>
          {job.customer_name || "Customer"} · {job.project_name || "Project"}
        </h1>
        <div className="meta">
          <span>{job.job_date || "—"}</span>
          <span className={statusClass(job.processing_status)}>
            {job.processing_status || "Draft"}
          </span>
          {job.approval_status ? <span className="badge">{job.approval_status}</span> : null}
        </div>

        {job.processing_error ? (
          <div className="error-box">
            <strong>Processing error</strong>
            {"\n"}
            {job.processing_error}
          </div>
        ) : null}

        {error ? <div className="error-box">{error}</div> : null}

        <button
          className="btn btn-primary"
          type="button"
          onClick={() => navigate(`/jobs/${job.job_sheet_id}/record`)}
        >
          Record voice note
        </button>
        <button className="btn btn-ghost" type="button" disabled={mutationBusy} onClick={triggerProcess}>
          {busy ? "Submitting…" : "Submit for processing"}
        </button>
        {processMsg && <p className="status-line">{processMsg}</p>}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Upload audio file</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          Accepts webm, wav, mp3, m4a, mp4, ogg, flac. Files under 1 KB are rejected.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          disabled={uploading || processing}
          onChange={onFilePicked}
        />
        {filePreview && (
          <div className={`file-preview ${filePreview.ok ? "" : "file-preview-bad"}`}>
            <div>
              <strong>{filePreview.filename}</strong>
            </div>
            <div className="small muted">
              {filePreview.formattedSize} · {filePreview.mimeType || "unknown type"} ·{" "}
              {filePreview.ok ? "Ready to upload" : "Invalid"}
            </div>
            {!filePreview.ok && filePreview.message ? (
              <div className="small">{filePreview.message}</div>
            ) : null}
          </div>
        )}
        {uploadError ? <div className="error-box">{uploadError}</div> : null}
        {uploading ? (
          <div className="progress">
            <span style={{ width: `${uploadProgress}%` }} />
          </div>
        ) : null}
        <div className="row-actions">
          <button className="btn btn-primary" type="button" disabled={!canUpload} onClick={uploadSelectedFile}>
            {uploading ? "Uploading…" : "Upload"}
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={uploading || (!selectedFile && !filePreview)}
            onClick={clearFileSelection}
          >
            Cancel
          </button>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Recordings</h2>
        {data.recordings.length === 0 && <p className="muted">No recordings yet.</p>}
        {data.recordings.map((r) => {
          const invalid = String(r.status || "").trim() === "Invalid";
          const rowBusy = mutatingId === r.recording_id;
          const actionsDisabled = mutationBusy || processing;
          return (
            <div className={`list-item ${invalid ? "list-item-invalid" : ""}`} key={r.recording_id}>
              <div>
                <strong>#{r.recording_order}</strong> {r.recording_name || r.recording_id}
              </div>
              <div className="meta" style={{ marginTop: 4 }}>
                <span className={statusClass(r.status)}>{r.status || "Saved"}</span>
                <span className="small muted">{r.duration_seconds || 0}s</span>
                <span className="small muted">{r.transcript ? "Has transcript" : "No transcript"}</span>
              </div>
              {invalid && (r.invalid_reason || "").trim() ? (
                <div className="small muted">Reason: {r.invalid_reason}</div>
              ) : null}
              {invalid ? (
                <div className="small muted">Skipped by voice processing.</div>
              ) : null}
              <div className="row-actions">
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={actionsDisabled || invalid}
                  onClick={() => markInvalid(r)}
                >
                  {rowBusy ? "Working…" : "Mark invalid"}
                </button>
                <button
                  className="btn btn-danger"
                  type="button"
                  disabled={actionsDisabled}
                  onClick={() => deleteRecording(r)}
                >
                  {rowBusy ? "Working…" : "Delete"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
