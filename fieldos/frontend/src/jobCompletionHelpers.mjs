/** Phase 3C job completion helpers (Node + browser). */

export const COMPLETION_STATUSES = {
  DRAFT: "Draft",
  READY: "Ready for Final Review",
  FINALISED: "Finalised",
  REOPENED: "Reopened",
};

export const ROW_CONFIRMATION = {
  SUGGESTED: "Suggested",
  CONFIRMED: "Confirmed",
  EXCLUDED: "Excluded",
};

export const DEFAULT_TIMEZONE = "Australia/Sydney";

function padClock(hours, minutes) {
  const h = Number(hours);
  const m = Number(minutes);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Canonical HH:MM for <input type="time"> and validation.
 * Accepts HH:MM, H:MM, Date, ISO datetime, Sheets fraction.
 * Rejects ambiguous free text.
 */
export function normaliseClockTime(value, timezoneName = DEFAULT_TIMEZONE) {
  if (value == null || value === "") return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezoneName,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(value);
      const hour = parts.find((p) => p.type === "hour");
      const minute = parts.find((p) => p.type === "minute");
      if (hour && minute) return padClock(Number(hour.value), Number(minute.value));
    } catch {
      return padClock(value.getHours(), value.getMinutes());
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 0 && value < 1) {
      const totalMinutes = Math.round(value * 24 * 60) % (24 * 60);
      return padClock(Math.floor(totalMinutes / 60), totalMinutes % 60);
    }
    return null;
  }

  const s = String(value).trim();
  if (!s) return null;

  const hm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (hm) return padClock(Number(hm[1]), Number(hm[2]));

  if (
    /^(morning|afternoon|evening|noon|midnight|all\s*day)$/i.test(s) ||
    /^\d{1,2}\s*(am|pm)\b/i.test(s) ||
    /\d\s*(am|pm)\s*to\s*/i.test(s) ||
    /to\s*\d/i.test(s) ||
    /ish/i.test(s) ||
    /^\d{1,2}$/.test(s)
  ) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const epoch = /^(1899|1900)-\d{2}-\d{2}T([01]\d|2[0-3]):([0-5]\d)/.exec(s);
    if (epoch && /Z$/i.test(s)) {
      return padClock(Number(epoch[2]), Number(epoch[3]));
    }
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) {
      return normaliseClockTime(parsed, timezoneName);
    }
    return null;
  }

  const locale = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/.exec(s);
  if (
    locale &&
    /(?:GMT|UTC|1899|1900|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(s)
  ) {
    return padClock(Number(locale[1]), Number(locale[2]));
  }

  return null;
}

export function describeClockTime(value, timezoneName = DEFAULT_TIMEZONE) {
  let type = "null";
  if (value === undefined) type = "undefined";
  else if (value === null) type = "null";
  else if (value === "") type = "empty_string";
  else if (value instanceof Date) type = "Date";
  else type = typeof value;
  const normalised = normaliseClockTime(value, timezoneName);
  return { type, normalised, ok: Boolean(normalised) };
}

function canonicalClockOrEmpty(value) {
  if (value == null || value === "") return "";
  return normaliseClockTime(value) || "";
}

export function emptyLabourRow() {
  return {
    staff_id: "",
    staff_name: "",
    work_date: "",
    start_time: "",
    finish_time: "",
    break_minutes: 0,
    travel_minutes: 0,
    role_or_activity: "",
    billable: false,
    confirmation_status: ROW_CONFIRMATION.SUGGESTED,
    notes: "",
    source: "manual",
  };
}

export function emptyMachineryRow() {
  return {
    equipment_name: "",
    operator_staff_id: "",
    start_time: "",
    finish_time: "",
    duration_hours: "",
    billable: false,
    confirmation_status: ROW_CONFIRMATION.SUGGESTED,
    charge_code: "",
    notes: "",
    source: "manual",
  };
}

export function emptyMaterialRow() {
  return {
    item_name: "",
    quantity: "",
    unit: "",
    billable: false,
    confirmation_status: ROW_CONFIRMATION.SUGGESTED,
    notes: "",
    source: "manual",
  };
}

/**
 * Normalise material quantity for client validation / display.
 * Mirrors Apps Script fieldosNormaliseMaterialQuantity_.
 */
export function normaliseMaterialQuantity(raw, options = {}) {
  const existingUnit = String(options.unit || "");
  if (raw === null || raw === undefined) {
    return { ok: true, quantity: null, unit: existingUnit, blank: true };
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      return { ok: false, quantity: null, unit: existingUnit, error: "non_numeric", raw: String(raw) };
    }
    return { ok: true, quantity: raw, unit: existingUnit, blank: false };
  }
  const s = String(raw).trim();
  if (!s) {
    return { ok: true, quantity: null, unit: existingUnit, blank: true };
  }
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) {
    return { ok: true, quantity: Number(s), unit: existingUnit, blank: false };
  }
  const withUnit = /^([+-]?\d+(?:\.\d+)?)\s+([A-Za-z][A-Za-z0-9/%._-]*)\s*$/.exec(s);
  if (withUnit) {
    const qty = Number(withUnit[1]);
    if (!Number.isFinite(qty)) {
      return { ok: false, quantity: null, unit: existingUnit, error: "non_numeric", raw: s };
    }
    return {
      ok: true,
      quantity: qty,
      unit: existingUnit || String(withUnit[2]),
      blank: false,
    };
  }
  return { ok: false, quantity: null, unit: existingUnit, error: "non_numeric", raw: s };
}

/** Parse "Material row N quantity must be a number/numeric." → 0-based index or null. */
export function parseMaterialQuantityRowError(message) {
  const m = /Material row\s+(\d+)\s+quantity must be (?:a number|numeric)/i.exec(String(message || ""));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return null;
  return n - 1;
}

/** Parse any "Labour|Machinery|Material row N <field> must be a number." */
export function parseCompletionNumericFieldError(message) {
  const m =
    /(Labour|Machinery|Material) row\s+(\d+)\s+([a-z0-9_ ]+?)\s+must be (?:a number|numeric)/i.exec(
      String(message || "")
    );
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const row = Number(m[2]) - 1;
  const field = String(m[3] || "")
    .trim()
    .replace(/\s+/g, "_");
  if (!Number.isFinite(row) || row < 0) return null;
  const prefix =
    kind === "labour" ? "lab" : kind === "machinery" ? "mch" : "mat";
  const focusId =
    field === "quantity"
      ? `${prefix}-qty-${row}`
      : field.includes("duration")
        ? `${prefix}-hours-${row}`
        : field.includes("break")
          ? `${prefix}-break-${row}`
          : field.includes("travel")
            ? `${prefix}-travel-${row}`
            : field.includes("labour_hours") || field === "hours"
              ? `${prefix}-hours-${row}`
              : null;
  return { kind, row, field, focusId };
}

export function materialFieldErrors(row) {
  const errors = {};
  if (!row || row.confirmation_status === ROW_CONFIRMATION.EXCLUDED) return errors;
  const normalised = normaliseMaterialQuantity(row.quantity, { unit: row.unit || "" });
  if (!normalised.ok) {
    errors.quantity = "Quantity must be a number.";
  }
  return errors;
}

export function collectMaterialValidationMessages(form) {
  const messages = [];
  (form?.material_entries || []).forEach((row, index) => {
    const errors = materialFieldErrors(row);
    if (errors.quantity) {
      messages.push(`Material row ${index + 1} quantity must be a number.`);
    }
  });
  return messages;
}

/**
 * Optional numeric: blank → null. Never Number(""). Rejects arbitrary text.
 */
export function normaliseOptionalNumber(raw) {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null, blank: true };
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      return { ok: false, value: null, blank: false, raw: String(raw) };
    }
    return { ok: true, value: raw, blank: false };
  }
  const s = String(raw).trim();
  if (!s) {
    return { ok: true, value: null, blank: true };
  }
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) {
    return { ok: true, value: Number(s), blank: false };
  }
  return { ok: false, value: null, blank: false, raw: s };
}

/**
 * Required numeric with default (break/travel minutes). Blank → default. Zero stays zero.
 */
export function normaliseNumberWithDefault(raw, defaultValue = 0) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return { ok: true, value: defaultValue, blank: true };
  }
  const n = normaliseOptionalNumber(raw);
  if (!n.ok) return n;
  return { ok: true, value: n.value == null ? defaultValue : n.value, blank: false };
}

/**
 * Build PATCH/POST body with normalised numerics. Does not mutate form.
 * Invalid text blocks submission (ok: false) without calling the API.
 */
export function buildCompletionSavePayload(form, extra = {}) {
  const errors = [];
  const labour_entries = (form?.labour_entries || []).map((row, index) => {
    const breakN = normaliseNumberWithDefault(row.break_minutes, 0);
    const travelN = normaliseNumberWithDefault(row.travel_minutes, 0);
    const hoursN = normaliseOptionalNumber(row.labour_hours);
    const travelHoursN = normaliseOptionalNumber(row.travel_hours);
    const confidenceN = normaliseOptionalNumber(row.confidence);
    if (!breakN.ok) {
      errors.push({
        kind: "labour",
        row: index,
        field: "break_minutes",
        message: `Labour row ${index + 1} break minutes must be a number.`,
        focusId: `lab-break-${index}`,
      });
    }
    if (!travelN.ok) {
      errors.push({
        kind: "labour",
        row: index,
        field: "travel_minutes",
        message: `Labour row ${index + 1} travel minutes must be a number.`,
        focusId: `lab-travel-${index}`,
      });
    }
    if (!hoursN.ok) {
      errors.push({
        kind: "labour",
        row: index,
        field: "labour_hours",
        message: `Labour row ${index + 1} labour hours must be a number.`,
        focusId: `lab-hours-${index}`,
      });
    }
    if (!travelHoursN.ok) {
      errors.push({
        kind: "labour",
        row: index,
        field: "travel_hours",
        message: `Labour row ${index + 1} travel hours must be a number.`,
        focusId: `lab-travel-${index}`,
      });
    }
    if (!confidenceN.ok) {
      errors.push({
        kind: "labour",
        row: index,
        field: "confidence",
        message: `Labour row ${index + 1} confidence must be a number.`,
        focusId: null,
      });
    }
    return {
      ...row,
      break_minutes: breakN.ok ? breakN.value : row.break_minutes,
      travel_minutes: travelN.ok ? travelN.value : row.travel_minutes,
      labour_hours: hoursN.ok ? hoursN.value : row.labour_hours,
      travel_hours: travelHoursN.ok ? travelHoursN.value : row.travel_hours,
      confidence: confidenceN.ok ? confidenceN.value : row.confidence,
    };
  });

  const machinery_entries = (form?.machinery_entries || []).map((row, index) => {
    const durationN = normaliseOptionalNumber(row.duration_hours);
    const confidenceN = normaliseOptionalNumber(row.confidence);
    if (!durationN.ok) {
      errors.push({
        kind: "machinery",
        row: index,
        field: "duration_hours",
        message: `Machinery row ${index + 1} duration hours must be a number.`,
        focusId: `mch-hours-${index}`,
      });
    }
    if (!confidenceN.ok) {
      errors.push({
        kind: "machinery",
        row: index,
        field: "confidence",
        message: `Machinery row ${index + 1} confidence must be a number.`,
        focusId: null,
      });
    }
    return {
      ...row,
      duration_hours: durationN.ok ? durationN.value : row.duration_hours,
      confidence: confidenceN.ok ? confidenceN.value : row.confidence,
    };
  });

  const material_entries = (form?.material_entries || []).map((row, index) => {
    const qtyN = normaliseMaterialQuantity(row.quantity, { unit: row.unit || "" });
    const unitCostN = normaliseOptionalNumber(row.unit_cost);
    const totalCostN = normaliseOptionalNumber(row.total_cost);
    const confidenceN = normaliseOptionalNumber(row.confidence);
    if (!qtyN.ok) {
      errors.push({
        kind: "material",
        row: index,
        field: "quantity",
        message: `Material row ${index + 1} quantity must be a number.`,
        focusId: `mat-qty-${index}`,
      });
    }
    if (!unitCostN.ok) {
      errors.push({
        kind: "material",
        row: index,
        field: "unit_cost",
        message: `Material row ${index + 1} unit cost must be a number.`,
        focusId: null,
      });
    }
    if (!totalCostN.ok) {
      errors.push({
        kind: "material",
        row: index,
        field: "total_cost",
        message: `Material row ${index + 1} total cost must be a number.`,
        focusId: null,
      });
    }
    if (!confidenceN.ok) {
      errors.push({
        kind: "material",
        row: index,
        field: "confidence",
        message: `Material row ${index + 1} confidence must be a number.`,
        focusId: null,
      });
    }
    const next = {
      ...row,
      quantity: qtyN.ok ? qtyN.quantity : row.quantity,
      unit: qtyN.ok ? qtyN.unit : row.unit,
      confidence: confidenceN.ok ? confidenceN.value : row.confidence,
    };
    if (Object.prototype.hasOwnProperty.call(row, "unit_cost")) {
      next.unit_cost = unitCostN.ok ? unitCostN.value : row.unit_cost;
    }
    if (Object.prototype.hasOwnProperty.call(row, "total_cost")) {
      next.total_cost = totalCostN.ok ? totalCostN.value : row.total_cost;
    }
    return next;
  });

  if (errors.length) {
    return { ok: false, errors, payload: null };
  }

  const payload = {
    ...form,
    labour_entries,
    machinery_entries,
    material_entries,
    ...extra,
  };
  return { ok: true, errors: [], payload };
}

export function buildCompletionForm(data) {
  const c = data?.completion || {};
  return {
    work_summary: c.work_summary || "",
    invoice_description: c.invoice_description || "",
    internal_notes: c.internal_notes || "",
    completion_status: c.completion_status || COMPLETION_STATUSES.DRAFT,
    variations: Array.isArray(c.variations) ? c.variations.slice() : [],
    warnings: Array.isArray(c.warnings) ? c.warnings.slice() : [],
    warning_resolutions: Array.isArray(c.warning_resolutions)
      ? c.warning_resolutions.map((row) => ({ ...row }))
      : [],
    labour_entries: (data?.labour_entries || []).map((row) => ({
      ...row,
      start_time: canonicalClockOrEmpty(row.start_time),
      finish_time: canonicalClockOrEmpty(row.finish_time),
    })),
    machinery_entries: (data?.machinery_entries || []).map((row) => ({
      ...row,
      start_time: canonicalClockOrEmpty(row.start_time),
      finish_time: canonicalClockOrEmpty(row.finish_time),
    })),
    material_entries: (data?.material_entries || []).map((row) => ({ ...row })),
  };
}

export const EMPTY_COMPLETION_FORM = buildCompletionForm({});

export function completionHasUnsavedChanges(form, baseline) {
  return JSON.stringify(form) !== JSON.stringify(baseline);
}

/** Display hours from start/finish/break without trusting stored labour_hours. */
export function displayLabourHours(row) {
  const start = parseTime(normaliseClockTime(row?.start_time) || row?.start_time);
  const finish = parseTime(normaliseClockTime(row?.finish_time) || row?.finish_time);
  if (start == null || finish == null || finish <= start) return null;
  const breakMinutes = Number(row?.break_minutes) || 0;
  if (breakMinutes < 0 || breakMinutes > finish - start) return null;
  return Math.round(((finish - start - breakMinutes) / 60) * 100) / 100;
}

function parseTime(value) {
  const normalised = normaliseClockTime(value);
  if (!normalised) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(normalised);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function warningKey(text) {
  const t = String(text || "").toLowerCase();
  if (/contradictory lunch|confirm unpaid break/.test(t)) return "contradictory_lunch";
  if (/multiple lunch\/break|confirm break_minutes/.test(t)) return "break_minutes_confirm";
  if (/incomplete sentence|incomplete|fragment/.test(t)) return "incomplete_fragments";
  if (/all day/.test(t)) return "all_day_unconfirmed";
  return `warning:${t.replace(/\s+/g, " ").trim().slice(0, 80)}`;
}

export function isResolvableBreakWarning(text) {
  const key = warningKey(text);
  return key === "contradictory_lunch" || key === "break_minutes_confirm";
}

export function isNonCriticalAckWarning(text) {
  if (isResolvableBreakWarning(text)) return false;
  const key = warningKey(text);
  return key === "incomplete_fragments" || key === "all_day_unconfirmed";
}

export function findWarningResolution(resolutions, warningText) {
  const key = warningKey(warningText);
  for (const row of resolutions || []) {
    const rowKey = String(row?.warning_key || "").trim() || warningKey(row?.warning_text);
    if (rowKey === key) return row;
  }
  return null;
}

export function isBreakWarningResolved(resolutions, warningText) {
  const row = findWarningResolution(resolutions, warningText);
  if (!row || !row.resolved) return false;
  if (row.break_minutes == null || row.break_minutes === "") return false;
  const n = Number(row.break_minutes);
  return Number.isFinite(n) && n >= 0;
}

/**
 * Field-level labour errors for inline UI.
 * Blank → required only. Non-empty invalid → "Use HH:MM." only.
 */
export function labourFieldErrors(row) {
  const errors = {};
  if (!row || row.confirmation_status === ROW_CONFIRMATION.EXCLUDED) return errors;

  const startRaw = row.start_time;
  const finishRaw = row.finish_time;
  const startNorm = startRaw == null || startRaw === "" ? null : normaliseClockTime(startRaw);
  const finishNorm = finishRaw == null || finishRaw === "" ? null : normaliseClockTime(finishRaw);
  const start = startNorm ? parseTime(startNorm) : null;
  const finish = finishNorm ? parseTime(finishNorm) : null;

  if (startRaw == null || String(startRaw).trim() === "") {
    errors.start_time = "Start time is required.";
  } else if (start == null) {
    errors.start_time = "Use HH:MM.";
  }

  if (finishRaw == null || String(finishRaw).trim() === "") {
    errors.finish_time = "Finish time is required.";
  } else if (finish == null) {
    errors.finish_time = "Use HH:MM.";
  }

  const breakRaw = row.break_minutes;
  let breakMinutes = 0;
  if (breakRaw !== "" && breakRaw != null) {
    breakMinutes = Number(breakRaw);
    if (!Number.isFinite(breakMinutes)) {
      errors.break_minutes = "Break minutes must be a number.";
    } else if (breakMinutes < 0) {
      errors.break_minutes = "Break minutes cannot be negative.";
    } else if (start != null && finish != null && finish > start && breakMinutes > finish - start) {
      errors.break_minutes = "Break minutes cannot exceed gross shift duration.";
    }
  }

  const conf = String(row.confirmation_status || "").trim();
  if (!conf || conf === ROW_CONFIRMATION.SUGGESTED) {
    errors.confirmation_status = "Confirm or exclude before finalising.";
  }

  return errors;
}

/** Deduped validation messages for a form (no duplicate field rules). */
export function collectLabourValidationMessages(form) {
  const messages = [];
  const seen = new Set();
  (form?.labour_entries || []).forEach((row, idx) => {
    if (row.confirmation_status === ROW_CONFIRMATION.EXCLUDED) return;
    const fieldErrors = labourFieldErrors(row);
    Object.entries(fieldErrors).forEach(([field, message]) => {
      const text = `labour[${idx}].${field}: ${message}`;
      if (seen.has(text)) return;
      seen.add(text);
      messages.push(text);
    });
  });
  return messages;
}

export function upsertBreakWarningResolution(resolutions, warningText, { breakMinutes, resolutionNote = "" }) {
  const key = warningKey(warningText);
  const next = (resolutions || []).map((row) => ({ ...row }));
  const idx = next.findIndex(
    (row) => (String(row.warning_key || "").trim() || warningKey(row.warning_text)) === key
  );
  const entry = {
    warning_key: key,
    warning_text: String(warningText || ""),
    resolved: true,
    break_minutes: Number(breakMinutes),
    resolution_note: String(resolutionNote || "").trim(),
  };
  if (idx >= 0) next[idx] = { ...next[idx], ...entry };
  else next.push(entry);
  return next;
}

export function canFinaliseClient(form) {
  if (!String(form.work_summary || "").trim()) return false;
  if (!String(form.invoice_description || "").trim()) return false;
  for (const row of form.labour_entries || []) {
    if (row.confirmation_status === ROW_CONFIRMATION.EXCLUDED) continue;
    const errors = labourFieldErrors(row);
    if (Object.keys(errors).length) return false;
    if (displayLabourHours(row) == null) return false;
  }
  for (const row of form.machinery_entries || []) {
    if (row.confirmation_status === ROW_CONFIRMATION.EXCLUDED) continue;
    if (!row.confirmation_status || row.confirmation_status === ROW_CONFIRMATION.SUGGESTED) {
      return false;
    }
  }
  for (const row of form.material_entries || []) {
    if (row.confirmation_status === ROW_CONFIRMATION.EXCLUDED) continue;
    if (!row.confirmation_status || row.confirmation_status === ROW_CONFIRMATION.SUGGESTED) {
      return false;
    }
  }
  for (const warning of form.warnings || []) {
    if (isResolvableBreakWarning(warning) && !isBreakWarningResolved(form.warning_resolutions, warning)) {
      return false;
    }
  }
  return true;
}

export function needsOverrideReason(form) {
  return (form.warnings || []).some((w) => isNonCriticalAckWarning(w));
}

export function isMobileFriendlyTableLayout(viewportWidth) {
  return Number(viewportWidth) < 720;
}
