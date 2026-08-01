/**
 * Daily Work Job Sheet — pure helpers for the wizard UI.
 */

export {
  AUDIO_FILE_ACCEPT,
  DEFAULT_MAX_UPLOAD_MB,
  SOURCE_BROWSER_RECORDING,
  SOURCE_UPLOADED_FILE,
} from "./newJobFromRecordingHelpers.mjs";

const LIST_FIELDS = [
  "work_completed",
  "materials_used",
  "equipment_used",
  "hours_or_times",
  "site_conditions",
  "issues_found",
  "client_requests",
  "follow_up_required",
  "safety_notes",
];

export function canShowDailyWorkJobSheet(role) {
  const r = String(role || "").trim().toLowerCase();
  if (!r) return false;
  if (r === "admin" || r === "administrator") return true;
  if (r === "manager" || r === "mgr") return true;
  return true;
}

export function sydneyTodayISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function emptyReviewedJobSheet() {
  return {
    customer_name: "",
    project_name: "",
    project_id: "",
    work_date: "",
    staff_ids: [],
    staff_names: [],
    work_completed: [],
    materials_used: [],
    equipment_used: [],
    hours_or_times: [],
    site_conditions: [],
    issues_found: [],
    client_requests: [],
    follow_up_required: [],
    safety_notes: [],
    manager_notes: "",
    completion_summary: "",
    site_address: "",
  };
}

function asItemList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") {
        const text = String(item || "").trim();
        return text ? { text, recording_ids: [] } : null;
      }
      if (item && typeof item === "object") {
        const text = String(item.text || item.item || "").trim();
        if (!text) return null;
        const ids = item.recording_ids || item.sources || [];
        const recording_ids = (Array.isArray(ids) ? ids : [ids])
          .map((x) => String(x || "").trim())
          .filter(Boolean);
        return { text, recording_ids };
      }
      return null;
    })
    .filter(Boolean);
}

export function reviewedJobSheetFromExtraction(extraction = {}) {
  const sheet = extraction.job_sheet || {};
  const out = emptyReviewedJobSheet();
  for (const key of [
    "customer_name",
    "project_name",
    "project_id",
    "work_date",
    "manager_notes",
    "completion_summary",
    "site_address",
  ]) {
    if (sheet[key] != null) out[key] = String(sheet[key] || "").trim();
  }
  for (const key of ["staff_ids", "staff_names"]) {
    const raw = sheet[key];
    if (Array.isArray(raw)) {
      out[key] = raw.map((x) => String(x || "").trim()).filter(Boolean);
    } else if (raw) {
      out[key] = [String(raw).trim()];
    }
  }
  for (const key of LIST_FIELDS) {
    out[key] = asItemList(sheet[key]);
  }
  if (!out.work_date) {
    out.work_date = String(extraction.work_date || "").trim();
  }
  return out;
}

export function makeIdempotencyKey(workSessionId) {
  const rand =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `dw-${String(workSessionId || "x")}-${rand}`;
}

function bulletLines(items) {
  const lines = [];
  for (const item of items || []) {
    const text =
      item && typeof item === "object"
        ? String(item.text || "").trim()
        : String(item || "").trim();
    if (text) lines.push(`- ${text}`);
  }
  return lines;
}

/** Deterministic manager_notes preview — mirrors backend format_manager_notes. */
export function formatManagerNotesPreview(job = {}) {
  const sections = [
    ["WORK COMPLETED", bulletLines(job.work_completed)],
    ["MATERIALS USED", bulletLines(job.materials_used)],
    ["EQUIPMENT USED", bulletLines(job.equipment_used)],
    ["HOURS / TIMES", bulletLines(job.hours_or_times)],
    ["SITE CONDITIONS", bulletLines(job.site_conditions)],
    ["ISSUES FOUND", bulletLines(job.issues_found)],
    ["CLIENT REQUESTS", bulletLines(job.client_requests)],
    ["FOLLOW-UP REQUIRED", bulletLines(job.follow_up_required)],
    ["SAFETY / SITE NOTES", bulletLines(job.safety_notes)],
  ];
  const blocks = [];
  for (const [title, lines] of sections) {
    if (!lines.length) continue;
    blocks.push(`${title}\n${lines.join("\n")}`);
  }
  const summary = String(job.completion_summary || "").trim();
  if (summary) blocks.push(`SUMMARY\n${summary}`);
  const extra = String(job.manager_notes || "").trim();
  if (extra && !extra.startsWith("WORK COMPLETED")) {
    blocks.push(`MANAGER NOTES\n${extra}`);
  }
  return blocks.join("\n\n").trim();
}

export function moveItemBetweenLists(job, fromField, toField, index) {
  const out = JSON.parse(JSON.stringify(job || emptyReviewedJobSheet()));
  const src = Array.isArray(out[fromField]) ? [...out[fromField]] : [];
  if (index < 0 || index >= src.length) return out;
  const item = src.splice(index, 1)[0];
  const dst = Array.isArray(out[toField]) ? [...out[toField]] : [];
  dst.push(item);
  out[fromField] = src;
  out[toField] = dst;
  return out;
}

export function validateReviewedJobSheetLocally(job = {}) {
  const customerOk =
    String(job.customer_name || "").trim() ||
    String(job.project_id || "").trim() ||
    String(job.project_name || "").trim();
  const projectOk = String(job.project_id || "").trim() || String(job.project_name || "").trim();
  const workDate = String(job.work_date || "").trim();
  const staffIds = Array.isArray(job.staff_ids) ? job.staff_ids : [];
  const staffNames = Array.isArray(job.staff_names) ? job.staff_names : [];
  const completed = Array.isArray(job.work_completed) ? job.work_completed : [];
  const summary = String(job.completion_summary || "").trim();

  if (!customerOk) return { ok: false, error: "Customer or project is required." };
  if (!projectOk) return { ok: false, error: "Project is required." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
    return { ok: false, error: "Work date must be YYYY-MM-DD." };
  }
  if (!staffIds.length && !staffNames.some((n) => String(n || "").trim())) {
    return { ok: false, error: "At least one staff member is required." };
  }
  if (!completed.length && !summary) {
    return { ok: false, error: "Work completed or completion summary is required." };
  }
  return { ok: true, error: "" };
}

export const ACTIVE_DAILY_WORK_SESSION_KEY = "fieldos_daily_work_active_session_id";

export function sessionStorageKey(workSessionId) {
  return `fieldos_daily_work_session_${String(workSessionId || "").trim()}`;
}

export function sortRecordingsChronologically(recordings) {
  const list = Array.isArray(recordings) ? [...recordings] : [];
  return list.sort((a, b) => {
    const ra = String(a.recorded_at || a.created_at || "");
    const rb = String(b.recorded_at || b.created_at || "");
    if (ra !== rb) return ra.localeCompare(rb);
    const sa = Number(a.sequence || 0);
    const sb = Number(b.sequence || 0);
    if (sa !== sb) return sa - sb;
    return String(a.recording_id || "").localeCompare(String(b.recording_id || ""));
  });
}
