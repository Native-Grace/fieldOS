/**
 * Phase 3C hotfix — get_job_detail must stay lightweight and isolated.
 * Run: node --test apps-script/tests/get_job_detail_perf.test.mjs
 *
 * Guards against the post-3C 504 regression: get_job_detail must NOT touch
 * completion tables, OpenAI, locks, writes, or recurse into get_job_completion.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const displaySrc = fs.readFileSync(
  path.join(__dirname, "..", "FieldOSDisplayLookup.js"),
  "utf8"
);
const gatewaySrc = fs.readFileSync(
  path.join(__dirname, "..", "FieldOSGateway.js"),
  "utf8"
);

const COMPLETION_TABLES = [
  "tbl_job_completions",
  "tbl_job_labour",
  "tbl_job_machinery",
  "tbl_job_materials",
];

function buildContext(harness) {
  const accessed = harness.accessed;
  const writes = harness.writes;
  const locks = harness.locks;
  const openaiCalls = harness.openaiCalls;

  function readTable(table) {
    accessed.push(table);
    return (harness.tables[table] || []).slice();
  }

  const DB = {
    getSheet(table) {
      accessed.push(table);
      if (!harness.tables[table]) throw new Error(`Database Error: Table '${table}' missing.`);
      return { name: table };
    },
    findAll(table) {
      return readTable(table);
    },
    findWhere(table, cond) {
      return readTable(table).filter((r) =>
        Object.keys(cond).every((k) => String(r[k]) === String(cond[k]))
      );
    },
    findById(table, key, id) {
      const rows = readTable(table).filter((r) => String(r[key]) === String(id));
      return rows[0] || null;
    },
    insertRecord(table) {
      writes.push({ op: "insert", table });
      throw new Error("get_job_detail must not write");
    },
    updateRecord(table) {
      writes.push({ op: "update", table });
      throw new Error("get_job_detail must not write");
    },
    deleteWhere(table) {
      writes.push({ op: "delete", table });
      throw new Error("get_job_detail must not write");
    },
    generateId: (p) => `${p}-X`,
  };

  const repo = (table, key) => ({
    findById: (id) => DB.findById(table, key, id),
    find: (cond) => DB.findWhere(table, cond),
    findByField: (f, v) => DB.findWhere(table, { [f]: v })[0] || null,
    findAll: () => DB.findAll(table),
  });

  const FieldOSJobCompletion = {
    getJobCompletion() {
      harness.recursion.push("getJobCompletion");
      throw new Error("get_job_detail must not call get_job_completion");
    },
  };

  const context = {
    console: { log: (m) => harness.logs.push(String(m)) },
    Logger: { log: (m) => harness.logs.push(String(m)) },
    Utilities: { formatDate: () => "2026-07-22", getUuid: () => "aaaa-bbbb" },
    Session: { getScriptTimeZone: () => "Australia/Sydney" },
    ContentService: {
      createTextOutput: (s) => ({ setMimeType: () => s }),
      MimeType: { JSON: "json" },
    },
    DB,
    JobSheetRepository: repo("tbl_job_sheets", "job_sheet_id"),
    RecordingRepository: repo("tbl_recordings", "recording_id"),
    ProjectRepository: repo("tbl_projects", "project_id"),
    CustomerRepository: repo("tbl_customers", "customer_id"),
    SyncRepository: {
      create() {
        writes.push({ op: "sync" });
        throw new Error("get_job_detail must not write audit rows");
      },
    },
    Utils: {
      withLock(name, _t, fn) {
        locks.push(name);
        return fn();
      },
    },
    OpenAI: {
      chatComplete() {
        openaiCalls.push(true);
        return "{}";
      },
      getApiKey: () => "sk-test",
    },
    FieldOSJobCompletion,
  };
  vm.createContext(context);
  vm.runInContext(displaySrc, context);
  vm.runInContext(gatewaySrc, context);
  return context;
}

function harnessBase(overrides = {}) {
  return {
    tables: {
      tbl_job_sheets: [
        {
          job_sheet_id: "21759f5d",
          staff_id: "STAFF-9012C021",
          date: "2026-07-22",
          project_id: "Kat and James Dykes",
          customer_name: "Kat Dykes",
          processing_status: "Completed",
          approval_status: "Approved",
          ai_summary: "Mowed lawns",
          ai_transcript: "SECRET_TRANSCRIPT",
        },
      ],
      tbl_recordings: [
        { recording_id: "REC-1", job_sheet_id: "21759f5d", recording_order: 1, status: "Processed", recording_drive_file_id: "drive-x", transcript: "hi" },
      ],
      tbl_projects: [],
      tbl_customers: [],
    },
    accessed: [],
    writes: [],
    locks: [],
    openaiCalls: [],
    recursion: [],
    logs: [],
    ...overrides,
  };
}

test("get_job_detail never accesses completion tables", () => {
  const h = harnessBase();
  const ctx = buildContext(h);
  ctx.FieldOSGateway.getJobDetail({
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-MGR001",
    actor_role: "manager",
  });
  for (const table of COMPLETION_TABLES) {
    assert.ok(!h.accessed.includes(table), `must not access ${table}`);
  }
});

test("get_job_detail performs no writes, locks, OpenAI, or recursion", () => {
  const h = harnessBase();
  const ctx = buildContext(h);
  ctx.FieldOSGateway.getJobDetail({
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-MGR001",
    actor_role: "manager",
  });
  assert.equal(h.writes.length, 0);
  assert.equal(h.locks.length, 0);
  assert.equal(h.openaiCalls.length, 0);
  assert.equal(h.recursion.length, 0);
});

test("get_job_detail skips project/customer master scans when customer present", () => {
  const h = harnessBase();
  const ctx = buildContext(h);
  ctx.FieldOSGateway.getJobDetail({
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-MGR001",
    actor_role: "manager",
  });
  assert.ok(!h.accessed.includes("tbl_projects"), "should skip tbl_projects when customer resolved");
  assert.ok(!h.accessed.includes("tbl_customers"), "should skip tbl_customers when customer resolved");
});

test("get_job_detail reads each required sheet at most once", () => {
  const h = harnessBase();
  const ctx = buildContext(h);
  ctx.FieldOSGateway.getJobDetail({
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-MGR001",
    actor_role: "manager",
  });
  const jobReads = h.accessed.filter((t) => t === "tbl_job_sheets").length;
  const recReads = h.accessed.filter((t) => t === "tbl_recordings").length;
  assert.equal(jobReads, 1);
  assert.equal(recReads, 1);
});

test("get_job_detail emits sanitised timing log without transcript", () => {
  const h = harnessBase();
  const ctx = buildContext(h);
  ctx.FieldOSGateway.getJobDetail({
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-MGR001",
    actor_role: "manager",
  });
  const timingLog = h.logs.find((l) => l.includes("get_job_detail") && l.includes("stages_ms"));
  assert.ok(timingLog, "timing log should be emitted");
  assert.doesNotMatch(timingLog, /SECRET_TRANSCRIPT|drive-x/);
  const parsed = JSON.parse(timingLog);
  assert.ok("total_ms" in parsed.stages_ms);
  assert.ok("job_lookup_ms" in parsed.stages_ms);
  assert.ok("recordings_lookup_ms" in parsed.stages_ms);
  assert.ok("customer_project_resolution_ms" in parsed.stages_ms);
});

test("get_job_detail returns for a job with many recordings", () => {
  const many = [];
  for (let i = 1; i <= 250; i++) {
    many.push({ recording_id: `REC-${i}`, job_sheet_id: "21759f5d", recording_order: i, status: "Processed" });
  }
  const h = harnessBase();
  h.tables.tbl_recordings = many;
  const ctx = buildContext(h);
  const out = ctx.FieldOSGateway.getJobDetail({
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-MGR001",
    actor_role: "manager",
  });
  assert.equal(out.data.recordings.length, 250);
});

test("manager get_job_detail authorised for unassigned job; staff blocked", () => {
  const h = harnessBase();
  const ctx = buildContext(h);
  const out = ctx.FieldOSGateway.getJobDetail({
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-OTHER",
    actor_role: "manager",
  });
  assert.equal(out.data.job.job_sheet_id, "21759f5d");
  assert.throws(
    () =>
      ctx.FieldOSGateway.getJobDetail({
        job_sheet_id: "21759f5d",
        staff_id: "STAFF-OTHER",
        actor_role: "staff",
      }),
    /not assigned/
  );
});

test("read-only timing diagnostic exists and logs stages only", () => {
  const h = harnessBase();
  const ctx = buildContext(h);
  assert.equal(typeof ctx.testFieldOSGetJobDetailTiming, "function");
  ctx.testFieldOSGetJobDetailTiming("21759f5d", "manager");
  const diag = h.logs.find((l) => l.includes("get_job_detail_timing"));
  assert.ok(diag);
  assert.doesNotMatch(diag, /SECRET_TRANSCRIPT/);
});
