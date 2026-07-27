/**
 * Phase 3F — job report batches and PDF data layer.
 * Depends on: JobReportHelpers.js, JobCompletionHelpers.js, CompletionExportHelpers.js,
 * JobCompletion.js, CompletionExports.js (_loadCompletionBundle), Database.js,
 * Repositories.js, Utilities.js, FieldOSGateway role helpers.
 *
 * Scope rules:
 * - This layer produces structured report DATA only. PDF bytes are rendered by FastAPI.
 * - Generated batches are immutable; regenerating means creating a new batch.
 * - Locks (REPORT_BATCH_{id}) are held around writes only, never while building payloads.
 */

var FIELDOS_REPORT_BATCH_HEADERS_ = [
  "report_batch_id",
  "report_type",
  "date_from",
  "date_to",
  "filter_json",
  "group_by",
  "status",
  "record_count",
  "line_count",
  "group_count",
  "estimated_pages",
  "template_version",
  "scope_staff_id",
  "created_by",
  "created_at",
  "validated_by",
  "validated_at",
  "completed_at",
  "file_name",
  "checksum",
  "blocker_summary",
  "notes",
  "snapshot_json",
  "version"
];

var FIELDOS_REPORT_ITEM_HEADERS_ = [
  "report_batch_item_id",
  "report_batch_id",
  "job_sheet_id",
  "completion_id",
  "group_key",
  "group_label",
  "sort_order",
  "item_status",
  "line_count",
  "blocker_summary",
  "created_at"
];

var FieldOSJobReports = {
  _nowIso: function () {
    try {
      return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX");
    } catch (e) {
      return new Date().toISOString();
    }
  },

  _actor: function (payload) {
    var p = payload || {};
    var role = fieldosNormalizeRole_(p.actor_role || p.role || "staff");
    return {
      role: role,
      is_manager: fieldosIsManagerOrAdmin_(role),
      staff_id: String(p.actor_staff_id || p.staff_id || "").trim(),
      identity: String(p.actor_identity || p.staff_id || "").trim()
    };
  },

  _reportTypeList: function () {
    return [
      FIELDOS_REPORT_TYPES_.JOB_SHEET_SUMMARY,
      FIELDOS_REPORT_TYPES_.STAFF_WORK_REPORT,
      FIELDOS_REPORT_TYPES_.CLIENT_JOB_REPORT,
      FIELDOS_REPORT_TYPES_.PROJECT_ACTIVITY_REPORT,
      FIELDOS_REPORT_TYPES_.COMPLETION_REGISTER
    ];
  },

  _allowedReportTypes: function (actor) {
    if (actor.is_manager) return this._reportTypeList();
    return [FIELDOS_REPORT_TYPES_.STAFF_WORK_REPORT];
  },

  _resolveReportType: function (payload, actor) {
    var requested = String((payload && payload.report_type) || "").trim();
    var allowed = this._allowedReportTypes(actor);
    if (!requested) {
      return actor.is_manager ? FIELDOS_REPORT_TYPES_.JOB_SHEET_SUMMARY : FIELDOS_REPORT_TYPES_.STAFF_WORK_REPORT;
    }
    if (this._reportTypeList().indexOf(requested) < 0) {
      throw new Error("Validation Error: unsupported report_type.");
    }
    if (allowed.indexOf(requested) < 0) {
      throw new Error("Forbidden: staff may only run the Staff Work Report.");
    }
    return requested;
  },

  _assertStaffScope: function (actor) {
    if (actor.is_manager) return;
    if (!actor.staff_id) {
      throw new Error("Missing required attribute: staff_id.");
    }
  },

  _tablesExist: function () {
    try {
      DB.getSheet("tbl_report_batches");
      DB.getSheet("tbl_report_batch_items");
      return true;
    } catch (e) {
      return false;
    }
  },

  _assertTables: function () {
    if (!this._tablesExist()) {
      throw new Error("Validation Error: report tables missing — run migrateSchemaForJobReports().");
    }
  },

  _parseJson: function (raw, fallback) {
    if (raw == null || raw === "") return fallback;
    if (typeof raw === "object") return raw;
    try {
      return JSON.parse(String(raw));
    } catch (e) {
      return fallback;
    }
  },

  _readTable: function (tableName) {
    try {
      return DB.findAll(tableName) || [];
    } catch (e) {
      return [];
    }
  },

  _jobRow: function (jobSheetId, cache) {
    var id = String(jobSheetId || "");
    if (!id) return null;
    if (cache && Object.prototype.hasOwnProperty.call(cache, id)) return cache[id];
    var row = null;
    try {
      row = JobSheetRepository.findById(id) || null;
    } catch (e) {
      row = null;
    }
    if (cache) cache[id] = row;
    return row;
  },

  _jobDisplay: function (job) {
    var j = job || {};
    return {
      job_sheet_id: String(j.job_sheet_id || ""),
      job_date: fieldosNormaliseCalendarDate_(j.date || j.job_date) || "",
      customer_name: String(j.customer_name || j.customer || ""),
      project_name: String(j.project_name || j.project_id || ""),
      approval_status: String(j.approval_status || ""),
      processing_status: String(j.processing_status || ""),
      assigned_staff_id: String(j.staff_id || j.assigned_staff_id || "")
    };
  },

  /** Recording evidence is counted, never read. No IDs, URLs or transcripts. */
  _recordingCount: function (jobSheetId) {
    var id = String(jobSheetId || "");
    if (!id) return 0;
    try {
      return (DB.findWhere("tbl_recordings", { job_sheet_id: id }) || []).length;
    } catch (e) {
      return 0;
    }
  },

  /** Minimal duplicate of the Phase 3D loader, used when CompletionExports is absent. */
  _minimalCompletionBundle: function (completionRow, job) {
    var row = completionRow || {};
    var completionId = String(row.completion_id || "");
    var jobSheetId = String(row.job_sheet_id || "");
    var labour = [];
    var machinery = [];
    var materials = [];
    try {
      labour = DB.findWhere("tbl_job_labour", { completion_id: completionId }) || [];
      machinery = DB.findWhere("tbl_job_machinery", { completion_id: completionId }) || [];
      materials = DB.findWhere("tbl_job_materials", { completion_id: completionId }) || [];
    } catch (e) {
      /* leave children empty when child tables are missing */
    }
    var completion = {
      completion_id: completionId,
      job_sheet_id: jobSheetId,
      completion_status: String(row.completion_status || ""),
      work_summary: String(row.work_summary || ""),
      invoice_description: String(row.invoice_description || ""),
      internal_notes: String(row.internal_notes || ""),
      total_labour_hours: Number(row.total_labour_hours) || 0,
      total_travel_hours: Number(row.total_travel_hours) || 0,
      total_machinery_hours: Number(row.total_machinery_hours) || 0,
      billable_labour_hours: Number(row.billable_labour_hours) || 0,
      non_billable_labour_hours: Number(row.non_billable_labour_hours) || 0,
      variations: fieldosSplitReportLines_(row.variations),
      finalised_by: String(row.finalised_by || ""),
      finalised_at: row.finalised_at || null,
      version: Number(row.version) || 1
    };
    return {
      completion: completion,
      job: this._jobDisplay(job),
      labour_entries: labour,
      machinery_entries: machinery,
      material_entries: materials,
      readiness: { invoice_ready: false, payroll_ready: false, warning_count: 0 }
    };
  },

  _loadBundle: function (completionRow, cache) {
    var bundle = null;
    if (
      typeof FieldOSCompletionExports !== "undefined" &&
      FieldOSCompletionExports &&
      typeof FieldOSCompletionExports._loadCompletionBundle === "function"
    ) {
      bundle = FieldOSCompletionExports._loadCompletionBundle(completionRow);
    }
    var jobSheetId = String((completionRow && completionRow.job_sheet_id) || "");
    var jobRow = this._jobRow(jobSheetId, cache);
    if (!bundle) bundle = this._minimalCompletionBundle(completionRow, jobRow);
    if (!bundle.completion.internal_notes) {
      bundle.completion.internal_notes = String((completionRow && completionRow.internal_notes) || "");
    }
    return this._decorateBundle(bundle, jobRow);
  },

  _decorateBundle: function (bundle, jobRow) {
    var b = bundle;
    var completionVariations = (b.completion && b.completion.variations) || [];
    b.task_lines = fieldosExtractTaskLines_(jobRow || {}, {
      approval_status: (jobRow && jobRow.approval_status) || (b.job && b.job.approval_status) || "",
      variations:
        completionVariations && completionVariations.length
          ? completionVariations
          : jobRow
            ? jobRow.variations
            : ""
    });
    b.recording_count = this._recordingCount(b.job && b.job.job_sheet_id);
    return b;
  },

  /** Job-only bundle for jobs that have no completion record yet. */
  _bundleFromJob: function (jobRow) {
    var bundle = {
      completion: {
        completion_id: "",
        job_sheet_id: String((jobRow && jobRow.job_sheet_id) || ""),
        completion_status: "",
        work_summary: "",
        invoice_description: "",
        internal_notes: "",
        total_labour_hours: 0,
        total_travel_hours: 0,
        total_machinery_hours: 0,
        billable_labour_hours: 0,
        non_billable_labour_hours: 0,
        variations: [],
        finalised_by: "",
        finalised_at: null,
        version: 1
      },
      job: this._jobDisplay(jobRow),
      labour_entries: [],
      machinery_entries: [],
      material_entries: [],
      readiness: { invoice_ready: false, payroll_ready: false, warning_count: 0 }
    };
    return this._decorateBundle(bundle, jobRow);
  },

  /**
   * Reduce a bundle to what one staff member is allowed to see: their own labour
   * rows, no machinery/materials, no internal notes, and totals recomputed from
   * the remaining rows so job-wide aggregates are not disclosed.
   */
  _scopeBundleToStaff: function (bundle, staffId) {
    var id = String(staffId || "");
    bundle.labour_entries = (bundle.labour_entries || []).filter(function (row) {
      return String((row && row.staff_id) || "") === id;
    });
    bundle.machinery_entries = [];
    bundle.material_entries = [];
    bundle.completion.internal_notes = "";
    if (typeof fieldosComputeCompletionTotals_ === "function") {
      var totals = fieldosComputeCompletionTotals_(bundle.labour_entries, []);
      bundle.completion.total_labour_hours = totals.total_labour_hours;
      bundle.completion.total_travel_hours = totals.total_travel_hours;
      bundle.completion.total_machinery_hours = 0;
      bundle.completion.billable_labour_hours = totals.billable_labour_hours;
      bundle.completion.non_billable_labour_hours = totals.non_billable_labour_hours;
    }
    return bundle;
  },

  /**
   * All bundles visible to the actor that match the filters, plus the rejected
   * ones with reasons. Runs entirely outside any lock.
   */
  _collectBundles: function (filters, actor) {
    var self = this;
    var cache = {};
    var rows = this._readTable("tbl_job_completions");
    var included = [];
    var excluded = [];
    rows.forEach(function (row) {
      var bundle;
      try {
        bundle = self._loadBundle(row, cache);
      } catch (e) {
        excluded.push({
          job_sheet_id: String(row.job_sheet_id || ""),
          completion_id: String(row.completion_id || ""),
          reasons: ["Completion could not be loaded."]
        });
        return;
      }
      if (fieldosMatchReportFilters_(bundle, filters, actor)) {
        if (!actor.is_manager) self._scopeBundleToStaff(bundle, actor.staff_id);
        included.push(bundle);
        return;
      }
      var reasons = fieldosReportExclusionReasons_(bundle, filters, actor);
      // Staff actors are never told about jobs outside their own scope.
      if (!actor.is_manager) return;
      excluded.push({
        job_sheet_id: bundle.job.job_sheet_id,
        completion_id: bundle.completion.completion_id,
        job_date: bundle.job.job_date,
        reasons: reasons.length ? reasons : ["Did not match the report filters."]
      });
    });
    included.sort(function (a, b) {
      var ak = fieldosReportBundleSortKey_(a);
      var bk = fieldosReportBundleSortKey_(b);
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
    excluded.sort(function (a, b) {
      var ak = String(a.job_date || "") + "|" + String(a.job_sheet_id || "");
      var bk = String(b.job_date || "") + "|" + String(b.job_sheet_id || "");
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
    return { included: included, excluded: excluded };
  },

  _buildFilters: function (payload, actor) {
    var p = payload || {};
    var source = p.filters && typeof p.filters === "object" ? p.filters : p;
    var filters = {
      date_from: fieldosNormaliseCalendarDate_(source.date_from) || String(source.date_from || ""),
      date_to: fieldosNormaliseCalendarDate_(source.date_to) || String(source.date_to || ""),
      staff: String(source.staff || source.assigned_staff_id || source.staff_id_filter || "").trim(),
      customer: String(source.customer || "").trim(),
      project: String(source.project || "").trim(),
      completion_status: String(source.completion_status || "").trim(),
      approval_status: String(source.approval_status || "").trim(),
      job_sheet_id: String(source.job_sheet_id || "").trim(),
      completion_id: String(source.completion_id || "").trim()
    };
    if (source.billable === true || source.billable === false) {
      filters.billable = source.billable;
    } else if (source.billable === "true" || source.billable === "TRUE") {
      filters.billable = true;
    } else if (source.billable === "false" || source.billable === "FALSE") {
      filters.billable = false;
    }
    // Staff actors are always pinned to their own staff_id.
    if (!actor.is_manager) filters.staff = actor.staff_id;
    return filters;
  },

  _totals: function (bundles) {
    var totals = {
      job_count: 0,
      completion_count: 0,
      finalised_count: 0,
      approved_count: 0,
      labour_row_count: 0,
      machinery_row_count: 0,
      material_row_count: 0,
      task_line_count: 0,
      recording_count_only: 0,
      total_labour_hours: 0,
      total_travel_hours: 0,
      total_machinery_hours: 0,
      billable_labour_hours: 0,
      non_billable_labour_hours: 0
    };
    var jobIds = [];
    var finalised =
      typeof FIELDOS_COMPLETION_STATUSES_ !== "undefined"
        ? FIELDOS_COMPLETION_STATUSES_.FINALISED
        : "Finalised";
    (bundles || []).forEach(function (bundle) {
      var c = bundle.completion || {};
      var job = bundle.job || {};
      if (job.job_sheet_id && jobIds.indexOf(job.job_sheet_id) < 0) jobIds.push(job.job_sheet_id);
      if (c.completion_id) totals.completion_count += 1;
      if (String(c.completion_status || "") === finalised) totals.finalised_count += 1;
      if (String(job.approval_status || "") === "Approved") totals.approved_count += 1;
      totals.labour_row_count += (bundle.labour_entries || []).length;
      totals.machinery_row_count += (bundle.machinery_entries || []).length;
      totals.material_row_count += (bundle.material_entries || []).length;
      totals.task_line_count += (bundle.task_lines || []).length;
      totals.recording_count_only += Number(bundle.recording_count) || 0;
      totals.total_labour_hours += Number(c.total_labour_hours) || 0;
      totals.total_travel_hours += Number(c.total_travel_hours) || 0;
      totals.total_machinery_hours += Number(c.total_machinery_hours) || 0;
      totals.billable_labour_hours += Number(c.billable_labour_hours) || 0;
      totals.non_billable_labour_hours += Number(c.non_billable_labour_hours) || 0;
    });
    totals.job_count = jobIds.length;
    [
      "total_labour_hours",
      "total_travel_hours",
      "total_machinery_hours",
      "billable_labour_hours",
      "non_billable_labour_hours"
    ].forEach(function (key) {
      totals[key] = Math.round(totals[key] * 100) / 100;
    });
    return totals;
  },

  /** Hard blockers stop a batch from being generated. */
  _itemBlockers: function (bundle, reportType) {
    var blockers = [];
    if (!bundle) return ["Completion not found."];
    var c = bundle.completion || {};
    var job = bundle.job || {};
    var finalised =
      typeof FIELDOS_COMPLETION_STATUSES_ !== "undefined"
        ? FIELDOS_COMPLETION_STATUSES_.FINALISED
        : "Finalised";
    if (!job.job_sheet_id) blockers.push("Job sheet not found for this completion.");
    if (!job.job_date) blockers.push("Job date unresolved.");
    if (reportType === FIELDOS_REPORT_TYPES_.CLIENT_JOB_REPORT) {
      if (String(job.approval_status || "") !== "Approved") {
        blockers.push("Client reports require job approval_status Approved.");
      }
      if (String(c.completion_status || "") !== finalised) {
        blockers.push("Client reports require a Finalised completion.");
      }
    }
    if (reportType === FIELDOS_REPORT_TYPES_.COMPLETION_REGISTER) {
      if (String(c.completion_status || "") !== finalised) {
        blockers.push("Completion register rows require a Finalised completion.");
      }
    }
    if (reportType === FIELDOS_REPORT_TYPES_.STAFF_WORK_REPORT) {
      if (!(bundle.labour_entries || []).length) {
        blockers.push("Staff work reports require at least one labour row.");
      }
    }
    return fieldosUniqueMessages_(blockers);
  },

  /** Soft warnings surface in preview but never block generation. */
  _itemWarnings: function (bundle, reportType) {
    var warnings = [];
    if (!bundle) return warnings;
    var c = bundle.completion || {};
    var job = bundle.job || {};
    var finalised =
      typeof FIELDOS_COMPLETION_STATUSES_ !== "undefined"
        ? FIELDOS_COMPLETION_STATUSES_.FINALISED
        : "Finalised";
    if (String(c.completion_status || "") !== finalised) {
      warnings.push("Completion is not Finalised — figures may change.");
    }
    if (String(job.approval_status || "") !== "Approved") {
      warnings.push("Job is not Approved — manager review items are omitted from tasks.");
    }
    if (!(bundle.task_lines || []).length) {
      warnings.push("No manager-reviewed task lines or variations recorded.");
    }
    return fieldosUniqueMessages_(warnings);
  },

  _buildPreview: function (reportType, groupBy, filters, actor) {
    var self = this;
    var collected = this._collectBundles(filters, actor);
    var included = collected.included;
    var grouped = fieldosGroupReportBundles_(included, reportType, groupBy);
    var totals = this._totals(included);
    var lineCount = 0;
    included.forEach(function (bundle) {
      lineCount += fieldosReportBundleLineCount_(bundle);
    });
    var estimatedPages = fieldosEstimateReportPages_(reportType, included.length, {
      line_count: lineCount,
      group_count: grouped.groups.length
    });

    var itemDiagnostics = included.map(function (bundle) {
      return {
        job_sheet_id: bundle.job.job_sheet_id,
        completion_id: bundle.completion.completion_id,
        job_date: bundle.job.job_date,
        customer_name: bundle.job.customer_name,
        project_name: bundle.job.project_name,
        completion_status: bundle.completion.completion_status,
        approval_status: bundle.job.approval_status,
        line_count: fieldosReportBundleLineCount_(bundle),
        task_line_count: (bundle.task_lines || []).length,
        recording_count_only: Number(bundle.recording_count) || 0,
        blockers: self._itemBlockers(bundle, reportType),
        warnings: self._itemWarnings(bundle, reportType)
      };
    });

    var blockers = [];
    if (!included.length) blockers.push("No jobs match the report filters.");
    if (included.length > FIELDOS_REPORT_MAX_RECORDS_) {
      blockers.push(
        "Report covers " +
          included.length +
          " records (limit " +
          FIELDOS_REPORT_MAX_RECORDS_ +
          ") — narrow the filters."
      );
    }
    itemDiagnostics.forEach(function (item) {
      item.blockers.forEach(function (message) {
        blockers.push(item.job_sheet_id + ": " + message);
      });
    });

    return {
      bundles: included,
      grouped: grouped,
      totals: totals,
      line_count: lineCount,
      estimated_pages: estimatedPages,
      items: itemDiagnostics,
      excluded: collected.excluded,
      blockers: fieldosUniqueMessages_(blockers)
    };
  },

  _writeAudit: function (meta) {
    try {
      SyncRepository.create({
        record_id: meta.report_batch_id || meta.job_sheet_id || "FIELDOS_REPORT",
        target_system: "FieldOS_Reports",
        status: "Success",
        request_payload: JSON.stringify(fieldosReportAuditPayload_(meta)),
        response_payload: String(meta.new_status || ""),
        timestamp: new Date()
      });
    } catch (err) {
      if (typeof Logger !== "undefined" && Logger.log) {
        Logger.log("Report audit write failed: " + err);
      }
    }
  },

  _getBatch: function (reportBatchId) {
    var id = String(reportBatchId || "");
    if (!id) throw new Error("Missing required attribute: report_batch_id.");
    var rows = DB.findWhere("tbl_report_batches", { report_batch_id: id }) || [];
    if (!rows.length) throw new Error("Not Found: report batch " + id + " does not exist.");
    return rows[0];
  },

  _assertBatchAccess: function (header, actor) {
    if (actor.is_manager) return;
    if (String(header.scope_staff_id || "") !== actor.staff_id) {
      throw new Error("Forbidden: report batch belongs to another staff member.");
    }
  },

  _checkVersion: function (header, expectedVersion) {
    if (expectedVersion == null || expectedVersion === "") return;
    if (Number(header.version || 0) !== Number(expectedVersion)) {
      throw new Error("Conflict: report batch version changed since you loaded this record.");
    }
  },

  _assertMutable: function (header, verb) {
    var status = String(header.status || "");
    if (status === FIELDOS_REPORT_STATUS_.GENERATED) {
      throw new Error(
        "Validation Error: Generated report batches are immutable — create a new batch to regenerate."
      );
    }
    if (status === FIELDOS_REPORT_STATUS_.CANCELLED) {
      throw new Error("Validation Error: Cancelled report batches cannot be " + verb + ".");
    }
  },

  _batchToApi: function (header) {
    return {
      report_batch_id: String(header.report_batch_id || ""),
      report_type: String(header.report_type || ""),
      date_from: String(header.date_from || ""),
      date_to: String(header.date_to || ""),
      filters: this._parseJson(header.filter_json, {}),
      group_by: String(header.group_by || ""),
      status: String(header.status || ""),
      record_count: Number(header.record_count) || 0,
      line_count: Number(header.line_count) || 0,
      group_count: Number(header.group_count) || 0,
      estimated_pages: Number(header.estimated_pages) || 0,
      template_version: String(header.template_version || ""),
      scope_staff_id: String(header.scope_staff_id || ""),
      created_by: String(header.created_by || ""),
      created_at: header.created_at || null,
      validated_by: String(header.validated_by || ""),
      validated_at: header.validated_at || null,
      completed_at: header.completed_at || null,
      file_name: String(header.file_name || ""),
      checksum: String(header.checksum || ""),
      blockers: this._parseJson(header.blocker_summary, []),
      notes: String(header.notes || ""),
      version: Number(header.version) || 1
    };
  },

  _assembleBatch: function (header) {
    var items = DB.findWhere("tbl_report_batch_items", {
      report_batch_id: String(header.report_batch_id || "")
    }) || [];
    items.sort(function (a, b) {
      var an = Number(a.sort_order);
      var bn = Number(b.sort_order);
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
      var ak = String(a.job_sheet_id || "") + "|" + String(a.completion_id || "");
      var bk = String(b.job_sheet_id || "") + "|" + String(b.completion_id || "");
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
    return {
      report_batch: this._batchToApi(header),
      items: items.map(function (row) {
        return {
          report_batch_item_id: String(row.report_batch_item_id || ""),
          report_batch_id: String(row.report_batch_id || ""),
          job_sheet_id: String(row.job_sheet_id || ""),
          completion_id: String(row.completion_id || ""),
          group_key: String(row.group_key || ""),
          group_label: String(row.group_label || ""),
          sort_order: Number(row.sort_order) || 0,
          item_status: String(row.item_status || ""),
          line_count: Number(row.line_count) || 0,
          blocker_summary: String(row.blocker_summary || ""),
          created_at: row.created_at || null
        };
      })
    };
  },

  _groupLookup: function (grouped) {
    var lookup = {};
    (grouped.groups || []).forEach(function (group) {
      (group.items || []).forEach(function (item) {
        var bundle = item.bundle || {};
        var key =
          String((bundle.job && bundle.job.job_sheet_id) || "") +
          "|" +
          String((bundle.completion && bundle.completion.completion_id) || "");
        if (!lookup[key]) {
          lookup[key] = { group_key: group.group_key, group_label: group.group_label };
        }
      });
    });
    return lookup;
  },

  getReportOptions: function (payload) {
    var actor = this._actor(payload);
    this._assertStaffScope(actor);
    var allowed = this._allowedReportTypes(actor);
    var types = allowed.map(function (type) {
      var groups = fieldosReportGroupOptions_(type);
      return {
        report_type: type,
        default_group_by: groups.default_group,
        allowed_group_by: groups.allowed
      };
    });
    return {
      action: "get_report_options",
      message: "OK",
      data: {
        actor_role: actor.role,
        report_types: types,
        report_statuses: [
          FIELDOS_REPORT_STATUS_.DRAFT,
          FIELDOS_REPORT_STATUS_.VALIDATED,
          FIELDOS_REPORT_STATUS_.GENERATED,
          FIELDOS_REPORT_STATUS_.CANCELLED
        ],
        template_version: FIELDOS_REPORT_TEMPLATE_VERSION_,
        max_records: FIELDOS_REPORT_MAX_RECORDS_,
        filter_keys: [
          "date_from",
          "date_to",
          "staff",
          "customer",
          "project",
          "completion_status",
          "approval_status",
          "billable",
          "job_sheet_id",
          "completion_id"
        ],
        scoped_to_staff_id: actor.is_manager ? "" : actor.staff_id
      }
    };
  },

  previewReport: function (payload) {
    var actor = this._actor(payload);
    this._assertStaffScope(actor);
    var reportType = this._resolveReportType(payload, actor);
    var filters = this._buildFilters(payload, actor);
    var groupBy = fieldosReportResolveGroupBy_(reportType, payload && payload.group_by);
    var preview = this._buildPreview(reportType, groupBy, filters, actor);

    this._writeAudit({
      action: "preview_report",
      report_type: reportType,
      group_by: groupBy,
      actor_staff_id: actor.staff_id,
      actor_role: actor.role,
      record_count: preview.bundles.length,
      line_count: preview.line_count,
      group_count: preview.grouped.groups.length,
      estimated_pages: preview.estimated_pages,
      blocker_count: preview.blockers.length,
      template_version: FIELDOS_REPORT_TEMPLATE_VERSION_,
      date_from: filters.date_from,
      date_to: filters.date_to,
      correlation_id: payload && payload.correlation_id
    });

    return {
      action: "preview_report",
      message: "OK",
      data: {
        report_type: reportType,
        group_by: groupBy,
        filters: filters,
        template_version: FIELDOS_REPORT_TEMPLATE_VERSION_,
        included: preview.items,
        excluded: preview.excluded,
        groupings: preview.grouped.groups.map(function (group) {
          return {
            group_key: group.group_key,
            group_label: group.group_label,
            group_type: group.group_type,
            record_count: group.record_count,
            line_count: group.line_count,
            job_sheet_ids: group.job_sheet_ids
          };
        }),
        totals: preview.totals,
        record_count: preview.bundles.length,
        line_count: preview.line_count,
        estimated_pages: preview.estimated_pages,
        blockers: preview.blockers
      }
    };
  },

  createReportBatch: function (payload) {
    var self = this;
    var actor = this._actor(payload);
    this._assertStaffScope(actor);
    this._assertTables();
    var reportType = this._resolveReportType(payload, actor);
    var filters = this._buildFilters(payload, actor);
    var groupBy = fieldosReportResolveGroupBy_(reportType, payload && payload.group_by);

    // Heavy work first: nothing below the lock builds large payloads.
    var preview = this._buildPreview(reportType, groupBy, filters, actor);
    if (!preview.bundles.length) {
      throw new Error("Validation Error: no jobs match the report filters.");
    }
    if (preview.bundles.length > FIELDOS_REPORT_MAX_RECORDS_) {
      throw new Error(
        "Validation Error: report covers " +
          preview.bundles.length +
          " records (limit " +
          FIELDOS_REPORT_MAX_RECORDS_ +
          ") — narrow the filters."
      );
    }

    var batchId = DB.generateId("RPT");
    var now = this._nowIso();
    var groupLookup = this._groupLookup(preview.grouped);
    var header = {
      report_batch_id: batchId,
      report_type: reportType,
      date_from: String(filters.date_from || ""),
      date_to: String(filters.date_to || ""),
      filter_json: JSON.stringify(filters),
      group_by: groupBy,
      status: FIELDOS_REPORT_STATUS_.DRAFT,
      record_count: preview.bundles.length,
      line_count: preview.line_count,
      group_count: preview.grouped.groups.length,
      estimated_pages: preview.estimated_pages,
      template_version: FIELDOS_REPORT_TEMPLATE_VERSION_,
      scope_staff_id: actor.is_manager ? "" : actor.staff_id,
      created_by: actor.identity || actor.staff_id,
      created_at: now,
      validated_by: "",
      validated_at: "",
      completed_at: "",
      file_name: "",
      checksum: "",
      blocker_summary: JSON.stringify(preview.blockers),
      notes: String((payload && payload.notes) || ""),
      snapshot_json: "",
      version: 1
    };

    var assembled = Utils.withLock("REPORT_BATCH_" + batchId, 30000, function () {
      DB.insertRecord("tbl_report_batches", header, { alreadyLocked: true });
      preview.bundles.forEach(function (bundle, index) {
        var key =
          String(bundle.job.job_sheet_id || "") + "|" + String(bundle.completion.completion_id || "");
        var group = groupLookup[key] || { group_key: "", group_label: "" };
        DB.insertRecord(
          "tbl_report_batch_items",
          {
            report_batch_item_id: DB.generateId("RPI"),
            report_batch_id: batchId,
            job_sheet_id: bundle.job.job_sheet_id,
            completion_id: bundle.completion.completion_id,
            group_key: group.group_key,
            group_label: group.group_label,
            sort_order: index + 1,
            item_status: "Pending",
            line_count: fieldosReportBundleLineCount_(bundle),
            blocker_summary: self._itemBlockers(bundle, reportType).join("; "),
            created_at: now
          },
          { alreadyLocked: true }
        );
      });
      return self._assembleBatch(header);
    });

    this._writeAudit({
      action: "create_report_batch",
      report_batch_id: batchId,
      report_type: reportType,
      group_by: groupBy,
      actor_staff_id: actor.staff_id,
      actor_role: actor.role,
      new_status: FIELDOS_REPORT_STATUS_.DRAFT,
      record_count: preview.bundles.length,
      line_count: preview.line_count,
      group_count: preview.grouped.groups.length,
      estimated_pages: preview.estimated_pages,
      blocker_count: preview.blockers.length,
      template_version: FIELDOS_REPORT_TEMPLATE_VERSION_,
      date_from: header.date_from,
      date_to: header.date_to,
      correlation_id: payload && payload.correlation_id
    });

    return {
      action: "create_report_batch",
      message: "Report batch created.",
      data: assembled
    };
  },

  listReportBatches: function (payload) {
    var actor = this._actor(payload);
    this._assertStaffScope(actor);
    if (!this._tablesExist()) {
      return { action: "list_report_batches", message: "OK", data: { items: [] } };
    }
    var self = this;
    var reportType = String((payload && payload.report_type) || "").trim();
    var status = String((payload && payload.status) || "").trim();
    var rows = this._readTable("tbl_report_batches").filter(function (row) {
      if (!actor.is_manager && String(row.scope_staff_id || "") !== actor.staff_id) return false;
      if (reportType && String(row.report_type || "") !== reportType) return false;
      if (status && String(row.status || "") !== status) return false;
      return true;
    });
    rows.sort(function (a, b) {
      return (
        String(b.created_at || "").localeCompare(String(a.created_at || "")) ||
        String(a.report_batch_id || "").localeCompare(String(b.report_batch_id || ""))
      );
    });
    return {
      action: "list_report_batches",
      message: "OK",
      data: {
        items: rows.map(function (row) {
          return self._batchToApi(row);
        })
      }
    };
  },

  getReportBatch: function (payload) {
    var actor = this._actor(payload);
    this._assertStaffScope(actor);
    var header = this._getBatch(payload && payload.report_batch_id);
    this._assertBatchAccess(header, actor);
    return {
      action: "get_report_batch",
      message: "OK",
      data: this._assembleBatch(header)
    };
  },

  validateReportBatch: function (payload) {
    var self = this;
    var actor = this._actor(payload);
    this._assertStaffScope(actor);
    var batchId = String((payload && payload.report_batch_id) || "");
    var header = this._getBatch(batchId);
    this._assertBatchAccess(header, actor);
    this._assertMutable(header, "validated");

    var reportType = String(header.report_type || "");
    var scopeStaffId = String(header.scope_staff_id || "");
    var itemRows = DB.findWhere("tbl_report_batch_items", { report_batch_id: batchId }) || [];
    var cache = {};

    // Recompute item state outside the lock; only the writes below are serialised.
    var evaluated = itemRows.map(function (item) {
      var bundle = null;
      var completionId = String(item.completion_id || "");
      var jobSheetId = String(item.job_sheet_id || "");
      if (completionId) {
        var rows = [];
        try {
          rows = DB.findWhere("tbl_job_completions", { completion_id: completionId }) || [];
        } catch (e) {
          rows = [];
        }
        if (rows.length) bundle = self._loadBundle(rows[0], cache);
      } else if (jobSheetId) {
        var jobRow = self._jobRow(jobSheetId, cache);
        if (jobRow) bundle = self._bundleFromJob(jobRow);
      }
      if (bundle && scopeStaffId) self._scopeBundleToStaff(bundle, scopeStaffId);
      var blockers = self._itemBlockers(bundle, reportType);
      return {
        item: item,
        bundle: bundle,
        blockers: blockers,
        line_count: bundle ? fieldosReportBundleLineCount_(bundle) : 0
      };
    });

    var batchBlockers = [];
    if (!evaluated.length) batchBlockers.push("Report batch has no items.");
    evaluated.forEach(function (entry) {
      entry.blockers.forEach(function (message) {
        batchBlockers.push(String(entry.item.job_sheet_id || "") + ": " + message);
      });
    });
    batchBlockers = fieldosUniqueMessages_(batchBlockers);
    var nextStatus = batchBlockers.length
      ? FIELDOS_REPORT_STATUS_.DRAFT
      : FIELDOS_REPORT_STATUS_.VALIDATED;
    var previous = String(header.status || "");

    var result = Utils.withLock("REPORT_BATCH_" + batchId, 30000, function () {
      var current = self._getBatch(batchId);
      self._checkVersion(current, payload && payload.expected_version);
      self._assertMutable(current, "validated");
      evaluated.forEach(function (entry) {
        DB.updateRecord("tbl_report_batch_items", "report_batch_item_id", entry.item.report_batch_item_id, {
          item_status: entry.blockers.length ? "Blocked" : "Ready",
          blocker_summary: entry.blockers.join("; "),
          line_count: entry.line_count
        });
      });
      var patch = {
        status: nextStatus,
        blocker_summary: JSON.stringify(batchBlockers),
        validated_by: batchBlockers.length ? "" : actor.identity || actor.staff_id,
        validated_at: batchBlockers.length ? "" : self._nowIso(),
        version: Number(current.version || 1) + 1
      };
      DB.updateRecord("tbl_report_batches", "report_batch_id", batchId, patch);
      var merged = {};
      Object.keys(current).forEach(function (key) {
        merged[key] = current[key];
      });
      Object.assign(merged, patch);
      return self._assembleBatch(merged);
    });

    this._writeAudit({
      action: "validate_report_batch",
      report_batch_id: batchId,
      report_type: reportType,
      group_by: String(header.group_by || ""),
      actor_staff_id: actor.staff_id,
      actor_role: actor.role,
      previous_status: previous,
      new_status: nextStatus,
      record_count: evaluated.length,
      blocker_count: batchBlockers.length,
      template_version: String(header.template_version || FIELDOS_REPORT_TEMPLATE_VERSION_),
      correlation_id: payload && payload.correlation_id
    });

    return {
      action: "validate_report_batch",
      message: batchBlockers.length ? "Report batch has blockers." : "Report batch validated.",
      data: result
    };
  },

  generateReportData: function (payload) {
    var self = this;
    var p = payload || {};
    var actor = this._actor(p);
    this._assertStaffScope(actor);
    var batchId = String(p.report_batch_id || "");
    var header = this._getBatch(batchId);
    this._assertBatchAccess(header, actor);
    this._assertMutable(header, "generated");
    if (String(header.status || "") !== FIELDOS_REPORT_STATUS_.VALIDATED) {
      throw new Error("Validation Error: validate the report batch before generating.");
    }

    var reportType = String(header.report_type || "");
    var groupBy = String(header.group_by || "");
    var scopeStaffId = String(header.scope_staff_id || "");
    var itemRows = DB.findWhere("tbl_report_batch_items", { report_batch_id: batchId }) || [];
    itemRows.sort(function (a, b) {
      return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
    });

    // Snapshot assembly happens entirely outside the lock.
    var cache = {};
    var bundles = [];
    itemRows.forEach(function (item) {
      if (String(item.item_status || "") === "Blocked") {
        throw new Error("Validation Error: report batch still has blocked items.");
      }
      var completionId = String(item.completion_id || "");
      var jobSheetId = String(item.job_sheet_id || "");
      var bundle = null;
      if (completionId) {
        var rows = DB.findWhere("tbl_job_completions", { completion_id: completionId }) || [];
        if (rows.length) bundle = self._loadBundle(rows[0], cache);
      } else if (jobSheetId) {
        var jobRow = self._jobRow(jobSheetId, cache);
        if (jobRow) bundle = self._bundleFromJob(jobRow);
      }
      if (!bundle) throw new Error("Validation Error: source job missing for batch item.");
      if (scopeStaffId) self._scopeBundleToStaff(bundle, scopeStaffId);
      bundles.push(bundle);
    });

    var generatedAt = this._nowIso();
    var grouped = fieldosGroupReportBundles_(bundles, reportType, groupBy);
    var totals = this._totals(bundles);
    var lineCount = 0;
    bundles.forEach(function (bundle) {
      lineCount += fieldosReportBundleLineCount_(bundle);
    });
    var estimatedPages = fieldosEstimateReportPages_(reportType, bundles.length, {
      line_count: lineCount,
      group_count: grouped.groups.length
    });
    var includeInternal =
      actor.is_manager &&
      (p.include_internal_notes === true || p.include_internal_notes === "true");

    var jobsData = bundles.map(function (bundle) {
      return fieldosBuildJobPdfData_(bundle, {
        actor: actor,
        include_internal_notes: includeInternal,
        report_type: reportType,
        generated_at: generatedAt
      });
    });

    var snapshot = {
      template_version: FIELDOS_REPORT_TEMPLATE_VERSION_,
      report_type: reportType,
      group_by: grouped.group_by,
      generated_at: generatedAt,
      date_from: String(header.date_from || ""),
      date_to: String(header.date_to || ""),
      filters: fieldosScrubReportRecord_(this._parseJson(header.filter_json, {})),
      totals: totals,
      record_count: bundles.length,
      line_count: lineCount,
      estimated_pages: estimatedPages,
      groups: grouped.groups.map(function (group) {
        return {
          group_key: group.group_key,
          group_label: group.group_label,
          group_type: group.group_type,
          record_count: group.record_count,
          line_count: group.line_count,
          job_sheet_ids: group.job_sheet_ids
        };
      }),
      jobs: jobsData,
      omitted_job_data: false
    };
    // No PDF bytes are ever stored — the renderer reads this data shape instead.
    var snapshotJson = JSON.stringify(fieldosScrubReportRecord_(snapshot));
    if (snapshotJson.length > FIELDOS_REPORT_SNAPSHOT_MAX_CHARS_) {
      snapshot.jobs = [];
      snapshot.omitted_job_data = true;
      snapshot.job_index = bundles.map(function (bundle) {
        return {
          job_sheet_id: bundle.job.job_sheet_id,
          completion_id: bundle.completion.completion_id,
          job_date: bundle.job.job_date
        };
      });
      snapshotJson = JSON.stringify(fieldosScrubReportRecord_(snapshot));
    }
    var checksum = fieldosSimpleChecksum_(snapshotJson);
    var singleJobId = bundles.length === 1 ? bundles[0].job.job_sheet_id : "";
    var fileName = fieldosSafeReportFilename_(
      reportType,
      header.date_from || (singleJobId ? bundles[0].job.job_date : ""),
      header.date_to || (singleJobId ? bundles[0].job.job_date : ""),
      singleJobId
    );
    var previous = String(header.status || "");

    var result = Utils.withLock("REPORT_BATCH_" + batchId, 30000, function () {
      var current = self._getBatch(batchId);
      self._checkVersion(current, payload && payload.expected_version);
      self._assertMutable(current, "generated");
      if (String(current.status || "") !== FIELDOS_REPORT_STATUS_.VALIDATED) {
        throw new Error("Validation Error: validate the report batch before generating.");
      }
      var patch = {
        status: FIELDOS_REPORT_STATUS_.GENERATED,
        record_count: bundles.length,
        line_count: lineCount,
        group_count: grouped.groups.length,
        estimated_pages: estimatedPages,
        template_version: FIELDOS_REPORT_TEMPLATE_VERSION_,
        completed_at: generatedAt,
        file_name: fileName,
        checksum: checksum,
        blocker_summary: JSON.stringify([]),
        snapshot_json: snapshotJson,
        version: Number(current.version || 1) + 1
      };
      DB.updateRecord("tbl_report_batches", "report_batch_id", batchId, patch);
      var merged = {};
      Object.keys(current).forEach(function (key) {
        merged[key] = current[key];
      });
      Object.assign(merged, patch);
      return self._assembleBatch(merged);
    });

    this._writeAudit({
      action: "generate_report_data",
      report_batch_id: batchId,
      report_type: reportType,
      group_by: grouped.group_by,
      actor_staff_id: actor.staff_id,
      actor_role: actor.role,
      previous_status: previous,
      new_status: FIELDOS_REPORT_STATUS_.GENERATED,
      record_count: bundles.length,
      line_count: lineCount,
      group_count: grouped.groups.length,
      estimated_pages: estimatedPages,
      template_version: FIELDOS_REPORT_TEMPLATE_VERSION_,
      file_name: fileName,
      checksum: checksum,
      date_from: String(header.date_from || ""),
      date_to: String(header.date_to || ""),
      correlation_id: payload && payload.correlation_id
    });

    result.report_data = snapshot;
    return {
      action: "generate_report_data",
      message: "Report data generated.",
      data: result
    };
  },

  cancelReportBatch: function (payload) {
    var self = this;
    var actor = this._actor(payload);
    this._assertStaffScope(actor);
    var batchId = String((payload && payload.report_batch_id) || "");
    var header = this._getBatch(batchId);
    this._assertBatchAccess(header, actor);
    var previous = String(header.status || "");
    if (previous === FIELDOS_REPORT_STATUS_.GENERATED) {
      throw new Error("Validation Error: Generated report batches cannot be cancelled.");
    }

    var result = Utils.withLock("REPORT_BATCH_" + batchId, 30000, function () {
      var current = self._getBatch(batchId);
      self._checkVersion(current, payload && payload.expected_version);
      if (String(current.status || "") === FIELDOS_REPORT_STATUS_.GENERATED) {
        throw new Error("Validation Error: Generated report batches cannot be cancelled.");
      }
      var patch = {
        status: FIELDOS_REPORT_STATUS_.CANCELLED,
        version: Number(current.version || 1) + 1
      };
      DB.updateRecord("tbl_report_batches", "report_batch_id", batchId, patch);
      var merged = {};
      Object.keys(current).forEach(function (key) {
        merged[key] = current[key];
      });
      Object.assign(merged, patch);
      return self._assembleBatch(merged);
    });

    this._writeAudit({
      action: "cancel_report_batch",
      report_batch_id: batchId,
      report_type: String(header.report_type || ""),
      actor_staff_id: actor.staff_id,
      actor_role: actor.role,
      previous_status: previous,
      new_status: FIELDOS_REPORT_STATUS_.CANCELLED,
      record_count: Number(header.record_count) || 0,
      correlation_id: payload && payload.correlation_id
    });

    return {
      action: "cancel_report_batch",
      message: "Report batch cancelled.",
      data: result
    };
  },

  /**
   * Frozen report data for a Generated batch, for the FastAPI PDF renderer.
   * Returns the snapshot exactly as it was frozen — never PDF bytes. When the
   * snapshot omitted per-job data (oversized batch), omitted_job_data is true and
   * the renderer should page through getJobPdfData per job instead.
   */
  getReportBatchPdfData: function (payload) {
    var actor = this._actor(payload);
    this._assertStaffScope(actor);
    var header = this._getBatch(payload && payload.report_batch_id);
    this._assertBatchAccess(header, actor);
    if (String(header.status || "") !== FIELDOS_REPORT_STATUS_.GENERATED) {
      throw new Error("Validation Error: report has not been generated.");
    }
    var snapshot = this._parseJson(header.snapshot_json, null);
    if (!snapshot) {
      throw new Error("Validation Error: report snapshot missing.");
    }

    this._writeAudit({
      action: "download_report_batch",
      report_batch_id: String(header.report_batch_id || ""),
      report_type: String(header.report_type || ""),
      group_by: String(header.group_by || ""),
      actor_staff_id: actor.staff_id,
      actor_role: actor.role,
      new_status: String(header.status || ""),
      record_count: Number(header.record_count) || 0,
      line_count: Number(header.line_count) || 0,
      estimated_pages: Number(header.estimated_pages) || 0,
      template_version: String(header.template_version || ""),
      file_name: String(header.file_name || ""),
      checksum: String(header.checksum || ""),
      correlation_id: payload && payload.correlation_id
    });

    return {
      action: "get_report_batch_pdf_data",
      message: "OK",
      data: {
        report_batch_id: String(header.report_batch_id || ""),
        report_type: String(header.report_type || ""),
        template_version: String(header.template_version || FIELDOS_REPORT_TEMPLATE_VERSION_),
        file_name: String(header.file_name || ""),
        checksum: String(header.checksum || ""),
        record_count: Number(header.record_count) || 0,
        estimated_pages: Number(header.estimated_pages) || 0,
        report_data: fieldosScrubReportRecord_(snapshot)
      }
    };
  },

  /**
   * Structured single-job data for the FastAPI PDF renderer.
   * Staff actors only ever receive their own labour rows and never machinery,
   * materials or internal notes.
   */
  getJobPdfData: function (payload) {
    var actor = this._actor(payload);
    this._assertStaffScope(actor);
    var p = payload || {};
    var jobSheetId = String(p.job_sheet_id || "").trim();
    var completionId = String(p.completion_id || "").trim();
    if (!jobSheetId && !completionId) {
      throw new Error("Missing required attribute: job_sheet_id or completion_id.");
    }

    var cache = {};
    var bundle = null;
    if (completionId) {
      var rows = DB.findWhere("tbl_job_completions", { completion_id: completionId }) || [];
      if (!rows.length) throw new Error("Not Found: completion " + completionId + " does not exist.");
      bundle = this._loadBundle(rows[0], cache);
    } else {
      var completions = DB.findWhere("tbl_job_completions", { job_sheet_id: jobSheetId }) || [];
      if (completions.length) {
        completions.sort(function (a, b) {
          return String(b.created_at || "").localeCompare(String(a.created_at || ""));
        });
        bundle = this._loadBundle(completions[0], cache);
      } else {
        var jobRow = this._jobRow(jobSheetId, cache);
        if (!jobRow) throw new Error("Not Found: job sheet " + jobSheetId + " does not exist.");
        bundle = this._bundleFromJob(jobRow);
      }
    }

    if (jobSheetId && String(bundle.job.job_sheet_id || "") !== jobSheetId) {
      throw new Error("Validation Error: completion does not belong to job " + jobSheetId + ".");
    }

    if (!actor.is_manager) {
      if (fieldosReportBundleStaffIds_(bundle).indexOf(actor.staff_id) < 0) {
        throw new Error("Forbidden: job is not assigned to this staff member.");
      }
      this._scopeBundleToStaff(bundle, actor.staff_id);
    }

    var reportType = actor.is_manager
      ? String(p.report_type || FIELDOS_REPORT_TYPES_.JOB_SHEET_SUMMARY)
      : FIELDOS_REPORT_TYPES_.STAFF_WORK_REPORT;
    var generatedAt = this._nowIso();
    var pdfData = fieldosBuildJobPdfData_(bundle, {
      actor: actor,
      include_internal_notes: p.include_internal_notes,
      report_type: reportType,
      generated_at: generatedAt
    });
    var fileName = fieldosSafeReportFilename_(
      reportType,
      bundle.job.job_date,
      bundle.job.job_date,
      bundle.job.job_sheet_id
    );

    this._writeAudit({
      action: "get_job_pdf_data",
      report_type: reportType,
      actor_staff_id: actor.staff_id,
      actor_role: actor.role,
      job_sheet_id: bundle.job.job_sheet_id,
      completion_id: bundle.completion.completion_id,
      record_count: 1,
      line_count: fieldosReportBundleLineCount_(bundle),
      template_version: FIELDOS_REPORT_TEMPLATE_VERSION_,
      file_name: fileName,
      correlation_id: p.correlation_id
    });

    return {
      action: "get_job_pdf_data",
      message: "OK",
      job_sheet_id: bundle.job.job_sheet_id,
      data: {
        report_type: reportType,
        template_version: FIELDOS_REPORT_TEMPLATE_VERSION_,
        file_name: fileName,
        generated_at: generatedAt,
        pdf_data: pdfData
      }
    };
  }
};
