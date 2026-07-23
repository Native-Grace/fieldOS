/**
 * Node tests for VoiceProcessing.executePipeline + OpenAI Whisper path.
 * Run: node --test apps-script/tests/voice_processing.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vpSrc = fs.readFileSync(
  path.join(__dirname, "..", "VoiceProcessing.js"),
  "utf8"
);
const openaiSrc = fs.readFileSync(path.join(__dirname, "..", "OpenAI.js"), "utf8");

function makeBlob({ name = "", contentType = "", bytes = [1, 2, 3] } = {}) {
  let _name = name;
  let _type = contentType;
  let _bytes = bytes.slice();
  return {
    getName: function () {
      return _name;
    },
    getContentType: function () {
      return _type;
    },
    getBytes: function () {
      return _bytes;
    },
    copyBlob: function () {
      return makeBlob({ name: _name, contentType: _type, bytes: _bytes });
    },
    setName: function (n) {
      _name = n;
    },
    setContentType: function (t) {
      _type = t;
    },
  };
}

function loadContext(overrides = {}) {
  const updates = [];
  const openaiCalls = [];
  const fetchCalls = [];
  const context = {
    console,
    Logger: { log: function () {} },
    Config: {
      QUEUE_STATUS: {
        QUEUED: "Queued",
        PROCESSING: "Processing",
        COMPLETED: "Completed",
        FAILED: "Failed",
      },
    },
    JobSheetRepository: {
      update: function (id, patch) {
        updates.push({ id, patch });
      },
    },
    PropertiesService: {
      getScriptProperties: function () {
        return {
          getProperty: function (key) {
            if (key === "OPENAI_API_KEY") return "sk-test-key-not-real";
            return null;
          },
        };
      },
    },
    UrlFetchApp: {
      fetch: function (url, options) {
        fetchCalls.push({ url: url, options: options });
        throw new Error("UrlFetchApp should not be called in unit tests");
      },
    },
    ...overrides,
  };
  context.__updates = updates;
  context.__openaiCalls = openaiCalls;
  context.__fetchCalls = fetchCalls;
  if (!overrides.OpenAI) {
    context.OpenAI = {
      getApiKey: function () {
        return "sk-test-key-not-real";
      },
      transcribeAudio: function (audioBlob) {
        const apiKey = this.getApiKey();
        if (!apiKey) {
          throw new Error("OpenAI API key is missing from Script Properties.");
        }
        openaiCalls.push({
          name: audioBlob.getName(),
          contentType: audioBlob.getContentType(),
          byteLength: audioBlob.getBytes().length,
          blob: audioBlob,
        });
        return "whisper:" + (audioBlob.getName() || "blob");
      },
      chatComplete: function () {
        throw new Error("chatComplete must not be called in this pass");
      },
    };
  }
  vm.createContext(context);
  vm.runInContext(vpSrc, context);
  return context;
}

test("executePipeline extracts job_sheet_id and returns transcript", () => {
  const ctx = loadContext();
  ctx.VoiceProcessingService.processJobSheetRecordings = function (id) {
    assert.equal(id, "21759f5d");
    return "hello transcript";
  };
  const out = ctx.VoiceProcessing.executePipeline({ job_sheet_id: "21759f5d" });
  assert.equal(out, "hello transcript");
});

test("missing job_sheet_id throws", () => {
  const ctx = loadContext();
  assert.throws(
    () => ctx.VoiceProcessing.executePipeline({}),
    /job_sheet_id is required/
  );
  assert.throws(
    () => ctx.VoiceProcessing.executePipeline(null),
    /job row object/
  );
});

test("transcript alias helpers and completed skip", () => {
  const ctx = loadContext();
  assert.equal(
    ctx.fieldosVpGetTranscriptText_({ transcript: " from fieldos " }),
    "from fieldos"
  );
  assert.equal(
    ctx.fieldosVpGetTranscriptText_({ transcription: " legacy " }),
    "legacy"
  );
  assert.equal(
    ctx.fieldosVpIsRecordingComplete_({
      status: "Processed",
      transcript: "done",
    }),
    true
  );
  assert.equal(
    ctx.fieldosVpIsRecordingComplete_({ status: "Saved", transcript: "x" }),
    false
  );
});

test("Drive resolution prefers recording_drive_file_id; legacy filename remains", () => {
  const ctx = loadContext();
  const plan = ctx.fieldosVpPickDriveResolvePlan_({
    recording_drive_file_id: "drive-file-1",
    audio_file: "legacy.webm",
  });
  assert.equal(plan.mode, "drive_id");
  assert.equal(plan.value, "drive-file-1");
  const legacy = ctx.fieldosVpPickDriveResolvePlan_({ audio_file: "clip.webm" });
  assert.equal(legacy.mode, "filename");
  assert.equal(legacy.value, "clip.webm");
});

test("recording order preserved when aggregating", () => {
  const ctx = loadContext();
  const sorted = ctx.fieldosVpSortRecordingsByOrder_([
    { recording_id: "REC-B", recording_order: 2 },
    { recording_id: "REC-A", recording_order: 1 },
    { recording_id: "REC-C", recording_order: 3 },
  ]);
  assert.equal(sorted[0].recording_id, "REC-A");
  assert.equal(sorted[1].recording_id, "REC-B");
  assert.equal(sorted[2].recording_id, "REC-C");
});

test("OpenAI path: Drive Blob passed; writeback; order; no Gemini", () => {
  const ctx = loadContext();
  const writebacks = [];
  ctx.VoiceProcessingService._getSpreadsheet = function () {
    return {};
  };
  ctx.VoiceProcessingService._getRecords = function () {
    return [
      {
        job_sheet_id: "21759f5d",
        recording_id: "REC-2",
        recording_order: 2,
        recording_drive_file_id: "fid-2",
        status: "Saved",
        transcript: "",
        _sheetRowIndex: 3,
      },
      {
        job_sheet_id: "21759f5d",
        recording_id: "REC-1",
        recording_order: 1,
        recording_drive_file_id: "fid-1",
        status: "Saved",
        transcript: "",
        _sheetRowIndex: 2,
      },
    ];
  };
  ctx.VoiceProcessingService._resolveRecordingDriveFile = function (rec) {
    return {
      getName: function () {
        return rec.recording_name || rec.recording_id + ".bin";
      },
      getBlob: function () {
        return makeBlob({
          name: rec.recording_id,
          contentType: "audio/webm",
          bytes: [1, 2, 3, 4],
        });
      },
    };
  };
  ctx.VoiceProcessingService._updateRowValue = function (ss, table, row, vals) {
    writebacks.push({ row: row, vals: vals, table: table });
  };

  const out = ctx.VoiceProcessingService.processJobSheetRecordings("21759f5d");
  assert.match(out, /whisper:recording-REC-1\.webm/);
  assert.match(out, /whisper:recording-REC-2\.webm/);
  assert.ok(out.indexOf("REC-1") < out.indexOf("REC-2"));
  assert.equal(ctx.__openaiCalls.length, 2);
  assert.equal(ctx.__openaiCalls[0].name, "recording-REC-1.webm");
  assert.equal(ctx.__openaiCalls[0].contentType, "audio/webm");
  assert.equal(ctx.__openaiCalls[1].name, "recording-REC-2.webm");
  assert.equal(writebacks.length, 2);
  assert.equal(writebacks[0].vals.status, "Processed");
  assert.equal(writebacks[0].vals.transcript, "whisper:recording-REC-1.webm");
  assert.equal(writebacks[0].vals.transcription, "whisper:recording-REC-1.webm");
  assert.doesNotMatch(vpSrc, /GEMINI_API_KEY|generativelanguage|gemini-1\.5/i);
});

test("completed recordings remain idempotently skipped", () => {
  const ctx = loadContext();
  ctx.VoiceProcessingService._getSpreadsheet = function () {
    return {};
  };
  ctx.VoiceProcessingService._getRecords = function () {
    return [
      {
        job_sheet_id: "21759f5d",
        recording_id: "REC-DONE",
        recording_order: 1,
        status: "Processed",
        transcript: "already done",
        _sheetRowIndex: 2,
      },
    ];
  };
  const out = ctx.VoiceProcessingService.processJobSheetRecordings("21759f5d");
  assert.equal(out, "already done");
  assert.equal(ctx.__openaiCalls.length, 0);
});

test("Invalid recordings are skipped without OpenAI calls", () => {
  const ctx = loadContext();
  ctx.VoiceProcessingService._getSpreadsheet = function () {
    return {};
  };
  ctx.VoiceProcessingService._getRecords = function () {
    return [
      {
        job_sheet_id: "21759f5d",
        recording_id: "REC-819FC620",
        recording_order: 1,
        recording_drive_file_id: "fid-bad",
        status: "Invalid",
        _sheetRowIndex: 2,
      },
      {
        job_sheet_id: "21759f5d",
        recording_id: "REC-OK",
        recording_order: 2,
        recording_drive_file_id: "fid-ok",
        status: "Saved",
        _sheetRowIndex: 3,
      },
    ];
  };
  ctx.VoiceProcessingService._resolveRecordingDriveFile = function (recording) {
    assert.notEqual(recording.recording_id, "REC-819FC620");
    return {
      getName: function () {
        return "ok.webm";
      },
      getBlob: function () {
        return makeBlob({
          name: "ok.webm",
          contentType: "audio/webm",
          bytes: [1, 2, 3, 4],
        });
      },
    };
  };
  const writebacks = [];
  ctx.VoiceProcessingService._updateRowValue = function (ss, table, row, vals) {
    writebacks.push({ row, vals });
  };

  const out = ctx.VoiceProcessingService.processJobSheetRecordings("21759f5d");
  assert.equal(out, "whisper:ok.webm");
  assert.equal(ctx.__openaiCalls.length, 1);
  assert.equal(writebacks.length, 1);
  assert.equal(writebacks[0].vals.status, "Processed");
});

test("per-recording failure identifies recording_id and rethrows", () => {
  const ctx = loadContext();
  ctx.VoiceProcessingService._getSpreadsheet = function () {
    return {};
  };
  ctx.VoiceProcessingService._getRecords = function () {
    return [
      {
        job_sheet_id: "21759f5d",
        recording_id: "REC-FAIL",
        recording_order: 1,
        recording_drive_file_id: "fid",
        status: "Saved",
        _sheetRowIndex: 2,
      },
    ];
  };
  ctx.VoiceProcessingService._resolveRecordingDriveFile = function () {
    return {
      getName: function () {
        return "x";
      },
      getBlob: function () {
        return makeBlob({
          name: "x",
          contentType: "audio/webm",
          bytes: [1],
        });
      },
    };
  };
  ctx.OpenAI.transcribeAudio = function () {
    throw new Error("Whisper API Error (500): boom");
  };
  ctx.VoiceProcessingService._updateRowValue = function () {};

  assert.throws(
    () => ctx.VoiceProcessingService.processJobSheetRecordings("21759f5d"),
    /recording_id=REC-FAIL/
  );
  assert.throws(
    () =>
      ctx.VoiceProcessing.executePipeline({ job_sheet_id: "21759f5d" }),
    /recording_id=REC-FAIL/
  );
  assert.equal(ctx.__updates.length, 0);
});

test("missing OpenAI API key fails clearly", () => {
  const ctx = loadContext({
    PropertiesService: {
      getScriptProperties: function () {
        return { getProperty: function () { return null; } };
      },
    },
  });
  // Rebind OpenAI mock to use empty key from PropertiesService
  ctx.OpenAI = {
    getApiKey: function () {
      return null;
    },
    transcribeAudio: function (audioBlob) {
      const apiKey = this.getApiKey();
      if (!apiKey) {
        throw new Error("OpenAI API key is missing from Script Properties.");
      }
      return "x";
    },
  };
  ctx.VoiceProcessingService._getSpreadsheet = function () {
    return {};
  };
  ctx.VoiceProcessingService._getRecords = function () {
    return [
      {
        job_sheet_id: "21759f5d",
        recording_id: "REC-1",
        recording_order: 1,
        recording_drive_file_id: "fid",
        status: "Saved",
        _sheetRowIndex: 2,
      },
    ];
  };
  ctx.VoiceProcessingService._resolveRecordingDriveFile = function () {
    return {
      getName: function () {
        return "x.bin";
      },
      getBlob: function () {
        return makeBlob({ name: "x", contentType: "audio/webm", bytes: [1] });
      },
    };
  };
  ctx.VoiceProcessingService._updateRowValue = function () {};

  assert.throws(
    () => ctx.VoiceProcessingService.processJobSheetRecordings("21759f5d"),
    /OpenAI API key is missing/
  );
});

test("Gemini is not called; chatComplete not wired into pipeline", () => {
  assert.doesNotMatch(vpSrc, /GEMINI_API_KEY/);
  assert.doesNotMatch(vpSrc, /generativelanguage\.googleapis/);
  assert.doesNotMatch(vpSrc, /gemini-1\.5/i);
  assert.match(vpSrc, /OpenAI\.transcribeAudio/);
  assert.doesNotMatch(vpSrc, /OpenAI\.chatComplete/);
});

test("NO_RECORDINGS and empty results fail; success marks Completed", () => {
  const ctx = loadContext();
  ctx.VoiceProcessingService.processJobSheetRecordings = function () {
    return "NO_RECORDINGS";
  };
  assert.throws(
    () => ctx.VoiceProcessing.executePipeline({ job_sheet_id: "21759f5d" }),
    /no transcript aggregated/
  );
  ctx.VoiceProcessingService.processJobSheetRecordings = function () {
    return "ok body";
  };
  ctx.VoiceProcessing.executePipeline({ job_sheet_id: "21759f5d" });
  assert.equal(ctx.__updates[0].patch.processing_status, "Completed");
  assert.equal(ctx.__updates[0].patch.processing_error, "");
});

test("OpenAI.js exposes Whisper blob helper and OPENAI_API_KEY", () => {
  assert.match(openaiSrc, /OPENAI_API_KEY/);
  assert.match(openaiSrc, /transcribeAudio:\s*function\(audioBlob\)/);
  assert.match(openaiSrc, /chatComplete:\s*function/);
});

test("no Queue.js modification required", () => {
  const queueSrc = fs.readFileSync(
    path.join(__dirname, "..", "Queue.js"),
    "utf8"
  );
  assert.match(queueSrc, /VoiceProcessing\.executePipeline\(jobToProcess\)/);
});

test("webm MIME + missing extension forces recording-<id>.webm", () => {
  const ctx = loadContext();
  const out = ctx.fieldosVpPrepareWhisperUploadBlob_(
    makeBlob({ name: "DriveUntitled", contentType: "audio/webm", bytes: [9, 9] }),
    { recording_id: "REC-819FC620", recording_name: "21759f5d-REC.webm" }
  );
  assert.equal(out.getName(), "recording-REC-819FC620.webm");
  assert.equal(out.getContentType(), "audio/webm");
  assert.deepEqual(out.getBytes(), [9, 9]);
});

test("webm filename + octet-stream MIME infers audio/webm", () => {
  const ctx = loadContext();
  const out = ctx.fieldosVpPrepareWhisperUploadBlob_(
    makeBlob({
      name: "clip.webm",
      contentType: "application/octet-stream",
      bytes: [1, 2],
    }),
    { recording_id: "REC-1", recording_name: "clip.webm" }
  );
  assert.equal(out.getContentType(), "audio/webm");
  assert.match(out.getName(), /\.webm$/i);
});

test("valid mp3 unchanged extension and mime", () => {
  const ctx = loadContext();
  const out = ctx.fieldosVpPrepareWhisperUploadBlob_(
    makeBlob({ name: "note.mp3", contentType: "audio/mpeg", bytes: [3] }),
    { recording_id: "REC-1" }
  );
  assert.equal(out.getName(), "note.mp3");
  assert.equal(out.getContentType(), "audio/mpeg");
});

test("unsupported format rejected before HTTP call", () => {
  const ctx = loadContext();
  assert.throws(
    () =>
      ctx.fieldosVpPrepareWhisperUploadBlob_(
        makeBlob({ name: "x.txt", contentType: "text/plain", bytes: [1] }),
        { recording_id: "REC-X" }
      ),
    /Unsupported audio format.*recording_id=REC-X/
  );
  assert.equal(ctx.__fetchCalls.length, 0);
  assert.equal(ctx.__openaiCalls.length, 0);
});

test("zero-byte blob rejected", () => {
  const ctx = loadContext();
  assert.throws(
    () =>
      ctx.fieldosVpPrepareWhisperUploadBlob_(
        makeBlob({ name: "a.webm", contentType: "audio/webm", bytes: [] }),
        { recording_id: "REC-Z" }
      ),
    /zero-byte.*recording_id=REC-Z/
  );
});

test("OpenAI multipart uses normalised .webm filename and audio/webm Content-Type", () => {
  const fetchCalls = [];
  const ctx = {
    console,
    Logger: { log: function () {} },
    PropertiesService: {
      getScriptProperties: function () {
        return {
          getProperty: function (key) {
            if (key === "OPENAI_API_KEY") return "sk-test";
            return null;
          },
        };
      },
    },
    UrlFetchApp: {
      fetch: function (url, options) {
        fetchCalls.push({ url: url, options: options });
        return {
          getResponseCode: function () {
            return 200;
          },
          getContentText: function () {
            return JSON.stringify({ text: "ok" });
          },
        };
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(openaiSrc, ctx);
  vm.runInContext(vpSrc, ctx);

  const normalised = ctx.fieldosVpPrepareWhisperUploadBlob_(
    makeBlob({ name: "noext", contentType: "audio/webm", bytes: [7, 7, 7] }),
    { recording_id: "REC-819FC620" }
  );
  const text = ctx.OpenAI.transcribeAudio(normalised);
  assert.equal(text, "ok");
  assert.equal(fetchCalls.length, 1);
  const filePart = fetchCalls[0].options.payload.file;
  assert.equal(filePart.getName(), "recording-REC-819FC620.webm");
  assert.equal(filePart.getContentType(), "audio/webm");
  assert.match(filePart.getName(), /\.webm$/);
});
