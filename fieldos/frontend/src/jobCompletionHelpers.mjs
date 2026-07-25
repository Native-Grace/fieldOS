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

export function buildCompletionForm(data) {
  const c = data?.completion || {};
  return {
    work_summary: c.work_summary || "",
    invoice_description: c.invoice_description || "",
    internal_notes: c.internal_notes || "",
    completion_status: c.completion_status || COMPLETION_STATUSES.DRAFT,
    variations: Array.isArray(c.variations) ? c.variations.slice() : [],
    warnings: Array.isArray(c.warnings) ? c.warnings.slice() : [],
    labour_entries: (data?.labour_entries || []).map((row) => ({ ...row })),
    machinery_entries: (data?.machinery_entries || []).map((row) => ({ ...row })),
    material_entries: (data?.material_entries || []).map((row) => ({ ...row })),
  };
}

export const EMPTY_COMPLETION_FORM = buildCompletionForm({});

export function completionHasUnsavedChanges(form, baseline) {
  return JSON.stringify(form) !== JSON.stringify(baseline);
}

/** Display hours from start/finish/break without trusting stored labour_hours. */
export function displayLabourHours(row) {
  const start = parseTime(row?.start_time);
  const finish = parseTime(row?.finish_time);
  if (start == null || finish == null || finish <= start) return null;
  const breakMinutes = Number(row?.break_minutes) || 0;
  if (breakMinutes < 0 || breakMinutes > finish - start) return null;
  return Math.round(((finish - start - breakMinutes) / 60) * 100) / 100;
}

function parseTime(value) {
  if (!value) return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value).trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function canFinaliseClient(form) {
  if (!String(form.work_summary || "").trim()) return false;
  if (!String(form.invoice_description || "").trim()) return false;
  for (const row of form.labour_entries || []) {
    if (row.confirmation_status === ROW_CONFIRMATION.EXCLUDED) continue;
    if (!row.confirmation_status || row.confirmation_status === ROW_CONFIRMATION.SUGGESTED) {
      return false;
    }
    if (!row.start_time || !row.finish_time) return false;
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
  return true;
}

export function isMobileFriendlyTableLayout(viewportWidth) {
  return Number(viewportWidth) < 720;
}
