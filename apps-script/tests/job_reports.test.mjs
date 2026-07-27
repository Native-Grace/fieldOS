/**
 * Phase 3F job report data layer tests.
 * Run: node --test apps-script/tests/job_reports.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");

// Values built inside the vm realm have foreign prototypes, so structural
// comparisons go through a JSON round trip before assert's strict deep equality.
const plain = (value) => JSON.parse(JSON.stringify(value));
const deepEqual = (actual, expected, message) =>
  assert.deepEqual(plain(actual), plain(expected), message);

const completionHelpersSrc = read("JobCompletionHelpers.js");
const exportHelpersSrc = read("CompletionExportHelpers.js");
const reportHelpersSrc = read("JobReportHelpers.js");
const completionExportsSrc = read("CompletionExports.js");
const reportsSrc = read("JobReports.js");

const TRANSCRIPT_SECRET = "SECRET_TRANSCRIPT_TEXT";
const DRIVE_SECRET = "DRIVE_FILE_ABC123";

function seedTables() {
  return {
    tbl_job_completions: [
      {
        completion_id: "CMP-A",
        job_sheet_id: "21759f5d",
        completion_status: "Finalised",
        work_summary: "Planted trees and mulched beds",
        invoice_description: "Tree planting",
        internal_notes: "INTERNAL_MARGIN_NOTE",
        total_labour_hours: 15,
        total_travel_hours: 0.67,
        total_machinery_hours: 2,
        billable_labour_hours: 15,
        non_billable_labour_hours: 0,
        variations: '["Extra mulch spread"]',
        warnings: "[]",
        warning_resolutions: "[]",
        finalised_by: "STAFF-MGR",
        finalised_at: "2026-07-17T02:00:00.000Z",
        created_at: "2026-07-16T22:00:00.000Z",
        version: 3,
      },
      {
        completion_id: "CMP-B",
        job_sheet_id: "b2",
        completion_status: "Finalised",
        work_summary: "Fence line clearing",
        invoice_description: "Fence clearing",
        internal_notes: "",
        total_labour_hours: 7.5,
        total_travel_hours: 0,
        total_machinery_hours: 0,
        billable_labour_hours: 0,
        non_billable_labour_hours: 7.5,
        variations: "",
        warnings: "[]",
        warning_resolutions: "[]",
        finalised_by: "STAFF-MGR",
        finalised_at: "2026-07-21T02:00:00.000Z",
        created_at: "2026-07-20T22:00:00.000Z",
        version: 1,
      },
      {
        completion_id: "CMP-C",
        job_sheet_id: "c3",
        completion_status: "Draft",
        work_summary: "",
        invoice_description: "",
        internal_notes: "",
        total_labour_hours: 4,
        total_travel_hours: 0,
        total_machinery_hours: 0,
        billable_labour_hours: 4,
        non_billable_labour_hours: 0,
        variations: "",
        warnings: "[]",
        warning_resolutions: "[]",
        finalised_by: "",
        finalised_at: "",
        created_at: "2026-06-01T22:00:00.000Z",
        version: 1,
      },
    ],
    tbl_job_labour: [
      {
        labour_id: "LAB-A1",
        completion_id: "CMP-A",
        job_sheet_id: "21759f5d",
        staff_id: "STAFF-1",
        staff_name: "Alex",
        work_date: "2026-07-16",
        start_time: "07:00",
        finish_time: "15:00",
        break_minutes: 30,
        travel_minutes: 20,
        confirmation_status: "Confirmed",
        billable: "TRUE",
        notes: "Row note A1",
      },
      {
        labour_id: "LAB-A2",
        completion_id: "CMP-A",
        job_sheet_id: "21759f5d",
        staff_id: "STAFF-2",
        staff_name: "Bec",
        work_date: "2026-07-16",
        start_time: "07:00",
        finish_time: "15:00",
        break_minutes: 30,
        travel_minutes: 20,
        confirmation_status: "Confirmed",
        billable: "TRUE",
        notes: "Row note A2",
      },
      {
        labour_id: "LAB-B1",
        completion_id: "CMP-B",
        job_sheet_id: "b2",
        staff_id: "STAFF-2",
        staff_name: "Bec",
        work_date: "2026-07-20",
        start_time: "08:00",
        finish_time: "16:00",
        break_minutes: 30,
        travel_minutes: 0,
        confirmation_status: "Confirmed",
        billable: "FALSE",
        notes: "",
      },
      {
        labour_id: "LAB-C1",
        completion_id: "CMP-C",
        job_sheet_id: "c3",
        staff_id: "STAFF-1",
        staff_name: "Alex",
        work_date: "2026-06-01",
        start_time: "09:00",
        finish_time: "13:00",
        break_minutes: 0,
        travel_minutes: 0,
        confirmation_status: "Confirmed",
        billable: "TRUE",
        notes: "",
      },
    ],
    tbl_job_machinery: [
      {
        machinery_entry_id: "MCH-A1",
        completion_id: "CMP-A",
        job_sheet_id: "21759f5d",
        equipment_name: "Mini excavator",
        operator_staff_id: "STAFF-1",
        duration_hours: 2,
        billable: "TRUE",
        charge_code: "EXC",
        confirmation_status: "Confirmed",
        notes: "",
      },
    ],
    tbl_job_materials: [
      {
        material_entry_id: "JMT-A1",
        completion_id: "CMP-A",
        job_sheet_id: "21759f5d",
        item_name: "Mulch",
        item_code: "MU-01",
        quantity: 4,
        unit: "m3",
        billable: "TRUE",
        confirmation_status: "Confirmed",
        notes: "",
      },
    ],
    tbl_recordings: [
      {
        recording_id: "REC-1",
        job_sheet_id: "21759f5d",
        recording_drive_file_id: DRIVE_SECRET,
        recording_file_url: `https://drive.example/${DRIVE_SECRET}`,
        transcript: TRANSCRIPT_SECRET,
        status: "Processed",
      },
      {
        recording_id: "REC-2",
        job_sheet_id: "21759f5d",
        recording_drive_file_id: `${DRIVE_SECRET}-2`,
        recording_file_url: `https://drive.example/${DRIVE_SECRET}-2`,
        transcript: TRANSCRIPT_SECRET,
        status: "Processed",
      },
    ],
    tbl_report_batches: [],
    tbl_report_batch_items: [],
  };
}

function seedJobs() {
  return {
    "21759f5d": {
      job_sheet_id: "21759f5d",
      // 2026-07-16 in Australia/Sydney
      date: new Date("2026-07-15T14:00:00.000Z"),
      customer_name: "Acme Landscapes",
      project_name: "Garden Renewal",
      approval_status: "Approved",
      processing_status: "Completed",
      staff_id: "STAFF-1",
      manager_review_items:
        "Plant 12 advanced trees\n- Spread mulch to all beds\n2) Repair drip line",
      variations: "Extra mulch spread",
      ai_transcript: TRANSCRIPT_SECRET,
      ai_summary: "Summary text",
    },
    b2: {
      job_sheet_id: "b2",
      date: "2026-07-20",
      customer_name: "Beta Farms",
      project_name: "Fence Line",
      approval_status: "Pending Review",
      processing_status: "Completed",
      staff_id: "STAFF-2",
      manager_review_items: "UNAPPROVED_REVIEW_ITEM",
      variations: "Gate repair",
      ai_transcript: TRANSCRIPT_SECRET,
    },
    c3: {
      job_sheet_id: "c3",
      date: "2026-06-01",
      customer_name: "Acme Landscapes",
      project_name: "Garden Renewal",
      approval_status: "Approved",
      processing_status: "Completed",
      staff_id: "STAFF-1",
      manager_review_items: "Weed spraying",
      variations: "",
      ai_transcript: TRANSCRIPT_SECRET,
    },
  };
}

function buildContext(options = {}) {
  const tables = options.tables || seedTables();
  const jobs = options.jobs || seedJobs();
  const audits = [];
  const locks = [];
  let idSeq = 0;

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
          const get = (type) => parts.find((p) => p.type === type).value;
          return `${get("year")}-${get("month")}-${get("day")}`;
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
    SyncRepository: {
      create(row) {
        audits.push(row);
        return row;
      },
    },
    Utils: {
      withLock(name, _timeout, fn) {
        locks.push(name);
        return fn();
      },
    },
    DB: {
      generateId(prefix) {
        idSeq += 1;
        return `${prefix}-${String(idSeq).padStart(4, "0")}`;
      },
      getSheet(table) {
        if (!tables[table]) throw new Error(`Database Error: Table '${table}' missing.`);
        return { name: table };
      },
      findAll(table) {
        if (!tables[table]) throw new Error(`Database Error: Table '${table}' missing.`);
        return tables[table].map((row) => ({ ...row }));
      },
      findWhere(table, cond) {
        if (!tables[table]) throw new Error(`Database Error: Table '${table}' missing.`);
        return tables[table]
          .filter((row) => Object.keys(cond).every((k) => String(row[k]) === String(cond[k])))
          .map((row) => ({ ...row }));
      },
      insertRecord(table, record) {
        if (!tables[table]) throw new Error(`Database Error: Table '${table}' missing.`);
        tables[table].push({ ...record });
        return record;
      },
      updateRecord(table, keyColumn, keyValue, patch) {
        const row = (tables[table] || []).find(
          (candidate) => String(candidate[keyColumn]) === String(keyValue)
        );
        if (!row) throw new Error(`Record with ${keyColumn} = '${keyValue}' not found in ${table}.`);
        Object.assign(row, patch);
        return { ...row };
      },
    },
    // Mirrors FieldOSGateway.js role helpers (canonical roles: staff|manager|admin).
    fieldosNormalizeRole_(role) {
      const r = String(role == null ? "" : role)
        .trim()
        .toLowerCase();
      if (r === "admin" || r === "administrator") return "admin";
      if (r === "manager" || r === "mgr") return "manager";
      return "staff";
    },
    fieldosIsManagerOrAdmin_(role) {
      const n = context.fieldosNormalizeRole_(role);
      return n === "manager" || n === "admin";
    },
  };

  context.FieldOSJobCompletion = {
    _parseList(raw) {
      if (raw == null || raw === "") return [];
      if (Array.isArray(raw)) return raw.map(String);
      try {
        const parsed = JSON.parse(String(raw));
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        /* fall through */
      }
      return String(raw)
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
    },
    _parseObjectList(raw) {
      if (Array.isArray(raw)) return raw;
      try {
        const parsed = JSON.parse(String(raw || "[]"));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
    _boolApi(value) {
      return value === true || value === "TRUE" || value === "true";
    },
    _toApiLabour(row) {
      return {
        labour_id: String(row.labour_id || ""),
        completion_id: String(row.completion_id || ""),
        job_sheet_id: String(row.job_sheet_id || ""),
        staff_id: String(row.staff_id || ""),
        staff_name: String(row.staff_name || ""),
        work_date: context.fieldosNormaliseCalendarDate_(row.work_date) || "",
        start_time: String(row.start_time || ""),
        finish_time: String(row.finish_time || ""),
        break_minutes: Number(row.break_minutes) || 0,
        labour_hours: row.labour_hours == null || row.labour_hours === "" ? null : Number(row.labour_hours),
        travel_minutes: Number(row.travel_minutes) || 0,
        travel_hours: Number(row.travel_hours) || 0,
        role_or_activity: String(row.role_or_activity || ""),
        billable: this._boolApi(row.billable),
        confirmation_status: String(row.confirmation_status || "Suggested"),
        notes: String(row.notes || ""),
      };
    },
    _toApiMachinery(row) {
      return {
        machinery_entry_id: String(row.machinery_entry_id || ""),
        equipment_name: String(row.equipment_name || ""),
        operator_staff_id: String(row.operator_staff_id || ""),
        duration_hours: row.duration_hours == null || row.duration_hours === "" ? null : Number(row.duration_hours),
        billable: this._boolApi(row.billable),
        charge_code: String(row.charge_code || ""),
        confirmation_status: String(row.confirmation_status || "Suggested"),
        notes: String(row.notes || ""),
      };
    },
    _toApiMaterial(row) {
      return {
        material_entry_id: String(row.material_entry_id || ""),
        item_name: String(row.item_name || ""),
        item_code: String(row.item_code || ""),
        quantity: row.quantity == null || row.quantity === "" ? null : Number(row.quantity),
        unit: String(row.unit || ""),
        billable: this._boolApi(row.billable),
        confirmation_status: String(row.confirmation_status || "Suggested"),
        notes: String(row.notes || ""),
      };
    },
  };

  vm.createContext(context);
  vm.runInContext(completionHelpersSrc, context);
  vm.runInContext(exportHelpersSrc, context);
  vm.runInContext(reportHelpersSrc, context);
  if (options.withCompletionExports !== false) {
    vm.runInContext(completionExportsSrc, context);
  }
  vm.runInContext(reportsSrc, context);

  context.__tables = tables;
  context.__jobs = jobs;
  context.__audits = audits;
  context.__locks = locks;
  return context;
}

const MANAGER = { actor_role: "manager", staff_id: "STAFF-MGR", actor_identity: "mgr@nativegrace.com" };
const STAFF_2 = { actor_role: "staff", staff_id: "STAFF-2" };

test("task lines come from reviewed text only, never the transcript", () => {
  const ctx = buildContext();
  const job = ctx.__jobs["21759f5d"];
  const rows = ctx.fieldosExtractTaskLines_(job, {});

  assert.equal(rows.length, 4);
  const reviewRows = rows.filter((r) => r.source_type === "manager_review_items");
  const variationRows = rows.filter((r) => r.source_type === "variations");
  assert.equal(reviewRows.length, 3);
  assert.equal(variationRows.length, 1);
  deepEqual(
    reviewRows.map((r) => r.description),
    ["Plant 12 advanced trees", "Spread mulch to all beds", "Repair drip line"]
  );
  rows.forEach((row) => {
    // Display-only rows: never invent quantities or durations.
    assert.equal(row.quantity, "");
    assert.equal(row.duration, "");
    assert.equal(row.assigned_staff_id, "");
    assert.equal(row.notes, "");
  });
  assert.ok(!JSON.stringify(rows).includes(TRANSCRIPT_SECRET));
});

test("manager review items are withheld until the job is Approved", () => {
  const ctx = buildContext();
  const pending = ctx.fieldosExtractTaskLines_(ctx.__jobs.b2, {});
  deepEqual(
    pending.map((r) => r.source_type),
    ["variations"]
  );
  assert.ok(!JSON.stringify(pending).includes("UNAPPROVED_REVIEW_ITEM"));

  const approved = ctx.fieldosExtractTaskLines_(ctx.__jobs.b2, { approval_status: "Approved" });
  assert.equal(approved.filter((r) => r.source_type === "manager_review_items").length, 1);
});

test("forbidden keys are scrubbed from nested payloads", () => {
  const ctx = buildContext();
  const keys = ctx.fieldosReportForbiddenKeys_();
  assert.ok(keys.includes("transcript"));
  assert.ok(keys.includes("drive"));
  assert.ok(keys.includes("token"));
  assert.ok(keys.includes("secret"));

  const scrubbed = ctx.fieldosScrubReportRecord_({
    job_sheet_id: "21759f5d",
    ai_transcript: TRANSCRIPT_SECRET,
    recording_drive_file_id: DRIVE_SECRET,
    nested: [
      { transcript: TRANSCRIPT_SECRET, description: "keep me" },
      { access_token: "tok", webhook_secret: "shh", quantity: 4 },
    ],
    deep: { level: { authorization: "Bearer x", api_key: "k", label: "ok" } },
  });
  assert.equal(scrubbed.job_sheet_id, "21759f5d");
  assert.equal(scrubbed.ai_transcript, undefined);
  assert.equal(scrubbed.recording_drive_file_id, undefined);
  assert.equal(scrubbed.nested[0].description, "keep me");
  assert.equal(scrubbed.nested[0].transcript, undefined);
  assert.equal(scrubbed.nested[1].quantity, 4);
  assert.equal(scrubbed.nested[1].access_token, undefined);
  assert.equal(scrubbed.deep.level.label, "ok");
  assert.equal(scrubbed.deep.level.authorization, undefined);
  assert.ok(!JSON.stringify(scrubbed).includes(TRANSCRIPT_SECRET));
  assert.ok(!JSON.stringify(scrubbed).includes(DRIVE_SECRET));
});

test("filters match on date range, customer, approval, billable and ids", () => {
  const ctx = buildContext();
  const bundle = ctx.FieldOSJobReports._loadBundle(
    ctx.DB.findWhere("tbl_job_completions", { completion_id: "CMP-A" })[0],
    {}
  );
  const manager = { role: "manager", staff_id: "STAFF-MGR" };
  const match = (filters) => ctx.fieldosMatchReportFilters_(bundle, filters, manager);

  assert.equal(match({ date_from: "2026-07-01", date_to: "2026-07-31" }), true);
  assert.equal(match({ date_from: "2026-07-17", date_to: "2026-07-31" }), false);
  assert.equal(match({ date_to: "2026-07-16" }), true, "date_to is inclusive");
  assert.equal(match({ customer: "acme" }), true);
  assert.equal(match({ customer: "beta" }), false);
  assert.equal(match({ project: "Garden" }), true);
  assert.equal(match({ approval_status: "Approved" }), true);
  assert.equal(match({ approval_status: "Pending Review" }), false);
  assert.equal(match({ completion_status: "Finalised" }), true);
  assert.equal(match({ completion_status: "Draft" }), false);
  assert.equal(match({ job_sheet_id: "21759f5d" }), true);
  assert.equal(match({ job_sheet_id: "b2" }), false);
  assert.equal(match({ completion_id: "CMP-A" }), true);
  assert.equal(match({ completion_id: "CMP-B" }), false);
  assert.equal(match({ billable: true }), true);
  assert.equal(match({ billable: false }), false);
  assert.equal(match({ staff: "STAFF-2" }), true, "labour row staff counts as a match");
  assert.equal(match({ staff: "STAFF-9" }), false);
});

test("staff actors only see jobs they are assigned to or worked on", () => {
  const ctx = buildContext();
  const load = (completionId) =>
    ctx.FieldOSJobReports._loadBundle(
      ctx.DB.findWhere("tbl_job_completions", { completion_id: completionId })[0],
      {}
    );
  const staff2 = { role: "staff", staff_id: "STAFF-2" };

  // Assigned to STAFF-1 but STAFF-2 has a labour row on it.
  assert.equal(ctx.fieldosMatchReportFilters_(load("CMP-A"), {}, staff2), true);
  // Assigned to STAFF-2.
  assert.equal(ctx.fieldosMatchReportFilters_(load("CMP-B"), {}, staff2), true);
  // Neither assigned nor worked on by STAFF-2.
  assert.equal(ctx.fieldosMatchReportFilters_(load("CMP-C"), {}, staff2), false);
  // Staff actors without a staff_id see nothing.
  assert.equal(ctx.fieldosMatchReportFilters_(load("CMP-A"), {}, { role: "staff" }), false);
});

test("report options gate types by role", () => {
  const ctx = buildContext();
  const managerOptions = ctx.FieldOSJobReports.getReportOptions(MANAGER);
  assert.equal(managerOptions.data.report_types.length, 5);
  deepEqual(
    managerOptions.data.report_types.map((t) => t.report_type),
    [
      "Job Sheet Summary",
      "Staff Work Report",
      "Client Job Report",
      "Project Activity Report",
      "Completion Register",
    ]
  );
  assert.equal(managerOptions.data.template_version, "3F.1");

  const staffOptions = ctx.FieldOSJobReports.getReportOptions(STAFF_2);
  deepEqual(
    staffOptions.data.report_types.map((t) => t.report_type),
    ["Staff Work Report"]
  );
  assert.equal(staffOptions.data.scoped_to_staff_id, "STAFF-2");

  assert.throws(
    () => ctx.FieldOSJobReports.previewReport({ ...STAFF_2, report_type: "Client Job Report" }),
    /Forbidden/
  );
});

test("manager preview reports groupings, totals, pages and blockers without creating a batch", () => {
  const ctx = buildContext();
  const preview = ctx.FieldOSJobReports.previewReport({
    ...MANAGER,
    report_type: "Job Sheet Summary",
    date_from: "2026-07-01",
    date_to: "2026-07-31",
  });

  assert.equal(preview.data.record_count, 2);
  deepEqual(
    preview.data.included.map((i) => i.job_sheet_id),
    ["21759f5d", "b2"]
  );
  // c3 sits outside the date window and is reported as excluded with a reason.
  const excludedC3 = preview.data.excluded.find((e) => e.job_sheet_id === "c3");
  assert.ok(excludedC3);
  assert.ok(excludedC3.reasons.some((r) => /before date_from/.test(r)));

  assert.equal(preview.data.group_by, "job_sheet_id");
  deepEqual(
    preview.data.groupings.map((g) => g.group_key),
    ["21759f5d", "b2"]
  );
  assert.equal(preview.data.totals.job_count, 2);
  assert.equal(preview.data.totals.recording_count_only, 2);
  assert.ok(preview.data.line_count > 0);
  assert.ok(preview.data.estimated_pages >= 3);
  deepEqual(preview.data.blockers, []);
  assert.equal(ctx.__tables.tbl_report_batches.length, 0, "preview must not create a batch");
  assert.equal(ctx.__tables.tbl_report_batch_items.length, 0);

  const previewAudit = ctx.__audits.find(
    (a) => JSON.parse(a.request_payload).action === "preview_report"
  );
  assert.ok(previewAudit);
  assert.ok(!JSON.stringify(previewAudit).includes(TRANSCRIPT_SECRET));
});

test("client job report blocks unapproved jobs and staff report groups by staff", () => {
  const ctx = buildContext();
  const client = ctx.FieldOSJobReports.previewReport({
    ...MANAGER,
    report_type: "Client Job Report",
    date_from: "2026-07-01",
    date_to: "2026-07-31",
  });
  deepEqual(
    client.data.groupings.map((g) => g.group_key),
    ["Acme Landscapes", "Beta Farms"]
  );
  assert.ok(client.data.blockers.some((b) => /b2: Client reports require job approval_status/.test(b)));

  const staffReport = ctx.FieldOSJobReports.previewReport({
    ...MANAGER,
    report_type: "Staff Work Report",
    date_from: "2026-07-01",
    date_to: "2026-07-31",
  });
  assert.equal(staffReport.data.group_by, "staff_id");
  deepEqual(
    staffReport.data.groupings.map((g) => g.group_key),
    ["STAFF-1", "STAFF-2"]
  );
  // 21759f5d has labour for both staff, so it appears in both groups.
  deepEqual(staffReport.data.groupings[0].job_sheet_ids, ["21759f5d"]);
  deepEqual(staffReport.data.groupings[1].job_sheet_ids, ["21759f5d", "b2"]);
});

test("staff preview is scoped to their own rows and hides other jobs", () => {
  const ctx = buildContext();
  const preview = ctx.FieldOSJobReports.previewReport({
    ...STAFF_2,
    report_type: "Staff Work Report",
    date_from: "2026-07-01",
    date_to: "2026-07-31",
  });
  deepEqual(
    preview.data.included.map((i) => i.job_sheet_id),
    ["21759f5d", "b2"]
  );
  deepEqual(preview.data.excluded, [], "staff are never told about other jobs");
  assert.equal(preview.data.filters.staff, "STAFF-2");
  assert.equal(preview.data.totals.labour_row_count, 2, "only STAFF-2 labour rows are counted");
  assert.equal(preview.data.totals.machinery_row_count, 0);
  assert.equal(preview.data.totals.material_row_count, 0);
});

test("grouping and item order are deterministic across runs", () => {
  const first = buildContext().FieldOSJobReports.previewReport({
    ...MANAGER,
    report_type: "Completion Register",
    date_from: "2026-01-01",
    date_to: "2026-12-31",
  });
  const second = buildContext().FieldOSJobReports.previewReport({
    ...MANAGER,
    report_type: "Completion Register",
    date_from: "2026-01-01",
    date_to: "2026-12-31",
  });
  deepEqual(first.data.included, second.data.included);
  deepEqual(first.data.groupings, second.data.groupings);
  deepEqual(
    first.data.included.map((i) => `${i.job_date}|${i.job_sheet_id}`),
    ["2026-06-01|c3", "2026-07-16|21759f5d", "2026-07-20|b2"]
  );
  deepEqual(
    first.data.groupings.map((g) => g.group_key),
    ["2026-06", "2026-07"]
  );
});

test("page estimates scale with records, lines and groups", () => {
  const ctx = buildContext();
  assert.equal(ctx.fieldosEstimateReportPages_("Job Sheet Summary", 0, {}), 0);
  assert.equal(ctx.fieldosEstimateReportPages_("Job Sheet Summary", 1, { line_count: 8 }), 2);
  assert.equal(ctx.fieldosEstimateReportPages_("Job Sheet Summary", 3, { line_count: 30 }), 4);
  assert.ok(
    ctx.fieldosEstimateReportPages_("Completion Register", 100, { line_count: 400, group_count: 4 }) >
      ctx.fieldosEstimateReportPages_("Completion Register", 10, { line_count: 40, group_count: 1 })
  );
});

test("filenames are safe and deterministic", () => {
  const ctx = buildContext();
  assert.equal(
    ctx.fieldosSafeReportFilename_("Job Sheet Summary", "2026-07-16", "2026-07-16", "21759f5d"),
    "nativegrace_job_21759f5d_2026-07-16.pdf"
  );
  assert.equal(
    ctx.fieldosSafeReportFilename_("Staff Work Report", "2026-07-01", "2026-07-31", ""),
    "nativegrace_staff_work_report_2026-07-01_to_2026-07-31.pdf"
  );
  assert.equal(
    ctx.fieldosSafeReportFilename_("Client Job Report", "2026-07-16", "2026-07-16", ""),
    "nativegrace_client_job_report_2026-07-16.pdf"
  );
  // Path traversal and odd characters never survive into a filename.
  assert.equal(
    ctx.fieldosSafeReportFilename_("Job Sheet Summary", "../../etc/passwd", "", "../../secret id"),
    "nativegrace_job_secret_id_undated.pdf"
  );
});

test("job pdf data carries display rows, readiness and counts but no forbidden fields", () => {
  const ctx = buildContext();
  const result = ctx.FieldOSJobReports.getJobPdfData({
    ...MANAGER,
    job_sheet_id: "21759f5d",
    include_internal_notes: true,
  });
  const data = result.data.pdf_data;

  assert.equal(result.data.file_name, "nativegrace_job_21759f5d_2026-07-16.pdf");
  assert.equal(data.template_version, "3F.1");
  assert.equal(data.job.job_date, "2026-07-16");
  assert.equal(data.job.customer_name, "Acme Landscapes");
  assert.equal(data.completion.completion_id, "CMP-A");
  assert.equal(data.labour.length, 2);
  assert.equal(data.machinery.length, 1);
  assert.equal(data.materials.length, 1);
  assert.equal(data.tasks.length, 4);
  assert.equal(data.recording_count_only, 2);
  assert.equal(data.readiness.job_approved, true);
  assert.equal(data.readiness.completion_finalised, true);
  assert.equal(data.totals.total_labour_hours, 15);
  assert.equal(data.totals.task_line_count, 4);
  assert.equal(data.internal_notes, "INTERNAL_MARGIN_NOTE");

  const json = JSON.stringify(data);
  assert.ok(!json.includes(TRANSCRIPT_SECRET));
  assert.ok(!json.includes(DRIVE_SECRET));
  assert.ok(!/transcript/i.test(json));
  assert.ok(!/drive/i.test(json));
});

test("internal notes are withheld unless a manager asks for them", () => {
  const ctx = buildContext();
  const withoutFlag = ctx.FieldOSJobReports.getJobPdfData({ ...MANAGER, job_sheet_id: "21759f5d" });
  assert.equal(withoutFlag.data.pdf_data.internal_notes, undefined);
  assert.equal(withoutFlag.data.pdf_data.include_internal_notes, false);
  assert.equal(withoutFlag.data.pdf_data.labour[0].notes, undefined);
  assert.ok(!JSON.stringify(withoutFlag.data.pdf_data).includes("INTERNAL_MARGIN_NOTE"));

  const staffAsking = ctx.FieldOSJobReports.getJobPdfData({
    ...STAFF_2,
    job_sheet_id: "21759f5d",
    include_internal_notes: true,
  });
  assert.equal(staffAsking.data.pdf_data.internal_notes, undefined);
  assert.ok(!JSON.stringify(staffAsking.data.pdf_data).includes("INTERNAL_MARGIN_NOTE"));
});

test("job pdf data is staff scoped", () => {
  const ctx = buildContext();
  const scoped = ctx.FieldOSJobReports.getJobPdfData({ ...STAFF_2, job_sheet_id: "21759f5d" });
  assert.equal(scoped.data.report_type, "Staff Work Report");
  deepEqual(
    scoped.data.pdf_data.labour.map((r) => r.staff_id),
    ["STAFF-2"]
  );
  assert.equal(scoped.data.pdf_data.machinery.length, 0);
  assert.equal(scoped.data.pdf_data.materials.length, 0);
  assert.equal(scoped.data.pdf_data.totals.total_labour_hours, 7.5);
  assert.ok(!JSON.stringify(scoped.data.pdf_data).includes("Alex"));

  assert.throws(
    () => ctx.FieldOSJobReports.getJobPdfData({ ...STAFF_2, job_sheet_id: "c3" }),
    /Forbidden/
  );
});

test("batch lifecycle: create, validate, generate, then immutable", () => {
  const ctx = buildContext();
  const created = ctx.FieldOSJobReports.createReportBatch({
    ...MANAGER,
    report_type: "Job Sheet Summary",
    date_from: "2026-07-01",
    date_to: "2026-07-31",
    notes: "July job sheets",
  });
  const batchId = created.data.report_batch.report_batch_id;
  assert.match(batchId, /^RPT-/);
  assert.equal(created.data.report_batch.status, "Draft");
  assert.equal(created.data.report_batch.record_count, 2);
  assert.equal(created.data.items.length, 2);
  assert.match(created.data.items[0].report_batch_item_id, /^RPI-/);
  deepEqual(
    created.data.items.map((i) => i.job_sheet_id),
    ["21759f5d", "b2"]
  );

  const validated = ctx.FieldOSJobReports.validateReportBatch({ ...MANAGER, report_batch_id: batchId });
  assert.equal(validated.data.report_batch.status, "Validated");
  deepEqual(validated.data.report_batch.blockers, []);
  deepEqual(
    validated.data.items.map((i) => i.item_status),
    ["Ready", "Ready"]
  );

  const generated = ctx.FieldOSJobReports.generateReportData({
    ...MANAGER,
    report_batch_id: batchId,
    expected_version: validated.data.report_batch.version,
  });
  assert.equal(generated.data.report_batch.status, "Generated");
  assert.ok(generated.data.report_batch.checksum);
  assert.equal(generated.data.report_batch.file_name, "nativegrace_job_sheet_summary_2026-07-01_to_2026-07-31.pdf");
  assert.equal(generated.data.report_data.jobs.length, 2);
  assert.equal(generated.data.report_data.omitted_job_data, false);

  const storedRow = ctx.__tables.tbl_report_batches.find((r) => r.report_batch_id === batchId);
  const snapshot = JSON.parse(storedRow.snapshot_json);
  assert.equal(snapshot.template_version, "3F.1");
  assert.equal(snapshot.jobs.length, 2);
  // Frozen data only — no PDF bytes, no transcripts, no Drive identifiers.
  assert.ok(!/pdf_base64|pdf_bytes|content_bytes/i.test(storedRow.snapshot_json));
  assert.ok(!storedRow.snapshot_json.includes(TRANSCRIPT_SECRET));
  assert.ok(!storedRow.snapshot_json.includes(DRIVE_SECRET));

  // Generated batches are immutable — regenerating means a new batch.
  assert.throws(
    () => ctx.FieldOSJobReports.generateReportData({ ...MANAGER, report_batch_id: batchId }),
    /immutable/
  );
  assert.throws(
    () => ctx.FieldOSJobReports.validateReportBatch({ ...MANAGER, report_batch_id: batchId }),
    /immutable/
  );
  assert.throws(
    () => ctx.FieldOSJobReports.cancelReportBatch({ ...MANAGER, report_batch_id: batchId }),
    /cannot be cancelled/
  );

  // Locks are only taken around writes, and only on the batch key.
  assert.ok(ctx.__locks.length > 0);
  ctx.__locks.forEach((name) => assert.match(name, new RegExp(`^REPORT_BATCH_${batchId}$`)));
});

test("frozen batch data can be read back only after generation", () => {
  const ctx = buildContext();
  const created = ctx.FieldOSJobReports.createReportBatch({
    ...MANAGER,
    report_type: "Job Sheet Summary",
    date_from: "2026-07-01",
    date_to: "2026-07-31",
  });
  const batchId = created.data.report_batch.report_batch_id;

  assert.throws(
    () => ctx.FieldOSJobReports.getReportBatchPdfData({ ...MANAGER, report_batch_id: batchId }),
    /has not been generated/
  );

  ctx.FieldOSJobReports.validateReportBatch({ ...MANAGER, report_batch_id: batchId });
  ctx.FieldOSJobReports.generateReportData({ ...MANAGER, report_batch_id: batchId });

  const frozen = ctx.FieldOSJobReports.getReportBatchPdfData({ ...MANAGER, report_batch_id: batchId });
  assert.equal(frozen.data.report_batch_id, batchId);
  assert.equal(frozen.data.template_version, "3F.1");
  assert.equal(frozen.data.report_data.jobs.length, 2);
  assert.equal(frozen.data.report_data.omitted_job_data, false);
  assert.ok(frozen.data.checksum);
  const json = JSON.stringify(frozen);
  assert.ok(!json.includes(TRANSCRIPT_SECRET));
  assert.ok(!json.includes(DRIVE_SECRET));
  assert.ok(!/pdf_base64|pdf_bytes/i.test(json));

  // Staff cannot read a manager-scoped batch.
  assert.throws(
    () => ctx.FieldOSJobReports.getReportBatchPdfData({ ...STAFF_2, report_batch_id: batchId }),
    /Forbidden/
  );
});

test("stale expected_version raises a Conflict", () => {
  const ctx = buildContext();
  const created = ctx.FieldOSJobReports.createReportBatch({
    ...MANAGER,
    report_type: "Job Sheet Summary",
    date_from: "2026-07-01",
    date_to: "2026-07-31",
  });
  const batchId = created.data.report_batch.report_batch_id;
  assert.equal(created.data.report_batch.version, 1);

  ctx.FieldOSJobReports.validateReportBatch({ ...MANAGER, report_batch_id: batchId });
  assert.throws(
    () =>
      ctx.FieldOSJobReports.generateReportData({
        ...MANAGER,
        report_batch_id: batchId,
        expected_version: 1,
      }),
    /Conflict/
  );
  assert.throws(
    () =>
      ctx.FieldOSJobReports.validateReportBatch({
        ...MANAGER,
        report_batch_id: batchId,
        expected_version: 99,
      }),
    /Conflict/
  );
});

test("unvalidated batches cannot be generated and cancelled batches are closed", () => {
  const ctx = buildContext();
  const created = ctx.FieldOSJobReports.createReportBatch({
    ...MANAGER,
    report_type: "Job Sheet Summary",
    date_from: "2026-07-01",
    date_to: "2026-07-31",
  });
  const batchId = created.data.report_batch.report_batch_id;
  assert.throws(
    () => ctx.FieldOSJobReports.generateReportData({ ...MANAGER, report_batch_id: batchId }),
    /validate the report batch before generating/
  );

  const cancelled = ctx.FieldOSJobReports.cancelReportBatch({ ...MANAGER, report_batch_id: batchId });
  assert.equal(cancelled.data.report_batch.status, "Cancelled");
  assert.throws(
    () => ctx.FieldOSJobReports.validateReportBatch({ ...MANAGER, report_batch_id: batchId }),
    /Cancelled/
  );
});

test("batch listing and access are scoped for staff", () => {
  const ctx = buildContext();
  const managerBatch = ctx.FieldOSJobReports.createReportBatch({
    ...MANAGER,
    report_type: "Job Sheet Summary",
    date_from: "2026-07-01",
    date_to: "2026-07-31",
  });
  const staffBatch = ctx.FieldOSJobReports.createReportBatch({
    ...STAFF_2,
    report_type: "Staff Work Report",
    date_from: "2026-07-01",
    date_to: "2026-07-31",
  });
  assert.equal(staffBatch.data.report_batch.scope_staff_id, "STAFF-2");

  const staffList = ctx.FieldOSJobReports.listReportBatches(STAFF_2);
  deepEqual(
    staffList.data.items.map((i) => i.report_batch_id),
    [staffBatch.data.report_batch.report_batch_id]
  );
  const managerList = ctx.FieldOSJobReports.listReportBatches(MANAGER);
  assert.equal(managerList.data.items.length, 2);

  assert.throws(
    () =>
      ctx.FieldOSJobReports.getReportBatch({
        ...STAFF_2,
        report_batch_id: managerBatch.data.report_batch.report_batch_id,
      }),
    /Forbidden/
  );
});

test("audit payloads are whitelist-only and drop secrets", () => {
  const ctx = buildContext();
  const safe = ctx.fieldosReportAuditPayload_({
    action: "generate_report_data",
    report_batch_id: "RPT-0001",
    report_type: "Job Sheet Summary",
    record_count: 2,
    checksum: "abc12345",
    file_name: "nativegrace_job_21759f5d_2026-07-16.pdf",
    snapshot_json: "SHOULD_NOT_APPEAR",
    ai_transcript: TRANSCRIPT_SECRET,
    recording_drive_file_id: DRIVE_SECRET,
    webhook_secret: "shh",
    Authorization: "Bearer tok",
  });
  assert.equal(safe.report_batch_id, "RPT-0001");
  assert.equal(safe.record_count, 2);
  assert.equal(safe.checksum, "abc12345");
  assert.equal(safe.snapshot_json, undefined);
  assert.equal(safe.ai_transcript, undefined);
  assert.equal(safe.recording_drive_file_id, undefined);
  assert.equal(safe.webhook_secret, undefined);
  assert.equal(safe.Authorization, undefined);

  ctx.FieldOSJobReports.getJobPdfData({ ...MANAGER, job_sheet_id: "21759f5d" });
  const auditJson = JSON.stringify(ctx.__audits);
  assert.ok(!auditJson.includes(TRANSCRIPT_SECRET));
  assert.ok(!auditJson.includes(DRIVE_SECRET));
  assert.ok(!auditJson.includes("INTERNAL_MARGIN_NOTE"));
});

test("falls back to a minimal loader when CompletionExports is unavailable", () => {
  const ctx = buildContext({ withCompletionExports: false });
  assert.equal(typeof ctx.FieldOSCompletionExports, "undefined");
  const preview = ctx.FieldOSJobReports.previewReport({
    ...MANAGER,
    report_type: "Job Sheet Summary",
    date_from: "2026-07-01",
    date_to: "2026-07-31",
  });
  deepEqual(
    preview.data.included.map((i) => i.job_sheet_id),
    ["21759f5d", "b2"]
  );

  const pdf = ctx.FieldOSJobReports.getJobPdfData({ ...MANAGER, job_sheet_id: "21759f5d" });
  assert.equal(pdf.data.pdf_data.labour.length, 2);
  assert.equal(pdf.data.pdf_data.tasks.length, 4);
  assert.ok(!JSON.stringify(pdf.data.pdf_data).includes(TRANSCRIPT_SECRET));
});

test("reports refuse to run when the report tables are missing", () => {
  const tables = seedTables();
  delete tables.tbl_report_batches;
  delete tables.tbl_report_batch_items;
  const ctx = buildContext({ tables });
  assert.throws(
    () =>
      ctx.FieldOSJobReports.createReportBatch({
        ...MANAGER,
        report_type: "Job Sheet Summary",
        date_from: "2026-07-01",
        date_to: "2026-07-31",
      }),
    /migrateSchemaForJobReports/
  );
  deepEqual(ctx.FieldOSJobReports.listReportBatches(MANAGER).data.items, []);
});
