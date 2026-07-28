/**
 * Phase 3G / 3G.1 Apps Script delivery control-plane tests.
 * Run: node --test apps-script/tests/document_delivery.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function loadHelpers() {
  const code = fs.readFileSync(path.join(root, "DocumentDeliveryHelpers.js"), "utf8");
  const context = {
    Utilities: {
      DigestAlgorithm: { SHA_256: "SHA_256" },
      Charset: { UTF_8: "UTF_8" },
      computeDigest() {
        return [1, 2, 3, 4, 5, 6, 7, 8];
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

function makeDb(tables) {
  const store = tables;
  let seq = 1;
  return {
    generateId(prefix) {
      return `${prefix}-${String(seq++).padStart(4, "0")}`;
    },
    getSheet(name) {
      if (!Object.prototype.hasOwnProperty.call(store, name)) {
        throw new Error(`Missing sheet ${name}`);
      }
      return { name };
    },
    findWhere(table, cond) {
      const rows = store[table] || [];
      const keys = Object.keys(cond || {});
      if (!keys.length) return rows.map((r) => ({ ...r }));
      return rows
        .filter((row) => keys.every((k) => String(row[k] ?? "") === String(cond[k] ?? "")))
        .map((r) => ({ ...r }));
    },
    insertRecord(table, row) {
      if (!store[table]) store[table] = [];
      store[table].push({ ...row });
    },
    updateRecord(table, key, id, patch) {
      const rows = store[table] || [];
      const idx = rows.findIndex((r) => String(r[key]) === String(id));
      if (idx < 0) throw new Error(`Missing ${table} ${id}`);
      rows[idx] = { ...rows[idx], ...patch };
      return rows[idx];
    },
  };
}

function loadModule() {
  const helpers = fs.readFileSync(path.join(root, "DocumentDeliveryHelpers.js"), "utf8");
  const moduleSrc = fs.readFileSync(path.join(root, "DocumentDelivery.js"), "utf8");
  const audits = [];
  const tables = {
    tbl_document_deliveries: [],
    tbl_job_attachments: [],
  };
  const context = {
    console,
    Logger: { log() {} },
    Utilities: {
      DigestAlgorithm: { SHA_256: "SHA_256" },
      Charset: { UTF_8: "UTF_8" },
      computeDigest() {
        return [10, 20, 30, 40];
      },
    },
    DB: makeDb(tables),
    SyncRepository: {
      create(row) {
        audits.push(row);
      },
    },
    __audits: audits,
    __tables: tables,
  };
  vm.createContext(context);
  vm.runInContext(helpers, context);
  vm.runInContext(moduleSrc, context);
  return context;
}

const manager = {
  actor_role: "manager",
  actor_staff_id: "STAFF-MGR001",
  staff_id: "STAFF-MGR001",
};

test("client profile strips forbidden fields", () => {
  const ctx = loadHelpers();
  const cleaned = ctx.fieldosApplyPdfProfile_(
    {
      job: { job_sheet_id: "21759f5d" },
      internal_notes: "secret",
      drive_file_id: "DRIVE",
      ai_transcript: "talk",
      cost_rate: 12,
    },
    ctx.FIELDOS_PDF_PROFILES_.CLIENT_JOB_SUMMARY
  );
  assert.equal(cleaned.audience, "client");
  assert.equal(cleaned.internal_notes, undefined);
  assert.equal(cleaned.drive_file_id, undefined);
  assert.equal(cleaned.ai_transcript, undefined);
});

test("attachment validation blocks executables", () => {
  const ctx = loadHelpers();
  const blockers = ctx.fieldosValidateAttachmentUpload_({
    file_name: "x.exe",
    byte_size: 1000,
    mime_type: "application/octet-stream",
  });
  assert.ok(blockers.some((b) => /Executable|not allowed/i.test(b)));
});

test("email preview never includes drive ids", () => {
  const ctx = loadHelpers();
  const preview = ctx.fieldosPreviewDeliveryEmail_({
    document_type: "Client Job Summary",
    recipient_email: "Client@Example.com",
    job_sheet_id: "21759f5d",
  });
  assert.equal(preview.to, "client@example.com");
  assert.ok(!/drive/i.test(preview.body));
  assert.match(preview.subject, /21759f5d/);
});

test("audit payload sanitises secrets and omits pdf bytes", () => {
  const ctx = loadHelpers();
  const cleaned = ctx.fieldosDeliveryAuditPayload_({
    action: "sent",
    delivery_id: "DLV-1",
    recipient_email: "a@b.com",
    pdf_bytes: "SECRET",
    token: "tok",
    drive_file_id: "FID",
    webhook_secret: "sec",
    checksum: "abc",
  });
  assert.equal(cleaned.pdf_bytes, undefined);
  assert.equal(cleaned.token, undefined);
  assert.equal(cleaned.webhook_secret, undefined);
  assert.equal(cleaned.drive_file_id, undefined);
  assert.equal(cleaned.drive_filed, undefined);
  assert.equal(cleaned.checksum, "abc");
  assert.equal(cleaned.recipient_email, "a@b.com");
});

test("gateway and setup wire Phase 3G", () => {
  const gateway = fs.readFileSync(path.join(root, "FieldOSGateway.js"), "utf8");
  const setup = fs.readFileSync(path.join(root, "Setup.js"), "utf8");
  const repos = fs.readFileSync(path.join(root, "Repositories.js"), "utf8");
  assert.match(gateway, /FieldOSDocumentDelivery/);
  assert.match(gateway, /update_delivery_draft/);
  assert.match(gateway, /record_delivery_outcome/);
  assert.match(setup, /migrateSchemaForDocumentDelivery/);
  assert.match(repos, /DocumentDeliveryRepository/);
  assert.match(repos, /JobAttachmentRepository/);
});

test("create delivery draft requires job or report id", () => {
  const ctx = loadModule();
  assert.throws(
    () =>
      ctx.FieldOSDocumentDelivery.createDeliveryDraft({
        ...manager,
        document_type: "Client Job Summary",
        recipient_email: "client@example.com",
        delivery_method: "download_only",
      }),
    /report_batch_id or job_sheet_id/
  );
  const created = ctx.FieldOSDocumentDelivery.createDeliveryDraft({
    ...manager,
    document_type: "Client Job Summary",
    recipient_email: "client@example.com",
    job_sheet_id: "21759f5d",
    delivery_method: "download_only",
  });
  assert.equal(created.data.delivery.job_sheet_id, "21759f5d");
});

test("record_delivery_outcome persists status timestamps checksum template and key", () => {
  const ctx = loadModule();
  const created = ctx.FieldOSDocumentDelivery.createDeliveryDraft({
    ...manager,
    document_type: "Client Job Summary",
    recipient_email: "client@example.com",
    job_sheet_id: "21759f5d",
    delivery_method: "download_only",
  });
  const id = created.data.delivery.delivery_id;
  const out = ctx.FieldOSDocumentDelivery.recordDeliveryOutcome({
    ...manager,
    delivery_id: id,
    expected_version: 1,
    status: "Ready",
    checksum: "checksum-aaa",
    idempotency_key: "key-1",
    template_version: "3G.1",
    audit_action: "validate_delivery",
    clear_failure: true,
  });
  const d = out.data.delivery;
  assert.equal(d.status, "Ready");
  assert.equal(d.checksum, "checksum-aaa");
  assert.equal(d.idempotency_key, "key-1");
  assert.equal(d.template_version, "3G.1");
  assert.equal(d.version, 2);

  const sent = ctx.FieldOSDocumentDelivery.recordDeliveryOutcome({
    ...manager,
    delivery_id: id,
    expected_version: 2,
    status: "Sent",
    checksum: "checksum-aaa",
    idempotency_key: "key-1",
    sent_by: "STAFF-MGR001",
    sent_at: "2026-07-26T10:00:00Z",
    audit_action: "sent",
  });
  assert.equal(sent.data.delivery.status, "Sent");
  assert.equal(sent.data.delivery.sent_by, "STAFF-MGR001");
  assert.equal(sent.data.delivery.sent_at, "2026-07-26T10:00:00Z");
  assert.equal(sent.data.delivery.failure_reason, "");
});

test("idempotent Sent returns original; conflicting checksum is 409", () => {
  const ctx = loadModule();
  const created = ctx.FieldOSDocumentDelivery.createDeliveryDraft({
    ...manager,
    document_type: "Client Job Summary",
    recipient_email: "client@example.com",
    job_sheet_id: "21759f5d",
    delivery_method: "download_only",
  });
  const id = created.data.delivery.delivery_id;
  ctx.FieldOSDocumentDelivery.recordDeliveryOutcome({
    ...manager,
    delivery_id: id,
    expected_version: 1,
    status: "Sent",
    checksum: "c1",
    idempotency_key: "idem-A",
    sent_by: "STAFF-MGR001",
    sent_at: "2026-07-26T10:00:00Z",
  });
  const again = ctx.FieldOSDocumentDelivery.recordDeliveryOutcome({
    ...manager,
    delivery_id: id,
    expected_version: 2,
    status: "Sent",
    checksum: "c1",
    idempotency_key: "idem-A",
  });
  assert.equal(again.data.idempotent, true);
  assert.equal(again.data.delivery.version, 2);

  assert.throws(
    () =>
      ctx.FieldOSDocumentDelivery.recordDeliveryOutcome({
        ...manager,
        delivery_id: id,
        expected_version: 2,
        status: "Sent",
        checksum: "DIFFERENT",
        idempotency_key: "idem-A",
      }),
    /Conflict: idempotency key reused with a different checksum/
  );
});

test("stale version returns Conflict", () => {
  const ctx = loadModule();
  const created = ctx.FieldOSDocumentDelivery.createDeliveryDraft({
    ...manager,
    document_type: "Client Job Summary",
    recipient_email: "client@example.com",
    job_sheet_id: "21759f5d",
    delivery_method: "download_only",
  });
  assert.throws(
    () =>
      ctx.FieldOSDocumentDelivery.recordDeliveryOutcome({
        ...manager,
        delivery_id: created.data.delivery.delivery_id,
        expected_version: 99,
        status: "Ready",
      }),
    /Conflict: delivery version changed/
  );
});

test("failed outcome then retry with new key can reach Sent", () => {
  const ctx = loadModule();
  const created = ctx.FieldOSDocumentDelivery.createDeliveryDraft({
    ...manager,
    document_type: "Client Job Summary",
    recipient_email: "ops@nativegrace.com",
    job_sheet_id: "21759f5d",
    delivery_method: "email",
  });
  const id = created.data.delivery.delivery_id;
  const failed = ctx.FieldOSDocumentDelivery.recordDeliveryOutcome({
    ...manager,
    delivery_id: id,
    expected_version: 1,
    status: "Failed",
    checksum: "c1",
    idempotency_key: "key-old",
    failure_reason: "DOCUMENT_EMAIL_ENABLED is false.",
    failed_at: "2026-07-26T11:00:00Z",
    audit_action: "failed",
  });
  assert.equal(failed.data.delivery.status, "Failed");
  assert.match(failed.data.delivery.failure_reason, /DOCUMENT_EMAIL_ENABLED/);

  const sent = ctx.FieldOSDocumentDelivery.recordDeliveryOutcome({
    ...manager,
    delivery_id: id,
    expected_version: failed.data.delivery.version,
    status: "Sent",
    checksum: "c2",
    idempotency_key: "key-new-retry",
    sent_by: "STAFF-MGR001",
    sent_at: "2026-07-26T12:00:00Z",
    clear_failure: true,
    audit_action: "retried",
  });
  assert.equal(sent.data.delivery.status, "Sent");
  assert.equal(sent.data.delivery.idempotency_key, "key-new-retry");
  assert.equal(sent.data.delivery.failure_reason, "");
});

test("supersede via outcome then create replacement draft", () => {
  const ctx = loadModule();
  const created = ctx.FieldOSDocumentDelivery.createDeliveryDraft({
    ...manager,
    document_type: "Client Job Summary",
    recipient_email: "client@example.com",
    job_sheet_id: "21759f5d",
    delivery_method: "download_only",
  });
  const id = created.data.delivery.delivery_id;
  ctx.FieldOSDocumentDelivery.recordDeliveryOutcome({
    ...manager,
    delivery_id: id,
    expected_version: 1,
    status: "Sent",
    checksum: "c1",
    idempotency_key: "k1",
    sent_by: "STAFF-MGR001",
    sent_at: "2026-07-26T10:00:00Z",
  });
  const superseded = ctx.FieldOSDocumentDelivery.recordDeliveryOutcome({
    ...manager,
    delivery_id: id,
    expected_version: 2,
    status: "Superseded",
    audit_action: "superseded",
  });
  assert.equal(superseded.data.delivery.status, "Superseded");
  const replacement = ctx.FieldOSDocumentDelivery.createDeliveryDraft({
    ...manager,
    document_type: "Client Job Summary",
    recipient_email: "client@example.com",
    job_sheet_id: "21759f5d",
    delivery_method: "download_only",
    supersedes_delivery_id: id,
  });
  assert.equal(replacement.data.delivery.status, "Draft");
  assert.equal(replacement.data.delivery.supersedes_delivery_id, id);
});

test("forbidden pdf/token fields rejected before write", () => {
  const ctx = loadModule();
  const created = ctx.FieldOSDocumentDelivery.createDeliveryDraft({
    ...manager,
    document_type: "Client Job Summary",
    recipient_email: "client@example.com",
    job_sheet_id: "21759f5d",
    delivery_method: "download_only",
  });
  assert.throws(
    () =>
      ctx.FieldOSDocumentDelivery.recordDeliveryOutcome({
        ...manager,
        delivery_id: created.data.delivery.delivery_id,
        expected_version: 1,
        status: "Ready",
        pdf_bytes: "%PDF",
      }),
    /forbidden field 'pdf_bytes'/
  );
});

test("testFieldOSDocumentDeliveryModule returns safe diagnostic shape", () => {
  const ctx = loadModule();
  const report = ctx.testFieldOSDocumentDeliveryModule();
  assert.equal(report.defined, true);
  assert.ok(Array.isArray(report.supported_actions));
  assert.ok(report.supported_actions.includes("record_delivery_outcome"));
  assert.equal(report.delivery_tables_present, true);
  assert.equal(report.attachment_tables_present, true);
  assert.equal(report.diagnostic, "testFieldOSDocumentDeliveryModule");
  const raw = JSON.stringify(report);
  assert.ok(!/recipient|pdf_bytes|token|webhook/i.test(raw));
});
