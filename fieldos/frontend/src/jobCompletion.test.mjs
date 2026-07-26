/**
 * Phase 3C frontend helper tests.
 * Run: node --test fieldos/frontend/src/jobCompletion.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompletionForm,
  canFinaliseClient,
  collectLabourValidationMessages,
  completionHasUnsavedChanges,
  describeClockTime,
  displayLabourHours,
  emptyLabourRow,
  isBreakWarningResolved,
  isMobileFriendlyTableLayout,
  labourFieldErrors,
  needsOverrideReason,
  normaliseClockTime,
  ROW_CONFIRMATION,
  upsertBreakWarningResolution,
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
    warnings: [],
    warning_resolutions: [],
    labour_entries: [
      {
        start_time: "08:00",
        finish_time: "12:00",
        break_minutes: 0,
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

test("blank times produce required field errors only", () => {
  const errors = labourFieldErrors({
    start_time: "",
    finish_time: "",
    break_minutes: 0,
    confirmation_status: ROW_CONFIRMATION.CONFIRMED,
  });
  assert.equal(errors.start_time, "Start time is required.");
  assert.equal(errors.finish_time, "Finish time is required.");
  assert.equal(errors.break_minutes, undefined);
  assert.ok(!Object.values(errors).some((m) => /HH:MM/i.test(m)));
});

test("malformed non-empty times produce Use HH:MM only", () => {
  const errors = labourFieldErrors({
    start_time: "25:99",
    finish_time: "noon",
    break_minutes: 0,
    confirmation_status: ROW_CONFIRMATION.CONFIRMED,
  });
  assert.equal(errors.start_time, "Use HH:MM.");
  assert.equal(errors.finish_time, "Use HH:MM.");
  assert.ok(!Object.values(errors).some((m) => /required/i.test(m)));
});

test("validation messages are unique per field rule", () => {
  const messages = collectLabourValidationMessages({
    labour_entries: [
      {
        start_time: "",
        finish_time: "",
        break_minutes: 0,
        confirmation_status: ROW_CONFIRMATION.SUGGESTED,
      },
    ],
  });
  assert.equal(new Set(messages).size, messages.length);
  assert.equal(messages.filter((m) => /Start time is required/.test(m)).length, 1);
  assert.equal(messages.filter((m) => /Finish time is required/.test(m)).length, 1);
});

test("resolved lunch contradiction allows client finalise; unresolved blocks", () => {
  const lunch =
    "Contradictory lunch information in source text — confirm unpaid break manually.";
  const base = {
    work_summary: "x",
    invoice_description: "y",
    warnings: [lunch],
    warning_resolutions: [],
    labour_entries: [
      {
        start_time: "07:00",
        finish_time: "15:00",
        break_minutes: 30,
        confirmation_status: ROW_CONFIRMATION.CONFIRMED,
      },
    ],
    machinery_entries: [],
    material_entries: [],
  };
  assert.equal(canFinaliseClient(base), false);
  const resolved = {
    ...base,
    warning_resolutions: upsertBreakWarningResolution([], lunch, {
      breakMinutes: 30,
      resolutionNote: "Confirmed",
    }),
  };
  assert.equal(isBreakWarningResolved(resolved.warning_resolutions, lunch), true);
  assert.equal(canFinaliseClient(resolved), true);
});

test("override reason still required for non-critical ack warnings", () => {
  const form = {
    warnings: ["Incomplete sentence fragments flagged in manager review items."],
    warning_resolutions: [],
  };
  assert.equal(needsOverrideReason(form), true);
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
  assert.deepEqual(empty.warning_resolutions, []);
  const partial = buildCompletionForm({ completion: null });
  assert.equal(partial.invoice_description, "");
});

test("clock normaliser and form coerce ISO/Date/fraction to HH:MM for time inputs", () => {
  assert.equal(normaliseClockTime("07:00"), "07:00");
  assert.equal(normaliseClockTime("7:00"), "07:00");
  assert.equal(normaliseClockTime(7 / 24), "07:00");
  assert.equal(normaliseClockTime("7"), null);
  assert.equal(normaliseClockTime("morning"), null);
  assert.equal(normaliseClockTime("7ish"), null);
  assert.equal(normaliseClockTime("7am to 5pm"), null);

  const iso = "2026-07-25T21:00:00.000Z"; // 07:00 Australia/Sydney AEST
  assert.equal(normaliseClockTime(iso), "07:00");
  assert.equal(describeClockTime(iso).type, "string");
  assert.equal(describeClockTime(iso).normalised, "07:00");

  const form = buildCompletionForm({
    completion: { work_summary: "x", invoice_description: "y" },
    labour_entries: [
      {
        start_time: "1899-12-30T07:00:00+10:00",
        finish_time: 15 / 24,
        break_minutes: 0,
        confirmation_status: ROW_CONFIRMATION.CONFIRMED,
      },
    ],
  });
  assert.equal(form.labour_entries[0].start_time, "07:00");
  assert.equal(form.labour_entries[0].finish_time, "15:00");
});
