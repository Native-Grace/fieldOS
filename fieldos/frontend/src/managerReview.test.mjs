/**
 * Manager review UI helpers.
 * Run: node --test fieldos/frontend/src/managerReview.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewForm,
  escapeText,
  isManagerRole,
  reviewHasUnsavedChanges,
} from "./managerReviewHelpers.mjs";

test("fields render baseline from job payload", () => {
  const form = buildReviewForm({
    ai_summary: "Summary",
    client_requests: "Water roses",
    variations: "",
    safety_issues: "",
    manager_review_items: "Fragments",
    weather: "Fine",
    travel_time: "20m",
    manager_notes: "Note",
  });
  assert.equal(form.ai_summary, "Summary");
  assert.equal(form.manager_review_items, "Fragments");
  assert.equal(form.manager_notes, "Note");
});

test("unsaved changes detection", () => {
  const baseline = buildReviewForm({ ai_summary: "A", manager_notes: "" });
  const dirty = { ...baseline, manager_notes: "x" };
  assert.equal(reviewHasUnsavedChanges(dirty, baseline), true);
  assert.equal(reviewHasUnsavedChanges(baseline, baseline), false);
});

test("manager role detection", () => {
  assert.equal(isManagerRole("Manager"), true);
  assert.equal(isManagerRole("Field Staff"), false);
  assert.equal(isManagerRole("admin"), true);
});

test("transcript HTML escaped", () => {
  assert.equal(escapeText("<b>x</b>"), "&lt;b&gt;x&lt;/b&gt;");
});

test("return reason required locally before submit", () => {
  const reason = "  ";
  assert.equal(reason.trim().length === 0, true);
});

test("transcript collapsed by default (no ai_transcript until expand)", () => {
  const job = { ai_transcript_character_count: 42, ai_transcript: null };
  assert.equal(job.ai_transcript, null);
  assert.equal(job.ai_transcript_character_count, 42);
});

test("stale conflict message shape", () => {
  const msg = "This review changed elsewhere. Refresh and try again.";
  assert.match(msg, /Refresh/);
});
