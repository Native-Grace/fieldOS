/**
 * NewJobFromRecording.gs
 * create_job_sheet_from_recording + list_job_create_masters.
 * Audio bytes never accepted — Drive file id + metadata only.
 */

var FIELDOS_CREATE_JOB_FROM_RECORDING_ALLOWLIST_ = {
  recording_id: true,
  idempotency_key: true,
  payload_hash: true,
  staff_id: true,
  actor_staff_id: true,
  actor_role: true,
  created_by: true,
  created_by_name: true,
  job_fields: true,
  reviewed_job: true,
  transcript: true,
  recording_drive_file_id: true,
  recording_file_url: true,
  recording_name: true,
  duration_seconds: true,
  mime_type: true,
  source: true,
  extraction_confidence: true,
  changed_fields: true,
  model: true,
  provider: true
};

var FIELDOS_CREATE_JOB_FORBIDDEN_KEYS_ = {
  webhook_secret: true,
  pdf_bytes: true,
  pdf_base64: true,
  content_base64: true,
  audio_bytes: true,
  audio_base64: true,
  file_bytes: true,
  token: true,
  api_key: true
};

function fieldosAssertManager_(body) {
  const role = (body && (body.actor_role || body.role)) || "staff";
  FieldOSGateway._assertManagerRole(role);
}

function fieldosNormalizeJobForApi_(job) {
  try {
    const cols = {
      assignment: PropertiesService.getScriptProperties().getProperty("JOB_ASSIGNMENT_COLUMN") || "staff_id",
      date: PropertiesService.getScriptProperties().getProperty("JOB_DATE_COLUMN") || "date",
      project: PropertiesService.getScriptProperties().getProperty("JOB_PROJECT_COLUMN") || "project_id"
    };
    const maps = typeof fieldosLoadDisplayMaps_ === "function" ? fieldosLoadDisplayMaps_() : null;
    return FieldOSGateway._normalizeJob(job, cols, maps);
  } catch (e) {
    return job || {};
  }
}

/**
 * @param {object} body
 * @returns {object}
 */
function fieldosPickCreateJobFromRecordingPayload_(body) {
  const src = body || {};
  const out = {};
  Object.keys(src).forEach(function (key) {
    if (FIELDOS_CREATE_JOB_FORBIDDEN_KEYS_[key]) {
      throw new Error("Forbidden field rejected: " + key);
    }
    if (FIELDOS_CREATE_JOB_FROM_RECORDING_ALLOWLIST_[key]) {
      out[key] = src[key];
    }
  });
  return out;
}

/**
 * @returns {{customers: object[], projects: object[], staff: object[]}}
 */
function fieldosListJobCreateMasters_(body) {
  fieldosAssertManager_(body);
  const customers = (typeof CustomerRepository !== "undefined" && CustomerRepository.findAll
    ? CustomerRepository.findAll()
    : []
  ).map(function (c) {
    return {
      customer_id: String(c.customer_id || ""),
      customer_name: String(c.customer_name || c.name || "")
    };
  });
  const projects = (typeof ProjectRepository !== "undefined" && ProjectRepository.findAll
    ? ProjectRepository.findAll()
    : []
  ).map(function (p) {
    return {
      project_id: String(p.project_id || ""),
      project_name: String(p.project_name || p.name || ""),
      customer_id: String(p.customer_id || "")
    };
  });
  const staff = (typeof StaffRepository !== "undefined" && StaffRepository.findAll
    ? StaffRepository.findAll()
    : []
  ).map(function (s) {
    return {
      staff_id: String(s.staff_id || ""),
      staff_name: String(s.staff_name || s.name || "")
    };
  });
  return { customers: customers, projects: projects, staff: staff };
}

/**
 * Create job sheet from manager-reviewed recording extraction.
 * @param {object} body
 * @returns {{job: object, link: object, idempotent: boolean, headers: string[]}}
 */
function fieldosCreateJobSheetFromRecording_(body) {
  fieldosAssertManager_(body);
  const safe = fieldosPickCreateJobFromRecordingPayload_(body);
  const idempotencyKey = String(safe.idempotency_key || "").trim();
  const payloadHash = String(safe.payload_hash || "").trim();
  const recordingId = String(safe.recording_id || "").trim();
  if (!idempotencyKey) throw new Error("Validation Error: idempotency_key is required.");
  if (!recordingId) throw new Error("Validation Error: recording_id is required.");
  if (!safe.job_fields || typeof safe.job_fields !== "object") {
    throw new Error("Validation Error: job_fields is required.");
  }

  const lockName = "CREATE_JOB_FROM_RECORDING_" + idempotencyKey;
  return Utils.withLock(lockName, 15000, function () {
    // Idempotency table (optional until migration).
    const existing = fieldosFindIdempotentCreateJob_(idempotencyKey);
    if (existing) {
      if (
        existing.payload_hash &&
        payloadHash &&
        String(existing.payload_hash) !== payloadHash
      ) {
        throw new Error("Conflict: idempotency key reused with a different reviewed payload.");
      }
      const job = JobSheetRepository.findById(existing.job_sheet_id);
      if (!job) {
        throw new Error("Conflict: idempotent job_sheet_id missing.");
      }
      return {
        job: fieldosNormalizeJobForApi_(job),
        link: existing.link || {
          job_sheet_id: existing.job_sheet_id,
          recording_id: recordingId
        },
        idempotent: true,
        headers: DB.getHeaders("tbl_job_sheets")
      };
    }

    const picked = fieldosPickWritableJobFields_(safe.job_fields);
    const writable = picked.writable || {};
    if (!writable.staff_id) {
      throw new Error("Validation Error: staff_id is required on job_fields.");
    }
    if (!writable.date) {
      throw new Error("Validation Error: date is required on job_fields.");
    }

    const created = JobSheetRepository.create(writable);
    const jobSheetId = String(created.job_sheet_id || "");
    if (!jobSheetId) throw new Error("Create Error: job_sheet_id missing after insert.");

    // Link recording into tbl_recordings when Drive metadata present (no audio bytes).
    let recordingRow = null;
    const driveId = String(safe.recording_drive_file_id || "").trim();
    if (driveId) {
      recordingRow = fieldosRegisterLinkedRecording_({
        job_sheet_id: jobSheetId,
        recording_id: recordingId,
        staff_id: String(safe.created_by || writable.staff_id || ""),
        recording_drive_file_id: driveId,
        recording_file_url: String(safe.recording_file_url || ""),
        recording_name: String(safe.recording_name || ""),
        duration_seconds: safe.duration_seconds || 0,
        transcript: String(safe.transcript || "")
      });
    }

    const link = fieldosInsertJobRecordingLink_({
      job_sheet_id: jobSheetId,
      recording_id: recordingId,
      transcript_id: "",
      created_by: String(safe.created_by || "")
    });

    fieldosStoreCreateJobIdempotency_({
      idempotency_key: idempotencyKey,
      payload_hash: payloadHash,
      job_sheet_id: jobSheetId,
      recording_id: recordingId,
      created_by: String(safe.created_by || ""),
      link: link
    });

    // Audit via sync log when available — no chain-of-thought.
    try {
      if (typeof SyncRepository !== "undefined" && SyncRepository.create) {
        SyncRepository.create({
          action: "create_job_sheet_from_recording",
          entity_type: "job_sheet",
          entity_id: jobSheetId,
          actor_staff_id: String(safe.created_by || ""),
          detail: JSON.stringify({
            recording_id: recordingId,
            model: String(safe.model || ""),
            provider: String(safe.provider || ""),
            changed_field_count: Array.isArray(safe.changed_fields)
              ? safe.changed_fields.length
              : 0
          })
        });
      }
    } catch (auditErr) {
      // Non-fatal.
    }

    return {
      job: fieldosNormalizeJobForApi_(created),
      link: link,
      recording: recordingRow,
      idempotent: false,
      headers: DB.getHeaders("tbl_job_sheets"),
      missing_job_fields: picked.missing || []
    };
  });
}

function fieldosFindIdempotentCreateJob_(key) {
  try {
    if (!DB.getHeaders("tbl_new_job_from_recording_keys")) return null;
  } catch (e) {
    return null;
  }
  const rows = DB.findWhere("tbl_new_job_from_recording_keys", { idempotency_key: key }) || [];
  return rows.length ? rows[0] : null;
}

function fieldosStoreCreateJobIdempotency_(row) {
  try {
    DB.getHeaders("tbl_new_job_from_recording_keys");
  } catch (e) {
    return;
  }
  const record = {
    idempotency_key: row.idempotency_key,
    payload_hash: row.payload_hash,
    job_sheet_id: row.job_sheet_id,
    recording_id: row.recording_id,
    created_by: row.created_by,
    created_at: new Date().toISOString()
  };
  const headers = DB.getHeaders("tbl_new_job_from_recording_keys");
  const writable = {};
  headers.forEach(function (h) {
    if (Object.prototype.hasOwnProperty.call(record, h)) writable[h] = record[h];
  });
  DB.insertRecord("tbl_new_job_from_recording_keys", writable);
}

function fieldosInsertJobRecordingLink_(fields) {
  try {
    DB.getHeaders("tbl_job_recording_links");
  } catch (e) {
    return {
      link_id: "",
      job_sheet_id: fields.job_sheet_id,
      recording_id: fields.recording_id,
      transcript_id: "",
      created_at: new Date().toISOString(),
      created_by: fields.created_by || ""
    };
  }
  const linkId = DB.generateId("JRL");
  const record = {
    link_id: linkId,
    job_sheet_id: fields.job_sheet_id,
    recording_id: fields.recording_id,
    transcript_id: fields.transcript_id || "",
    created_at: new Date().toISOString(),
    created_by: fields.created_by || ""
  };
  const headers = DB.getHeaders("tbl_job_recording_links");
  const writable = {};
  headers.forEach(function (h) {
    if (Object.prototype.hasOwnProperty.call(record, h)) writable[h] = record[h];
  });
  DB.insertRecord("tbl_job_recording_links", writable);
  return writable;
}

/**
 * Register recording against new job without audio bytes.
 */
function fieldosRegisterLinkedRecording_(fields) {
  const row = {
    recording_id: fields.recording_id || DB.generateId("REC"),
    job_sheet_id: fields.job_sheet_id,
    recording_file_url: fields.recording_file_url || "",
    recording_drive_file_id: fields.recording_drive_file_id || "",
    recording_name: fields.recording_name || "",
    recording_order: 1,
    duration_seconds: fields.duration_seconds || 0,
    transcript: fields.transcript || "",
    status: fields.transcript ? "Processed" : "Saved",
    created_by: fields.staff_id || "",
    created_at: new Date().toISOString()
  };
  const headers = DB.getHeaders("tbl_recordings");
  const writable = {};
  headers.forEach(function (h) {
    if (Object.prototype.hasOwnProperty.call(row, h)) writable[h] = row[h];
  });
  // Avoid duplicate recording_id
  const existing = DB.findById("tbl_recordings", "recording_id", writable.recording_id);
  if (existing) {
    DB.updateRecord("tbl_recordings", "recording_id", writable.recording_id, {
      job_sheet_id: fields.job_sheet_id,
      transcript: fields.transcript || existing.transcript || ""
    });
    return DB.findById("tbl_recordings", "recording_id", writable.recording_id);
  }
  DB.insertRecord("tbl_recordings", writable);
  return writable;
}
