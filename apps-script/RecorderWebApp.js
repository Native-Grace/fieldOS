/**
 * RecorderWebApp.gs
 * Serves the custom audio recorder and saves recordings to Drive + tbl_recordings.
 */

function doGet(e) {
  const template = HtmlService.createTemplateFromFile('Recorder');

  template.jobSheetId = e.parameter.job_sheet_id || "";
  template.userIdentity = e.parameter.user_identity || "";
  template.returnUrl = e.parameter.return_url || "";

  return template
    .evaluate()
    .setTitle("Native Grace Recorder")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Saves a base64 webm audio recording to Google Drive and creates tbl_recordings row.
 */
function saveRecording(payload) {
  try {
    if (!payload) throw new Error("Missing save payload.");
    if (!payload.job_sheet_id) throw new Error("Missing job_sheet_id.");
    if (!payload.audio_base64) throw new Error("Missing audio_base64.");

    const jobSheetId = payload.job_sheet_id;
    const userIdentity = payload.user_identity || "";
    const durationSeconds = Number(payload.duration_seconds || 0);

    const folderId = Config.get("RECORDINGS_FOLDER_ID");
    const folder = DriveApp.getFolderById(folderId);

    const existingRecordings = RecordingRepository.find({
      job_sheet_id: jobSheetId
    });

    const recordingOrder = existingRecordings.length + 1;

    const timestamp = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      "yyyyMMdd-HHmmss"
    );

    const recordingName = `JS-${jobSheetId}-REC-${recordingOrder}-${timestamp}.webm`;

    const audioBytes = Utilities.base64Decode(payload.audio_base64);
    const blob = Utilities.newBlob(audioBytes, "audio/webm", recordingName);

    const file = folder.createFile(blob);

    const recording = RecordingRepository.create({
      job_sheet_id: jobSheetId,
      recording_file_url: file.getUrl(),
      recording_drive_file_id: file.getId(),
      recording_name: recordingName,
      recording_order: recordingOrder,
      duration_seconds: durationSeconds,
      transcript: "",
      status: "Saved",
      created_by: userIdentity,
      created_at: new Date()
    });

    SyncRepository.create({
      record_id: jobSheetId,
      target_system: "Recorder_Web_App",
      status: "Success",
      request_payload: JSON.stringify({
        job_sheet_id: jobSheetId,
        user_identity: userIdentity,
        duration_seconds: durationSeconds
      }),
      response_payload: JSON.stringify(recording),
      timestamp: new Date()
    });

    return {
      status: "Success",
      message: "Recording saved.",
      recording_id: recording.recording_id,
      recording_file_url: file.getUrl(),
      recording_drive_file_id: file.getId(),
      recording_order: recordingOrder
    };

  } catch (err) {
    try {
      SyncRepository.create({
        record_id: payload && payload.job_sheet_id ? payload.job_sheet_id : "RECORDER",
        target_system: "Recorder_Web_App",
        status: "Failed",
        request_payload: JSON.stringify(payload || {}),
        response_payload: Utils.getStackTrace(err),
        timestamp: new Date()
      });
    } catch (logErr) {
      console.error(logErr);
    }

    return {
      status: "Failed",
      message: err.toString()
    };
  }
}