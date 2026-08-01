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

const MAX_CREATE_RESPONSE_BYTES = 5 * 1024;

/** Legacy oversized create payload shape (pre-fix) for size comparison. */
function legacyCreateEnvelopeBytes({ jobSheetId, notes, recordings }) {
  const job = {
    job_sheet_id: jobSheetId,
    staff_id: "STAFF-1",
    date: "2026-08-01",
    project_id: "PROJ-6002C0A0",
    manager_notes: notes,
    processing_status: "Completed",
    processing_error: "",
    approval_status: "Pending Review",
  };
  const links = recordings.map((r, i) => ({
    link_id: `JRL-${i + 1}`,
    job_sheet_id: jobSheetId,
    recording_id: r.recording_id,
    transcript_id: "",
    work_session_id: "DWS-1",
    sequence: i + 1,
    created_at: "2026-08-01T00:00:00.000Z",
    created_by: "STAFF-1",
  }));
  const headers = [
    "job_sheet_id",
    "staff_id",
    "date",
    "project_id",
    "manager_notes",
    "processing_status",
    "processing_error",
    "approval_status",
  ];
  const handlerResult = {
    action: "create_completed_job_sheet_from_recordings",
    message: "Completed job sheet created",
    job_sheet_id: jobSheetId,
    data: {
      job_sheet_id: jobSheetId,
      record_id: jobSheetId,
      job,
      links,
      idempotent: false,
      headers,
      missing_job_fields: [],
    },
  };
  // fieldosJsonResponse previously promoted job + links to top level (double-wrap).
  const httpEnvelope = {
    status: "Success",
    action: handlerResult.action,
    message: handlerResult.message,
    record_id: jobSheetId,
    timestamp: "2026-08-01T00:00:00.000Z",
    job_sheet_id: jobSheetId,
    data: handlerResult.data,
    job,
    links,
    idempotent: false,
  };
  return Buffer.byteLength(JSON.stringify(httpEnvelope), "utf8");
}

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
        "link_count",
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
  const flushCalls = { n: 0 };
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
    SpreadsheetApp: {
      flush() {
        flushCalls.n += 1;
      },
    },
    Logger: {
      log() {},
    },
    JobSheetRepository: {
      create(writable) {
        const job = { ...writable };
        if (!job.job_sheet_id) {
          job.job_sheet_id = DB.generateId("JS");
        }
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

  // Minimal Router / gateway normalisation used by tests.
  sandbox.fieldosJsonResponse = function (status, action, message, recordId, data) {
    const response = {
      status,
      action,
      message,
      record_id: recordId || null,
      timestamp: "2026-08-01T00:00:00.000Z",
    };
    if (recordId) response.job_sheet_id = recordId;
    if (data !== undefined) {
      response.data = data;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        if (typeof data.idempotent === "boolean") response.idempotent = data.idempotent;
        if (!response.job_sheet_id && data.job_sheet_id) {
          response.job_sheet_id = data.job_sheet_id;
        }
      }
    }
    return JSON.stringify(response);
  };
  sandbox.routeCreateThroughRouter_ = function (handlerResult) {
    assert.notEqual(handlerResult.data, undefined);
    return JSON.parse(
      sandbox.fieldosJsonResponse(
        "Success",
        handlerResult.action,
        handlerResult.message,
        handlerResult.job_sheet_id,
        handlerResult.data
      )
    );
  };

  return { sandbox, tables, flushCalls };
}

describe("Daily Work Job Sheet Apps Script", () => {
  it("wires gateway and router", () => {
    assert.match(gatewaySrc, /create_completed_job_sheet_from_recordings/);
    assert.match(gatewaySrc, /get_completed_job_sheet_create_result/);
    assert.match(routerSrc, /create_completed_job_sheet_from_recordings/);
    assert.match(routerSrc, /get_completed_job_sheet_create_result/);
    assert.match(setupSrc, /migrateSchemaForDailyWorkSessions/);
    assert.match(setupSrc, /link_count/);
    // Gateway must not promote full job/links (double-wrap).
    assert.doesNotMatch(
      gatewaySrc.slice(gatewaySrc.indexOf("function fieldosJsonResponse")),
      /response\.job = data\.job/
    );
    assert.doesNotMatch(
      gatewaySrc.slice(gatewaySrc.indexOf("function fieldosJsonResponse")),
      /response\.links = data\.links/
    );
  });

  it("creates minimal response with job_sheet_id under 5KB", () => {
    const { sandbox, tables, flushCalls } = buildSandbox();
    const notes =
      "WORK COMPLETED\n- Pruned front hedges\n\nISSUES FOUND\n- Rear tap leaking\n\nFOLLOW-UP REQUIRED\n- Return to repair rear tap\n\nSUMMARY\nDone";
    const recordings = [
      { recording_id: "R1", sequence: 1, recording_drive_file_id: "drv1", transcript: "a ".repeat(200) },
      { recording_id: "R2", sequence: 2, recording_drive_file_id: "drv2", transcript: "b ".repeat(200) },
      { recording_id: "R3", sequence: 3, recording_drive_file_id: "drv3", transcript: "c ".repeat(200) },
    ];
    const result = sandbox.fieldosCreateCompletedJobSheetFromRecordings_({
      work_session_id: "DWS-1",
      idempotency_key: "key-1",
      payload_hash: "hash-1",
      created_by: "STAFF-1",
      actor_role: "staff",
      processing_type: "daily_work_dictation",
      reviewed_job_sheet: { work_completed: [{ text: "x" }], aggregated_transcript: "huge" },
      aggregated_transcript: "should not appear in response",
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
      recordings,
    });

    assert.ok(result.job_sheet_id);
    assert.equal(result.data.job_sheet_id, result.job_sheet_id);
    assert.equal(result.data.record_id, result.job_sheet_id);
    assert.equal(result.data.work_session_id, "DWS-1");
    assert.equal(result.data.idempotent, false);
    assert.equal(result.data.link_count, 3);
    assert.equal(result.message, "Completed job sheet created");
    assert.equal(Object.prototype.hasOwnProperty.call(result.data, "job"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.data, "links"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "job"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "links"), false);

    const blob = JSON.stringify(result);
    assert.ok(Buffer.byteLength(blob, "utf8") < MAX_CREATE_RESPONSE_BYTES);
    assert.equal(blob.includes("transcript"), false);
    assert.equal(blob.includes("aggregated_transcript"), false);
    assert.equal(blob.includes("reviewed_job_sheet"), false);
    assert.equal(blob.includes(notes.slice(0, 20)), false);

    const envelope = sandbox.routeCreateThroughRouter_(result);
    assert.equal(envelope.status, "Success");
    assert.equal(envelope.record_id, result.job_sheet_id);
    assert.equal(envelope.data.job_sheet_id, result.job_sheet_id);
    assert.equal(Object.prototype.hasOwnProperty.call(envelope, "job"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(envelope, "links"), false);
    const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
    assert.ok(envelopeBytes < MAX_CREATE_RESPONSE_BYTES);

    const beforeBytes = legacyCreateEnvelopeBytes({
      jobSheetId: result.job_sheet_id,
      notes,
      recordings,
    });
    assert.ok(beforeBytes > envelopeBytes);
    // Expose for operator report (asserted bounds).
    assert.ok(beforeBytes > 1000);
    assert.ok(envelopeBytes < 800);

    assert.equal(flushCalls.n, 1);
    assert.equal(tables.tbl_job_recording_links.rows.length, 3);
    assert.equal(tables.tbl_daily_work_create_keys.rows.length, 1);
    const keyRow = tables.tbl_daily_work_create_keys.rows[0];
    assert.equal(keyRow.job_sheet_id, result.job_sheet_id);
    assert.equal(keyRow.work_session_id, "DWS-1");
    assert.equal(Number(keyRow.link_count), 3);
    assert.ok(!String(keyRow.links_json || "").includes("transcript"));
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

  it("is idempotent for same key+hash and returns existing ID", () => {
    const { sandbox, tables } = buildSandbox();
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
    assert.equal(b.data.idempotent, true);
    assert.equal(b.message, "Existing completed job sheet returned");
    assert.equal(a.job_sheet_id, b.job_sheet_id);
    assert.equal(b.data.record_id, b.job_sheet_id);
    assert.equal(b.data.link_count, 1);
    assert.equal(tables.tbl_job_sheets.rows.length, 1);
    assert.equal(tables.tbl_daily_work_create_keys.rows.length, 1);
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

  it("create-key written before return and reconciliation finds it", () => {
    const { sandbox, tables } = buildSandbox();
    const created = sandbox.fieldosCreateCompletedJobSheetFromRecordings_({
      work_session_id: "DWS-4",
      idempotency_key: "key-lookup",
      payload_hash: "hash-lookup",
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
    });
    assert.equal(tables.tbl_daily_work_create_keys.rows.length, 1);
    assert.equal(tables.tbl_daily_work_create_keys.rows[0].job_sheet_id, created.job_sheet_id);

    const found = sandbox.fieldosGetCompletedJobSheetCreateResult_({
      work_session_id: "DWS-4",
      idempotency_key: "key-lookup",
    });
    assert.equal(found.data.found, true);
    assert.equal(found.job_sheet_id, created.job_sheet_id);
    assert.equal(found.data.job_sheet_id, created.job_sheet_id);
    assert.equal(found.data.payload_hash, "hash-lookup");
    assert.equal(found.data.job.job_sheet_id, created.job_sheet_id);
    assert.equal(Object.prototype.hasOwnProperty.call(found.data.job, "manager_notes"), false);

    const missing = sandbox.fieldosGetCompletedJobSheetCreateResult_({
      work_session_id: "DWS-MISSING",
      idempotency_key: "no-such-key",
    });
    assert.equal(missing.data.found, false);
    assert.equal(missing.data.job_sheet_id, "");
  });

  it("router keeps data and does not drop job_sheet_id", () => {
    const { sandbox } = buildSandbox();
    const result = sandbox.fieldosCompletedJobCreateRouterResult_({
      job_sheet_id: "JS-KEEP",
      work_session_id: "DWS-X",
      idempotent: false,
      link_count: 2,
    });
    const envelope = sandbox.routeCreateThroughRouter_(result);
    assert.equal(envelope.status, "Success");
    assert.equal(envelope.action, "create_completed_job_sheet_from_recordings");
    assert.equal(envelope.record_id, "JS-KEEP");
    assert.equal(envelope.job_sheet_id, "JS-KEEP");
    assert.deepEqual(envelope.data, {
      job_sheet_id: "JS-KEEP",
      record_id: "JS-KEEP",
      work_session_id: "DWS-X",
      idempotent: false,
      link_count: 2,
    });
  });
});
