/**
 * Node tests for FieldOSDisplayLookup pure helpers.
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

test("project found and customer found", () => {
  const maps = buildMaps(
    [{ project_id: "PROJ-1", project_name: "Roof", customer_id: "CUST-1" }],
    [{ customer_id: "CUST-1", customer_name: "Acme Homes" }]
  );
  const out = resolve("PROJ-1", maps.projectById, maps.customerById);
  assert.equal(out.project_name, "Roof");
  assert.equal(out.customer_name, "Acme Homes");
});

test("project found and customer missing", () => {
  const maps = buildMaps(
    [{ project_id: "PROJ-1", project_name: "Roof", customer_id: "CUST-MISSING" }],
    []
  );
  const out = resolve("PROJ-1", maps.projectById, maps.customerById);
  assert.equal(out.project_name, "Roof");
  assert.equal(out.customer_name, "");
});

test("project missing keeps raw project_id as project_name", () => {
  const maps = buildMaps([], []);
  const out = resolve("Kat and James Dykes", maps.projectById, maps.customerById);
  assert.equal(out.project_name, "Kat and James Dykes");
  assert.equal(out.customer_name, "");
});

test("blank project_id yields empty strings", () => {
  const maps = buildMaps(
    [{ project_id: "PROJ-1", project_name: "Roof", customer_id: "CUST-1" }],
    [{ customer_id: "CUST-1", customer_name: "Acme" }]
  );
  const out = resolve("  ", maps.projectById, maps.customerById);
  assert.equal(out.project_name, "");
  assert.equal(out.customer_name, "");
});
