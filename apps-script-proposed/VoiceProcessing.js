/**
 * VoiceProcessing.gs
 * Processes multi-source voice dictations from 'tbl_recordings'.
 * Transcribes audio via OpenAI Whisper (OPENAI_API_KEY).
 * Phase 3A: GPT structured summary → tbl_job_sheets writeback via OpenAI.chatComplete.
 *
 * Queue contract: VoiceProcessing.executePipeline(jobRow)
 * FieldOS recordings use transcript + recording_drive_file_id;
 * legacy AppSheet rows may use transcription + audio_file / file_path.
 *
 * Recording loop skips status === "Invalid" and already Processed+transcript rows.
 * Usable transcript/transcription text skips the transcription API (no re-Whisper).
 */

/**
 * @param {object} jobRow
 * @returns {string}
 */
function fieldosVpExtractJobSheetId_(jobRow) {
  if (!jobRow || typeof jobRow !== "object" || Array.isArray(jobRow)) {
    throw new Error("VoiceProcessing.executePipeline requires a job row object.");
  }
  const jobSheetId = String(jobRow.job_sheet_id == null ? "" : jobRow.job_sheet_id).trim();
  if (!jobSheetId) {
    throw new Error("VoiceProcessing.executePipeline: jobRow.job_sheet_id is required.");
  }
  return jobSheetId;
}

/**
 * Read transcript text from either FieldOS or legacy column.
 * @param {object} recording
 * @returns {string}
 */
function fieldosVpGetTranscriptText_(recording) {
  if (!recording) return "";
  const a = String(recording.transcript == null ? "" : recording.transcript).trim();
  if (a) return a;
  const b = String(recording.transcription == null ? "" : recording.transcription).trim();
  return b;
}

/**
 * Skip Whisper when already Processed with non-empty transcript text.
 * Saved (or other) status alone is never enough — see fieldosVpHasUsableTranscript_.
 * @param {object} recording
 * @returns {boolean}
 */
function fieldosVpIsRecordingComplete_(recording) {
  if (!recording) return false;
  const status = String(recording.status == null ? "" : recording.status).trim();
  if (status !== "Processed") return false;
  return fieldosVpGetTranscriptText_(recording) !== "";
}

/**
 * True when transcript or transcription already has usable (trimmed) text.
 * Used to skip the transcription API without requiring status === Processed.
 * @param {object} recording
 * @returns {boolean}
 */
function fieldosVpHasUsableTranscript_(recording) {
  return fieldosVpGetTranscriptText_(recording) !== "";
}

/**
 * Prefer Drive file id (FieldOS), then legacy path columns, then recording_name.
 * @param {object} recording
 * @returns {{mode: "drive_id"|"filename", value: string}|null}
 */
function fieldosVpPickDriveResolvePlan_(recording) {
  if (!recording) return null;
  const driveId = String(
    recording.recording_drive_file_id == null ? "" : recording.recording_drive_file_id
  ).trim();
  if (driveId) return { mode: "drive_id", value: driveId };

  const audioFile = String(recording.audio_file == null ? "" : recording.audio_file).trim();
  if (audioFile) return { mode: "filename", value: audioFile };

  const filePath = String(recording.file_path == null ? "" : recording.file_path).trim();
  if (filePath) return { mode: "filename", value: filePath };

  const name = String(recording.recording_name == null ? "" : recording.recording_name).trim();
  if (name) return { mode: "filename", value: name };

  return null;
}

/**
 * Parse created_at to epoch ms for stable sorting. Missing/invalid → 0.
 * @param {object} recording
 * @returns {number}
 */
function fieldosVpCreatedAtMs_(recording) {
  const v = recording && recording.created_at;
  if (v == null || v === "") return 0;
  if (Object.prototype.toString.call(v) === "[object Date]") {
    const t = v.getTime();
    return isNaN(t) ? 0 : t;
  }
  const parsed = Date.parse(String(v));
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Stable sort: recording_order (numeric) → created_at → recording_id.
 * Deterministic tie-break for legacy duplicate orders (do not rewrite rows).
 * @param {Array<object>} recordings
 * @returns {Array<object>}
 */
function fieldosVpSortRecordingsByOrder_(recordings) {
  return (recordings || []).slice().sort(function (a, b) {
    const ao = Number(a && a.recording_order != null ? a.recording_order : NaN);
    const bo = Number(b && b.recording_order != null ? b.recording_order : NaN);
    const aOk = !isNaN(ao) && isFinite(ao);
    const bOk = !isNaN(bo) && isFinite(bo);
    if (aOk && bOk && ao !== bo) return ao - bo;
    if (aOk && !bOk) return -1;
    if (!aOk && bOk) return 1;
    const at = fieldosVpCreatedAtMs_(a);
    const bt = fieldosVpCreatedAtMs_(b);
    if (at !== bt) return at - bt;
    const aid = String(a && a.recording_id != null ? a.recording_id : "");
    const bid = String(b && b.recording_id != null ? b.recording_id : "");
    if (aid < bid) return -1;
    if (aid > bid) return 1;
    return 0;
  });
}

/**
 * Writeback map: both transcript aliases + status. Header-safe updater skips missing columns.
 * @param {string} text
 * @returns {object}
 */
function fieldosVpBuildTranscriptWriteback_(text) {
  return {
    transcript: text,
    transcription: text,
    status: "Processed"
  };
}

/**
 * @param {*} result
 * @returns {boolean}
 */
function fieldosVpIsEmptyPipelineResult_(result) {
  if (result == null) return true;
  if (result === "NO_RECORDINGS") return true;
  if (typeof result === "string" && result.trim() === "") return true;
  return false;
}

/** GPT model used for structured job summary (chatComplete). */
var FIELDOS_VP_SUMMARY_MODEL_ = "gpt-4o";

/**
 * Strict system prompt for landscaping/gardening job-note extraction.
 * Returns JSON only — no markdown.
 */
var FIELDOS_VP_SUMMARY_SYSTEM_PROMPT_ =
  "You are a field operations analyst for Native Grace landscaping and gardening jobs in Australia. " +
  "Read the job voice transcripts and extract structured facts for managers. " +
  "Return a single JSON object only (no markdown, no commentary) with exactly these keys:\n" +
  "summary (string), client_requests (array of strings), variations (array of strings), " +
  "safety_issues (array of strings), manager_review_items (array of strings), " +
  "weather (string), travel_time (string), confidence_score (number 0 to 1).\n" +
  "Rules:\n" +
  "- Do not fabricate facts. If information is absent, use an empty string or empty array.\n" +
  "- summary: concise manager-useful overview of work completed and outcomes.\n" +
  "- client_requests: explicit client asks or preferences.\n" +
  "- variations: only extra work, changed scope, or potentially chargeable additions — " +
  "not ordinary routine work notes.\n" +
  "- safety_issues: hazards, incidents, PPE gaps, or unsafe conditions.\n" +
  "- manager_review_items: list each uncertain, contradictory, incomplete, or follow-up item " +
  "that needs manager action. Prefer specific wording that quotes or paraphrases the actual " +
  "unclear or conflicting content (for example what was said in one recording versus another). " +
  "When transcript content is incomplete, truncated, or fragmentary, say that explicitly " +
  "(for example: \"Recordings 4 and 5 contain incomplete sentence fragments and cannot be " +
  "reliably interpreted.\") — do not invent the missing meaning. " +
  "Avoid generic placeholders such as \"Unclear details in recordings 4 and 5\" when the nature " +
  "of the uncertainty is known; use that wording only when no more specific interpretation " +
  "of the content is possible.\n" +
  "- weather and travel_time: only when stated or clearly implied; otherwise empty string.\n" +
  "- confidence_score: overall confidence in the extraction from 0.0 to 1.0.\n" +
  "- Distinguish confirmed facts from uncertain statements; put uncertain content in manager_review_items.\n" +
  "- Do not include personal commentary or markdown fences.";

var FIELDOS_VP_SUMMARY_REQUIRED_KEYS_ = [
  "summary",
  "client_requests",
  "variations",
  "safety_issues",
  "manager_review_items",
  "weather",
  "travel_time",
  "confidence_score"
];

/**
 * Eligible rows for job-level aggregate: Processed + non-empty transcript.
 * @param {object} recording
 * @returns {boolean}
 */
function fieldosVpIsEligibleForJobAggregate_(recording) {
  if (!recording) return false;
  const status = String(recording.status == null ? "" : recording.status).trim();
  if (status === "Invalid") return false;
  if (status !== "Processed") return false;
  return fieldosVpGetTranscriptText_(recording) !== "";
}

/**
 * Aggregate eligible recordings in recording_order with [Recording N] boundaries.
 * @param {Array<object>} recordings
 * @returns {{ text: string, recordingCount: number, characterCount: number, segments: Array<{order:number,recording_id:string,text:string}> }}
 */
function fieldosVpAggregateEligibleTranscripts_(recordings) {
  const sorted = fieldosVpSortRecordingsByOrder_(recordings || []).filter(
    fieldosVpIsEligibleForJobAggregate_
  );
  const segments = [];
  for (let i = 0; i < sorted.length; i++) {
    const rec = sorted[i];
    const text = fieldosVpGetTranscriptText_(rec);
    const orderNum =
      Number(rec.recording_order != null ? rec.recording_order : i + 1) || i + 1;
    segments.push({
      order: orderNum,
      recording_id: String(rec.recording_id || ""),
      text: text
    });
  }
  const parts = segments.map(function (seg, idx) {
    const label = "[Recording " + (idx + 1) + "]";
    return label + "\n" + seg.text;
  });
  const text = parts.join("\n\n");
  return {
    text: text,
    recordingCount: segments.length,
    characterCount: text.length,
    segments: segments
  };
}

/**
 * @param {Array} value
 * @returns {string} newline-separated unique non-empty strings
 */
function fieldosVpJoinListField_(value) {
  const arr = Array.isArray(value) ? value : [];
  const seen = {};
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const item = String(arr[i] == null ? "" : arr[i]).trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push(item);
  }
  return out.join("\n");
}

/**
 * Strip a single markdown fence wrapper if present (repair helper only).
 * @param {string} raw
 * @returns {string}
 */
function fieldosVpStripJsonFences_(raw) {
  let s = String(raw == null ? "" : raw).trim();
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return String(fenced[1] || "").trim();
  return s;
}

/**
 * Reject markdown fences / trailing prose before JSON.parse on first pass.
 * @param {string} raw
 * @returns {string}
 */
function fieldosVpAssertRawJsonObjectText_(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) throw new Error("Structured summary response was empty.");
  if (/^```/.test(s)) {
    throw new Error("Structured summary rejected markdown-fenced JSON.");
  }
  if (s.charAt(0) !== "{") {
    throw new Error("Structured summary must be a JSON object.");
  }
  // Reject obvious trailing prose after the closing brace.
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error("Structured summary JSON object is incomplete.");
  const trailing = s.slice(end + 1).trim();
  if (trailing) {
    throw new Error("Structured summary rejected trailing prose after JSON.");
  }
  return s.slice(0, end + 1);
}

/**
 * @param {*} value
 * @returns {boolean}
 */
function fieldosVpIsStringArray_(value) {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") return false;
  }
  return true;
}

/**
 * Strict structured summary validator.
 * @param {*} obj
 * @returns {object} normalised object
 */
function fieldosVpValidateStructuredSummary_(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("Structured summary must be a JSON object.");
  }
  for (let i = 0; i < FIELDOS_VP_SUMMARY_REQUIRED_KEYS_.length; i++) {
    const key = FIELDOS_VP_SUMMARY_REQUIRED_KEYS_[i];
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new Error("Structured summary missing required key: " + key);
    }
  }
  const stringKeys = ["summary", "weather", "travel_time"];
  for (let i = 0; i < stringKeys.length; i++) {
    const k = stringKeys[i];
    if (typeof obj[k] !== "string") {
      throw new Error("Structured summary field '" + k + "' must be a string.");
    }
  }
  const listKeys = [
    "client_requests",
    "variations",
    "safety_issues",
    "manager_review_items"
  ];
  for (let i = 0; i < listKeys.length; i++) {
    const k = listKeys[i];
    if (!fieldosVpIsStringArray_(obj[k])) {
      throw new Error(
        "Structured summary field '" + k + "' must be an array of strings."
      );
    }
  }
  const score = Number(obj.confidence_score);
  if (!Number.isFinite(score)) {
    throw new Error("Structured summary confidence_score must be numeric.");
  }
  if (score < 0 || score > 1) {
    throw new Error("Structured summary confidence_score must be between 0 and 1.");
  }
  return {
    summary: String(obj.summary || "").trim(),
    client_requests: obj.client_requests.slice(),
    variations: obj.variations.slice(),
    safety_issues: obj.safety_issues.slice(),
    manager_review_items: obj.manager_review_items.slice(),
    weather: String(obj.weather || "").trim(),
    travel_time: String(obj.travel_time || "").trim(),
    confidence_score: score
  };
}

/**
 * Parse + validate GPT content. Optionally strip fences on repair pass only.
 * @param {string} raw
 * @param {{allowFenceStrip?:boolean}=} opts
 * @returns {object}
 */
function fieldosVpParseStructuredSummaryJson_(raw, opts) {
  opts = opts || {};
  let text = String(raw == null ? "" : raw);
  if (opts.allowFenceStrip) {
    text = fieldosVpStripJsonFences_(text);
  }
  const jsonText = fieldosVpAssertRawJsonObjectText_(text);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      "Structured summary malformed JSON: " +
        (err && err.message ? err.message : String(err))
    );
  }
  return fieldosVpValidateStructuredSummary_(parsed);
}

/**
 * Map validated summary to tbl_job_sheets writeback (confirmed columns only).
 * Does not include manager_notes or approval_status.
 * @param {object} summary
 * @param {string} aiTranscript
 * @returns {object}
 */
function fieldosVpBuildJobSheetSummaryWriteback_(summary, aiTranscript) {
  return {
    ai_transcript: String(aiTranscript || ""),
    ai_summary: String(summary.summary || ""),
    client_requests: fieldosVpJoinListField_(summary.client_requests),
    variations: fieldosVpJoinListField_(summary.variations),
    safety_issues: fieldosVpJoinListField_(summary.safety_issues),
    manager_review_items: fieldosVpJoinListField_(summary.manager_review_items),
    weather: String(summary.weather || ""),
    travel_time: String(summary.travel_time || ""),
    ai_confidence_score: Number(summary.confidence_score)
  };
}

/**
 * Call OpenAI.chatComplete and validate; one controlled repair retry.
 * @param {string} aggregatedTranscript
 * @param {{job_sheet_id?:string, recordingCount?:number, characterCount?:number}=} meta
 * @returns {object} validated summary
 */
function fieldosVpRunStructuredSummary_(aggregatedTranscript, meta) {
  meta = meta || {};
  if (typeof OpenAI === "undefined" || !OpenAI || typeof OpenAI.chatComplete !== "function") {
    throw new Error("OpenAI.chatComplete is unavailable.");
  }
  const jobSheetId = String(meta.job_sheet_id || "").trim() || "(unknown)";
  const userPrompt =
    "Job sheet ID: " +
    jobSheetId +
    "\n\nVoice transcripts:\n\n" +
    String(aggregatedTranscript || "");

  Logger.log(
    JSON.stringify({
      fieldos_vp_summary: "request",
      job_sheet_id: jobSheetId,
      recording_count: Number(meta.recordingCount || 0),
      transcript_character_count: Number(meta.characterCount || 0),
      model: FIELDOS_VP_SUMMARY_MODEL_
    })
  );

  let raw;
  try {
    raw = OpenAI.chatComplete(FIELDOS_VP_SUMMARY_SYSTEM_PROMPT_, userPrompt);
  } catch (err) {
    throw new Error(
      "VoiceProcessing structured summary failed for job_sheet_id=" +
        jobSheetId +
        ": " +
        (err && err.message ? err.message : String(err))
    );
  }

  try {
    const validated = fieldosVpParseStructuredSummaryJson_(raw, {
      allowFenceStrip: false
    });
    Logger.log(
      JSON.stringify({
        fieldos_vp_summary: "parse_ok",
        job_sheet_id: jobSheetId,
        recording_count: Number(meta.recordingCount || 0),
        transcript_character_count: Number(meta.characterCount || 0),
        model: FIELDOS_VP_SUMMARY_MODEL_,
        confidence_score: validated.confidence_score,
        parse_success: true
      })
    );
    return validated;
  } catch (firstErr) {
    Logger.log(
      JSON.stringify({
        fieldos_vp_summary: "parse_retry",
        job_sheet_id: jobSheetId,
        model: FIELDOS_VP_SUMMARY_MODEL_,
        parse_success: false,
        error: String(firstErr && firstErr.message ? firstErr.message : firstErr).slice(0, 180)
      })
    );
    const repairUser =
      "Your previous response was invalid. Return ONLY a valid JSON object with the required keys " +
      "and no markdown fences or trailing text.\n\nOriginal transcripts:\n\n" +
      String(aggregatedTranscript || "");
    let repairedRaw;
    try {
      repairedRaw = OpenAI.chatComplete(FIELDOS_VP_SUMMARY_SYSTEM_PROMPT_, repairUser);
    } catch (err2) {
      throw new Error(
        "VoiceProcessing structured summary repair call failed for job_sheet_id=" +
          jobSheetId +
          ": " +
          (err2 && err2.message ? err2.message : String(err2))
      );
    }
    try {
      const validated2 = fieldosVpParseStructuredSummaryJson_(repairedRaw, {
        allowFenceStrip: true
      });
      Logger.log(
        JSON.stringify({
          fieldos_vp_summary: "parse_ok_after_repair",
          job_sheet_id: jobSheetId,
          model: FIELDOS_VP_SUMMARY_MODEL_,
          confidence_score: validated2.confidence_score,
          parse_success: true
        })
      );
      return validated2;
    } catch (secondErr) {
      Logger.log(
        JSON.stringify({
          fieldos_vp_summary: "parse_failed",
          job_sheet_id: jobSheetId,
          model: FIELDOS_VP_SUMMARY_MODEL_,
          parse_success: false,
          error: String(
            secondErr && secondErr.message ? secondErr.message : secondErr
          ).slice(0, 180)
        })
      );
      throw new Error(
        "VoiceProcessing structured summary invalid JSON for job_sheet_id=" +
          jobSheetId +
          ": " +
          (secondErr && secondErr.message ? secondErr.message : String(secondErr))
      );
    }
  }
}

/** MIME → Whisper-friendly extension */
var FIELDOS_VP_MIME_TO_EXT_ = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "audio/wav": "wav",
  "audio/x-wav": "wav"
};

/** Extension → MIME (for octet-stream inference) */
var FIELDOS_VP_EXT_TO_MIME_ = {
  webm: "audio/webm",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  wav: "audio/wav"
};

/**
 * @param {string} filename
 * @returns {string} lowercase extension without dot, or ""
 */
function fieldosVpFileExtension_(filename) {
  const name = String(filename == null ? "" : filename).trim();
  const m = name.match(/\.([A-Za-z0-9]+)$/);
  return m ? String(m[1]).toLowerCase() : "";
}

/**
 * Normalise Drive blob for OpenAI Whisper multipart upload.
 * Copies the blob; never mutates the Drive file. Bytes unchanged.
 *
 * @param {GoogleAppsScript.Base.Blob} blob
 * @param {{recording_id?:string, recording_name?:string, drive_file_name?:string}=} meta
 * @returns {GoogleAppsScript.Base.Blob}
 */
function fieldosVpPrepareWhisperUploadBlob_(blob, meta) {
  meta = meta || {};
  if (!blob) {
    throw new Error("Whisper upload requires an audio blob.");
  }

  const recordingId = String(meta.recording_id == null ? "" : meta.recording_id).trim() || "unknown";
  const recordingName = String(meta.recording_name == null ? "" : meta.recording_name).trim();
  const driveName = String(meta.drive_file_name == null ? "" : meta.drive_file_name).trim();

  let bytes;
  try {
    bytes = blob.getBytes();
  } catch (e) {
    throw new Error(
      "Whisper upload could not read blob bytes for recording_id=" + recordingId
    );
  }
  const byteLength = bytes && bytes.length ? bytes.length : 0;
  if (byteLength === 0) {
    throw new Error(
      "Whisper upload rejected zero-byte blob for recording_id=" +
        recordingId +
        " filename=" +
        (blob.getName && blob.getName() ? blob.getName() : recordingName || "(none)") +
        " mime=" +
        (blob.getContentType && blob.getContentType() ? blob.getContentType() : "(none)") +
        " byte_length=0"
    );
  }

  let mime = String(blob.getContentType() || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  let name = String(blob.getName() || driveName || recordingName || "").trim();

  const extFromName =
    fieldosVpFileExtension_(name) || fieldosVpFileExtension_(recordingName);

  if ((!mime || mime === "application/octet-stream") && extFromName) {
    const inferred = FIELDOS_VP_EXT_TO_MIME_[extFromName];
    if (inferred) mime = inferred;
  }

  const targetExt = FIELDOS_VP_MIME_TO_EXT_[mime];
  if (!targetExt) {
    throw new Error(
      "Unsupported audio format for Whisper: recording_id=" +
        recordingId +
        " filename=" +
        (name || recordingName || "(none)") +
        " mime=" +
        (mime || "(none)") +
        " byte_length=" +
        byteLength
    );
  }

  // Prefer Whisper-friendly audio/* Content-Type for webm/mp4 containers.
  let uploadMime = mime;
  if (mime === "video/webm") uploadMime = "audio/webm";
  if (mime === "video/mp4") uploadMime = "audio/mp4";

  let uploadName = name || recordingName || "recording-" + recordingId;
  const hasTargetExt = new RegExp("\\." + targetExt + "$", "i").test(uploadName);

  if ((mime === "audio/webm" || mime === "video/webm") && !hasTargetExt) {
    uploadName = "recording-" + recordingId + ".webm";
  } else if (!hasTargetExt) {
    uploadName = "recording-" + recordingId + "." + targetExt;
  }

  let uploadBlob;
  if (typeof blob.copyBlob === "function") {
    uploadBlob = blob.copyBlob();
  } else {
    // Test / non-Apps Script doubles
    uploadBlob = blob;
  }
  if (typeof uploadBlob.setName === "function") uploadBlob.setName(uploadName);
  if (typeof uploadBlob.setContentType === "function") {
    uploadBlob.setContentType(uploadMime);
  }

  return uploadBlob;
}

/**
 * Sanitised error for Queue / sync logs (never include API keys).
 * @param {string} recordingId
 * @param {*} err
 * @returns {Error}
 */
function fieldosVpWrapRecordingError_(recordingId, err) {
  const rid = String(recordingId == null ? "" : recordingId).trim() || "(unknown)";
  let msg = err && err.message ? String(err.message) : String(err);
  msg = msg.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer ***");
  msg = msg.replace(/sk-[A-Za-z0-9]+/g, "sk-***");
  return new Error(
    "VoiceProcessing transcription failed for recording_id=" + rid + ": " + msg
  );
}

var VoiceProcessingService = {

  /**
   * Safe getter for the spreadsheet instance.
   */
  _getSpreadsheet: function() {
    const propId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
    if (!propId) {
      const activeSS = SpreadsheetApp.getActiveSpreadsheet();
      if (activeSS) return activeSS;
      throw new Error("Configuration Error: 'SPREADSHEET_ID' script property is missing.");
    }
    return SpreadsheetApp.openById(propId.trim());
  },

  /**
   * Helper to map any sheet data to clean JSON object structures.
   */
  _getRecords: function(ss, tableName) {
    const sheet = ss.getSheetByName(tableName);
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    const headers = data.shift();
    return data.map(function (row, idx) {
      const obj = { _sheetRowIndex: idx + 2 };
      headers.forEach(function (h, i) {
        obj[h] = row[i];
      });
      return obj;
    });
  },

  /**
   * Resolve a Drive file for a recording (FieldOS id first, then legacy filename paths).
   * @param {object} recording
   * @returns {GoogleAppsScript.Drive.File}
   */
  _resolveRecordingDriveFile: function(recording) {
    const plan = fieldosVpPickDriveResolvePlan_(recording);
    if (!plan) {
      throw new Error("Recording record is missing an audio file path asset.");
    }

    if (plan.mode === "drive_id") {
      try {
        return DriveApp.getFileById(plan.value);
      } catch (e) {
        throw new Error(
          "Google Drive resolve failure: " + (e && e.message ? e.message : String(e))
        );
      }
    }

    return this._resolveDriveFileByFilename_(plan.value);
  },

  /**
   * Legacy AppSheet path/filename lookup.
   * @param {string} filePath
   * @returns {GoogleAppsScript.Drive.File}
   */
  _resolveDriveFileByFilename_: function(filePath) {
    try {
      const cleanPath = String(filePath || "")
        .replace(/^'|'$/g, "")
        .trim();
      const files = DriveApp.getFilesByName(cleanPath.split("/").pop());
      if (files.hasNext()) {
        return files.next();
      }
      throw new Error("File asset not found in Google Drive: " + cleanPath);
    } catch (e) {
      throw new Error(
        "Google Drive resolve failure: " + (e && e.message ? e.message : String(e))
      );
    }
  },

  /**
   * Main Orchestrator: Processes all unprocessed recordings for a given Job Sheet ID.
   * Uses OpenAI Whisper. Does not call Gemini.
   * @param {string} jobSheetId
   * @returns {string} aggregated transcript body ([Recording N] format from Processed rows)
   */
  processJobSheetRecordings: function(jobSheetId) {
    if (!jobSheetId) throw new Error("Missing required parameter: jobSheetId");
    Logger.log("Starting OpenAI voice processing for Job Sheet ID: " + jobSheetId);

    const ss = this._getSpreadsheet();
    const recordings = this._getRecords(ss, "tbl_recordings");

    const targetRecordings = fieldosVpSortRecordingsByOrder_(
      recordings.filter(function (r) {
        return String(r.job_sheet_id) === String(jobSheetId);
      })
    );
    if (targetRecordings.length === 0) {
      Logger.log("No recordings found in 'tbl_recordings' for Job Sheet ID: " + jobSheetId);
      return "NO_RECORDINGS";
    }

    for (let i = 0; i < targetRecordings.length; i++) {
      const recording = targetRecordings[i];
      var recordingStatus = String(recording.status || "").trim();
      if (recordingStatus === "Invalid") {
        continue;
      }
      const recordingId = String(recording.recording_id || "");

      if (fieldosVpIsRecordingComplete_(recording)) {
        Logger.log(
          "Recording " + recordingId + " already processed. Skipping OpenAI call."
        );
        continue;
      }

      // Usable existing text → skip API; promote to Processed for job aggregate.
      // Status "Saved" alone does not skip (no text → still transcribe).
      if (fieldosVpHasUsableTranscript_(recording)) {
        const existingText = fieldosVpGetTranscriptText_(recording);
        Logger.log(
          "Recording " + recordingId + " has existing transcript text. Skipping OpenAI call."
        );
        try {
          this._updateRowValue(
            ss,
            "tbl_recordings",
            recording._sheetRowIndex,
            fieldosVpBuildTranscriptWriteback_(existingText)
          );
          recording.transcript = existingText;
          recording.transcription = existingText;
          recording.status = "Processed";
        } catch (err) {
          throw fieldosVpWrapRecordingError_(recordingId, err);
        }
        continue;
      }

      Logger.log("Transcribing Recording ID: " + recordingId + " via OpenAI Whisper");

      try {
        const file = this._resolveRecordingDriveFile(recording);
        const transcript = this._transcribeDriveFile_(file, recording);

        this._updateRowValue(
          ss,
          "tbl_recordings",
          recording._sheetRowIndex,
          fieldosVpBuildTranscriptWriteback_(transcript)
        );
        // Keep in-memory row current for post-pass aggregate without a full reload dependency.
        recording.transcript = transcript;
        recording.transcription = transcript;
        recording.status = "Processed";
      } catch (err) {
        try {
          this._updateRowValue(ss, "tbl_recordings", recording._sheetRowIndex, {
            status: "Error: Transcription Failed"
          });
        } catch (updateErr) {
          // Best-effort status only; primary error is rethrown below.
        }
        throw fieldosVpWrapRecordingError_(recordingId, err);
      }
    }

    const agg = fieldosVpAggregateEligibleTranscripts_(targetRecordings);
    if (!agg.text) {
      throw new Error("No successful transcriptions could be aggregated.");
    }
    Logger.log(
      JSON.stringify({
        fieldos_vp_aggregate: "ok",
        job_sheet_id: jobSheetId,
        recording_count: agg.recordingCount,
        transcript_character_count: agg.characterCount
      })
    );
    return agg.text;
  },

  /**
   * Load recordings for a job (for summary retry without re-transcribe).
   * @param {string} jobSheetId
   * @returns {Array<object>}
   */
  _loadJobRecordings_: function(jobSheetId) {
    const ss = this._getSpreadsheet();
    const recordings = this._getRecords(ss, "tbl_recordings") || [];
    return fieldosVpSortRecordingsByOrder_(
      recordings.filter(function (r) {
        return String(r.job_sheet_id) === String(jobSheetId);
      })
    );
  },

  /**
   * Transcribe a Drive file blob via OpenAI Whisper (normalised filename + MIME).
   * @param {GoogleAppsScript.Drive.File} file
   * @param {object=} recording row (for recording_id / recording_name)
   * @returns {string}
   */
  _transcribeDriveFile_: function(file, recording) {
    if (!file) throw new Error("Recording record is missing an audio file path asset.");
    if (typeof OpenAI === "undefined" || !OpenAI || typeof OpenAI.transcribeAudio !== "function") {
      throw new Error("OpenAI.transcribeAudio is unavailable.");
    }

    const blob = file.getBlob();
    if (!blob) throw new Error("Drive file returned an empty audio blob.");

    const uploadBlob = fieldosVpPrepareWhisperUploadBlob_(blob, {
      recording_id: recording && recording.recording_id,
      recording_name: recording && recording.recording_name,
      drive_file_name: typeof file.getName === "function" ? file.getName() : ""
    });

    // OpenAI.transcribeAudio uses blob.getName() / getContentType() for multipart.
    return OpenAI.transcribeAudio(uploadBlob);
  },

  /**
   * Legacy entry: path/filename → Drive → OpenAI Whisper.
   * @param {string} filePath
   * @returns {string}
   */
  _transcribeAudioFile: function(filePath) {
    if (!filePath) throw new Error("Recording record is missing an audio file path asset.");
    const file = this._resolveDriveFileByFilename_(filePath);
    return this._transcribeDriveFile_(file);
  },

  /**
   * Header-safe column updater. Skips keys whose columns are absent.
   */
  _updateRowValue: function(ss, tableName, rowIndex, columnKeyValuePairs) {
    const sheet = ss.getSheetByName(tableName);
    const headers = sheet
      .getDataRange()
      .getValues()[0]
      .map(function (h) {
        return String(h).trim().toLowerCase();
      });

    Object.keys(columnKeyValuePairs).forEach(function (key) {
      const colIndex = headers.indexOf(String(key).trim().toLowerCase()) + 1;
      if (colIndex > 0) {
        sheet.getRange(rowIndex, colIndex).setValue(columnKeyValuePairs[key]);
      }
    });
  }
};

/**
 * Queue worker entry point (compatibility facade).
 * Queue.processNext passes a full tbl_job_sheets row.
 *
 * Minimal contract:
 * - validate jobRow / job_sheet_id
 * - call VoiceProcessingService.processJobSheetRecordings
 * - fail on NO_RECORDINGS / null / undefined / blank aggregate
 * - on success: processing_status=Completed, processing_error=""
 * - return aggregated transcript; rethrow service/repository errors
 *
 * Phase 3A (additional): Whisper aggregate → ai_transcript → GPT structured
 * summary writeback → Completed (same success path).
 */
var VoiceProcessing = {
  /**
   * @param {object} jobRow tbl_job_sheets row containing job_sheet_id
   * @returns {string} aggregated transcript
   */
  executePipeline: function(jobRow) {
    const jobSheetId = fieldosVpExtractJobSheetId_(jobRow);

    let aggregated;
    try {
      aggregated = VoiceProcessingService.processJobSheetRecordings(jobSheetId);
    } catch (err) {
      throw err;
    }

    if (fieldosVpIsEmptyPipelineResult_(aggregated)) {
      // Prefer reloading Processed transcripts so a summary-only retry can succeed
      // without retranscribing when Whisper already wrote rows.
      try {
        const existing = VoiceProcessingService._loadJobRecordings_(jobSheetId);
        const fromSheet = fieldosVpAggregateEligibleTranscripts_(existing);
        if (fromSheet.text) {
          aggregated = fromSheet.text;
        }
      } catch (loadErr) {
        // fall through to empty failure
      }
    }

    if (fieldosVpIsEmptyPipelineResult_(aggregated)) {
      throw new Error(
        "VoiceProcessing.executePipeline: no transcript aggregated for job_sheet_id=" +
          jobSheetId +
          " (result=" +
          String(aggregated) +
          ")."
      );
    }

    // Prefer sheet-backed aggregate (Processed only) for GPT + ai_transcript.
    let aggregateMeta = {
      text: aggregated,
      recordingCount: 0,
      characterCount: String(aggregated || "").length
    };
    try {
      const rows = VoiceProcessingService._loadJobRecordings_(jobSheetId);
      const fromSheet = fieldosVpAggregateEligibleTranscripts_(rows);
      if (fromSheet.text) {
        aggregateMeta = fromSheet;
        aggregated = fromSheet.text;
      }
    } catch (aggErr) {
      // Keep processJobSheetRecordings aggregate.
    }

    if (typeof JobSheetRepository !== "undefined" && JobSheetRepository.update) {
      // Write transcript first so GPT failure still preserves aggregate text.
      JobSheetRepository.update(jobSheetId, {
        ai_transcript: aggregated
      });
    }

    const summary = fieldosVpRunStructuredSummary_(aggregated, {
      job_sheet_id: jobSheetId,
      recordingCount: aggregateMeta.recordingCount,
      characterCount: aggregateMeta.characterCount
    });

    const writeback = fieldosVpBuildJobSheetSummaryWriteback_(summary, aggregated);
    const completedStatus =
      typeof Config !== "undefined" &&
      Config.QUEUE_STATUS &&
      Config.QUEUE_STATUS.COMPLETED
        ? Config.QUEUE_STATUS.COMPLETED
        : "Completed";

    if (typeof JobSheetRepository !== "undefined" && JobSheetRepository.update) {
      // Atomic structured writeback + Completed. Does not touch manager_notes / approval_status.
      JobSheetRepository.update(jobSheetId, {
        ai_transcript: writeback.ai_transcript,
        ai_summary: writeback.ai_summary,
        client_requests: writeback.client_requests,
        variations: writeback.variations,
        safety_issues: writeback.safety_issues,
        manager_review_items: writeback.manager_review_items,
        weather: writeback.weather,
        travel_time: writeback.travel_time,
        ai_confidence_score: writeback.ai_confidence_score,
        processing_status: completedStatus,
        processing_error: ""
      });
    }

    return aggregated;
  }
};

/**
 * AppSheet / editor entry: same OpenAI transcription path (no Gemini).
 */
function triggerVoiceProcessing(jobSheetId) {
  if (!jobSheetId || typeof jobSheetId !== "string") {
    jobSheetId = "bcedd86f";
  }
  return VoiceProcessingService.processJobSheetRecordings(jobSheetId);
}
