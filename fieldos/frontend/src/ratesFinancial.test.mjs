/**
 * Phase 3E rates & financial staging helper tests.
 * Run: node --test fieldos/frontend/src/ratesFinancial.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RATE_SOURCE_PRECEDENCE,
  RATE_STATUSES,
  RATE_TABS,
  SNAPSHOT_STATUSES,
  buildRatesQuery,
  canApproveSnapshot,
  canSupersedeSnapshot,
  canValidateSnapshot,
  confirmApproveMessage,
  emptyRowsMessage,
  formatMoneyDisplay,
  isManagerRole,
  isWideLayout,
  overlapWarningText,
  precedenceRank,
  pruneBlanks,
  rateSourceLabel,
  readinessCards,
  readinessTone,
  snapshotStatusTone,
  staleConflictMessage,
  tabLabel,
} from "./ratesFinancialHelpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("manager role gate", () => {
  assert.equal(isManagerRole("manager"), true);
  assert.equal(isManagerRole("Admin"), true);
  assert.equal(isManagerRole("administrator"), true);
  assert.equal(isManagerRole("staff"), false);
  assert.equal(isManagerRole(""), false);
});

test("status vocabularies match the backend lifecycle", () => {
  assert.deepEqual(RATE_STATUSES, ["Active", "Inactive"]);
  assert.deepEqual(SNAPSHOT_STATUSES, [
    "Draft",
    "Validated",
    "Approved",
    "Superseded",
    "Cancelled",
  ]);
});

test("tab labels cover every rate management section", () => {
  assert.deepEqual(
    RATE_TABS.map((tab) => tab.key),
    [
      "rate_cards",
      "labour_rates",
      "machinery_rates",
      "material_catalog",
      "customer_pricing",
      "payroll_mappings",
      "xero_mappings",
      "financial_snapshots",
    ]
  );
  assert.equal(tabLabel("xero_mappings"), "Xero mappings");
  assert.equal(tabLabel("nope"), "");
  assert.match(emptyRowsMessage("labour_rates"), /labour rates/);
});

test("snapshot action gates follow Draft → Validated → Approved → Superseded", () => {
  assert.equal(canValidateSnapshot("Draft"), true);
  assert.equal(canValidateSnapshot("Validated"), true);
  assert.equal(canValidateSnapshot("Approved"), false);
  assert.equal(canApproveSnapshot("Validated"), true);
  assert.equal(canApproveSnapshot("Draft"), false);
  assert.equal(canSupersedeSnapshot("Approved"), true);
  assert.equal(canSupersedeSnapshot("Validated"), false);
  assert.equal(canSupersedeSnapshot("Superseded"), false);
});

test("snapshot and readiness badge tones", () => {
  assert.equal(snapshotStatusTone("Approved"), "ok");
  assert.equal(snapshotStatusTone("Draft"), "muted");
  assert.equal(snapshotStatusTone("Superseded"), "warn");
  assert.equal(readinessTone(true), "ok");
  assert.equal(readinessTone(false), "warn");
});

test("money display never invents a value", () => {
  assert.equal(formatMoneyDisplay("85.00"), "AUD 85.00");
  assert.equal(formatMoneyDisplay("85.5"), "AUD 85.50");
  assert.equal(formatMoneyDisplay("85", ""), "85.00");
  assert.equal(formatMoneyDisplay("-12.34", "AUD"), "-AUD 12.34");
  assert.equal(formatMoneyDisplay(""), "—");
  assert.equal(formatMoneyDisplay(null), "—");
  assert.equal(formatMoneyDisplay(undefined), "—");
  assert.equal(formatMoneyDisplay("n/a"), "—");
});

test("approve confirmation states immutability and the posting boundary", () => {
  const msg = confirmApproveMessage({
    financial_snapshot_id: "CFS-1",
    completion_id: "CMP-1",
    total_inc_tax: "1234.50",
    currency: "AUD",
    line_count: 4,
  });
  assert.match(msg, /CFS-1/);
  assert.match(msg, /CMP-1/);
  assert.match(msg, /AUD 1234\.50/);
  assert.match(msg, /immutable/);
  assert.match(msg, /supersede/i);
  assert.match(msg, /no.*posted to Xero or payroll/i);
});

test("overlap warning summarises conflicting effective ranges", () => {
  assert.equal(overlapWarningText([]), "");
  const text = overlapWarningText([
    { a_id: "LR-1", b_id: "LR-2", message: "Overlapping active records LR-1 and LR-2" },
  ]);
  assert.match(text, /1 overlapping active effective-date range:/);
  assert.match(text, /LR-1 \/ LR-2/);
  const many = overlapWarningText(
    Array.from({ length: 7 }, (_, i) => ({ a_id: `A${i}`, b_id: `B${i}` }))
  );
  assert.match(many, /7 overlapping/);
  assert.match(many, /\+2 more/);
});

test("rate source precedence labels", () => {
  assert.deepEqual(RATE_SOURCE_PRECEDENCE, [
    "customer_project_override",
    "customer_override",
    "staff_specific",
    "role_activity",
    "default_rate_card",
  ]);
  assert.equal(precedenceRank("customer_project_override"), 1);
  assert.equal(precedenceRank("default_rate_card"), 5);
  assert.equal(precedenceRank("machinery_rate"), null);
  assert.equal(rateSourceLabel("staff_specific"), "Staff specific");
  assert.equal(rateSourceLabel("non_billable"), "Non-billable (zero)");
  assert.equal(rateSourceLabel(""), "—");
});

test("query builder drops blanks and false flags", () => {
  assert.equal(
    buildRatesQuery({ on_date: "2026-07-16", include_inactive: false, staff_id: "" }),
    "?on_date=2026-07-16"
  );
  assert.equal(buildRatesQuery({ include_inactive: true }), "?include_inactive=true");
  assert.equal(buildRatesQuery({}), "");
});

test("pruneBlanks keeps only supplied fields", () => {
  assert.deepEqual(pruneBlanks({ a: " x ", b: "", c: null, d: 0, e: undefined }), { a: "x", d: 0 });
});

test("stale conflict message names the record", () => {
  assert.match(staleConflictMessage("Labour rate"), /Labour rate changed elsewhere \(409\)/);
});

test("readiness cards surface flags and totals", () => {
  const cards = readinessCards({
    invoice_pricing_ready: false,
    payroll_mapping_ready: true,
    pricing_status: "Unresolved",
    totals_preview: {
      subtotal_ex_tax: "100.00",
      tax_amount: "10.00",
      total_inc_tax: "110.00",
      tax_type: "GST on Income",
      currency: "AUD",
    },
  });
  assert.equal(cards.find((c) => c.key === "invoice").value, "Blocked");
  assert.equal(cards.find((c) => c.key === "payroll").value, "Ready");
  assert.equal(cards.find((c) => c.key === "total").value, "AUD 110.00");
  assert.match(cards.find((c) => c.key === "tax").label, /GST on Income/);
});

test("responsive helper", () => {
  assert.equal(isWideLayout(719), false);
  assert.equal(isWideLayout(720), true);
});

test("rates page wires every manager-only endpoint and guard", () => {
  const page = fs.readFileSync(path.join(__dirname, "pages", "RatesFinancialPage.jsx"), "utf8");
  assert.match(page, /Navigate to="\/"/);
  assert.match(page, /isManagerRole/);
  assert.match(page, /"\/rate-cards"/);
  assert.match(page, /"\/rates\/labour"/);
  assert.match(page, /"\/rates\/machinery"/);
  assert.match(page, /"\/materials\/catalog"/);
  assert.match(page, /"\/pricing\/customer"/);
  assert.match(page, /"\/mappings\/payroll"/);
  assert.match(page, /"\/mappings\/xero"/);
  assert.match(page, /pricing\/readiness/);
  assert.match(page, /financial-snapshots/);
  assert.match(page, /\/financial-snapshots\/\$\{encodeURIComponent\(snapshot\.financial_snapshot_id\)\}\/\$\{action\}/);
  assert.match(page, /snapshotAction\("validate"/);
  assert.match(page, /snapshotAction\("approve"/);
  assert.match(page, /snapshotAction\("supersede"/);
});

test("rates page handles dating, conflicts, confirmation and blockers", () => {
  const page = fs.readFileSync(path.join(__dirname, "pages", "RatesFinancialPage.jsx"), "utf8");
  assert.match(page, /effective_from/);
  assert.match(page, /effective_to/);
  assert.match(page, /expected_version/);
  assert.match(page, /status === 409|staleConflictMessage/);
  assert.match(page, /window\.confirm/);
  assert.match(page, /confirmApproveMessage/);
  assert.match(page, /window\.prompt/);
  assert.match(page, /invoice_blockers/);
  assert.match(page, /payroll_blockers/);
  assert.match(page, /rate_source_type/);
  assert.match(page, /overlapWarningText/);
  assert.match(page, /Loading /);
  assert.match(page, /error-box/);
  assert.match(page, /dashboard-page/);
});

test("routes and manager navigation are wired", () => {
  const app = fs.readFileSync(path.join(__dirname, "App.jsx"), "utf8");
  const jobs = fs.readFileSync(path.join(__dirname, "pages", "JobsPage.jsx"), "utf8");
  const completions = fs.readFileSync(
    path.join(__dirname, "pages", "CompletionsDashboardPage.jsx"),
    "utf8"
  );
  assert.match(app, /path="\/rates"/);
  assert.match(app, /RatesFinancialPage/);
  assert.match(jobs, /to="\/rates"/);
  assert.match(jobs, /manager &&/);
  assert.match(completions, /to="\/rates"/);
});

test("page reuses the shared authenticated api client", () => {
  const page = fs.readFileSync(path.join(__dirname, "pages", "RatesFinancialPage.jsx"), "utf8");
  const api = fs.readFileSync(path.join(__dirname, "api.js"), "utf8");
  assert.match(page, /from "\.\.\/api"/);
  assert.match(api, /Authorization/);
  assert.ok(!page.includes("?token="));
  assert.ok(!page.includes("fetch("));
});
