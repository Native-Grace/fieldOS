/** Pure helpers for manager review UI (no React). */

export const EMPTY_REVIEW_FORM = {
  ai_summary: "",
  client_requests: "",
  variations: "",
  safety_issues: "",
  manager_review_items: "",
  weather: "",
  travel_time: "",
  manager_notes: "",
};

export function buildReviewForm(job) {
  return {
    ai_summary: job?.ai_summary || "",
    client_requests: job?.client_requests || "",
    variations: job?.variations || "",
    safety_issues: job?.safety_issues || "",
    manager_review_items: job?.manager_review_items || "",
    weather: job?.weather || "",
    travel_time: job?.travel_time || "",
    manager_notes: job?.manager_notes || "",
  };
}

export function reviewHasUnsavedChanges(form, baseline) {
  return Object.keys(EMPTY_REVIEW_FORM).some(
    (key) => String(form[key] || "") !== String(baseline[key] || "")
  );
}

export function isManagerRole(role) {
  const r = String(role || "").trim().toLowerCase();
  return r === "manager" || r === "admin" || r === "administrator";
}

export function escapeText(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
