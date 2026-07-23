/**
 * VoiceProcessing.gs
 * Processes multi-source voice dictations from 'tbl_recordings'.
 * Transcribes audio via OpenAI Whisper (OPENAI_API_KEY).
 *
 * Queue contract: VoiceProcessing.executePipeline(jobRow)
 * FieldOS recordings use transcript + recording_drive_file_id;
 * legacy AppSheet rows may use transcription + audio_file / file_path.
 *
 * Structured GPT summary / job-line writeback is intentionally out of scope
 * (chatComplete helper exists in OpenAI.js but has no production field mapping).
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
 * Stable sort by recording_order (numeric), then recording_id.
 * @param {Array<object>} recordings
 * @returns {Array<object>}
 */
function fieldosVpSortRecordingsByOrder_(recordings) {
  return (recordings || []).slice().sort(function (a, b) {
    const ao = Number(a && a.recording_order != null ? a.recording_order : NaN);
    const bo = Number(b && b.recording_order != null ? b.recording_order : NaN);
    const aOk = !isNaN(ao);
    const bOk = !isNaN(bo);
    if (aOk && bOk && ao !== bo) return ao - bo;
    if (aOk && !bOk) return -1;
    if (!aOk && bOk) return 1;
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
   * Uses OpenAI Whisper. Does not call Gemini. Does not write GPT summaries.
   * @param {string} jobSheetId
   * @returns {string} aggregated transcript body
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

    const combinedTranscripts = [];

    for (let i = 0; i < targetRecordings.length; i++) {
      const recording = targetRecordings[i];
      const recordingId = String(recording.recording_id || "");

      if (fieldosVpIsRecordingComplete_(recording)) {
        Logger.log(
          "Recording " + recordingId + " already processed. Skipping OpenAI call."
        );
        combinedTranscripts.push(fieldosVpGetTranscriptText_(recording));
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

        combinedTranscripts.push(transcript);
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

    if (combinedTranscripts.length === 0) {
      throw new Error("No successful transcriptions could be aggregated.");
    }

    const fullTranscriptBody = combinedTranscripts.join(
      "\n\n--- Next Recording Segment ---\n\n"
    );
    Logger.log(
      "OpenAI transcriptions aggregated for job_sheet_id=" +
        jobSheetId +
        " (segments=" +
        combinedTranscripts.length +
        ")."
    );
    return fullTranscriptBody;
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
      throw new Error(
        "VoiceProcessing.executePipeline: no transcript aggregated for job_sheet_id=" +
          jobSheetId +
          " (result=" +
          String(aggregated) +
          ")."
      );
    }

    if (typeof JobSheetRepository !== "undefined" && JobSheetRepository.update) {
      const completedStatus =
        typeof Config !== "undefined" &&
        Config.QUEUE_STATUS &&
        Config.QUEUE_STATUS.COMPLETED
          ? Config.QUEUE_STATUS.COMPLETED
          : "Completed";
      JobSheetRepository.update(jobSheetId, {
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
