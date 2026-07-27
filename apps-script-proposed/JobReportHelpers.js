/**
 * Phase 3F — pure report data helpers.
 * Safe for Apps Script and Node tests (no SpreadsheetApp / Drive / LockService).
 *
 * Report data is display-only:
 * - Quantities, durations and hours are never derived or invented here.
 * - Task lines come from manager-reviewed text only, never from ai_transcript.
 * - Forbidden keys (transcript, Drive identifiers, tokens, secrets) are scrubbed
 *   out of every payload that leaves this layer.
 */

var FIELDOS_REPORT_TYPES_ = {
  JOB_SHEET_SUMMARY: "Job Sheet Summary",
  STAFF_WORK_REPORT: "Staff Work Report",
  CLIENT_JOB_REPORT: "Client Job Report",
  PROJECT_ACTIVITY_REPORT: "Project Activity Report",
  COMPLETION_REGISTER: "Completion Register"
};

var FIELDOS_REPORT_STATUS_ = {
  DRAFT: "Draft",
  VALIDATED: "Validated",
  GENERATED: "Generated",
  CANCELLED: "Cancelled"
};

/** Bump when the PDF data contract changes in a way renderers must know about. */
var FIELDOS_REPORT_TEMPLATE_VERSION_ = "3F.1";

var FIELDOS_REPORT_TASK_SOURCES_ = {
  MANAGER_REVIEW_ITEMS: "manager_review_items",
  VARIATIONS: "variations"
};

/** Batch size ceiling — reports beyond this must be narrowed by filters. */
var FIELDOS_REPORT_MAX_RECORDS_ = 200;

/** Frozen snapshots live in one sheet cell; stay well under the 50k cell limit. */
var FIELDOS_REPORT_SNAPSHOT_MAX_CHARS_ = 45000;

/**
 * Key fragments that must never appear in report payloads, snapshots or audits.
 * Matched as case-insensitive substrings of the key name.
 */
var FIELDOS_REPORT_FORBIDDEN_KEY_PATTERNS_ = [
  "transcript",
  "drive",
  "token",
  "secret",
  "password",
  "credential",
  "authorization",
  "api_key",
  "apikey",
  "bearer",
  "private_key",
  "signature",
  "cookie",
  "webhook",
  "openai",
  "whisper",
  "file_url",
  "file_id",
  "raw_payload",
  "request_payload",
  "response_payload"
];

function fieldosReportForbiddenKeys_() {
  return FIELDOS_REPORT_FORBIDDEN_KEY_PATTERNS_.slice();
}

function fieldosReportKeyForbidden_(key) {
  var k = String(key == null ? "" : key).toLowerCase();
  if (!k) return false;
  for (var i = 0; i < FIELDOS_REPORT_FORBIDDEN_KEY_PATTERNS_.length; i++) {
    if (k.indexOf(FIELDOS_REPORT_FORBIDDEN_KEY_PATTERNS_[i]) >= 0) return true;
  }
  return false;
}

function fieldosReportIsDateObject_(value) {
  return Object.prototype.toString.call(value) === "[object Date]";
}

/**
 * Deep copy with forbidden keys removed. Arrays and plain objects are walked;
 * Dates and primitives pass through unchanged.
 */
function fieldosScrubReportRecord_(value, depth) {
  var level = Number(depth) || 0;
  if (level > 12) return null;
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.map(function (item) {
      return fieldosScrubReportRecord_(item, level + 1);
    });
  }
  if (typeof value !== "object") return value;
  if (fieldosReportIsDateObject_(value)) return value;
  var out = {};
  Object.keys(value).forEach(function (key) {
    if (fieldosReportKeyForbidden_(key)) return;
    out[key] = fieldosScrubReportRecord_(value[key], level + 1);
  });
  return out;
}

/**
 * Split a stored text/list field into trimmed display lines.
 * Accepts arrays, JSON arrays and newline-separated text; strips bullet markers.
 */
function fieldosSplitReportLines_(raw) {
  if (raw == null || raw === "") return [];
  var list = [];
  if (Array.isArray(raw)) {
    list = raw.slice();
  } else if (typeof raw === "object") {
    return [];
  } else {
    var text = String(raw);
    var parsed = null;
    if (/^\s*\[/.test(text)) {
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        parsed = null;
      }
    }
    list = Array.isArray(parsed) ? parsed : text.split(/\r?\n+/);
  }
  var out = [];
  list.forEach(function (entry) {
    var line;
    if (entry == null) line = "";
    else if (typeof entry === "object") {
      line = String(entry.description || entry.text || entry.item || "");
    } else {
      line = String(entry);
    }
    line = line
      .replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line) out.push(line);
  });
  return out;
}

function fieldosReportTaskRow_(description, category, status, sourceType) {
  return {
    description: String(description || ""),
    category: String(category || ""),
    status: String(status || ""),
    // Report rows never carry derived numbers — the PDF prints what was recorded.
    quantity: "",
    duration: "",
    assigned_staff_id: "",
    notes: "",
    source_type: String(sourceType || "")
  };
}

/**
 * Display-only task rows for a job sheet.
 *
 * manager_review_items are included only once the job is Approved, because before
 * approval they are unreviewed AI output. Variations are always included.
 * ai_transcript is never read.
 *
 * @param {object} job raw job sheet row (or display object)
 * @param {{approval_status?:string, variations?:*, include_variations?:boolean, max_lines?:number}=} options
 * @returns {Array<object>}
 */
function fieldosExtractTaskLines_(job, options) {
  var src = job || {};
  var opts = options || {};
  var approval = String(
    opts.approval_status != null ? opts.approval_status : src.approval_status || ""
  ).trim();
  var maxLines =
    Number(opts.max_lines) > 0 ? Math.floor(Number(opts.max_lines)) : FIELDOS_REPORT_MAX_RECORDS_;
  var rows = [];

  if (approval === "Approved") {
    fieldosSplitReportLines_(src.manager_review_items).forEach(function (description) {
      rows.push(
        fieldosReportTaskRow_(
          description,
          "Manager Review Item",
          "Approved",
          FIELDOS_REPORT_TASK_SOURCES_.MANAGER_REVIEW_ITEMS
        )
      );
    });
  }

  if (opts.include_variations !== false) {
    var variationSource = opts.variations != null ? opts.variations : src.variations;
    fieldosSplitReportLines_(variationSource).forEach(function (description) {
      rows.push(
        fieldosReportTaskRow_(
          description,
          "Variation",
          "Recorded",
          FIELDOS_REPORT_TASK_SOURCES_.VARIATIONS
        )
      );
    });
  }

  var seen = {};
  var deduped = [];
  rows.forEach(function (row) {
    var key = row.source_type + "|" + row.description.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    deduped.push(row);
  });
  return deduped.slice(0, maxLines);
}

function fieldosReportNormaliseRole_(role) {
  if (typeof fieldosNormalizeRole_ === "function") return fieldosNormalizeRole_(role);
  var r = String(role == null ? "" : role)
    .trim()
    .toLowerCase();
  if (r === "admin" || r === "administrator") return "admin";
  if (r === "manager" || r === "mgr") return "manager";
  return "staff";
}

function fieldosReportActorIsManager_(actor) {
  var a = actor || {};
  var role = fieldosReportNormaliseRole_(a.role != null ? a.role : a.actor_role);
  return role === "manager" || role === "admin";
}

/** Every staff id attached to a bundle: job assignment plus labour row owners. */
function fieldosReportBundleStaffIds_(bundle) {
  var ids = [];
  function add(value) {
    var s = String(value == null ? "" : value).trim();
    if (s && ids.indexOf(s) < 0) ids.push(s);
  }
  var b = bundle || {};
  var job = b.job || {};
  add(job.assigned_staff_id);
  add(job.staff_id);
  (b.labour_entries || []).forEach(function (row) {
    add(row && row.staff_id);
  });
  (b.machinery_entries || []).forEach(function (row) {
    add(row && row.operator_staff_id);
  });
  return ids;
}

function fieldosReportTruthy_(value) {
  return value === true || value === "true" || value === "TRUE" || value === 1 || value === "1";
}

function fieldosReportFalsy_(value) {
  return value === false || value === "false" || value === "FALSE" || value === 0 || value === "0";
}

function fieldosReportBundleIsBillable_(bundle) {
  var b = bundle || {};
  var c = b.completion || {};
  if (Number(c.billable_labour_hours) > 0) return true;
  var billableRow = false;
  ["labour_entries", "machinery_entries", "material_entries"].forEach(function (key) {
    (b[key] || []).forEach(function (row) {
      if (row && fieldosReportTruthy_(row.billable)) billableRow = true;
    });
  });
  return billableRow;
}

function fieldosReportContains_(haystack, needle) {
  return (
    String(haystack == null ? "" : haystack)
      .toLowerCase()
      .indexOf(
        String(needle == null ? "" : needle)
          .toLowerCase()
          .trim()
      ) >= 0
  );
}

function fieldosReportFilterStaffId_(filters) {
  var f = filters || {};
  return String(f.staff || f.assigned_staff_id || f.staff_id || "").trim();
}

/**
 * Filter a bundle against report filters and the requesting actor.
 *
 * Staff actors only ever see jobs they are assigned to or have labour rows on.
 * Blank job dates are not excluded on date alone (same rule as Phase 3D).
 *
 * @param {object} bundle { completion, job, labour_entries, ... }
 * @param {object} filters { date_from, date_to, staff|assigned_staff_id, customer, project,
 *   completion_status, approval_status, billable, job_sheet_id, completion_id }
 * @param {{role?:string, staff_id?:string}=} actor
 * @returns {boolean}
 */
function fieldosMatchReportFilters_(bundle, filters, actor) {
  var b = bundle || {};
  var c = b.completion || {};
  var job = b.job || {};
  var f = filters || {};
  var a = actor || {};

  if (!fieldosReportActorIsManager_(a)) {
    var actorStaffId = String(a.staff_id || "").trim();
    if (!actorStaffId) return false;
    if (fieldosReportBundleStaffIds_(b).indexOf(actorStaffId) < 0) return false;
  }

  var jobDate = fieldosNormaliseCalendarDate_(job.job_date || job.date) || "";
  if (!fieldosDateInInclusiveRange_(jobDate, f.date_from, f.date_to)) return false;

  if (f.job_sheet_id && String(job.job_sheet_id || c.job_sheet_id || "") !== String(f.job_sheet_id)) {
    return false;
  }
  if (f.completion_id && String(c.completion_id || "") !== String(f.completion_id)) return false;
  if (f.completion_status && String(c.completion_status || "") !== String(f.completion_status)) {
    return false;
  }
  if (f.approval_status && String(job.approval_status || "") !== String(f.approval_status)) {
    return false;
  }
  if (f.customer && !fieldosReportContains_(job.customer_name, f.customer)) return false;
  if (f.project && !fieldosReportContains_(job.project_name, f.project)) return false;

  var staffFilter = fieldosReportFilterStaffId_(f);
  if (staffFilter && fieldosReportBundleStaffIds_(b).indexOf(staffFilter) < 0) return false;

  if (fieldosReportTruthy_(f.billable) && !fieldosReportBundleIsBillable_(b)) return false;
  if (fieldosReportFalsy_(f.billable) && fieldosReportBundleIsBillable_(b)) return false;

  return true;
}

/** Human-readable reasons a bundle failed the filters — for preview diagnostics. */
function fieldosReportExclusionReasons_(bundle, filters, actor) {
  var b = bundle || {};
  var c = b.completion || {};
  var job = b.job || {};
  var f = filters || {};
  var a = actor || {};
  var reasons = [];

  if (!fieldosReportActorIsManager_(a)) {
    var actorStaffId = String(a.staff_id || "").trim();
    if (!actorStaffId) reasons.push("Staff actor has no staff_id.");
    else if (fieldosReportBundleStaffIds_(b).indexOf(actorStaffId) < 0) {
      reasons.push("Job is not assigned to this staff member and has no labour rows for them.");
    }
  }

  var jobDate = fieldosNormaliseCalendarDate_(job.job_date || job.date) || "";
  var dateFrom = fieldosNormaliseCalendarDate_(f.date_from) || "";
  var dateTo = fieldosNormaliseCalendarDate_(f.date_to) || "";
  if (jobDate && dateFrom && jobDate < dateFrom) {
    reasons.push("job_date " + jobDate + " is before date_from " + dateFrom + ".");
  }
  if (jobDate && dateTo && jobDate > dateTo) {
    reasons.push("job_date " + jobDate + " is after date_to " + dateTo + ".");
  }
  if (!jobDate && (dateFrom || dateTo)) {
    reasons.push("job_date missing or unparseable (date filter skipped when blank).");
  }
  if (f.job_sheet_id && String(job.job_sheet_id || c.job_sheet_id || "") !== String(f.job_sheet_id)) {
    reasons.push("job_sheet_id mismatch.");
  }
  if (f.completion_id && String(c.completion_id || "") !== String(f.completion_id)) {
    reasons.push("completion_id mismatch.");
  }
  if (f.completion_status && String(c.completion_status || "") !== String(f.completion_status)) {
    reasons.push("completion_status mismatch.");
  }
  if (f.approval_status && String(job.approval_status || "") !== String(f.approval_status)) {
    reasons.push("approval_status mismatch.");
  }
  if (f.customer && !fieldosReportContains_(job.customer_name, f.customer)) {
    reasons.push("customer filter did not match.");
  }
  if (f.project && !fieldosReportContains_(job.project_name, f.project)) {
    reasons.push("project filter did not match.");
  }
  var staffFilter = fieldosReportFilterStaffId_(f);
  if (staffFilter && fieldosReportBundleStaffIds_(b).indexOf(staffFilter) < 0) {
    reasons.push("staff filter did not match assignment or labour rows.");
  }
  if (fieldosReportTruthy_(f.billable) && !fieldosReportBundleIsBillable_(b)) {
    reasons.push("no billable rows or billable hours.");
  }
  if (fieldosReportFalsy_(f.billable) && fieldosReportBundleIsBillable_(b)) {
    reasons.push("job has billable rows but billable=false was requested.");
  }
  return reasons;
}

/** Grouping rules per report type: default plus the group_by values a caller may pick. */
var FIELDOS_REPORT_GROUPINGS_ = {
  "Job Sheet Summary": { default_group: "job_sheet_id", allowed: ["job_sheet_id"] },
  "Staff Work Report": { default_group: "staff_id", allowed: ["staff_id", "job_sheet_id"] },
  "Client Job Report": {
    default_group: "customer",
    allowed: ["customer", "project", "job_sheet_id"]
  },
  "Project Activity Report": {
    default_group: "project",
    allowed: ["project", "customer", "job_month"]
  },
  "Completion Register": {
    default_group: "job_month",
    allowed: ["job_month", "customer", "project", "none"]
  }
};

function fieldosReportGroupOptions_(reportType) {
  var spec = FIELDOS_REPORT_GROUPINGS_[String(reportType || "")];
  if (!spec) return { default_group: "job_sheet_id", allowed: ["job_sheet_id"] };
  return { default_group: spec.default_group, allowed: spec.allowed.slice() };
}

function fieldosReportResolveGroupBy_(reportType, groupBy) {
  var spec = fieldosReportGroupOptions_(reportType);
  var requested = String(groupBy || "").trim();
  if (requested && spec.allowed.indexOf(requested) >= 0) return requested;
  return spec.default_group;
}

function fieldosReportBundleLineCount_(bundle) {
  var b = bundle || {};
  return (
    (b.labour_entries || []).length +
    (b.machinery_entries || []).length +
    (b.material_entries || []).length +
    (b.task_lines || []).length
  );
}

function fieldosReportBundleSortKey_(bundle) {
  var b = bundle || {};
  var job = b.job || {};
  var c = b.completion || {};
  return (
    String(fieldosNormaliseCalendarDate_(job.job_date || job.date) || "") +
    "|" +
    String(job.job_sheet_id || c.job_sheet_id || "") +
    "|" +
    String(c.completion_id || "")
  );
}

function fieldosReportJobMonth_(bundle) {
  var job = (bundle && bundle.job) || {};
  var ymd = fieldosNormaliseCalendarDate_(job.job_date || job.date) || "";
  return ymd ? ymd.slice(0, 7) : "";
}

/**
 * Group bundles per report-type rules. Deterministic: groups sorted by key,
 * items sorted by job_date then job_sheet_id then completion_id.
 *
 * Staff Work Report fans a job out into one group per staff member with labour
 * rows on it, so a job may appear in more than one group.
 *
 * @returns {{group_by:string, groups:Array<object>}}
 */
function fieldosGroupReportBundles_(bundles, reportType, groupBy) {
  var mode = fieldosReportResolveGroupBy_(reportType, groupBy);
  var list = (bundles || []).slice();
  var order = [];
  var map = {};

  function bucket(key, label, groupType) {
    var k = String(key == null ? "" : key);
    if (!map[k]) {
      map[k] = {
        group_key: k,
        group_label: String(label || k || "(unspecified)"),
        group_type: groupType,
        items: []
      };
      order.push(k);
    }
    return map[k];
  }

  list.forEach(function (bundle) {
    var b = bundle || {};
    var job = b.job || {};
    var c = b.completion || {};
    if (mode === "staff_id") {
      var staffIds = [];
      (b.labour_entries || []).forEach(function (row) {
        var id = String((row && row.staff_id) || "").trim();
        if (id && staffIds.indexOf(id) < 0) staffIds.push(id);
      });
      if (!staffIds.length) {
        var assigned = String(job.assigned_staff_id || job.staff_id || "").trim();
        staffIds = [assigned || ""];
      }
      staffIds.forEach(function (staffId) {
        var labourForStaff = (b.labour_entries || []).filter(function (row) {
          return String((row && row.staff_id) || "") === staffId;
        });
        var name = "";
        labourForStaff.forEach(function (row) {
          if (!name && row && row.staff_name) name = String(row.staff_name);
        });
        bucket(staffId, name || staffId || "(unassigned)", "staff_id").items.push({
          bundle: b,
          staff_id: staffId,
          labour_entries: labourForStaff
        });
      });
      return;
    }
    if (mode === "customer") {
      bucket(String(job.customer_name || ""), String(job.customer_name || "(no customer)"), "customer").items.push({
        bundle: b
      });
      return;
    }
    if (mode === "project") {
      bucket(String(job.project_name || ""), String(job.project_name || "(no project)"), "project").items.push({
        bundle: b
      });
      return;
    }
    if (mode === "job_month") {
      var month = fieldosReportJobMonth_(b);
      bucket(month, month || "(undated)", "job_month").items.push({ bundle: b });
      return;
    }
    if (mode === "none") {
      bucket("all", "All records", "none").items.push({ bundle: b });
      return;
    }
    var jobId = String(job.job_sheet_id || c.job_sheet_id || "");
    bucket(jobId, jobId || "(no job sheet)", "job_sheet_id").items.push({ bundle: b });
  });

  order.sort(function (a, b) {
    if (a === b) return 0;
    if (a === "") return 1;
    if (b === "") return -1;
    return a < b ? -1 : 1;
  });

  var groups = order.map(function (key) {
    var group = map[key];
    group.items.sort(function (a, b) {
      var ak = fieldosReportBundleSortKey_(a.bundle);
      var bk = fieldosReportBundleSortKey_(b.bundle);
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
    var lineCount = 0;
    var jobIds = [];
    group.items.forEach(function (item) {
      lineCount += fieldosReportBundleLineCount_(item.bundle);
      var jobId = String(
        (item.bundle.job && item.bundle.job.job_sheet_id) ||
          (item.bundle.completion && item.bundle.completion.job_sheet_id) ||
          ""
      );
      if (jobId && jobIds.indexOf(jobId) < 0) jobIds.push(jobId);
    });
    group.record_count = group.items.length;
    group.line_count = lineCount;
    group.job_sheet_ids = jobIds;
    return group;
  });

  return { group_by: mode, groups: groups };
}

/**
 * Rough page estimate for UI expectation-setting only — never a print guarantee.
 *
 * @param {string} reportType
 * @param {number} recordCount
 * @param {{line_count?:number, group_count?:number, include_cover?:boolean}=} options
 * @returns {number}
 */
function fieldosEstimateReportPages_(reportType, recordCount, options) {
  var opts = options || {};
  var records = Math.max(0, Math.floor(Number(recordCount) || 0));
  if (!records) return 0;
  var lines = Math.max(0, Math.floor(Number(opts.line_count) || 0));
  var groups = Math.max(1, Math.floor(Number(opts.group_count) || 1));
  var type = String(reportType || "");
  var pages;

  if (type === FIELDOS_REPORT_TYPES_.JOB_SHEET_SUMMARY) {
    // One page per job sheet, plus overflow pages for unusually long jobs.
    var linesPerFirstPage = 14;
    var overflow = Math.max(0, lines - records * linesPerFirstPage);
    pages = records + Math.ceil(overflow / 30);
  } else {
    var rowsPerPage = 20;
    if (type === FIELDOS_REPORT_TYPES_.CLIENT_JOB_REPORT) rowsPerPage = 16;
    else if (type === FIELDOS_REPORT_TYPES_.PROJECT_ACTIVITY_REPORT) rowsPerPage = 18;
    else if (type === FIELDOS_REPORT_TYPES_.COMPLETION_REGISTER) rowsPerPage = 28;
    var units = lines || records;
    pages = Math.ceil(units / rowsPerPage) + Math.ceil(groups / 6);
  }

  if (opts.include_cover !== false) pages += 1;
  return Math.max(1, pages);
}

function fieldosReportNumberOrBlank_(value) {
  if (value === "" || value == null) return "";
  var n = Number(value);
  return Number.isFinite(n) ? n : "";
}

function fieldosReportLabourRow_(row, includeNotes) {
  var r = row || {};
  var out = {
    labour_id: String(r.labour_id || ""),
    staff_id: String(r.staff_id || ""),
    staff_name: String(r.staff_name || ""),
    work_date: fieldosNormaliseCalendarDate_(r.work_date) || "",
    start_time: String(r.start_time || ""),
    finish_time: String(r.finish_time || ""),
    break_minutes: Number(r.break_minutes) || 0,
    labour_hours: fieldosReportNumberOrBlank_(r.labour_hours),
    travel_minutes: Number(r.travel_minutes) || 0,
    travel_hours: Number(r.travel_hours) || 0,
    role_or_activity: String(r.role_or_activity || ""),
    billable: fieldosReportTruthy_(r.billable),
    confirmation_status: String(r.confirmation_status || "")
  };
  if (includeNotes) out.notes = String(r.notes || "");
  return out;
}

function fieldosReportMachineryRow_(row, includeNotes) {
  var r = row || {};
  var out = {
    machinery_entry_id: String(r.machinery_entry_id || ""),
    equipment_name: String(r.equipment_name || ""),
    operator_staff_id: String(r.operator_staff_id || ""),
    start_time: String(r.start_time || ""),
    finish_time: String(r.finish_time || ""),
    duration_hours: fieldosReportNumberOrBlank_(r.duration_hours),
    charge_code: String(r.charge_code || ""),
    billable: fieldosReportTruthy_(r.billable),
    confirmation_status: String(r.confirmation_status || "")
  };
  if (includeNotes) out.notes = String(r.notes || "");
  return out;
}

function fieldosReportMaterialRow_(row, includeNotes) {
  var r = row || {};
  var out = {
    material_entry_id: String(r.material_entry_id || ""),
    item_name: String(r.item_name || ""),
    item_code: String(r.item_code || ""),
    quantity: fieldosReportNumberOrBlank_(r.quantity),
    unit: String(r.unit || ""),
    billable: fieldosReportTruthy_(r.billable),
    confirmation_status: String(r.confirmation_status || "")
  };
  if (includeNotes) out.notes = String(r.notes || "");
  return out;
}

/**
 * Structured single-job data for the FastAPI PDF renderer. No PDF bytes, no
 * forbidden fields, no money. Row-level and completion internal notes are only
 * included for managers who explicitly ask for them.
 *
 * @param {object} bundle { completion, job, labour_entries, machinery_entries,
 *   material_entries, task_lines, readiness, recording_count }
 * @param {{actor?:object, actor_role?:string, include_internal_notes?:boolean,
 *   report_type?:string, generated_at?:string, recording_count?:number}=} options
 */
function fieldosBuildJobPdfData_(bundle, options) {
  var b = bundle || {};
  var opts = options || {};
  var c = b.completion || {};
  var job = b.job || {};
  var readiness = b.readiness || {};
  var actor = opts.actor || { role: opts.actor_role };
  var manager = fieldosReportActorIsManager_(actor);
  var includeInternal = manager && fieldosReportTruthy_(opts.include_internal_notes);

  var labour = (b.labour_entries || []).map(function (row) {
    return fieldosReportLabourRow_(row, includeInternal);
  });
  var machinery = (b.machinery_entries || []).map(function (row) {
    return fieldosReportMachineryRow_(row, includeInternal);
  });
  var materials = (b.material_entries || []).map(function (row) {
    return fieldosReportMaterialRow_(row, includeInternal);
  });
  var tasks = (b.task_lines || []).map(function (row) {
    var task = fieldosReportTaskRow_(row.description, row.category, row.status, row.source_type);
    task.notes = includeInternal ? String(row.notes || "") : "";
    return task;
  });

  var recordingCount = Number(
    opts.recording_count != null ? opts.recording_count : b.recording_count
  );
  if (!Number.isFinite(recordingCount) || recordingCount < 0) recordingCount = 0;

  var data = {
    template_version: FIELDOS_REPORT_TEMPLATE_VERSION_,
    report_type: String(opts.report_type || FIELDOS_REPORT_TYPES_.JOB_SHEET_SUMMARY),
    generated_at: String(opts.generated_at || ""),
    job: {
      job_sheet_id: String(job.job_sheet_id || c.job_sheet_id || ""),
      job_date: fieldosNormaliseCalendarDate_(job.job_date || job.date) || "",
      customer_name: String(job.customer_name || ""),
      project_name: String(job.project_name || ""),
      approval_status: String(job.approval_status || ""),
      processing_status: String(job.processing_status || ""),
      assigned_staff_id: String(job.assigned_staff_id || job.staff_id || "")
    },
    completion: {
      completion_id: String(c.completion_id || ""),
      completion_status: String(c.completion_status || ""),
      work_summary: String(c.work_summary || ""),
      invoice_description: String(c.invoice_description || ""),
      variations: fieldosSplitReportLines_(c.variations),
      finalised_by: String(c.finalised_by || ""),
      finalised_at: c.finalised_at || null,
      version: Number(c.version) || 1
    },
    tasks: tasks,
    labour: labour,
    machinery: machinery,
    materials: materials,
    // Recording evidence is reported as a count only — never IDs, URLs or text.
    recording_count_only: Math.floor(recordingCount),
    readiness: {
      invoice_ready: readiness.invoice_ready === true,
      payroll_ready: readiness.payroll_ready === true,
      warning_count: Number(readiness.warning_count) || 0,
      completion_finalised:
        String(c.completion_status || "") ===
        (typeof FIELDOS_COMPLETION_STATUSES_ !== "undefined"
          ? FIELDOS_COMPLETION_STATUSES_.FINALISED
          : "Finalised"),
      job_approved: String(job.approval_status || "") === "Approved"
    },
    totals: {
      total_labour_hours: Number(c.total_labour_hours) || 0,
      total_travel_hours: Number(c.total_travel_hours) || 0,
      total_machinery_hours: Number(c.total_machinery_hours) || 0,
      billable_labour_hours: Number(c.billable_labour_hours) || 0,
      non_billable_labour_hours: Number(c.non_billable_labour_hours) || 0,
      labour_row_count: labour.length,
      machinery_row_count: machinery.length,
      material_row_count: materials.length,
      task_line_count: tasks.length
    },
    include_internal_notes: includeInternal
  };

  if (includeInternal) {
    data.internal_notes = String(c.internal_notes || "");
  }

  return fieldosScrubReportRecord_(data);
}

function fieldosReportSlug_(value, fallback) {
  var s = String(value == null ? "" : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || String(fallback || "");
}

function fieldosReportDatePart_(value, fallback) {
  var raw = String(value == null ? "" : value).trim();
  var normalised =
    typeof fieldosNormaliseCalendarDate_ === "function" ? fieldosNormaliseCalendarDate_(raw) || "" : "";
  var safe = normalised || raw.replace(/[^0-9-]/g, "");
  return safe || String(fallback || "");
}

/**
 * Deterministic, filesystem-safe PDF filename.
 * Single job: nativegrace_job_21759f5d_2026-07-16.pdf
 * Range:      nativegrace_staff_work_report_2026-07-01_to_2026-07-31.pdf
 */
function fieldosSafeReportFilename_(reportType, dateFrom, dateTo, jobSheetId) {
  var from = fieldosReportDatePart_(dateFrom, "");
  var to = fieldosReportDatePart_(dateTo, "");
  var jobSlug = fieldosReportSlug_(jobSheetId, "");
  if (jobSlug) {
    return "nativegrace_job_" + jobSlug + "_" + (from || to || "undated") + ".pdf";
  }
  var typeSlug = fieldosReportSlug_(reportType, "report");
  if (from && to && from === to) return "nativegrace_" + typeSlug + "_" + from + ".pdf";
  return "nativegrace_" + typeSlug + "_" + (from || "from") + "_to_" + (to || "to") + ".pdf";
}

/** Whitelist-only audit shape — no payloads, snapshots, transcripts or secrets. */
function fieldosReportAuditPayload_(meta) {
  var m = meta || {};
  var payload = {
    action: String(m.action || ""),
    report_batch_id: String(m.report_batch_id || ""),
    report_type: String(m.report_type || ""),
    group_by: String(m.group_by || ""),
    actor_staff_id: String(m.actor_staff_id || ""),
    actor_role: String(m.actor_role || ""),
    previous_status: String(m.previous_status || ""),
    new_status: String(m.new_status || ""),
    record_count: m.record_count != null ? Number(m.record_count) || 0 : null,
    line_count: m.line_count != null ? Number(m.line_count) || 0 : null,
    group_count: m.group_count != null ? Number(m.group_count) || 0 : null,
    estimated_pages: m.estimated_pages != null ? Number(m.estimated_pages) || 0 : null,
    blocker_count: m.blocker_count != null ? Number(m.blocker_count) || 0 : null,
    template_version: String(m.template_version || ""),
    date_from: String(m.date_from || ""),
    date_to: String(m.date_to || ""),
    job_sheet_id: String(m.job_sheet_id || ""),
    completion_id: String(m.completion_id || ""),
    file_name: String(m.file_name || ""),
    checksum: String(m.checksum || ""),
    correlation_id: String(m.correlation_id || "")
  };
  return fieldosScrubReportRecord_(payload);
}
