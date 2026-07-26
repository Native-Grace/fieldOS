/**
 * Phase 3C — pure job-completion calculation and draft helpers.
 * Safe to load in Apps Script and Node tests (no SpreadsheetApp / OpenAI).
 */

var FIELDOS_COMPLETION_STATUSES_ = {
  DRAFT: "Draft",
  READY: "Ready for Final Review",
  FINALISED: "Finalised",
  REOPENED: "Reopened"
};

var FIELDOS_ROW_CONFIRMATION_ = {
  SUGGESTED: "Suggested",
  CONFIRMED: "Confirmed",
  EXCLUDED: "Excluded"
};

var FIELDOS_MAX_SHIFT_HOURS_ = 12;

/**
 * Parse HH:MM or H:MM into minutes from midnight. Returns null if invalid.
 */
function fieldosParseTimeToMinutes_(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Deterministic labour arithmetic from start/finish/break.
 * @returns {{ ok: boolean, gross_minutes: number|null, net_labour_minutes: number|null,
 *   labour_hours: number|null, travel_hours: number, errors: string[], warnings: string[] }}
 */
function fieldosComputeLabourEntry_(entry, options) {
  const opts = options || {};
  const maxShiftHours = opts.maxShiftHours != null ? Number(opts.maxShiftHours) : FIELDOS_MAX_SHIFT_HOURS_;
  const errors = [];
  const warnings = [];
  const start = fieldosParseTimeToMinutes_(entry && entry.start_time);
  const finish = fieldosParseTimeToMinutes_(entry && entry.finish_time);
  let breakMinutes = entry && entry.break_minutes != null && entry.break_minutes !== ""
    ? Number(entry.break_minutes)
    : 0;
  let travelMinutes = entry && entry.travel_minutes != null && entry.travel_minutes !== ""
    ? Number(entry.travel_minutes)
    : 0;

  if (!Number.isFinite(breakMinutes)) {
    errors.push("Break minutes must be a number.");
    breakMinutes = 0;
  }
  if (!Number.isFinite(travelMinutes)) {
    errors.push("travel_minutes must be a number.");
    travelMinutes = 0;
  }
  if (breakMinutes < 0) errors.push("Break minutes cannot be negative.");
  if (travelMinutes < 0) errors.push("travel_minutes cannot be negative.");

  const startRaw = String((entry && entry.start_time) || "").trim();
  const finishRaw = String((entry && entry.finish_time) || "").trim();
  // Blank → required only. Non-empty invalid → format only. Never both for one field.
  if (start == null) {
    errors.push(startRaw === "" ? "Start time is required." : "Start time must use HH:MM.");
  }
  if (finish == null) {
    errors.push(finishRaw === "" ? "Finish time is required." : "Finish time must use HH:MM.");
  }
  if (start == null || finish == null) {
    return {
      ok: false,
      gross_minutes: null,
      net_labour_minutes: null,
      labour_hours: null,
      travel_hours: Math.round((travelMinutes / 60) * 100) / 100,
      errors: fieldosUniqueMessages_(errors),
      warnings: warnings
    };
  }

  if (finish <= start) {
    errors.push("finish_time must be after start_time (overnight shifts are not supported).");
    return {
      ok: false,
      gross_minutes: null,
      net_labour_minutes: null,
      labour_hours: null,
      travel_hours: Math.round((travelMinutes / 60) * 100) / 100,
      errors: fieldosUniqueMessages_(errors),
      warnings: fieldosUniqueMessages_(warnings)
    };
  }

  const gross = finish - start;
  if (breakMinutes > gross) {
    errors.push("Break minutes cannot exceed gross shift duration.");
  }
  const net = Math.max(0, gross - Math.max(0, breakMinutes));
  const labourHours = Math.round((net / 60) * 100) / 100;
  const travelHours = Math.round((Math.max(0, travelMinutes) / 60) * 100) / 100;

  if (gross / 60 > maxShiftHours) {
    warnings.push("Shift exceeds " + maxShiftHours + " hours.");
  }

  return {
    ok: errors.length === 0,
    gross_minutes: gross,
    net_labour_minutes: net,
    labour_hours: labourHours,
    travel_hours: travelHours,
    errors: fieldosUniqueMessages_(errors),
    warnings: fieldosUniqueMessages_(warnings)
  };
}

/** Stable warning key for resolve / override gating. */
function fieldosWarningKey_(text) {
  const t = String(text || "").toLowerCase();
  if (/contradictory lunch|confirm unpaid break/.test(t)) return "contradictory_lunch";
  if (/multiple lunch\/break|confirm break_minutes/.test(t)) return "break_minutes_confirm";
  if (/incomplete sentence|incomplete|fragment/.test(t)) return "incomplete_fragments";
  if (/all day/.test(t)) return "all_day_unconfirmed";
  return "warning:" + t.replace(/\s+/g, " ").trim().slice(0, 80);
}

function fieldosIsResolvableBreakWarning_(text) {
  const key = fieldosWarningKey_(text);
  return key === "contradictory_lunch" || key === "break_minutes_confirm";
}

function fieldosIsNonCriticalAckWarning_(text) {
  if (fieldosIsResolvableBreakWarning_(text)) return false;
  const key = fieldosWarningKey_(text);
  return key === "incomplete_fragments" || key === "all_day_unconfirmed";
}

function fieldosUniqueMessages_(messages) {
  const seen = {};
  const out = [];
  (messages || []).forEach(function (m) {
    const t = String(m || "").trim();
    if (!t || seen[t]) return;
    seen[t] = true;
    out.push(t);
  });
  return out;
}

/**
 * Find a resolution for a warning text / key.
 * Resolutions: [{ warning_key, warning_text, resolved, break_minutes, resolution_note, ... }]
 */
function fieldosFindWarningResolution_(resolutions, warningText) {
  const key = fieldosWarningKey_(warningText);
  const list = Array.isArray(resolutions) ? resolutions : [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i] || {};
    const rowKey = String(row.warning_key || "").trim() || fieldosWarningKey_(row.warning_text);
    if (rowKey === key) return row;
  }
  return null;
}

function fieldosIsBreakWarningResolved_(resolutions, warningText) {
  const row = fieldosFindWarningResolution_(resolutions, warningText);
  if (!row || !row.resolved) return false;
  const breakMinutes = row.break_minutes;
  if (breakMinutes == null || breakMinutes === "") return false;
  const n = Number(breakMinutes);
  return Number.isFinite(n) && n >= 0;
}

function fieldosComputeMachineryDurationHours_(entry) {
  const errors = [];
  const warnings = [];
  if (entry && entry.duration_hours != null && entry.duration_hours !== "") {
    const h = Number(entry.duration_hours);
    if (!Number.isFinite(h) || h < 0) {
      errors.push("duration_hours must be a non-negative number.");
      return { ok: false, duration_hours: null, errors: errors, warnings: warnings };
    }
    return {
      ok: true,
      duration_hours: Math.round(h * 100) / 100,
      errors: errors,
      warnings: warnings
    };
  }
  const start = fieldosParseTimeToMinutes_(entry && entry.start_time);
  const finish = fieldosParseTimeToMinutes_(entry && entry.finish_time);
  if (start == null || finish == null) {
    warnings.push("Machinery duration incomplete (need duration_hours or start/finish).");
    return { ok: true, duration_hours: null, errors: errors, warnings: warnings };
  }
  if (finish <= start) {
    errors.push("Machinery finish_time must be after start_time.");
    return { ok: false, duration_hours: null, errors: errors, warnings: warnings };
  }
  return {
    ok: true,
    duration_hours: Math.round(((finish - start) / 60) * 100) / 100,
    errors: errors,
    warnings: warnings
  };
}

function fieldosIsExcludedRow_(row) {
  return String((row && row.confirmation_status) || "").trim() === FIELDOS_ROW_CONFIRMATION_.EXCLUDED;
}

function fieldosIsConfirmedRow_(row) {
  return String((row && row.confirmation_status) || "").trim() === FIELDOS_ROW_CONFIRMATION_.CONFIRMED;
}

function fieldosIsSuggestedRow_(row) {
  const s = String((row && row.confirmation_status) || "").trim();
  return !s || s === FIELDOS_ROW_CONFIRMATION_.SUGGESTED;
}

/**
 * Server-side totals from row arrays. Never trusts client totals.
 */
function fieldosComputeCompletionTotals_(labourEntries, machineryEntries) {
  let totalLabourMinutes = 0;
  let totalTravelMinutes = 0;
  let billableLabourMinutes = 0;
  let nonBillableLabourMinutes = 0;
  let totalMachineryHours = 0;
  const errors = [];
  const warnings = [];

  (labourEntries || []).forEach(function (row, idx) {
    if (fieldosIsExcludedRow_(row)) return;
    const calc = fieldosComputeLabourEntry_(row);
    calc.errors.forEach(function (e) {
      errors.push("labour[" + idx + "]: " + e);
    });
    calc.warnings.forEach(function (w) {
      warnings.push("labour[" + idx + "]: " + w);
    });
    if (calc.net_labour_minutes == null) return;
    totalLabourMinutes += calc.net_labour_minutes;
    const travel = Number(row.travel_minutes) || 0;
    totalTravelMinutes += travel > 0 ? travel : 0;
    if (row.billable === true || row.billable === "TRUE" || row.billable === "true") {
      billableLabourMinutes += calc.net_labour_minutes;
    } else {
      nonBillableLabourMinutes += calc.net_labour_minutes;
    }
  });

  (machineryEntries || []).forEach(function (row, idx) {
    if (fieldosIsExcludedRow_(row)) return;
    const calc = fieldosComputeMachineryDurationHours_(row);
    calc.errors.forEach(function (e) {
      errors.push("machinery[" + idx + "]: " + e);
    });
    calc.warnings.forEach(function (w) {
      warnings.push("machinery[" + idx + "]: " + w);
    });
    if (calc.duration_hours != null) totalMachineryHours += calc.duration_hours;
  });

  function hoursFromMinutes(m) {
    return Math.round((m / 60) * 100) / 100;
  }

  return {
    ok: errors.length === 0,
    total_labour_hours: hoursFromMinutes(totalLabourMinutes),
    total_travel_hours: hoursFromMinutes(totalTravelMinutes),
    total_machinery_hours: Math.round(totalMachineryHours * 100) / 100,
    billable_labour_hours: hoursFromMinutes(billableLabourMinutes),
    non_billable_labour_hours: hoursFromMinutes(nonBillableLabourMinutes),
    errors: errors,
    warnings: warnings
  };
}

/**
 * Sanitised audit payload — never includes transcript, notes body, secrets.
 */
function fieldosCompletionAuditPayload_(meta) {
  return {
    action: meta.action || "",
    job_sheet_id: meta.job_sheet_id || "",
    completion_id: meta.completion_id || "",
    actor_staff_id: meta.actor_staff_id || "",
    actor_role: meta.actor_role || "",
    previous_completion_status: meta.previous_completion_status || "",
    new_completion_status: meta.new_completion_status || "",
    fields_changed: meta.fields_changed || [],
    labour_count: meta.labour_count != null ? meta.labour_count : null,
    machinery_count: meta.machinery_count != null ? meta.machinery_count : null,
    material_count: meta.material_count != null ? meta.material_count : null,
    version: meta.version != null ? meta.version : null,
    reopen_reason_present: !!meta.reopen_reason_present,
    override_reason_present: !!meta.override_reason_present,
    correlation_id: meta.correlation_id || ""
  };
}

/**
 * Detect contradictory lunch / incomplete fragments in approved text sources.
 */
function fieldosCompletionSourceWarnings_(job) {
  const warnings = [];
  const transcript = String((job && job.ai_transcript) || "");
  const reviewItems = String((job && job.manager_review_items) || "");
  const summary = String((job && job.ai_summary) || "");
  const blob = (transcript + "\n" + reviewItems + "\n" + summary).toLowerCase();

  const lunchMentions = (blob.match(/lunch/g) || []).length;
  if (lunchMentions >= 2) {
    const hasNoLunch = /no\s+lunch|didn't\s+have\s+lunch|did\s+not\s+have\s+lunch|skipped\s+lunch/.test(blob);
    const hasHadLunch = /had\s+(a\s+)?lunch|took\s+(a\s+)?lunch|lunch\s+break/.test(blob);
    if (hasNoLunch && hasHadLunch) {
      warnings.push("Contradictory lunch information in source text — confirm unpaid break manually.");
    } else if (lunchMentions >= 2 && /break/.test(blob)) {
      warnings.push("Multiple lunch/break references — confirm break_minutes manually.");
    }
  }

  if (/incomplete|fragment|unclear|\[cut\]|\.\.\./i.test(reviewItems) || /incomplete sentence/i.test(blob)) {
    warnings.push("Incomplete sentence fragments flagged in manager review items.");
  }

  if (/\ball\s+day\b/i.test(blob) && !/\d{1,2}:\d{2}/.test(blob)) {
    warnings.push('"All day" mentioned without confirmed clock times — do not invent duration.');
  }

  return warnings;
}

/**
 * Candidate draft from approved job fields. Never fabricates staff IDs beyond assignment.
 * Never invents rates/prices. Materials/machinery only when clearly present in text.
 */
function fieldosBuildCompletionDraftFromJob_(job, options) {
  const opts = options || {};
  const warnings = fieldosCompletionSourceWarnings_(job);
  const staffId = String((job && (job.assigned_staff_id || job.staff_id)) || "").trim();
  const staffName = String(opts.staff_name || "").trim();
  const workDate = String((job && (job.job_date || job.date)) || "").trim().slice(0, 10);
  const summary = String((job && job.ai_summary) || "").trim();
  const variationsRaw = String((job && job.variations) || "").trim();
  const travelRaw = String((job && job.travel_time) || "").trim();

  const labourEntries = [];
  if (staffId || staffName || summary) {
    labourEntries.push({
      staff_name: staffName,
      staff_id: staffId,
      work_date: workDate,
      start_time: "",
      finish_time: "",
      break_minutes: 0,
      labour_hours: null,
      travel_minutes: 0,
      travel_hours: 0,
      role_or_activity: "",
      billable: false,
      confirmation_status: FIELDOS_ROW_CONFIRMATION_.SUGGESTED,
      notes: "",
      source: "ai_draft",
      confidence: staffId ? 0.4 : 0.2
    });
    warnings.push("Labour times are unconfirmed — enter start/finish and break before finalising.");
  }

  if (travelRaw) {
    warnings.push("Job travel_time text present ('" + travelRaw.slice(0, 80) + "') — enter travel_minutes explicitly; do not assume billable.");
  }

  const machineryEntries = [];
  const materialEntries = [];
  const blob = [
    summary,
    String((job && job.client_requests) || ""),
    variationsRaw,
    String((job && job.ai_transcript) || "")
  ].join("\n");

  const treeMatch = /(\d+|seven|six|five|four|three|two|one)\s+trees?\b/i.exec(blob);
  if (treeMatch) {
    const wordMap = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7
    };
    const rawQty = String(treeMatch[1]).toLowerCase();
    const qty = wordMap[rawQty] != null ? wordMap[rawQty] : Number(rawQty);
    if (Number.isFinite(qty) && qty > 0) {
      materialEntries.push({
        item_name: "Trees (supply and planting)",
        quantity: qty,
        unit: "each",
        billable: false,
        confirmation_status: FIELDOS_ROW_CONFIRMATION_.SUGGESTED,
        notes: "Suggested from approved job text — confirm before finalising.",
        source: "ai_draft",
        confidence: 0.55
      });
    }
  }

  if (/earthworks|driveway|reshape|excavator|bobcat|skid\s*steer/i.test(blob)) {
    machineryEntries.push({
      equipment_name: /excavator/i.test(blob)
        ? "Excavator"
        : /bobcat|skid\s*steer/i.test(blob)
          ? "Skid steer"
          : "Earthmoving equipment",
      operator_staff_id: staffId || "",
      start_time: "",
      finish_time: "",
      duration_hours: null,
      billable: false,
      charge_code: "",
      confirmation_status: FIELDOS_ROW_CONFIRMATION_.SUGGESTED,
      notes: "Suggested from approved job text — confirm duration and billable flag.",
      source: "ai_draft",
      confidence: 0.45
    });
  }

  const variations = variationsRaw
    ? variationsRaw.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean)
    : [];

  let invoiceDescription = "";
  if (summary) {
    invoiceDescription = summary.replace(/\s+/g, " ").trim();
    if (invoiceDescription.length > 280) {
      invoiceDescription = invoiceDescription.slice(0, 277) + "...";
    }
  }

  return {
    work_summary: summary,
    invoice_description: invoiceDescription,
    internal_notes: "",
    labour_entries: labourEntries,
    machinery_entries: machineryEntries,
    material_entries: materialEntries,
    variations: variations,
    warnings: warnings,
    overall_confidence: materialEntries.length || machineryEntries.length ? 0.5 : 0.35
  };
}

/**
 * Finalisation gate checks. Returns { ok, criticalErrors, nonCriticalWarnings }.
 * Critical arithmetic / missing times cannot be overridden.
 * Lunch/break contradictions require explicit resolution (verified break_minutes).
 * Other non-critical ack warnings require override_reason when still unresolved.
 */
function fieldosValidateCompletionForFinalise_(completion, job, options) {
  const opts = options || {};
  const critical = [];
  const nonCritical = [];
  const status = String((job && job.approval_status) || "").trim();
  const processing = String((job && job.processing_status) || "").trim();
  const resolutions =
    (completion && completion.warning_resolutions) ||
    opts.warning_resolutions ||
    [];

  if (status !== "Approved") {
    critical.push("Job approval_status must be Approved to finalise.");
  }
  if (processing !== "Completed") {
    critical.push("Job processing_status must be Completed to finalise.");
  }

  const completionStatus = String((completion && completion.completion_status) || "").trim();
  if (completionStatus === FIELDOS_COMPLETION_STATUSES_.FINALISED) {
    critical.push("Completion is already Finalised.");
  }

  const workSummary = String((completion && completion.work_summary) || "").trim();
  const invoiceDescription = String((completion && completion.invoice_description) || "").trim();
  if (!workSummary) critical.push("work_summary is required.");
  if (!invoiceDescription) critical.push("invoice_description is required.");

  const labour = (completion && completion.labour_entries) || [];
  const machinery = (completion && completion.machinery_entries) || [];
  const materials = (completion && completion.material_entries) || [];

  labour.forEach(function (row, idx) {
    if (fieldosIsExcludedRow_(row)) return;
    if (fieldosIsSuggestedRow_(row)) {
      critical.push("labour[" + idx + "] is still Suggested — confirm or exclude before finalising.");
    }
    const calc = fieldosComputeLabourEntry_(row);
    calc.errors.forEach(function (e) {
      critical.push("labour[" + idx + "]: " + e);
    });
    // Do NOT add a second "start/finish required" when calc already reported field errors.
    calc.warnings.forEach(function (w) {
      nonCritical.push("labour[" + idx + "]: " + w);
    });
  });

  machinery.forEach(function (row, idx) {
    if (fieldosIsExcludedRow_(row)) return;
    if (fieldosIsSuggestedRow_(row)) {
      critical.push("machinery[" + idx + "] is still Suggested — confirm or exclude before finalising.");
    }
    const calc = fieldosComputeMachineryDurationHours_(row);
    calc.errors.forEach(function (e) {
      critical.push("machinery[" + idx + "]: " + e);
    });
  });

  materials.forEach(function (row, idx) {
    if (fieldosIsExcludedRow_(row)) return;
    if (fieldosIsSuggestedRow_(row)) {
      critical.push("material[" + idx + "] is still Suggested — confirm or exclude before finalising.");
    }
    if (!String(row.item_name || "").trim()) {
      critical.push("material[" + idx + "]: item_name is required.");
    }
  });

  // Totals recompute hours only — do not re-push the same labour/machinery field errors.
  const totals = fieldosComputeCompletionTotals_(labour, machinery);

  const existingWarnings = Array.isArray(completion && completion.warnings)
    ? completion.warnings
    : [];
  existingWarnings.forEach(function (w) {
    const text = String(w || "").trim();
    if (text) nonCritical.push(text);
  });

  const unresolvedBreak = [];
  existingWarnings.forEach(function (w) {
    const text = String(w || "").trim();
    if (!text || !fieldosIsResolvableBreakWarning_(text)) return;
    if (!fieldosIsBreakWarningResolved_(resolutions, text)) {
      unresolvedBreak.push(text);
    }
  });
  if (unresolvedBreak.length) {
    critical.push(
      "Resolve lunch/break contradiction by confirming break minutes: " +
        unresolvedBreak.join("; ")
    );
  }

  // Override is only for unresolved non-critical ack warnings — never arithmetic/time.
  const overrideReason = String(opts.override_reason || "").trim();
  const needsAck = existingWarnings.filter(function (w) {
    return fieldosIsNonCriticalAckWarning_(w);
  });
  if (needsAck.length && !overrideReason) {
    critical.push(
      "Unresolved non-critical warnings require override_reason: " + needsAck.join("; ")
    );
  }

  return {
    ok: fieldosUniqueMessages_(critical).length === 0,
    criticalErrors: fieldosUniqueMessages_(critical),
    nonCriticalWarnings: fieldosUniqueMessages_(nonCritical),
    totals: totals
  };
}
