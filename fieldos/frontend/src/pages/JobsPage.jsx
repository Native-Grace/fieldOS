import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, clearSession, getStaff } from "../api";
import {
  DEFAULT_JOBS_DAYS,
  JOBS_RANGE_OPTIONS,
  emptyJobsMessage,
  fetchMyJobs,
  loadJobsDays,
  normalizeJobsDays,
  saveJobsDays,
} from "../jobsRange";

function statusClass(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("fail")) return "badge failed";
  if (s.includes("queue") || s.includes("process")) return "badge queued";
  if (s.includes("complete")) return "badge completed";
  return "badge";
}

function initialDays() {
  if (typeof localStorage === "undefined") return DEFAULT_JOBS_DAYS;
  return loadJobsDays(localStorage);
}

export default function JobsPage() {
  const staff = getStaff();
  const [items, setItems] = useState([]);
  const [days, setDays] = useState(initialDays);
  const [error, setError] = useState("");
  const [assumptions, setAssumptions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const data = await fetchMyJobs({ days, api });
        if (cancelled) return;
        setItems(data.items);
        setAssumptions(data.assumptions);
      } catch (err) {
        if (!cancelled) {
          setItems([]);
          setError(err.message || "Failed to load jobs");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  function onRangeChange(event) {
    const next = normalizeJobsDays(event.target.value);
    setDays(next);
    if (typeof localStorage !== "undefined") saveJobsDays(localStorage, next);
  }

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
        <div className="topbar-actions">
          <label className="range-select">
            <span className="visually-hidden">Date range</span>
            <select
              value={days}
              onChange={onRangeChange}
              disabled={loading}
              aria-label="Job date range"
            >
              {JOBS_RANGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-ghost" style={{ width: "auto" }} onClick={logout} type="button">
            Log out
          </button>
        </div>
      </div>

      {assumptions.length > 0 && (
        <div className="warn-box">
          <strong>FieldOS notes</strong>
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
        <div className="card">{emptyJobsMessage(days)}</div>
      )}

      {!loading &&
        items.map((job) => (
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
