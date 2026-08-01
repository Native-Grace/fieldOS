/**
 * Create Job from Recording — wizard helpers + UI wiring tests.
 * Run: node --test fieldos/frontend/src/newJobFromRecordingHelpers.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AUDIO_FILE_ACCEPT,
  DEFAULT_MAX_UPLOAD_MB,
  SOURCE_BROWSER_RECORDING,
  SOURCE_UPLOADED_FILE,
  canShowNewJobFromRecording,
  confidenceTone,
  formatByteSize,
  makeIdempotencyKey,
  matchStatusLabel,
  reviewedJobFromExtraction,
  validateAudioFileForUpload,
  validateReviewedJobLocally,
} from "./newJobFromRecordingHelpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fakeFile({ name, size, type }) {
  return { name, size, type };
}

test("button visible for manager/admin only", () => {
  assert.equal(canShowNewJobFromRecording("manager"), true);
  assert.equal(canShowNewJobFromRecording("Admin"), true);
  assert.equal(canShowNewJobFromRecording("Field Staff"), false);
  assert.equal(canShowNewJobFromRecording("staff"), false);
});

test("validation requires customer project date staff title", () => {
  const bad = validateReviewedJobLocally({});
  assert.equal(bad.ok, false);
  const ok = validateReviewedJobLocally({
    customer_name: "Kat and James Dykes",
    project_name: "Kat and James Dykes",
    job_title: "Inspect beds",
    scheduled_date: "2026-08-04",
    assigned_staff_ids: ["STAFF-DEMO001"],
  });
  assert.equal(ok.ok, true);
});

test("review form populated from extraction without auto-selecting fuzzy", () => {
  const job = reviewedJobFromExtraction(
    {
      job: {
        customer_name: "Kat and James Dykes",
        project_name: "Kat and James Dykes",
        job_title: "Inspect",
        job_description: "beds",
        scheduled_date: "2026-08-04",
        assigned_staff_names: ["Alex"],
        notes: "irrigation",
      },
    },
    {
      customer: {
        status: "Matched",
        matched_id: "CUST-1",
        matched_name: "Kat and James Dykes",
      },
      project: { status: "Possible match", matched_id: "", possible_matches: [{ id: "P1" }] },
      staff: [{ status: "Matched", matched_id: "STAFF-DEMO001", matched_name: "Alex" }],
    }
  );
  assert.equal(job.customer_id, "CUST-1");
  assert.equal(job.project_id, "");
  assert.deepEqual(job.assigned_staff_ids, ["STAFF-DEMO001"]);
});

test("match labels and confidence tones", () => {
  assert.equal(matchStatusLabel("Matched"), "Matched");
  assert.equal(matchStatusLabel("Possible match"), "Possible match");
  assert.equal(confidenceTone(0.9), "high");
  assert.equal(confidenceTone(0.2), "low");
});

test("idempotency key unique per call", () => {
  const a = makeIdempotencyKey("NJR-1");
  const b = makeIdempotencyKey("NJR-1");
  assert.notEqual(a, b);
  assert.match(a, /^njr-NJR-1-/);
});

test("file input accept includes supported audio", () => {
  assert.match(AUDIO_FILE_ACCEPT, /audio\/\*/);
  assert.match(AUDIO_FILE_ACCEPT, /\.mp3/);
  assert.match(AUDIO_FILE_ACCEPT, /\.m4a/);
  assert.match(AUDIO_FILE_ACCEPT, /\.wav/);
  assert.match(AUDIO_FILE_ACCEPT, /\.webm/);
  assert.match(AUDIO_FILE_ACCEPT, /\.ogg/);
  assert.match(AUDIO_FILE_ACCEPT, /\.mp4/);
});

test("selected valid file passes validation", () => {
  const ok = validateAudioFileForUpload(
    fakeFile({ name: "site.m4a", size: 50_000, type: "audio/mp4" }),
    { maxUploadMb: DEFAULT_MAX_UPLOAD_MB }
  );
  assert.equal(ok.ok, true);
});

test("oversized file rejected", () => {
  const tooBig = (DEFAULT_MAX_UPLOAD_MB + 1) * 1024 * 1024;
  const bad = validateAudioFileForUpload(
    fakeFile({ name: "huge.webm", size: tooBig, type: "audio/webm" }),
    { maxUploadMb: DEFAULT_MAX_UPLOAD_MB }
  );
  assert.equal(bad.ok, false);
  assert.match(bad.error, /too large/i);
});

test("unsupported file rejected", () => {
  const bad = validateAudioFileForUpload(
    fakeFile({ name: "notes.txt", size: 5000, type: "text/plain" }),
    { maxUploadMb: DEFAULT_MAX_UPLOAD_MB }
  );
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unsupported/i);
});

test("empty file rejected", () => {
  const bad = validateAudioFileForUpload(
    fakeFile({ name: "empty.webm", size: 0, type: "audio/webm" })
  );
  assert.equal(bad.ok, false);
  assert.match(bad.error, /empty/i);
});

test("formatByteSize readable", () => {
  assert.equal(formatByteSize(500), "500 B");
  assert.match(formatByteSize(2048), /KB/);
});

test("JobsPage wires New Job from Recording for managers", () => {
  const page = fs.readFileSync(path.join(__dirname, "pages", "JobsPage.jsx"), "utf8");
  assert.match(page, /New Job from Recording/);
  assert.match(page, /canShowNewJobFromRecording|manager/);
  assert.match(page, /new-from-recording/);
});

test("wizard shows upload button, file input, playback, replace/remove", () => {
  const page = fs.readFileSync(
    path.join(__dirname, "pages", "NewJobFromRecordingPage.jsx"),
    "utf8"
  );
  assert.match(page, /Choose audio file/);
  assert.match(page, /Record audio/);
  assert.match(page, /data-testid="choose-audio-file-btn"/);
  assert.match(page, /data-testid="audio-file-input"/);
  assert.match(page, /data-testid="selected-file-meta"/);
  assert.match(page, /data-testid="audio-playback"/);
  assert.match(page, /data-testid="replace-audio-btn"/);
  assert.match(page, /data-testid="remove-audio-btn"/);
  assert.match(page, /AUDIO_FILE_ACCEPT/);
  assert.match(page, /accept=\{AUDIO_FILE_ACCEPT\}/);
  assert.match(page, /className="btn/);
  // Step-1 actions must use design-system .btn (not unstyled .button)
  assert.match(page, /data-testid="record-audio-btn"[\s\S]*?className="btn btn-primary"/);
  assert.match(page, /Choose audio file[\s\S]*?btn btn-ghost/);
});

test("upload sends multipart with source metadata; File kept in ref", () => {
  const page = fs.readFileSync(
    path.join(__dirname, "pages", "NewJobFromRecordingPage.jsx"),
    "utf8"
  );
  assert.match(page, /uploadForm\("\/jobs\/from-recording\/uploads"/);
  assert.match(page, /formData\.append\("file"/);
  assert.match(page, /formData\.append\(\s*"source"/);
  assert.match(page, /SOURCE_UPLOADED_FILE/);
  assert.match(page, /SOURCE_BROWSER_RECORDING/);
  assert.match(page, /audioRef\.current/);
  assert.ok(!/btoa|base64|readAsDataURL/.test(page));
});

test("wizard never auto-creates job; microphone flow still present", () => {
  const page = fs.readFileSync(
    path.join(__dirname, "pages", "NewJobFromRecordingPage.jsx"),
    "utf8"
  );
  assert.match(page, /Create Job/);
  assert.match(page, /confirmCreate/);
  assert.match(page, /idempotency_key/);
  assert.match(page, /MediaRecorder|startRecording/);
  assert.match(page, /Record audio/);
  assert.ok(!/autoCreate|automatically create/i.test(page));
});

test("source constants exported", () => {
  assert.equal(SOURCE_UPLOADED_FILE, "uploaded_file");
  assert.equal(SOURCE_BROWSER_RECORDING, "browser_recording");
});
