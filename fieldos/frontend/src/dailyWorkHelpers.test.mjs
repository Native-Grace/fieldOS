/**
 * Daily Work Job Sheet — helpers + UI wiring tests.
 * Run: node --test fieldos/frontend/src/dailyWorkHelpers.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canShowDailyWorkJobSheet,
  formatManagerNotesPreview,
  makeIdempotencyKey,
  moveItemBetweenLists,
  sessionStorageKey,
  validateReviewedJobSheetLocally,
} from "./dailyWorkHelpers.mjs";
import { canShowNewJobFromRecording } from "./newJobFromRecordingHelpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("canShowDailyWorkJobSheet for staff manager admin", () => {
  assert.equal(canShowDailyWorkJobSheet("staff"), true);
  assert.equal(canShowDailyWorkJobSheet("Field Staff"), true);
  assert.equal(canShowDailyWorkJobSheet("manager"), true);
  assert.equal(canShowDailyWorkJobSheet("Admin"), true);
  assert.equal(canShowDailyWorkJobSheet(""), false);
});

test("New Job from Recording workflow still exists for managers", () => {
  assert.equal(canShowNewJobFromRecording("manager"), true);
  assert.equal(canShowNewJobFromRecording("staff"), false);
  const app = fs.readFileSync(path.join(__dirname, "App.jsx"), "utf8");
  assert.match(app, /new-from-recording/);
  assert.match(app, /NewJobFromRecordingPage/);
  const page = fs.readFileSync(path.join(__dirname, "pages", "JobsPage.jsx"), "utf8");
  assert.match(page, /New Job from Recording/);
  assert.match(page, /canShowNewJobFromRecording/);
});

test("Daily Work route and buttons wired in App and JobsPage", () => {
  const app = fs.readFileSync(path.join(__dirname, "App.jsx"), "utf8");
  assert.match(app, /\/jobs\/daily-work/);
  assert.match(app, /DailyWorkJobSheetPage/);
  const page = fs.readFileSync(path.join(__dirname, "pages", "JobsPage.jsx"), "utf8");
  assert.match(page, /daily-work/);
  assert.match(page, /Record Today/);
});

test("move completed item to follow_up_required", () => {
  const job = {
    work_completed: [{ text: "Pruned hedges", recording_ids: ["R1"] }],
    follow_up_required: [],
  };
  const moved = moveItemBetweenLists(job, "work_completed", "follow_up_required", 0);
  assert.equal(moved.work_completed.length, 0);
  assert.equal(moved.follow_up_required.length, 1);
  assert.equal(moved.follow_up_required[0].text, "Pruned hedges");
});

test("formatManagerNotesPreview is deterministic", () => {
  const job = {
    work_completed: [{ text: "Weeded beds" }],
    materials_used: [{ text: "Mulch 2 bags" }],
    completion_summary: "Front garden tidy.",
  };
  const a = formatManagerNotesPreview(job);
  const b = formatManagerNotesPreview(job);
  assert.equal(a, b);
  assert.match(a, /WORK COMPLETED/);
  assert.match(a, /- Weeded beds/);
  assert.match(a, /MATERIALS USED/);
  assert.match(a, /SUMMARY/);
});

test("validateReviewedJobSheetLocally requires work_completed or summary", () => {
  const bad = validateReviewedJobSheetLocally({
    customer_name: "Kat",
    project_name: "Kat",
    work_date: "2026-08-01",
    staff_ids: ["STAFF-1"],
    work_completed: [],
    completion_summary: "",
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /work_completed|completion summary/i);

  const ok = validateReviewedJobSheetLocally({
    customer_name: "Kat",
    project_name: "Kat",
    work_date: "2026-08-01",
    staff_ids: ["STAFF-1"],
    work_completed: [{ text: "Mowed lawn" }],
  });
  assert.equal(ok.ok, true);
});

test("NewJobFromRecordingPage remains separate from Daily Work", () => {
  const njr = fs.readFileSync(
    path.join(__dirname, "pages", "NewJobFromRecordingPage.jsx"),
    "utf8"
  );
  const dw = fs.readFileSync(
    path.join(__dirname, "pages", "DailyWorkJobSheetPage.jsx"),
    "utf8"
  );
  assert.match(njr, /New Job from Recording/);
  assert.match(njr, /from-recording/);
  assert.doesNotMatch(njr, /daily-work-sessions/);
  assert.match(dw, /Daily Work/);
  assert.match(dw, /daily-work-sessions/);
  assert.doesNotMatch(dw, /from-recording\/uploads/);
});

test("idempotency key uses dw prefix", () => {
  const a = makeIdempotencyKey("DW-1");
  const b = makeIdempotencyKey("DW-1");
  assert.notEqual(a, b);
  assert.match(a, /^dw-DW-1-/);
});

test("sessionStorageKey is stable per session", () => {
  assert.equal(sessionStorageKey("DW-ABC"), "fieldos_daily_work_session_DW-ABC");
});
