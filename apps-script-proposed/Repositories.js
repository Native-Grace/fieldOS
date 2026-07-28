/**
 * Repositories.gs
 * Instantiated repositories mapped strictly to the Native Grace schema.
 */

const CustomerRepository = new BaseRepository('tbl_customers', 'customer_id', 'CUST');
const ProjectRepository = new BaseRepository('tbl_projects', 'project_id', 'PROJ');
const StaffRepository = new BaseRepository('tbl_staff', 'staff_id', 'STAFF');
const TaskRepository = new BaseRepository('tbl_tasks', 'task_id', 'TASK');
const JobSheetRepository = new BaseRepository('tbl_job_sheets', 'job_sheet_id', 'JS');
const JobSheetLineRepository = new BaseRepository('tbl_job_sheet_lines', 'line_id', 'JSL');
const MaterialRepository = new BaseRepository('tbl_materials', 'material_line_id', 'MAT');
const EquipmentRepository = new BaseRepository('tbl_equipment', 'equipment_line_id', 'EQ');
const FollowUpRepository = new BaseRepository('tbl_follow_ups', 'follow_up_id', 'FU');
const PhotoRepository = new BaseRepository('tbl_photos', 'photo_id', 'PH');
const SyncRepository = new BaseRepository('tbl_sync_logs', 'log_id', 'LOG');
const AIAuditRepository = new BaseRepository('tbl_ai_audit', 'audit_id', 'AI');
const JobCompletionRepository = new BaseRepository('tbl_job_completions', 'completion_id', 'CMP');
const JobLabourRepository = new BaseRepository('tbl_job_labour', 'labour_id', 'LAB');
const JobMachineryRepository = new BaseRepository('tbl_job_machinery', 'machinery_entry_id', 'MCH');
const JobMaterialEntryRepository = new BaseRepository('tbl_job_materials', 'material_entry_id', 'JMT');
const ExportBatchRepository = new BaseRepository('tbl_export_batches', 'export_batch_id', 'EXP');
const ExportBatchItemRepository = new BaseRepository('tbl_export_batch_items', 'export_batch_item_id', 'EXI');

// Phase 3E — rates, financial mappings and completion pricing snapshots.
const RateCardRepository = new BaseRepository('tbl_rate_cards', 'rate_card_id', 'RC');
const LabourRateRepository = new BaseRepository('tbl_labour_rates', 'labour_rate_id', 'LR');
const MachineryRateRepository = new BaseRepository('tbl_machinery_rates', 'machinery_rate_id', 'MR');
const MaterialCatalogRepository = new BaseRepository('tbl_material_catalog', 'material_id', 'MATC');
const CustomerPricingRepository = new BaseRepository('tbl_customer_pricing', 'customer_pricing_id', 'CP');
const PayrollMappingRepository = new BaseRepository('tbl_payroll_mappings', 'payroll_mapping_id', 'PM');
const XeroMappingRepository = new BaseRepository('tbl_xero_mappings', 'xero_mapping_id', 'XM');
const CompletionFinancialRepository = new BaseRepository('tbl_completion_financials', 'financial_snapshot_id', 'CFS');
const CompletionFinancialLineRepository = new BaseRepository('tbl_completion_financial_lines', 'financial_line_id', 'CFL');

// Phase 3F — job report batches and their per-job items.
const ReportBatchRepository = new BaseRepository('tbl_report_batches', 'report_batch_id', 'RPT');
const ReportBatchItemRepository = new BaseRepository('tbl_report_batch_items', 'report_batch_item_id', 'RPI');

// Phase 3G — document deliveries and job attachments.
const DocumentDeliveryRepository = new BaseRepository('tbl_document_deliveries', 'delivery_id', 'DLV');
const JobAttachmentRepository = new BaseRepository('tbl_job_attachments', 'attachment_id', 'ATT');

const RecordingRepository = new BaseRepository({
  tableName: 'tbl_recordings',
  idField: 'recording_id',
  idPrefix: 'REC'
});