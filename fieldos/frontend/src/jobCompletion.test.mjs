/**
 * Phase 3C frontend helper tests.
 * Run: node --test fieldos/frontend/src/jobCompletion.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompletionForm,
  canFinaliseClient,
  completionHasUnsavedChanges,
  displayLabourHours,
  emptyLabourRow,
  isMobileFriendlyTableLayout,
  ROW_CONFIRMATION,
} from "./jobCompletionHelpers.mjs";

test("completion panel form builds and detects unsaved changes", () => {
  const form = buildCompletionForm({
    completion: { work_summary: "Planted trees", invoice_description: "Seven trees" },
    labour_entries: [emptyLabourRow()],
  });
  assert.equal(form.work_summary, "Planted trees");
  const dirty = completionHasUnsavedChanges(
    { ...form, work_summary: "Changed" },
    form
  );
  assert.equal(dirty, true);
});

test("derived hours display and finalise gate", () => {
  assert.equal(
    displayLabourHours({ start_time: "08:00", finish_time: "12:00", break_minutes: 30 }),
    3.5
  );
  const incomplete = {
    work_summary: "x",
    invoice_description: "y",
    labour_entries: [
      {
        start_time: "08:00",
        finish_time: "12:00",
        confirmation_status: ROW_CONFIRMATION.SUGGESTED,
      },
    ],
    machinery_entries: [],
    material_entries: [],
  };
  assert.equal(canFinaliseClient(incomplete), false);
  incomplete.labour_entries[0].confirmation_status = ROW_CONFIRMATION.CONFIRMED;
  assert.equal(canFinaliseClient(incomplete), true);
});

test("mobile-friendly layout helper", () => {
  assert.equal(isMobileFriendlyTableLayout(375), true);
  assert.equal(isMobileFriendlyTableLayout(900), false);
});

test("billable confirmation defaults suggested", () => {
  const row = emptyLabourRow();
  assert.equal(row.billable, false);
  assert.equal(row.confirmation_status, ROW_CONFIRMATION.SUGGESTED);
});

test("completion form builds safely from null/failed payload (panel stays resilient)", () => {
  // If the separate completion request is slow or fails, core detail must still render.
  const empty = buildCompletionForm(undefined);
  assert.equal(empty.work_summary, "");
  assert.deepEqual(empty.labour_entries, []);
  assert.deepEqual(empty.machinery_entries, []);
  assert.deepEqual(empty.material_entries, []);
  const partial = buildCompletionForm({ completion: null });
  assert.equal(partial.invoice_description, "");
});
