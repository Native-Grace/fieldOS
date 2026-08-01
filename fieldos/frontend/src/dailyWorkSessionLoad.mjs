/**
 * Daily Work — open-session load policy (pure, testable).
 * No automatic polling; callers decide when to fetch.
 */

export const OPEN_SESSIONS_REASONS = Object.freeze({
  INITIAL: "initial",
  REFRESH: "refresh",
  POST_CREATE: "post-create",
});

/**
 * @param {number} prev
 * @returns {number}
 */
export function nextOpenSessionsRequestId(prev) {
  return (Number(prev) || 0) + 1;
}

/**
 * Late responses must not overwrite wizard state.
 * @param {{ requestId: number, latestRequestId: number, aborted?: boolean }} args
 */
export function isStaleOpenSessionsResponse({ requestId, latestRequestId, aborted = false }) {
  if (aborted) return true;
  return Number(requestId) !== Number(latestRequestId);
}

/**
 * Auto-resume from sessionStorage only on the initial page load fetch.
 * @param {string} reason
 * @param {boolean} resumeRequested
 */
export function shouldAutoResumeOnOpenSessionsLoad(reason, resumeRequested) {
  return resumeRequested === true && reason === OPEN_SESSIONS_REASONS.INITIAL;
}

/**
 * Block overlapping open-session GETs (no parallel in-flight).
 * @param {boolean} inFlight
 * @param {string} reason
 */
export function shouldSkipOverlappingOpenSessionsFetch(inFlight, reason) {
  if (!inFlight) return false;
  // Allow initial/refresh only by aborting the prior request first (caller responsibility).
  // If still marked in-flight without abort, skip.
  void reason;
  return true;
}

/**
 * Draft form reset when user clicks Start new session.
 * @param {{ staff_id?: string, staff_name?: string } | null | undefined} staff
 * @param {() => string} todayISO
 */
export function buildStartNewSessionDetailsForm(staff, todayISO) {
  return {
    work_date: todayISO(),
    customer_name: "",
    project_id: "",
    project_name: "",
    staff_ids: staff?.staff_id ? [staff.staff_id] : [],
    staff_names: staff?.staff_name ? [staff.staff_name] : [],
    site_address: "",
    starting_note: "",
  };
}

/**
 * Development-safe open-session fetch log (no customer/project payloads).
 * @param {"start"|"end"|"skip"|"stale"} phase
 * @param {{ reason: string, requestId?: number, currentStep?: string, nextStep?: string, itemCount?: number }} meta
 */
export function logOpenSessionsFetch(phase, meta = {}) {
  try {
    const isDev =
      (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV) ||
      (typeof process !== "undefined" && process.env && process.env.NODE_ENV === "development");
    if (!isDev) return;
    // eslint-disable-next-line no-console
    console.debug("[daily-work] open-sessions", phase, {
      reason: meta.reason || "",
      requestId: meta.requestId,
      currentStep: meta.currentStep,
      nextStep: meta.nextStep,
      itemCount: meta.itemCount,
    });
  } catch {
    /* ignore */
  }
}

/**
 * Create Job Sheet button enablement after CreateFailed recovery.
 * CreateFailed never creates silently — must return to ReviewRequired and confirm.
 */
export function canCreateCompletedJobSheet({
  status,
  reviewConfirmed,
  jobCreated = false,
} = {}) {
  if (jobCreated) return false;
  if (status === "CreateFailed") return false;
  if (status !== "ReviewRequired") return false;
  return reviewConfirmed === true;
}
