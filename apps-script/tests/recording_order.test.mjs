/**
 * recording_order assignment + deterministic aggregation tie-break.
 * Run: node --test apps-script/tests/recording_order.test.mjs
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
const vpSrc = fs.readFileSync(path.join(__dirname, "..", "VoiceProcessing.js"), "utf8");

function loadGateway(harness) {
  const context = {
    console,
    Utilities: {
      formatDate: () => "2026-07-01",
      getUuid: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    },
    Session: { getScriptTimeZone: () => "Australia/Sydney" },
    ContentService: {
      createTextOutput: (s) => ({
        setMimeType() {
          return s;
        },
        getContent() {
          return s;
        },
      }),
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
    Utils: {
      withLock(_name, _timeout, fn) {
        harness.lockCalls = (harness.lockCalls || 0) + 1;
        return fn();
      },
    },
    DB: {
      findWhere(table, cond) {
        return harness.recordings.filter((r) =>
          Object.keys(cond).every((k) => String(r[k]) === String(cond[k]))
        );
      },
      findById() {
        return null;
      },
      insertRecord(table, row, options) {
        harness.inserts.push({
          table,
          alreadyLocked: !!(options && options.alreadyLocked),
          row: { ...row },
        });
        harness.recordings.push({ ...row });
        return row;
      },
    },
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

function loadVp() {
  const context = {
    console,
    Logger: { log() {} },
    Config: { QUEUE_STATUS: { COMPLETED: "Completed" } },
    JobSheetRepository: { update() {}, findById() { return null; } },
    OpenAI: { chatComplete() { return "{}"; }, transcribeAudio() { return ""; } },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty() { return "sk-test"; } };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(vpSrc, context);
  return context;
}

function baseHarness(overrides = {}) {
  return {
    jobs: {
      "21759f5d": {
        job_sheet_id: "21759f5d",
        staff_id: "STAFF-9012C021",
        processing_status: "Draft",
      },
    },
    recordings: [
      {
        recording_id: "REC-2",
        job_sheet_id: "21759f5d",
        recording_order: 2,
        status: "Processed",
      },
      {
        recording_id: "REC-8A",
        job_sheet_id: "21759f5d",
        recording_order: 8,
        status: "Invalid",
      },
    ],
    sync: [],
    inserts: [],
    lockCalls: 0,
    ...overrides,
  };
}

const registerPayload = (overrides = {}) => ({
  job_sheet_id: "21759f5d",
  staff_id: "STAFF-9012C021",
  recording_drive_file_id: "drive-new",
  recording_file_url: "https://drive.example/new",
  recording_name: "new.webm",
  duration_seconds: 1.5,
  created_by: "alex@nativegrace.com",
  ...overrides,
});

test("max + 1 assignment after gap / existing max 8", () => {
  const harness = baseHarness();
  const ctx = loadGateway(harness);
  assert.equal(ctx.fieldosNextRecordingOrderFromRows_(harness.recordings), 9);
  const out = ctx.FieldOSGateway.registerRecording(registerPayload());
  assert.equal(out.data.recording_order, 9);
  assert.equal(harness.lockCalls, 1);
  assert.equal(harness.inserts[0].alreadyLocked, true);
});

test("duplicate client-supplied order is ignored", () => {
  const harness = baseHarness();
  const ctx = loadGateway(harness);
  const out = ctx.FieldOSGateway.registerRecording(
    registerPayload({ recording_order: 8, recording_id: "REC-CLIENT" })
  );
  assert.equal(out.data.recording_order, 9);
  assert.equal(out.data.recording_id, "REC-CLIENT");
  const syncReq = JSON.parse(harness.sync[0].request_payload);
  assert.equal(syncReq.client_recording_order_ignored, true);
});

test("stale client detail (low order) does not win", () => {
  const harness = baseHarness();
  const ctx = loadGateway(harness);
  const out = ctx.FieldOSGateway.registerRecording(
    registerPayload({ recording_order: 3 })
  );
  assert.equal(out.data.recording_order, 9);
});

test("two near-concurrent uploads get distinct orders via re-read under lock", () => {
  const harness = baseHarness();
  const ctx = loadGateway(harness);
  const a = ctx.FieldOSGateway.registerRecording(
    registerPayload({ recording_id: "REC-A", recording_drive_file_id: "d-a" })
  );
  const b = ctx.FieldOSGateway.registerRecording(
    registerPayload({ recording_id: "REC-B", recording_drive_file_id: "d-b" })
  );
  assert.equal(a.data.recording_order, 9);
  assert.equal(b.data.recording_order, 10);
  const orders = harness.recordings
    .filter((r) => r.recording_id === "REC-A" || r.recording_id === "REC-B")
    .map((r) => r.recording_order);
  assert.deepEqual(orders.sort((x, y) => x - y), [9, 10]);
});

test("length+1 would collide after deletion; max+1 does not", () => {
  // Live-shaped: missing order 1, max=8, length=7 → length+1 === 8 collision.
  const rows = [
    { recording_order: 2 },
    { recording_order: 3 },
    { recording_order: 4 },
    { recording_order: 5 },
    { recording_order: 6 },
    { recording_order: 7 },
    { recording_order: 8 },
  ];
  const ctx = loadGateway(baseHarness({ recordings: [] }));
  assert.equal(rows.length + 1, 8);
  assert.equal(ctx.fieldosNextRecordingOrderFromRows_(rows), 9);
});

test("nonnumeric / missing existing order ignored for max", () => {
  const ctx = loadGateway(baseHarness({ recordings: [] }));
  assert.equal(
    ctx.fieldosNextRecordingOrderFromRows_([
      { recording_order: "" },
      { recording_order: "abc" },
      { recording_order: null },
      { recording_order: 4 },
    ]),
    5
  );
  assert.equal(ctx.fieldosNextRecordingOrderFromRows_([]), 1);
  assert.equal(ctx.fieldosNextRecordingOrderFromRows_([{ recording_order: undefined }]), 1);
});

test("aggregation deterministic tie-break for legacy duplicate orders", () => {
  const ctx = loadVp();
  const sorted = ctx.fieldosVpSortRecordingsByOrder_([
    {
      recording_id: "REC-A8A33827",
      recording_order: 8,
      created_at: "2026-07-23T15:23:16.374Z",
      status: "Processed",
      transcript: "second dup",
    },
    {
      recording_id: "REC-2CA16A87",
      recording_order: 8,
      created_at: "2026-07-23T15:13:08.128Z",
      status: "Invalid",
      transcript: "first dup invalid",
    },
    {
      recording_id: "REC-EARLIER-ID-Z",
      recording_order: 8,
      created_at: "2026-07-23T15:13:08.128Z",
      status: "Processed",
      transcript: "same ts earlier id",
    },
  ]);
  assert.deepEqual(
    sorted.map((r) => r.recording_id),
    ["REC-2CA16A87", "REC-EARLIER-ID-Z", "REC-A8A33827"]
  );

  const agg = ctx.fieldosVpAggregateEligibleTranscripts_(sorted);
  // Invalid skipped; same-order remaining sorted by created_at then recording_id
  assert.equal(agg.recordingCount, 2);
  assert.match(agg.text, /^\[Recording 1\]\nsame ts earlier id/);
  assert.match(agg.text, /\[Recording 2\]\nsecond dup/);
});
