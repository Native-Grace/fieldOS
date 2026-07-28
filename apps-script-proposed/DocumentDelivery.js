/**
 * Phase 3G FieldOSDocumentDelivery — delivery records + attachment metadata.
 * PDF bytes are never stored in Sheets. Email/Drive sends are executed by FastAPI
 * after manager confirmation; Apps Script owns the auditable control plane.
 *
 * Depends on: DocumentDeliveryHelpers.js, Database.js, Utilities.js, Repositories.js
 */

var FIELDOS_DELIVERY_HEADERS_ = [
  "delivery_id",
  "report_batch_id",
  "job_sheet_id",
  "completion_id",
  "document_type",
  "recipient_type",
  "recipient_email",
  "delivery_method",
  "status",
  "sent_by",
  "sent_at",
  "failed_at",
  "failure_reason",
  "checksum",
  "template_version",
  "supersedes_delivery_id",
  "idempotency_key",
  "drive_file_id",
  "attachment_ids_json",
  "subject",
  "body_preview",
  "created_by",
  "created_at",
  "version"
];

var FIELDOS_ATTACHMENT_HEADERS_ = [
  "attachment_id",
  "job_sheet_id",
  "completion_id",
  "attachment_type",
  "file_name",
  "mime_type",
  "byte_size",
  "caption",
  "uploaded_by",
  "uploaded_at",
  "client_visible",
  "approved_by",
  "approved_at",
  "storage_ref",
  "checksum",
  "status",
  "version"
];

var FieldOSDocumentDelivery = {
  _nowIso: function () {
    return new Date().toISOString();
  },

  _actor: function (payload) {
    var p = payload || {};
    var role = String(p.actor_role || p.role || "staff");
    return {
      staff_id: String(p.actor_staff_id || p.staff_id || ""),
      role: role,
      is_manager: fieldosDeliveryIsManager_(role),
      identity: String(p.actor_identity || p.staff_id || "")
    };
  },

  _assertManager: function (actor) {
    if (!actor.is_manager) throw new Error("Forbidden: manager or admin role required.");
  },

  _assertTables: function () {
    try {
      DB.getSheet("tbl_document_deliveries");
      DB.getSheet("tbl_job_attachments");
    } catch (err) {
      throw new Error("Validation Error: delivery tables missing — run migrateSchemaForDocumentDelivery().");
    }
  },

  _writeAudit: function (meta) {
    try {
      SyncRepository.create({
        record_id: meta.delivery_id || meta.attachment_id || meta.job_sheet_id || "FIELDOS_DELIVERY",
        target_system: "FieldOS_Deliveries",
        status: "Success",
        request_payload: JSON.stringify(fieldosDeliveryAuditPayload_(meta)),
        response_payload: String(meta.new_status || meta.status || ""),
        timestamp: new Date()
      });
    } catch (err) {
      if (typeof Logger !== "undefined" && Logger.log) Logger.log("Delivery audit write failed: " + err);
    }
  },

  _rowToApi: function (row) {
    var r = row || {};
    var ids = [];
    try {
      ids = JSON.parse(String(r.attachment_ids_json || "[]"));
    } catch (e) {
      ids = [];
    }
    return {
      delivery_id: String(r.delivery_id || ""),
      report_batch_id: String(r.report_batch_id || ""),
      job_sheet_id: String(r.job_sheet_id || ""),
      completion_id: String(r.completion_id || ""),
      document_type: String(r.document_type || ""),
      recipient_type: String(r.recipient_type || ""),
      recipient_email: String(r.recipient_email || ""),
      delivery_method: String(r.delivery_method || ""),
      status: String(r.status || ""),
      sent_by: String(r.sent_by || ""),
      sent_at: r.sent_at || null,
      failed_at: r.failed_at || null,
      failure_reason: String(r.failure_reason || ""),
      checksum: String(r.checksum || ""),
      template_version: String(r.template_version || FIELDOS_DELIVERY_TEMPLATE_VERSION_),
      supersedes_delivery_id: String(r.supersedes_delivery_id || ""),
      idempotency_key: String(r.idempotency_key || ""),
      file_drive: !!String(r.drive_file_id || ""),
      attachment_ids: ids,
      subject: String(r.subject || ""),
      body_preview: String(r.body_preview || ""),
      version: Number(r.version) || 1,
      created_at: r.created_at || null,
      created_by: String(r.created_by || "")
    };
  },

  deliveryOptions: function (payload) {
    var actor = this._actor(payload);
    this._assertManager(actor);
    return {
      action: "delivery_options",
      message: "OK",
      data: {
        profiles: [
          FIELDOS_PDF_PROFILES_.INTERNAL_JOB_SHEET,
          FIELDOS_PDF_PROFILES_.CLIENT_JOB_SUMMARY,
          FIELDOS_PDF_PROFILES_.STAFF_WORK_RECORD,
          FIELDOS_PDF_PROFILES_.COMPLETION_REGISTER
        ],
        statuses: [
          FIELDOS_DELIVERY_STATUSES_.DRAFT,
          FIELDOS_DELIVERY_STATUSES_.READY,
          FIELDOS_DELIVERY_STATUSES_.SENT,
          FIELDOS_DELIVERY_STATUSES_.FAILED,
          FIELDOS_DELIVERY_STATUSES_.CANCELLED,
          FIELDOS_DELIVERY_STATUSES_.SUPERSEDED
        ],
        delivery_methods: ["email", "drive", "email_and_drive", "download_only"],
        template_version: FIELDOS_DELIVERY_TEMPLATE_VERSION_,
        email_enabled: false,
        drive_filing_enabled: false,
        email_gate_reason: "DOCUMENT_EMAIL_ENABLED is false (default). FastAPI enforces the live gate.",
        drive_gate_reason:
          "DOCUMENT_DRIVE_FILING_ENABLED is false (default). FastAPI enforces the live gate.",
        auto_send: false,
        antivirus_boundary:
          "FieldOS enforces MIME/extension/size allowlists; AV scanning is an ops boundary. No public links."
      }
    };
  },

  createDeliveryDraft: function (payload) {
    this._assertTables();
    var actor = this._actor(payload);
    this._assertManager(actor);
    var p = payload || {};
    var profile = String(p.document_type || FIELDOS_PDF_PROFILES_.CLIENT_JOB_SUMMARY);
    var email = fieldosNormaliseDeliveryEmail_(p.recipient_email);
    if (email && !fieldosIsValidDeliveryEmail_(email)) {
      throw new Error("Validation Error: recipient_email is invalid.");
    }
    var preview = fieldosPreviewDeliveryEmail_({
      document_type: profile,
      recipient_email: email || "recipient@example.com",
      job_sheet_id: p.job_sheet_id,
      customer_name: p.customer_name,
      project_name: p.project_name
    });
    var deliveryId = DB.generateId("DLV");
    var row = {
      delivery_id: deliveryId,
      report_batch_id: String(p.report_batch_id || ""),
      job_sheet_id: String(p.job_sheet_id || ""),
      completion_id: String(p.completion_id || ""),
      document_type: profile,
      recipient_type: String(p.recipient_type || "client"),
      recipient_email: email,
      delivery_method: String(p.delivery_method || "email"),
      status: FIELDOS_DELIVERY_STATUSES_.DRAFT,
      sent_by: "",
      sent_at: "",
      failed_at: "",
      failure_reason: "",
      checksum: "",
      template_version: FIELDOS_DELIVERY_TEMPLATE_VERSION_,
      supersedes_delivery_id: String(p.supersedes_delivery_id || ""),
      idempotency_key: "",
      drive_file_id: "",
      attachment_ids_json: JSON.stringify(p.attachment_ids || []),
      subject: preview.subject,
      body_preview: preview.body,
      created_by: actor.staff_id,
      created_at: this._nowIso(),
      version: 1
    };
    DB.insertRecord("tbl_document_deliveries", row);
    this._writeAudit({
      action: "create_delivery_draft",
      delivery_id: deliveryId,
      document_type: profile,
      recipient_email: email,
      status: FIELDOS_DELIVERY_STATUSES_.DRAFT,
      new_status: FIELDOS_DELIVERY_STATUSES_.DRAFT,
      actor_staff_id: actor.staff_id,
      actor_role: actor.role
    });
    return {
      action: "create_delivery_draft",
      message: "OK",
      data: { delivery: this._rowToApi(row), email_preview: preview, auto_send: false, confirm_required: true }
    };
  },

  listDeliveries: function (payload) {
    this._assertTables();
    var actor = this._actor(payload);
    this._assertManager(actor);
    var p = payload || {};
    var jobFilter = String(p.job_sheet_id || "");
    var batchFilter = String(p.report_batch_id || "");
    var rows = (DB.findWhere("tbl_document_deliveries", {}) || []).filter(function (row) {
      if (jobFilter && String(row.job_sheet_id || "") !== jobFilter) return false;
      if (batchFilter && String(row.report_batch_id || "") !== batchFilter) return false;
      return true;
    });
    var self = this;
    return {
      action: "list_deliveries",
      message: "OK",
      data: { items: rows.map(function (r) { return self._rowToApi(r); }) }
    };
  },

  getDelivery: function (payload) {
    this._assertTables();
    var actor = this._actor(payload);
    this._assertManager(actor);
    var id = String((payload && payload.delivery_id) || "");
    var rows = DB.findWhere("tbl_document_deliveries", { delivery_id: id }) || [];
    if (!rows.length) throw new Error("Not Found: delivery " + id + " does not exist.");
    return { action: "get_delivery", message: "OK", data: { delivery: this._rowToApi(rows[0]) } };
  },

  updateDeliveryDraft: function (payload) {
    this._assertTables();
    var actor = this._actor(payload);
    this._assertManager(actor);
    var p = payload || {};
    this._rejectForbiddenPayload_(p);
    var id = String(p.delivery_id || "");
    var rows = DB.findWhere("tbl_document_deliveries", { delivery_id: id }) || [];
    if (!rows.length) throw new Error("Not Found: delivery " + id + " does not exist.");
    var row = rows[0];
    this._checkVersion_(row, p.expected_version);
    var status = String(row.status || "");
    if (
      status !== FIELDOS_DELIVERY_STATUSES_.DRAFT &&
      status !== FIELDOS_DELIVERY_STATUSES_.FAILED
    ) {
      throw new Error("Validation Error: Only Draft or Failed deliveries can be edited.");
    }
    var patch = { version: (Number(row.version) || 1) + 1 };
    if (Object.prototype.hasOwnProperty.call(p, "recipient_email")) {
      var email = fieldosNormaliseDeliveryEmail_(p.recipient_email);
      if (email && !fieldosIsValidDeliveryEmail_(email)) {
        throw new Error("Validation Error: recipient_email is invalid.");
      }
      patch.recipient_email = email;
    }
    if (p.document_type) patch.document_type = String(p.document_type);
    if (p.delivery_method) patch.delivery_method = String(p.delivery_method);
    if (p.recipient_type) patch.recipient_type = String(p.recipient_type);
    if (Object.prototype.hasOwnProperty.call(p, "attachment_ids")) {
      patch.attachment_ids_json = JSON.stringify(p.attachment_ids || []);
    }
    var preview = fieldosPreviewDeliveryEmail_({
      document_type: patch.document_type || row.document_type,
      recipient_email: patch.recipient_email != null ? patch.recipient_email : row.recipient_email,
      job_sheet_id: row.job_sheet_id,
      customer_name: p.customer_name,
      project_name: p.project_name
    });
    patch.subject = preview.subject;
    patch.body_preview = preview.body;
    DB.updateRecord("tbl_document_deliveries", "delivery_id", id, patch);
    this._writeAudit({
      action: "update_delivery_draft",
      delivery_id: id,
      recipient_email: patch.recipient_email != null ? patch.recipient_email : row.recipient_email,
      status: row.status,
      actor_staff_id: actor.staff_id,
      actor_role: actor.role,
      version: patch.version
    });
    var merged = Object.assign({}, row, patch);
    return {
      action: "update_delivery_draft",
      message: "OK",
      data: { delivery: this._rowToApi(merged), email_preview: preview }
    };
  },

  // Validate/send/retry/cancel/supersede are owned by FastAPI DeliveryOrchestrator
  // (PDF render + provider gates). Apps Script persists outcomes only.
  recordDeliveryOutcome: function (payload) {
    this._assertTables();
    var actor = this._actor(payload);
    this._assertManager(actor);
    var p = payload || {};
    this._rejectForbiddenPayload_(p);
    var id = String(p.delivery_id || "");
    var rows = DB.findWhere("tbl_document_deliveries", { delivery_id: id }) || [];
    if (!rows.length) throw new Error("Not Found: delivery " + id + " does not exist.");
    var row = rows[0];
    this._checkVersion_(row, p.expected_version);

    var nextStatus = String(p.status || row.status);
    var nextKey = String(
      p.idempotency_key != null && p.idempotency_key !== ""
        ? p.idempotency_key
        : row.idempotency_key || ""
    );
    var nextChecksum = String(
      p.checksum != null && p.checksum !== "" ? p.checksum : row.checksum || ""
    );

    // Idempotent success: same delivery + key + Sent → return original (no version bump).
    if (
      String(row.status) === FIELDOS_DELIVERY_STATUSES_.SENT &&
      nextStatus === FIELDOS_DELIVERY_STATUSES_.SENT &&
      nextKey &&
      String(row.idempotency_key || "") === nextKey
    ) {
      if (nextChecksum && String(row.checksum || "") && nextChecksum !== String(row.checksum || "")) {
        throw new Error(
          "Conflict: idempotency key reused with a different checksum payload."
        );
      }
      return {
        action: "record_delivery_outcome",
        message: "OK",
        data: { delivery: this._rowToApi(row), idempotent: true }
      };
    }

    // Same key with a different Sent payload / another Sent row → 409.
    if (nextStatus === FIELDOS_DELIVERY_STATUSES_.SENT && nextKey) {
      if (
        String(row.status) === FIELDOS_DELIVERY_STATUSES_.SENT &&
        String(row.idempotency_key || "") &&
        String(row.idempotency_key || "") !== nextKey
      ) {
        throw new Error(
          "Conflict: delivery already Sent with a different idempotency key."
        );
      }
      var others = DB.findWhere("tbl_document_deliveries", {}) || [];
      for (var i = 0; i < others.length; i++) {
        var other = others[i];
        if (String(other.delivery_id) === id) continue;
        if (
          String(other.status) === FIELDOS_DELIVERY_STATUSES_.SENT &&
          String(other.idempotency_key || "") === nextKey
        ) {
          throw new Error(
            "Conflict: duplicate send blocked by idempotency key."
          );
        }
      }
    }

    var patch = {
      status: nextStatus,
      checksum: nextChecksum,
      idempotency_key: nextKey,
      template_version: String(
        p.template_version || row.template_version || FIELDOS_DELIVERY_TEMPLATE_VERSION_
      ),
      version: (Number(row.version) || 1) + 1
    };

    if (p.clear_failure === true || p.clear_failure === "true" || nextStatus === FIELDOS_DELIVERY_STATUSES_.SENT) {
      patch.failure_reason = "";
      patch.failed_at = "";
    } else if (Object.prototype.hasOwnProperty.call(p, "failure_reason")) {
      patch.failure_reason = String(p.failure_reason || "");
    }

    if (p.sent_at) patch.sent_at = p.sent_at;
    if (p.sent_by) patch.sent_by = String(p.sent_by);
    if (p.failed_at) patch.failed_at = p.failed_at;
    // drive_file_id only when a real private provider returns one — never URLs.
    if (p.drive_file_id) patch.drive_file_id = String(p.drive_file_id);

    DB.updateRecord("tbl_document_deliveries", "delivery_id", id, patch);
    this._writeAudit({
      action: String(p.audit_action || "delivery_outcome"),
      delivery_id: id,
      previous_status: row.status,
      new_status: patch.status,
      checksum: patch.checksum,
      template_version: patch.template_version,
      idempotency_key: patch.idempotency_key,
      failure_reason: patch.failure_reason || "",
      actor_staff_id: actor.staff_id,
      actor_role: actor.role,
      drive_filed: !!p.drive_file_id,
      version: patch.version
    });
    var merged = Object.assign({}, row, patch);
    return {
      action: "record_delivery_outcome",
      message: "OK",
      data: { delivery: this._rowToApi(merged) }
    };
  },

  _checkVersion_: function (row, expected) {
    if (expected === undefined || expected === null || expected === "") return;
    if (Number(row.version) !== Number(expected)) {
      throw new Error(
        "Conflict: delivery version changed since you loaded this record."
      );
    }
  },

  _rejectForbiddenPayload_: function (payload) {
    var p = payload || {};
    var forbidden = [
      "pdf_bytes",
      "pdf_base64",
      "content_base64",
      "Authorization",
      "authorization",
      "token",
      "access_token",
      "webhook_secret",
      "drive_url",
      "public_url",
      "public_link",
      "email_body",
      "body"
    ];
    for (var i = 0; i < forbidden.length; i++) {
      if (Object.prototype.hasOwnProperty.call(p, forbidden[i]) && p[forbidden[i]] != null && p[forbidden[i]] !== "") {
        throw new Error(
          "Validation Error: forbidden field '" + forbidden[i] + "' must not be sent to Apps Script."
        );
      }
    }
  },

  listAttachments: function (payload) {
    this._assertTables();
    var actor = this._actor(payload);
    var jobId = String((payload && payload.job_sheet_id) || "");
    if (!jobId) throw new Error("Missing required attribute: job_sheet_id.");
    var rows = (DB.findWhere("tbl_job_attachments", { job_sheet_id: jobId }) || []).filter(function (r) {
      return String(r.status || "") !== "Deleted";
    });
    return {
      action: "list_attachments",
      message: "OK",
      data: {
        items: rows.map(function (r) {
          return {
            attachment_id: String(r.attachment_id || ""),
            job_sheet_id: String(r.job_sheet_id || ""),
            completion_id: String(r.completion_id || ""),
            attachment_type: String(r.attachment_type || "other"),
            file_name: String(r.file_name || ""),
            mime_type: String(r.mime_type || ""),
            byte_size: Number(r.byte_size) || 0,
            caption: String(r.caption || ""),
            uploaded_by: String(r.uploaded_by || ""),
            uploaded_at: r.uploaded_at || null,
            client_visible: r.client_visible === true || r.client_visible === "TRUE" || r.client_visible === "true",
            approved_by: String(r.approved_by || ""),
            approved_at: r.approved_at || null,
            checksum: String(r.checksum || ""),
            status: String(r.status || "Uploaded"),
            version: Number(r.version) || 1,
            has_storage_ref: actor.is_manager ? !!String(r.storage_ref || "") : undefined
          };
        })
      }
    };
  },

  uploadAttachment: function (payload) {
    this._assertTables();
    var actor = this._actor(payload);
    var p = payload || {};
    var blockers = fieldosValidateAttachmentUpload_({
      file_name: p.file_name,
      byte_size: p.byte_size,
      mime_type: p.mime_type
    });
    if (blockers.length) throw new Error("Validation Error: " + blockers.join("; "));
    var id = DB.generateId("ATT");
    var row = {
      attachment_id: id,
      job_sheet_id: String(p.job_sheet_id || ""),
      completion_id: String(p.completion_id || ""),
      attachment_type: String(p.attachment_type || "other"),
      file_name: String(p.file_name || ""),
      mime_type: String(p.mime_type || ""),
      byte_size: Number(p.byte_size) || 0,
      caption: String(p.caption || "").slice(0, 500),
      uploaded_by: actor.staff_id,
      uploaded_at: this._nowIso(),
      client_visible: false,
      approved_by: "",
      approved_at: "",
      storage_ref: String(p.storage_ref || ""),
      checksum: String(p.checksum || ""),
      status: "Uploaded",
      version: 1
    };
    DB.insertRecord("tbl_job_attachments", row);
    this._writeAudit({
      action: "attachment_uploaded",
      attachment_id: id,
      job_sheet_id: row.job_sheet_id,
      actor_staff_id: actor.staff_id,
      actor_role: actor.role
    });
    return {
      action: "upload_attachment",
      message: "OK",
      data: {
        attachment: {
          attachment_id: id,
          job_sheet_id: row.job_sheet_id,
          attachment_type: row.attachment_type,
          file_name: row.file_name,
          mime_type: row.mime_type,
          byte_size: row.byte_size,
          caption: row.caption,
          uploaded_by: row.uploaded_by,
          uploaded_at: row.uploaded_at,
          client_visible: false,
          status: "Uploaded",
          version: 1
        }
      }
    };
  },

  setAttachmentClientVisible: function (payload) {
    this._assertTables();
    var actor = this._actor(payload);
    this._assertManager(actor);
    var id = String((payload && payload.attachment_id) || "");
    var rows = DB.findWhere("tbl_job_attachments", { attachment_id: id }) || [];
    if (!rows.length) throw new Error("Not Found: attachment " + id + " does not exist.");
    var visible = payload && (payload.client_visible === true || payload.client_visible === "true");
    var patch = {
      client_visible: visible,
      approved_by: visible ? actor.staff_id : "",
      approved_at: visible ? this._nowIso() : "",
      status: visible ? "Approved" : "Uploaded",
      version: (Number(rows[0].version) || 1) + 1
    };
    DB.updateRecord("tbl_job_attachments", "attachment_id", id, patch);
    this._writeAudit({
      action: "attachment_visibility_changed",
      attachment_id: id,
      job_sheet_id: rows[0].job_sheet_id,
      client_visible: visible,
      actor_staff_id: actor.staff_id,
      actor_role: actor.role
    });
    return {
      action: "set_attachment_client_visible",
      message: "OK",
      data: {
        attachment: Object.assign({}, rows[0], patch, {
          client_visible: visible,
          has_storage_ref: !!String(rows[0].storage_ref || "")
        })
      }
    };
  }
};

/**
 * Safe diagnostic — no secrets, recipients, or PDF bytes.
 * Usage in Apps Script editor: testFieldOSDocumentDeliveryModule()
 */
function testFieldOSDocumentDeliveryModule() {
  var deliveryPresent = false;
  var attachmentPresent = false;
  try {
    DB.getSheet("tbl_document_deliveries");
    deliveryPresent = true;
  } catch (e1) {
    deliveryPresent = false;
  }
  try {
    DB.getSheet("tbl_job_attachments");
    attachmentPresent = true;
  } catch (e2) {
    attachmentPresent = false;
  }
  var report = {
    diagnostic: "testFieldOSDocumentDeliveryModule",
    defined: typeof FieldOSDocumentDelivery === "object" && FieldOSDocumentDelivery !== null,
    supported_actions: [
      "delivery_options",
      "list_deliveries",
      "get_delivery",
      "create_delivery_draft",
      "update_delivery_draft",
      "record_delivery_outcome",
      "list_attachments",
      "upload_attachment",
      "set_attachment_client_visible"
    ],
    delivery_tables_present: deliveryPresent,
    attachment_tables_present: attachmentPresent
  };
  if (typeof Logger !== "undefined" && Logger.log) {
    Logger.log(JSON.stringify(report));
  }
  return report;
}
