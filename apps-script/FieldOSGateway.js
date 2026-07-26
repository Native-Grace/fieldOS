/**
 * FieldOS Phase 2 — Apps Script gateway extensions.
 *
 * Merged into repo apps-script/ source. Not deployed to Google until approved.
 * Wired from Router.js routeRequest() / doPost().
 *
 * New doPost actions (all require webhook_secret):
 *   - list_jobs_for_staff
 *   - get_job_detail
 *   - register_recording
 *
 * Reuses confirmed:
 *   - process_voice_dictation (existing Router.js)
 *   - JobSheetRepository / SyncRepository / DB / Config / Utils
 *   - DB.insertRecord for tbl_recordings (avoids broken RecordingRepository constructor)
 *   - FieldOSDisplayLookup.js for project/customer display names (batch maps; safe degrade)
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
    case "list_jobs_for_review":
      return FieldOSGateway.listJobsForReview(payload);
    case "get_job_detail":
      return FieldOSGateway.getJobDetail(payload);
    case "register_recording":
      return FieldOSGateway.registerRecording(payload);
    case "invalidate_recording":
      return FieldOSGateway.invalidateRecording(payload);
    case "delete_recording":
      return FieldOSGateway.deleteRecording(payload);
    case "update_job_review":
      return FieldOSGateway.updateJobReview(payload);
    case "approve_job_sheet":
      return FieldOSGateway.approveJobSheet(payload);
    case "return_job_sheet":
      return FieldOSGateway.returnJobSheet(payload);
    case "reopen_job_sheet":
      return FieldOSGateway.reopenJobSheet(payload);
    case "get_job_completion":
      return FieldOSJobCompletion.getJobCompletion(payload);
    case "create_job_completion_draft":
      return FieldOSJobCompletion.createJobCompletionDraft(payload);
    case "generate_job_completion_draft":
      return FieldOSJobCompletion.generateJobCompletionDraft(payload);
    case "update_job_completion":
      return FieldOSJobCompletion.updateJobCompletion(payload);
    case "finalise_job_completion":
      return FieldOSJobCompletion.finaliseJobCompletion(payload);
    case "reopen_job_completion":
      return FieldOSJobCompletion.reopenJobCompletion(payload);
    case "list_job_completions":
      return FieldOSJobCompletion.listJobCompletions(payload);
    case "list_completion_dashboard":
      return FieldOSCompletionExports.listCompletionDashboard(payload);
    case "get_completion_dashboard_summary":
      return FieldOSCompletionExports.getCompletionDashboardSummary(payload);
    case "get_completion_export_readiness":
      return FieldOSCompletionExports.getCompletionExportReadiness(payload);
    case "create_export_batch":
      return FieldOSCompletionExports.createExportBatch(payload);
    case "list_export_batches":
      return FieldOSCompletionExports.listExportBatches(payload);
    case "get_export_batch":
      return FieldOSCompletionExports.getExportBatch(payload);
    case "validate_export_batch":
      return FieldOSCompletionExports.validateExportBatch(payload);
    case "generate_export_batch":
      return FieldOSCompletionExports.generateExportBatch(payload);
    case "get_export_batch_csv":
      return FieldOSCompletionExports.getExportBatchCsv(payload);
    case "cancel_export_batch":
      return FieldOSCompletionExports.cancelExportBatch(payload);
    case "list_rate_cards":
      return FieldOSRatesFinancial.listRateCards(payload);
    case "create_rate_card":
      return FieldOSRatesFinancial.createRateCard(payload);
    case "update_rate_card":
      return FieldOSRatesFinancial.updateRateCard(payload);
    case "list_labour_rates":
      return FieldOSRatesFinancial.listLabourRates(payload);
    case "create_labour_rate":
      return FieldOSRatesFinancial.createLabourRate(payload);
    case "update_labour_rate":
      return FieldOSRatesFinancial.updateLabourRate(payload);
    case "list_machinery_rates":
      return FieldOSRatesFinancial.listMachineryRates(payload);
    case "create_machinery_rate":
      return FieldOSRatesFinancial.createMachineryRate(payload);
    case "update_machinery_rate":
      return FieldOSRatesFinancial.updateMachineryRate(payload);
    case "list_material_catalog":
      return FieldOSRatesFinancial.listMaterialCatalog(payload);
    case "create_material_catalog_item":
      return FieldOSRatesFinancial.createMaterialCatalogItem(payload);
    case "update_material_catalog_item":
      return FieldOSRatesFinancial.updateMaterialCatalogItem(payload);
    case "list_customer_pricing":
      return FieldOSRatesFinancial.listCustomerPricing(payload);
    case "create_customer_pricing":
      return FieldOSRatesFinancial.createCustomerPricing(payload);
    case "update_customer_pricing":
      return FieldOSRatesFinancial.updateCustomerPricing(payload);
    case "list_payroll_mappings":
      return FieldOSRatesFinancial.listPayrollMappings(payload);
    case "create_payroll_mapping":
      return FieldOSRatesFinancial.createPayrollMapping(payload);
    case "update_payroll_mapping":
      return FieldOSRatesFinancial.updatePayrollMapping(payload);
    case "list_xero_mappings":
      return FieldOSRatesFinancial.listXeroMappings(payload);
    case "create_xero_mapping":
      return FieldOSRatesFinancial.createXeroMapping(payload);
    case "update_xero_mapping":
      return FieldOSRatesFinancial.updateXeroMapping(payload);
    case "get_completion_pricing_readiness":
      return FieldOSRatesFinancial.getCompletionPricingReadiness(payload);
    case "create_financial_snapshot":
      return FieldOSRatesFinancial.createFinancialSnapshot(payload);
    case "list_financial_snapshots":
      return FieldOSRatesFinancial.listFinancialSnapshots(payload);
    case "get_financial_snapshot":
      return FieldOSRatesFinancial.getFinancialSnapshot(payload);
    case "validate_financial_snapshot":
      return FieldOSRatesFinancial.validateFinancialSnapshot(payload);
    case "approve_financial_snapshot":
      return FieldOSRatesFinancial.approveFinancialSnapshot(payload);
    case "supersede_financial_snapshot":
      return FieldOSRatesFinancial.supersedeFinancialSnapshot(payload);
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

/**
 * Next recording_order for a job: max numeric order among existing rows + 1.
 * Non-numeric / missing orders are ignored for the max (treated as absent).
 * Do NOT use existing.length + 1 — deletions create gaps and collide with max.
 *
 * @param {Array<object>} rows
 * @returns {number}
 */
function fieldosNextRecordingOrderFromRows_(rows) {
  let maxOrder = 0;
  const list = rows || [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i] && list[i].recording_order;
    if (raw == null || raw === "") continue;
    const n = Number(raw);
    if (!isFinite(n) || isNaN(n)) continue;
    const floored = Math.floor(n);
    if (floored > maxOrder) maxOrder = floored;
  }
  return maxOrder + 1;
}

/** Canonical FieldOS roles: staff | manager | admin */
function fieldosNormalizeRole_(role) {
  const r = String(role == null ? "" : role).trim().toLowerCase();
  if (!r) return "staff";
  if (r === "admin" || r === "administrator") return "admin";
  if (r === "manager" || r === "mgr") return "manager";
  if (r === "staff" || r === "field staff" || r === "field_staff" || r === "technician") {
    return "staff";
  }
  // Unknown labels default to staff (least privilege).
  return "staff";
}

function fieldosIsManagerOrAdmin_(role) {
  const n = fieldosNormalizeRole_(role);
  return n === "manager" || n === "admin";
}

var FIELDOS_REVIEW_EDITABLE_KEYS_ = [
  "ai_summary",
  "client_requests",
  "variations",
  "safety_issues",
  "manager_review_items",
  "weather",
  "travel_time",
  "manager_notes"
];

/**
 * Sanitised timing log for get_job_detail stages.
 * Logs stage durations, recording count, and role only.
 * NEVER logs transcript, notes, Drive IDs, customer text, or secrets.
 */
function fieldosLogJobDetailTiming_(jobSheetId, actorRole, timings, recordingCount) {
  try {
    const payload = {
      fieldos_timing: "get_job_detail",
      job_sheet_id: String(jobSheetId || ""),
      actor_role: fieldosNormalizeRole_(actorRole),
      recording_count: Number(recordingCount || 0),
      stages_ms: timings || {}
    };
    if (typeof console !== "undefined" && console.log) {
      console.log(JSON.stringify(payload));
    } else if (typeof Logger !== "undefined" && Logger.log) {
      Logger.log(JSON.stringify(payload));
    }
  } catch (err) {
    /* timing log must never break the request */
  }
}

/**
 * Pick only columns that exist on tbl_job_sheets (header-safe).
 * @param {object} patch
 * @returns {{writable: object, missing: string[]}}
 */
function fieldosPickWritableJobFields_(patch) {
  const headers = typeof DB !== "undefined" && DB.getHeaders
    ? DB.getHeaders("tbl_job_sheets")
    : Object.keys(patch || {});
  const headerSet = {};
  for (let i = 0; i < headers.length; i++) {
    headerSet[String(headers[i])] = true;
  }
  const writable = {};
  const missing = [];
  const src = patch || {};
  Object.keys(src).forEach(function (key) {
    if (headerSet[key]) writable[key] = src[key];
    else missing.push(key);
  });
  return { writable: writable, missing: missing };
}

/**
 * Compare expected concurrency tokens against the live job row.
 * @returns {string|null} error message or null if ok
 */
function fieldosCheckReviewConcurrency_(job, expected) {
  if (!expected) return null;
  if (
    expected.expected_approval_status != null &&
    String(expected.expected_approval_status) !== "" &&
    String(job.approval_status || "") !== String(expected.expected_approval_status)
  ) {
    return "Conflict: approval_status changed since you loaded this review.";
  }
  if (
    expected.expected_processing_completed_at != null &&
    String(expected.expected_processing_completed_at) !== ""
  ) {
    const live = job.processing_completed_at;
    let liveIso = "";
    if (live != null && live !== "") {
      if (Object.prototype.toString.call(live) === "[object Date]") {
        liveIso = live.toISOString();
      } else {
        liveIso = String(live);
      }
    }
    if (liveIso !== String(expected.expected_processing_completed_at)) {
      return "Conflict: processing_completed_at changed since you loaded this review.";
    }
  }
  return null;
}

/**
 * Sanitised audit payload for tbl_sync_logs (no transcript / secrets).
 */
function fieldosReviewAuditPayload_(meta) {
  return JSON.stringify({
    action: meta.action || "",
    job_sheet_id: meta.job_sheet_id || "",
    actor_staff_id: meta.actor_staff_id || "",
    actor_role: meta.actor_role || "",
    previous_approval_status: meta.previous_approval_status || "",
    new_approval_status: meta.new_approval_status || "",
    fields_changed: meta.fields_changed || [],
    return_reason_present: !!meta.return_reason_present,
    correlation_id: meta.correlation_id || "",
    missing_columns: meta.missing_columns || []
  });
}

var FieldOSGateway = {

  _col: function(payload, key, fallback) {
    const v = payload[key];
    return (v && String(v).trim()) || fallback;
  },

  _normalizeJob: function(job, cols, displayMaps) {
    const dateRaw = job[cols.date] || "";
    let jobDate = fieldosNormaliseCalendarDate_(dateRaw) || "";

    const projectKey = String(job[cols.project] || "").trim();
    // Dual-read: project_id PK → exact/normalised project_name → raw fallback.
    let projectName = "";
    let customerName = "";
    try {
      const maps = displayMaps || {
        projectById: {},
        customerById: {},
        projectByExactName: {},
        projectByNormName: {}
      };
      const resolved = fieldosResolveProjectCustomer_(projectKey, maps);
      projectName = resolved.project_name || "";
      customerName = resolved.customer_name || "";
      if (resolved.warning && typeof Logger !== "undefined" && Logger.log) {
        Logger.log(
          JSON.stringify({
            fieldos_display_warning: resolved.warning,
            job_sheet_id: String(job.job_sheet_id || ""),
            match: resolved.match || null
          })
        );
      }
    } catch (err) {
      projectName = projectKey;
      customerName = "";
    }
    // If sheet still has a customer column value and lookup returned empty, keep sheet value.
    if (!customerName && cols.customer) {
      customerName = String(job[cols.customer] || "").trim();
    }

    return {
      job_sheet_id: String(job.job_sheet_id || ""),
      job_date: jobDate,
      project_name: projectName,
      customer_name: customerName,
      processing_status: String(job.processing_status || ""),
      approval_status: String(job.approval_status || ""),
      processing_error: String(job.processing_error || ""),
      processing_started_at: job.processing_started_at || null,
      processing_completed_at: job.processing_completed_at || null,
      assigned_staff_id: String(job[cols.assignment] || ""),
      ai_summary: String(job.ai_summary == null ? "" : job.ai_summary),
      client_requests: String(job.client_requests == null ? "" : job.client_requests),
      variations: String(job.variations == null ? "" : job.variations),
      safety_issues: String(job.safety_issues == null ? "" : job.safety_issues),
      manager_review_items: String(
        job.manager_review_items == null ? "" : job.manager_review_items
      ),
      weather: String(job.weather == null ? "" : job.weather),
      travel_time: String(job.travel_time == null ? "" : job.travel_time),
      ai_confidence_score: job.ai_confidence_score == null || job.ai_confidence_score === ""
        ? null
        : Number(job.ai_confidence_score),
      manager_notes: String(job.manager_notes == null ? "" : job.manager_notes),
      approved_by: String(job.approved_by == null ? "" : job.approved_by),
      approved_at: job.approved_at || null,
      returned_by: String(job.returned_by == null ? "" : job.returned_by),
      returned_at: job.returned_at || null,
      return_reason: String(job.return_reason == null ? "" : job.return_reason),
      ai_transcript_character_count: String(
        job.ai_transcript == null ? "" : job.ai_transcript
      ).length
    };
  },

  /**
   * Staff: must be assigned. Manager/admin: any job.
   */
  _assertJobAccess: function(job, staffId, assignmentColumn, actorRole) {
    if (!job) throw new Error("Job sheet not found.");
    if (fieldosIsManagerOrAdmin_(actorRole)) return;
    if (String(job[assignmentColumn] || "") !== String(staffId)) {
      throw new Error("Forbidden: Job is not assigned to this staff member.");
    }
  },

  _assertManagerRole: function(actorRole) {
    if (!fieldosIsManagerOrAdmin_(actorRole)) {
      throw new Error("Forbidden: Manager or admin role required.");
    }
  },

  _extractReviewEdits: function(payload) {
    const edits = {};
    const changed = [];
    for (let i = 0; i < FIELDOS_REVIEW_EDITABLE_KEYS_.length; i++) {
      const key = FIELDOS_REVIEW_EDITABLE_KEYS_[i];
      if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
      edits[key] = String(payload[key] == null ? "" : payload[key]);
      changed.push(key);
    }
    return { edits: edits, fields_changed: changed };
  },

  _loadJobOrThrow: function(jobSheetId) {
    const job = JobSheetRepository.findById(jobSheetId);
    if (!job) throw new Error("Job sheet not found: " + jobSheetId);
    return job;
  },

  _headerSafeUpdateJobSheet: function(jobSheetId, patch) {
    const picked = fieldosPickWritableJobFields_(patch);
    if (!picked.writable || !Object.keys(picked.writable).length) {
      throw new Error("No writable job-sheet columns matched the update payload.");
    }
    if (
      Object.prototype.hasOwnProperty.call(patch, "approval_status") &&
      !Object.prototype.hasOwnProperty.call(picked.writable, "approval_status")
    ) {
      throw new Error("Schema Error: approval_status column missing on tbl_job_sheets.");
    }
    DB.updateRecord("tbl_job_sheets", "job_sheet_id", jobSheetId, picked.writable);
    return picked;
  },

  _writeReviewAudit: function(meta) {
    try {
      SyncRepository.create({
        record_id: meta.job_sheet_id || "REVIEW",
        target_system: "FieldOS_Review",
        status: "Success",
        request_payload: fieldosReviewAuditPayload_(meta),
        response_payload: JSON.stringify({
          approval_status: meta.new_approval_status || "",
          missing_columns: meta.missing_columns || []
        }),
        timestamp: new Date()
      });
    } catch (err) {
      // Audit failure must not roll back the sheet write.
      if (typeof Logger !== "undefined" && Logger.log) {
        Logger.log("FieldOS review audit write failed: " + String(err && err.message ? err.message : err));
      }
    }
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
      invalid_reason: String(row.invalid_reason || row.processing_error || ""),
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

  _assertJobNotProcessing: function(job) {
    const status = String(job && job.processing_status != null ? job.processing_status : "")
      .trim()
      .toLowerCase();
    if (status === "processing") {
      throw new Error("Cannot change recordings while the job is Processing.");
    }
  },

  _findRecordingForJob: function(jobSheetId, recordingId) {
    const rid = String(recordingId || "").trim();
    const jid = String(jobSheetId || "").trim();
    if (!rid || !jid) return null;
    let row = null;
    try {
      row = DB.findById("tbl_recordings", "recording_id", rid);
    } catch (err) {
      row = null;
    }
    if (!row) return null;
    if (String(row.job_sheet_id || "") !== jid) return null;
    return row;
  },

  _sanitizeReason: function(reason) {
    let text = String(reason == null ? "" : reason).replace(/\s+/g, " ").trim();
    if (!text) text = "Marked invalid by user.";
    if (text.length > 200) text = text.slice(0, 200).trim();
    return text || "Marked invalid by user.";
  },

  /**
   * Permanent delete first; trash fallback for permission / notFound edge cases.
   * Never logs Drive file IDs.
   * @returns {"deleted"|"trashed"}
   */
  _cleanupDriveRecordingFile: function(fileId) {
    const id = String(fileId || "").trim();
    if (!id) return "deleted";
    let permanentErr = null;
    try {
      if (typeof Drive !== "undefined" && Drive.Files && typeof Drive.Files.remove === "function") {
        Drive.Files.remove(id, { supportsAllDrives: true });
        return "deleted";
      }
    } catch (err) {
      permanentErr = err;
    }
    try {
      // DriveApp trash fallback (also used when Advanced Drive is unavailable).
      DriveApp.getFileById(id).setTrashed(true);
      return "trashed";
    } catch (trashErr) {
      const msg = permanentErr && permanentErr.message ? permanentErr.message : "";
      const tmsg = trashErr && trashErr.message ? trashErr.message : String(trashErr);
      throw new Error(
        "Drive cleanup failed. Recording row was not deleted. " +
          String(tmsg || msg || "unknown").slice(0, 120)
      );
    }
  },

  _headerSafeUpdateRecording: function(recordingId, patch) {
    // Prefer DB.updateRecord; skips missing columns via try/catch per-field if needed.
    try {
      DB.updateRecord("tbl_recordings", "recording_id", recordingId, patch);
      return;
    } catch (err) {
      // Retry without optional columns that may be absent on older sheets.
      const slim = {
        status: patch.status
      };
      if (patch.invalid_reason != null) slim.invalid_reason = patch.invalid_reason;
      try {
        DB.updateRecord("tbl_recordings", "recording_id", recordingId, slim);
      } catch (err2) {
        DB.updateRecord("tbl_recordings", "recording_id", recordingId, { status: patch.status });
      }
    }
  },

  listJobsForStaff: function(payload) {
    const staffId = payload.staff_id;
    if (!staffId) throw new Error("Missing required attribute: staff_id.");

    const days = Math.min(Math.max(Number(payload.days || 7), 1), 90);
    const cols = {
      assignment: this._col(payload, "assignment_column", "staff_id"),
      date: this._col(payload, "date_column", "date"),
      project: this._col(payload, "project_column", "project_id"),
      customer: this._col(payload, "customer_column", "customer_name")
    };

    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - days);

    const all = JobSheetRepository.findAll() || [];
    const jobs = [];
    // Load project/customer maps once (avoid N+1 findById per job).
    const displayMaps = fieldosLoadDisplayMaps_();

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
      jobs.push(FieldOSGateway._normalizeJob(job, cols, displayMaps));
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

  listJobsForReview: function(payload) {
    this._assertManagerRole(payload.actor_role || payload.role || "staff");

    const days = Math.min(Math.max(Number(payload.days || 7), 1), 90);
    const processingFilter = String(payload.processing_status || "").trim().toLowerCase();
    const approvalFilter = String(payload.approval_status || "").trim().toLowerCase();
    const search = String(payload.search || "").trim().toLowerCase().slice(0, 200);
    const cols = {
      assignment: this._col(payload, "assignment_column", "staff_id"),
      date: this._col(payload, "date_column", "date"),
      project: this._col(payload, "project_column", "project_id"),
      customer: this._col(payload, "customer_column", "customer_name")
    };

    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - days);

    const displayMaps = fieldosLoadDisplayMaps_();
    const jobs = (JobSheetRepository.findAll() || []).reduce(function (out, job) {
      const raw = job[cols.date];
      if (!raw) return out;
      const jobDate =
        Object.prototype.toString.call(raw) === "[object Date]"
          ? raw
          : new Date(String(raw).slice(0, 10) + "T00:00:00");
      if (isNaN(jobDate.getTime()) || jobDate < since) return out;

      const normalized = FieldOSGateway._normalizeJob(job, cols, displayMaps);
      if (
        processingFilter &&
        String(normalized.processing_status || "").trim().toLowerCase() !== processingFilter
      ) {
        return out;
      }
      if (
        approvalFilter &&
        String(normalized.approval_status || "").trim().toLowerCase() !== approvalFilter
      ) {
        return out;
      }
      if (search) {
        const haystack = [
          normalized.job_sheet_id,
          normalized.customer_name,
          normalized.project_name
        ]
          .join(" ")
          .toLowerCase();
        if (haystack.indexOf(search) === -1) return out;
      }

      // Explicit summary allowlist: never expose transcript, recordings, or Drive identifiers.
      out.push({
        job_sheet_id: normalized.job_sheet_id,
        job_date: normalized.job_date,
        project_name: normalized.project_name,
        customer_name: normalized.customer_name,
        processing_status: normalized.processing_status,
        approval_status: normalized.approval_status,
        processing_error: normalized.processing_error
      });
      return out;
    }, []);

    jobs.sort(function (a, b) {
      return (
        String(b.job_date).localeCompare(String(a.job_date)) ||
        String(a.job_sheet_id).localeCompare(String(b.job_sheet_id))
      );
    });

    return {
      action: "list_jobs_for_review",
      message: "OK",
      job_sheet_id: null,
      data: { jobs: jobs, days: days }
    };
  },

  /**
   * Lightweight per-job project/customer resolution.
   * Skips full tbl_projects / tbl_customers master scans when the job row already
   * carries a customer name. Otherwise performs targeted single-record lookups only.
   * Never touches completion tables, OpenAI, locks, or writes.
   */
  _buildJobDetailDisplayMaps_: function(job, cols) {
    const empty = {
      projectById: {},
      customerById: {},
      projectByExactName: {},
      projectByNormName: {}
    };
    if (!job) return empty;
    // Fast path: customer already resolvable on the row — _normalizeJob keeps it.
    if (String(job[cols.customer] || "").trim()) return empty;
    const projectKey = String(job[cols.project] || "").trim();
    if (!projectKey) return empty;
    try {
      let project = null;
      if (typeof ProjectRepository !== "undefined" && ProjectRepository.findById) {
        project = ProjectRepository.findById(projectKey);
        if (!project && ProjectRepository.findByField) {
          project = ProjectRepository.findByField("project_name", projectKey);
        }
      }
      if (!project) return empty;
      let customers = [];
      const customerId = String(project.customer_id || "").trim();
      if (customerId && typeof CustomerRepository !== "undefined" && CustomerRepository.findById) {
        const customer = CustomerRepository.findById(customerId);
        if (customer) customers = [customer];
      }
      return fieldosBuildDisplayMaps_([project], customers);
    } catch (err) {
      return empty;
    }
  },

  getJobDetail: function(payload) {
    const detailStart = Date.now();
    const timings = {};
    const jobSheetId = payload.job_sheet_id;
    const staffId = payload.staff_id;
    if (!jobSheetId) throw new Error("Missing required attribute: job_sheet_id.");
    if (!staffId) throw new Error("Missing required attribute: staff_id.");

    const actorRole = payload.actor_role || payload.role || "staff";
    const cols = {
      assignment: this._col(payload, "assignment_column", "staff_id"),
      date: this._col(payload, "date_column", "date"),
      project: this._col(payload, "project_column", "project_id"),
      customer: this._col(payload, "customer_column", "customer_name")
    };

    // Stage: job row lookup (single tbl_job_sheets read).
    let stageStart = Date.now();
    const job = JobSheetRepository.findById(jobSheetId);
    timings.job_lookup_ms = Date.now() - stageStart;
    this._assertJobAccess(job, staffId, cols.assignment, actorRole);

    // Stage: recordings lookup (single tbl_recordings read).
    stageStart = Date.now();
    let recordings = [];
    try {
      recordings = RecordingRepository.find({ job_sheet_id: jobSheetId }) || [];
    } catch (err) {
      // RecordingRepository constructor bug in production export — fall back to DB
      recordings = DB.findWhere("tbl_recordings", { job_sheet_id: jobSheetId }) || [];
    }
    timings.recordings_lookup_ms = Date.now() - stageStart;

    // Stage: customer/project resolution (targeted; skips master scans when possible).
    stageStart = Date.now();
    const displayMaps = this._buildJobDetailDisplayMaps_(job, cols);
    timings.customer_project_resolution_ms = Date.now() - stageStart;

    // Stage: review field mapping.
    stageStart = Date.now();
    const normalized = this._normalizeJob(job, cols, displayMaps);

    // Full transcript only for manager/admin when explicitly requested.
    const includeTranscript =
      payload.include_transcript === true || payload.include_transcript === "true";
    if (includeTranscript && fieldosIsManagerOrAdmin_(actorRole)) {
      normalized.ai_transcript = String(job.ai_transcript == null ? "" : job.ai_transcript);
    }
    timings.review_field_mapping_ms = Date.now() - stageStart;

    // Stage: response serialisation (recording summaries only — no completion data).
    stageStart = Date.now();
    const recordingsOut = recordings.map(function (row) {
      const rec = FieldOSGateway._normalizeRecording(row);
      if (!fieldosIsManagerOrAdmin_(actorRole)) {
        rec.recording_drive_file_id = "";
      }
      return rec;
    });
    const result = {
      action: "get_job_detail",
      message: "OK",
      job_sheet_id: jobSheetId,
      data: {
        job: normalized,
        recordings: recordingsOut
      }
    };
    timings.serialisation_ms = Date.now() - stageStart;
    timings.total_ms = Date.now() - detailStart;

    fieldosLogJobDetailTiming_(jobSheetId, actorRole, timings, recordingsOut.length);
    return result;
  },

  registerRecording: function(payload) {
    const jobSheetId = payload.job_sheet_id;
    const staffId = payload.staff_id;
    if (!jobSheetId) throw new Error("Missing required attribute: job_sheet_id.");
    if (!staffId) throw new Error("Missing required attribute: staff_id.");
    if (!payload.recording_drive_file_id) throw new Error("Missing recording_drive_file_id.");
    if (!payload.recording_file_url) throw new Error("Missing recording_file_url.");

    const assignmentColumn = this._col(payload, "assignment_column", "staff_id");
    const job = JobSheetRepository.findById(jobSheetId);
    this._assertAssigned(job, staffId, assignmentColumn);

    // Client-supplied recording_order is ignored — Apps Script is authority (max+1 under lock).
    const clientOrderIgnored =
      payload.recording_order != null && String(payload.recording_order).trim() !== "";

    const lockTimeoutMs = 30000;
    const registered = Utils.withLock(
      "REGISTER_RECORDING_" + String(jobSheetId),
      lockTimeoutMs,
      function () {
        let existing = [];
        try {
          existing = RecordingRepository.find({ job_sheet_id: jobSheetId }) || [];
        } catch (err) {
          existing = DB.findWhere("tbl_recordings", { job_sheet_id: jobSheetId }) || [];
        }
        // Re-read under lock so concurrent/stale clients cannot collide on length+1.
        const recordingOrder = fieldosNextRecordingOrderFromRows_(existing);
        const recordingId =
          payload.recording_id ||
          ("REC-" + Utilities.getUuid().split("-")[0].toUpperCase());
        const recordingName =
          payload.recording_name || jobSheetId + "-REC-" + recordingOrder + ".webm";

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

        // alreadyLocked: ScriptLock is not re-entrant; outer lock covers order+insert.
        DB.insertRecord("tbl_recordings", row, { alreadyLocked: true });
        return row;
      }
    );

    SyncRepository.create({
      record_id: jobSheetId,
      target_system: "FieldOS_API",
      status: "Success",
      request_payload: JSON.stringify({
        action: "register_recording",
        job_sheet_id: jobSheetId,
        recording_drive_file_id: registered.recording_drive_file_id,
        duration_seconds: registered.duration_seconds,
        client_recording_order_ignored: clientOrderIgnored
      }),
      response_payload: JSON.stringify({
        recording_id: registered.recording_id,
        recording_order: registered.recording_order
      }),
      timestamp: new Date()
    });

    return {
      action: "register_recording",
      message: "Recording registered.",
      job_sheet_id: jobSheetId,
      data: {
        recording_id: registered.recording_id,
        recording_file_url: registered.recording_file_url,
        recording_drive_file_id: registered.recording_drive_file_id,
        recording_order: registered.recording_order,
        status: "Saved"
      }
    };
  },

  invalidateRecording: function(payload) {
    const jobSheetId = String(payload.job_sheet_id || "").trim();
    const recordingId = String(payload.recording_id || "").trim();
    const staffId = String(payload.actor_staff_id || payload.staff_id || "").trim();
    if (!jobSheetId) throw new Error("Missing required attribute: job_sheet_id.");
    if (!recordingId) throw new Error("Missing required attribute: recording_id.");
    if (!staffId) throw new Error("Missing required attribute: staff_id.");

    const assignmentColumn = this._col(payload, "assignment_column", "staff_id");
    const job = JobSheetRepository.findById(jobSheetId);
    this._assertAssigned(job, staffId, assignmentColumn);
    this._assertJobNotProcessing(job);

    const row = this._findRecordingForJob(jobSheetId, recordingId);
    if (!row) throw new Error("Recording not found for this job.");

    const reason = this._sanitizeReason(payload.reason);
    const alreadyInvalid = String(row.status || "").trim() === "Invalid";
    if (!alreadyInvalid) {
      const patch = {
        status: "Invalid",
        invalid_reason: reason,
        updated_at: new Date()
      };
      this._headerSafeUpdateRecording(recordingId, patch);
    }

    SyncRepository.create({
      record_id: jobSheetId,
      target_system: "FieldOS_API",
      status: "Success",
      request_payload: JSON.stringify({
        action: "invalidate_recording",
        job_sheet_id: jobSheetId,
        recording_id: recordingId,
        actor_staff_id: staffId
      }),
      response_payload: JSON.stringify({
        recording_id: recordingId,
        recording_status: "Invalid",
        idempotent: alreadyInvalid
      }),
      timestamp: new Date()
    });

    return {
      action: "invalidate_recording",
      message: alreadyInvalid ? "Recording already Invalid." : "Recording marked Invalid.",
      job_sheet_id: jobSheetId,
      data: {
        recording_id: recordingId,
        recording_status: "Invalid",
        invalid_reason: alreadyInvalid
          ? String(row.invalid_reason || row.processing_error || reason)
          : reason,
        idempotent: alreadyInvalid
      }
    };
  },

  deleteRecording: function(payload) {
    const jobSheetId = String(payload.job_sheet_id || "").trim();
    const recordingId = String(payload.recording_id || "").trim();
    const staffId = String(payload.actor_staff_id || payload.staff_id || "").trim();
    if (!jobSheetId) throw new Error("Missing required attribute: job_sheet_id.");
    if (!recordingId) throw new Error("Missing required attribute: recording_id.");
    if (!staffId) throw new Error("Missing required attribute: staff_id.");

    const assignmentColumn = this._col(payload, "assignment_column", "staff_id");
    const job = JobSheetRepository.findById(jobSheetId);
    this._assertAssigned(job, staffId, assignmentColumn);
    this._assertJobNotProcessing(job);

    const row = this._findRecordingForJob(jobSheetId, recordingId);
    if (!row) throw new Error("Recording not found for this job.");

    const driveId = String(row.recording_drive_file_id || "").trim();
    const driveOutcome = this._cleanupDriveRecordingFile(driveId);

    const deleted = DB.deleteWhere("tbl_recordings", {
      recording_id: recordingId,
      job_sheet_id: jobSheetId
    });
    if (!deleted) {
      throw new Error("Recording not found for this job.");
    }

    SyncRepository.create({
      record_id: jobSheetId,
      target_system: "FieldOS_API",
      status: "Success",
      request_payload: JSON.stringify({
        action: "delete_recording",
        job_sheet_id: jobSheetId,
        recording_id: recordingId,
        actor_staff_id: staffId
      }),
      response_payload: JSON.stringify({
        recording_id: recordingId,
        recording_status: "Deleted",
        drive_outcome: driveOutcome
      }),
      timestamp: new Date()
    });

    return {
      action: "delete_recording",
      message: "Recording deleted.",
      job_sheet_id: jobSheetId,
      data: {
        recording_id: recordingId,
        recording_status: "Deleted",
        drive_outcome: driveOutcome
      }
    };
  },

  updateJobReview: function(payload) {
    const jobSheetId = String(payload.job_sheet_id || "").trim();
    const staffId = String(payload.actor_staff_id || payload.staff_id || "").trim();
    const actorRole = payload.actor_role || payload.role || "staff";
    if (!jobSheetId) throw new Error("Missing required attribute: job_sheet_id.");
    if (!staffId) throw new Error("Missing required attribute: staff_id.");
    this._assertManagerRole(actorRole);

    const lockTimeoutMs = 30000;
    const self = this;
    return Utils.withLock("JOB_REVIEW_" + jobSheetId, lockTimeoutMs, function () {
      const job = self._loadJobOrThrow(jobSheetId);
      const conflict = fieldosCheckReviewConcurrency_(job, payload);
      if (conflict) throw new Error(conflict);

      const extracted = self._extractReviewEdits(payload);
      if (!extracted.fields_changed.length) {
        throw new Error("No review fields provided to update.");
      }

      const previous = String(job.approval_status || "");
      // Save-draft must not silently downgrade Approved.
      if (previous === "Approved") {
        throw new Error(
          "Approved jobs cannot be edited without an explicit reopen action."
        );
      }

      const picked = self._headerSafeUpdateJobSheet(jobSheetId, extracted.edits);
      const updated = self._loadJobOrThrow(jobSheetId);
      const cols = {
        assignment: self._col(payload, "assignment_column", "staff_id"),
        date: self._col(payload, "date_column", "date"),
        project: self._col(payload, "project_column", "project_id"),
        customer: self._col(payload, "customer_column", "customer_name")
      };
      self._writeReviewAudit({
        action: "update_job_review",
        job_sheet_id: jobSheetId,
        actor_staff_id: staffId,
        actor_role: fieldosNormalizeRole_(actorRole),
        previous_approval_status: previous,
        new_approval_status: String(updated.approval_status || previous),
        fields_changed: extracted.fields_changed,
        return_reason_present: false,
        correlation_id: String(payload.correlation_id || ""),
        missing_columns: picked.missing
      });

      return {
        action: "update_job_review",
        message: "Review draft saved.",
        job_sheet_id: jobSheetId,
        data: {
          job: self._normalizeJob(updated, cols, fieldosLoadDisplayMaps_()),
          warnings: picked.missing.length
            ? ["Missing sheet columns skipped: " + picked.missing.join(", ")]
            : []
        }
      };
    });
  },

  approveJobSheet: function(payload) {
    const jobSheetId = String(payload.job_sheet_id || "").trim();
    const staffId = String(payload.actor_staff_id || payload.staff_id || "").trim();
    const actorRole = payload.actor_role || payload.role || "staff";
    const actorIdentity = String(
      payload.actor_identity || payload.created_by || staffId
    ).trim();
    if (!jobSheetId) throw new Error("Missing required attribute: job_sheet_id.");
    if (!staffId) throw new Error("Missing required attribute: staff_id.");
    this._assertManagerRole(actorRole);

    const lockTimeoutMs = 30000;
    const self = this;
    return Utils.withLock("JOB_REVIEW_" + jobSheetId, lockTimeoutMs, function () {
      const job = self._loadJobOrThrow(jobSheetId);
      const conflict = fieldosCheckReviewConcurrency_(job, payload);
      if (conflict) throw new Error(conflict);

      const processing = String(job.processing_status || "").trim();
      if (processing !== "Completed") {
        throw new Error("Approve requires processing_status=Completed.");
      }

      const previous = String(job.approval_status || "");
      const extracted = self._extractReviewEdits(payload);
      const nowIso = new Date().toISOString();
      const patch = Object.assign({}, extracted.edits, {
        approval_status: "Approved",
        approved_by: actorIdentity,
        approved_at: nowIso,
        returned_by: "",
        returned_at: "",
        return_reason: ""
      });

      const picked = self._headerSafeUpdateJobSheet(jobSheetId, patch);
      const updated = self._loadJobOrThrow(jobSheetId);
      const cols = {
        assignment: self._col(payload, "assignment_column", "staff_id"),
        date: self._col(payload, "date_column", "date"),
        project: self._col(payload, "project_column", "project_id"),
        customer: self._col(payload, "customer_column", "customer_name")
      };
      self._writeReviewAudit({
        action: "approve_job_sheet",
        job_sheet_id: jobSheetId,
        actor_staff_id: staffId,
        actor_role: fieldosNormalizeRole_(actorRole),
        previous_approval_status: previous,
        new_approval_status: "Approved",
        fields_changed: extracted.fields_changed.concat([
          "approval_status",
          "approved_by",
          "approved_at"
        ]),
        return_reason_present: false,
        correlation_id: String(payload.correlation_id || ""),
        missing_columns: picked.missing
      });

      return {
        action: "approve_job_sheet",
        message: "Job sheet approved.",
        job_sheet_id: jobSheetId,
        data: {
          job: self._normalizeJob(updated, cols, fieldosLoadDisplayMaps_()),
          warnings: picked.missing.length
            ? ["Missing sheet columns skipped: " + picked.missing.join(", ")]
            : []
        }
      };
    });
  },

  returnJobSheet: function(payload) {
    const jobSheetId = String(payload.job_sheet_id || "").trim();
    const staffId = String(payload.actor_staff_id || payload.staff_id || "").trim();
    const actorRole = payload.actor_role || payload.role || "staff";
    const actorIdentity = String(
      payload.actor_identity || payload.created_by || staffId
    ).trim();
    const returnReason = String(payload.return_reason == null ? "" : payload.return_reason)
      .replace(/\s+/g, " ")
      .trim();
    if (!jobSheetId) throw new Error("Missing required attribute: job_sheet_id.");
    if (!staffId) throw new Error("Missing required attribute: staff_id.");
    this._assertManagerRole(actorRole);
    if (!returnReason) throw new Error("return_reason is required.");

    const lockTimeoutMs = 30000;
    const self = this;
    return Utils.withLock("JOB_REVIEW_" + jobSheetId, lockTimeoutMs, function () {
      const job = self._loadJobOrThrow(jobSheetId);
      const conflict = fieldosCheckReviewConcurrency_(job, payload);
      if (conflict) throw new Error(conflict);

      const previous = String(job.approval_status || "");
      const extracted = self._extractReviewEdits(payload);
      const nowIso = new Date().toISOString();
      const patch = Object.assign({}, extracted.edits, {
        approval_status: "Returned for Correction",
        returned_by: actorIdentity,
        returned_at: nowIso,
        return_reason: returnReason.slice(0, 500),
        approved_by: "",
        approved_at: ""
      });

      const picked = self._headerSafeUpdateJobSheet(jobSheetId, patch);
      const updated = self._loadJobOrThrow(jobSheetId);
      const cols = {
        assignment: self._col(payload, "assignment_column", "staff_id"),
        date: self._col(payload, "date_column", "date"),
        project: self._col(payload, "project_column", "project_id"),
        customer: self._col(payload, "customer_column", "customer_name")
      };
      self._writeReviewAudit({
        action: "return_job_sheet",
        job_sheet_id: jobSheetId,
        actor_staff_id: staffId,
        actor_role: fieldosNormalizeRole_(actorRole),
        previous_approval_status: previous,
        new_approval_status: "Returned for Correction",
        fields_changed: extracted.fields_changed.concat([
          "approval_status",
          "returned_by",
          "returned_at",
          "return_reason"
        ]),
        return_reason_present: true,
        correlation_id: String(payload.correlation_id || ""),
        missing_columns: picked.missing
      });

      return {
        action: "return_job_sheet",
        message: "Job sheet returned for correction.",
        job_sheet_id: jobSheetId,
        data: {
          job: self._normalizeJob(updated, cols, fieldosLoadDisplayMaps_()),
          warnings: picked.missing.length
            ? ["Missing sheet columns skipped: " + picked.missing.join(", ")]
            : []
        }
      };
    });
  },

  reopenJobSheet: function(payload) {
    const jobSheetId = String(payload.job_sheet_id || "").trim();
    const staffId = String(payload.actor_staff_id || payload.staff_id || "").trim();
    const actorRole = payload.actor_role || payload.role || "staff";
    if (!jobSheetId) throw new Error("Missing required attribute: job_sheet_id.");
    if (!staffId) throw new Error("Missing required attribute: staff_id.");
    this._assertManagerRole(actorRole);

    const lockTimeoutMs = 30000;
    const self = this;
    return Utils.withLock("JOB_REVIEW_" + jobSheetId, lockTimeoutMs, function () {
      const job = self._loadJobOrThrow(jobSheetId);
      const conflict = fieldosCheckReviewConcurrency_(job, payload);
      if (conflict) throw new Error(conflict);

      const previous = String(job.approval_status || "");
      if (previous !== "Approved") {
        throw new Error("Reopen requires approval_status=Approved.");
      }

      const patch = {
        approval_status: "Pending Review",
        approved_by: "",
        approved_at: ""
      };
      const picked = self._headerSafeUpdateJobSheet(jobSheetId, patch);
      const updated = self._loadJobOrThrow(jobSheetId);
      const cols = {
        assignment: self._col(payload, "assignment_column", "staff_id"),
        date: self._col(payload, "date_column", "date"),
        project: self._col(payload, "project_column", "project_id"),
        customer: self._col(payload, "customer_column", "customer_name")
      };
      self._writeReviewAudit({
        action: "reopen_job_sheet",
        job_sheet_id: jobSheetId,
        actor_staff_id: staffId,
        actor_role: fieldosNormalizeRole_(actorRole),
        previous_approval_status: previous,
        new_approval_status: "Pending Review",
        fields_changed: ["approval_status", "approved_by", "approved_at"],
        return_reason_present: false,
        correlation_id: String(payload.correlation_id || ""),
        missing_columns: picked.missing
      });

      return {
        action: "reopen_job_sheet",
        message: "Job sheet reopened for review.",
        job_sheet_id: jobSheetId,
        data: {
          job: self._normalizeJob(updated, cols, fieldosLoadDisplayMaps_()),
          warnings: picked.missing.length
            ? ["Missing sheet columns skipped: " + picked.missing.join(", ")]
            : []
        }
      };
    });
  }
};

/**
 * MANUAL TEST: list_jobs_for_staff via fieldosRouteRequest (no HTTP / no doPost).
 *
 * WARNING: Do not run fieldosRouteRequest from the Apps Script editor Run menu —
 * it requires a payload argument. Run testFieldOSListJobs() instead.
 *
 * Replace staff_id (and column names if your sheet headers differ) before running.
 */
function testFieldOSListJobs() {
  // CRITICAL: Replace with a real staff_id value from tbl_job_sheets.staff_id.
  const payload = {
    action: "list_jobs_for_staff",
    staff_id: "REPLACE_WITH_REAL_STAFF_ID",
    days: 7,
    assignment_column: "staff_id",
    date_column: "date",
    project_column: "project_id",
    customer_column: "customer_name"
  };

  const result = fieldosRouteRequest(payload);
  Logger.log(JSON.stringify(result, null, 2));
}

/**
 * READ-ONLY DIAGNOSTIC: measure get_job_detail stage durations for one job.
 * Logs stage timings only — no transcript, notes, Drive IDs, or sensitive text.
 * Performs no writes, no locks, no completion access, no OpenAI, no migrations.
 *
 * Usage in the Apps Script editor: testFieldOSGetJobDetailTiming('21759f5d')
 */
function testFieldOSGetJobDetailTiming(jobSheetId, actorRole) {
  const id = String(jobSheetId || "").trim();
  if (!id) {
    Logger.log("testFieldOSGetJobDetailTiming: pass a job_sheet_id, e.g. '21759f5d'.");
    return;
  }
  const job = JobSheetRepository.findById(id);
  if (!job) {
    Logger.log("testFieldOSGetJobDetailTiming: job not found: " + id);
    return;
  }
  const role = actorRole || "manager";
  const staffId = String(job.staff_id || "DIAGNOSTIC");
  const start = Date.now();
  const result = FieldOSGateway.getJobDetail({
    action: "get_job_detail",
    job_sheet_id: id,
    staff_id: staffId,
    actor_role: role,
    include_transcript: false
  });
  // getJobDetail already emits sanitised stage timings via fieldosLogJobDetailTiming_.
  Logger.log(
    JSON.stringify({
      diagnostic: "get_job_detail_timing",
      job_sheet_id: id,
      actor_role: fieldosNormalizeRole_(role),
      total_ms: Date.now() - start,
      recording_count: (result && result.data && result.data.recordings)
        ? result.data.recordings.length
        : 0
    })
  );
}
