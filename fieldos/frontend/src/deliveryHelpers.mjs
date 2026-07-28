/** Phase 3G delivery / attachment UI helpers (no React). */

export const PDF_PROFILES = [
  "Internal Job Sheet",
  "Client Job Summary",
  "Staff Work Record",
  "Completion Register",
];

export const DELIVERY_STATUSES = ["Draft", "Ready", "Sent", "Failed", "Cancelled", "Superseded"];

export const DELIVERY_METHODS = ["email", "drive", "email_and_drive", "download_only"];

export function isManagerRole(role) {
  const r = String(role || "").trim().toLowerCase();
  return r === "manager" || r === "admin" || r === "administrator";
}

export function canEditDelivery(status) {
  return status === "Draft" || status === "Failed";
}

export function canValidateDelivery(status) {
  return status === "Draft" || status === "Failed";
}

export function canSendDelivery(status) {
  return status === "Ready";
}

export function canRetryDelivery(status) {
  return status === "Failed";
}

export function canCancelDelivery(status) {
  return status === "Draft" || status === "Ready" || status === "Failed";
}

export function canSupersedeDelivery(status) {
  return status === "Sent" || status === "Failed";
}

export function confirmSendMessage(delivery) {
  const email = delivery?.recipient_email || "(no email)";
  const doc = delivery?.document_type || "PDF";
  return (
    `Send ${doc} to ${email}?\n\n` +
    "This requires explicit confirmation. FieldOS never auto-sends email or Drive filings.\n" +
    "Only the generated PDF is attached — no transcripts, audio, or Drive IDs."
  );
}

export function providerDisabledMessage(options = {}) {
  const parts = [];
  if (options.email_gate_reason) parts.push(options.email_gate_reason);
  if (options.drive_gate_reason) parts.push(options.drive_gate_reason);
  if (!parts.length) {
    return "Email and Drive providers are disabled by default. download_only can complete after confirm.";
  }
  return parts.join(" ");
}

export function emptyDeliveryMessage() {
  return "No deliveries yet. Create a draft, preview recipients, validate, then confirm send.";
}

export const MISSING_DELIVERY_SOURCE_MESSAGE =
  "Cannot create delivery: no job or report was selected.";

/**
 * Build POST /deliveries draft body with exactly one source context.
 * Job context → job_sheet_id only. Report context → report_batch_id only.
 * Never requires both. Returns { ok, error?, payload?, source_type?, ... }.
 */
export function buildCreateDeliveryDraftPayload({
  document_type,
  recipient_email,
  recipient_type = "client",
  delivery_method = "email",
  jobSheetId = "",
  reportBatchId = "",
  completionId = "",
  customerName = "",
  projectName = "",
  attachment_ids = [],
  sourceType = "",
} = {}) {
  const jobId = String(jobSheetId || "").trim();
  const batchId = String(reportBatchId || "").trim();
  const forced = String(sourceType || "")
    .trim()
    .toLowerCase();

  let source_type = "";
  if (forced === "job" || forced === "report") {
    source_type = forced;
  } else if (batchId) {
    source_type = "report";
  } else if (jobId) {
    source_type = "job";
  }

  const has_job_sheet_id = source_type === "job" && !!jobId;
  const has_report_batch_id = source_type === "report" && !!batchId;

  if (!has_job_sheet_id && !has_report_batch_id) {
    return {
      ok: false,
      error: MISSING_DELIVERY_SOURCE_MESSAGE,
      source_type: source_type || null,
      has_job_sheet_id: false,
      has_report_batch_id: false,
    };
  }

  const payload = {
    document_type,
    recipient_email: recipient_email || undefined,
    recipient_type,
    delivery_method,
    // Explicit null for the unused source so callers/tests can assert contract.
    job_sheet_id: has_job_sheet_id ? jobId : null,
    report_batch_id: has_report_batch_id ? batchId : null,
  };

  const completion = String(completionId || "").trim();
  if (completion) payload.completion_id = completion;
  if (customerName) payload.customer_name = customerName;
  if (projectName) payload.project_name = projectName;
  if (Array.isArray(attachment_ids) && attachment_ids.length) {
    payload.attachment_ids = attachment_ids.map(String);
  }

  return {
    ok: true,
    payload,
    source_type,
    has_job_sheet_id,
    has_report_batch_id,
  };
}

/** Strip null source fields before JSON POST (FastAPI Optional + exclude_none). */
export function deliveryDraftRequestBody(payload) {
  const body = { ...(payload || {}) };
  if (body.job_sheet_id == null || body.job_sheet_id === "") delete body.job_sheet_id;
  if (body.report_batch_id == null || body.report_batch_id === "") delete body.report_batch_id;
  return body;
}

export function deliveryStatusTone(status) {
  switch (String(status || "")) {
    case "Sent":
      return "ok";
    case "Failed":
      return "error";
    case "Ready":
      return "warn";
    case "Superseded":
    case "Cancelled":
      return "muted";
    default:
      return "neutral";
  }
}
