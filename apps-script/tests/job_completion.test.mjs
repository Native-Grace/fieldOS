/**
 * Phase 3C job completion helpers + gateway tests.
 * Run: node --test apps-script/tests/job_completion.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helpersSrc = fs.readFileSync(
  path.join(__dirname, "..", "JobCompletionHelpers.js"),
  "utf8"
);
const completionSrc = fs.readFileSync(
  path.join(__dirname, "..", "JobCompletion.js"),
  "utf8"
);

function loadHelpers() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(helpersSrc, context);
  return context;
}

function loadCompletion(harness) {
  const tables = harness.tables;
  const context = {
    console,
    Logger: { log() {} },
    Utilities: { formatDate: () => "2026-07-01", getUuid: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    JobSheetRepository: {
      findById(id) {
        return harness.jobs[id] || null;
      },
    },
    SyncRepository: {
      create(row) {
        harness.sync.push(row);
      },
    },
    Utils: {
      withLock(_name, _timeout, fn) {
        return fn();
      },
    },
    DB: {
      generateId(prefix) {
        harness.idSeq += 1;
        return `${prefix}-T${harness.idSeq}`;
      },
      getSheet(table) {
        if (!tables[table]) throw new Error(`Database Error: Table '${table}' missing.`);
        return { name: table };
      },
      findWhere(table, cond) {
        return (tables[table] || []).filter((r) =>
          Object.keys(cond).every((k) => String(r[k]) === String(cond[k]))
        );
      },
      findAll(table) {
        return (tables[table] || []).slice();
      },
      insertRecord(table, row) {
        tables[table] = tables[table] || [];
        tables[table].push({ ...row });
        return row;
      },
      updateRecord(table, key, id, patch) {
        const rows = tables[table] || [];
        const row = rows.find((r) => String(r[key]) === String(id));
        if (!row) throw new Error("missing");
        Object.assign(row, patch);
        return row;
      },
      deleteWhere(table, cond) {
        const before = tables[table] || [];
        tables[table] = before.filter(
          (r) => !Object.keys(cond).every((k) => String(r[k]) === String(cond[k]))
        );
        return before.length - tables[table].length;
      },
    },
    fieldosNormalizeRole_(role) {
      const r = String(role || "").toLowerCase();
      if (r === "admin" || r === "manager") return r;
      return "staff";
    },
    fieldosIsManagerOrAdmin_(role) {
      const r = String(role || "").toLowerCase();
      return r === "manager" || r === "admin";
    },
    OpenAI: undefined,
  };
  vm.createContext(context);
  vm.runInContext(helpersSrc, context);
  vm.runInContext(completionSrc, context);
  return context;
}

function approvedJob(overrides = {}) {
  return {
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-9012C021",
    date: "2026-07-22",
    processing_status: "Completed",
    approval_status: "Approved",
    ai_summary:
      "Supply and planting of seven trees, including site preparation and earthworks to reshape the driveway area.",
    client_requests: "",
    variations: "Extra driveway reshaping",
    manager_review_items: "Incomplete fragment about lunch.",
    travel_time: "",
    manager_notes: "ok",
    ai_transcript:
      "Planted seven trees. Did earthworks on the driveway. Had lunch. Actually no lunch today.",
    ...overrides,
  };
}

function harness(overrides = {}) {
  return {
    jobs: { "21759f5d": approvedJob() },
    tables: {
      tbl_job_completions: [],
      tbl_job_labour: [],
      tbl_job_machinery: [],
      tbl_job_materials: [],
    },
    sync: [],
    idSeq: 0,
    ...overrides,
  };
}

test("labour calculation subtracts break and keeps travel separate", () => {
  const ctx = loadHelpers();
  const calc = ctx.fieldosComputeLabourEntry_({
    start_time: "08:00",
    finish_time: "16:30",
    break_minutes: 30,
    travel_minutes: 45,
  });
  assert.equal(calc.ok, true);
  assert.equal(calc.gross_minutes, 510);
  assert.equal(calc.net_labour_minutes, 480);
  assert.equal(calc.labour_hours, 8);
  assert.equal(calc.travel_hours, 0.75);
});

test("negative break and break over shift rejected", () => {
  const ctx = loadHelpers();
  const neg = ctx.fieldosComputeLabourEntry_({
    start_time: "08:00",
    finish_time: "12:00",
    break_minutes: -5,
  });
  assert.equal(neg.ok, false);
  const over = ctx.fieldosComputeLabourEntry_({
    start_time: "08:00",
    finish_time: "09:00",
    break_minutes: 90,
  });
  assert.equal(over.ok, false);
});

test("draft does not fabricate foreign staff IDs and warns on lunch contradiction", () => {
  const ctx = loadHelpers();
  const draft = ctx.fieldosBuildCompletionDraftFromJob_(approvedJob());
  assert.equal(draft.labour_entries[0].staff_id, "STAFF-9012C021");
  assert.equal(draft.labour_entries[0].billable, false);
  assert.equal(draft.labour_entries[0].confirmation_status, "Suggested");
  assert.ok(draft.material_entries.some((m) => m.quantity === 7));
  assert.ok(draft.warnings.some((w) => /contradictory lunch/i.test(w)));
  assert.ok(!draft.labour_entries.some((l) => l.staff_id === "MADE-UP"));
});

test("approved job required and max one active completion", () => {
  const h = harness({
    jobs: {
      "21759f5d": approvedJob({ approval_status: "Pending Review" }),
    },
  });
  const ctx = loadCompletion(h);
  assert.throws(
    () =>
      ctx.FieldOSJobCompletion.createJobCompletionDraft({
        job_sheet_id: "21759f5d",
        actor_role: "manager",
        staff_id: "STAFF-MGR001",
      }),
    /Approved/
  );

  h.jobs["21759f5d"].approval_status = "Approved";
  ctx.FieldOSJobCompletion.createJobCompletionDraft({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
    actor_identity: "manager@nativegrace.com",
  });
  assert.throws(
    () =>
      ctx.FieldOSJobCompletion.createJobCompletionDraft({
        job_sheet_id: "21759f5d",
        actor_role: "manager",
        staff_id: "STAFF-MGR001",
      }),
    /already exists/
  );
});

test("generate draft + staff mutation rejected + audit sanitised", () => {
  const h = harness();
  const ctx = loadCompletion(h);
  const out = ctx.FieldOSJobCompletion.generateJobCompletionDraft({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
    actor_identity: "manager@nativegrace.com",
  });
  assert.equal(out.data.completion.completion_status, "Draft");
  assert.ok(out.data.labour_entries.length >= 1);
  assert.throws(
    () =>
      ctx.FieldOSJobCompletion.updateJobCompletion({
        job_sheet_id: "21759f5d",
        actor_role: "staff",
        staff_id: "STAFF-9012C021",
        work_summary: "hack",
      }),
    /Forbidden/
  );
  assert.ok(h.sync.length >= 1);
  const payload = JSON.stringify(h.sync[0].request_payload);
  assert.ok(!payload.includes("Had lunch"));
  assert.ok(!payload.includes("SECRET"));
});

test("stale version rejected and finalise/reopen flow", () => {
  const h = harness();
  const ctx = loadCompletion(h);
  let data = ctx.FieldOSJobCompletion.generateJobCompletionDraft({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
    actor_identity: "mgr",
  }).data;

  assert.throws(
    () =>
      ctx.FieldOSJobCompletion.updateJobCompletion({
        job_sheet_id: "21759f5d",
        actor_role: "manager",
        staff_id: "STAFF-MGR001",
        expected_version: 999,
        work_summary: "x",
      }),
    /Conflict/
  );

  const labour = data.labour_entries.map((row) => ({
    ...row,
    start_time: "07:00",
    finish_time: "15:00",
    break_minutes: 30,
    confirmation_status: "Confirmed",
    billable: true,
  }));
  const machinery = data.machinery_entries.map((row) => ({
    ...row,
    duration_hours: 2,
    confirmation_status: "Confirmed",
  }));
  const materials = data.material_entries.map((row) => ({
    ...row,
    confirmation_status: "Confirmed",
  }));

  data = ctx.FieldOSJobCompletion.updateJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
    expected_version: data.completion.version,
    work_summary: data.completion.work_summary,
    invoice_description: data.completion.invoice_description,
    labour_entries: labour,
    machinery_entries: machinery,
    material_entries: materials,
    warnings: [],
  }).data;

  assert.equal(data.completion.total_labour_hours, 7.5);

  data = ctx.FieldOSJobCompletion.finaliseJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
    actor_identity: "mgr",
    expected_version: data.completion.version,
    override_reason: "Reviewed contradictory lunch notes.",
  }).data;
  assert.equal(data.completion.completion_status, "Finalised");
  assert.ok(data.completion.finalised_by);

  data = ctx.FieldOSJobCompletion.reopenJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
    actor_identity: "mgr",
    expected_version: data.completion.version,
    reopen_reason: "Adjust break minutes",
  }).data;
  assert.equal(data.completion.completion_status, "Reopened");
});

test("finalisation blocked when suggested rows remain", () => {
  const h = harness();
  const ctx = loadCompletion(h);
  const data = ctx.FieldOSJobCompletion.generateJobCompletionDraft({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
  }).data;
  assert.throws(
    () =>
      ctx.FieldOSJobCompletion.finaliseJobCompletion({
        job_sheet_id: "21759f5d",
        actor_role: "manager",
        staff_id: "STAFF-MGR001",
        expected_version: data.completion.version,
      }),
    /Suggested|Validation Error/
  );
});
