/**
 * Apps Script tests for create_completed_job_sheet_from_recordings.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, "..", "DailyWorkJobSheet.js"), "utf8");
const setupSrc = fs.readFileSync(path.join(__dirname, "..", "Setup.js"), "utf8");
const gatewaySrc = fs.readFileSync(path.join(__dirname, "..", "FieldOSGateway.js"), "utf8");
const routerSrc = fs.readFileSync(path.join(__dirname, "..", "Router.js"), "utf8");

function buildSandbox() {
  const tables = {
    tbl_job_sheets: {
      headers: [
        "job_sheet_id",
        "staff_id",
        "date",
        "project_id",
        "manager_notes",
        "processing_status",
        "processing_error",
        "approval_status",
      ],
      rows: [],
    },
    tbl_job_recording_links: {
      headers: [
        "link_id",
        "job_sheet_id",
        "recording_id",
        "transcript_id",
        "work_session_id",
        "sequence",
        "created_at",
        "created_by",
      ],
      rows: [],
    },
    tbl_daily_work_create_keys: {
      headers: [
        "idempotency_key",
        "payload_hash",
        "job_sheet_id",
        "work_session_id",
        "created_by",
        "created_at",
        "links_json",
      ],
      rows: [],
    },
    tbl_daily_work_sessions: {
      headers: [
        "work_session_id",
        "work_date",
        "project_id",
        "staff_ids",
        "status",
        "created_at",
        "created_by",
        "updated_at",
        "version",
        "created_job_sheet_id",
      ],
      rows: [],
    },
    tbl_recordings: {
      headers: [
        "recording_id",
        "job_sheet_id",
        "recording_drive_file_id",
        "recording_file_url",
        "recording_name",
        "duration_seconds",
        "transcript",
        "status",
        "created_by",
        "created_at",
      ],
      rows: [],
    },
  };

  let seq = 1;
  const DB = {
    getHeaders(name) {
      if (!tables[name]) throw new Error("missing " + name);
      return tables[name].headers.slice();
    },
    generateId(prefix) {
      return prefix + "-" + String(seq++).padStart(4, "0");
    },
    insertRecord(name, row) {
      tables[name].rows.push({ ...row });
      return row;
    },
    findWhere(name, query) {
      return tables[name].rows.filter((r) =>
        Object.keys(query).every((k) => String(r[k] || "") === String(query[k] || ""))
      );
    },
    findById(name, idKey, id) {
      return tables[name].rows.find((r) => String(r[idKey]) === String(id)) || null;
    },
    updateRecord(name, idKey, id, patch) {
      const row = tables[name].rows.find((r) => String(r[idKey]) === String(id));
      if (row) Object.assign(row, patch);
      return row;
    },
  };

  const sandbox = {
    DB,
    Utils: {
      withLock(_name, _ms, fn) {
        return fn();
      },
    },
    JobSheetRepository: {
      create(writable) {
        const job = {
          job_sheet_id: DB.generateId("JS"),
          ...writable,
        };
        // Reject customer_name write
        if (Object.prototype.hasOwnProperty.call(writable, "customer_name")) {
          throw new Error("customer_name must not be written");
        }
        tables.tbl_job_sheets.rows.push(job);
        return job;
      },
      findById(id) {
        return DB.findById("tbl_job_sheets", "job_sheet_id", id);
      },
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty() {
            return null;
          },
        };
      },
    },
    FieldOSGateway: {
      _normalizeJob(job) {
        return job;
      },
      _assertManagerRole() {},
    },
    fieldosNormalizeJobForApi_(job) {
      return job;
    },
    fieldosPickWritableJobFields_(patch) {
      const allowed = new Set([
        "job_sheet_id",
        "staff_id",
        "date",
        "project_id",
        "manager_notes",
        "processing_status",
        "processing_error",
        "approval_status",
      ]);
      const writable = {};
      const missing = [];
      Object.keys(patch || {}).forEach((k) => {
        if (allowed.has(k)) writable[k] = patch[k];
        else missing.push(k);
      });
      return { writable, missing };
    },
    fieldosRegisterLinkedRecording_(fields) {
      return DB.insertRecord("tbl_recordings", {
        recording_id: fields.recording_id,
        job_sheet_id: fields.job_sheet_id,
        recording_drive_file_id: fields.recording_drive_file_id,
        recording_file_url: fields.recording_file_url || "",
        recording_name: fields.recording_name || "",
        duration_seconds: fields.duration_seconds || 0,
        transcript: fields.transcript || "",
        status: "Processed",
        created_by: fields.staff_id || "",
        created_at: new Date().toISOString(),
      });
    },
    console,
  };

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { sandbox, tables };
}

describe("Daily Work Job Sheet Apps Script", () => {
  it("wires gateway and router", () => {
    assert.match(gatewaySrc, /create_completed_job_sheet_from_recordings/);
    assert.match(routerSrc, /create_completed_job_sheet_from_recordings/);
    assert.match(setupSrc, /migrateSchemaForDailyWorkSessions/);
  });

  it("creates completed job with supported headers only and multiple links", () => {
    const { sandbox, tables } = buildSandbox();
    const notes =
      "WORK COMPLETED\n- Pruned front hedges\n\nISSUES FOUND\n- Rear tap leaking\n\nFOLLOW-UP REQUIRED\n- Return to repair rear tap\n\nSUMMARY\nDone";
    const result = sandbox.fieldosCreateCompletedJobSheetFromRecordings_({
      work_session_id: "DWS-1",
      idempotency_key: "key-1",
      payload_hash: "hash-1",
      created_by: "STAFF-1",
      actor_role: "staff",
      processing_type: "daily_work_dictation",
      job_fields: {
        staff_id: "STAFF-1",
        date: "2026-08-01",
        project_id: "PROJ-6002C0A0",
        manager_notes: notes,
        processing_status: "Completed",
        processing_error: "",
        approval_status: "Pending Review",
        customer_name: "SHOULD_BE_STRIPPED_BY_PICK",
      },
      recordings: [
        { recording_id: "R1", sequence: 1, recording_drive_file_id: "drv1", transcript: "a" },
        { recording_id: "R2", sequence: 2, recording_drive_file_id: "drv2", transcript: "b" },
        { recording_id: "R3", sequence: 3, recording_drive_file_id: "drv3", transcript: "c" },
      ],
    });
    assert.equal(result.idempotent, false);
    assert.ok(result.job.job_sheet_id);
    assert.equal(result.job.processing_status, "Completed");
    assert.equal(result.job.approval_status, "Pending Review");
    assert.equal(result.job.manager_notes, notes);
    assert.equal(Object.prototype.hasOwnProperty.call(result.job, "customer_name"), false);
    assert.equal(result.links.length, 3);
    assert.equal(tables.tbl_job_recording_links.rows.length, 3);
    assert.ok(tables.tbl_job_recording_links.rows.every((l) => l.work_session_id === "DWS-1"));
    assert.ok(tables.tbl_job_recording_links.rows.every((l) => l.sequence >= 1));
  });

  it("rejects forbidden top-level fields", () => {
    const { sandbox } = buildSandbox();
    assert.throws(() => {
      sandbox.fieldosPickCreateCompletedJobPayload_({
        work_session_id: "DWS-1",
        audio_bytes: "nope",
      });
    }, /Forbidden/);
  });

  it("is idempotent for same key+hash", () => {
    const { sandbox } = buildSandbox();
    const body = {
      work_session_id: "DWS-2",
      idempotency_key: "key-idem",
      payload_hash: "hash-a",
      created_by: "STAFF-1",
      job_fields: {
        staff_id: "STAFF-1",
        date: "2026-08-01",
        project_id: "P1",
        manager_notes: "WORK COMPLETED\n- X",
        processing_status: "Completed",
        processing_error: "",
        approval_status: "Pending Review",
      },
      recordings: [{ recording_id: "R9", sequence: 1 }],
    };
    const a = sandbox.fieldosCreateCompletedJobSheetFromRecordings_(body);
    const b = sandbox.fieldosCreateCompletedJobSheetFromRecordings_(body);
    assert.equal(b.idempotent, true);
    assert.equal(a.job.job_sheet_id, b.job.job_sheet_id);
  });

  it("conflicts when idempotency key reused with different hash", () => {
    const { sandbox } = buildSandbox();
    const body = {
      work_session_id: "DWS-3",
      idempotency_key: "key-conflict",
      payload_hash: "hash-a",
      created_by: "STAFF-1",
      job_fields: {
        staff_id: "STAFF-1",
        date: "2026-08-01",
        project_id: "P1",
        manager_notes: "WORK COMPLETED\n- X",
        processing_status: "Completed",
        processing_error: "",
        approval_status: "Pending Review",
      },
      recordings: [{ recording_id: "R1", sequence: 1 }],
    };
    sandbox.fieldosCreateCompletedJobSheetFromRecordings_(body);
    assert.throws(() => {
      sandbox.fieldosCreateCompletedJobSheetFromRecordings_({
        ...body,
        payload_hash: "hash-b",
      });
    }, /Conflict/);
  });
});
