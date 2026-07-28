/**
 * Phase 3G pure helpers — PDF delivery profiles, privacy, attachment rules.
 * Keep in sync with fieldos/backend/app/services/delivery_math.py and attachment_math.py.
 */

var FIELDOS_DELIVERY_TEMPLATE_VERSION_ = "3G.1";

var FIELDOS_PDF_PROFILES_ = {
  INTERNAL_JOB_SHEET: "Internal Job Sheet",
  CLIENT_JOB_SUMMARY: "Client Job Summary",
  STAFF_WORK_RECORD: "Staff Work Record",
  COMPLETION_REGISTER: "Completion Register"
};

var FIELDOS_DELIVERY_STATUSES_ = {
  DRAFT: "Draft",
  READY: "Ready",
  SENT: "Sent",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  SUPERSEDED: "Superseded"
};

var FIELDOS_CLIENT_FORBIDDEN_FIELDS_ = {
  internal_notes: true,
  warnings: true,
  warning_resolutions: true,
  warning_count: true,
  payroll: true,
  payroll_mapping: true,
  cost: true,
  cost_rate: true,
  sell_rate: true,
  unit_cost: true,
  amount: true,
  price: true,
  xero: true,
  xero_mapping: true,
  ai_transcript: true,
  transcript: true,
  manager_review_items: true,
  drive_file_id: true,
  recording_drive_file_id: true,
  storage_ref: true,
  webhook_secret: true,
  token: true,
  mapping: true,
  mappings: true,
  notes: true
};

var FIELDOS_ATTACHMENT_FORBIDDEN_EXT_ = {
  ".exe": true,
  ".bat": true,
  ".cmd": true,
  ".js": true,
  ".vbs": true,
  ".ps1": true,
  ".sh": true,
  ".jar": true,
  ".html": true,
  ".htm": true,
  ".svg": true
};

function fieldosDeliveryIsManager_(role) {
  var r = String(role || "")
    .trim()
    .toLowerCase();
  return r === "manager" || r === "admin" || r === "administrator";
}

function fieldosNormaliseDeliveryEmail_(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function fieldosIsValidDeliveryEmail_(value) {
  var text = fieldosNormaliseDeliveryEmail_(value);
  if (!text || text.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

function fieldosStripClientForbidden_(value) {
  if (Object.prototype.toString.call(value) === "[object Array]") {
    return value.map(fieldosStripClientForbidden_);
  }
  if (!value || typeof value !== "object") return value;
  var out = {};
  Object.keys(value).forEach(function (key) {
    if (FIELDOS_CLIENT_FORBIDDEN_FIELDS_[key]) return;
    out[key] = fieldosStripClientForbidden_(value[key]);
  });
  return out;
}

function fieldosApplyPdfProfile_(snapshot, profile) {
  var name = String(profile || FIELDOS_PDF_PROFILES_.INTERNAL_JOB_SHEET);
  var client = name === FIELDOS_PDF_PROFILES_.CLIENT_JOB_SUMMARY;
  var base = snapshot && typeof snapshot === "object" ? JSON.parse(JSON.stringify(snapshot)) : {};
  if (client) base = fieldosStripClientForbidden_(base);
  base.audience = client ? "client" : "internal";
  base.document_type = name;
  base.template_version = String(base.template_version || FIELDOS_DELIVERY_TEMPLATE_VERSION_);
  return base;
}

function fieldosDeliveryIdempotencyKey_(parts) {
  var p = parts || {};
  var raw = [
    String(p.report_batch_id || ""),
    String(p.job_sheet_id || ""),
    String(p.document_type || ""),
    fieldosNormaliseDeliveryEmail_(p.recipient_email),
    String(p.checksum || ""),
    String(p.template_version || FIELDOS_DELIVERY_TEMPLATE_VERSION_)
  ].join("|");
  // Apps Script Utilities digest — deterministic hex.
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return digest
    .map(function (b) {
      var v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? "0" + v : v;
    })
    .join("");
}

function fieldosPreviewDeliveryEmail_(opts) {
  var o = opts || {};
  var job = String(o.job_sheet_id || "job");
  var doc = String(o.document_type || FIELDOS_PDF_PROFILES_.CLIENT_JOB_SUMMARY);
  var customer = String(o.customer_name || "Client");
  var project = String(o.project_name || "Project");
  return {
    to: fieldosNormaliseDeliveryEmail_(o.recipient_email),
    subject: "Native Grace — " + doc + " for " + job,
    body:
      "Hello,\n\nPlease find attached the " +
      doc +
      " for " +
      customer +
      " / " +
      project +
      " (job sheet " +
      job +
      ").\n\nNo automatic follow-up is sent from FieldOS.\n\nRegards,\nNative Grace\n"
  };
}

function fieldosAttachmentExtension_(filename) {
  var name = String(filename || "")
    .trim()
    .toLowerCase();
  var idx = name.lastIndexOf(".");
  if (idx < 0) return "";
  return name.slice(idx);
}

function fieldosValidateAttachmentUpload_(opts) {
  var o = opts || {};
  var blockers = [];
  var name = String(o.file_name || "").trim();
  if (!name) blockers.push("Filename is required.");
  var ext = fieldosAttachmentExtension_(name);
  if (FIELDOS_ATTACHMENT_FORBIDDEN_EXT_[ext]) {
    blockers.push("Executable or scriptable file types are not allowed.");
  }
  var size = Number(o.byte_size) || 0;
  if (size < 32) blockers.push("File is empty or too small.");
  if (size > 15 * 1024 * 1024) blockers.push("File exceeds the 15MB limit.");
  return blockers;
}

function fieldosDeliveryAuditPayload_(meta) {
  var src = meta || {};
  var allowed = [
    "action",
    "delivery_id",
    "report_batch_id",
    "job_sheet_id",
    "document_type",
    "recipient_type",
    "recipient_email",
    "delivery_method",
    "status",
    "previous_status",
    "new_status",
    "checksum",
    "template_version",
    "idempotency_key",
    "supersedes_delivery_id",
    "drive_filed",
    "failure_reason",
    "attachment_id",
    "client_visible",
    "actor_staff_id",
    "actor_role",
    "version"
  ];
  var out = {};
  allowed.forEach(function (key) {
    if (src[key] != null && src[key] !== "") out[key] = src[key];
  });
  return out;
}
