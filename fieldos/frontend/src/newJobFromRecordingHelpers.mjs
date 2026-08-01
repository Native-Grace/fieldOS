/**
 * Create Job from Recording — pure helpers for the wizard UI.
 */

export const WIZARD_STEPS = [
  "record",
  "transcribing",
  "review",
  "confirm",
  "created",
];

export const SOURCE_UPLOADED_FILE = "uploaded_file";
export const SOURCE_BROWSER_RECORDING = "browser_recording";

/** Matches FieldOS backend ALLOWED_AUDIO_MIMES + common extensions. */
export const AUDIO_FILE_ACCEPT =
  "audio/*,audio/webm,audio/mp4,audio/mpeg,audio/wav,audio/ogg,.m4a,.mp3,.wav,.webm,.ogg,.mp4";

export const SUPPORTED_AUDIO_EXTENSIONS = new Set([
  "webm",
  "mp3",
  "wav",
  "ogg",
  "mp4",
  "m4a",
  "mpeg",
  "mpga",
  "oga",
  "flac",
]);

export const SUPPORTED_AUDIO_MIMES = new Set([
  "audio/webm",
  "video/webm",
  "audio/mp4",
  "video/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "application/ogg",
  "audio/x-m4a",
  "audio/flac",
  "audio/x-flac",
]);

/** Default aligns with backend MAX_UPLOAD_MB. */
export const DEFAULT_MAX_UPLOAD_MB = 25;
export const MIN_UPLOAD_BYTES = 1024;

export function canShowNewJobFromRecording(role) {
  const r = String(role || "").trim().toLowerCase();
  return r === "manager" || r === "admin";
}

export function formatByteSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function extensionOf(filename) {
  const name = String(filename || "");
  const i = name.lastIndexOf(".");
  if (i < 0) return "";
  return name.slice(i + 1).toLowerCase();
}

export function guessMimeFromExtension(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === "webm") return "audio/webm";
  if (e === "mp3" || e === "mpeg" || e === "mpga") return "audio/mpeg";
  if (e === "wav") return "audio/wav";
  if (e === "ogg" || e === "oga") return "audio/ogg";
  if (e === "mp4" || e === "m4a") return "audio/mp4";
  if (e === "flac") return "audio/flac";
  return "application/octet-stream";
}

/**
 * Client-side gate before multipart upload (no duration required for files).
 * @returns {{ ok: true, mimeType: string } | { ok: false, error: string }}
 */
export function validateAudioFileForUpload(file, { maxUploadMb = DEFAULT_MAX_UPLOAD_MB } = {}) {
  if (!file) {
    return { ok: false, error: "No audio file selected." };
  }
  const size = typeof file.size === "number" ? file.size : 0;
  if (size <= 0) {
    return { ok: false, error: "Selected file is empty." };
  }
  if (size < MIN_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `Audio file is too small (${formatByteSize(size)}). Minimum is ${MIN_UPLOAD_BYTES} bytes.`,
    };
  }
  const maxBytes = Math.max(1, Number(maxUploadMb) || DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024;
  if (size > maxBytes) {
    return {
      ok: false,
      error: `File is too large (${formatByteSize(size)}). Maximum upload size is ${maxUploadMb} MB.`,
    };
  }
  const mime = String(file.type || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const ext = extensionOf(file.name);
  const mimeKnown = mime && SUPPORTED_AUDIO_MIMES.has(mime);
  const mimeAudioGeneric = mime.startsWith("audio/");
  const extOk = ext && SUPPORTED_AUDIO_EXTENSIONS.has(ext);
  if (mime && !mimeKnown && !mimeAudioGeneric && !extOk) {
    return {
      ok: false,
      error: `Unsupported audio type (${mime}). Use webm, mp3, wav, ogg, m4a, or mp4.`,
    };
  }
  if (!mime && !extOk) {
    return {
      ok: false,
      error: "Unsupported audio file. Use webm, mp3, wav, ogg, m4a, or mp4.",
    };
  }
  return { ok: true, mimeType: mimeKnown || mimeAudioGeneric ? mime : guessMimeFromExtension(ext) };
}

export function emptyReviewedJob() {
  return {
    customer_id: "",
    customer_name: "",
    project_id: "",
    project_name: "",
    job_title: "",
    job_description: "",
    scheduled_date: "",
    scheduled_time: "",
    assigned_staff_ids: [],
    assigned_staff_names: [],
    site_address: "",
    contact_name: "",
    contact_phone: "",
    priority: "",
    status: "Scheduled",
    notes: "",
  };
}

export function reviewedJobFromExtraction(extraction = {}, matchReport = {}) {
  const job = extraction.job || {};
  const customer = matchReport.customer || {};
  const project = matchReport.project || {};
  const staffMatches = Array.isArray(matchReport.staff) ? matchReport.staff : [];
  const staffIds = staffMatches
    .filter((s) => s && s.status === "Matched" && s.matched_id)
    .map((s) => s.matched_id);
  const staffNames = (job.assigned_staff_names || []).map(String);
  return {
    ...emptyReviewedJob(),
    customer_id: customer.matched_id || "",
    customer_name: customer.matched_name || job.customer_name || "",
    project_id: project.matched_id || "",
    project_name: project.matched_name || job.project_name || "",
    job_title: String(job.job_title || "").trim(),
    job_description: String(job.job_description || "").trim(),
    scheduled_date: String(job.scheduled_date || "").trim(),
    scheduled_time: String(job.scheduled_time || "").trim(),
    assigned_staff_ids: staffIds,
    assigned_staff_names: staffNames,
    site_address: String(job.site_address || "").trim(),
    contact_name: String(job.contact_name || "").trim(),
    contact_phone: String(job.contact_phone || "").trim(),
    priority: String(job.priority || "").trim(),
    status: String(job.status || "Scheduled").trim() || "Scheduled",
    notes: String(job.notes || "").trim(),
  };
}

export function validateReviewedJobLocally(job = {}) {
  const customerOk = String(job.customer_id || "").trim() || String(job.customer_name || "").trim();
  const projectOk = String(job.project_id || "").trim() || String(job.project_name || "").trim();
  const titleOk =
    String(job.job_title || "").trim() || String(job.job_description || "").trim();
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(String(job.scheduled_date || "").trim());
  const staffOk =
    (Array.isArray(job.assigned_staff_ids) && job.assigned_staff_ids.length > 0) ||
    (Array.isArray(job.assigned_staff_names) &&
      job.assigned_staff_names.some((n) => String(n || "").trim()));
  if (!customerOk) return { ok: false, error: "Customer is required." };
  if (!projectOk) return { ok: false, error: "Project is required." };
  if (!titleOk) return { ok: false, error: "Job title or description is required." };
  if (!dateOk) return { ok: false, error: "Scheduled date must be YYYY-MM-DD." };
  if (!staffOk) return { ok: false, error: "At least one assigned staff member is required." };
  return { ok: true, error: "" };
}

export function matchStatusLabel(status) {
  const s = String(status || "");
  if (s === "Matched") return "Matched";
  if (s === "Possible match") return "Possible match";
  if (s === "New value") return "New value";
  return "Unresolved";
}

export function makeIdempotencyKey(recordingId) {
  const rand =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `njr-${String(recordingId || "x")}-${rand}`;
}

export function confidenceTone(score) {
  const n = Number(score);
  if (!(n >= 0)) return "unknown";
  if (n >= 0.8) return "high";
  if (n >= 0.5) return "medium";
  return "low";
}
