/**
 * FieldOS Phase 2 — proposed Apps Script gateway extensions.
 *
 * DO NOT copy blindly over production without review.
 * Production apps-script/ is untouched. Merge this file into the Apps Script
 * project and wire routeRequest() as described in README.md in this folder.
 *
 * New doPost actions (all require webhook_secret):
 *   - list_jobs_for_staff
 *   - get_job_detail
 *   - register_recording
 *
 * Reuses confirmed:
 *   - process_voice_dictation (existing Router.js)
 *   - JobSheetRepository / RecordingRepository / SyncRepository / DB / Config / Utils
 */

/**
 * Constant-time string compare for webhook secrets.
 */
function fieldosSecretsEqual_(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  const len = Math.max(left.length, right.length);
  let mismatch = left.length === right.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const c1 = i < left.length ? left.charCodeAt(i) : 0;
    const c2 = i < right.length ? right.charCodeAt(i) : 0;
    mismatch |= c1 ^ c2;
  }
  return mismatch === 0;
}

/**
 * Verify webhook_secret using constant-time compare.
 * Call from doPost instead of !== when merging.
 */
function fieldosVerifyWebhookSecret_(provided) {
  const expected = Config.getWebhookSecret();
  if (!provided || !fieldosSecretsEqual_(provided, expected)) {
    throw new Error("Unauthorized: Invalid or missing webhook_secret.");
  }
}

/**
 * Extend routeRequest switch — call after handling confirmed actions,
 * or merge these cases into Router.js routeRequest().
 *
 * @returns {object|null} result for Utils.createJsonResponse, or null if unsupported
 */
function fieldosRouteRequest(payload) {
  const action = payload.action;
  switch (action) {
    case "list_jobs_for_staff":
      return FieldOSGateway.listJobsForStaff(payload);
    case "get_job_detail":
      return FieldOSGateway.getJobDetail(payload);
    case "register_recording":
      return FieldOSGateway.registerRecording(payload);
    default:
      return null;
  }
}

/**
 * Enrich Utils.createJsonResponse with optional data object.
 * If merging into production, prefer adding data support to Utils once.
 */
function fieldosJsonResponse(status, action, message, recordId, data) {
  const response = {
    status: status,
    action: action,
    message: message,
    record_id: recordId || null,
    timestamp: new Date().toISOString()
  };
  if (data !== undefined) {
    response.data = data;
  }
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

const FieldOSGateway = {

  _col: function(payload, key, fallback) {
    const v = payload[key];
    return (v && String(v).trim()) || fallback;
  },

  _normalizeJob: function(job, cols) {
    const dateRaw = job[cols.date] || "";
    let jobDate = "";
    if (dateRaw) {
      if (Object.prototype.toString.call(dateRaw) === "[object Date]") {
        jobDate = Utilities.formatDate(dateRaw, Session.getScriptTimeZone(), "yyyy-MM-dd");
      } else {
        jobDate = String(dateRaw).slice(0, 10);
      }
    }
    return {
      job_sheet_id: String(job.job_sheet_id || ""),
      job_date: jobDate,
      project_name: String(job[cols.project] || ""),
      customer_name: String(job[cols.customer] || ""),
      processing_status: String(job.processing_status || ""),
      approval_status: String(job.approval_status || ""),
      processing_error: String(job.processing_error || ""),
      processing_started_at: job.processing_started_at || null,
      processing_completed_at: job.processing_completed_at || null,
      assigned_staff_id: String(job[cols.assignment] || "")
    };
  },

  _normalizeRecording: function(row) {
    return {
      recording_id: String(row.recording_id || ""),
      job_sheet_id: String(row.job_sheet_id || ""),
      recording_file_url: String(row.recording_file_url || ""),
      recording_drive_file_id: String(row.recording_drive_file_id || ""),
      recording_name: String(row.recording_name || ""),
      recording_order: Number(row.recording_order || 0),
      duration_seconds: Number(row.duration_seconds || 0),
      transcript: String(row.transcript || ""),
      status: String(row.status || ""),
      created_by: String(row.created_by || ""),
      created_at: row.created_at || null
    };
  },

  _assertAssigned: function(job, staffId, assignmentColumn) {
    if (!job) throw new Error("Job sheet not found.");
    if (String(job[assignmentColumn] || "") !== String(staffId)) {
      throw new Error("Forbidden: Job is not assigned to this staff member.");
    }
  },

  listJobsForStaff: function(payload) {
    const staffId = payload.staff_id;
    if (!staffId) throw new Error("Missing required attribute: staff_id.");

    const days = Math.min(Math.max(Number(payload.days || 7), 1), 90);
    const cols = {
      assignment: this._col(payload, "assignment_column", "assigned_staff_id"),
      date: this._col(payload, "date_column", "job_date"),
      project: this._col(payload, "project_column", "project_name"),
      customer: this._col(payload, "customer_column", "customer_name")
    };

    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - days);

    const all = JobSheetRepository.findAll() || [];
    const jobs = [];

    all.forEach(function(job) {
      if (String(job[cols.assignment] || "") !== String(staffId)) return;
      const raw = job[cols.date];
      if (!raw) return;
      let jobDate;
      if (Object.prototype.toString.call(raw) === "[object Date]") {
        jobDate = raw;
      } else {
        jobDate = new Date(String(raw).slice(0, 10) + "T00:00:00");
      }
      if (isNaN(jobDate.getTime()) || jobDate < since) return;
      jobs.push(FieldOSGateway._normalizeJob(job, cols));
    });

    jobs.sort(function(a, b) {
      return String(b.job_date).localeCompare(String(a.job_date));
    });

    return {
      action: "list_jobs_for_staff",
      message: "OK",
      job_sheet_id: null,
      data: { jobs: jobs, days: days }
    };
  },

  getJobDetail: function(payload) {
    const jobSheetId = payload.job_sheet_id;
    const staffId = payload.staff_id;
    if (!jobSheetId) throw new Error("Missing required attribute: job_sheet_id.");
    if (!staffId) throw new Error("Missing required attribute: staff_id.");

    const cols = {
      assignment: this._col(payload, "assignment_column", "assigned_staff_id"),
      date: this._col(payload, "date_column", "job_date"),
      project: this._col(payload, "project_column", "project_name"),
      customer: this._col(payload, "customer_column", "customer_name")
    };

    const job = JobSheetRepository.findById(jobSheetId);
    this._assertAssigned(job, staffId, cols.assignment);

    let recordings = [];
    try {
      recordings = RecordingRepository.find({ job_sheet_id: jobSheetId }) || [];
    } catch (err) {
      // RecordingRepository constructor bug in production export — fall back to DB
      recordings = DB.findWhere("tbl_recordings", { job_sheet_id: jobSheetId }) || [];
    }

    return {
      action: "get_job_detail",
      message: "OK",
      job_sheet_id: jobSheetId,
      data: {
        job: this._normalizeJob(job, cols),
        recordings: recordings.map(this._normalizeRecording)
      }
    };
  },

  registerRecording: function(payload) {
    const jobSheetId = payload.job_sheet_id;
    const staffId = payload.staff_id;
    if (!jobSheetId) throw new Error("Missing required attribute: job_sheet_id.");
    if (!staffId) throw new Error("Missing required attribute: staff_id.");
    if (!payload.recording_drive_file_id) throw new Error("Missing recording_drive_file_id.");
    if (!payload.recording_file_url) throw new Error("Missing recording_file_url.");

    const assignmentColumn = this._col(payload, "assignment_column", "assigned_staff_id");
    const job = JobSheetRepository.findById(jobSheetId);
    this._assertAssigned(job, staffId, assignmentColumn);

    let existing = [];
    try {
      existing = RecordingRepository.find({ job_sheet_id: jobSheetId }) || [];
    } catch (err) {
      existing = DB.findWhere("tbl_recordings", { job_sheet_id: jobSheetId }) || [];
    }
    const recordingOrder = existing.length + 1;
    const recordingId = payload.recording_id || ("REC-" + Utilities.getUuid().split("-")[0].toUpperCase());
    const recordingName = payload.recording_name || (jobSheetId + "-REC-" + recordingOrder + ".webm");

    const row = {
      recording_id: recordingId,
      job_sheet_id: jobSheetId,
      recording_file_url: String(payload.recording_file_url),
      recording_drive_file_id: String(payload.recording_drive_file_id),
      recording_name: recordingName,
      recording_order: recordingOrder,
      duration_seconds: Number(payload.duration_seconds || 0),
      transcript: "",
      status: "Saved",
      created_by: String(payload.created_by || ""),
      created_at: new Date()
    };

    // Prefer DB.insertRecord to avoid broken RecordingRepository constructor in export
    DB.insertRecord("tbl_recordings", row);

    SyncRepository.create({
      record_id: jobSheetId,
      target_system: "FieldOS_API",
      status: "Success",
      request_payload: JSON.stringify({
        action: "register_recording",
        job_sheet_id: jobSheetId,
        recording_drive_file_id: row.recording_drive_file_id,
        duration_seconds: row.duration_seconds
      }),
      response_payload: JSON.stringify({ recording_id: recordingId, recording_order: recordingOrder }),
      timestamp: new Date()
    });

    return {
      action: "register_recording",
      message: "Recording registered.",
      job_sheet_id: jobSheetId,
      data: {
        recording_id: recordingId,
        recording_file_url: row.recording_file_url,
        recording_drive_file_id: row.recording_drive_file_id,
        recording_order: recordingOrder,
        status: "Saved"
      }
    };
  }
};
