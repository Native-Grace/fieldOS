/**
 * Phase 3D — pure export readiness + CSV helpers.
 * Safe for Apps Script and Node tests (no SpreadsheetApp / Drive).
 */

var FIELDOS_EXPORT_TYPES_ = {
  INVOICE_CSV: "Invoice CSV",
  PAYROLL_CSV: "Payroll CSV",
  MACHINERY_CSV: "Machinery CSV",
  MATERIALS_CSV: "Materials CSV",
  COMPLETION_SUMMARY_CSV: "Completion Summary CSV"
};

var FIELDOS_EXPORT_STATUSES_ = {
  DRAFT: "Draft",
  VALIDATED: "Validated",
  EXPORTED: "Exported",
  CANCELLED: "Cancelled"
};

function fieldosEscapeCsvCell_(value) {
  if (value == null) return "";
  var s = String(value);
  // Formula-injection protection for spreadsheet consumers.
  if (/^[=+\-@]/.test(s)) {
    s = "'" + s;
  }
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function fieldosBuildCsv_(headers, rows) {
  var lines = [];
  lines.push(headers.map(fieldosEscapeCsvCell_).join(","));
  (rows || []).forEach(function (row) {
    lines.push(
      headers
        .map(function (h) {
          return fieldosEscapeCsvCell_(row[h]);
        })
        .join(",")
    );
  });
  return lines.join("\r\n") + "\r\n";
}

function fieldosSimpleChecksum_(text) {
  var s = String(text || "");
  var hash = 2166136261;
  for (var i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ("00000000" + (hash >>> 0).toString(16)).slice(-8);
}

function fieldosUnresolvedWarningCount_(completion) {
  var warnings = Array.isArray(completion && completion.warnings) ? completion.warnings : [];
  var resolutions = Array.isArray(completion && completion.warning_resolutions)
    ? completion.warning_resolutions
    : [];
  var count = 0;
  warnings.forEach(function (w) {
    if (fieldosIsResolvableBreakWarning_(w) && !fieldosIsBreakWarningResolved_(resolutions, w)) {
      count += 1;
      return;
    }
    if (fieldosIsNonCriticalAckWarning_(w)) count += 1;
  });
  return count;
}

function fieldosRowConfirmationOk_(row) {
  if (fieldosIsExcludedRow_(row)) return true;
  return fieldosIsConfirmedRow_(row);
}

/**
 * Export readiness for a completion + job + children.
 * @returns {{ invoice_ready, invoice_blockers, payroll_ready, payroll_blockers, warning_count }}
 */
function fieldosComputeExportReadiness_(completion, job, labour, machinery, materials) {
  var invoiceBlockers = [];
  var payrollBlockers = [];
  var status = String((completion && completion.completion_status) || "").trim();
  var approval = String((job && job.approval_status) || (completion && completion.job_approval_status) || "").trim();
  var labourRows = labour || [];
  var machineryRows = machinery || [];
  var materialRows = materials || [];
  var warningCount = fieldosUnresolvedWarningCount_(completion || {});

  if (status !== FIELDOS_COMPLETION_STATUSES_.FINALISED) {
    invoiceBlockers.push("Completion is not Finalised.");
    payrollBlockers.push("Completion is not Finalised.");
  }
  if (approval !== "Approved") {
    invoiceBlockers.push("Job approval_status must be Approved.");
  }
  if (!String((completion && completion.work_summary) || "").trim()) {
    invoiceBlockers.push("Work summary is blank.");
  }
  if (!String((completion && completion.invoice_description) || "").trim()) {
    invoiceBlockers.push("Invoice description is blank.");
  }
  if (warningCount > 0) {
    invoiceBlockers.push(warningCount + " unresolved critical warning" + (warningCount === 1 ? "" : "s"));
  }

  labourRows.forEach(function (row, idx) {
    if (fieldosIsExcludedRow_(row)) return;
    if (!fieldosRowConfirmationOk_(row)) {
      invoiceBlockers.push("labour[" + idx + "] is not Confirmed or Excluded.");
      payrollBlockers.push("labour[" + idx + "] is not Confirmed.");
    }
    var calc = fieldosComputeLabourEntry_(row);
    calc.errors.forEach(function (e) {
      invoiceBlockers.push("labour[" + idx + "]: " + e);
      payrollBlockers.push("labour[" + idx + "]: " + e);
    });
    if (fieldosIsConfirmedRow_(row)) {
      if (!String(row.staff_id || "").trim()) {
        payrollBlockers.push("labour[" + idx + "] missing staff_id.");
      }
      if (!fieldosNormaliseCalendarDate_(row.work_date)) {
        payrollBlockers.push("labour[" + idx + "] missing work_date.");
      }
      if (!fieldosNormaliseClockTime_(row.start_time)) {
        payrollBlockers.push("labour[" + idx + "] missing start_time.");
      }
      if (!fieldosNormaliseClockTime_(row.finish_time)) {
        payrollBlockers.push("labour[" + idx + "] missing finish_time.");
      }
      if (calc.net_labour_minutes == null) {
        payrollBlockers.push("labour[" + idx + "] labour hours not derived.");
      }
    }
  });

  machineryRows.forEach(function (row, idx) {
    if (fieldosIsExcludedRow_(row)) return;
    if (!fieldosRowConfirmationOk_(row)) {
      invoiceBlockers.push("machinery[" + idx + "] is not Confirmed or Excluded.");
    }
  });
  materialRows.forEach(function (row, idx) {
    if (fieldosIsExcludedRow_(row)) return;
    if (!fieldosRowConfirmationOk_(row)) {
      invoiceBlockers.push("material[" + idx + "] is not Confirmed or Excluded.");
    }
  });

  invoiceBlockers = fieldosUniqueMessages_(invoiceBlockers);
  payrollBlockers = fieldosUniqueMessages_(payrollBlockers);

  return {
    invoice_ready: invoiceBlockers.length === 0,
    invoice_blockers: invoiceBlockers,
    payroll_ready: payrollBlockers.length === 0,
    payroll_blockers: payrollBlockers,
    warning_count: warningCount
  };
}

function fieldosExportAuditPayload_(meta) {
  return {
    action: meta.action || "",
    export_batch_id: meta.export_batch_id || "",
    export_type: meta.export_type || "",
    actor_staff_id: meta.actor_staff_id || "",
    actor_role: meta.actor_role || "",
    previous_status: meta.previous_status || "",
    new_status: meta.new_status || "",
    record_count: meta.record_count != null ? meta.record_count : null,
    checksum: meta.checksum || "",
    date_from: meta.date_from || "",
    date_to: meta.date_to || "",
    correlation_id: meta.correlation_id || ""
  };
}

function fieldosSafeExportFilename_(exportType, dateFrom, dateTo) {
  var slug = String(exportType || "export")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return (
    "nativegrace_" +
    slug +
    "_" +
    String(dateFrom || "from") +
    "_to_" +
    String(dateTo || "to") +
    ".csv"
  );
}

function fieldosPad2_(n) {
  var s = String(n);
  return s.length < 2 ? "0" + s : s;
}

function fieldosDefaultDashboardRange_() {
  var to = new Date();
  var from = new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);
  return {
    date_from: fieldosNormaliseCalendarDate_(from) || "",
    date_to: fieldosNormaliseCalendarDate_(to) || ""
  };
}

function fieldosVariationSummary_(completion) {
  var v = completion && completion.variations;
  if (Array.isArray(v)) return v.join("; ");
  return String(v || "");
}

function fieldosBuildInvoiceCsvRows_(items) {
  return (items || []).map(function (item) {
    var c = item.completion || {};
    var job = item.job || {};
    var labour = item.labour_entries || [];
    var machinery = item.machinery_entries || [];
    var materials = item.material_entries || [];
    var billableMachinery = 0;
    machinery.forEach(function (row) {
      if (fieldosIsExcludedRow_(row) || !fieldosIsConfirmedRow_(row)) return;
      if (row.billable === true || row.billable === "TRUE" || row.billable === "true") {
        billableMachinery += Number(row.duration_hours) || 0;
      }
    });
    var billableMaterials = 0;
    materials.forEach(function (row) {
      if (fieldosIsExcludedRow_(row) || !fieldosIsConfirmedRow_(row)) return;
      if (row.billable === true || row.billable === "TRUE" || row.billable === "true") {
        billableMaterials += 1;
      }
    });
    return {
      job_sheet_id: c.job_sheet_id || job.job_sheet_id || "",
      job_date: fieldosNormaliseCalendarDate_(job.job_date || job.date) || "",
      customer_name: job.customer_name || "",
      project_name: job.project_name || "",
      invoice_description: c.invoice_description || "",
      work_summary: c.work_summary || "",
      variation_summary: fieldosVariationSummary_(c),
      billable_labour_hours: c.billable_labour_hours || 0,
      billable_machinery_hours: Math.round(billableMachinery * 100) / 100,
      billable_material_items: billableMaterials,
      pricing_status: "Rates not configured",
      finalised_by: c.finalised_by || "",
      finalised_at: c.finalised_at || ""
    };
  });
}

function fieldosBuildPayrollCsvRows_(items) {
  var rows = [];
  (items || []).forEach(function (item) {
    var c = item.completion || {};
    (item.labour_entries || []).forEach(function (row) {
      if (!fieldosIsConfirmedRow_(row) || fieldosIsExcludedRow_(row)) return;
      var calc = fieldosComputeLabourEntry_(row);
      rows.push({
        job_sheet_id: c.job_sheet_id || "",
        completion_id: c.completion_id || "",
        work_date: fieldosNormaliseCalendarDate_(row.work_date) || "",
        staff_id: row.staff_id || "",
        staff_name: row.staff_name || "",
        start_time: fieldosNormaliseClockTime_(row.start_time) || "",
        finish_time: fieldosNormaliseClockTime_(row.finish_time) || "",
        break_minutes: Number(row.break_minutes) || 0,
        net_labour_minutes: calc.net_labour_minutes == null ? "" : calc.net_labour_minutes,
        labour_hours: calc.labour_hours == null ? "" : calc.labour_hours,
        travel_minutes: Number(row.travel_minutes) || 0,
        travel_hours: calc.travel_hours || 0,
        role_or_activity: row.role_or_activity || "",
        billable: row.billable === true || row.billable === "TRUE" || row.billable === "true" ? "TRUE" : "FALSE",
        notes: row.notes || "",
        finalised_by: c.finalised_by || "",
        finalised_at: c.finalised_at || ""
      });
    });
  });
  return rows;
}

function fieldosBuildMachineryCsvRows_(items) {
  var rows = [];
  (items || []).forEach(function (item) {
    var c = item.completion || {};
    var job = item.job || {};
    (item.machinery_entries || []).forEach(function (row) {
      if (!fieldosIsConfirmedRow_(row) || fieldosIsExcludedRow_(row)) return;
      rows.push({
        job_sheet_id: c.job_sheet_id || "",
        completion_id: c.completion_id || "",
        job_date: fieldosNormaliseCalendarDate_(job.job_date || job.date) || "",
        equipment_name: row.equipment_name || "",
        operator_staff_id: row.operator_staff_id || "",
        duration_hours: row.duration_hours == null ? "" : row.duration_hours,
        billable: row.billable === true || row.billable === "TRUE" || row.billable === "true" ? "TRUE" : "FALSE",
        charge_code: row.charge_code || "",
        notes: row.notes || "",
        finalised_by: c.finalised_by || "",
        finalised_at: c.finalised_at || ""
      });
    });
  });
  return rows;
}

function fieldosBuildMaterialsCsvRows_(items) {
  var rows = [];
  (items || []).forEach(function (item) {
    var c = item.completion || {};
    var job = item.job || {};
    (item.material_entries || []).forEach(function (row) {
      if (!fieldosIsConfirmedRow_(row) || fieldosIsExcludedRow_(row)) return;
      rows.push({
        job_sheet_id: c.job_sheet_id || "",
        completion_id: c.completion_id || "",
        job_date: fieldosNormaliseCalendarDate_(job.job_date || job.date) || "",
        item_name: row.item_name || "",
        quantity: row.quantity == null ? "" : row.quantity,
        unit: row.unit || "",
        billable: row.billable === true || row.billable === "TRUE" || row.billable === "true" ? "TRUE" : "FALSE",
        notes: row.notes || "",
        finalised_by: c.finalised_by || "",
        finalised_at: c.finalised_at || ""
      });
    });
  });
  return rows;
}

function fieldosBuildSummaryCsvRows_(items) {
  return (items || []).map(function (item) {
    var c = item.completion || {};
    var job = item.job || {};
    var readiness = item.readiness || fieldosComputeExportReadiness_(
      c,
      job,
      item.labour_entries,
      item.machinery_entries,
      item.material_entries
    );
    return {
      job_sheet_id: c.job_sheet_id || "",
      completion_id: c.completion_id || "",
      customer_name: job.customer_name || "",
      project_name: job.project_name || "",
      job_date: fieldosNormaliseCalendarDate_(job.job_date || job.date) || "",
      completion_status: c.completion_status || "",
      approval_status: job.approval_status || c.job_approval_status || "",
      total_labour_hours: c.total_labour_hours || 0,
      total_travel_hours: c.total_travel_hours || 0,
      total_machinery_hours: c.total_machinery_hours || 0,
      billable_labour_hours: c.billable_labour_hours || 0,
      non_billable_labour_hours: c.non_billable_labour_hours || 0,
      invoice_ready: readiness.invoice_ready ? "TRUE" : "FALSE",
      payroll_ready: readiness.payroll_ready ? "TRUE" : "FALSE",
      warning_count: readiness.warning_count || 0,
      finalised_by: c.finalised_by || "",
      finalised_at: c.finalised_at || ""
    };
  });
}

function fieldosCsvHeadersForType_(exportType) {
  if (exportType === FIELDOS_EXPORT_TYPES_.INVOICE_CSV) {
    return [
      "job_sheet_id",
      "job_date",
      "customer_name",
      "project_name",
      "invoice_description",
      "work_summary",
      "variation_summary",
      "billable_labour_hours",
      "billable_machinery_hours",
      "billable_material_items",
      "pricing_status",
      "finalised_by",
      "finalised_at"
    ];
  }
  if (exportType === FIELDOS_EXPORT_TYPES_.PAYROLL_CSV) {
    return [
      "job_sheet_id",
      "completion_id",
      "work_date",
      "staff_id",
      "staff_name",
      "start_time",
      "finish_time",
      "break_minutes",
      "net_labour_minutes",
      "labour_hours",
      "travel_minutes",
      "travel_hours",
      "role_or_activity",
      "billable",
      "notes",
      "finalised_by",
      "finalised_at"
    ];
  }
  if (exportType === FIELDOS_EXPORT_TYPES_.MACHINERY_CSV) {
    return [
      "job_sheet_id",
      "completion_id",
      "job_date",
      "equipment_name",
      "operator_staff_id",
      "duration_hours",
      "billable",
      "charge_code",
      "notes",
      "finalised_by",
      "finalised_at"
    ];
  }
  if (exportType === FIELDOS_EXPORT_TYPES_.MATERIALS_CSV) {
    return [
      "job_sheet_id",
      "completion_id",
      "job_date",
      "item_name",
      "quantity",
      "unit",
      "billable",
      "notes",
      "finalised_by",
      "finalised_at"
    ];
  }
  return [
    "job_sheet_id",
    "completion_id",
    "customer_name",
    "project_name",
    "job_date",
    "completion_status",
    "approval_status",
    "total_labour_hours",
    "total_travel_hours",
    "total_machinery_hours",
    "billable_labour_hours",
    "non_billable_labour_hours",
    "invoice_ready",
    "payroll_ready",
    "warning_count",
    "finalised_by",
    "finalised_at"
  ];
}

function fieldosBuildCsvForType_(exportType, items) {
  var headers = fieldosCsvHeadersForType_(exportType);
  var rows;
  if (exportType === FIELDOS_EXPORT_TYPES_.INVOICE_CSV) rows = fieldosBuildInvoiceCsvRows_(items);
  else if (exportType === FIELDOS_EXPORT_TYPES_.PAYROLL_CSV) rows = fieldosBuildPayrollCsvRows_(items);
  else if (exportType === FIELDOS_EXPORT_TYPES_.MACHINERY_CSV) rows = fieldosBuildMachineryCsvRows_(items);
  else if (exportType === FIELDOS_EXPORT_TYPES_.MATERIALS_CSV) rows = fieldosBuildMaterialsCsvRows_(items);
  else rows = fieldosBuildSummaryCsvRows_(items);
  // Deterministic sort by job_sheet_id then completion_id / staff / equipment.
  rows.sort(function (a, b) {
    var ak = String(a.job_sheet_id || "") + "|" + String(a.completion_id || "") + "|" + String(a.staff_id || a.equipment_name || a.item_name || "");
    var bk = String(b.job_sheet_id || "") + "|" + String(b.completion_id || "") + "|" + String(b.staff_id || b.equipment_name || b.item_name || "");
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  return {
    headers: headers,
    rows: rows,
    csv: fieldosBuildCsv_(headers, rows),
    checksum: fieldosSimpleChecksum_(fieldosBuildCsv_(headers, rows))
  };
}

function fieldosSortExportItems_(items) {
  var rows = (items || []).slice();
  rows.sort(function (a, b) {
    var ak = String(a.job_sheet_id || "") + "|" + String(a.completion_id || "");
    var bk = String(b.job_sheet_id || "") + "|" + String(b.completion_id || "");
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  return rows;
}

/** Whitelist-only audit shape — drops CSV bodies, transcripts, tokens, Drive IDs. */
function fieldosSanitizeExportAudit_(meta) {
  return fieldosExportAuditPayload_(meta || {});
}
