/**
 * Node tests for FieldOSDisplayLookup dual-read helpers.
 * Run: node --test apps-script/tests/display_lookup.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(
  path.join(__dirname, "..", "FieldOSDisplayLookup.js"),
  "utf8"
);
const context = { console };
vm.createContext(context);
vm.runInContext(src, context);

const resolve = context.fieldosResolveProjectCustomer_;
const buildMaps = context.fieldosBuildDisplayMaps_;
const normalize = context.fieldosNormalizeDisplayLabel_;

const liveProjects = [
  {
    project_id: "PROJ-8BC1502B",
    project_name: "Babidge",
    customer_id: "CUST-8BC1502B",
  },
  {
    project_id: "PROJ-6002C0A0",
    project_name: "Kat and James Dykes",
    customer_id: "CUST-6002C0A0",
  },
];
const liveCustomers = [
  { customer_id: "CUST-8BC1502B", customer_name: "Babidge" },
  { customer_id: "CUST-6002C0A0", customer_name: "Kat and James Dykes" },
];

test("exact project_id match with linked customer", () => {
  const maps = buildMaps(liveProjects, liveCustomers);
  const out = resolve("PROJ-6002C0A0", maps);
  assert.equal(out.project_name, "Kat and James Dykes");
  assert.equal(out.customer_name, "Kat and James Dykes");
  assert.equal(out.match, "project_id");
});

test("exact legacy project_name match (job 21759f5d)", () => {
  const maps = buildMaps(liveProjects, liveCustomers);
  const out = resolve("Kat and James Dykes", maps);
  assert.equal(out.project_name, "Kat and James Dykes");
  assert.equal(out.customer_name, "Kat and James Dykes");
  assert.equal(out.match, "project_name_exact");
});

test("exact legacy project_name match (job Babidge)", () => {
  const maps = buildMaps(liveProjects, liveCustomers);
  const out = resolve("Babidge", maps);
  assert.equal(out.project_name, "Babidge");
  assert.equal(out.customer_name, "Babidge");
  assert.equal(out.match, "project_name_exact");
});

test("normalised project_name match", () => {
  const maps = buildMaps(liveProjects, liveCustomers);
  const out = resolve("  kat   and james dykes. ", maps);
  assert.equal(normalize("  kat   and james dykes. "), "kat and james dykes");
  assert.equal(out.project_name, "Kat and James Dykes");
  assert.equal(out.customer_name, "Kat and James Dykes");
  assert.equal(out.match, "project_name_normalised");
});

test("linked customer resolution", () => {
  const maps = buildMaps(liveProjects, liveCustomers);
  const out = resolve("Babidge", maps);
  assert.equal(out.customer_name, "Babidge");
});

test("missing customer yields empty customer_name", () => {
  const maps = buildMaps(
    [{ project_id: "PROJ-1", project_name: "Solo", customer_id: "CUST-MISSING" }],
    []
  );
  const out = resolve("Solo", maps);
  assert.equal(out.project_name, "Solo");
  assert.equal(out.customer_name, "");
  assert.equal(out.match, "project_name_exact");
});

test("duplicate normalised names fall back safely with warning", () => {
  const maps = buildMaps(
    [
      { project_id: "PROJ-A", project_name: "Smith Co", customer_id: "CUST-1" },
      { project_id: "PROJ-B", project_name: "smith  co.", customer_id: "CUST-2" },
    ],
    [
      { customer_id: "CUST-1", customer_name: "One" },
      { customer_id: "CUST-2", customer_name: "Two" },
    ]
  );
  const out = resolve("Smith Co", maps);
  // exact name still unique for "Smith Co"
  assert.equal(out.match, "project_name_exact");
  assert.equal(out.customer_name, "One");

  const ambiguous = resolve("smith co", maps);
  assert.equal(ambiguous.project_name, "smith co");
  assert.equal(ambiguous.customer_name, "");
  assert.equal(ambiguous.match, "fallback");
  assert.ok(String(ambiguous.warning).includes("ambiguous_normalised_project_name"));
});

test("duplicate exact project_name falls back with warning", () => {
  const maps = buildMaps(
    [
      { project_id: "PROJ-A", project_name: "Dup", customer_id: "CUST-1" },
      { project_id: "PROJ-B", project_name: "Dup", customer_id: "CUST-2" },
    ],
    [
      { customer_id: "CUST-1", customer_name: "One" },
      { customer_id: "CUST-2", customer_name: "Two" },
    ]
  );
  const out = resolve("Dup", maps);
  assert.equal(out.project_name, "Dup");
  assert.equal(out.customer_name, "");
  assert.equal(out.match, "fallback");
  assert.ok(String(out.warning).includes("ambiguous_exact_project_name"));
});

test("unknown label fallback (smith)", () => {
  const maps = buildMaps(liveProjects, liveCustomers);
  const out = resolve("smith", maps);
  assert.equal(out.project_name, "smith");
  assert.equal(out.customer_name, "");
  assert.equal(out.match, "fallback");
});

test("blank label", () => {
  const maps = buildMaps(liveProjects, liveCustomers);
  const out = resolve("  ", maps);
  assert.equal(out.project_name, "");
  assert.equal(out.customer_name, "");
  assert.equal(out.match, "blank");
});

test("PK match takes precedence over display match", () => {
  const maps = buildMaps(
    [
      {
        project_id: "PROJ-LEGACY-NAME",
        project_name: "Other",
        customer_id: "CUST-1",
      },
      {
        project_id: "PROJ-2",
        project_name: "PROJ-LEGACY-NAME",
        customer_id: "CUST-2",
      },
    ],
    [
      { customer_id: "CUST-1", customer_name: "FromPk" },
      { customer_id: "CUST-2", customer_name: "FromName" },
    ]
  );
  const out = resolve("PROJ-LEGACY-NAME", maps);
  assert.equal(out.match, "project_id");
  assert.equal(out.project_name, "Other");
  assert.equal(out.customer_name, "FromPk");
});

// Load diagnostics for editor-only sample helper (depends on resolve/maps above).
const diagSrc = fs.readFileSync(
  path.join(__dirname, "..", "FieldOSDisplayDiagnostics.js"),
  "utf8"
);
vm.runInContext(diagSrc, context);
const buildSample = context.fieldosDiagBuildDisplayResolveSampleRows_;

test("editor-only display resolve sample reports sanitised fields only", () => {
  const maps = buildMaps(liveProjects, liveCustomers);
  const rows = buildSample(
    [
      { job_sheet_id: "21759f5d", project_id: "Kat and James Dykes" },
      { job_sheet_id: "9d395bbd", project_id: "Babidge" },
      { job_sheet_id: "e17cc590", project_id: "smith" },
      { job_sheet_id: "blank1", project_id: "" },
    ],
    maps
  );
  assert.equal(rows.length, 4);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "customer_name",
    "job_sheet_id",
    "match",
    "project_name",
    "raw_project_id",
  ]);
  assert.equal(rows[0].project_name, "Kat and James Dykes");
  assert.equal(rows[0].customer_name, "Kat and James Dykes");
  assert.equal(rows[1].project_name, "Babidge");
  assert.equal(rows[1].customer_name, "Babidge");
  assert.equal(rows[2].project_name, "smith");
  assert.equal(rows[2].customer_name, "");
  assert.equal(rows[3].project_name, "");
  assert.equal(rows[3].customer_name, "");
});
