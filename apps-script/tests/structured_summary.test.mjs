/**
 * Phase 3A structured summary helpers + pipeline writeback tests.
 * Run: node --test apps-script/tests/structured_summary.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vpSrc = fs.readFileSync(path.join(__dirname, "..", "VoiceProcessing.js"), "utf8");

function validSummary(overrides = {}) {
  return {
    summary: "Mowed lawns and edged beds.",
    client_requests: ["Please water roses"],
    variations: [],
    safety_issues: [],
    manager_review_items: [],
    weather: "Fine",
    travel_time: "25 minutes",
    confidence_score: 0.82,
    ...overrides,
  };
}

function loadVp(overrides = {}) {
  const updates = [];
  const chatCalls = [];
  const whisperCalls = [];
  const context = {
    console,
    Logger: { log: function () {} },
    Config: {
      QUEUE_STATUS: {
        COMPLETED: "Completed",
        FAILED: "Failed",
        PROCESSING: "Processing",
        QUEUED: "Queued",
      },
    },
    JobSheetRepository: {
      update: function (id, patch) {
        updates.push({ id, patch });
      },
      findById: function () {
        return {
          job_sheet_id: "21759f5d",
          manager_notes: "Keep existing notes",
          approval_status: "Pending Review",
        };
      },
    },
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
    OpenAI: {
      transcribeAudio: function () {
        whisperCalls.push("whisper");
        return "transcribed text";
      },
      chatComplete: function (systemPrompt, userPrompt) {
        chatCalls.push({ systemPrompt, userPrompt });
        return JSON.stringify(validSummary());
      },
    },
    ...overrides,
  };
  context.__updates = updates;
  context.__chatCalls = chatCalls;
  context.__whisperCalls = whisperCalls;
  vm.createContext(context);
  vm.runInContext(vpSrc, context);
  return context;
}

test("transcript aggregation order with Recording boundaries", () => {
  const ctx = loadVp();
  const agg = ctx.fieldosVpAggregateEligibleTranscripts_([
    {
      recording_id: "REC-B",
      recording_order: 2,
      status: "Processed",
      transcript: "second",
    },
    {
      recording_id: "REC-A",
      recording_order: 1,
      status: "Processed",
      transcript: "first",
    },
  ]);
  assert.equal(agg.recordingCount, 2);
  assert.match(agg.text, /^\[Recording 1\]\nfirst/);
  assert.match(agg.text, /\[Recording 2\]\nsecond/);
  assert.ok(agg.text.indexOf("first") < agg.text.indexOf("second"));
});

test("Invalid and empty transcripts excluded", () => {
  const ctx = loadVp();
  const agg = ctx.fieldosVpAggregateEligibleTranscripts_([
    {
      recording_id: "REC-BAD",
      recording_order: 1,
      status: "Invalid",
      transcript: "should skip",
    },
    {
      recording_id: "REC-EMPTY",
      recording_order: 2,
      status: "Processed",
      transcript: "  ",
    },
    {
      recording_id: "REC-OK",
      recording_order: 3,
      status: "Processed",
      transcript: "kept",
    },
    {
      recording_id: "REC-SAVED",
      recording_order: 4,
      status: "Saved",
      transcript: "not processed yet",
    },
  ]);
  assert.equal(agg.recordingCount, 1);
  assert.equal(agg.segments[0].recording_id, "REC-OK");
  assert.doesNotMatch(agg.text, /should skip|not processed/);
});

test("valid structured JSON validates", () => {
  const ctx = loadVp();
  const out = ctx.fieldosVpValidateStructuredSummary_(validSummary());
  assert.equal(out.confidence_score, 0.82);
  assert.equal(out.summary, "Mowed lawns and edged beds.");
});

test("malformed JSON failure", () => {
  const ctx = loadVp();
  assert.throws(
    () => ctx.fieldosVpParseStructuredSummaryJson_("{not json"),
    /malformed JSON|JSON object/
  );
});

test("markdown-fenced JSON rejected on first pass", () => {
  const ctx = loadVp();
  const fenced = "```json\n" + JSON.stringify(validSummary()) + "\n```";
  assert.throws(
    () => ctx.fieldosVpParseStructuredSummaryJson_(fenced, { allowFenceStrip: false }),
    /markdown-fenced/
  );
});

test("markdown-fenced JSON accepted on repair strip", () => {
  const ctx = loadVp();
  const fenced = "```json\n" + JSON.stringify(validSummary()) + "\n```";
  const out = ctx.fieldosVpParseStructuredSummaryJson_(fenced, {
    allowFenceStrip: true,
  });
  assert.equal(out.confidence_score, 0.82);
});

test("missing required keys rejected", () => {
  const ctx = loadVp();
  const bad = validSummary();
  delete bad.weather;
  assert.throws(() => ctx.fieldosVpValidateStructuredSummary_(bad), /missing required key: weather/);
});

test("invalid list types rejected", () => {
  const ctx = loadVp();
  assert.throws(
    () =>
      ctx.fieldosVpValidateStructuredSummary_(
        validSummary({ client_requests: "not-an-array" })
      ),
    /array of strings/
  );
});

test("confidence bounds rejected outside 0-1", () => {
  const ctx = loadVp();
  assert.throws(
    () =>
      ctx.fieldosVpValidateStructuredSummary_(validSummary({ confidence_score: 1.5 })),
    /between 0 and 1/
  );
  assert.throws(
    () =>
      ctx.fieldosVpValidateStructuredSummary_(validSummary({ confidence_score: -0.1 })),
    /between 0 and 1/
  );
});

test("prompt requires specific manager_review_items wording", () => {
  assert.match(vpSrc, /manager_review_items/);
  assert.match(vpSrc, /quotes or paraphrases the actual/);
  assert.match(vpSrc, /Avoid generic placeholders/);
  assert.match(vpSrc, /Unclear details in recordings 4 and 5/);
  assert.match(vpSrc, /incomplete, truncated, or fragmentary/);
  assert.match(vpSrc, /incomplete sentence fragments/);
  assert.match(vpSrc, /cannot be[\s\S]*reliably interpreted/);
  assert.match(vpSrc, /do not invent the missing meaning/);
});

test("writeback maps incomplete-fragment manager_review wording", () => {
  const ctx = loadVp();
  const wb = ctx.fieldosVpBuildJobSheetSummaryWriteback_(
    validSummary({
      manager_review_items: [
        "Recordings 4 and 5 contain incomplete sentence fragments and cannot be reliably interpreted.",
      ],
    }),
    "[Recording 1]\nhello"
  );
  assert.equal(
    wb.manager_review_items,
    "Recordings 4 and 5 contain incomplete sentence fragments and cannot be reliably interpreted."
  );
  assert.doesNotMatch(wb.manager_review_items, /Unclear details/i);
});

test("atomic structured writeback only after validated GPT output", () => {
  let chatCalls = 0;
  const ctx = loadVp({
    OpenAI: {
      chatComplete: function () {
        chatCalls++;
        if (chatCalls === 1) return "{bad";
        return "still not json {{{";
      },
      transcribeAudio: function () {
        return "x";
      },
    },
  });
  ctx.VoiceProcessingService.processJobSheetRecordings = function () {
    return "[Recording 1]\nx";
  };
  ctx.VoiceProcessingService._loadJobRecordings_ = function () {
    return [
      {
        recording_id: "REC-1",
        recording_order: 1,
        status: "Processed",
        transcript: "x",
      },
    ];
  };
  assert.throws(
    () => ctx.VoiceProcessing.executePipeline({ job_sheet_id: "21759f5d" }),
    /invalid JSON|malformed|structured summary/
  );
  assert.ok(ctx.__updates.some((u) => u.patch.ai_transcript));
  assert.ok(!ctx.__updates.some((u) => Object.prototype.hasOwnProperty.call(u.patch, "ai_summary")));
  assert.ok(
    !ctx.__updates.some((u) => Object.prototype.hasOwnProperty.call(u.patch, "manager_review_items"))
  );
  assert.ok(
    !ctx.__updates.some((u) => Object.prototype.hasOwnProperty.call(u.patch, "client_requests"))
  );
});

test("successful writeback preserves manager_notes and approval_status by omission", () => {
  const jobState = {
    job_sheet_id: "21759f5d",
    manager_notes: "Keep existing notes",
    approval_status: "Pending Review",
    ai_summary: "",
  };
  const ctx = loadVp({
    JobSheetRepository: {
      update: function (id, patch) {
        ctx.__updates.push({ id, patch });
        Object.keys(patch).forEach((k) => {
          jobState[k] = patch[k];
        });
      },
      findById: function () {
        return jobState;
      },
    },
  });
  ctx.VoiceProcessingService.processJobSheetRecordings = function () {
    return "[Recording 1]\nhello";
  };
  ctx.VoiceProcessingService._loadJobRecordings_ = function () {
    return [
      {
        recording_id: "REC-1",
        recording_order: 1,
        status: "Processed",
        transcript: "hello",
      },
    ];
  };
  ctx.VoiceProcessing.executePipeline({ job_sheet_id: "21759f5d" });
  assert.equal(jobState.manager_notes, "Keep existing notes");
  assert.equal(jobState.approval_status, "Pending Review");
  assert.ok(jobState.ai_summary);
  assert.equal(jobState.processing_status, "Completed");
});

test("writeback mapping joins lists and omits manager_notes/approval", () => {
  const ctx = loadVp();
  const wb = ctx.fieldosVpBuildJobSheetSummaryWriteback_(
    validSummary({
      client_requests: ["A", "A", "B"],
      variations: ["Extra mulch bag"],
      manager_review_items: [
        "Recording 4 says hedge was completed; Recording 5 says hedge was left unfinished",
      ],
    }),
    "[Recording 1]\nhello"
  );
  assert.equal(wb.ai_transcript, "[Recording 1]\nhello");
  assert.equal(wb.ai_summary, "Mowed lawns and edged beds.");
  assert.equal(wb.client_requests, "A\nB");
  assert.equal(wb.variations, "Extra mulch bag");
  assert.equal(
    wb.manager_review_items,
    "Recording 4 says hedge was completed; Recording 5 says hedge was left unfinished"
  );
  assert.doesNotMatch(wb.manager_review_items, /^Unclear details in recordings/i);
  assert.equal(wb.ai_confidence_score, 0.82);
  assert.equal(Object.prototype.hasOwnProperty.call(wb, "manager_notes"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(wb, "approval_status"), false);
});

test("trailing prose rejected", () => {
  const ctx = loadVp();
  const raw = JSON.stringify(validSummary()) + "\nThanks!";
  assert.throws(
    () => ctx.fieldosVpParseStructuredSummaryJson_(raw),
    /trailing prose/
  );
});

test("executePipeline writes ai_transcript then structured fields and Completed", () => {
  const ctx = loadVp();
  ctx.VoiceProcessingService.processJobSheetRecordings = function () {
    return "[Recording 1]\nhello";
  };
  ctx.VoiceProcessingService._loadJobRecordings_ = function () {
    return [
      {
        recording_id: "REC-1",
        recording_order: 1,
        status: "Processed",
        transcript: "hello",
      },
    ];
  };
  const out = ctx.VoiceProcessing.executePipeline({ job_sheet_id: "21759f5d" });
  assert.match(out, /hello/);
  assert.equal(ctx.__chatCalls.length, 1);
  assert.match(ctx.__chatCalls[0].systemPrompt, /Native Grace landscaping/);
  assert.ok(ctx.__updates.length >= 2);
  assert.equal(ctx.__updates[0].patch.ai_transcript, "[Recording 1]\nhello");
  const finalPatch = ctx.__updates[ctx.__updates.length - 1].patch;
  assert.equal(finalPatch.processing_status, "Completed");
  assert.equal(finalPatch.processing_error, "");
  assert.equal(finalPatch.ai_summary, "Mowed lawns and edged beds.");
  for (const key of [
    "ai_transcript",
    "ai_summary",
    "client_requests",
    "variations",
    "safety_issues",
    "manager_review_items",
    "weather",
    "travel_time",
    "ai_confidence_score",
  ]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(finalPatch, key),
      "missing atomic writeback key: " + key
    );
  }
  assert.equal(Object.prototype.hasOwnProperty.call(finalPatch, "manager_notes"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(finalPatch, "approval_status"), false);
});

test("summary failure does not retranscribe Processed recordings", () => {
  const ctx = loadVp({
    OpenAI: {
      transcribeAudio: function () {
        throw new Error("whisper should not run");
      },
      chatComplete: function () {
        throw new Error("GPT API Error (500): boom");
      },
    },
  });
  let whisperViaService = 0;
  ctx.VoiceProcessingService.processJobSheetRecordings = function () {
    return "[Recording 1]\nalready";
  };
  ctx.VoiceProcessingService._loadJobRecordings_ = function () {
    return [
      {
        recording_id: "REC-1",
        recording_order: 1,
        status: "Processed",
        transcript: "already",
      },
    ];
  };
  ctx.VoiceProcessingService._transcribeDriveFile_ = function () {
    whisperViaService++;
    return "nope";
  };
  assert.throws(
    () => ctx.VoiceProcessing.executePipeline({ job_sheet_id: "21759f5d" }),
    /structured summary failed|GPT API Error/
  );
  assert.equal(whisperViaService, 0);
  // ai_transcript may have been written before GPT failure
  assert.ok(ctx.__updates.some((u) => u.patch.ai_transcript));
  assert.ok(!ctx.__updates.some((u) => u.patch.ai_summary));
});

test("OpenAI error rethrows to Queue (Failed path)", () => {
  const ctx = loadVp({
    OpenAI: {
      chatComplete: function () {
        throw new Error("GPT API Error (429): rate");
      },
      transcribeAudio: function () {
        return "x";
      },
    },
  });
  ctx.VoiceProcessingService.processJobSheetRecordings = function () {
    return "[Recording 1]\nx";
  };
  ctx.VoiceProcessingService._loadJobRecordings_ = function () {
    return [
      {
        recording_id: "REC-1",
        recording_order: 1,
        status: "Processed",
        transcript: "x",
      },
    ];
  };
  assert.throws(
    () => ctx.VoiceProcessing.executePipeline({ job_sheet_id: "21759f5d" }),
    /structured summary failed/
  );
});

test("repair path recovers from fenced JSON once", () => {
  let calls = 0;
  const ctx = loadVp({
    OpenAI: {
      chatComplete: function () {
        calls++;
        if (calls === 1) {
          return "```json\n" + JSON.stringify(validSummary()) + "\n```";
        }
        return JSON.stringify(validSummary({ confidence_score: 0.5 }));
      },
      transcribeAudio: function () {
        return "x";
      },
    },
  });
  const out = ctx.fieldosVpRunStructuredSummary_("[Recording 1]\nx", {
    job_sheet_id: "21759f5d",
    recordingCount: 1,
    characterCount: 20,
  });
  assert.equal(calls, 2);
  assert.equal(out.confidence_score, 0.5);
});

test("no Queue.js modification required for Phase 3A", () => {
  const queueSrc = fs.readFileSync(path.join(__dirname, "..", "Queue.js"), "utf8");
  assert.match(queueSrc, /VoiceProcessing\.executePipeline\(jobToProcess\)/);
  assert.match(queueSrc, /processing_completed_at/);
});
