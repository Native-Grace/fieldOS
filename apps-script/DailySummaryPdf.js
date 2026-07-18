/**
 * RecorderWebApp.gs
 * Opens the Native Grace recorder page from AppSheet.
 */

function doGet(e) {
  const template = HtmlService.createTemplateFromFile("Recorder");

  template.jobSheetId = e.parameter.job_sheet_id || "";
  template.userIdentity = e.parameter.user_identity || "";
  template.returnUrl = e.parameter.return_url || "";

  return template
    .evaluate()
    .setTitle("Native Grace Recorder")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}