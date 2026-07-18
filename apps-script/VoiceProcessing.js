/**
 * VoiceProcessing.gs
 * Processes multi-source voice dictations from 'tbl_recordings'.
 * Transcribes audio file inputs using the Gemini API, handles relational mapping,
 * and pushes structural logs out to 'tbl_ai_audit'.
 */

const VoiceProcessingService = {

  /**
   * Safe getter for the spreadsheet instance.
   */
  _getSpreadsheet: function() {
    const propId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
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
    return data.map((row, idx) => {
      let obj = { _sheetRowIndex: idx + 2 }; // Account for header and 0-index offset
      headers.forEach((h, i) => obj[h] = row[i]);
      return obj;
    });
  },

  /**
   * Main Orchestrator: Processes all unprocessed recordings for a given Job Sheet ID.
   * @param {string} jobSheetId - The targeted job sheet cross-reference ID.
   */
  processJobSheetRecordings: function(jobSheetId) {
    if (!jobSheetId) throw new Error("Missing required parameter: jobSheetId");
    Logger.log(`Starting voice processing routine for Job Sheet ID: ${jobSheetId}`);
    
    const ss = this._getSpreadsheet();
    const recordings = this._getRecords(ss, 'tbl_recordings');
    
    // Filter out all recordings linked to this job sheet
    const targetRecordings = recordings.filter(r => String(r.job_sheet_id) === String(jobSheetId));
    if (targetRecordings.length === 0) {
      Logger.log(`No recordings found in 'tbl_recordings' for Job Sheet ID: ${jobSheetId}`);
      return "NO_RECORDINGS";
    }

    let combinedTranscripts = [];

    // 1. Loop through and transcribe any unprocessed files
    targetRecordings.forEach(recording => {
      if (recording.transcription && String(recording.transcription).trim() !== "" && recording.status === "Processed") {
        Logger.log(`Recording ${recording.recording_id} already processed. Skipping API call.`);
        combinedTranscripts.push(recording.transcription);
      } else {
        Logger.log(`Processing fresh audio file for Recording ID: ${recording.recording_id}`);
        
        try {
          const transcript = this._transcribeAudioFile(recording.audio_file || recording.file_path);
          
          // Update the specific recording row inline
          this._updateRowValue(ss, 'tbl_recordings', recording._sheetRowIndex, {
            'transcription': transcript,
            'status': 'Processed'
          });
          
          combinedTranscripts.push(transcript);
        } catch (err) {
          Logger.log(`Failed to process Recording ID ${recording.recording_id}: ${err.message}`);
          this._updateRowValue(ss, 'tbl_recordings', recording._sheetRowIndex, { 'status': 'Error: Transcription Failed' });
        }
      }
    });

    if (combinedTranscripts.length === 0) {
      throw new Error("No successful transcriptions could be aggregated.");
    }

    // 2. Compile aggregated transcript text block
    const fullTranscriptBody = combinedTranscripts.join("\n\n--- Next Recording Segment ---\n\n");
    Logger.log("Transcriptions successfully aggregated. Shipping payload to AI Audit Engine.");

    // 3. Log data transmission block into tbl_ai_audit
    this._logToAiAudit(ss, jobSheetId, fullTranscriptBody);

    return fullTranscriptBody;
  },

  /**
   * Internal Method: Resolves relative AppSheet file links to Drive files and calls the Gemini API.
   */
  _transcribeAudioFile: function(filePath) {
    if (!filePath) throw new Error("Recording record is missing an audio file path asset.");
    
    // Resolve standard AppSheet default naming structures from Drive root
    let file;
    try {
      // Strips potential leading system cleanup markers
      const cleanPath = filePath.replace(/^'|'$/g, "").trim();
      const files = DriveApp.getFilesByName(cleanPath.split('/').pop());
      if (files.hasNext()) {
        file = files.next();
      } else {
        throw new Error(`File asset not found in Google Drive: ${cleanPath}`);
      }
    } catch(e) {
      throw new Error(`Google Drive Storage Engine resolve failure: ${e.message}`);
    }

    const blob = file.getBlob();
    const base64AudioData = Utilities.base64Encode(blob.getBytes());
    const mimeType = blob.getContentType() || "audio/mp3";

    // Call out to Gemini API Engine using native multimodal capacities
    const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) throw new Error("Systems Integration Error: 'GEMINI_API_KEY' script property is missing.");

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    
    const payload = {
      "contents": [{
        "parts": [
          { "text": "Provide an exact, clean transcription of this field voice dictation log. Do not add commentary or summarize yet, output verbatim text logs only." },
          {
            "inlineData": {
              "mimeType": mimeType,
              "data": base64AudioData
            }
          }
        ]
      }]
    };

    const options = {
      "method": "post",
      "contentType": "application/json",
      "payload": JSON.stringify(payload),
      "muteHttpExceptions": true
    };

    const response = UrlFetchApp.fetch(apiUrl, options);
    const responseCode = response.getResponseCode();
    const responseBody = response.getContentText();

    if (responseCode !== 200) {
      throw new Error(`Gemini API Endpoint Execution Failure (Status: ${responseCode}): ${responseBody}`);
    }

    const json = JSON.parse(responseBody);
    if (!json.candidates || !json.candidates[0].content || !json.candidates[0].content.parts) {
      throw new Error("Malformed JSON response packet parsed from Gemini transcription endpoint.");
    }

    return json.candidates[0].content.parts[0].text;
  },

  /**
   * Internal Method: Commits dynamic transcription arrays to the AI Audit ledger sheet.
   */
  _logToAiAudit: function(ss, jobSheetId, aggregatedText) {
    const auditSheet = ss.getSheetByName('tbl_ai_audit');
    if (!auditSheet) throw new Error("Architecture Verification Error: Sheet 'tbl_ai_audit' missing.");

    const headers = auditSheet.getDataRange().getValues()[0];
    const newId = `AUDIT_${Utilities.getUuid()}`;
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
    
    const requestPayloadString = `Analyze this voice dictation transcript compilation for Job Sheet ID ${jobSheetId}:\n"${aggregatedText}"`;

    // Map properties dynamically to exact schema columns matching UI views
    const newRow = headers.map(header => {
      switch(String(header).trim().toLowerCase()) {
        case 'audit_id': return newId;
        case 'job_sheet_id': return jobSheetId;
        case 'request_payload': return requestPayloadString;
        case 'response_payload': return "PENDING_ANALYSIS";
        case 'timestamp': return timestamp;
        default: return "";
      }
    });

    auditSheet.appendRow(newRow);
    Logger.log(`Successfully committed operational record entry payload to 'tbl_ai_audit' ledger.`);
  },

  /**
   * Internal Method: Self-healing inline column updating tool.
   */
  _updateRowValue: function(ss, tableName, rowIndex, columnKeyValuePairs) {
    const sheet = ss.getSheetByName(tableName);
    const headers = sheet.getDataRange().getValues()[0].map(h => String(h).trim().toLowerCase());

    Object.keys(columnKeyValuePairs).forEach(key => {
      const colIndex = headers.indexOf(String(key).trim().toLowerCase()) + 1;
      if (colIndex > 0) {
        sheet.getRange(rowIndex, colIndex).setValue(columnKeyValuePairs[key]);
      }
    });
  }
};

/**
 * AppSheet Webhook / Bot Execution Automation Target Gateway
 */
function triggerVoiceProcessing(jobSheetId) {
  // Graceful handling for manual test operations inside the script runner console
  if (!jobSheetId || typeof jobSheetId !== 'string') {
    jobSheetId = "bcedd86f"; 
  }
  return VoiceProcessingService.processJobSheetRecordings(jobSheetId);
}