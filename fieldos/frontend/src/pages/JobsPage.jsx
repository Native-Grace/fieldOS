import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, clearSession, getStaff } from "../api";

function statusClass(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("fail")) return "badge failed";
  if (s.includes("queue") || s.includes("process")) return "badge queued";
  if (s.includes("complete")) return "badge completed";
  return "badge";
}

export default function JobsPage() {
  const staff = getStaff();
  const [items, setItems] = useState([]);
  const [days, setDays] = useState(7);
  const [error, setError] = useState("");
  const [assumptions, setAssumptions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const data = await api("/jobs/mine?days=7");
        if (cancelled) return;
        setItems(data.items || []);
        setDays(data.days);
        setAssumptions(data.assumptions || []);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function logout() {
    clearSession();
    window.location.href = "/login";
  }

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>My Jobs</h1>
          <p className="small muted" style={{ margin: 0 }}>
            {staff?.staff_name} · last {days} days
          </p>
        </div>
        <button className="btn btn-ghost" style={{ width: "auto" }} onClick={logout} type="button">
          Log out
        </button>
      </div>

      {assumptions.length > 0 && (
        <div className="warn-box">
          <strong>Phase 1 assumptions</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {assumptions.slice(0, 2).map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
      {loading && <p className="muted">Loading jobs…</p>}
      {!loading && !error && items.length === 0 && (
        <div className="card">No jobs in the last {days} days.</div>
      )}

      {items.map((job) => (
        <Link key={job.job_sheet_id} className="job-row" to={`/jobs/${job.job_sheet_id}`}>
          <div className="job-id">{job.job_sheet_id}</div>
          <div className="job-title">
            {job.customer_name || "Customer"} · {job.project_name || "Project"}
          </div>
          <div className="meta">
            <span>{job.job_date || "—"}</span>
            <span className={statusClass(job.processing_status)}>
              {job.processing_status || "Draft"}
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
