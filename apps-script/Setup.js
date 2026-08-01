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
    const jobColumnsToAdd = [
      "approval_status",
      "manager_notes",
      "approved_by",
      "approved_at",
      "returned_by",
      "returned_at",
      "return_reason"
    ];
    let nextCol = lastCol + 1;
    jobColumnsToAdd.forEach(function (colName) {
      if (headers.includes(colName)) {
        Logger.log("Notice [tbl_job_sheets]: '" + colName + "' column already exists. Skipping.");
        return;
      }
      const targetCell = jobSheet.getRange(1, nextCol);
      targetCell.setValue(colName);
      targetCell
        .setFontWeight("bold")
        .setBackground("#f3f3f3")
        .setHorizontalAlignment("left");
      jobSheet.autoResizeColumns(nextCol, 1);
      Logger.log("Success [tbl_job_sheets]: Added column -> " + colName);
      nextCol += 1;
    });
  } else {
    Logger.log("Error: 'tbl_job_sheets' tab not found. Check your sheet name spelling.");
  }
  
  Logger.log("Migration sequence completed successfully.");
}

/**
 * Phase 3C: ensure job-completion sheets exist with required headers.
 * Non-destructive — creates missing tabs and appends missing columns only.
 * Does not invent pricing columns.
 */
function migrateSchemaForJobCompletion() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!spreadsheetId) {
    throw new Error("Migration Error: 'SPREADSHEET_ID' script property is missing or blank in Project Settings.");
  }
  const ss = SpreadsheetApp.openById(spreadsheetId);

  function ensureTable(sheetName, columns) {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
      sheet
        .getRange(1, 1, 1, columns.length)
        .setFontWeight("bold")
        .setBackground("#f3f3f3")
        .setHorizontalAlignment("left");
      sheet.autoResizeColumns(1, columns.length);
      Logger.log("Success [" + sheetName + "]: Created sheet with headers.");
      return;
    }
    const lastCol = sheet.getLastColumn();
    const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    let nextCol = lastCol + 1;
    columns.forEach(function (colName) {
      if (headers.indexOf(colName) >= 0) {
        Logger.log("Notice [" + sheetName + "]: '" + colName + "' already exists. Skipping.");
        return;
      }
      const cell = sheet.getRange(1, nextCol);
      cell.setValue(colName);
      cell.setFontWeight("bold").setBackground("#f3f3f3").setHorizontalAlignment("left");
      sheet.autoResizeColumns(nextCol, 1);
      Logger.log("Success [" + sheetName + "]: Added column -> " + colName);
      nextCol += 1;
    });
  }

  ensureTable("tbl_job_completions", FIELDOS_COMPLETION_HEADERS_);
  ensureTable("tbl_job_labour", FIELDOS_LABOUR_HEADERS_);
  ensureTable("tbl_job_machinery", FIELDOS_MACHINERY_HEADERS_);
  ensureTable("tbl_job_materials", FIELDOS_MATERIAL_HEADERS_);
  Logger.log("Phase 3C job completion migration completed.");
}
/**
 * Phase 3D: ensure export-batch sheets exist with required headers.
 * Non-destructive — creates missing tabs and appends missing columns only.
 */
function migrateSchemaForCompletionExports() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!spreadsheetId) {
    throw new Error("Migration Error: 'SPREADSHEET_ID' script property is missing or blank in Project Settings.");
  }
  const ss = SpreadsheetApp.openById(spreadsheetId);

  function ensureTable(sheetName, columns) {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
      sheet
        .getRange(1, 1, 1, columns.length)
        .setFontWeight("bold")
        .setBackground("#f3f3f3")
        .setHorizontalAlignment("left");
      sheet.autoResizeColumns(1, columns.length);
      Logger.log("Success [" + sheetName + "]: Created sheet with headers.");
      return;
    }
    const lastCol = sheet.getLastColumn();
    const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    let nextCol = lastCol + 1;
    columns.forEach(function (colName) {
      if (headers.indexOf(colName) >= 0) {
        Logger.log("Notice [" + sheetName + "]: '" + colName + "' already exists. Skipping.");
        return;
      }
      const cell = sheet.getRange(1, nextCol);
      cell.setValue(colName);
      cell.setFontWeight("bold").setBackground("#f3f3f3").setHorizontalAlignment("left");
      sheet.autoResizeColumns(nextCol, 1);
      Logger.log("Success [" + sheetName + "]: Added column -> " + colName);
      nextCol += 1;
    });
  }

  ensureTable("tbl_export_batches", FIELDOS_EXPORT_BATCH_HEADERS_);
  ensureTable("tbl_export_batch_items", FIELDOS_EXPORT_ITEM_HEADERS_);
  Logger.log("Phase 3D completion export migration completed.");
}

/**
 * Phase 3E: ensure rates / financial mapping / pricing snapshot sheets exist.
 * Non-destructive — creates missing tabs and appends missing columns only.
 * Does not write rate values; pricing data is entered by managers.
 *
 * Header arrays are defined inline so this migration works even when
 * RatesFinancial.js has not yet been pushed into the Apps Script project.
 * Keep these lists in sync with FIELDOS_*_HEADERS_ in RatesFinancial.js
 * (and the material catalog link columns in JobCompletion.js).
 */
function migrateSchemaForRatesFinancial() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!spreadsheetId) {
    throw new Error("Migration Error: 'SPREADSHEET_ID' script property is missing or blank in Project Settings.");
  }
  const ss = SpreadsheetApp.openById(spreadsheetId);

  const rateCardHeaders = [
    "rate_card_id",
    "card_name",
    "description",
    "currency",
    "status",
    "effective_from",
    "effective_to",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "version"
  ];
  const labourRateHeaders = [
    "labour_rate_id",
    "rate_card_id",
    "staff_id",
    "customer_id",
    "project_id",
    "role_code",
    "activity_code",
    "unit",
    "sell_rate",
    "cost_rate",
    "travel_rate",
    "overtime_rate",
    "status",
    "effective_from",
    "effective_to",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "version"
  ];
  const machineryRateHeaders = [
    "machinery_rate_id",
    "rate_card_id",
    "equipment_id",
    "equipment_name",
    "charge_code",
    "unit",
    "sell_rate",
    "cost_rate",
    "minimum_charge",
    "status",
    "effective_from",
    "effective_to",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "version"
  ];
  const materialCatalogHeaders = [
    "material_id",
    "item_code",
    "item_name",
    "description",
    "unit",
    "cost_price",
    "sell_price",
    "tax_code",
    "account_code",
    "supplier",
    "active",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "version"
  ];
  const customerPricingHeaders = [
    "customer_pricing_id",
    "customer_id",
    "project_id",
    "rate_card_id",
    "price_notes",
    "status",
    "effective_from",
    "effective_to",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "version"
  ];
  const payrollMappingHeaders = [
    "payroll_mapping_id",
    "staff_id",
    "employee_reference",
    "ordinary_hours_code",
    "overtime_hours_code",
    "travel_hours_code",
    "allowance_code",
    "cost_centre",
    "pay_calendar",
    "employment_classification",
    "award_reference",
    "status",
    "effective_from",
    "effective_to",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "version"
  ];
  const xeroMappingHeaders = [
    "xero_mapping_id",
    "entity_type",
    "local_reference",
    "xero_reference",
    "account_code",
    "tax_type",
    "tax_rate_percent",
    "tracking_category",
    "tracking_option",
    "status",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "version"
  ];
  const completionFinancialHeaders = [
    "financial_snapshot_id",
    "completion_id",
    "job_sheet_id",
    "customer_id",
    "project_id",
    "job_date",
    "currency",
    "snapshot_status",
    "pricing_status",
    "rate_card_id",
    "line_count",
    "subtotal_ex_tax",
    "tax_amount",
    "total_inc_tax",
    "tax_type",
    "tax_rate_percent",
    "account_code",
    "draft_reference",
    "xero_reference",
    "blockers",
    "notes",
    "created_by",
    "created_at",
    "validated_by",
    "validated_at",
    "approved_by",
    "approved_at",
    "superseded_by",
    "superseded_at",
    "version"
  ];
  const completionFinancialLineHeaders = [
    "financial_line_id",
    "financial_snapshot_id",
    "completion_id",
    "line_number",
    "line_type",
    "source_row_id",
    "description",
    "staff_id",
    "equipment_id",
    "material_id",
    "quantity",
    "unit",
    "unit_sell",
    "line_amount_ex_tax",
    "tax_type",
    "tax_rate_percent",
    "tax_amount",
    "line_total_inc_tax",
    "account_code",
    "rate_source_type",
    "rate_source_id",
    "billable",
    "non_billable_reason",
    "blockers",
    "created_at"
  ];
  // Additive columns only — full Phase 3C material header set lives in JobCompletion.js.
  const jobMaterialLinkHeaders = [
    "material_entry_id",
    "completion_id",
    "job_sheet_id",
    "item_name",
    "catalog_material_id",
    "item_code",
    "quantity",
    "unit",
    "billable",
    "confirmation_status",
    "notes",
    "source",
    "created_at",
    "updated_at"
  ];

  function ensureTable(sheetName, columns) {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
      sheet
        .getRange(1, 1, 1, columns.length)
        .setFontWeight("bold")
        .setBackground("#f3f3f3")
        .setHorizontalAlignment("left");
      sheet.autoResizeColumns(1, columns.length);
      Logger.log("Success [" + sheetName + "]: Created sheet with headers.");
      return;
    }
    const lastCol = sheet.getLastColumn();
    const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    let nextCol = lastCol + 1;
    columns.forEach(function (colName) {
      if (headers.indexOf(colName) >= 0) {
        Logger.log("Notice [" + sheetName + "]: '" + colName + "' already exists. Skipping.");
        return;
      }
      const cell = sheet.getRange(1, nextCol);
      cell.setValue(colName);
      cell.setFontWeight("bold").setBackground("#f3f3f3").setHorizontalAlignment("left");
      sheet.autoResizeColumns(nextCol, 1);
      Logger.log("Success [" + sheetName + "]: Added column -> " + colName);
      nextCol += 1;
    });
  }

  ensureTable("tbl_rate_cards", rateCardHeaders);
  ensureTable("tbl_labour_rates", labourRateHeaders);
  ensureTable("tbl_machinery_rates", machineryRateHeaders);
  ensureTable("tbl_material_catalog", materialCatalogHeaders);
  ensureTable("tbl_customer_pricing", customerPricingHeaders);
  ensureTable("tbl_payroll_mappings", payrollMappingHeaders);
  ensureTable("tbl_xero_mappings", xeroMappingHeaders);
  ensureTable("tbl_completion_financials", completionFinancialHeaders);
  ensureTable("tbl_completion_financial_lines", completionFinancialLineHeaders);
  ensureTable("tbl_job_materials", jobMaterialLinkHeaders);
  Logger.log("Phase 3E rates and financial migration completed.");
}

/**
 * Phase 3F: ensure job report batch sheets exist.
 * Non-destructive — creates missing tabs and appends missing columns only.
 * Stores report data only: no PDF bytes, transcripts, Drive IDs or secrets.
 *
 * Header arrays are defined inline so this migration works even when
 * JobReports.js has not yet been pushed into the Apps Script project.
 * Keep these lists in sync with FIELDOS_REPORT_BATCH_HEADERS_ and
 * FIELDOS_REPORT_ITEM_HEADERS_ in JobReports.js.
 */
function migrateSchemaForJobReports() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!spreadsheetId) {
    throw new Error("Migration Error: 'SPREADSHEET_ID' script property is missing or blank in Project Settings.");
  }
  const ss = SpreadsheetApp.openById(spreadsheetId);

  const reportBatchHeaders = [
    "report_batch_id",
    "report_type",
    "date_from",
    "date_to",
    "filter_json",
    "group_by",
    "status",
    "record_count",
    "line_count",
    "group_count",
    "estimated_pages",
    "template_version",
    "scope_staff_id",
    "created_by",
    "created_at",
    "validated_by",
    "validated_at",
    "completed_at",
    "file_name",
    "checksum",
    "blocker_summary",
    "notes",
    "snapshot_json",
    "version"
  ];
  const reportBatchItemHeaders = [
    "report_batch_item_id",
    "report_batch_id",
    "job_sheet_id",
    "completion_id",
    "group_key",
    "group_label",
    "sort_order",
    "item_status",
    "line_count",
    "blocker_summary",
    "created_at"
  ];

  function ensureTable(sheetName, columns) {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
      sheet
        .getRange(1, 1, 1, columns.length)
        .setFontWeight("bold")
        .setBackground("#f3f3f3")
        .setHorizontalAlignment("left");
      sheet.autoResizeColumns(1, columns.length);
      Logger.log("Success [" + sheetName + "]: Created sheet with headers.");
      return;
    }
    const lastCol = sheet.getLastColumn();
    const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    let nextCol = lastCol + 1;
    columns.forEach(function (colName) {
      if (headers.indexOf(colName) >= 0) {
        Logger.log("Notice [" + sheetName + "]: '" + colName + "' already exists. Skipping.");
        return;
      }
      const cell = sheet.getRange(1, nextCol);
      cell.setValue(colName);
      cell.setFontWeight("bold").setBackground("#f3f3f3").setHorizontalAlignment("left");
      sheet.autoResizeColumns(nextCol, 1);
      Logger.log("Success [" + sheetName + "]: Added column -> " + colName);
      nextCol += 1;
    });
  }

  ensureTable("tbl_report_batches", reportBatchHeaders);
  ensureTable("tbl_report_batch_items", reportBatchItemHeaders);
  Logger.log("Phase 3F job report migration completed.");
}

/**
 * Phase 3G: document deliveries + job attachments.
 * Non-destructive. Stores delivery metadata and attachment metadata only —
 * never PDF bytes, public Drive links, transcripts, or secrets.
 * Keep headers in sync with FIELDOS_DELIVERY_HEADERS_ / FIELDOS_ATTACHMENT_HEADERS_.
 */
function migrateSchemaForDocumentDelivery() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!spreadsheetId) {
    throw new Error("Migration Error: 'SPREADSHEET_ID' script property is missing or blank in Project Settings.");
  }
  const ss = SpreadsheetApp.openById(spreadsheetId);

  const deliveryHeaders = [
    "delivery_id",
    "report_batch_id",
    "job_sheet_id",
    "completion_id",
    "document_type",
    "recipient_type",
    "recipient_email",
    "delivery_method",
    "status",
    "sent_by",
    "sent_at",
    "failed_at",
    "failure_reason",
    "checksum",
    "template_version",
    "supersedes_delivery_id",
    "idempotency_key",
    "drive_file_id",
    "attachment_ids_json",
    "subject",
    "body_preview",
    "created_by",
    "created_at",
    "version"
  ];
  const attachmentHeaders = [
    "attachment_id",
    "job_sheet_id",
    "completion_id",
    "attachment_type",
    "file_name",
    "mime_type",
    "byte_size",
    "caption",
    "uploaded_by",
    "uploaded_at",
    "client_visible",
    "approved_by",
    "approved_at",
    "storage_ref",
    "checksum",
    "status",
    "version"
  ];

  function ensureTable(sheetName, columns) {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
      sheet
        .getRange(1, 1, 1, columns.length)
        .setFontWeight("bold")
        .setBackground("#f3f3f3")
        .setHorizontalAlignment("left");
      sheet.autoResizeColumns(1, columns.length);
      Logger.log("Success [" + sheetName + "]: Created sheet with headers.");
      return;
    }
    const lastCol = sheet.getLastColumn();
    const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    let nextCol = lastCol + 1;
    columns.forEach(function (colName) {
      if (headers.indexOf(colName) >= 0) {
        Logger.log("Notice [" + sheetName + "]: '" + colName + "' already exists. Skipping.");
        return;
      }
      const cell = sheet.getRange(1, nextCol);
      cell.setValue(colName);
      cell.setFontWeight("bold").setBackground("#f3f3f3").setHorizontalAlignment("left");
      sheet.autoResizeColumns(nextCol, 1);
      Logger.log("Success [" + sheetName + "]: Added column -> " + colName);
      nextCol += 1;
    });
  }

  ensureTable("tbl_document_deliveries", deliveryHeaders);
  ensureTable("tbl_job_attachments", attachmentHeaders);
  Logger.log("Phase 3G document delivery migration completed.");
}

/**
 * Create Job from Recording — link + idempotency tables.
 * Does not modify tbl_job_sheets headers.
 */
function migrateSchemaForCreateJobFromRecording() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!spreadsheetId) {
    throw new Error("Migration Error: 'SPREADSHEET_ID' script property is missing or blank in Project Settings.");
  }
  const ss = SpreadsheetApp.openById(spreadsheetId);

  const linkHeaders = [
    "link_id",
    "job_sheet_id",
    "recording_id",
    "transcript_id",
    "created_at",
    "created_by"
  ];
  const idempotencyHeaders = [
    "idempotency_key",
    "payload_hash",
    "job_sheet_id",
    "recording_id",
    "created_by",
    "created_at"
  ];

  function ensureTable(sheetName, columns) {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
      sheet
        .getRange(1, 1, 1, columns.length)
        .setFontWeight("bold")
        .setBackground("#f3f3f3")
        .setHorizontalAlignment("left");
      sheet.autoResizeColumns(1, columns.length);
      Logger.log("Success [" + sheetName + "]: Created sheet with headers.");
      return;
    }
    const lastCol = sheet.getLastColumn();
    const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    let nextCol = lastCol + 1;
    columns.forEach(function (colName) {
      if (headers.indexOf(colName) >= 0) {
        Logger.log("Notice [" + sheetName + "]: '" + colName + "' already exists. Skipping.");
        return;
      }
      const cell = sheet.getRange(1, nextCol);
      cell.setValue(colName);
      cell.setFontWeight("bold").setBackground("#f3f3f3").setHorizontalAlignment("left");
      sheet.autoResizeColumns(nextCol, 1);
      Logger.log("Success [" + sheetName + "]: Added column -> " + colName);
      nextCol += 1;
    });
  }

  ensureTable("tbl_job_recording_links", linkHeaders);
  ensureTable("tbl_new_job_from_recording_keys", idempotencyHeaders);
  Logger.log("Create Job from Recording migration completed.");
}

/**
 * Daily Work Job Sheet — session metadata + idempotency + link columns.
 * Does not modify tbl_job_sheets headers.
 * Staging ownership: FastAPI owns full session/audio/transcript/extraction state;
 * Sheets tbl_daily_work_sessions holds create-time metadata only.
 */
function migrateSchemaForDailyWorkSessions() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!spreadsheetId) {
    throw new Error("Migration Error: 'SPREADSHEET_ID' script property is missing or blank in Project Settings.");
  }
  const ss = SpreadsheetApp.openById(spreadsheetId);

  const sessionHeaders = [
    "work_session_id",
    "work_date",
    "project_id",
    "staff_ids",
    "status",
    "extraction_json_ref",
    "created_at",
    "created_by",
    "updated_at",
    "version",
    "created_job_sheet_id"
  ];
  const idempotencyHeaders = [
    "idempotency_key",
    "payload_hash",
    "job_sheet_id",
    "work_session_id",
    "created_by",
    "created_at",
    "links_json"
  ];
  const linkExtraHeaders = [
    "link_id",
    "job_sheet_id",
    "recording_id",
    "transcript_id",
    "work_session_id",
    "sequence",
    "created_at",
    "created_by"
  ];

  function ensureTable(sheetName, columns) {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
      sheet
        .getRange(1, 1, 1, columns.length)
        .setFontWeight("bold")
        .setBackground("#f3f3f3")
        .setHorizontalAlignment("left");
      sheet.autoResizeColumns(1, columns.length);
      Logger.log("Success [" + sheetName + "]: Created sheet with headers.");
      return;
    }
    const lastCol = sheet.getLastColumn();
    const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    let nextCol = lastCol + 1;
    columns.forEach(function (colName) {
      if (headers.indexOf(colName) >= 0) {
        Logger.log("Notice [" + sheetName + "]: '" + colName + "' already exists. Skipping.");
        return;
      }
      const cell = sheet.getRange(1, nextCol);
      cell.setValue(colName);
      cell.setFontWeight("bold").setBackground("#f3f3f3").setHorizontalAlignment("left");
      sheet.autoResizeColumns(nextCol, 1);
      Logger.log("Success [" + sheetName + "]: Added column -> " + colName);
      nextCol += 1;
    });
  }

  ensureTable("tbl_daily_work_sessions", sessionHeaders);
  ensureTable("tbl_daily_work_create_keys", idempotencyHeaders);
  ensureTable("tbl_job_recording_links", linkExtraHeaders);
  Logger.log("Daily Work Job Sheet migration completed.");
}
