/**
 * Node tests for audio file upload helpers.
 * Run: node --test fieldos/frontend/src/recordingFileUpload.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCEPT_ATTR,
  buildFilePreview,
  isProcessingStatus,
  safeUserError,
  validateSelectedAudioFile,
} from "./recordingFileUpload.js";

test("file picker accept attr lists supported formats", () => {
  assert.match(ACCEPT_ATTR, /\.webm/);
  assert.match(ACCEPT_ATTR, /\.mp3/);
  assert.match(ACCEPT_ATTR, /\.flac/);
});

test("unsupported format rejected", () => {
  const result = validateSelectedAudioFile({ name: "notes.txt", type: "text/plain", size: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported_format");
});

test("tiny file rejected", () => {
  const result = validateSelectedAudioFile({
    name: "tiny.webm",
    type: "audio/webm",
    size: 18,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too_small");
});

test("filename/size/MIME preview", () => {
  const file = { name: "site.wav", type: "audio/wav", size: 4096 };
  const validation = validateSelectedAudioFile(file);
  assert.equal(validation.ok, true);
  const preview = buildFilePreview(file, validation);
  assert.equal(preview.filename, "site.wav");
  assert.equal(preview.mimeType, "audio/wav");
  assert.equal(preview.ok, true);
  assert.match(preview.formattedSize, /KB|B/);
});

test("octet-stream with supported extension accepted", () => {
  const result = validateSelectedAudioFile({
    name: "clip.mp3",
    type: "application/octet-stream",
    size: 4096,
  });
  assert.equal(result.ok, true);
});

test("action buttons disabled while Processing", () => {
  assert.equal(isProcessingStatus("Processing"), true);
  assert.equal(isProcessingStatus("Completed"), false);
  assert.equal(isProcessingStatus("Queued"), false);
});

test("backend error shown safely", () => {
  assert.equal(
    safeUserError(new Error("Drive file id=abc webhook_secret=x")),
    "Something went wrong. Please try again."
  );
  assert.equal(safeUserError(new Error("Recording not found for this job.")), "Recording not found for this job.");
});

test("upload disabled / duplicate prevention helpers via validation ok gate", () => {
  const bad = validateSelectedAudioFile({ name: "x.webm", type: "audio/webm", size: 10 });
  assert.equal(bad.ok, false);
  const good = validateSelectedAudioFile({ name: "x.webm", type: "audio/webm", size: 2048 });
  assert.equal(good.ok, true);
});
