/**
 * Phase 3D — Completion dashboard + export batch gateway.
 * Depends on: CompletionExportHelpers.js, JobCompletion.js, JobCompletionHelpers.js,
 * Database.js, Repositories.js, Utilities.js, FieldOSGateway role helpers.
 */

var FIELDOS_EXPORT_BATCH_HEADERS_ = [
  "export_batch_id",
  "export_type",
  "date_from",
  "date_to",
  "filter_json",
  "status",
  "record_count",
  "created_by",
  "created_at",
  "completed_at",
  "file_name",
  "checksum",
  "notes",
  "snapshot_json",
  "version"
];

var FIELDOS_EXPORT_ITEM_HEADERS_ = [
  "export_batch_item_id",
  "export_batch_id",
  "job_sheet_id",
  "completion_id",
  "item_status",
  "blocker_summary",
  "created_at"
];

var FieldOSCompletionExports = {
  _assertManager: function (actorRole) {
    if (!fieldosIsManagerOrAdmin_(actorRole)) {
      throw new Error("Forbidden: manager or admin role required.");
    }
  },

  _nowIso: function () {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX");
  },

  _tablesExist: function () {
    try {
      DB.getSheet("tbl_export_batches");
      DB.getSheet("tbl_export_batch_items");
      return true;
    } catch (e) {
      return false;
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

  _jobDisplay: function (job) {
    job = job || {};
    return {
      job_sheet_id: String(job.job_sheet_id || ""),
      // Primary dashboard date = job sheet date (not finalised_at).
      job_date: fieldosNormaliseCalendarDate_(job.date || job.job_date) || "",
      customer_name: String(job.customer_name || job.customer || ""),
      project_name: String(job.project_name || job.project_id || ""),
      approval_status: String(job.approval_status || ""),
      processing_status: String(job.processing_status || ""),
      assigned_staff_id: String(job.staff_id || job.assigned_staff_id || "")
    };
  },

  _loadCompletionBundle: function (completionRow) {
    var completionId = String(completionRow.completion_id || "");
    var jobSheetId = String(completionRow.job_sheet_id || "");
    var job = JobSheetRepository.findById(jobSheetId) || { job_sheet_id: jobSheetId };
    var labour = DB.findWhere("tbl_job_labour", { completion_id: completionId }) || [];
    var machinery = DB.findWhere("tbl_job_machinery", { completion_id: completionId }) || [];
    var materials = DB.findWhere("tbl_job_materials", { completion_id: completionId }) || [];
    var completion = {
      completion_id: completionId,
      job_sheet_id: jobSheetId,
      completion_status: String(completionRow.completion_status || ""),
      work_summary: String(completionRow.work_summary || ""),
      invoice_description: String(completionRow.invoice_description || ""),
      total_labour_hours: Number(completionRow.total_labour_hours) || 0,
      total_travel_hours: Number(completionRow.total_travel_hours) || 0,
      total_machinery_hours: Number(completionRow.total_machinery_hours) || 0,
      billable_labour_hours: Number(completionRow.billable_labour_hours) || 0,
      non_billable_labour_hours: Number(completionRow.non_billable_labour_hours) || 0,
      variations: FieldOSJobCompletion._parseList(completionRow.variations),
      warnings: FieldOSJobCompletion._parseList(completionRow.warnings),
      warning_resolutions: FieldOSJobCompletion._parseObjectList(completionRow.warning_resolutions),
      finalised_by: String(completionRow.finalised_by || ""),
      finalised_at: (function () {
        var raw = completionRow.finalised_at;
        if (raw == null || raw === "") return null;
        if (fieldosIsDateObject_(raw)) {
          try {
            if (typeof Utilities !== "undefined" && Utilities.formatDate) {
              return Utilities.formatDate(raw, fieldosSpreadsheetTimeZone_(), "yyyy-MM-dd'T'HH:mm:ssXXX");
            }
          } catch (eFin) {
            /* fall through */
          }
          return raw.toISOString();
        }
        return String(raw);
      })(),
      finalised_date: fieldosNormaliseCalendarDate_(completionRow.finalised_at) || "",
      version: Number(completionRow.version) || 1,
      job_approval_status: String(job.approval_status || "")
    };
    var labourApi = labour.map(FieldOSJobCompletion._toApiLabour.bind(FieldOSJobCompletion));
    var machineryApi = machinery.map(FieldOSJobCompletion._toApiMachinery.bind(FieldOSJobCompletion));
    var materialsApi = materials.map(FieldOSJobCompletion._toApiMaterial.bind(FieldOSJobCompletion));
    var readiness = fieldosComputeExportReadiness_(completion, job, labourApi, machineryApi, materialsApi);
    return {
      completion: completion,
      job: this._jobDisplay(job),
      labour_entries: labourApi,
      machinery_entries: machineryApi,
      material_entries: materialsApi,
      readiness: readiness
    };
  },

  _matchesFilters: function (bundle, filters) {
    var f = filters || {};
    var c = bundle.completion;
    var job = bundle.job;
    // Primary inclusion date = normalised job_date (job reporting).
    var jobDate = fieldosNormaliseCalendarDate_(job.job_date);
    var dateFrom = fieldosNormaliseCalendarDate_(f.date_from);
    var dateTo = fieldosNormaliseCalendarDate_(f.date_to);
    if (dateFrom && jobDate && jobDate < dateFrom) return false;
    if (dateTo && jobDate && jobDate > dateTo) return false;
    // Optional dedicated finalised-date filter (does not replace job_date).
    if (f.finalised_from || f.finalised_to) {
      var finDate = fieldosNormaliseCalendarDate_(c.finalised_at || c.finalised_date);
      var finFrom = fieldosNormaliseCalendarDate_(f.finalised_from);
      var finTo = fieldosNormaliseCalendarDate_(f.finalised_to);
      if (finFrom && (!finDate || finDate < finFrom)) return false;
      if (finTo && (!finDate || finDate > finTo)) return false;
    }
    if (f.completion_status && String(c.completion_status) !== String(f.completion_status)) return false;
    if (f.approval_status && String(job.approval_status) !== String(f.approval_status)) return false;
    if (f.customer) {
      var cust = String(job.customer_name || "").toLowerCase();
      if (cust.indexOf(String(f.customer).toLowerCase()) < 0) return false;
    }
    if (f.project) {
      var proj = String(job.project_name || "").toLowerCase();
      if (proj.indexOf(String(f.project).toLowerCase()) < 0) return false;
    }
    if (f.assigned_staff_id && String(job.assigned_staff_id) !== String(f.assigned_staff_id)) return false;
    if (f.billable === true || f.billable === "true" || f.billable === "TRUE") {
      if (!(Number(c.billable_labour_hours) > 0)) return false;
    }
    if (f.billable === false || f.billable === "false" || f.billable === "FALSE") {
      if (Number(c.billable_labour_hours) > 0) return false;
    }
    if (f.q) {
      var q = String(f.q).toLowerCase();
      var blob = [
        c.job_sheet_id,
        c.work_summary,
        c.invoice_description,
        job.customer_name,
        job.project_name
      ]
        .join(" ")
        .toLowerCase();
      if (blob.indexOf(q) < 0) return false;
    }
    return true;
  },

  _exclusionReasons: function (bundle, filters) {
    var reasons = [];
    var f = filters || {};
    var c = bundle.completion;
    var job = bundle.job;
    var jobDate = fieldosNormaliseCalendarDate_(job.job_date);
    var dateFrom = fieldosNormaliseCalendarDate_(f.date_from);
    var dateTo = fieldosNormaliseCalendarDate_(f.date_to);
    if (dateFrom && jobDate && jobDate < dateFrom) {
      reasons.push("job_date " + jobDate + " is before date_from " + dateFrom);
    }
    if (dateTo && jobDate && jobDate > dateTo) {
      reasons.push("job_date " + jobDate + " is after date_to " + dateTo);
    }
    if (!jobDate && (dateFrom || dateTo)) {
      reasons.push("job_date missing or unparseable (date filter skipped when blank)");
    }
    if (f.completion_status && String(c.completion_status) !== String(f.completion_status)) {
      reasons.push("completion_status mismatch");
    }
    if (f.approval_status && String(job.approval_status) !== String(f.approval_status)) {
      reasons.push("approval_status mismatch");
    }
    return reasons;
  },

  _dashboardItems: function (filters) {
    var rows = DB.findAll("tbl_job_completions") || [];
    var items = [];
    rows.forEach(
      function (row) {
        var bundle = this._loadCompletionBundle(row);
        if (!this._matchesFilters(bundle, filters)) return;
        items.push({
          job_date: bundle.job.job_date,
          job_sheet_id: bundle.completion.job_sheet_id,
          completion_id: bundle.completion.completion_id,
          customer_name: bundle.job.customer_name,
          project_name: bundle.job.project_name,
          completion_status: bundle.completion.completion_status,
          approval_status: bundle.job.approval_status,
          finalised_by: bundle.completion.finalised_by,
          finalised_at: bundle.completion.finalised_at,
          total_labour_hours: bundle.completion.total_labour_hours,
          total_travel_hours: bundle.completion.total_travel_hours,
          total_machinery_hours: bundle.completion.total_machinery_hours,
          billable_labour_hours: bundle.completion.billable_labour_hours,
          non_billable_labour_hours: bundle.completion.non_billable_labour_hours,
          unresolved_warning_count: bundle.readiness.warning_count,
          invoice_ready: bundle.readiness.invoice_ready,
          payroll_ready: bundle.readiness.payroll_ready,
          export_status: bundle.completion.completion_status === FIELDOS_COMPLETION_STATUSES_.FINALISED
            ? bundle.readiness.invoice_ready || bundle.readiness.payroll_ready
              ? "Ready"
              : "Blocked"
            : "Not finalised",
          version: bundle.completion.version
        });
      }.bind(this)
    );
    items.sort(function (a, b) {
      var ak = String(a.job_date || "") + "|" + String(a.job_sheet_id || "");
      var bk = String(b.job_date || "") + "|" + String(b.job_sheet_id || "");
      return ak < bk ? 1 : ak > bk ? -1 : 0;
    });
    return items;
  },

  _summarise: function (items) {
    var summary = {
      job_count: items.length,
      finalised_jobs: 0,
      draft_or_reopened_jobs: 0,
      total_labour_hours: 0,
      total_travel_hours: 0,
      total_machinery_hours: 0,
      billable_labour_hours: 0,
      non_billable_labour_hours: 0,
      unresolved_warnings: 0,
      jobs_ready_for_invoice_export: 0,
      jobs_ready_for_payroll_export: 0
    };
    items.forEach(function (row) {
      if (row.completion_status === FIELDOS_COMPLETION_STATUSES_.FINALISED) summary.finalised_jobs += 1;
      if (
        row.completion_status === FIELDOS_COMPLETION_STATUSES_.DRAFT ||
        row.completion_status === FIELDOS_COMPLETION_STATUSES_.REOPENED
      ) {
        summary.draft_or_reopened_jobs += 1;
      }
      summary.total_labour_hours += Number(row.total_labour_hours) || 0;
      summary.total_travel_hours += Number(row.total_travel_hours) || 0;
      summary.total_machinery_hours += Number(row.total_machinery_hours) || 0;
      summary.billable_labour_hours += Number(row.billable_labour_hours) || 0;
      summary.non_billable_labour_hours += Number(row.non_billable_labour_hours) || 0;
      summary.unresolved_warnings += Number(row.unresolved_warning_count) || 0;
      if (row.invoice_ready) summary.jobs_ready_for_invoice_export += 1;
      if (row.payroll_ready) summary.jobs_ready_for_payroll_export += 1;
    });
    ["total_labour_hours", "total_travel_hours", "total_machinery_hours", "billable_labour_hours", "non_billable_labour_hours"].forEach(
      function (k) {
        summary[k] = Math.round(summary[k] * 100) / 100;
      }
    );
    return summary;
  },

  _writeAudit: function (meta) {
    try {
      SyncRepository.create({
        record_id: meta.export_batch_id || "EXPORT",
        target_system: "FieldOS_Export",
        status: "Success",
        request_payload: JSON.stringify(fieldosExportAuditPayload_(meta)),
        response_payload: meta.new_status || "",
        timestamp: new Date()
      });
    } catch (err) {
      Logger.log("Export audit write failed: " + err);
    }
  },

  _getBatch: function (exportBatchId) {
    var rows = DB.findWhere("tbl_export_batches", { export_batch_id: exportBatchId }) || [];
    if (!rows.length) throw new Error("Export batch not found.");
    return rows[0];
  },

  _checkVersion: function (header, expectedVersion) {
    if (expectedVersion == null || expectedVersion === "") return;
    if (Number(header.version || 0) !== Number(expectedVersion)) {
      throw new Error("Conflict: export batch version changed since you loaded this record.");
    }
  },

  _assembleBatch: function (header) {
    var items = DB.findWhere("tbl_export_batch_items", { export_batch_id: header.export_batch_id }) || [];
    items.sort(function (a, b) {
      return String(a.job_sheet_id || "").localeCompare(String(b.job_sheet_id || ""));
    });
    return {
      export_batch: {
        export_batch_id: String(header.export_batch_id || ""),
        export_type: String(header.export_type || ""),
        date_from: String(header.date_from || ""),
        date_to: String(header.date_to || ""),
        filter_json: this._parseJson(header.filter_json, {}),
        status: String(header.status || ""),
        record_count: Number(header.record_count) || 0,
        created_by: String(header.created_by || ""),
        created_at: header.created_at || null,
        completed_at: header.completed_at || null,
        file_name: String(header.file_name || ""),
        checksum: String(header.checksum || ""),
        notes: String(header.notes || ""),
        version: Number(header.version) || 1
      },
      items: items.map(function (row) {
        return {
          export_batch_item_id: String(row.export_batch_item_id || ""),
          export_batch_id: String(row.export_batch_id || ""),
          job_sheet_id: String(row.job_sheet_id || ""),
          completion_id: String(row.completion_id || ""),
          item_status: String(row.item_status || ""),
          blocker_summary: String(row.blocker_summary || ""),
          created_at: row.created_at || null
        };
      })
    };
  },

  listCompletionDashboard: function (payload) {
    this._assertManager(payload.actor_role);
    var range = fieldosDefaultDashboardRange_();
    var filters = {
      date_from: payload.date_from || range.date_from,
      date_to: payload.date_to || range.date_to,
      completion_status: payload.completion_status || "",
      approval_status: payload.approval_status || "",
      customer: payload.customer || "",
      project: payload.project || "",
      assigned_staff_id: payload.assigned_staff_id || "",
      billable: payload.billable,
      q: payload.q || ""
    };
    var items = this._dashboardItems(filters);
    return {
      action: "list_completion_dashboard",
      message: "OK",
      data: { items: items, filters: filters, summary: this._summarise(items) }
    };
  },

  getCompletionDashboardSummary: function (payload) {
    var listed = this.listCompletionDashboard(payload);
    return {
      action: "get_completion_dashboard_summary",
      message: "OK",
      data: { summary: listed.data.summary, filters: listed.data.filters }
    };
  },

  getCompletionExportReadiness: function (payload) {
    this._assertManager(payload.actor_role);
    var completionId = String(payload.completion_id || "");
    if (!completionId) throw new Error("Missing required attribute: completion_id.");
    var rows = DB.findWhere("tbl_job_completions", { completion_id: completionId }) || [];
    if (!rows.length) throw new Error("Completion not found.");
    var bundle = this._loadCompletionBundle(rows[0]);
    return {
      action: "get_completion_export_readiness",
      message: "OK",
      data: {
        completion_id: completionId,
        job_sheet_id: bundle.completion.job_sheet_id,
        readiness: bundle.readiness
      }
    };
  },

  createExportBatch: function (payload) {
    this._assertManager(payload.actor_role);
    if (!this._tablesExist()) {
      throw new Error("Validation Error: export tables missing — run migrateSchemaForCompletionExports().");
    }
    var exportType = String(payload.export_type || FIELDOS_EXPORT_TYPES_.COMPLETION_SUMMARY_CSV);
    var validTypes = Object.keys(FIELDOS_EXPORT_TYPES_).map(function (k) {
      return FIELDOS_EXPORT_TYPES_[k];
    });
    if (validTypes.indexOf(exportType) < 0) {
      throw new Error("Validation Error: unsupported export_type.");
    }
    var range = fieldosDefaultDashboardRange_();
    var filters = payload.filters || {
      date_from: payload.date_from || range.date_from,
      date_to: payload.date_to || range.date_to
    };
    var actor = String(payload.actor_identity || payload.staff_id || "");
    var now = this._nowIso();
    var dashboard = this._dashboardItems(filters);
    var selectedIds = Array.isArray(payload.completion_ids) ? payload.completion_ids.map(String) : null;
    var selected = dashboard.filter(function (row) {
      if (selectedIds && selectedIds.indexOf(String(row.completion_id)) < 0) return false;
      return true;
    });
    if (!selected.length) throw new Error("Validation Error: no completions match the export filters.");

    var batchId = DB.generateId("EXP");
    var header = {
      export_batch_id: batchId,
      export_type: exportType,
      date_from: String(filters.date_from || range.date_from),
      date_to: String(filters.date_to || range.date_to),
      filter_json: JSON.stringify(filters),
      status: FIELDOS_EXPORT_STATUSES_.DRAFT,
      record_count: selected.length,
      created_by: actor,
      created_at: now,
      completed_at: "",
      file_name: "",
      checksum: "",
      notes: String(payload.notes || ""),
      snapshot_json: "",
      version: 1
    };
    DB.insertRecord("tbl_export_batches", header);
    selected.forEach(
      function (row) {
        DB.insertRecord("tbl_export_batch_items", {
          export_batch_item_id: DB.generateId("EXI"),
          export_batch_id: batchId,
          job_sheet_id: row.job_sheet_id,
          completion_id: row.completion_id,
          item_status: "Pending",
          blocker_summary: "",
          created_at: now
        });
      }.bind(this)
    );
    this._writeAudit({
      action: "create_export_batch",
      export_batch_id: batchId,
      export_type: exportType,
      actor_staff_id: payload.staff_id,
      actor_role: fieldosNormalizeRole_(payload.actor_role),
      new_status: FIELDOS_EXPORT_STATUSES_.DRAFT,
      record_count: selected.length,
      date_from: header.date_from,
      date_to: header.date_to
    });
    return {
      action: "create_export_batch",
      message: "Export batch created.",
      data: this._assembleBatch(header)
    };
  },

  listExportBatches: function (payload) {
    this._assertManager(payload.actor_role);
    if (!this._tablesExist()) {
      return { action: "list_export_batches", message: "OK", data: { items: [] } };
    }
    var rows = DB.findAll("tbl_export_batches") || [];
    rows.sort(function (a, b) {
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });
    return {
      action: "list_export_batches",
      message: "OK",
      data: {
        items: rows.map(function (row) {
          return {
            export_batch_id: String(row.export_batch_id || ""),
            export_type: String(row.export_type || ""),
            status: String(row.status || ""),
            record_count: Number(row.record_count) || 0,
            date_from: String(row.date_from || ""),
            date_to: String(row.date_to || ""),
            created_at: row.created_at || null,
            file_name: String(row.file_name || ""),
            version: Number(row.version) || 1
          };
        })
      }
    };
  },

  getExportBatch: function (payload) {
    this._assertManager(payload.actor_role);
    var header = this._getBatch(String(payload.export_batch_id || ""));
    return {
      action: "get_export_batch",
      message: "OK",
      data: this._assembleBatch(header)
    };
  },

  validateExportBatch: function (payload) {
    this._assertManager(payload.actor_role);
    var self = this;
    var batchId = String(payload.export_batch_id || "");
    return Utils.withLock("EXPORT_BATCH_" + batchId, 30000, function () {
      var header = self._getBatch(batchId);
      self._checkVersion(header, payload.expected_version);
      if (String(header.status) === FIELDOS_EXPORT_STATUSES_.EXPORTED) {
        throw new Error("Validation Error: Exported batches are immutable.");
      }
      if (String(header.status) === FIELDOS_EXPORT_STATUSES_.CANCELLED) {
        throw new Error("Validation Error: Cancelled batches cannot be validated.");
      }
      var items = DB.findWhere("tbl_export_batch_items", { export_batch_id: batchId }) || [];
      var allOk = true;
      items.forEach(function (item) {
        var rows = DB.findWhere("tbl_job_completions", { completion_id: item.completion_id }) || [];
        if (!rows.length) {
          allOk = false;
          DB.updateRecord("tbl_export_batch_items", "export_batch_item_id", item.export_batch_item_id, {
            item_status: "Blocked",
            blocker_summary: "Completion not found."
          });
          return;
        }
        var bundle = self._loadCompletionBundle(rows[0]);
        var readiness = bundle.readiness;
        var blockers = [];
        var exportType = String(header.export_type || "");
        if (exportType === FIELDOS_EXPORT_TYPES_.INVOICE_CSV) blockers = readiness.invoice_blockers;
        else if (exportType === FIELDOS_EXPORT_TYPES_.PAYROLL_CSV) blockers = readiness.payroll_blockers;
        else if (exportType === FIELDOS_EXPORT_TYPES_.MACHINERY_CSV || exportType === FIELDOS_EXPORT_TYPES_.MATERIALS_CSV) {
          if (bundle.completion.completion_status !== FIELDOS_COMPLETION_STATUSES_.FINALISED) {
            blockers = ["Completion is not Finalised."];
          }
        } else {
          blockers = readiness.invoice_blockers.length ? readiness.invoice_blockers : readiness.payroll_blockers;
          // Summary CSV may include non-ready rows; mark Ready/Blocked but do not fail whole batch.
          blockers = [];
        }
        var status = blockers.length ? "Blocked" : "Ready";
        if (blockers.length) allOk = false;
        DB.updateRecord("tbl_export_batch_items", "export_batch_item_id", item.export_batch_item_id, {
          item_status: status,
          blocker_summary: blockers.join("; ")
        });
      });
      var previous = String(header.status || "");
      var nextStatus =
        String(header.export_type) === FIELDOS_EXPORT_TYPES_.COMPLETION_SUMMARY_CSV || allOk
          ? FIELDOS_EXPORT_STATUSES_.VALIDATED
          : FIELDOS_EXPORT_STATUSES_.DRAFT;
      var patch = {
        status: nextStatus,
        version: Number(header.version || 1) + 1
      };
      DB.updateRecord("tbl_export_batches", "export_batch_id", batchId, patch);
      Object.assign(header, patch);
      self._writeAudit({
        action: "validate_export_batch",
        export_batch_id: batchId,
        export_type: header.export_type,
        actor_staff_id: payload.staff_id,
        actor_role: fieldosNormalizeRole_(payload.actor_role),
        previous_status: previous,
        new_status: nextStatus,
        record_count: items.length
      });
      if (nextStatus !== FIELDOS_EXPORT_STATUSES_.VALIDATED && String(header.export_type) !== FIELDOS_EXPORT_TYPES_.COMPLETION_SUMMARY_CSV) {
        // Still return assembled batch with blockers for UI.
      }
      return {
        action: "validate_export_batch",
        message: nextStatus === FIELDOS_EXPORT_STATUSES_.VALIDATED ? "Batch validated." : "Batch has blockers.",
        data: self._assembleBatch(header)
      };
    });
  },

  generateExportBatch: function (payload) {
    this._assertManager(payload.actor_role);
    var self = this;
    var batchId = String(payload.export_batch_id || "");
    return Utils.withLock("EXPORT_BATCH_" + batchId, 30000, function () {
      var header = self._getBatch(batchId);
      self._checkVersion(header, payload.expected_version);
      if (String(header.status) === FIELDOS_EXPORT_STATUSES_.EXPORTED) {
        throw new Error("Validation Error: Exported batches are immutable — create a new batch to regenerate.");
      }
      if (String(header.status) === FIELDOS_EXPORT_STATUSES_.CANCELLED) {
        throw new Error("Validation Error: Cancelled batches cannot be generated.");
      }
      if (String(header.status) !== FIELDOS_EXPORT_STATUSES_.VALIDATED) {
        throw new Error("Validation Error: validate the batch before generating.");
      }
      var itemRows = DB.findWhere("tbl_export_batch_items", { export_batch_id: batchId }) || [];
      var bundles = [];
      itemRows.forEach(function (item) {
        if (String(item.item_status) === "Blocked" && String(header.export_type) !== FIELDOS_EXPORT_TYPES_.COMPLETION_SUMMARY_CSV) {
          throw new Error("Validation Error: batch still has blocked items.");
        }
        var rows = DB.findWhere("tbl_job_completions", { completion_id: item.completion_id }) || [];
        if (!rows.length) throw new Error("Validation Error: completion missing for batch item.");
        bundles.push(self._loadCompletionBundle(rows[0]));
      });
      // Release-sensitive work: build CSV after reading, still under lock briefly for atomic status flip.
      var built = fieldosBuildCsvForType_(String(header.export_type), bundles);
      var fileName = fieldosSafeExportFilename_(header.export_type, header.date_from, header.date_to);
      var checksum = fieldosSimpleChecksum_(built.csv);
      var previous = String(header.status || "");
      var patch = {
        status: FIELDOS_EXPORT_STATUSES_.EXPORTED,
        completed_at: self._nowIso(),
        file_name: fileName,
        checksum: checksum,
        snapshot_json: JSON.stringify({ headers: built.headers, rows: built.rows }),
        record_count: built.rows.length,
        version: Number(header.version || 1) + 1
      };
      DB.updateRecord("tbl_export_batches", "export_batch_id", batchId, patch);
      Object.assign(header, patch);
      self._writeAudit({
        action: "generate_export_batch",
        export_batch_id: batchId,
        export_type: header.export_type,
        actor_staff_id: payload.staff_id,
        actor_role: fieldosNormalizeRole_(payload.actor_role),
        previous_status: previous,
        new_status: FIELDOS_EXPORT_STATUSES_.EXPORTED,
        record_count: built.rows.length,
        checksum: checksum,
        date_from: header.date_from,
        date_to: header.date_to
      });
      var assembled = self._assembleBatch(header);
      assembled.csv_preview_rows = Math.min(5, built.rows.length);
      assembled.checksum = checksum;
      assembled.file_name = fileName;
      return {
        action: "generate_export_batch",
        message: "Export generated.",
        data: assembled
      };
    });
  },

  getExportBatchCsv: function (payload) {
    this._assertManager(payload.actor_role);
    var header = this._getBatch(String(payload.export_batch_id || ""));
    if (String(header.status) !== FIELDOS_EXPORT_STATUSES_.EXPORTED) {
      throw new Error("Validation Error: batch has not been generated.");
    }
    var snapshot = this._parseJson(header.snapshot_json, null);
    if (!snapshot || !snapshot.headers) {
      throw new Error("Validation Error: export snapshot missing.");
    }
    var csv = fieldosBuildCsv_(snapshot.headers, snapshot.rows || []);
    this._writeAudit({
      action: "download_export_batch",
      export_batch_id: header.export_batch_id,
      export_type: header.export_type,
      actor_staff_id: payload.staff_id,
      actor_role: fieldosNormalizeRole_(payload.actor_role),
      new_status: header.status,
      record_count: Number(header.record_count) || 0,
      checksum: String(header.checksum || "")
    });
    return {
      action: "get_export_batch_csv",
      message: "OK",
      data: {
        export_batch_id: header.export_batch_id,
        file_name: String(header.file_name || "export.csv"),
        content_type: "text/csv; charset=utf-8",
        checksum: String(header.checksum || ""),
        csv_text: csv
      }
    };
  },

  cancelExportBatch: function (payload) {
    this._assertManager(payload.actor_role);
    var self = this;
    var batchId = String(payload.export_batch_id || "");
    return Utils.withLock("EXPORT_BATCH_" + batchId, 30000, function () {
      var header = self._getBatch(batchId);
      self._checkVersion(header, payload.expected_version);
      if (String(header.status) === FIELDOS_EXPORT_STATUSES_.EXPORTED) {
        throw new Error("Validation Error: Exported batches cannot be cancelled.");
      }
      var previous = String(header.status || "");
      var patch = {
        status: FIELDOS_EXPORT_STATUSES_.CANCELLED,
        version: Number(header.version || 1) + 1
      };
      DB.updateRecord("tbl_export_batches", "export_batch_id", batchId, patch);
      Object.assign(header, patch);
      self._writeAudit({
        action: "cancel_export_batch",
        export_batch_id: batchId,
        export_type: header.export_type,
        actor_staff_id: payload.staff_id,
        actor_role: fieldosNormalizeRole_(payload.actor_role),
        previous_status: previous,
        new_status: FIELDOS_EXPORT_STATUSES_.CANCELLED,
        record_count: Number(header.record_count) || 0
      });
      return {
        action: "cancel_export_batch",
        message: "Batch cancelled.",
        data: self._assembleBatch(header)
      };
    });
  }
};

/**
 * Read-only dashboard date-filter diagnostic for a job sheet.
 * Usage: testFieldOSCompletionDashboardDiagnostic('21759f5d')
 * Optional: testFieldOSCompletionDashboardDiagnostic('21759f5d', '2026-05-01', '2026-07-26')
 * Does not log transcript, notes, Drive IDs, or secrets.
 */
function testFieldOSCompletionDashboardDiagnostic(jobSheetId, dateFromOpt, dateToOpt) {
  var id = String(jobSheetId || "").trim();
  if (!id) {
    Logger.log("testFieldOSCompletionDashboardDiagnostic: pass a job_sheet_id, e.g. '21759f5d'.");
    return { ok: false, error: "job_sheet_id required" };
  }
  var range = fieldosDefaultDashboardRange_();
  var dateFrom = fieldosNormaliseCalendarDate_(dateFromOpt || "2026-05-01") || range.date_from;
  var dateTo = fieldosNormaliseCalendarDate_(dateToOpt || "2026-07-26") || range.date_to;
  var filters = { date_from: dateFrom, date_to: dateTo };

  var job = JobSheetRepository.findById(id) || null;
  var completions = (DB.findWhere("tbl_job_completions", { job_sheet_id: id }) || []).slice();
  var report = {
    diagnostic: "testFieldOSCompletionDashboardDiagnostic",
    job_sheet_id: id,
    primary_date_field: "job_date",
    date_from: dateFrom,
    date_to: dateTo,
    spreadsheet_timezone: fieldosSpreadsheetTimeZone_(),
    job_found: !!job,
    completion_count: completions.length,
    candidates: []
  };

  if (!job) {
    report.inclusion_result = false;
    report.exclusion_reasons = ["job sheet not found"];
    Logger.log(JSON.stringify(report, null, 2));
    return report;
  }

  var rawJobDate = job.date != null && job.date !== "" ? job.date : job.job_date;
  var jobDateDesc = fieldosDescribeCalendarDate_(rawJobDate);
  report.raw_candidate_date_type = jobDateDesc.type;
  report.raw_candidate_date_preview = fieldosIsDateObject_(rawJobDate)
    ? "[object Date]"
    : String(rawJobDate == null ? "" : rawJobDate).slice(0, 80);
  report.normalised_candidate_date = jobDateDesc.normalised;
  report.passes_date_filter = fieldosDateInInclusiveRange_(jobDateDesc.normalised, dateFrom, dateTo);

  if (!completions.length) {
    report.inclusion_result = false;
    report.exclusion_reasons = ["no completion rows for job"];
    Logger.log(JSON.stringify(report, null, 2));
    return report;
  }

  completions.forEach(function (row) {
    var bundle = FieldOSCompletionExports._loadCompletionBundle(row);
    var labourDates = (bundle.labour_entries || []).map(function (lab) {
      return {
        labour_id: lab.labour_id || "",
        work_date: lab.work_date || ""
      };
    });
    var reasons = FieldOSCompletionExports._exclusionReasons(bundle, filters);
    var included = FieldOSCompletionExports._matchesFilters(bundle, filters);
    report.candidates.push({
      completion_id: bundle.completion.completion_id,
      completion_status: bundle.completion.completion_status,
      approval_status: bundle.job.approval_status,
      job_date_normalised: bundle.job.job_date,
      finalised_date: fieldosNormaliseCalendarDate_(bundle.completion.finalised_at) || "",
      labour_work_dates: labourDates,
      passes_date_filter: fieldosDateInInclusiveRange_(bundle.job.job_date, dateFrom, dateTo),
      inclusion_result: included,
      exclusion_reasons: reasons
    });
  });

  report.inclusion_result = report.candidates.some(function (c) {
    return c.inclusion_result;
  });
  report.exclusion_reasons = report.inclusion_result
    ? []
    : report.candidates.reduce(function (acc, c) {
        return acc.concat(c.exclusion_reasons || []);
      }, []);

  Logger.log(JSON.stringify(report, null, 2));
  return report;
}
