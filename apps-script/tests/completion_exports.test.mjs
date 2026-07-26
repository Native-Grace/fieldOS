/**
 * Phase 3D export readiness + CSV helpers tests.
 * Run: node --test apps-script/tests/completion_exports.test.mjs
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
const exportHelpersSrc = fs.readFileSync(
  path.join(__dirname, "..", "CompletionExportHelpers.js"),
  "utf8"
);
const exportsSrc = fs.readFileSync(path.join(__dirname, "..", "CompletionExports.js"), "utf8");

function load() {
  const context = {
    console,
    Session: { getScriptTimeZone: () => "Australia/Sydney" },
    Utilities: {
      formatDate(date, tz, pattern) {
        if (pattern === "yyyy-MM-dd") {
          const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: tz || "Australia/Sydney",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).formatToParts(date);
          const y = parts.find((p) => p.type === "year")?.value;
          const m = parts.find((p) => p.type === "month")?.value;
          const d = parts.find((p) => p.type === "day")?.value;
          return `${y}-${m}-${d}`;
        }
        if (pattern === "yyyy-MM-dd'T'HH:mm:ssXXX") {
          return date.toISOString();
        }
        return String(date);
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(helpersSrc, context);
  vm.runInContext(exportHelpersSrc, context);
  return context;
}

function loadDashboardHarness() {
  const tables = {
    tbl_job_completions: [
      {
        completion_id: "CMP-288481F1",
        job_sheet_id: "21759f5d",
        completion_status: "Finalised",
        work_summary: "Planted trees",
        invoice_description: "Tree planting",
        total_labour_hours: 7.5,
        total_travel_hours: 0.5,
        total_machinery_hours: 0,
        billable_labour_hours: 7.5,
        non_billable_labour_hours: 0,
        variations: "[]",
        warnings: "[]",
        warning_resolutions: "[]",
        finalised_by: "STAFF-MGR001",
        finalised_at: "2026-07-26T10:25:20.645Z",
        version: 3,
      },
    ],
    tbl_job_labour: [
      {
        labour_id: "LAB-1",
        completion_id: "CMP-288481F1",
        job_sheet_id: "21759f5d",
        staff_id: "STAFF-1",
        staff_name: "Alex",
        work_date: "Thu Jul 16 2026 00:00:00 GMT+1000 (Australian Eastern Standard Time)",
        start_time: "07:00",
        finish_time: "15:00",
        break_minutes: 30,
        travel_minutes: 20,
        confirmation_status: "Confirmed",
        billable: "TRUE",
      },
    ],
    tbl_job_machinery: [],
    tbl_job_materials: [],
    tbl_export_batches: [],
    tbl_export_batch_items: [],
  };
  const jobs = {
    "21759f5d": {
      job_sheet_id: "21759f5d",
      date: new Date("2026-07-15T14:00:00.000Z"), // 2026-07-16 in Australia/Sydney
      customer_name: "Acme",
      project_name: "Garden",
      approval_status: "Approved",
      processing_status: "Completed",
      staff_id: "STAFF-1",
    },
  };
  const context = {
    console,
    Logger: { log() {} },
    Session: { getScriptTimeZone: () => "Australia/Sydney" },
    Utilities: {
      formatDate(date, tz, pattern) {
        if (pattern === "yyyy-MM-dd") {
          const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: tz || "Australia/Sydney",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).formatToParts(date);
          return `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}-${parts.find((p) => p.type === "day").value}`;
        }
        return date.toISOString();
      },
      getUuid: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    },
    JobSheetRepository: {
      findById(id) {
        return jobs[id] || null;
      },
    },
    SyncRepository: { create() {} },
    Utils: {
      withLock(_n, _t, fn) {
        return fn();
      },
    },
    DB: {
      generateId(prefix) {
        return `${prefix}-T1`;
      },
      getSheet(table) {
        if (!tables[table]) throw new Error(`missing ${table}`);
        return { name: table };
      },
      findAll(table) {
        return (tables[table] || []).slice();
      },
      findWhere(table, cond) {
        return (tables[table] || []).filter((r) =>
          Object.keys(cond).every((k) => String(r[k]) === String(cond[k]))
        );
      },
      updateRecord() {},
      createRecord() {},
    },
    FieldOSJobCompletion: {
      _parseList(v) {
        if (Array.isArray(v)) return v;
        if (!v) return [];
        try {
          return JSON.parse(v);
        } catch {
          return [];
        }
      },
      _parseObjectList(v) {
        return this._parseList(v);
      },
      _toApiLabour(row) {
        return {
          labour_id: row.labour_id,
          work_date: context.fieldosNormaliseCalendarDate_(row.work_date),
          staff_id: row.staff_id,
          confirmation_status: row.confirmation_status,
          start_time: row.start_time,
          finish_time: row.finish_time,
          break_minutes: row.break_minutes,
          travel_minutes: row.travel_minutes,
          billable: true,
        };
      },
      _toApiMachinery(row) {
        return row;
      },
      _toApiMaterial(row) {
        return row;
      },
    },
    fieldosIsManagerOrAdmin_() {
      return true;
    },
    fieldosNormalizeRole_(r) {
      return String(r || "manager").toLowerCase();
    },
  };
  vm.createContext(context);
  vm.runInContext(helpersSrc, context);
  vm.runInContext(exportHelpersSrc, context);
  vm.runInContext(exportsSrc, context);
  return context;
}

test("csv formula injection protection", () => {
  const ctx = load();
  assert.equal(ctx.fieldosEscapeCsvCell_("=CMD()"), "'=CMD()");
  assert.equal(ctx.fieldosEscapeCsvCell_("+1"), "'+1");
  assert.equal(ctx.fieldosEscapeCsvCell_("-1"), "'-1");
  assert.equal(ctx.fieldosEscapeCsvCell_("@x"), "'@x");
  const csv = ctx.fieldosBuildCsv_(["notes"], [{ notes: "=1+1" }]);
  assert.ok(csv.includes("'=1+1"));
  assert.ok(!csv.includes("\n=1+1"));
});

test("calendar date normaliser accepts Sheets Date, locale string, ISO, YYYY-MM-DD", () => {
  const ctx = load();
  const tz = { timezone: "Australia/Sydney" };
  // 2026-07-16 00:00 AEST
  const sheetsDate = new Date("2026-07-15T14:00:00.000Z");
  assert.equal(ctx.fieldosNormaliseCalendarDate_(sheetsDate, tz), "2026-07-16");
  assert.equal(
    ctx.fieldosNormaliseCalendarDate_(
      "Thu Jul 16 2026 00:00:00 GMT+1000 (Australian Eastern Standard Time)",
      tz
    ),
    "2026-07-16"
  );
  assert.equal(ctx.fieldosNormaliseCalendarDate_("2026-07-26T10:25:20.645Z", tz), "2026-07-26");
  assert.equal(ctx.fieldosNormaliseCalendarDate_("2026-07-16", tz), "2026-07-16");
  assert.equal(ctx.fieldosSpreadsheetTimeZone_(), "Australia/Sydney");
});

test("inclusive date_to boundary", () => {
  const ctx = load();
  assert.equal(
    ctx.fieldosDateInInclusiveRange_("2026-07-26", "2026-05-01", "2026-07-26"),
    true
  );
  assert.equal(
    ctx.fieldosDateInInclusiveRange_("2026-07-27", "2026-05-01", "2026-07-26"),
    false
  );
  assert.equal(
    ctx.fieldosDateInInclusiveRange_("2026-05-01", "2026-05-01", "2026-07-26"),
    true
  );
});

test("locale job_date no longer excludes via string slice bug", () => {
  const ctx = load();
  const broken = String(
    new Date("Thu Jul 16 2026 00:00:00 GMT+1000 (Australian Eastern Standard Time)")
  ).slice(0, 10);
  assert.equal(broken.startsWith("Thu"), true);
  assert.equal(broken > "2026-07-26", true); // old bug path
  const fixed = ctx.fieldosNormaliseCalendarDate_(
    "Thu Jul 16 2026 00:00:00 GMT+1000 (Australian Eastern Standard Time)"
  );
  assert.equal(fixed, "2026-07-16");
  assert.equal(ctx.fieldosDateInInclusiveRange_(fixed, "2026-05-01", "2026-07-26"), true);
});

test("job 21759f5d shape appears in dashboard with normalised dates", () => {
  const ctx = loadDashboardHarness();
  const listed = ctx.FieldOSCompletionExports.listCompletionDashboard({
    actor_role: "manager",
    date_from: "2026-05-01",
    date_to: "2026-07-26",
  });
  assert.equal(listed.data.items.length, 1);
  assert.equal(listed.data.items[0].job_sheet_id, "21759f5d");
  assert.equal(listed.data.items[0].completion_id, "CMP-288481F1");
  assert.equal(listed.data.items[0].job_date, "2026-07-16");

  const bundle = ctx.FieldOSCompletionExports._loadCompletionBundle(
    ctx.DB.findAll("tbl_job_completions")[0]
  );
  assert.equal(bundle.labour_entries[0].work_date, "2026-07-16");

  const csv = ctx.fieldosBuildCsvForType_(ctx.FIELDOS_EXPORT_TYPES_.PAYROLL_CSV, [bundle]);
  assert.match(csv.csv, /2026-07-16/);
  assert.ok(!csv.csv.includes("Thu Jul 16"));
});

test("dashboard diagnostic reports date filter fields", () => {
  const ctx = loadDashboardHarness();
  const report = ctx.testFieldOSCompletionDashboardDiagnostic("21759f5d", "2026-05-01", "2026-07-26");
  assert.equal(report.primary_date_field, "job_date");
  assert.equal(report.normalised_candidate_date, "2026-07-16");
  assert.equal(report.passes_date_filter, true);
  assert.equal(report.inclusion_result, true);
  assert.equal(report.raw_candidate_date_type, "Date");
  assert.ok(!JSON.stringify(report).includes("transcript"));
  assert.ok(!JSON.stringify(report).includes("DRIVE"));
});

test("readiness blockers for draft incomplete completion", () => {
  const ctx = load();
  const result = ctx.fieldosComputeExportReadiness_(
    {
      completion_status: "Draft",
      work_summary: "",
      invoice_description: "",
      warnings: ["Unresolved note"],
      warning_resolutions: [],
    },
    { approval_status: "Pending" },
    [
      {
        confirmation_status: "Draft",
        staff_id: "",
        work_date: "",
        start_time: "07:00",
        finish_time: "15:00",
        break_minutes: 30,
      },
    ],
    [{ confirmation_status: "Draft" }],
    []
  );
  assert.equal(result.invoice_ready, false);
  assert.equal(result.payroll_ready, false);
  assert.ok(result.invoice_blockers.some((b) => /Finalised/.test(b)));
  assert.ok(result.invoice_blockers.some((b) => /Approved/.test(b)));
  assert.ok(result.invoice_blockers.some((b) => /Invoice description/.test(b)));
});

test("payroll ready requires staff_id and confirmed labour", () => {
  const ctx = load();
  const labour = [
    {
      confirmation_status: "Confirmed",
      staff_id: "STAFF-1",
      staff_name: "Alex",
      work_date: "2026-07-01",
      start_time: "07:00",
      finish_time: "15:00",
      break_minutes: 30,
      travel_minutes: 0,
      billable: true,
    },
  ];
  const ready = ctx.fieldosComputeExportReadiness_(
    {
      completion_status: "Finalised",
      work_summary: "Done",
      invoice_description: "Plant trees",
      warnings: [],
      warning_resolutions: [],
    },
    { approval_status: "Approved" },
    labour,
    [],
    []
  );
  assert.equal(ready.invoice_ready, true);
  assert.equal(ready.payroll_ready, true);

  const blocked = ctx.fieldosComputeExportReadiness_(
    {
      completion_status: "Finalised",
      work_summary: "Done",
      invoice_description: "Plant trees",
      warnings: [],
      warning_resolutions: [],
    },
    { approval_status: "Approved" },
    [{ ...labour[0], staff_id: "" }],
    [],
    []
  );
  assert.equal(blocked.payroll_ready, false);
  assert.ok(blocked.payroll_blockers.some((b) => /staff_id/.test(b)));
});

test("summary csv excludes transcript and drive ids", () => {
  const ctx = load();
  const items = [
    {
      completion: {
        completion_id: "CMP-1",
        job_sheet_id: "JS-1",
        completion_status: "Finalised",
        work_summary: "Work",
        invoice_description: "Desc",
        total_labour_hours: 7.5,
        total_travel_hours: 0.5,
        total_machinery_hours: 1,
        billable_labour_hours: 7.5,
        non_billable_labour_hours: 0,
        finalised_by: "mgr",
        finalised_at: "2026-07-01T10:00:00Z",
        warnings: [],
        warning_resolutions: [],
        ai_transcript: "SECRET",
        drive_file_id: "DRIVE123",
      },
      job: {
        customer_name: "Acme",
        project_name: "Garden",
        job_date: "2026-07-01",
        approval_status: "Approved",
      },
      labour_entries: [],
      machinery_entries: [],
      material_entries: [],
      readiness: {
        invoice_ready: true,
        payroll_ready: true,
        warning_count: 0,
      },
    },
  ];
  const built = ctx.fieldosBuildCsvForType_(
    ctx.FIELDOS_EXPORT_TYPES_.COMPLETION_SUMMARY_CSV,
    items
  );
  assert.ok(built.csv.includes("job_sheet_id"));
  assert.ok(!built.csv.includes("SECRET"));
  assert.ok(!built.csv.includes("DRIVE123"));
  assert.ok(!/unit_cost|sell_price|gst/i.test(built.csv));
});

test("deterministic item ordering by job_sheet_id", () => {
  const ctx = load();
  const rows = ctx.fieldosSortExportItems_([
    { job_sheet_id: "JS-B", completion_id: "2" },
    { job_sheet_id: "JS-A", completion_id: "1" },
  ]);
  assert.equal(rows[0].job_sheet_id, "JS-A");
  assert.equal(rows[1].job_sheet_id, "JS-B");
});

test("audit sanitisation helper drops secrets", () => {
  const ctx = load();
  const safe = ctx.fieldosSanitizeExportAudit_({
    action: "generate_export_batch",
    csv_text: "SHOULD_NOT_APPEAR",
    transcript: "SECRET",
    Authorization: "Bearer tok",
    drive_file_id: "DRIVE",
    export_batch_id: "EXP-1",
    checksum: "abc",
  });
  assert.equal(safe.export_batch_id, "EXP-1");
  assert.equal(safe.checksum, "abc");
  assert.equal(safe.csv_text, undefined);
  assert.equal(safe.transcript, undefined);
  assert.equal(safe.Authorization, undefined);
  assert.equal(safe.drive_file_id, undefined);
});
