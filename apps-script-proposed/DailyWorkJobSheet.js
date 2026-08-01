/**
 * DailyWorkJobSheet.gs
 * create_completed_job_sheet_from_recordings — completed daily work (multi-recording).
 * Separate from create_job_sheet_from_recording (future/scheduled work).
 * Audio bytes never accepted — Drive file ids + metadata only.
 *
 * Success contract (Router → fieldosJsonResponse):
 * {
 *   action, message, job_sheet_id,
 *   data: { job_sheet_id, record_id, work_session_id, idempotent, link_count }
 * }
 * Never return transcripts, reviewed_job_sheet, full job rows, or link arrays.
 */

var FIELDOS_CREATE_COMPLETED_JOB_ALLOWLIST_ = {
  work_session_id: true,
  idempotency_key: true,
  payload_hash: true,
  staff_id: true,
  actor_staff_id: true,
  actor_role: true,
  created_by: true,
  created_by_name: true,
  job_fields: true,
  reviewed_job_sheet: true,
  recordings: true,
  aggregated_transcript: true,
  processing_type: true
};

var FIELDOS_CREATE_COMPLETED_JOB_FORBIDDEN_KEYS_ = {
  webhook_secret: true,
  pdf_bytes: true,
  pdf_base64: true,
  content_base64: true,
  audio_bytes: true,
  audio_base64: true,
  file_bytes: true,
  token: true,
  api_key: true,
  customer_name: true
};

function fieldosAssertStaffOrManager_(body) {
  const role = String((body && (body.actor_role || body.role)) || "staff")
    .trim()
    .toLowerCase();
  if (role === "admin" || role === "manager" || role === "staff" || role === "field staff") {
    return;
  }
  // Unknown → treat as staff (least privilege path still allowed for own create).
}

function fieldosPickCreateCompletedJobPayload_(body) {
  const src = body || {};
  const out = {};
  Object.keys(src).forEach(function (key) {
    if (FIELDOS_CREATE_COMPLETED_JOB_FORBIDDEN_KEYS_[key]) {
      throw new Error("Forbidden field rejected: " + key);
    }
    if (FIELDOS_CREATE_COMPLETED_JOB_ALLOWLIST_[key]) {
      out[key] = src[key];
    }
  });
  return out;
}

function fieldosFlushSheetsSafe_() {
  try {
    if (typeof SpreadsheetApp !== "undefined" && SpreadsheetApp.flush) {
      SpreadsheetApp.flush();
    }
  } catch (e) {
    // Non-fatal — best-effort persistence before ContentService return.
  }
}

function fieldosLogCreateCompletedResponse_(meta) {
  try {
    const payload = {
      action: "create_completed_job_sheet_from_recordings",
      work_session_id: String((meta && meta.work_session_id) || ""),
      job_sheet_id: String((meta && meta.job_sheet_id) || ""),
      idempotent: !!(meta && meta.idempotent),
      response_bytes: Number((meta && meta.response_bytes) || 0),
      elapsed_ms: Number((meta && meta.elapsed_ms) || 0),
      link_count: Number((meta && meta.link_count) || 0)
    };
    if (typeof Logger !== "undefined" && Logger.log) {
      Logger.log(JSON.stringify(payload));
    } else if (typeof console !== "undefined" && console.log) {
      console.log(JSON.stringify(payload));
    }
  } catch (e) {
    // Never fail create on logging.
  }
}

/**
 * Minimal Router-compatible success payload.
 * Must include job_sheet_id + data so doPost uses fieldosJsonResponse.
 * Do NOT attach job / links / transcripts / headers.
 */
function fieldosCompletedJobCreateRouterResult_(opts) {
  const jobSheetId = String((opts && opts.job_sheet_id) || "").trim();
  if (!jobSheetId) {
    throw new Error("Create Error: job_sheet_id missing from completed-job result.");
  }
  const workSessionId = String((opts && opts.work_session_id) || "").trim();
  const idempotent = !!(opts && opts.idempotent);
  const linkCount = Number((opts && opts.link_count) || 0);
  const message =
    (opts && opts.message) ||
    (idempotent
      ? "Existing completed job sheet returned"
      : "Completed job sheet created");
  return {
    action: "create_completed_job_sheet_from_recordings",
    message: message,
    job_sheet_id: jobSheetId,
    data: {
      job_sheet_id: jobSheetId,
      record_id: jobSheetId,
      work_session_id: workSessionId,
      idempotent: idempotent,
      link_count: linkCount
    }
  };
}

/**
 * Create one completed job sheet from a reviewed daily-work session.
 * @param {object} body
 * @returns {object} Minimal Router-compatible result
 */
function fieldosCreateCompletedJobSheetFromRecordings_(body) {
  const startedMs = Date.now();
  fieldosAssertStaffOrManager_(body);
  const safe = fieldosPickCreateCompletedJobPayload_(body);
  const idempotencyKey = String(safe.idempotency_key || "").trim();
  const payloadHash = String(safe.payload_hash || "").trim();
  const workSessionId = String(safe.work_session_id || "").trim();
  if (!idempotencyKey) throw new Error("Validation Error: idempotency_key is required.");
  if (!workSessionId) throw new Error("Validation Error: work_session_id is required.");
  if (!safe.job_fields || typeof safe.job_fields !== "object") {
    throw new Error("Validation Error: job_fields is required.");
  }
  const recordings = Array.isArray(safe.recordings) ? safe.recordings : [];
  if (!recordings.length) {
    throw new Error("Validation Error: at least one recording is required.");
  }

  const lockName = "CREATE_COMPLETED_JOB_" + idempotencyKey;
  return Utils.withLock(lockName, 20000, function () {
    const existing = fieldosFindIdempotentCompletedJob_(idempotencyKey);
    if (existing) {
      if (
        existing.payload_hash &&
        payloadHash &&
        String(existing.payload_hash) !== payloadHash
      ) {
        throw new Error("Conflict: idempotency key reused with a different reviewed payload.");
      }
      const existingId = String(existing.job_sheet_id || "").trim();
      if (!existingId) {
        throw new Error("Conflict: idempotent create-key row missing job_sheet_id.");
      }
      let linkCount = Number(existing.link_count || 0);
      if (!linkCount && typeof existing.links_json === "string" && existing.links_json) {
        try {
          const parsed = JSON.parse(existing.links_json) || [];
          linkCount = Array.isArray(parsed) ? parsed.length : 0;
        } catch (e) {
          linkCount = 0;
        }
      }
      const result = fieldosCompletedJobCreateRouterResult_({
        job_sheet_id: existingId,
        work_session_id: String(existing.work_session_id || workSessionId),
        idempotent: true,
        link_count: linkCount,
        message: "Existing completed job sheet returned"
      });
      fieldosLogCreateCompletedResponse_({
        work_session_id: workSessionId,
        job_sheet_id: existingId,
        idempotent: true,
        link_count: linkCount,
        response_bytes: JSON.stringify(result).length,
        elapsed_ms: Date.now() - startedMs
      });
      return result;
    }

    // One active job per work session (when session metadata table exists).
    const priorSession = fieldosFindDailyWorkSessionMeta_(workSessionId);
    if (priorSession && priorSession.created_job_sheet_id) {
      throw new Error("Conflict: this work session already created a job sheet.");
    }

    const picked = fieldosPickWritableJobFields_(safe.job_fields);
    const writable = picked.writable || {};
    // Never write customer_name even if somehow present.
    delete writable.customer_name;
    if (!writable.staff_id) {
      throw new Error("Validation Error: staff_id is required on job_fields.");
    }
    if (!writable.date) {
      throw new Error("Validation Error: date is required on job_fields.");
    }
    if (!writable.processing_status) {
      writable.processing_status = "Completed";
    }
    if (writable.processing_error == null) {
      writable.processing_error = "";
    }
    if (!writable.approval_status) {
      writable.approval_status = "Pending Review";
    }

    // Capture ID before insert so create-key + response never rely on undefined post-insert.
    const jobSheetId = DB.generateId("JS");
    if (!jobSheetId) throw new Error("Create Error: failed to generate job_sheet_id.");
    writable.job_sheet_id = jobSheetId;

    const created = JobSheetRepository.create(writable);
    const createdId = String((created && created.job_sheet_id) || jobSheetId || "").trim();
    if (!createdId || createdId !== jobSheetId) {
      throw new Error("Create Error: job_sheet_id mismatch after insert.");
    }

    const linkSummaries = [];
    const createdBy = String(safe.created_by || writable.staff_id || "");
    recordings.forEach(function (rec, idx) {
      const recordingId = String((rec && rec.recording_id) || "").trim();
      if (!recordingId) return;
      const driveId = String((rec && rec.recording_drive_file_id) || "").trim();
      if (driveId && typeof fieldosRegisterLinkedRecording_ === "function") {
        fieldosRegisterLinkedRecording_({
          job_sheet_id: jobSheetId,
          recording_id: recordingId,
          staff_id: createdBy,
          recording_drive_file_id: driveId,
          recording_file_url: String((rec && rec.recording_file_url) || ""),
          recording_name: String((rec && rec.recording_name) || ""),
          duration_seconds: (rec && rec.duration_seconds) || 0,
          transcript: String((rec && rec.transcript) || "")
        });
      }
      const link = fieldosInsertDailyWorkRecordingLink_({
        job_sheet_id: jobSheetId,
        recording_id: recordingId,
        work_session_id: workSessionId,
        sequence: (rec && rec.sequence) || idx + 1,
        created_by: createdBy
      });
      // Persist only compact link refs — never transcripts in create-key JSON.
      linkSummaries.push({
        link_id: String((link && link.link_id) || ""),
        recording_id: recordingId,
        sequence: Number((link && link.sequence) || idx + 1)
      });
    });

    // Persist create-result row before building/returning the HTTP response.
    fieldosStoreCompletedJobIdempotency_({
      idempotency_key: idempotencyKey,
      payload_hash: payloadHash,
      job_sheet_id: jobSheetId,
      work_session_id: workSessionId,
      created_by: createdBy,
      link_count: linkSummaries.length,
      links: linkSummaries
    });

    fieldosUpsertDailyWorkSessionMeta_({
      work_session_id: workSessionId,
      work_date: String(writable.date || ""),
      project_id: String(writable.project_id || ""),
      staff_ids: String(writable.staff_id || ""),
      status: "JobCreated",
      created_job_sheet_id: jobSheetId,
      created_by: createdBy,
      updated_at: new Date().toISOString(),
      version: 1
    });

    try {
      if (typeof SyncRepository !== "undefined" && SyncRepository.create) {
        SyncRepository.create({
          action: "create_completed_job_sheet_from_recordings",
          entity_type: "job_sheet",
          entity_id: jobSheetId,
          actor_staff_id: createdBy,
          detail: JSON.stringify({
            work_session_id: workSessionId,
            recording_count: linkSummaries.length,
            processing_type: String(safe.processing_type || "daily_work_dictation")
          })
        });
      }
    } catch (auditErr) {
      // Non-fatal.
    }

    fieldosFlushSheetsSafe_();

    const result = fieldosCompletedJobCreateRouterResult_({
      job_sheet_id: jobSheetId,
      work_session_id: workSessionId,
      idempotent: false,
      link_count: linkSummaries.length,
      message: "Completed job sheet created"
    });
    fieldosLogCreateCompletedResponse_({
      work_session_id: workSessionId,
      job_sheet_id: jobSheetId,
      idempotent: false,
      link_count: linkSummaries.length,
      response_bytes: JSON.stringify(result).length,
      elapsed_ms: Date.now() - startedMs
    });
    return result;
  });
}

/**
 * Look up a prior completed-job create by work_session_id and/or idempotency_key.
 * Used by FastAPI reconciliation when create response lacked job_sheet_id.
 * Response stays small — IDs + hash only (no full job / transcripts).
 */
function fieldosGetCompletedJobSheetCreateResult_(body) {
  fieldosAssertStaffOrManager_(body);
  const workSessionId = String((body && body.work_session_id) || "").trim();
  const idempotencyKey = String((body && body.idempotency_key) || "").trim();
  if (!workSessionId && !idempotencyKey) {
    throw new Error("Validation Error: work_session_id or idempotency_key is required.");
  }

  let row = null;
  if (idempotencyKey) {
    row = fieldosFindIdempotentCompletedJob_(idempotencyKey);
  }
  if (!row && workSessionId) {
    row = fieldosFindIdempotentCompletedJobBySession_(workSessionId);
  }

  if (!row || !String(row.job_sheet_id || "").trim()) {
    return {
      action: "get_completed_job_sheet_create_result",
      message: "No completed job create result found",
      job_sheet_id: null,
      data: {
        found: false,
        job_sheet_id: "",
        payload_hash: "",
        work_session_id: workSessionId,
        idempotency_key: idempotencyKey,
        link_count: 0
      }
    };
  }

  const jobSheetId = String(row.job_sheet_id || "").trim();
  let linkCount = Number(row.link_count || 0);
  if (!linkCount && typeof row.links_json === "string" && row.links_json) {
    try {
      const parsed = JSON.parse(row.links_json) || [];
      linkCount = Array.isArray(parsed) ? parsed.length : 0;
    } catch (e) {
      linkCount = 0;
    }
  }
  return {
    action: "get_completed_job_sheet_create_result",
    message: "Completed job create result found",
    job_sheet_id: jobSheetId,
    data: {
      found: true,
      job_sheet_id: jobSheetId,
      payload_hash: String(row.payload_hash || ""),
      work_session_id: String(row.work_session_id || workSessionId || ""),
      idempotency_key: String(row.idempotency_key || idempotencyKey || ""),
      link_count: linkCount,
      job: { job_sheet_id: jobSheetId }
    }
  };
}

function fieldosInsertDailyWorkRecordingLink_(fields) {
  try {
    DB.getHeaders("tbl_job_recording_links");
  } catch (e) {
    return {
      link_id: "",
      job_sheet_id: fields.job_sheet_id,
      recording_id: fields.recording_id,
      work_session_id: fields.work_session_id || "",
      sequence: fields.sequence || 0,
      created_at: new Date().toISOString(),
      created_by: fields.created_by || ""
    };
  }
  const linkId = DB.generateId("JRL");
  const record = {
    link_id: linkId,
    job_sheet_id: fields.job_sheet_id,
    recording_id: fields.recording_id,
    transcript_id: "",
    work_session_id: fields.work_session_id || "",
    sequence: fields.sequence || 0,
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

function fieldosFindIdempotentCompletedJob_(key) {
  try {
    if (!DB.getHeaders("tbl_daily_work_create_keys")) return null;
  } catch (e) {
    return null;
  }
  const rows = DB.findWhere("tbl_daily_work_create_keys", { idempotency_key: key }) || [];
  return rows.length ? rows[0] : null;
}

function fieldosFindIdempotentCompletedJobBySession_(workSessionId) {
  try {
    if (!DB.getHeaders("tbl_daily_work_create_keys")) return null;
  } catch (e) {
    return null;
  }
  const rows =
    DB.findWhere("tbl_daily_work_create_keys", { work_session_id: workSessionId }) || [];
  if (!rows.length) return null;
  // Prefer the newest row when multiple exist.
  return rows[rows.length - 1];
}

function fieldosStoreCompletedJobIdempotency_(row) {
  try {
    DB.getHeaders("tbl_daily_work_create_keys");
  } catch (e) {
    return;
  }
  const record = {
    idempotency_key: row.idempotency_key,
    payload_hash: row.payload_hash,
    job_sheet_id: row.job_sheet_id,
    work_session_id: row.work_session_id,
    created_by: row.created_by,
    created_at: new Date().toISOString(),
    link_count: Number(row.link_count || (row.links && row.links.length) || 0),
    // Compact link refs only — never transcripts / reviewed content.
    links_json: JSON.stringify(row.links || [])
  };
  const headers = DB.getHeaders("tbl_daily_work_create_keys");
  const writable = {};
  headers.forEach(function (h) {
    if (Object.prototype.hasOwnProperty.call(record, h)) writable[h] = record[h];
  });
  DB.insertRecord("tbl_daily_work_create_keys", writable);
}

function fieldosFindDailyWorkSessionMeta_(workSessionId) {
  try {
    if (!DB.getHeaders("tbl_daily_work_sessions")) return null;
  } catch (e) {
    return null;
  }
  const rows =
    DB.findWhere("tbl_daily_work_sessions", { work_session_id: workSessionId }) || [];
  return rows.length ? rows[0] : null;
}

function fieldosUpsertDailyWorkSessionMeta_(fields) {
  try {
    DB.getHeaders("tbl_daily_work_sessions");
  } catch (e) {
    return;
  }
  const existing = fieldosFindDailyWorkSessionMeta_(fields.work_session_id);
  const headers = DB.getHeaders("tbl_daily_work_sessions");
  const writable = {};
  headers.forEach(function (h) {
    if (Object.prototype.hasOwnProperty.call(fields, h)) writable[h] = fields[h];
  });
  if (existing) {
    DB.updateRecord("tbl_daily_work_sessions", "work_session_id", fields.work_session_id, writable);
  } else {
    if (!writable.created_at) writable.created_at = new Date().toISOString();
    DB.insertRecord("tbl_daily_work_sessions", writable);
  }
}
