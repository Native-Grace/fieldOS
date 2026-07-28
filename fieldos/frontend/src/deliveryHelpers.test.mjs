/**
 * Phase 3G delivery helper + wiring tests.
 * Run: node --test fieldos/frontend/src/deliveryHelpers.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MISSING_DELIVERY_SOURCE_MESSAGE,
  buildCreateDeliveryDraftPayload,
  canCancelDelivery,
  canSendDelivery,
  canSupersedeDelivery,
  canValidateDelivery,
  confirmSendMessage,
  deliveryDraftRequestBody,
  emptyDeliveryMessage,
  providerDisabledMessage,
} from "./deliveryHelpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("delivery action gates", () => {
  assert.equal(canValidateDelivery("Draft"), true);
  assert.equal(canSendDelivery("Ready"), true);
  assert.equal(canSendDelivery("Draft"), false);
  assert.equal(canCancelDelivery("Ready"), true);
  assert.equal(canSupersedeDelivery("Sent"), true);
  assert.equal(canSupersedeDelivery("Draft"), false);
});

test("confirm send message requires explicit confirmation language", () => {
  const msg = confirmSendMessage({
    document_type: "Client Job Summary",
    recipient_email: "client@example.com",
  });
  assert.match(msg, /never auto-sends/i);
  assert.match(msg, /client@example.com/);
  assert.match(emptyDeliveryMessage(), /Create a draft/i);
});

test("provider disabled message surfaces gate reasons", () => {
  const msg = providerDisabledMessage({
    email_gate_reason: "DOCUMENT_EMAIL_ENABLED is false.",
    drive_gate_reason: "DOCUMENT_DRIVE_FILING_ENABLED is false (default).",
  });
  assert.match(msg, /DOCUMENT_EMAIL_ENABLED/);
  assert.match(msg, /DOCUMENT_DRIVE_FILING_ENABLED/);
});

test("Job Detail draft payload contains job_sheet_id only", () => {
  const built = buildCreateDeliveryDraftPayload({
    document_type: "Client Job Summary",
    recipient_email: "ops@nativegrace.com",
    jobSheetId: "21759f5d",
    reportBatchId: "",
    sourceType: "job",
  });
  assert.equal(built.ok, true);
  assert.equal(built.source_type, "job");
  assert.equal(built.has_job_sheet_id, true);
  assert.equal(built.has_report_batch_id, false);
  assert.equal(built.payload.job_sheet_id, "21759f5d");
  assert.equal(built.payload.report_batch_id, null);
  const body = deliveryDraftRequestBody(built.payload);
  assert.equal(body.job_sheet_id, "21759f5d");
  assert.equal(Object.prototype.hasOwnProperty.call(body, "report_batch_id"), false);
});

test("Reports draft payload contains report_batch_id only", () => {
  const built = buildCreateDeliveryDraftPayload({
    document_type: "Completion Register",
    reportBatchId: "RPT-ABCD1234",
    jobSheetId: "21759f5d", // must not leak into report context
    sourceType: "report",
  });
  assert.equal(built.ok, true);
  assert.equal(built.source_type, "report");
  assert.equal(built.payload.report_batch_id, "RPT-ABCD1234");
  assert.equal(built.payload.job_sheet_id, null);
  const body = deliveryDraftRequestBody(built.payload);
  assert.equal(body.report_batch_id, "RPT-ABCD1234");
  assert.equal(Object.prototype.hasOwnProperty.call(body, "job_sheet_id"), false);
});

test("neither ID blocks locally without sending", () => {
  const built = buildCreateDeliveryDraftPayload({
    document_type: "Client Job Summary",
    jobSheetId: "",
    reportBatchId: "",
  });
  assert.equal(built.ok, false);
  assert.equal(built.error, MISSING_DELIVERY_SOURCE_MESSAGE);
  assert.equal(built.has_job_sheet_id, false);
  assert.equal(built.has_report_batch_id, false);
});

test("one ID accepted — job or report", () => {
  const jobOnly = buildCreateDeliveryDraftPayload({
    document_type: "Internal Job Sheet",
    jobSheetId: "21759f5d",
  });
  assert.equal(jobOnly.ok, true);
  assert.equal(jobOnly.source_type, "job");

  const reportOnly = buildCreateDeliveryDraftPayload({
    document_type: "Internal Job Sheet",
    reportBatchId: "RPT-1",
  });
  assert.equal(reportOnly.ok, true);
  assert.equal(reportOnly.source_type, "report");
});

test("both IDs: report wins by default; sourceType forces job", () => {
  const both = buildCreateDeliveryDraftPayload({
    document_type: "Client Job Summary",
    jobSheetId: "21759f5d",
    reportBatchId: "RPT-1",
  });
  assert.equal(both.ok, true);
  assert.equal(both.source_type, "report");
  assert.equal(both.payload.report_batch_id, "RPT-1");
  assert.equal(both.payload.job_sheet_id, null);

  const forcedJob = buildCreateDeliveryDraftPayload({
    document_type: "Client Job Summary",
    jobSheetId: "21759f5d",
    reportBatchId: "RPT-1",
    sourceType: "job",
  });
  assert.equal(forcedJob.source_type, "job");
  assert.equal(forcedJob.payload.job_sheet_id, "21759f5d");
  assert.equal(forcedJob.payload.report_batch_id, null);
});

test("no stale ID when switching between jobs/reports", () => {
  const jobA = buildCreateDeliveryDraftPayload({
    document_type: "Client Job Summary",
    jobSheetId: "21759f5d",
    sourceType: "job",
  });
  const jobB = buildCreateDeliveryDraftPayload({
    document_type: "Client Job Summary",
    jobSheetId: "JS-OTHER",
    sourceType: "job",
  });
  assert.notEqual(jobA.payload.job_sheet_id, jobB.payload.job_sheet_id);

  const report = buildCreateDeliveryDraftPayload({
    document_type: "Client Job Summary",
    reportBatchId: "RPT-NEW",
    jobSheetId: jobA.payload.job_sheet_id,
    sourceType: "report",
  });
  assert.equal(report.payload.job_sheet_id, null);
  assert.equal(report.payload.report_batch_id, "RPT-NEW");
});

test("pages wire DeliveryPanel with correct source IDs", () => {
  const reports = fs.readFileSync(path.join(__dirname, "pages", "ReportsPage.jsx"), "utf8");
  const detail = fs.readFileSync(path.join(__dirname, "pages", "JobDetailPage.jsx"), "utf8");
  const panel = fs.readFileSync(path.join(__dirname, "components", "DeliveryPanel.jsx"), "utf8");
  const completions = fs.readFileSync(
    path.join(__dirname, "pages", "CompletionsDashboardPage.jsx"),
    "utf8"
  );

  assert.match(reports, /DeliveryPanel/);
  assert.match(reports, /reportBatchId=\{selectedBatch\.report_batch_id\}/);
  assert.match(reports, /sourceType="report"/);
  assert.ok(!/jobSheetId=\{form\.job_sheet_id/.test(reports));

  assert.match(detail, /DeliveryPanel/);
  assert.match(detail, /jobSheetId=\{jobSheetId \|\| job\.job_sheet_id/);
  assert.match(detail, /sourceType="job"/);

  assert.ok(!completions.includes("DeliveryPanel"));

  assert.match(panel, /confirm_send:\s*true/);
  assert.match(panel, /buildCreateDeliveryDraftPayload/);
  assert.match(panel, /MISSING_DELIVERY_SOURCE_MESSAGE/);
  assert.match(panel, /\/deliveries/);
  assert.match(panel, /\/preview/);
  assert.ok(!panel.includes("window.open"));
  assert.ok(!panel.includes("?token="));
  assert.ok(!/auto.?send\s*=\s*true/i.test(panel));
});
