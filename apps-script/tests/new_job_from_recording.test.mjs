/**
 * Apps Script Create Job from Recording tests (Node VM).
 * Run: node --test apps-script/tests/new_job_from_recording.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, "..", "NewJobFromRecording.js"), "utf8");
const gatewaySrc = fs.readFileSync(path.join(__dirname, "..", "FieldOSGateway.js"), "utf8");

function load() {
  const jobs = {};
  const recordings = {};
  const links = [];
  const keys = [];
  const headers = {
    tbl_job_sheets: [
      "job_sheet_id",
      "staff_id",
      "date",
      "project_id",
      "manager_notes",
      "processing_status",
      "processing_error",
      "approval_status",
    ],
    tbl_recordings: [
      "recording_id",
      "job_sheet_id",
      "recording_drive_file_id",
      "recording_file_url",
      "recording_name",
      "recording_order",
      "duration_seconds",
      "transcript",
      "status",
      "created_by",
      "created_at",
    ],
    tbl_job_recording_links: [
      "link_id",
      "job_sheet_id",
      "recording_id",
      "transcript_id",
      "created_at",
      "created_by",
    ],
    tbl_new_job_from_recording_keys: [
      "idempotency_key",
      "payload_hash",
      "job_sheet_id",
      "recording_id",
      "created_by",
      "created_at",
    ],
  };

  const context = {
    console,
    Logger: { log() {} },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty() { return null; } };
      },
    },
    Utils: {
      withLock(_n, _t, fn) {
        return fn();
      },
    },
    DB: {
      generateId(prefix) {
        return `${prefix}-TEST01`;
      },
      getHeaders(table) {
        if (!headers[table]) throw new Error("missing " + table);
        return headers[table].slice();
      },
      insertRecord(table, row) {
        if (table === "tbl_job_sheets") {
          jobs[row.job_sheet_id] = { ...row };
          return jobs[row.job_sheet_id];
        }
        if (table === "tbl_recordings") {
          recordings[row.recording_id] = { ...row };
          return recordings[row.recording_id];
        }
        if (table === "tbl_job_recording_links") {
          links.push({ ...row });
          return row;
        }
        if (table === "tbl_new_job_from_recording_keys") {
          keys.push({ ...row });
          return row;
        }
        throw new Error("unexpected table " + table);
      },
      findById(table, key, id) {
        if (table === "tbl_job_sheets") return jobs[id] || null;
        if (table === "tbl_recordings") return recordings[id] || null;
        return null;
      },
      findWhere(table, cond) {
        if (table === "tbl_new_job_from_recording_keys") {
          return keys.filter((r) =>
            Object.keys(cond).every((k) => String(r[k]) === String(cond[k]))
          );
        }
        return [];
      },
      updateRecord(table, key, id, patch) {
        if (table === "tbl_recordings" && recordings[id]) {
          Object.assign(recordings[id], patch);
        }
      },
    },
    JobSheetRepository: {
      create(row) {
        const id = row.job_sheet_id || "JS-TEST01";
        const full = { ...row, job_sheet_id: id };
        jobs[id] = full;
        return full;
      },
      findById(id) {
        return jobs[id] || null;
      },
    },
    CustomerRepository: { findAll: () => [{ customer_id: "C1", customer_name: "Kat" }] },
    ProjectRepository: { findAll: () => [{ project_id: "P1", project_name: "Kat", customer_id: "C1" }] },
    StaffRepository: { findAll: () => [{ staff_id: "S1", staff_name: "Alex" }] },
    FieldOSGateway: {
      _assertManagerRole(role) {
        const r = String(role || "").toLowerCase();
        if (r !== "manager" && r !== "admin") {
          throw new Error("Forbidden: Manager or admin role required.");
        }
      },
      _normalizeJob(job) {
        return job;
      },
    },
    fieldosIsManagerOrAdmin_(role) {
      const r = String(role || "").toLowerCase();
      return r === "manager" || r === "admin";
    },
    fieldosPickWritableJobFields_(patch) {
      const headerSet = Object.fromEntries(headers.tbl_job_sheets.map((h) => [h, true]));
      const writable = {};
      const missing = [];
      Object.keys(patch || {}).forEach((k) => {
        if (headerSet[k]) writable[k] = patch[k];
        else missing.push(k);
      });
      return { writable, missing };
    },
    __jobs: jobs,
    __links: links,
    __keys: keys,
  };
  vm.createContext(context);
  // Only run NewJobFromRecording — helpers mocked above.
  vm.runInContext(src, context);
  return context;
}

test("creates job row respecting headers and link", () => {
  const ctx = load();
  const out = ctx.fieldosCreateJobSheetFromRecording_({
    actor_role: "manager",
    recording_id: "NJR-1",
    idempotency_key: "k1",
    payload_hash: "h1",
    created_by: "STAFF-MGR001",
    job_fields: {
      staff_id: "STAFF-DEMO001",
      date: "2026-08-04",
      project_id: "Kat and James Dykes",
      manager_notes: "Inspect beds",
      processing_status: "",
      processing_error: "",
      approval_status: "Pending Review",
      customer_name: "SHOULD_NOT_WRITE",
    },
    recording_drive_file_id: "drive-1",
    recording_file_url: "https://drive.example/1",
    transcript: "hello",
  });
  assert.equal(out.job.job_sheet_id, "JS-TEST01");
  assert.equal(out.idempotent, false);
  assert.ok(out.headers.includes("staff_id"));
  assert.ok(out.missing_job_fields.includes("customer_name"));
  assert.equal(ctx.__links.length, 1);
  assert.equal(ctx.__links[0].recording_id, "NJR-1");
});

test("rejects forbidden fields", () => {
  const ctx = load();
  assert.throws(
    () =>
      ctx.fieldosPickCreateJobFromRecordingPayload_({
        recording_id: "x",
        audio_bytes: "nope",
      }),
    /Forbidden field/
  );
});

test("idempotency returns existing job; conflict on hash change", () => {
  const ctx = load();
  const body = {
    actor_role: "manager",
    recording_id: "NJR-2",
    idempotency_key: "k2",
    payload_hash: "hash-a",
    created_by: "STAFF-MGR001",
    job_fields: {
      staff_id: "STAFF-DEMO001",
      date: "2026-08-04",
      project_id: "Kat",
      manager_notes: "n",
      processing_status: "",
      processing_error: "",
      approval_status: "Pending Review",
    },
  };
  const first = ctx.fieldosCreateJobSheetFromRecording_(body);
  const second = ctx.fieldosCreateJobSheetFromRecording_(body);
  assert.equal(second.idempotent, true);
  assert.equal(second.job.job_sheet_id, first.job.job_sheet_id);
  assert.throws(
    () =>
      ctx.fieldosCreateJobSheetFromRecording_({
        ...body,
        payload_hash: "hash-b",
      }),
    /Conflict/
  );
});

test("staff role forbidden", () => {
  const ctx = load();
  assert.throws(
    () =>
      ctx.fieldosCreateJobSheetFromRecording_({
        actor_role: "staff",
        recording_id: "NJR-3",
        idempotency_key: "k3",
        job_fields: { staff_id: "S", date: "2026-08-01" },
      }),
    /Manager or admin/
  );
});

test("gateway and router wire actions", () => {
  assert.match(gatewaySrc, /create_job_sheet_from_recording/);
  assert.match(gatewaySrc, /list_job_create_masters/);
  const router = fs.readFileSync(path.join(__dirname, "..", "Router.js"), "utf8");
  assert.match(router, /create_job_sheet_from_recording/);
});
