import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";

function statusClass(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("fail")) return "badge failed";
  if (s.includes("queue") || s.includes("process")) return "badge queued";
  if (s.includes("complete")) return "badge completed";
  return "badge";
}

export default function JobDetailPage() {
  const { jobSheetId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [processMsg, setProcessMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setError("");
    try {
      const detail = await api(`/jobs/${encodeURIComponent(jobSheetId)}`);
      setData(detail);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, [jobSheetId]);

  async function triggerProcess() {
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
      setProcessMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div>
        <Link to="/">← Back</Link>
        <div className="error-box">{error}</div>
      </div>
    );
  }

  if (!data) return <p className="muted">Loading…</p>;

  const job = data.job;

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

        <button className="btn btn-primary" type="button" onClick={() => navigate(`/jobs/${job.job_sheet_id}/record`)}>
          Record voice note
        </button>
        <button className="btn btn-ghost" type="button" disabled={busy} onClick={triggerProcess}>
          {busy ? "Submitting…" : "Submit for processing"}
        </button>
        {processMsg && <p className="status-line">{processMsg}</p>}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Recordings</h2>
        {data.recordings.length === 0 && <p className="muted">No recordings yet.</p>}
        {data.recordings.map((r) => (
          <div className="list-item" key={r.recording_id}>
            <div>
              <strong>#{r.recording_order}</strong> {r.recording_name || r.recording_id}
            </div>
            <div className="small muted">
              {r.status} · {r.duration_seconds || 0}s
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
