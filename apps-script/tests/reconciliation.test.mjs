/**
 * Node tests for FieldOS Phase 0 project/customer reconciliation + dry-run seed manifest.
 * Run: node --test apps-script/tests/reconciliation.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(
  path.join(__dirname, "..", "FieldOSDisplayDiagnostics.js"),
  "utf8"
);
const context = {
  console,
  DB: {},
  JobSheetRepository: {},
  ProjectRepository: {},
  CustomerRepository: {},
  Logger: { log: function () {} },
};
vm.createContext(context);
vm.runInContext(src, context);

const build = context.fieldosDiagBuildReconciliationReport_;
const normalize = context.fieldosDiagNormalizeLabel_;
const previewId = context.fieldosDiagPreviewSeedId_;
const buildManifest = context.fieldosDiagBuildMasterSeedDryRunManifest_;
const filterApproved = context.fieldosDiagFilterApprovedSafeSeeds_;
const pickFields = context.fieldosDiagPickWritableFields_;
const applySeed = context.fieldosDiagApplyMasterSeed_;

test("plain-text legacy labels become candidate seeds when masters empty", () => {
  const report = build(
    [
      {
        job_sheet_id: "21759f5d",
        project_id: "Kat and James Dykes",
        date: "2026-07-16",
      },
    ],
    [],
    []
  );
  assert.equal(report.masters.empty, true);
  assert.equal(report.exact_project_matches.length, 0);
  assert.equal(report.candidate_seed_labels.length, 1);
  assert.equal(report.safe_for_seed.length, 1);
  assert.equal(report.safe_for_seed[0].legacy_project_label, "Kat and James Dykes");
  assert.equal(report.candidate_seed_labels[0].proposed_seed.dry_run, true);
});

test("repeated labels aggregate usage and are NOT safe_for_seed by default", () => {
  const report = build(
    [
      { job_sheet_id: "j1", project_id: "smith", date: "2026-07-01" },
      { job_sheet_id: "j2", project_id: "smith", date: "2026-07-10" },
    ],
    [],
    []
  );
  assert.equal(report.distinct_label_count, 1);
  assert.equal(report.distinct_labels[0].usage_count, 2);
  assert.equal(report.candidate_seed_labels.length, 1);
  assert.equal(report.safe_for_seed.length, 0);
  assert.ok(
    report.manual_review.some(
      (r) =>
        r.legacy_project_label === "smith" &&
        r.reason === "repeated_legacy_label_requires_confirmation"
    )
  );
  assert.ok(report.warnings.some((w) => w.code === "label_reused_across_jobs"));
});

test("repeated labels become safe only with reviewed_reuse_allowlist", () => {
  const jobs = [
    { job_sheet_id: "j1", project_id: "smith", date: "2026-07-01" },
    { job_sheet_id: "j2", project_id: "smith", date: "2026-07-10" },
  ];
  const denied = build(jobs, [], []);
  assert.equal(denied.safe_for_seed.length, 0);

  const allowed = build(jobs, [], [], {
    reviewed_reuse_allowlist: ["smith"],
  });
  assert.equal(allowed.candidate_seed_labels.length, 1);
  assert.equal(allowed.safe_for_seed.length, 1);
  assert.equal(allowed.safe_for_seed[0].legacy_project_label, "smith");
  assert.equal(allowed.safe_for_seed[0].reuse_allowlisted, true);
  assert.ok(!allowed.manual_review.some((r) => r.legacy_project_label === "smith"));
});

test("blank labels never produce seed rows", () => {
  const report = build(
    [
      { job_sheet_id: "blank1", project_id: "", date: "2026-07-01" },
      { job_sheet_id: "blank2", project_id: "   ", date: "2026-07-02" },
      { job_sheet_id: "ok", project_id: "Solo Client", date: "2026-07-03" },
    ],
    [],
    []
  );
  assert.equal(report.blank_labels.count, 2);
  assert.equal(report.distinct_label_count, 1);
  assert.equal(report.candidate_seed_labels.length, 1);
  assert.equal(report.safe_for_seed.length, 1);
  assert.equal(report.safe_for_seed[0].legacy_project_label, "Solo Client");
  assert.ok(!report.candidate_seed_labels.some((r) => !r.legacy_project_label));
});

test("live-like classification: two singles safe, smith manual, blanks excluded", () => {
  const jobs = [
    { job_sheet_id: "b1", project_id: "", date: "2026-06-01" },
    { job_sheet_id: "b2", project_id: "", date: "2026-06-02" },
    { job_sheet_id: "b3", project_id: "", date: "2026-06-03" },
    { job_sheet_id: "b4", project_id: "", date: "2026-06-04" },
    { job_sheet_id: "b5", project_id: "", date: "2026-06-05" },
    { job_sheet_id: "b6", project_id: "  ", date: "2026-06-06" },
    { job_sheet_id: "j-bab", project_id: "Babidge", date: "2026-07-01" },
    {
      job_sheet_id: "21759f5d",
      project_id: "Kat and James Dykes",
      date: "2026-07-16",
    },
    { job_sheet_id: "s1", project_id: "smith", date: "2026-07-02" },
    { job_sheet_id: "s2", project_id: "smith", date: "2026-07-08" },
  ];
  const report = build(jobs, [], []);
  assert.equal(report.blank_labels.count, 6);
  assert.equal(report.distinct_label_count, 3);
  const safeLabels = report.safe_for_seed.map((r) => r.legacy_project_label).sort();
  assert.equal(safeLabels.length, 2);
  assert.ok(safeLabels.includes("Babidge"));
  assert.ok(safeLabels.includes("Kat and James Dykes"));
  assert.equal(report.candidate_seed_labels.length, 3);
  assert.ok(
    report.manual_review.some(
      (r) =>
        r.legacy_project_label === "smith" &&
        r.reason === "repeated_legacy_label_requires_confirmation"
    )
  );
  assert.ok(!report.safe_for_seed.some((r) => r.legacy_project_label === "smith"));
});

test("normalised duplicates go to manual_review not safe_for_seed", () => {
  const report = build(
    [
      { job_sheet_id: "a", project_id: "Kat and James Dykes", date: "2026-07-01" },
      { job_sheet_id: "b", project_id: "kat and james dykes", date: "2026-07-02" },
    ],
    [],
    []
  );
  assert.equal(normalize("Kat and James Dykes"), normalize("kat and james dykes"));
  assert.equal(report.safe_for_seed.length, 0);
  assert.ok(report.manual_review.length >= 1);
});

test("empty master tables do not invent existing matches", () => {
  const report = build(
    [{ job_sheet_id: "1", project_id: "Only Label", date: "2026-01-01" }],
    [],
    []
  );
  assert.equal(report.masters.empty, true);
  assert.equal(report.exact_project_matches.length, 0);
  assert.equal(report.exact_customer_matches.length, 0);
});

test("candidate seed preview IDs are deterministic", () => {
  const a = previewId("CUST", "Kat and James Dykes", {});
  const b = previewId("CUST", "Kat and James Dykes", {});
  const c = previewId("PROJ", "Kat and James Dykes", {});
  assert.equal(a, b);
  assert.equal(a.slice("CUST-".length), c.slice("PROJ-".length));
});

test("ambiguous labels when masters have duplicate names", () => {
  const report = build(
    [{ job_sheet_id: "1", project_id: "Dup Name", date: "2026-01-01" }],
    [
      { project_id: "PROJ-1", project_name: "Dup Name", customer_id: "CUST-1" },
      { project_id: "PROJ-2", project_name: "Dup Name", customer_id: "CUST-2" },
    ],
    [{ customer_id: "CUST-1", customer_name: "Dup Name" }]
  );
  assert.equal(report.candidate_seed_labels.length, 0);
  assert.ok(report.manual_review.some((r) => r.legacy_project_label === "Dup Name"));
});

test("dry-run manifest includes only safe_for_seed rows", () => {
  const jobs = [
    { job_sheet_id: "b1", project_id: "", date: "2026-06-01" },
    { job_sheet_id: "j-bab", project_id: "Babidge", date: "2026-07-01" },
    {
      job_sheet_id: "21759f5d",
      project_id: "Kat and James Dykes",
      date: "2026-07-16",
    },
    { job_sheet_id: "s1", project_id: "smith", date: "2026-07-02" },
    { job_sheet_id: "s2", project_id: "smith", date: "2026-07-08" },
  ];
  const report = build(jobs, [], []);
  const manifest = buildManifest(report, { migration_batch_id: "SEED-DRYRUN-TEST" });
  assert.equal(manifest.dry_run, true);
  assert.equal(manifest.migration_batch_id, "SEED-DRYRUN-TEST");
  assert.equal(manifest.customers.length, 2);
  assert.equal(manifest.projects.length, 2);
  const names = manifest.customers.map((c) => c.customer_name);
  assert.ok(names.includes("Babidge"));
  assert.ok(names.includes("Kat and James Dykes"));
  assert.ok(!names.includes("smith"));
  assert.ok(manifest.customers.every((c) => c.dry_run === true && c.source === "legacy_job_label"));
  assert.ok(
    manifest.projects.every(
      (p) => p.dry_run === true && p.customer_id && p.project_id && p.affected_job_sheet_ids
    )
  );
  const bab = manifest.customers.find((c) => c.customer_name === "Babidge");
  assert.ok(bab);
  assert.equal(bab.affected_job_sheet_ids.length, 1);
  assert.equal(bab.affected_job_sheet_ids[0], "j-bab");
  assert.equal(bab.usage_count, 1);
  assert.equal(bab.original_legacy_label, "Babidge");
  assert.equal(bab.migration_batch_id, "SEED-DRYRUN-TEST");
});

test("approved filter keeps only Babidge and Kat and James Dykes", () => {
  const jobs = [
    { job_sheet_id: "j-bab", project_id: "Babidge", date: "2026-07-01" },
    {
      job_sheet_id: "21759f5d",
      project_id: "Kat and James Dykes",
      date: "2026-07-16",
    },
    { job_sheet_id: "extra", project_id: "Other Solo", date: "2026-07-20" },
    { job_sheet_id: "s1", project_id: "smith", date: "2026-07-02" },
    { job_sheet_id: "s2", project_id: "smith", date: "2026-07-08" },
  ];
  const report = build(jobs, [], []);
  assert.equal(report.safe_for_seed.length, 3); // Babidge, Kat, Other Solo
  const filtered = filterApproved(report, ["Babidge", "Kat and James Dykes"]);
  assert.equal(filtered.safe_for_seed.length, 2);
  const labels = filtered.safe_for_seed.map((r) => r.legacy_project_label);
  assert.ok(labels.includes("Babidge"));
  assert.ok(labels.includes("Kat and James Dykes"));
  assert.ok(!labels.includes("Other Solo"));
  assert.ok(!labels.includes("smith"));

  const manifest = buildManifest(report, {
    migration_batch_id: "SEED-APPROVED",
    approved_seed_labels: ["Babidge", "Kat and James Dykes"],
  });
  assert.equal(manifest.customers.length, 2);
  assert.ok(!manifest.customers.some((c) => c.customer_name === "Other Solo"));
});

test("pickWritableFields drops unknown columns", () => {
  const picked = pickFields(["customer_id", "customer_name"], {
    customer_id: "CUST-1",
    customer_name: "Babidge",
    source: "legacy_job_label",
    migration_batch_id: "X",
  });
  assert.equal(picked.customer_id, "CUST-1");
  assert.equal(picked.customer_name, "Babidge");
  assert.equal(picked.source, undefined);
  assert.equal(picked.migration_batch_id, undefined);
});

test("apply without APPLY stays dry-run and writes nothing", () => {
  const jobs = [
    { job_sheet_id: "j-bab", project_id: "Babidge", date: "2026-07-01" },
    {
      job_sheet_id: "21759f5d",
      project_id: "Kat and James Dykes",
      date: "2026-07-16",
    },
  ];
  const report = build(jobs, [], []);
  const manifest = buildManifest(report, {
    migration_batch_id: "SEED-GATE",
    approved_seed_labels: ["Babidge", "Kat and James Dykes"],
  });
  const result = applySeed(manifest, { confirm_apply: "" });
  assert.equal(result.dry_run, true);
  assert.equal(result.wrote, false);
  assert.equal(result.customers_written.length, 0);
  assert.equal(result.projects_written.length, 0);
  assert.ok(String(result.message).includes("Dry-run only"));
});

test("apply with APPLY writes via repositories and builds rollback", () => {
  const created = { customers: [], projects: [] };
  context.DB.getHeaders = (table) =>
    table === "tbl_customers"
      ? ["customer_id", "customer_name", "source", "migration_batch_id", "original_legacy_label"]
      : ["project_id", "project_name", "customer_id", "source", "migration_batch_id", "original_legacy_label"];
  context.CustomerRepository.findById = () => null;
  context.ProjectRepository.findById = () => null;
  context.CustomerRepository.create = (row) => {
    created.customers.push(row);
    return row;
  };
  context.ProjectRepository.create = (row) => {
    created.projects.push(row);
    return row;
  };

  const jobs = [
    { job_sheet_id: "j-bab", project_id: "Babidge", date: "2026-07-01" },
    {
      job_sheet_id: "21759f5d",
      project_id: "Kat and James Dykes",
      date: "2026-07-16",
    },
    { job_sheet_id: "s1", project_id: "smith", date: "2026-07-02" },
    { job_sheet_id: "s2", project_id: "smith", date: "2026-07-08" },
  ];
  const report = build(jobs, [], []);
  const manifest = buildManifest(report, {
    migration_batch_id: "SEED-APPLY-TEST",
    approved_seed_labels: ["Babidge", "Kat and James Dykes"],
  });
  const result = applySeed(manifest, { confirm_apply: "APPLY" });
  assert.equal(result.dry_run, false);
  assert.equal(result.wrote, true);
  assert.equal(created.customers.length, 2);
  assert.equal(created.projects.length, 2);
  assert.ok(!created.customers.some((c) => c.customer_name === "smith"));
  assert.equal(result.rollback_manifest.delete_customer_ids.length, 2);
  assert.equal(result.rollback_manifest.delete_project_ids.length, 2);
  assert.ok(
    String(result.rollback_manifest.note).includes("Do NOT modify tbl_job_sheets")
  );
});
