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
    Utilities: {
      formatDate(date, _tz, pattern) {
        if (pattern === "HH:mm" || pattern === "HH:MM") {
          const d = date instanceof Date ? date : new Date(date);
          const parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Australia/Sydney",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).formatToParts(d);
          const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
          const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
          return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        }
        return "2026-07-01";
      },
      getUuid: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    },
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
    SpreadsheetApp: {
      flush() {
        harness.flushCalls = (harness.flushCalls || 0) + 1;
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

test("generate draft returns minimal payload under 5KB and flushes", () => {
  const h = harness();
  h.flushCalls = 0;
  const ctx = loadCompletion(h);
  const out = ctx.FieldOSJobCompletion.generateJobCompletionDraft({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
    actor_identity: "manager@nativegrace.com",
  });
  assert.equal(out.message, "Completion draft generated");
  assert.ok(out.data.completion_id);
  assert.equal(out.data.job_sheet_id, "21759f5d");
  assert.equal(out.data.status, "Draft");
  assert.equal(out.data.generated, true);
  assert.equal(typeof out.data.labour_count, "number");
  assert.equal(Object.prototype.hasOwnProperty.call(out.data, "completion"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out.data, "labour_entries"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out.data, "machinery_entries"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out.data, "material_entries"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out.data, "job"), false);
  const blob = JSON.stringify(out);
  assert.ok(Buffer.byteLength(blob, "utf8") < 5 * 1024);
  assert.ok(Buffer.byteLength(blob, "utf8") < 1024);
  assert.equal(blob.includes("ai_transcript"), false);
  assert.equal(blob.includes("Had lunch"), false);
  assert.equal(h.flushCalls, 1);
  // Rows persisted before response.
  assert.ok(h.tables.tbl_job_completions.length >= 1);
  assert.equal(h.tables.tbl_job_completions[0].completion_id, out.data.completion_id);
  assert.ok(h.tables.tbl_job_labour.length >= 1);

  // Full payload available via get — not generate.
  const loaded = ctx.FieldOSJobCompletion.getJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
  }).data;
  assert.equal(loaded.completion.completion_id, out.data.completion_id);
  assert.ok(loaded.labour_entries.length >= 1);
});

test("generate draft + staff mutation rejected + audit sanitised", () => {
  const h = harness();
  const ctx = loadCompletion(h);
  const gen = ctx.FieldOSJobCompletion.generateJobCompletionDraft({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
    actor_identity: "manager@nativegrace.com",
  });
  assert.ok(gen.data.completion_id);
  const out = ctx.FieldOSJobCompletion.getJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
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
  ctx.FieldOSJobCompletion.generateJobCompletionDraft({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
    actor_identity: "mgr",
  });
  let data = ctx.FieldOSJobCompletion.getJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
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
  assert.equal(data.updated, true);
  assert.ok(data.version > 1);
  assert.equal(Object.prototype.hasOwnProperty.call(data, "completion"), false);

  data = ctx.FieldOSJobCompletion.getJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
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

test("blank times produce required errors only; malformed produce format only; no duplicates", () => {
  const ctx = loadHelpers();
  const blank = ctx.fieldosComputeLabourEntry_({
    start_time: "",
    finish_time: "",
    break_minutes: 0,
  });
  assert.equal(blank.ok, false);
  assert.equal(blank.errors.join("|"), "Start time is required.|Finish time is required.");
  assert.equal(blank.warnings.length, 0);

  const malformed = ctx.fieldosComputeLabourEntry_({
    start_time: "25:99",
    finish_time: "noon",
    break_minutes: 0,
  });
  assert.equal(malformed.ok, false);
  assert.equal(
    malformed.errors.join("|"),
    "Start time must use HH:MM.|Finish time must use HH:MM."
  );
  assert.ok(!malformed.errors.some((e) => /required/i.test(e)));

  const gate = ctx.fieldosValidateCompletionForFinalise_(
    {
      completion_status: "Draft",
      work_summary: "Work",
      invoice_description: "Invoice",
      warnings: [],
      warning_resolutions: [],
      labour_entries: [
        {
          start_time: "",
          finish_time: "",
          break_minutes: 0,
          confirmation_status: "Confirmed",
        },
      ],
      machinery_entries: [],
      material_entries: [],
    },
    approvedJob()
  );
  assert.equal(gate.ok, false);
  const required = gate.criticalErrors.filter((e) => /Start time is required|Finish time is required/.test(e));
  assert.equal(required.length, 2);
  assert.equal(new Set(gate.criticalErrors).size, gate.criticalErrors.length);
  assert.ok(!gate.criticalErrors.some((e) => /start_time and finish_time are required/i.test(e)));
});

test("resolved lunch contradiction with confirmed break allows finalisation", () => {
  const ctx = loadHelpers();
  const lunchWarning =
    "Contradictory lunch information in source text — confirm unpaid break manually.";
  const completion = {
    completion_status: "Draft",
    work_summary: "Planted trees",
    invoice_description: "Seven trees",
    warnings: [lunchWarning],
    warning_resolutions: [
      {
        warning_key: "contradictory_lunch",
        warning_text: lunchWarning,
        resolved: true,
        break_minutes: 30,
        resolution_note: "Confirmed 30 min unpaid lunch",
      },
    ],
    labour_entries: [
      {
        start_time: "07:00",
        finish_time: "15:00",
        break_minutes: 30,
        confirmation_status: "Confirmed",
      },
    ],
    machinery_entries: [],
    material_entries: [],
  };
  const gate = ctx.fieldosValidateCompletionForFinalise_(completion, approvedJob(), {
    override_reason: "",
  });
  assert.equal(gate.ok, true, gate.criticalErrors.join(" | "));
  assert.equal(gate.totals.total_labour_hours, 7.5);
});

test("unresolved lunch contradiction blocks finalisation even with override_reason", () => {
  const ctx = loadHelpers();
  const lunchWarning =
    "Contradictory lunch information in source text — confirm unpaid break manually.";
  const gate = ctx.fieldosValidateCompletionForFinalise_(
    {
      completion_status: "Draft",
      work_summary: "Planted trees",
      invoice_description: "Seven trees",
      warnings: [lunchWarning],
      warning_resolutions: [],
      labour_entries: [
        {
          start_time: "07:00",
          finish_time: "15:00",
          break_minutes: 30,
          confirmation_status: "Confirmed",
        },
      ],
      machinery_entries: [],
      material_entries: [],
    },
    approvedJob({ manager_review_items: "" }),
    { override_reason: "Please ignore lunch notes" }
  );
  assert.equal(gate.ok, false);
  assert.ok(gate.criticalErrors.some((e) => /Resolve lunch\/break contradiction/i.test(e)));
});

test("invalid arithmetic cannot be overridden", () => {
  const ctx = loadHelpers();
  const gate = ctx.fieldosValidateCompletionForFinalise_(
    {
      completion_status: "Draft",
      work_summary: "Planted trees",
      invoice_description: "Seven trees",
      warnings: [],
      warning_resolutions: [],
      labour_entries: [
        {
          start_time: "08:00",
          finish_time: "09:00",
          break_minutes: 90,
          confirmation_status: "Confirmed",
        },
      ],
      machinery_entries: [],
      material_entries: [],
    },
    approvedJob({ manager_review_items: "", ai_transcript: "Planted trees." }),
    { override_reason: "Manager override arithmetic" }
  );
  assert.equal(gate.ok, false);
  assert.ok(gate.criticalErrors.some((e) => /Break minutes cannot exceed/i.test(e)));
});

test("finalisation blocked when suggested rows remain", () => {
  const h = harness();
  const ctx = loadCompletion(h);
  ctx.FieldOSJobCompletion.generateJobCompletionDraft({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
  });
  const data = ctx.FieldOSJobCompletion.getJobCompletion({
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

test("clock normaliser accepts HH:MM, H:MM, Date, ISO, fraction; rejects free text", () => {
  const ctx = loadHelpers();
  assert.equal(ctx.fieldosNormaliseClockTime_("07:00"), "07:00");
  assert.equal(ctx.fieldosNormaliseClockTime_("7:00"), "07:00");
  assert.equal(ctx.fieldosNormaliseClockTime_(7 / 24), "07:00");
  assert.equal(ctx.fieldosNormaliseClockTime_("7"), null);
  assert.equal(ctx.fieldosNormaliseClockTime_("morning"), null);
  assert.equal(ctx.fieldosNormaliseClockTime_("7ish"), null);
  assert.equal(ctx.fieldosNormaliseClockTime_("7am to 5pm"), null);
  assert.equal(ctx.fieldosNormaliseClockTime_("7am"), null);

  // Sheets-like Date: wall-clock 07:00 in Australia/Sydney.
  const sheetDate = new Date("1899-12-30T07:00:00+10:00");
  assert.equal(ctx.fieldosNormaliseClockTime_(sheetDate), "07:00");

  // ISO that is 07:00 Sydney (AEST, July) — must not become 21:00 via UTC.
  const isoSydneySeven = "2026-07-25T21:00:00.000Z";
  assert.equal(ctx.fieldosNormaliseClockTime_(isoSydneySeven), "07:00");
  assert.equal(ctx.fieldosNormaliseClockTime_("1899-12-30T07:00:00.000Z"), "07:00");
  assert.equal(ctx.fieldosNormaliseClockTime_("1899-12-30T07:00:00.000+10:00"), "07:00");

  const diag = ctx.fieldosDescribeClockTime_(sheetDate);
  assert.equal(diag.type, "Date");
  assert.equal(diag.normalised, "07:00");
  assert.equal(diag.ok, true);
});

test("spreadsheet timezone stability: local 07:00 does not shift to UTC hour", () => {
  const ctx = loadHelpers();
  // Instant corresponding to 07:00 Australia/Sydney in winter (AEST = UTC+10).
  const instant = new Date("2026-07-26T07:00:00+10:00");
  assert.equal(ctx.fieldosNormaliseClockTime_(instant), "07:00");
  assert.equal(ctx.fieldosNormaliseClockTime_(instant.toISOString()), "07:00");
  // UTC formatting of the same instant is 21:00 previous day — prove we did not use that.
  assert.notEqual(instant.toISOString().slice(11, 16), "07:00");
});

test("read -> api -> save -> read round trip keeps canonical HH:MM", () => {
  const h = harness();
  const ctx = loadCompletion(h);
  ctx.FieldOSJobCompletion.generateJobCompletionDraft({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
  });
  let data = ctx.FieldOSJobCompletion.getJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
  }).data;

  // Simulate Sheets returning Date objects for time cells on read.
  const sheetStart = new Date("1899-12-30T07:00:00+10:00");
  const sheetFinish = new Date("1899-12-30T15:00:00+10:00");
  h.tables.tbl_job_labour[0].start_time = sheetStart;
  h.tables.tbl_job_labour[0].finish_time = sheetFinish;

  data = ctx.FieldOSJobCompletion.getJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
  }).data;
  assert.equal(data.labour_entries[0].start_time, "07:00");
  assert.equal(data.labour_entries[0].finish_time, "15:00");

  data = ctx.FieldOSJobCompletion.updateJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
    expected_version: data.completion.version,
    work_summary: data.completion.work_summary,
    invoice_description: data.completion.invoice_description,
    labour_entries: data.labour_entries.map((row) => ({
      ...row,
      confirmation_status: "Confirmed",
      break_minutes: 30,
    })),
    machinery_entries: (data.machinery_entries || []).map((row) => ({
      ...row,
      duration_hours: 1,
      confirmation_status: "Confirmed",
    })),
    material_entries: (data.material_entries || []).map((row) => ({
      ...row,
      confirmation_status: "Confirmed",
    })),
    warnings: [],
    warning_resolutions: [],
  }).data;
  assert.equal(data.updated, true);

  data = ctx.FieldOSJobCompletion.getJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
  }).data;

  assert.equal(data.labour_entries[0].start_time, "07:00");
  assert.equal(data.labour_entries[0].finish_time, "15:00");
  assert.equal(typeof h.tables.tbl_job_labour[0].start_time, "string");
  assert.equal(h.tables.tbl_job_labour[0].start_time, "07:00");
});

test("finalisation succeeds with canonical times after Sheets Date coercion", () => {
  const h = harness();
  const ctx = loadCompletion(h);
  ctx.FieldOSJobCompletion.generateJobCompletionDraft({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
  });
  let data = ctx.FieldOSJobCompletion.getJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
  }).data;

  h.tables.tbl_job_labour[0].start_time = new Date("1899-12-30T07:00:00+10:00");
  h.tables.tbl_job_labour[0].finish_time = new Date("1899-12-30T15:00:00+10:00");
  h.tables.tbl_job_labour[0].break_minutes = 30;
  h.tables.tbl_job_labour[0].confirmation_status = "Confirmed";
  (h.tables.tbl_job_machinery || []).forEach((row) => {
    row.duration_hours = 1;
    row.confirmation_status = "Confirmed";
  });
  (h.tables.tbl_job_materials || []).forEach((row) => {
    row.confirmation_status = "Confirmed";
  });
  h.tables.tbl_job_completions[0].warnings = "[]";
  h.tables.tbl_job_completions[0].warning_resolutions = "[]";
  h.tables.tbl_job_completions[0].work_summary = "Planted trees";
  h.tables.tbl_job_completions[0].invoice_description = "Seven trees";

  data = ctx.FieldOSJobCompletion.finaliseJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
    actor_identity: "mgr",
    expected_version: data.completion.version,
  }).data;
  assert.equal(data.completion.completion_status, "Finalised");
  assert.equal(data.labour_entries[0].start_time, "07:00");
  assert.equal(data.completion.total_labour_hours, 7.5);
});

test("material quantity normalisation accepts numbers strings decimals whitespace and unit split", () => {
  const ctx = loadHelpers();
  assert.equal(ctx.fieldosNormaliseMaterialQuantity_(2).quantity, 2);
  assert.equal(ctx.fieldosNormaliseMaterialQuantity_("2").quantity, 2);
  assert.equal(ctx.fieldosNormaliseMaterialQuantity_("2.5").quantity, 2.5);
  assert.equal(ctx.fieldosNormaliseMaterialQuantity_("0").quantity, 0);
  assert.equal(ctx.fieldosNormaliseMaterialQuantity_("  ").blank, true);
  assert.equal(ctx.fieldosNormaliseMaterialQuantity_(null).blank, true);
  const split = ctx.fieldosNormaliseMaterialQuantity_("2 bags");
  assert.equal(split.ok, true);
  assert.equal(split.quantity, 2);
  assert.equal(split.unit, "bags");
  assert.equal(ctx.fieldosNormaliseMaterialQuantity_("several").ok, false);
  assert.equal(ctx.fieldosNormaliseMaterialQuantity_("N/A").ok, false);
});

test("material text quantity rejected with row number; numeric strings accepted on update", () => {
  const h = harness();
  h.flushCalls = 0;
  const ctx = loadCompletion(h);
  ctx.FieldOSJobCompletion.generateJobCompletionDraft({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
  });
  const loaded = ctx.FieldOSJobCompletion.getJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
  }).data;

  assert.throws(
    () =>
      ctx.FieldOSJobCompletion.updateJobCompletion({
        job_sheet_id: "21759f5d",
        actor_role: "manager",
        staff_id: "STAFF-MGR001",
        expected_version: loaded.completion.version,
        material_entries: [
          { item_name: "Mulch", quantity: 1, unit: "m3" },
          { item_name: "Bags", quantity: "several", unit: "" },
        ],
      }),
    /Material row 2 quantity must be numeric/
  );

  const beforeVersion = Number(h.tables.tbl_job_completions[0].version);
  h.flushCalls = 0;
  const out = ctx.FieldOSJobCompletion.updateJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
    expected_version: loaded.completion.version,
    work_summary: loaded.completion.work_summary,
    invoice_description: loaded.completion.invoice_description,
    material_entries: [
      { item_name: "Mulch", quantity: "2.5", unit: "m3" },
      { item_name: "Soil", quantity: "2 bags", unit: "" },
      { item_name: "Optional", quantity: "  ", unit: "" },
    ],
  });
  const blob = JSON.stringify(out);
  assert.ok(Buffer.byteLength(blob, "utf8") < 1024);
  assert.equal(Object.prototype.hasOwnProperty.call(out.data, "completion"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out.data, "labour_entries"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out.data, "machinery_entries"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out.data, "material_entries"), false);
  assert.equal(out.data.updated, true);
  assert.equal(out.data.material_count, 3);
  assert.equal(out.data.version, beforeVersion + 1);
  assert.equal(h.flushCalls, 1);
  assert.equal(Number(h.tables.tbl_job_completions[0].version), beforeVersion + 1);

  const mats = h.tables.tbl_job_materials;
  assert.equal(mats[0].quantity, 2.5);
  assert.equal(mats[1].quantity, 2);
  assert.equal(mats[1].unit, "bags");
  assert.equal(mats[2].quantity, "");
});

test("generate with existing completion returns existing without rewriting", () => {
  const h = harness();
  const ctx = loadCompletion(h);
  const first = ctx.FieldOSJobCompletion.generateJobCompletionDraft({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
  });
  assert.equal(first.data.generated, true);
  const version = Number(h.tables.tbl_job_completions[0].version);
  const labourCount = h.tables.tbl_job_labour.length;
  const second = ctx.FieldOSJobCompletion.generateJobCompletionDraft({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
  });
  assert.equal(second.data.existing, true);
  assert.equal(second.data.generated, false);
  assert.equal(second.data.completion_id, first.data.completion_id);
  assert.equal(Number(h.tables.tbl_job_completions[0].version), version);
  assert.equal(h.tables.tbl_job_labour.length, labourCount);
});

test("update response size under 1KB vs full assemble", () => {
  const h = harness();
  const ctx = loadCompletion(h);
  ctx.FieldOSJobCompletion.generateJobCompletionDraft({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
  });
  const loaded = ctx.FieldOSJobCompletion.getJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
  });
  const beforeAssembleBytes = Buffer.byteLength(
    JSON.stringify({
      action: "update_job_completion",
      message: "Completion updated.",
      job_sheet_id: "21759f5d",
      data: loaded.data,
    }),
    "utf8"
  );
  const updated = ctx.FieldOSJobCompletion.updateJobCompletion({
    job_sheet_id: "21759f5d",
    actor_role: "manager",
    staff_id: "STAFF-MGR001",
    expected_version: loaded.data.completion.version,
    work_summary: "Updated summary for size check",
  });
  const afterBytes = Buffer.byteLength(JSON.stringify(updated), "utf8");
  assert.ok(beforeAssembleBytes > 1024, `expected full assemble >1KB got ${beforeAssembleBytes}`);
  assert.ok(afterBytes < 1024, `expected minimal update <1KB got ${afterBytes}`);
  // Expose sizes for the report.
  updated.__size_before = beforeAssembleBytes;
  updated.__size_after = afterBytes;
  assert.ok(afterBytes < beforeAssembleBytes);
});
