/**
 * Node tests for FieldOS recording media helpers.
 * Run: node --test fieldos/frontend/src/recordingMedia.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_RECORDING_BYTES,
  NO_AUDIO_MESSAGE,
  appendRecordingChunk,
  buildRecordingBlob,
  buildRecordingDiagnostics,
  stopRecorderAndBuildBlob,
  validateRecordingForUpload,
} from "./recordingMedia.js";

test("valid multi-chunk recording passes validation", () => {
  const chunks = [];
  const a = new Blob([new Uint8Array(700)], { type: "audio/webm" });
  const b = new Blob([new Uint8Array(700)], { type: "audio/webm" });
  const next = appendRecordingChunk(appendRecordingChunk(chunks, a), b);
  const blob = buildRecordingBlob(next, "audio/webm");
  const result = validateRecordingForUpload({
    blob,
    durationSeconds: 1.2,
    chunkCount: next.length,
  });
  assert.equal(result.ok, true);
  assert.ok(blob.size >= MIN_RECORDING_BYTES);
});

test("zero chunks rejected", () => {
  const blob = buildRecordingBlob([], "audio/webm");
  const result = validateRecordingForUpload({
    blob,
    durationSeconds: 2,
    chunkCount: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.message, NO_AUDIO_MESSAGE);
  assert.equal(result.reason, "no_chunks");
});

test("only zero-byte chunks are not appended", () => {
  let chunks = [];
  chunks = appendRecordingChunk(chunks, new Blob([]));
  chunks = appendRecordingChunk(chunks, { size: 0 });
  assert.equal(chunks.length, 0);
});

test("18-byte blob rejected", () => {
  const blob = new Blob([new Uint8Array(18)], { type: "audio/webm" });
  const result = validateRecordingForUpload({
    blob,
    durationSeconds: 1,
    chunkCount: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "blob_too_small");
  assert.equal(result.byteLength, 18);
  assert.equal(result.message, NO_AUDIO_MESSAGE);
});

test("chunks reset between recordings (caller clears array)", () => {
  let chunks = [new Blob([new Uint8Array(10)])];
  chunks = [];
  chunks = appendRecordingChunk(chunks, new Blob([new Uint8Array(20)]));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].size, 20);
});

test("upload waits for onstop via stopRecorderAndBuildBlob", async () => {
  const chunks = [];
  const recorder = {
    state: "recording",
    mimeType: "audio/webm",
    onstop: null,
    stop() {
      // Simulate final dataavailable then onstop
      chunks.push(new Blob([new Uint8Array(1200)], { type: "audio/webm" }));
      this.state = "inactive";
      if (typeof this.onstop === "function") this.onstop();
    },
  };
  const { blob, diagnostics } = await stopRecorderAndBuildBlob(recorder, {
    chunks,
    mimeType: "audio/webm",
  });
  assert.ok(blob.size >= 1200);
  assert.equal(diagnostics.chunkCount, 1);
  assert.equal(recorder.state, "inactive");
});

test("diagnostics omit audio content", () => {
  const diag = buildRecordingDiagnostics({
    selectedMimeType: "audio/webm",
    chunkCount: 2,
    chunkSizes: [100, 200],
    finalBlobSize: 300,
    durationSeconds: 1.5,
    mediaRecorderState: "inactive",
    audioTrackReadyState: "live",
    audioTrackMuted: false,
    audioTrackEnabled: true,
  });
  assert.equal(diag.chunkCount, 2);
  assert.deepEqual(diag.chunkSizes, [100, 200]);
  assert.equal(Object.prototype.hasOwnProperty.call(diag, "dataUrl"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(diag, "bytes"), false);
});
