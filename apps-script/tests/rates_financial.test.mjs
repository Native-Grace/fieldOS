/**
 * Phase 3E rate resolution + financial snapshot tests.
 * Run: node --test apps-script/tests/rates_financial.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const completionHelpersSrc = fs.readFileSync(
  path.join(__dirname, "..", "JobCompletionHelpers.js"),
  "utf8"
);
const ratesHelpersSrc = fs.readFileSync(
  path.join(__dirname, "..", "RatesFinancialHelpers.js"),
  "utf8"
);
const ratesSrc = fs.readFileSync(path.join(__dirname, "..", "RatesFinancial.js"), "utf8");

const JOB_DATE = "2026-07-16";

function baseContext() {
  return {
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
  };
}

/** Helpers only — enough for the pure rate/line functions. */
function loadPure() {
  const context = baseContext();
  vm.createContext(context);
  vm.runInContext(completionHelpersSrc, context);
  vm.runInContext(ratesHelpersSrc, context);
  vm.runInContext(ratesSrc, context);
  return context;
}

function labourRate(overrides) {
  return Object.assign(
    {
      labour_rate_id: "LR-BASE",
      rate_card_id: "",
      staff_id: "",
      customer_id: "",
      project_id: "",
      role_code: "",
      activity_code: "",
      unit: "hour",
      sell_rate: "100.00",
      cost_rate: "50.00",
      travel_rate: "",
      overtime_rate: "",
      status: "Active",
      effective_from: "2026-01-01",
      effective_to: "",
    },
    overrides || {}
  );
}

const XERO_MAPPINGS = [
  {
    xero_mapping_id: "XM-LAB",
    entity_type: "labour",
    local_reference: "labour",
    xero_reference: "",
    account_code: "200",
    tax_type: "OUTPUT",
    tax_rate_percent: 10,
    status: "Active",
  },
  {
    xero_mapping_id: "XM-MAT",
    entity_type: "material",
    local_reference: "material",
    xero_reference: "",
    account_code: "310",
    tax_type: "OUTPUT",
    tax_rate_percent: 10,
    status: "Active",
  },
  {
    xero_mapping_id: "XM-MCH",
    entity_type: "machinery",
    local_reference: "machinery",
    xero_reference: "",
    account_code: "220",
    tax_type: "OUTPUT",
    tax_rate_percent: 10,
    status: "Active",
  },
  {
    xero_mapping_id: "XM-CUST",
    entity_type: "customer",
    local_reference: "CUST-1",
    xero_reference: "",
    account_code: "200",
    tax_type: "OUTPUT",
    tax_rate_percent: 10,
    status: "Active",
  },
];

function confirmedLabour(overrides) {
  return Object.assign(
    {
      labour_id: "LAB-1",
      staff_id: "STAFF-1",
      staff_name: "Alex",
      work_date: JOB_DATE,
      start_time: "07:00",
      finish_time: "15:00",
      break_minutes: 30,
      labour_hours: 7.5,
      travel_minutes: 0,
      role_or_activity: "",
      billable: true,
      confirmation_status: "Confirmed",
    },
    overrides || {}
  );
}

/** Full gateway harness with an in-memory sheet layer. */
function loadHarness(options) {
  const opts = options || {};
  const tables = {
    tbl_job_completions: [
      {
        completion_id: "CMP-1",
        job_sheet_id: "JS-1",
        completion_status: "Finalised",
        version: 3,
      },
    ],
    tbl_rate_cards: [
      {
        rate_card_id: "RC-1",
        card_name: "Standard 2026",
        currency: "AUD",
        status: "Active",
        effective_from: "2026-01-01",
        effective_to: "",
        version: 1,
      },
    ],
    tbl_labour_rates: [
      labourRate({
        labour_rate_id: "LR-DEFAULT",
        rate_card_id: "RC-1",
        sell_rate: "85.00",
        travel_rate: "60.00",
        version: 1,
      }),
    ],
    tbl_machinery_rates: [],
    tbl_material_catalog: [],
    tbl_customer_pricing: [
      {
        customer_pricing_id: "CP-1",
        customer_id: "CUST-1",
        project_id: "",
        rate_card_id: "RC-1",
        status: "Active",
        effective_from: "2026-01-01",
        effective_to: "",
        version: 1,
      },
    ],
    tbl_payroll_mappings: [
      {
        payroll_mapping_id: "PM-1",
        staff_id: "STAFF-1",
        employee_reference: "EMP-1",
        ordinary_hours_code: "ORD",
        cost_centre: "CC-1",
        status: "Active",
        effective_from: "2026-01-01",
        effective_to: "",
        version: 1,
      },
    ],
    tbl_xero_mappings: XERO_MAPPINGS.slice(),
    tbl_completion_financials: [],
    tbl_completion_financial_lines: [],
  };
  Object.keys(opts.tables || {}).forEach((name) => {
    tables[name] = opts.tables[name];
  });

  const labourEntries = opts.labour_entries || [confirmedLabour()];
  const auditRows = [];
  let idCounter = 0;

  const context = Object.assign(baseContext(), {
    DB: {
      generateId(prefix) {
        idCounter += 1;
        return `${prefix}-T${idCounter}`;
      },
      getSheet(name) {
        if (!tables[name]) throw new Error(`Database Error: Table '${name}' missing.`);
        return { name };
      },
      findAll(name) {
        return (tables[name] || []).map((row) => ({ ...row }));
      },
      findWhere(name, cond) {
        if (!tables[name]) throw new Error(`Database Error: Table '${name}' missing.`);
        return tables[name]
          .filter((row) => Object.keys(cond).every((k) => String(row[k]) === String(cond[k])))
          .map((row) => ({ ...row }));
      },
      insertRecord(name, record) {
        if (!tables[name]) throw new Error(`Database Error: Table '${name}' missing.`);
        tables[name].push({ ...record });
        return record;
      },
      updateRecord(name, keyColumn, keyValue, patch) {
        const row = (tables[name] || []).find(
          (candidate) => String(candidate[keyColumn]) === String(keyValue)
        );
        if (!row) throw new Error(`Record ${keyValue} not found in ${name}.`);
        Object.assign(row, patch);
        return { ...row };
      },
    },
    Utils: {
      withLock(_name, _timeout, fn) {
        return fn();
      },
    },
    SyncRepository: {
      create(row) {
        auditRows.push(row);
        return row;
      },
    },
    JobSheetRepository: {
      findById(id) {
        if (id !== "JS-1") return null;
        return {
          job_sheet_id: "JS-1",
          date: JOB_DATE,
          customer_id: opts.customer_id === undefined ? "CUST-1" : opts.customer_id,
          project_id: "PROJ-1",
          approval_status: "Approved",
          processing_status: "Completed",
        };
      },
    },
    fieldosIsManagerOrAdmin_(role) {
      return String(role || "") === "manager" || String(role || "") === "admin";
    },
    fieldosNormalizeRole_(role) {
      return String(role || "staff").toLowerCase();
    },
    fieldosLoadDisplayMaps_() {
      return {
        projectById: {
          "PROJ-1": { project_id: "PROJ-1", project_name: "Garden", customer_id: "CUST-1" },
        },
        customerById: { "CUST-1": { customer_id: "CUST-1", customer_name: "Acme" } },
        projectByExactName: {},
        projectByNormName: {},
      };
    },
    fieldosResolveProjectCustomer_() {
      return { project_name: "Garden", customer_name: "Acme", match: "project_id", warning: null };
    },
    FieldOSCompletionExports: {
      _loadCompletionBundle(row) {
        return {
          completion: {
            completion_id: String(row.completion_id),
            job_sheet_id: String(row.job_sheet_id),
            completion_status: String(row.completion_status),
            version: Number(row.version) || 1,
          },
          job: { job_sheet_id: "JS-1", job_date: JOB_DATE, approval_status: "Approved" },
          labour_entries: labourEntries,
          machinery_entries: opts.machinery_entries || [],
          material_entries: opts.material_entries || [],
          readiness: { invoice_ready: true, payroll_ready: true, warning_count: 0 },
        };
      },
    },
  });

  vm.createContext(context);
  vm.runInContext(completionHelpersSrc, context);
  vm.runInContext(ratesHelpersSrc, context);
  vm.runInContext(ratesSrc, context);
  context.__tables = tables;
  context.__audit = auditRows;
  return context;
}

test("line amounts stay exact in cents (0.1 + 0.2 = 0.30)", () => {
  const ctx = loadPure();
  assert.equal(0.1 + 0.2 === 0.3, false); // float baseline

  const built = ctx.fieldosBuildFinancialLines_({
    completion_id: "CMP-1",
    job_date: JOB_DATE,
    identity: { customer_id: "CUST-1", project_id: "PROJ-1" },
    material_entries: [
      {
        material_entry_id: "JMT-1",
        material_id: "MATC-A",
        item_name: "Sand",
        quantity: 1,
        billable: true,
        confirmation_status: "Confirmed",
      },
      {
        material_entry_id: "JMT-2",
        material_id: "MATC-B",
        item_name: "Gravel",
        quantity: 1,
        billable: true,
        confirmation_status: "Confirmed",
      },
    ],
    tables: {
      material_catalog: [
        { material_id: "MATC-A", item_name: "Sand", unit: "each", sell_price: "0.10", active: "TRUE" },
        { material_id: "MATC-B", item_name: "Gravel", unit: "each", sell_price: "0.20", active: "TRUE" },
      ],
      xero_mappings: XERO_MAPPINGS,
    },
  });

  assert.equal(built.lines.length, 2);
  assert.equal(built.lines[0].line_amount_ex_tax, "0.10");
  assert.equal(built.lines[1].line_amount_ex_tax, "0.20");
  assert.equal(built.subtotal_ex_tax_cents, 30);
  assert.equal(built.subtotal_ex_tax, "0.30");
  // 10% GST on 30c rounds half-up to 3c.
  assert.equal(built.tax_amount, "0.03");
  assert.equal(built.total_inc_tax, "0.33");
});

test("labour rate precedence: project > customer > staff > role > default", () => {
  const ctx = loadPure();
  const context = {
    staff_id: "STAFF-1",
    role_code: "LEADING_HAND",
    activity_code: "LEADING_HAND",
    customer_id: "CUST-1",
    project_id: "PROJ-1",
    on_date: JOB_DATE,
  };
  const rows = [
    labourRate({ labour_rate_id: "LR-DEFAULT", sell_rate: "80.00" }),
    labourRate({ labour_rate_id: "LR-ROLE", role_code: "LEADING_HAND", sell_rate: "90.00" }),
    labourRate({ labour_rate_id: "LR-STAFF", staff_id: "STAFF-1", sell_rate: "95.00" }),
    labourRate({ labour_rate_id: "LR-CUST", customer_id: "CUST-1", sell_rate: "105.00" }),
    labourRate({ labour_rate_id: "LR-PROJ", project_id: "PROJ-1", sell_rate: "120.00" }),
  ];

  const expected = [
    ["LR-PROJ", ctx.FIELDOS_RATE_SOURCE_.PROJECT, 12000],
    ["LR-CUST", ctx.FIELDOS_RATE_SOURCE_.CUSTOMER, 10500],
    ["LR-STAFF", ctx.FIELDOS_RATE_SOURCE_.STAFF, 9500],
    ["LR-ROLE", ctx.FIELDOS_RATE_SOURCE_.ROLE, 9000],
    ["LR-DEFAULT", ctx.FIELDOS_RATE_SOURCE_.DEFAULT_CARD, 8000],
  ];

  let candidates = rows.slice();
  expected.forEach(([id, sourceType, cents]) => {
    const resolved = ctx.fieldosResolveLabourSellRate_(context, candidates, []);
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.source_id, id);
    assert.equal(resolved.source_type, sourceType);
    assert.equal(resolved.rate_cents, cents);
    candidates = candidates.filter((row) => row.labour_rate_id !== id);
  });
});

test("effective date bounds are inclusive on both ends", () => {
  const ctx = loadPure();
  const rows = [
    labourRate({
      labour_rate_id: "LR-WINDOW",
      effective_from: JOB_DATE,
      effective_to: JOB_DATE,
      sell_rate: "77.00",
    }),
  ];
  const onDay = ctx.fieldosResolveLabourSellRate_({ staff_id: "STAFF-1", on_date: JOB_DATE }, rows, []);
  assert.equal(onDay.resolved, true);
  assert.equal(onDay.rate_cents, 7700);

  const dayBefore = ctx.fieldosResolveLabourSellRate_(
    { staff_id: "STAFF-1", on_date: "2026-07-15" },
    rows,
    []
  );
  const dayAfter = ctx.fieldosResolveLabourSellRate_(
    { staff_id: "STAFF-1", on_date: "2026-07-17" },
    rows,
    []
  );
  assert.equal(dayBefore.resolved, false);
  assert.equal(dayAfter.resolved, false);
  assert.equal(ctx.fieldosDateEffective_(rows[0], JOB_DATE), true);
});

test("overlapping active effective ranges are detected and rejected on create", () => {
  const ctx = loadPure();
  const overlaps = ctx.fieldosFindEffectiveOverlaps_(
    [
      labourRate({ labour_rate_id: "LR-A", effective_from: "2026-01-01", effective_to: "2026-06-30" }),
      labourRate({ labour_rate_id: "LR-B", effective_from: "2026-06-30", effective_to: "" }),
      labourRate({ labour_rate_id: "LR-C", effective_from: "2026-07-01", effective_to: "", status: "Inactive" }),
    ],
    "labour_rate_id",
    (row) => String(row.staff_id || "") + "|" + String(row.role_code || "")
  );
  assert.equal(overlaps.length, 1);
  assert.match(overlaps[0].message, /LR-A/);
  assert.match(overlaps[0].message, /LR-B/);

  const harness = loadHarness();
  assert.throws(
    () =>
      harness.FieldOSRatesFinancial.createLabourRate({
        actor_role: "manager",
        staff_id: "STAFF-MGR",
        record: {
          rate_card_id: "RC-1",
          sell_rate: "99.00",
          effective_from: "2026-05-01",
          effective_to: "",
        },
      }),
    /Validation Error: effective date range overlaps/
  );

  const created = harness.FieldOSRatesFinancial.createLabourRate({
    actor_role: "manager",
    staff_id: "STAFF-MGR",
    record: {
      rate_card_id: "RC-1",
      staff_id: "STAFF-9",
      sell_rate: "99.00",
      effective_from: "2026-05-01",
    },
  });
  assert.equal(created.data.item.sell_rate, "99.00");
  assert.equal(created.data.item.status, "Active");
  assert.equal(created.data.item.version, 1);
});

test("unresolved rates never fall back to zero", () => {
  const ctx = loadPure();
  const built = ctx.fieldosBuildFinancialLines_({
    completion_id: "CMP-1",
    job_date: JOB_DATE,
    identity: { customer_id: "CUST-1", project_id: "PROJ-1" },
    labour_entries: [confirmedLabour()],
    machinery_entries: [
      {
        machinery_entry_id: "MCH-1",
        equipment_name: "Excavator",
        duration_hours: 2,
        billable: true,
        confirmation_status: "Confirmed",
      },
    ],
    material_entries: [
      {
        material_entry_id: "JMT-1",
        item_name: "Trees",
        quantity: 7,
        billable: true,
        confirmation_status: "Confirmed",
      },
    ],
    tables: { xero_mappings: XERO_MAPPINGS },
  });

  assert.equal(built.lines.length, 3);
  built.lines.forEach((line) => {
    assert.equal(line.unit_sell, "");
    assert.equal(line.unit_sell_cents, null);
    assert.equal(line.line_amount_ex_tax, "");
    assert.ok(line.blockers.length > 0);
    assert.equal(line.rate_source_type, ctx.FIELDOS_RATE_SOURCE_.UNRESOLVED);
  });
  assert.equal(built.subtotal_ex_tax, "0.00");
  assert.equal(built.unresolved_line_count, 3);
  assert.ok(built.blockers.some((b) => /No active labour sell rate/.test(b)));
  assert.ok(built.blockers.some((b) => /No active machinery sell rate/.test(b)));
  assert.ok(built.blockers.some((b) => /No confirmed material catalog match/.test(b)));

  // Fuzzy name matches are surfaced as suggestions only, never auto-priced.
  const withSuggestions = ctx.fieldosBuildFinancialLines_({
    job_date: JOB_DATE,
    identity: {},
    material_entries: [
      {
        material_entry_id: "JMT-1",
        item_name: "Trees",
        quantity: 7,
        billable: true,
        confirmation_status: "Confirmed",
      },
    ],
    tables: {
      material_catalog: [
        { material_id: "MATC-T", item_code: "TREE", item_name: "Trees 45L", sell_price: "120.00", active: "TRUE" },
      ],
      xero_mappings: XERO_MAPPINGS,
    },
  });
  assert.equal(withSuggestions.lines[0].unit_sell, "");
  assert.equal(withSuggestions.suggestions.length, 1);
  assert.equal(withSuggestions.suggestions[0].suggested_matches[0].material_id, "MATC-T");
});

test("non-billable labour prices at zero with a reason, travel follows the flag", () => {
  const ctx = loadPure();
  const built = ctx.fieldosBuildFinancialLines_({
    job_date: JOB_DATE,
    identity: { customer_id: "CUST-1" },
    labour_entries: [
      confirmedLabour({ labour_id: "LAB-NB", billable: false, travel_minutes: 30 }),
      confirmedLabour({ labour_id: "LAB-EX", confirmation_status: "Suggested" }),
    ],
    tables: { labour_rates: [], xero_mappings: XERO_MAPPINGS },
  });

  // Suggested rows are never priced.
  assert.equal(built.lines.length, 2);
  const labour = built.lines[0];
  const travel = built.lines[1];
  assert.equal(labour.line_type, "labour");
  assert.equal(labour.billable, false);
  assert.equal(labour.unit_sell, "0.00");
  assert.equal(labour.line_amount_ex_tax, "0.00");
  assert.equal(labour.tax_amount, "0.00");
  assert.match(labour.non_billable_reason, /non-billable/);
  assert.equal(labour.blockers.length, 0);
  assert.equal(travel.line_type, "travel");
  assert.equal(travel.quantity, 0.5);
  assert.equal(travel.unit_sell, "0.00");
  assert.match(travel.non_billable_reason, /non-billable/);
  assert.equal(built.subtotal_ex_tax, "0.00");

  // Billable travel requires a configured travel_rate — it is never assumed.
  const billableTravel = ctx.fieldosBuildFinancialLines_({
    job_date: JOB_DATE,
    identity: {},
    labour_entries: [confirmedLabour({ travel_minutes: 30 })],
    tables: {
      labour_rates: [labourRate({ labour_rate_id: "LR-NOTRAVEL", staff_id: "STAFF-1", travel_rate: "" })],
      xero_mappings: XERO_MAPPINGS,
    },
  });
  const travelLine = billableTravel.lines[1];
  assert.equal(travelLine.line_type, "travel");
  assert.equal(travelLine.unit_sell, "");
  assert.ok(travelLine.blockers.some((b) => /no travel_rate configured/.test(b)));
});

test("overtime is never inferred from shift length", () => {
  const ctx = loadPure();
  const rates = [labourRate({ labour_rate_id: "LR-S", staff_id: "STAFF-1", sell_rate: "85.00" })];
  const noOvertime = ctx.fieldosBuildFinancialLines_({
    job_date: JOB_DATE,
    identity: {},
    labour_entries: [
      confirmedLabour({ start_time: "05:00", finish_time: "20:00", labour_hours: 14.5 }),
    ],
    tables: { labour_rates: rates, xero_mappings: XERO_MAPPINGS },
  });
  assert.equal(noOvertime.lines.length, 1);
  assert.equal(noOvertime.lines[0].line_amount_ex_tax, "1232.50");

  const explicitOvertime = ctx.fieldosBuildFinancialLines_({
    job_date: JOB_DATE,
    identity: {},
    labour_entries: [confirmedLabour({ overtime_hours: 2 })],
    tables: { labour_rates: rates, xero_mappings: XERO_MAPPINGS },
  });
  assert.equal(explicitOvertime.lines.length, 2);
  assert.equal(explicitOvertime.lines[1].unit_sell, "");
  assert.ok(explicitOvertime.lines[1].blockers.some((b) => /overtime_rate/.test(b)));
});

test("financial audit payload drops secrets and free text", () => {
  const ctx = loadPure();
  const safe = ctx.fieldosFinancialAuditPayload_({
    action: "approve_financial_snapshot",
    actor_staff_id: "STAFF-MGR",
    actor_role: "manager",
    resource_type: "tbl_completion_financials",
    resource_id: "CFS-1",
    completion_id: "CMP-1",
    new_status: "Approved",
    version: 4,
    webhook_secret: "SUPER_SECRET",
    Authorization: "Bearer token",
    transcript: "SECRET",
    drive_file_id: "DRIVE123",
    subtotal_ex_tax: "1234.00",
    customer_name: "Acme",
  });
  assert.equal(safe.resource_id, "CFS-1");
  assert.equal(safe.new_status, "Approved");
  assert.equal(safe.webhook_secret, undefined);
  assert.equal(safe.Authorization, undefined);
  assert.equal(safe.transcript, undefined);
  assert.equal(safe.drive_file_id, undefined);
  assert.equal(safe.subtotal_ex_tax, undefined);
  assert.equal(safe.customer_name, undefined);
  const serialised = JSON.stringify(safe);
  assert.ok(!serialised.includes("SUPER_SECRET"));
  assert.ok(!serialised.includes("DRIVE123"));
});

test("snapshot transitions: approved snapshots are immutable except supersede", () => {
  const ctx = loadPure();
  assert.equal(ctx.fieldosSnapshotTransitionAllowed_("Draft", "Validated"), true);
  assert.equal(ctx.fieldosSnapshotTransitionAllowed_("Validated", "Approved"), true);
  assert.equal(ctx.fieldosSnapshotTransitionAllowed_("Draft", "Approved"), false);
  assert.equal(ctx.fieldosSnapshotTransitionAllowed_("Approved", "Validated"), false);
  assert.equal(ctx.fieldosSnapshotTransitionAllowed_("Approved", "Draft"), false);
  assert.equal(ctx.fieldosSnapshotTransitionAllowed_("Approved", "Superseded"), true);
  assert.equal(ctx.fieldosSnapshotTransitionAllowed_("Superseded", "Approved"), false);
  assert.throws(
    () => ctx.fieldosAssertSnapshotTransition_("Approved", "Validated"),
    /Validation Error: Approved financial snapshots are immutable/
  );
  assert.throws(
    () => ctx.fieldosAssertSnapshotTransition_("Draft", "Approved"),
    /Validation Error: cannot move financial snapshot from Draft to Approved/
  );
});

test("snapshot lifecycle: draft → validated → approved → superseded", () => {
  const ctx = loadHarness();
  const readiness = ctx.FieldOSRatesFinancial.getCompletionPricingReadiness({
    actor_role: "manager",
    staff_id: "STAFF-MGR",
    completion_id: "CMP-1",
  });
  assert.equal(readiness.data.identity.customer_id, "CUST-1");
  assert.equal(readiness.data.identity.project_id, "PROJ-1");
  assert.equal(readiness.data.identity.job_date, JOB_DATE);
  assert.equal(readiness.data.invoice_pricing_ready, true);
  assert.equal(readiness.data.payroll_mapping_ready, true);
  assert.equal(readiness.data.sample_rates[0].unit_sell, "85.00");

  const created = ctx.FieldOSRatesFinancial.createFinancialSnapshot({
    actor_role: "manager",
    staff_id: "STAFF-MGR",
    completion_id: "CMP-1",
  });
  const snapshot = created.data.financial_snapshot;
  assert.equal(snapshot.snapshot_status, "Draft");
  assert.equal(snapshot.pricing_status, "Ready");
  assert.equal(snapshot.subtotal_ex_tax, "637.50");
  assert.equal(snapshot.tax_amount, "63.75");
  assert.equal(snapshot.total_inc_tax, "701.25");
  assert.equal(snapshot.xero_reference, "");
  assert.match(snapshot.draft_reference, /^DRAFT-INV-CMP-1-/);
  assert.equal(snapshot.blockers.length, 0);
  assert.equal(created.data.lines.length, 1);

  const validated = ctx.FieldOSRatesFinancial.validateFinancialSnapshot({
    actor_role: "manager",
    staff_id: "STAFF-MGR",
    financial_snapshot_id: snapshot.financial_snapshot_id,
    expected_version: snapshot.version,
  });
  assert.equal(validated.data.financial_snapshot.snapshot_status, "Validated");
  assert.equal(validated.data.financial_snapshot.pricing_status, "Validated");

  assert.throws(
    () =>
      ctx.FieldOSRatesFinancial.validateFinancialSnapshot({
        actor_role: "manager",
        financial_snapshot_id: snapshot.financial_snapshot_id,
        expected_version: 99,
      }),
    /Conflict: financial snapshot changed/
  );

  const approved = ctx.FieldOSRatesFinancial.approveFinancialSnapshot({
    actor_role: "manager",
    staff_id: "STAFF-MGR",
    financial_snapshot_id: snapshot.financial_snapshot_id,
  });
  assert.equal(approved.data.financial_snapshot.snapshot_status, "Approved");
  assert.equal(approved.data.financial_snapshot.pricing_status, "Approved");

  assert.throws(
    () =>
      ctx.FieldOSRatesFinancial.validateFinancialSnapshot({
        actor_role: "manager",
        financial_snapshot_id: snapshot.financial_snapshot_id,
      }),
    /Approved financial snapshots are immutable/
  );
  assert.throws(
    () =>
      ctx.FieldOSRatesFinancial.createFinancialSnapshot({
        actor_role: "manager",
        completion_id: "CMP-1",
      }),
    /Conflict: completion CMP-1 already has an Approved financial snapshot/
  );
  assert.throws(
    () =>
      ctx.FieldOSRatesFinancial.getCompletionPricingReadiness({
        actor_role: "staff",
        completion_id: "CMP-1",
      }),
    /Forbidden: manager or admin role required/
  );

  const superseded = ctx.FieldOSRatesFinancial.supersedeFinancialSnapshot({
    actor_role: "manager",
    staff_id: "STAFF-MGR",
    financial_snapshot_id: snapshot.financial_snapshot_id,
    reason: "Rate correction",
  });
  assert.equal(superseded.data.financial_snapshot.snapshot_status, "Superseded");

  const reCreated = ctx.FieldOSRatesFinancial.createFinancialSnapshot({
    actor_role: "manager",
    completion_id: "CMP-1",
  });
  assert.equal(reCreated.data.financial_snapshot.snapshot_status, "Draft");

  const listed = ctx.FieldOSRatesFinancial.listFinancialSnapshots({
    actor_role: "manager",
    completion_id: "CMP-1",
  });
  assert.equal(listed.data.items.length, 2);

  const auditActions = ctx.__audit.map((row) => JSON.parse(row.request_payload).action);
  assert.ok(auditActions.includes("create_financial_snapshot"));
  assert.ok(auditActions.includes("approve_financial_snapshot"));
  ctx.__audit.forEach((row) => {
    assert.equal(row.target_system, "FieldOS_Rates");
    assert.ok(!row.request_payload.includes("Acme"));
  });
});

test("unresolved identity and rates keep the snapshot in Draft with blockers", () => {
  const ctx = loadHarness({
    customer_id: "",
    tables: { tbl_labour_rates: [], tbl_customer_pricing: [] },
  });
  // Customer identity comes from the project map even when the job row is blank.
  const readiness = ctx.FieldOSRatesFinancial.getCompletionPricingReadiness({
    actor_role: "manager",
    completion_id: "CMP-1",
  });
  assert.equal(readiness.data.invoice_pricing_ready, false);
  assert.ok(readiness.data.invoice_blockers.some((b) => /No active labour sell rate/.test(b)));

  const created = ctx.FieldOSRatesFinancial.createFinancialSnapshot({
    actor_role: "manager",
    completion_id: "CMP-1",
  });
  const snapshot = created.data.financial_snapshot;
  assert.equal(snapshot.pricing_status, "Unresolved");
  assert.ok(snapshot.blockers.length > 0);
  assert.equal(created.data.lines[0].unit_sell, "");

  const validated = ctx.FieldOSRatesFinancial.validateFinancialSnapshot({
    actor_role: "manager",
    financial_snapshot_id: snapshot.financial_snapshot_id,
  });
  assert.equal(validated.data.financial_snapshot.snapshot_status, "Draft");
  assert.ok(validated.data.financial_snapshot.blockers.length > 0);
  assert.throws(
    () =>
      ctx.FieldOSRatesFinancial.approveFinancialSnapshot({
        actor_role: "manager",
        financial_snapshot_id: snapshot.financial_snapshot_id,
      }),
    /cannot move financial snapshot from Draft to Approved/
  );
});

test("customer identity blocker when no project or customer can be resolved", () => {
  const ctx = loadPure();
  const blockers = ctx.FieldOSRatesFinancial._identityBlockers({ customer_id: "", job_date: "" });
  assert.deepEqual(Array.from(blockers), [
    "Customer identity unresolved",
    "Job date unresolved",
  ]);
  assert.equal(
    ctx.FieldOSRatesFinancial._identityBlockers({ customer_id: "CUST-1", job_date: JOB_DATE }).length,
    0
  );
});
