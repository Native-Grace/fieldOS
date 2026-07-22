/**
 * Proposed sole doGet implementation (REVIEW ONLY — not wired into production Router.js).
 *
 * See DOGET_MERGE_PROPOSAL.md for inventory, obsolescence decisions, and apply plan.
 *
 * After approval:
 * 1. Replace Router.js doGet with doGet below (or inline equivalent).
 * 2. Remove doGet from RecorderWebApp.js and DailySummaryPdf.js.
 * 3. Point or remove Recordert.js serveRecorder_ accordingly.
 */

function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const mode = String(params.mode || "").trim();
  const jobSheetId = String(params.job_sheet_id || "").trim();

  // Explicit recorder mode, or legacy deep-link that only passes job_sheet_id
  const wantsRecorder = mode === "recorder" || jobSheetId !== "";

  if (wantsRecorder) {
    return serveRecorderPage_(params);
  }

  return HtmlService.createHtmlOutput("Native Grace FieldOS");
}

/**
 * Canonical recorder serve — merges Router serveRecorder_ + RecorderWebApp doGet.
 * Preserves: job validation, return_url, ALLOWALL framing, Recorder.html template vars.
 */
function serveRecorderPage_(params) {
  const jobSheetId = String(params.job_sheet_id || "").trim();
  const userIdentity = String(params.user_identity || "").trim();
  const returnUrl = String(params.return_url || "").trim();

  if (!jobSheetId) {
    return HtmlService.createHtmlOutput("Missing job_sheet_id");
  }

  const jobSheet = JobSheetRepository.findById(jobSheetId);
  if (!jobSheet) {
    return HtmlService.createHtmlOutput("Job sheet not found");
  }

  const template = HtmlService.createTemplateFromFile("Recorder");
  template.jobSheetId = jobSheetId;
  template.userIdentity = userIdentity;
  template.returnUrl = returnUrl;

  return template
    .evaluate()
    .setTitle("Native Grace Recorder")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
