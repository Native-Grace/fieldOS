/**
 * Node tests for FieldOSGateway invalidate_recording / delete_recording.
 * Run: node --test apps-script/tests/recording_management.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewaySrc = fs.readFileSync(
  path.join(__dirname, "..", "FieldOSGateway.js"),
  "utf8"
);
const vpSrc = fs.readFileSync(
  path.join(__dirname, "..", "VoiceProcessing.js"),
  "utf8"
);
const openaiSrc = fs.readFileSync(path.join(__dirname, "..", "OpenAI.js"), "utf8");

function loadGateway(harness) {
  const context = {
    console,
    Utilities: {
      formatDate: () => "2026-07-01",
      getUuid: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    },
    Session: { getScriptTimeZone: () => "Australia/Sydney" },
    ContentService: {
      createTextOutput: (s) => ({ setMimeType() { return s; }, getContent() { return s; } }),
      MimeType: { JSON: "json" },
    },
    Logger: { log() {} },
    JobSheetRepository: {
      findById(id) {
        return harness.jobs[id] || null;
      },
    },
    RecordingRepository: {
      find() {
        throw new Error("broken");
      },
    },
    SyncRepository: {
      create(row) {
        harness.sync.push(row);
      },
    },
    DB: {
      findById(table, key, id) {
        harness.dbCalls.push({ op: "findById", table, key, id });
        if (typeof table !== "string") throw new Error("bad table");
        return harness.recordings.find((r) => String(r[key]) === String(id)) || null;
      },
      findWhere(table, cond) {
        harness.dbCalls.push({ op: "findWhere", table, cond });
        return harness.recordings.filter((r) =>
          Object.keys(cond).every((k) => String(r[k]) === String(cond[k]))
        );
      },
      insertRecord() {},
      updateRecord(table, key, id, patch) {
        harness.dbCalls.push({ op: "updateRecord", table, key, id, patch });
        const row = harness.recordings.find((r) => String(r[key]) === String(id));
        if (!row) throw new Error("missing");
        Object.assign(row, patch);
      },
      deleteWhere(table, cond) {
        harness.dbCalls.push({ op: "deleteWhere", table, cond });
        const before = harness.recordings.length;
        harness.recordings = harness.recordings.filter(
          (r) => !Object.keys(cond).every((k) => String(r[k]) === String(cond[k]))
        );
        return before - harness.recordings.length;
      },
    },
    DriveApp: {
      getFileById(id) {
        return {
          setTrashed() {
            harness.drive.push({ op: "trash", id });
          },
        };
      },
    },
    Drive: harness.useAdvancedDrive
      ? {
          Files: {
            remove(id) {
              if (harness.driveDeleteFail) {
                const err = new Error("insufficientFilePermissions");
                throw err;
              }
              harness.drive.push({ op: "remove", id });
            },
          },
        }
      : undefined,
    fieldosLoadDisplayMaps_: () => ({
      projectById: {},
      customerById: {},
      projectByExactName: {},
      projectByNormName: {},
    }),
    fieldosResolveProjectCustomer_: (key) => ({
      project_name: key,
      customer_name: "",
      match: null,
      warning: null,
    }),
  };
  vm.createContext(context);
  vm.runInContext(gatewaySrc, context);
  return context;
}

function baseHarness(overrides = {}) {
  return {
    jobs: {
      "21759f5d": {
        job_sheet_id: "21759f5d",
        staff_id: "STAFF-9012C021",
        processing_status: "Draft",
        project_id: "Babidge",
      },
    },
    recordings: [
      {
        recording_id: "REC-OK",
        job_sheet_id: "21759f5d",
        recording_drive_file_id: "drive-ok",
        status: "Saved",
        recording_order: 1,
      },
    ],
    sync: [],
    drive: [],
    dbCalls: [],
    useAdvancedDrive: true,
    driveDeleteFail: false,
    ...overrides,
  };
}

test("invalidate_recording updates correct row", () => {
  const harness = baseHarness();
  const ctx = loadGateway(harness);
  const out = ctx.FieldOSGateway.invalidateRecording({
    job_sheet_id: "21759f5d",
    recording_id: "REC-OK",
    staff_id: "STAFF-9012C021",
    reason: "Bad take",
  });
  assert.equal(out.data.recording_status, "Invalid");
  assert.equal(harness.recordings[0].status, "Invalid");
  assert.equal(harness.recordings[0].invalid_reason, "Bad take");
});

test("recording/job mismatch rejected", () => {
  const harness = baseHarness({
    recordings: [
      {
        recording_id: "REC-OTHER",
        job_sheet_id: "other-job",
        recording_drive_file_id: "x",
        status: "Saved",
      },
    ],
  });
  const ctx = loadGateway(harness);
  assert.throws(
    () =>
      ctx.FieldOSGateway.invalidateRecording({
        job_sheet_id: "21759f5d",
        recording_id: "REC-OTHER",
        staff_id: "STAFF-9012C021",
        reason: "x",
      }),
    /Recording not found/
  );
});

test("Processing job blocks mutation", () => {
  const harness = baseHarness();
  harness.jobs["21759f5d"].processing_status = "Processing";
  const ctx = loadGateway(harness);
  assert.throws(
    () =>
      ctx.FieldOSGateway.deleteRecording({
        job_sheet_id: "21759f5d",
        recording_id: "REC-OK",
        staff_id: "STAFF-9012C021",
      }),
    /Processing/
  );
  assert.equal(harness.recordings.length, 1);
  assert.equal(harness.drive.length, 0);
});

test("delete_recording Drive cleanup before row delete", () => {
  const harness = baseHarness();
  const ctx = loadGateway(harness);
  const out = ctx.FieldOSGateway.deleteRecording({
    job_sheet_id: "21759f5d",
    recording_id: "REC-OK",
    staff_id: "STAFF-9012C021",
  });
  assert.equal(out.data.drive_outcome, "deleted");
  assert.deepEqual(
    harness.drive.map((d) => d.op),
    ["remove"]
  );
  assert.equal(harness.recordings.length, 0);
  const deleteIdx = harness.dbCalls.findIndex((c) => c.op === "deleteWhere");
  assert.ok(deleteIdx >= 0);
});

test("trash fallback when permanent delete denied", () => {
  const harness = baseHarness({ driveDeleteFail: true });
  const ctx = loadGateway(harness);
  const out = ctx.FieldOSGateway.deleteRecording({
    job_sheet_id: "21759f5d",
    recording_id: "REC-OK",
    staff_id: "STAFF-9012C021",
  });
  assert.equal(out.data.drive_outcome, "trashed");
  assert.ok(harness.drive.some((d) => d.op === "trash"));
  assert.equal(harness.recordings.length, 0);
});

test("cleanup failure preserves row", () => {
  const harness = baseHarness({ useAdvancedDrive: false });
  const ctx = loadGateway(harness);
  ctx.DriveApp.getFileById = function () {
    throw new Error("no access");
  };
  assert.throws(
    () =>
      ctx.FieldOSGateway.deleteRecording({
        job_sheet_id: "21759f5d",
        recording_id: "REC-OK",
        staff_id: "STAFF-9012C021",
      }),
    /Drive cleanup failed/
  );
  assert.equal(harness.recordings.length, 1);
});

function makeBlob({ name = "", contentType = "", bytes = [1, 2, 3] } = {}) {
  let _name = name;
  let _type = contentType;
  let _bytes = bytes.slice();
  return {
    getName: () => _name,
    getContentType: () => _type,
    getBytes: () => _bytes,
    copyBlob: () => makeBlob({ name: _name, contentType: _type, bytes: _bytes }),
    setName: (n) => {
      _name = n;
    },
    setContentType: (t) => {
      _type = t;
    },
  };
}

function loadVoice() {
  const openaiCalls = [];
  const context = {
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k === "OPENAI_API_KEY" ? "sk-test" : null),
      }),
    },
    UrlFetchApp: {
      fetch() {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ text: "ok" }),
        };
      },
    },
    Utilities: {
      newBlob() {
        return makeBlob();
      },
    },
    Logger: { log() {} },
    __openaiCalls: openaiCalls,
  };
  vm.createContext(context);
  vm.runInContext(openaiSrc, context);
  vm.runInContext(vpSrc, context);
  context.OpenAI = {
    transcribeAudio(blob) {
      openaiCalls.push(blob.getName());
      return "whisper:" + blob.getName();
    },
  };
  return context;
}

test("Invalid rows skipped by VoiceProcessing with no OpenAI call", () => {
  const ctx = loadVoice();
  ctx.VoiceProcessingService._getSpreadsheet = () => ({});
  ctx.VoiceProcessingService._getRecords = () => [
    {
      job_sheet_id: "21759f5d",
      recording_id: "REC-BAD",
      recording_order: 1,
      status: "Invalid",
      recording_drive_file_id: "x",
      _sheetRowIndex: 2,
    },
    {
      job_sheet_id: "21759f5d",
      recording_id: "REC-GOOD",
      recording_order: 2,
      status: "Saved",
      recording_drive_file_id: "y",
      _sheetRowIndex: 3,
    },
  ];
  ctx.VoiceProcessingService._resolveRecordingDriveFile = (rec) => {
    assert.notEqual(rec.recording_id, "REC-BAD");
    return {
      getName: () => "ok.webm",
      getBlob: () =>
        makeBlob({ name: "ok.webm", contentType: "audio/webm", bytes: [1, 2, 3, 4] }),
    };
  };
  ctx.VoiceProcessingService._updateRowValue = () => {};
  const out = ctx.VoiceProcessingService.processJobSheetRecordings("21759f5d");
  assert.equal(out, "whisper:ok.webm");
  assert.equal(ctx.__openaiCalls.length, 1);
});

test("Invalid-only job excluded from aggregation", () => {
  const ctx = loadVoice();
  ctx.VoiceProcessingService._getSpreadsheet = () => ({});
  ctx.VoiceProcessingService._getRecords = () => [
    {
      job_sheet_id: "21759f5d",
      recording_id: "REC-BAD",
      recording_order: 1,
      status: "Invalid",
      _sheetRowIndex: 2,
    },
  ];
  assert.throws(
    () => ctx.VoiceProcessingService.processJobSheetRecordings("21759f5d"),
    /No successful transcriptions/
  );
  assert.equal(ctx.__openaiCalls.length, 0);
});
