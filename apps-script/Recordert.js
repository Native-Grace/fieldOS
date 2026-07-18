function serveRecorder_(e) {
  const jobSheetId = String(e.parameter.job_sheet_id || '').trim();
  const userIdentity = String(e.parameter.user_identity || '').trim();

  if (!jobSheetId) {
    return HtmlService.createHtmlOutput('Missing job_sheet_id');
  }

  const jobSheet = JobSheetRepository.findById(jobSheetId);

  if (!jobSheet) {
    return HtmlService.createHtmlOutput('Job sheet not found');
  }

  const template = HtmlService.createTemplateFromFile('Recorder');
  template.jobSheetId = jobSheetId;
  template.userIdentity = userIdentity;

  return template
    .evaluate()
    .setTitle('Record Voice Note')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function saveRecording(payload) {
  if (!payload) throw new Error('Missing payload');

  const jobSheetId = String(payload.job_sheet_id || '').trim();
  const userIdentity = String(payload.user_identity || '').trim();
  const base64Audio = String(payload.base64_audio || '').trim();
  const mimeType = String(payload.mime_type || 'audio/webm').trim();
  const durationSeconds = Number(payload.duration_seconds || 0);

  if (!jobSheetId) throw new Error('Missing job_sheet_id');
  if (!base64Audio) throw new Error('Missing audio data');

  const jobSheet = JobSheetRepository.findById(jobSheetId);
  if (!jobSheet) throw new Error('Job sheet not found');

  const existing = RecordingRepository.find({ job_sheet_id: jobSheetId }) || [];
  const nextOrder = existing.length + 1;

  const recordingId = Utilities.generateId('REC');

  const bytes = Utilities.base64Decode(base64Audio);
  const blob = Utilities.newBlob(
    bytes,
    mimeType,
    `${recordingId}.webm`
  );

  const folder = getOrCreateRecordingsFolder_();
  const file = folder.createFile(blob);
  file.setName(`${jobSheetId}_${recordingId}.webm`);

  const row = {
    recording_id: recordingId,
    job_sheet_id: jobSheetId,
    recording_file_url: file.getUrl(),
    recording_drive_file_id: file.getId(),
    recording_name: file.getName(),
    recording_order: nextOrder,
    duration_seconds: durationSeconds,
    transcript: '',
    status: 'Saved',
    created_by: userIdentity,
    created_at: new Date()
  };

  RecordingRepository.create(row);

  return {
    success: true,
    recording_id: recordingId,
    recording_file_url: file.getUrl(),
    recording_drive_file_id: file.getId(),
    recording_order: nextOrder
  };
}

function getOrCreateRecordingsFolder_() {
  const folderName = 'Native Grace FieldOS Recordings';
  const folders = DriveApp.getFoldersByName(folderName);

  if (folders.hasNext()) {
    return folders.next();
  }

  return DriveApp.createFolder(folderName);
}