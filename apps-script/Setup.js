/**
 * Migration Utility: Updates database schemas for Phase 1 of the Approval Workflow.
 * Safely appends missing tracking columns to the far right of header rows.
 */
function migrateSchemaForManagerApproval() {
  // 1. Grab your spreadsheet ID from your environment properties
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  
  if (!spreadsheetId) {
    throw new Error("Migration Error: 'SPREADSHEET_ID' script property is missing or blank in Project Settings.");
  }
  
  const ss = SpreadsheetApp.openById(spreadsheetId);
  
  // -------------------------------------------------------------
  // PART 1: Update tbl_daily_job_summaries
  // -------------------------------------------------------------
  const summarySheet = ss.getSheetByName('tbl_daily_job_summaries');
  if (summarySheet) {
    const lastCol = summarySheet.getLastColumn();
    // Get existing headers (handle empty sheet edge-case safely)
    const headers = lastCol > 0 ? summarySheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    
    let summaryColumnsToAdd = [];
    if (!headers.includes('approved_by')) summaryColumnsToAdd.push('approved_by');
    if (!headers.includes('approved_at')) summaryColumnsToAdd.push('approved_at');
    
    if (summaryColumnsToAdd.length > 0) {
      const targetRange = summarySheet.getRange(1, lastCol + 1, 1, summaryColumnsToAdd.length);
      targetRange.setValues([summaryColumnsToAdd]);
      
      // Apply standard formatting styles matching your layout rules
      targetRange.setFontWeight("bold")
                 .setBackground("#f3f3f3")
                 .setHorizontalAlignment("left");
                 
      summarySheet.autoResizeColumns(lastCol + 1, summaryColumnsToAdd.length);
      Logger.log(`Success [tbl_daily_job_summaries]: Added columns -> ${summaryColumnsToAdd.join(', ')}`);
    } else {
      Logger.log("Notice [tbl_daily_job_summaries]: Approval columns already exist. Skipping.");
    }
  } else {
    Logger.log("Error: 'tbl_daily_job_summaries' tab not found. Please run your table creation script first.");
  }

  // -------------------------------------------------------------
  // PART 2: Update tbl_job_sheets
  // -------------------------------------------------------------
  const jobSheet = ss.getSheetByName('tbl_job_sheets');
  if (jobSheet) {
    const lastCol = jobSheet.getLastColumn();
    const headers = lastCol > 0 ? jobSheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    
    if (!headers.includes('approval_status')) {
      const targetCell = jobSheet.getRange(1, lastCol + 1);
      targetCell.setValue('approval_status');
      
      targetCell.setFontWeight("bold")
                .setBackground("#f3f3f3")
                .setHorizontalAlignment("left");
                
      jobSheet.autoResizeColumns(lastCol + 1, 1);
      Logger.log("Success [tbl_job_sheets]: Added column -> approval_status");
    } else {
      Logger.log("Notice [tbl_job_sheets]: 'approval_status' column already exists. Skipping.");
    }
  } else {
    Logger.log("Error: 'tbl_job_sheets' tab not found. Check your sheet name spelling.");
  }
  
  Logger.log("Migration sequence completed successfully.");
}