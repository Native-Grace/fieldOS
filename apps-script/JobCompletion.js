/**
 * Phase 3C — Job completion gateway (timesheets / labour / machinery / materials).
 * Depends on: JobCompletionHelpers.js, Database.js, Repositories.js, Utilities.js,
 * FieldOSGateway role helpers (fieldosNormalizeRole_, fieldosIsManagerOrAdmin_).
 */

var FIELDOS_COMPLETION_HEADERS_ = [
  "completion_id",
  "job_sheet_id",
  "completion_status",
  "work_summary",
  "invoice_description",
  "internal_notes",
  "total_labour_hours",
  "total_travel_hours",
  "total_machinery_hours",
  "billable_labour_hours",
  "non_billable_labour_hours",
  "variations",
  "warnings",
  "warning_resolutions",
  "created_by",
  "created_at",
  "updated_by",
  "updated_at",
  "finalised_by",
  "finalised_at",
  "reopened_by",
  "reopened_at",
  "reopen_reason",
  "version"
];

var FIELDOS_LABOUR_HEADERS_ = [
  "labour_id",
  "completion_id",
  "job_sheet_id",
  "staff_id",
  "staff_name",
  "work_date",
  "start_time",
  "finish_time",
  "break_minutes",
  "labour_hours",
  "travel_minutes",
  "travel_hours",
  "role_or_activity",
  "billable",
  "confirmation_status",
  "notes",
  "source",
  "created_at",
  "updated_at"
];

var FIELDOS_MACHINERY_HEADERS_ = [
  "machinery_entry_id",
  "completion_id",
  "job_sheet_id",
  "equipment_name",
  "operator_staff_id",
  "start_time",
  "finish_time",
  "duration_hours",
  "billable",
  "confirmation_status",
  "charge_code",
  "notes",
  "source",
  "created_at",
  "updated_at"
];

var FIELDOS_MATERIAL_HEADERS_ = [
  "material_entry_id",
  "completion_id",
  "job_sheet_id",
  "item_name",
  "quantity",
  "unit",
  "billable",
  "confirmation_status",
  "notes",
  "source",
  "created_at",
  "updated_at"
];

var FieldOSJobCompletion = {
  _nowIso: function () {
    return new Date().toISOString();
  },

  _assertManager: function (actorRole) {
    if (!fieldosIsManagerOrAdmin_(actorRole)) {
      throw new Error("Forbidden: manager or admin role required.");
    }
  },

  _getJob: function (jobSheetId) {
    const job = JobSheetRepository.findById(jobSheetId);
    if (!job) throw new Error("Job sheet not found: " + jobSheetId);
    return job;
  },

  _assertJobAccess: function (job, staffId, actorRole) {
    if (fieldosIsManagerOrAdmin_(actorRole)) return;
    const assigned = String(job.staff_id || "");
    if (assigned !== String(staffId || "")) {
      throw new Error("Forbidden: job is not assigned to this staff member.");
    }
  },

  _jobEligibleForCompletion: function (job) {
    return (
      String(job.processing_status || "").trim() === "Completed" &&
      String(job.approval_status || "").trim() === "Approved"
    );
  },

  _completionBlocked: function (job, completion) {
    const status = String((completion && completion.completion_status) || "");
    if (status === FIELDOS_COMPLETION_STATUSES_.FINALISED) return false;
    return !this._jobEligibleForCompletion(job);
  },

  _completionTablesExist: function () {
    try {
      DB.getSheet("tbl_job_completions");
      return true;
    } catch (err) {
      return false;
    }
  },

  _findActiveCompletionRow: function (jobSheetId) {
    // Missing completion tables (pre-migration) → treat as "no completion" (fast, no throw).
    if (!this._completionTablesExist()) return null;
    const rows = DB.findWhere("tbl_job_completions", { job_sheet_id: jobSheetId }) || [];
    if (!rows.length) return null;
    // Prefer non-finalised; else latest by version.
    rows.sort(function (a, b) {
      return Number(b.version || 0) - Number(a.version || 0);
    });
    return rows[0];
  },

  _loadChildren: function (completionId) {
    return {
      labour_entries: DB.findWhere("tbl_job_labour", { completion_id: completionId }) || [],
      machinery_entries: DB.findWhere("tbl_job_machinery", { completion_id: completionId }) || [],
      material_entries: DB.findWhere("tbl_job_materials", { completion_id: completionId }) || []
    };
  },

  _boolSheet: function (value) {
    if (value === true || value === "TRUE" || value === "true") return "TRUE";
    return "FALSE";
  },

  _boolApi: function (value) {
    return value === true || value === "TRUE" || value === "true";
  },

  _serializeList: function (arr) {
    if (!arr || !arr.length) return "";
    return JSON.stringify(arr);
  },

  _parseList: function (raw) {
    if (raw == null || raw === "") return [];
    if (Array.isArray(raw)) return raw.map(String);
    try {
      const parsed = JSON.parse(String(raw));
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch (e) {
      /* fall through */
    }
    return String(raw)
      .split(/\n+/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  },

  /** Parse JSON arrays of objects (warning_resolutions). */
  _parseObjectList: function (raw) {
    if (raw == null || raw === "") return [];
    if (Array.isArray(raw)) return raw;
    try {
      const parsed = JSON.parse(String(raw));
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  },

  _normaliseLabourRow: function (row, completionId, jobSheetId, now) {
    const startCanonical = fieldosClockTimePresent_(row.start_time)
      ? fieldosNormaliseClockTime_(row.start_time)
      : "";
    const finishCanonical = fieldosClockTimePresent_(row.finish_time)
      ? fieldosNormaliseClockTime_(row.finish_time)
      : "";
    // Validate using canonical HH:MM when available; otherwise pass through raw
    // non-blank values so format errors still surface (never String(Date)).
    const calc = fieldosComputeLabourEntry_({
      start_time: startCanonical
        ? startCanonical
        : fieldosClockTimePresent_(row.start_time)
          ? "invalid"
          : "",
      finish_time: finishCanonical
        ? finishCanonical
        : fieldosClockTimePresent_(row.finish_time)
          ? "invalid"
          : "",
      break_minutes: row.break_minutes,
      travel_minutes: row.travel_minutes
    });
    // Drafts may keep blank start/finish. Only block malformed/arithmetic errors here.
    const blocking = (calc.errors || []).filter(function (e) {
      return !/Start time is required\.|Finish time is required\./.test(String(e));
    });
    if (blocking.length) {
      throw new Error("Validation Error: " + blocking.join(" "));
    }
    return {
      labour_id: String(row.labour_id || DB.generateId("LAB")),
      completion_id: completionId,
      job_sheet_id: jobSheetId,
      staff_id: String(row.staff_id || ""),
      staff_name: String(row.staff_name || ""),
      work_date: String(row.work_date || "").slice(0, 10),
      start_time: startCanonical || "",
      finish_time: finishCanonical || "",
      break_minutes: Number(row.break_minutes) || 0,
      labour_hours: calc.labour_hours == null ? "" : calc.labour_hours,
      travel_minutes: Number(row.travel_minutes) || 0,
      travel_hours: calc.travel_hours,
      role_or_activity: String(row.role_or_activity || ""),
      billable: this._boolSheet(row.billable),
      confirmation_status: String(row.confirmation_status || FIELDOS_ROW_CONFIRMATION_.SUGGESTED),
      notes: String(row.notes || ""),
      source: String(row.source || "manual"),
      created_at: String(row.created_at || now),
      updated_at: now
    };
  },

  _normaliseMachineryRow: function (row, completionId, jobSheetId, now) {
    const startCanonical = fieldosClockTimePresent_(row.start_time)
      ? fieldosNormaliseClockTime_(row.start_time) || ""
      : "";
    const finishCanonical = fieldosClockTimePresent_(row.finish_time)
      ? fieldosNormaliseClockTime_(row.finish_time) || ""
      : "";
    const calc = fieldosComputeMachineryDurationHours_({
      duration_hours: row.duration_hours,
      start_time: startCanonical,
      finish_time: finishCanonical
    });
    if (!calc.ok) {
      throw new Error("Validation Error: " + calc.errors.join(" "));
    }
    return {
      machinery_entry_id: String(row.machinery_entry_id || DB.generateId("MCH")),
      completion_id: completionId,
      job_sheet_id: jobSheetId,
      equipment_name: String(row.equipment_name || ""),
      operator_staff_id: String(row.operator_staff_id || ""),
      start_time: startCanonical,
      finish_time: finishCanonical,
      duration_hours: calc.duration_hours == null ? "" : calc.duration_hours,
      billable: this._boolSheet(row.billable),
      confirmation_status: String(row.confirmation_status || FIELDOS_ROW_CONFIRMATION_.SUGGESTED),
      charge_code: String(row.charge_code || ""),
      notes: String(row.notes || ""),
      source: String(row.source || "manual"),
      created_at: String(row.created_at || now),
      updated_at: now
    };
  },

  _normaliseMaterialRow: function (row, completionId, jobSheetId, now) {
    let qty = row.quantity;
    if (qty === "" || qty == null) qty = "";
    else {
      qty = Number(qty);
      if (!Number.isFinite(qty)) {
        throw new Error("Validation Error: material quantity must be numeric.");
      }
    }
    return {
      material_entry_id: String(row.material_entry_id || DB.generateId("JMT")),
      completion_id: completionId,
      job_sheet_id: jobSheetId,
      item_name: String(row.item_name || ""),
      quantity: qty,
      unit: String(row.unit || ""),
      billable: this._boolSheet(row.billable),
      confirmation_status: String(row.confirmation_status || FIELDOS_ROW_CONFIRMATION_.SUGGESTED),
      notes: String(row.notes || ""),
      source: String(row.source || "manual"),
      created_at: String(row.created_at || now),
      updated_at: now
    };
  },

  _toApiLabour: function (row) {
    const start = fieldosNormaliseClockTime_(row.start_time) || "";
    const finish = fieldosNormaliseClockTime_(row.finish_time) || "";
    return {
      labour_id: String(row.labour_id || ""),
      completion_id: String(row.completion_id || ""),
      job_sheet_id: String(row.job_sheet_id || ""),
      staff_id: String(row.staff_id || ""),
      staff_name: String(row.staff_name || ""),
      work_date: String(row.work_date || ""),
      start_time: start,
      finish_time: finish,
      break_minutes: Number(row.break_minutes) || 0,
      labour_hours:
        row.labour_hours === "" || row.labour_hours == null ? null : Number(row.labour_hours),
      travel_minutes: Number(row.travel_minutes) || 0,
      travel_hours:
        row.travel_hours === "" || row.travel_hours == null ? 0 : Number(row.travel_hours),
      role_or_activity: String(row.role_or_activity || ""),
      billable: this._boolApi(row.billable),
      confirmation_status: String(row.confirmation_status || FIELDOS_ROW_CONFIRMATION_.SUGGESTED),
      notes: String(row.notes || ""),
      source: String(row.source || ""),
      created_at: row.created_at || null,
      updated_at: row.updated_at || null
    };
  },

  _toApiMachinery: function (row) {
    return {
      machinery_entry_id: String(row.machinery_entry_id || ""),
      completion_id: String(row.completion_id || ""),
      job_sheet_id: String(row.job_sheet_id || ""),
      equipment_name: String(row.equipment_name || ""),
      operator_staff_id: String(row.operator_staff_id || ""),
      start_time: fieldosNormaliseClockTime_(row.start_time) || "",
      finish_time: fieldosNormaliseClockTime_(row.finish_time) || "",
      duration_hours:
        row.duration_hours === "" || row.duration_hours == null
          ? null
          : Number(row.duration_hours),
      billable: this._boolApi(row.billable),
      confirmation_status: String(row.confirmation_status || FIELDOS_ROW_CONFIRMATION_.SUGGESTED),
      charge_code: String(row.charge_code || ""),
      notes: String(row.notes || ""),
      source: String(row.source || ""),
      created_at: row.created_at || null,
      updated_at: row.updated_at || null
    };
  },

  _toApiMaterial: function (row) {
    return {
      material_entry_id: String(row.material_entry_id || ""),
      completion_id: String(row.completion_id || ""),
      job_sheet_id: String(row.job_sheet_id || ""),
      item_name: String(row.item_name || ""),
      quantity:
        row.quantity === "" || row.quantity == null ? null : Number(row.quantity),
      unit: String(row.unit || ""),
      billable: this._boolApi(row.billable),
      confirmation_status: String(row.confirmation_status || FIELDOS_ROW_CONFIRMATION_.SUGGESTED),
      notes: String(row.notes || ""),
      source: String(row.source || ""),
      created_at: row.created_at || null,
      updated_at: row.updated_at || null
    };
  },

  _assemble: function (header, children, job, actorRole, staffId) {
    const labour = (children.labour_entries || []).map(this._toApiLabour.bind(this));
    const machinery = (children.machinery_entries || []).map(this._toApiMachinery.bind(this));
    const materials = (children.material_entries || []).map(this._toApiMaterial.bind(this));
    const manager = fieldosIsManagerOrAdmin_(actorRole);
    let labourOut = labour;
    let machineryOut = machinery;
    let materialsOut = materials;
    let internalNotes = String(header.internal_notes || "");
    if (!manager) {
      labourOut = labour.filter(function (r) {
        return String(r.staff_id || "") === String(staffId || "");
      });
      machineryOut = [];
      materialsOut = [];
      internalNotes = "";
    }
    const blocked = this._completionBlocked(job, header);
    const status = String(header.completion_status || "");
    const canEdit =
      manager &&
      !blocked &&
      status !== FIELDOS_COMPLETION_STATUSES_.FINALISED;
    const canFinalise =
      manager &&
      !blocked &&
      (status === FIELDOS_COMPLETION_STATUSES_.DRAFT ||
        status === FIELDOS_COMPLETION_STATUSES_.READY ||
        status === FIELDOS_COMPLETION_STATUSES_.REOPENED);
    const canReopen = manager && status === FIELDOS_COMPLETION_STATUSES_.FINALISED;

    return {
      completion: {
        completion_id: String(header.completion_id || ""),
        job_sheet_id: String(header.job_sheet_id || ""),
        completion_status: status,
        work_summary: String(header.work_summary || ""),
        invoice_description: String(header.invoice_description || ""),
        internal_notes: internalNotes,
        total_labour_hours: Number(header.total_labour_hours) || 0,
        total_travel_hours: Number(header.total_travel_hours) || 0,
        total_machinery_hours: Number(header.total_machinery_hours) || 0,
        billable_labour_hours: Number(header.billable_labour_hours) || 0,
        non_billable_labour_hours: Number(header.non_billable_labour_hours) || 0,
        variations: this._parseList(header.variations),
        warnings: this._parseList(header.warnings),
        warning_resolutions: this._parseObjectList(header.warning_resolutions),
        created_by: String(header.created_by || ""),
        created_at: header.created_at || null,
        updated_by: String(header.updated_by || ""),
        updated_at: header.updated_at || null,
        finalised_by: String(header.finalised_by || ""),
        finalised_at: header.finalised_at || null,
        reopened_by: String(header.reopened_by || ""),
        reopened_at: header.reopened_at || null,
        reopen_reason: String(header.reopen_reason || ""),
        version: Number(header.version) || 1,
        blocked: blocked,
        job_approval_status: String(job.approval_status || ""),
        job_processing_status: String(job.processing_status || "")
      },
      labour_entries: labourOut,
      machinery_entries: machineryOut,
      material_entries: materialsOut,
      can_edit: canEdit,
      can_finalise: canFinalise,
      can_reopen: canReopen,
      can_generate: manager && this._jobEligibleForCompletion(job)
    };
  },

  _writeAudit: function (meta) {
    try {
      SyncRepository.create({
        record_id: meta.completion_id || meta.job_sheet_id || "COMPLETION",
        target_system: "FieldOS_Completion",
        status: "Success",
        request_payload: JSON.stringify(fieldosCompletionAuditPayload_(meta)),
        response_payload: meta.new_completion_status || "",
        timestamp: new Date()
      });
    } catch (err) {
      Logger.log("Completion audit write failed: " + err);
    }
  },

  _checkVersion: function (header, expectedVersion) {
    if (expectedVersion == null || expectedVersion === "") return;
    if (Number(header.version || 0) !== Number(expectedVersion)) {
      throw new Error("Conflict: completion version changed since you loaded this record.");
    }
  },

  _replaceChildren: function (completionId, jobSheetId, labour, machinery, materials, now) {
    DB.deleteWhere("tbl_job_labour", { completion_id: completionId });
    DB.deleteWhere("tbl_job_machinery", { completion_id: completionId });
    DB.deleteWhere("tbl_job_materials", { completion_id: completionId });
    const labourRows = [];
    const machineryRows = [];
    const materialRows = [];
    (labour || []).forEach(
      function (row) {
        const normalised = this._normaliseLabourRow(row, completionId, jobSheetId, now);
        DB.insertRecord("tbl_job_labour", normalised, { alreadyLocked: true });
        labourRows.push(normalised);
      }.bind(this)
    );
    (machinery || []).forEach(
      function (row) {
        const normalised = this._normaliseMachineryRow(row, completionId, jobSheetId, now);
        DB.insertRecord("tbl_job_machinery", normalised, { alreadyLocked: true });
        machineryRows.push(normalised);
      }.bind(this)
    );
    (materials || []).forEach(
      function (row) {
        const normalised = this._normaliseMaterialRow(row, completionId, jobSheetId, now);
        DB.insertRecord("tbl_job_materials", normalised, { alreadyLocked: true });
        materialRows.push(normalised);
      }.bind(this)
    );
    return {
      labour_entries: labourRows,
      machinery_entries: machineryRows,
      material_entries: materialRows
    };
  },

  _applyTotals: function (patch, labour, machinery) {
    const totals = fieldosComputeCompletionTotals_(labour, machinery);
    // Blank start/finish are allowed on drafts; finalise validates required times.
    const blocking = (totals.errors || []).filter(function (e) {
      return !/Start time is required\.|Finish time is required\./.test(String(e));
    });
    if (blocking.length) {
      throw new Error("Validation Error: " + blocking.join(" "));
    }
    patch.total_labour_hours = totals.total_labour_hours;
    patch.total_travel_hours = totals.total_travel_hours;
    patch.total_machinery_hours = totals.total_machinery_hours;
    patch.billable_labour_hours = totals.billable_labour_hours;
    patch.non_billable_labour_hours = totals.non_billable_labour_hours;
    return totals;
  },

  getJobCompletion: function (payload) {
    const jobSheetId = String(payload.job_sheet_id || "");
    const staffId = String(payload.staff_id || payload.actor_staff_id || "");
    const actorRole = payload.actor_role || "staff";
    if (!jobSheetId) throw new Error("Missing required attribute: job_sheet_id.");
    const job = this._getJob(jobSheetId);
    this._assertJobAccess(job, staffId, actorRole);
    const header = this._findActiveCompletionRow(jobSheetId);
    if (!header) {
      return {
        action: "get_job_completion",
        message: "No completion record.",
        job_sheet_id: jobSheetId,
        data: {
          completion: null,
          labour_entries: [],
          machinery_entries: [],
          material_entries: [],
          can_edit: false,
          can_finalise: false,
          can_reopen: false,
          can_generate: fieldosIsManagerOrAdmin_(actorRole) && this._jobEligibleForCompletion(job)
        }
      };
    }
    const children = this._loadChildren(header.completion_id);
    return {
      action: "get_job_completion",
      message: "Completion loaded.",
      job_sheet_id: jobSheetId,
      data: this._assemble(header, children, job, actorRole, staffId)
    };
  },

  listJobCompletions: function (payload) {
    this._assertManager(payload.actor_role || "staff");
    const rows = DB.findAll("tbl_job_completions") || [];
    const items = rows.map(function (row) {
      return {
        completion_id: String(row.completion_id || ""),
        job_sheet_id: String(row.job_sheet_id || ""),
        completion_status: String(row.completion_status || ""),
        updated_at: row.updated_at || null,
        finalised_at: row.finalised_at || null,
        version: Number(row.version) || 1
      };
    });
    return {
      action: "list_job_completions",
      message: "Listed completions.",
      job_sheet_id: null,
      data: { items: items }
    };
  },

  createJobCompletionDraft: function (payload) {
    const jobSheetId = String(payload.job_sheet_id || "");
    const staffId = String(payload.staff_id || payload.actor_staff_id || "");
    const actorRole = payload.actor_role || "staff";
    const actor = String(payload.actor_identity || staffId);
    this._assertManager(actorRole);
    if (!jobSheetId) throw new Error("Missing required attribute: job_sheet_id.");
    const self = this;
    return Utils.withLock("JOB_COMPLETION_" + jobSheetId, 30000, function () {
      const job = self._getJob(jobSheetId);
      if (!self._jobEligibleForCompletion(job)) {
        throw new Error(
          "Validation Error: completion requires processing_status=Completed and approval_status=Approved."
        );
      }
      const existing = self._findActiveCompletionRow(jobSheetId);
      if (existing) {
        throw new Error("Validation Error: an active completion already exists for this job.");
      }
      const now = self._nowIso();
      const completionId = DB.generateId("CMP");
      const header = {
        completion_id: completionId,
        job_sheet_id: jobSheetId,
        completion_status: FIELDOS_COMPLETION_STATUSES_.DRAFT,
        work_summary: "",
        invoice_description: "",
        internal_notes: "",
        total_labour_hours: 0,
        total_travel_hours: 0,
        total_machinery_hours: 0,
        billable_labour_hours: 0,
        non_billable_labour_hours: 0,
        variations: "",
        warnings: "",
        warning_resolutions: "",
        created_by: actor,
        created_at: now,
        updated_by: actor,
        updated_at: now,
        finalised_by: "",
        finalised_at: "",
        reopened_by: "",
        reopened_at: "",
        reopen_reason: "",
        version: 1
      };
      DB.insertRecord("tbl_job_completions", header, { alreadyLocked: true });
      self._writeAudit({
        action: "create_job_completion_draft",
        job_sheet_id: jobSheetId,
        completion_id: completionId,
        actor_staff_id: staffId,
        actor_role: fieldosNormalizeRole_(actorRole),
        previous_completion_status: "",
        new_completion_status: FIELDOS_COMPLETION_STATUSES_.DRAFT,
        version: 1
      });
      return {
        action: "create_job_completion_draft",
        message: "Draft created.",
        job_sheet_id: jobSheetId,
        data: self._assemble(header, { labour_entries: [], machinery_entries: [], material_entries: [] }, job, actorRole, staffId)
      };
    });
  },

  generateJobCompletionDraft: function (payload) {
    const jobSheetId = String(payload.job_sheet_id || "");
    const staffId = String(payload.staff_id || payload.actor_staff_id || "");
    const actorRole = payload.actor_role || "staff";
    const actor = String(payload.actor_identity || staffId);
    this._assertManager(actorRole);
    if (!jobSheetId) throw new Error("Missing required attribute: job_sheet_id.");
    const self = this;
    return Utils.withLock("JOB_COMPLETION_" + jobSheetId, 30000, function () {
      const job = self._getJob(jobSheetId);
      if (!self._jobEligibleForCompletion(job)) {
        throw new Error(
          "Validation Error: completion requires processing_status=Completed and approval_status=Approved."
        );
      }
      let header = self._findActiveCompletionRow(jobSheetId);
      const now = self._nowIso();
      const draft = fieldosBuildCompletionDraftFromJob_(job, {
        staff_name: String(payload.staff_name || "")
      });
      // Prefer OpenAI enrichment when available; never treat as authoritative.
      if (typeof OpenAI !== "undefined" && OpenAI && typeof OpenAI.chatComplete === "function") {
        try {
          const aiKey = OpenAI.getApiKey && OpenAI.getApiKey();
          if (aiKey) {
            const systemPrompt =
              "Extract candidate job-completion fields from approved FieldOS job data. " +
              "Return JSON only with keys: work_summary, invoice_description, labour_entries, " +
              "machinery_entries, material_entries, variations, warnings, overall_confidence. " +
              "Do not fabricate staff IDs, rates, prices, or times. Use blank values when unknown. " +
              "Travel is separate from labour. Unpaid breaks are not assumed. " +
              "Each labour/machinery/material row must include confirmation_status Suggested and billable false.";
            const userPrompt = JSON.stringify({
              job_sheet_id: jobSheetId,
              job_date: job.date || job.job_date || "",
              staff_id: job.staff_id || "",
              ai_summary: job.ai_summary || "",
              client_requests: job.client_requests || "",
              variations: job.variations || "",
              manager_review_items: job.manager_review_items || "",
              travel_time: job.travel_time || "",
              manager_notes: job.manager_notes || "",
              ai_transcript: String(job.ai_transcript || "").slice(0, 12000)
            });
            const raw = OpenAI.chatComplete(systemPrompt, userPrompt);
            const cleaned = String(raw || "").replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
            const parsed = JSON.parse(cleaned);
            if (parsed && typeof parsed === "object") {
              if (parsed.work_summary) draft.work_summary = String(parsed.work_summary);
              if (parsed.invoice_description) {
                draft.invoice_description = String(parsed.invoice_description);
              }
              if (Array.isArray(parsed.warnings)) {
                draft.warnings = draft.warnings.concat(parsed.warnings.map(String));
              }
              // Merge labour only when staff_id matches assignment or is blank.
              if (Array.isArray(parsed.labour_entries) && parsed.labour_entries.length) {
                const assigned = String(job.staff_id || "");
                draft.labour_entries = parsed.labour_entries
                  .map(function (row) {
                    const sid = String(row.staff_id || "");
                    if (sid && assigned && sid !== assigned) return null;
                    return {
                      staff_name: String(row.staff_name || ""),
                      staff_id: sid || assigned,
                      work_date: String(row.work_date || job.date || "").slice(0, 10),
                      start_time: String(row.start_time || ""),
                      finish_time: String(row.finish_time || ""),
                      break_minutes: Number(row.break_minutes) || 0,
                      travel_minutes: Number(row.travel_minutes) || 0,
                      role_or_activity: String(row.role_or_activity || ""),
                      billable: false,
                      confirmation_status: FIELDOS_ROW_CONFIRMATION_.SUGGESTED,
                      notes: String(row.notes || ""),
                      source: "ai_draft",
                      confidence: Number(row.confidence) || 0.4
                    };
                  })
                  .filter(Boolean);
              }
              if (Array.isArray(parsed.machinery_entries)) {
                draft.machinery_entries = parsed.machinery_entries.map(function (row) {
                  return {
                    equipment_name: String(row.equipment_name || ""),
                    operator_staff_id: String(row.operator_staff_id || job.staff_id || ""),
                    start_time: String(row.start_time || ""),
                    finish_time: String(row.finish_time || ""),
                    duration_hours:
                      row.duration_hours == null || row.duration_hours === ""
                        ? null
                        : Number(row.duration_hours),
                    billable: false,
                    confirmation_status: FIELDOS_ROW_CONFIRMATION_.SUGGESTED,
                    notes: String(row.notes || ""),
                    source: "ai_draft",
                    confidence: Number(row.confidence) || 0.4
                  };
                });
              }
              if (Array.isArray(parsed.material_entries)) {
                draft.material_entries = parsed.material_entries.map(function (row) {
                  return {
                    item_name: String(row.item_name || ""),
                    quantity: row.quantity == null ? null : Number(row.quantity),
                    unit: String(row.unit || ""),
                    billable: false,
                    confirmation_status: FIELDOS_ROW_CONFIRMATION_.SUGGESTED,
                    notes: String(row.notes || ""),
                    source: "ai_draft",
                    confidence: Number(row.confidence) || 0.4
                  };
                });
              }
              draft.warnings.push("AI draft enriched — manager confirmation required for all rows.");
            }
          }
        } catch (aiErr) {
          draft.warnings.push("AI enrichment skipped: " + String(aiErr).slice(0, 120));
        }
      }

      if (!header) {
        const completionId = DB.generateId("CMP");
        header = {
          completion_id: completionId,
          job_sheet_id: jobSheetId,
          completion_status: FIELDOS_COMPLETION_STATUSES_.DRAFT,
          work_summary: draft.work_summary,
          invoice_description: draft.invoice_description,
          internal_notes: "",
          total_labour_hours: 0,
          total_travel_hours: 0,
          total_machinery_hours: 0,
          billable_labour_hours: 0,
          non_billable_labour_hours: 0,
          variations: self._serializeList(draft.variations),
          warnings: self._serializeList(draft.warnings),
          warning_resolutions: "",
          created_by: actor,
          created_at: now,
          updated_by: actor,
          updated_at: now,
          finalised_by: "",
          finalised_at: "",
          reopened_by: "",
          reopened_at: "",
          reopen_reason: "",
          version: 1
        };
        DB.insertRecord("tbl_job_completions", header, { alreadyLocked: true });
      } else {
        if (String(header.completion_status) === FIELDOS_COMPLETION_STATUSES_.FINALISED) {
          throw new Error("Validation Error: Finalised completions require explicit reopen before regenerate.");
        }
        self._checkVersion(header, payload.expected_version);
        header.work_summary = draft.work_summary;
        header.invoice_description = draft.invoice_description;
        header.variations = self._serializeList(draft.variations);
        header.warnings = self._serializeList(draft.warnings);
        header.warning_resolutions = "";
        header.updated_by = actor;
        header.updated_at = now;
        header.version = Number(header.version || 1) + 1;
        header.completion_status =
          header.completion_status === FIELDOS_COMPLETION_STATUSES_.REOPENED
            ? FIELDOS_COMPLETION_STATUSES_.DRAFT
            : header.completion_status || FIELDOS_COMPLETION_STATUSES_.DRAFT;
        DB.updateRecord("tbl_job_completions", "completion_id", header.completion_id, {
          work_summary: header.work_summary,
          invoice_description: header.invoice_description,
          variations: header.variations,
          warnings: header.warnings,
          warning_resolutions: header.warning_resolutions,
          updated_by: header.updated_by,
          updated_at: header.updated_at,
          version: header.version,
          completion_status: header.completion_status
        });
        DB.deleteWhere("tbl_job_labour", { completion_id: header.completion_id });
        DB.deleteWhere("tbl_job_machinery", { completion_id: header.completion_id });
        DB.deleteWhere("tbl_job_materials", { completion_id: header.completion_id });
      }

      const children = self._replaceChildren(
        header.completion_id,
        jobSheetId,
        draft.labour_entries,
        draft.machinery_entries,
        draft.material_entries,
        now
      );
      const totals = self._applyTotals({}, children.labour_entries, children.machinery_entries);
      DB.updateRecord("tbl_job_completions", "completion_id", header.completion_id, {
        total_labour_hours: totals.total_labour_hours,
        total_travel_hours: totals.total_travel_hours,
        total_machinery_hours: totals.total_machinery_hours,
        billable_labour_hours: totals.billable_labour_hours,
        non_billable_labour_hours: totals.non_billable_labour_hours
      });
      header.total_labour_hours = totals.total_labour_hours;
      header.total_travel_hours = totals.total_travel_hours;
      header.total_machinery_hours = totals.total_machinery_hours;
      header.billable_labour_hours = totals.billable_labour_hours;
      header.non_billable_labour_hours = totals.non_billable_labour_hours;

      self._writeAudit({
        action: "generate_job_completion_draft",
        job_sheet_id: jobSheetId,
        completion_id: header.completion_id,
        actor_staff_id: staffId,
        actor_role: fieldosNormalizeRole_(actorRole),
        previous_completion_status: "",
        new_completion_status: header.completion_status,
        labour_count: children.labour_entries.length,
        machinery_count: children.machinery_entries.length,
        material_count: children.material_entries.length,
        version: header.version
      });

      return {
        action: "generate_job_completion_draft",
        message: "Draft generated from approved job.",
        job_sheet_id: jobSheetId,
        data: self._assemble(header, children, job, actorRole, staffId)
      };
    });
  },

  updateJobCompletion: function (payload) {
    const jobSheetId = String(payload.job_sheet_id || "");
    const staffId = String(payload.staff_id || payload.actor_staff_id || "");
    const actorRole = payload.actor_role || "staff";
    const actor = String(payload.actor_identity || staffId);
    this._assertManager(actorRole);
    if (!jobSheetId) throw new Error("Missing required attribute: job_sheet_id.");
    const self = this;
    return Utils.withLock("JOB_COMPLETION_" + jobSheetId, 30000, function () {
      const job = self._getJob(jobSheetId);
      const header = self._findActiveCompletionRow(jobSheetId);
      if (!header) throw new Error("Completion not found for job.");
      if (String(header.completion_status) === FIELDOS_COMPLETION_STATUSES_.FINALISED) {
        throw new Error("Validation Error: Finalised completions require explicit reopen before edits.");
      }
      if (self._completionBlocked(job, header)) {
        throw new Error(
          "Validation Error: completion is blocked because the job is no longer Approved/Completed."
        );
      }
      self._checkVersion(header, payload.expected_version);
      const now = self._nowIso();
      const previousStatus = String(header.completion_status || "");
      let nextStatus = previousStatus;
      if (payload.completion_status != null && String(payload.completion_status).trim() !== "") {
        const requested = String(payload.completion_status).trim();
        if (
          requested !== FIELDOS_COMPLETION_STATUSES_.DRAFT &&
          requested !== FIELDOS_COMPLETION_STATUSES_.READY
        ) {
          throw new Error("Validation Error: use finalise/reopen actions for Finalised/Reopened.");
        }
        nextStatus = requested;
      }

      const labour =
        payload.labour_entries != null
          ? payload.labour_entries
          : (self._loadChildren(header.completion_id).labour_entries || []).map(
              self._toApiLabour.bind(self)
            );
      const machinery =
        payload.machinery_entries != null
          ? payload.machinery_entries
          : (self._loadChildren(header.completion_id).machinery_entries || []).map(
              self._toApiMachinery.bind(self)
            );
      const materials =
        payload.material_entries != null
          ? payload.material_entries
          : (self._loadChildren(header.completion_id).material_entries || []).map(
              self._toApiMaterial.bind(self)
            );

      const children = self._replaceChildren(
        header.completion_id,
        jobSheetId,
        labour,
        machinery,
        materials,
        now
      );
      const patch = {
        work_summary:
          payload.work_summary != null ? String(payload.work_summary) : header.work_summary,
        invoice_description:
          payload.invoice_description != null
            ? String(payload.invoice_description)
            : header.invoice_description,
        internal_notes:
          payload.internal_notes != null ? String(payload.internal_notes) : header.internal_notes,
        variations:
          payload.variations != null
            ? self._serializeList(payload.variations)
            : header.variations,
        warnings:
          payload.warnings != null ? self._serializeList(payload.warnings) : header.warnings,
        warning_resolutions:
          payload.warning_resolutions != null
            ? self._serializeList(payload.warning_resolutions)
            : header.warning_resolutions,
        completion_status: nextStatus,
        updated_by: actor,
        updated_at: now,
        version: Number(header.version || 1) + 1
      };
      self._applyTotals(patch, children.labour_entries, children.machinery_entries);
      DB.updateRecord("tbl_job_completions", "completion_id", header.completion_id, patch);
      Object.assign(header, patch);

      self._writeAudit({
        action: "update_job_completion",
        job_sheet_id: jobSheetId,
        completion_id: header.completion_id,
        actor_staff_id: staffId,
        actor_role: fieldosNormalizeRole_(actorRole),
        previous_completion_status: previousStatus,
        new_completion_status: nextStatus,
        fields_changed: Object.keys(patch),
        labour_count: children.labour_entries.length,
        machinery_count: children.machinery_entries.length,
        material_count: children.material_entries.length,
        version: patch.version
      });

      return {
        action: "update_job_completion",
        message: "Completion updated.",
        job_sheet_id: jobSheetId,
        data: self._assemble(header, children, job, actorRole, staffId)
      };
    });
  },

  finaliseJobCompletion: function (payload) {
    const jobSheetId = String(payload.job_sheet_id || "");
    const staffId = String(payload.staff_id || payload.actor_staff_id || "");
    const actorRole = payload.actor_role || "staff";
    const actor = String(payload.actor_identity || staffId);
    this._assertManager(actorRole);
    const self = this;
    return Utils.withLock("JOB_COMPLETION_" + jobSheetId, 30000, function () {
      const job = self._getJob(jobSheetId);
      const header = self._findActiveCompletionRow(jobSheetId);
      if (!header) throw new Error("Completion not found for job.");
      self._checkVersion(header, payload.expected_version);
      const children = self._loadChildren(header.completion_id);
      const assembled = {
        completion_status: header.completion_status,
        work_summary: header.work_summary,
        invoice_description: header.invoice_description,
        warnings: self._parseList(header.warnings),
        warning_resolutions: self._parseObjectList(header.warning_resolutions),
        labour_entries: (children.labour_entries || []).map(self._toApiLabour.bind(self)),
        machinery_entries: (children.machinery_entries || []).map(self._toApiMachinery.bind(self)),
        material_entries: (children.material_entries || []).map(self._toApiMaterial.bind(self))
      };
      const gate = fieldosValidateCompletionForFinalise_(assembled, job, {
        override_reason: payload.override_reason,
        warning_resolutions: assembled.warning_resolutions
      });
      if (!gate.ok) {
        throw new Error("Validation Error: " + gate.criticalErrors.join(" "));
      }
      const now = self._nowIso();
      const previousStatus = String(header.completion_status || "");
      const patch = {
        completion_status: FIELDOS_COMPLETION_STATUSES_.FINALISED,
        finalised_by: actor,
        finalised_at: now,
        updated_by: actor,
        updated_at: now,
        version: Number(header.version || 1) + 1,
        total_labour_hours: gate.totals.total_labour_hours,
        total_travel_hours: gate.totals.total_travel_hours,
        total_machinery_hours: gate.totals.total_machinery_hours,
        billable_labour_hours: gate.totals.billable_labour_hours,
        non_billable_labour_hours: gate.totals.non_billable_labour_hours
      };
      DB.updateRecord("tbl_job_completions", "completion_id", header.completion_id, patch);
      Object.assign(header, patch);
      self._writeAudit({
        action: "finalise_job_completion",
        job_sheet_id: jobSheetId,
        completion_id: header.completion_id,
        actor_staff_id: staffId,
        actor_role: fieldosNormalizeRole_(actorRole),
        previous_completion_status: previousStatus,
        new_completion_status: FIELDOS_COMPLETION_STATUSES_.FINALISED,
        version: patch.version,
        override_reason_present: !!String(payload.override_reason || "").trim()
      });
      return {
        action: "finalise_job_completion",
        message: "Completion finalised.",
        job_sheet_id: jobSheetId,
        data: self._assemble(header, children, job, actorRole, staffId)
      };
    });
  },

  reopenJobCompletion: function (payload) {
    const jobSheetId = String(payload.job_sheet_id || "");
    const staffId = String(payload.staff_id || payload.actor_staff_id || "");
    const actorRole = payload.actor_role || "staff";
    const actor = String(payload.actor_identity || staffId);
    const reason = String(payload.reopen_reason || "").trim();
    this._assertManager(actorRole);
    if (!reason) throw new Error("Validation Error: reopen_reason is required.");
    const self = this;
    return Utils.withLock("JOB_COMPLETION_" + jobSheetId, 30000, function () {
      const job = self._getJob(jobSheetId);
      const header = self._findActiveCompletionRow(jobSheetId);
      if (!header) throw new Error("Completion not found for job.");
      if (String(header.completion_status) !== FIELDOS_COMPLETION_STATUSES_.FINALISED) {
        throw new Error("Validation Error: only Finalised completions can be reopened.");
      }
      self._checkVersion(header, payload.expected_version);
      const now = self._nowIso();
      const previousStatus = String(header.completion_status || "");
      const patch = {
        completion_status: FIELDOS_COMPLETION_STATUSES_.REOPENED,
        reopened_by: actor,
        reopened_at: now,
        reopen_reason: reason,
        updated_by: actor,
        updated_at: now,
        version: Number(header.version || 1) + 1
      };
      DB.updateRecord("tbl_job_completions", "completion_id", header.completion_id, patch);
      Object.assign(header, patch);
      const children = self._loadChildren(header.completion_id);
      self._writeAudit({
        action: "reopen_job_completion",
        job_sheet_id: jobSheetId,
        completion_id: header.completion_id,
        actor_staff_id: staffId,
        actor_role: fieldosNormalizeRole_(actorRole),
        previous_completion_status: previousStatus,
        new_completion_status: FIELDOS_COMPLETION_STATUSES_.REOPENED,
        version: patch.version,
        reopen_reason_present: true
      });
      return {
        action: "reopen_job_completion",
        message: "Completion reopened.",
        job_sheet_id: jobSheetId,
        data: self._assemble(header, children, job, actorRole, staffId)
      };
    });
  }
};
