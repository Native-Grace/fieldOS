/**
 * My Jobs date-range helpers (testable without React).
 */

export const DEFAULT_JOBS_DAYS = 7;

export const JOBS_RANGE_OPTIONS = [
  { value: 7, label: "Last 7 days" },
  { value: 14, label: "Last 14 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

export const JOBS_DAYS_STORAGE_KEY = "fieldos_jobs_days";

const ALLOWED = new Set(JOBS_RANGE_OPTIONS.map((o) => o.value));

/**
 * @param {*} value
 * @returns {number}
 */
export function normalizeJobsDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !ALLOWED.has(n)) return DEFAULT_JOBS_DAYS;
  return n;
}

/**
 * @param {Storage|null|undefined} storage
 * @returns {number}
 */
export function loadJobsDays(storage) {
  if (!storage || typeof storage.getItem !== "function") return DEFAULT_JOBS_DAYS;
  try {
    return normalizeJobsDays(storage.getItem(JOBS_DAYS_STORAGE_KEY));
  } catch {
    return DEFAULT_JOBS_DAYS;
  }
}

/**
 * @param {Storage|null|undefined} storage
 * @param {number} days
 */
export function saveJobsDays(storage, days) {
  if (!storage || typeof storage.setItem !== "function") return;
  try {
    storage.setItem(JOBS_DAYS_STORAGE_KEY, String(normalizeJobsDays(days)));
  } catch {
    // ignore quota / private mode
  }
}

/**
 * @param {number} days
 * @returns {string}
 */
export function jobsMinePath(days) {
  const d = normalizeJobsDays(days);
  return `/jobs/mine?days=${d}`;
}

/**
 * @param {number} days
 * @returns {string}
 */
export function emptyJobsMessage(days) {
  return `No jobs in the last ${normalizeJobsDays(days)} days.`;
}

/**
 * Fetch My Jobs for a selected range. Caller supplies api() so auth headers stay intact.
 *
 * @param {{ days: number, api: (path: string) => Promise<any> }} opts
 */
export async function fetchMyJobs({ days, api }) {
  if (typeof api !== "function") {
    throw new Error("api client is required");
  }
  const selected = normalizeJobsDays(days);
  const data = await api(jobsMinePath(selected));
  return {
    items: (data && data.items) || [],
    days: normalizeJobsDays(data && data.days != null ? data.days : selected),
    assumptions: (data && data.assumptions) || [],
  };
}
