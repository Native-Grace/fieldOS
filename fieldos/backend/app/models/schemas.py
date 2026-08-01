from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

from app.services.completion_math import (
    coerce_float_default,
    coerce_optional_float,
    normalise_material_quantity,
)


class ErrorBody(BaseModel):
    status: str = "Error"
    message: str
    detail: Optional[Any] = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1)


class StaffOut(BaseModel):
    staff_id: str
    staff_name: str
    email: EmailStr
    role: str = "Field Staff"


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    staff: StaffOut


class JobSummary(BaseModel):
    job_sheet_id: str
    job_date: Optional[date] = None
    project_name: str = ""
    customer_name: str = ""
    processing_status: str = ""
    approval_status: str = ""
    processing_error: str = ""


class JobReviewFields(BaseModel):
    """Manager review payload (ai_transcript optional / authorised)."""

    job_sheet_id: str
    job_date: Optional[date] = None
    project_name: str = ""
    customer_name: str = ""
    processing_status: str = ""
    approval_status: str = ""
    processing_error: str = ""
    processing_started_at: Optional[Union[datetime, str]] = None
    processing_completed_at: Optional[Union[datetime, str]] = None
    assigned_staff_id: str = ""
    ai_summary: str = ""
    client_requests: str = ""
    variations: str = ""
    safety_issues: str = ""
    manager_review_items: str = ""
    weather: str = ""
    travel_time: str = ""
    ai_confidence_score: Optional[float] = None
    manager_notes: str = ""
    approved_by: str = ""
    approved_at: Optional[Union[datetime, str]] = None
    returned_by: str = ""
    returned_at: Optional[Union[datetime, str]] = None
    return_reason: str = ""
    ai_transcript_character_count: int = 0
    ai_transcript: Optional[str] = None


class JobReviewResponse(BaseModel):
    job: JobReviewFields
    recordings: List[RecordingOut]
    data_mode: str
    assumptions: List[str]
    warnings: List[str] = Field(default_factory=list)
    can_edit: bool = False
    can_approve: bool = False


class ReviewEditRequest(BaseModel):
    ai_summary: Optional[str] = None
    client_requests: Optional[str] = None
    variations: Optional[str] = None
    safety_issues: Optional[str] = None
    manager_review_items: Optional[str] = None
    weather: Optional[str] = None
    travel_time: Optional[str] = None
    manager_notes: Optional[str] = None
    expected_approval_status: Optional[str] = None
    expected_processing_completed_at: Optional[str] = None


class ApproveJobRequest(ReviewEditRequest):
    pass


class ReturnJobRequest(ReviewEditRequest):
    return_reason: str = Field(min_length=1, max_length=500)


class ReopenJobRequest(BaseModel):
    expected_approval_status: Optional[str] = None
    expected_processing_completed_at: Optional[str] = None


class LabourEntry(BaseModel):
    labour_id: Optional[str] = None
    completion_id: Optional[str] = None
    job_sheet_id: Optional[str] = None
    staff_id: str = ""
    staff_name: str = ""
    work_date: Optional[str] = None
    start_time: str = ""
    finish_time: str = ""
    break_minutes: float = 0
    labour_hours: Optional[float] = None
    travel_minutes: float = 0
    travel_hours: Optional[float] = None
    role_or_activity: str = ""
    billable: bool = False
    confirmation_status: str = "Suggested"
    notes: str = ""
    source: str = ""
    created_at: Optional[Union[datetime, str]] = None
    updated_at: Optional[Union[datetime, str]] = None
    confidence: Optional[float] = None

    @field_validator("break_minutes", "travel_minutes", mode="before")
    @classmethod
    def _coerce_labour_required_floats(cls, value: Any) -> float:
        try:
            return coerce_float_default(value, 0.0)
        except ValueError as exc:
            raise ValueError("must be a number") from exc

    @field_validator("labour_hours", "travel_hours", "confidence", mode="before")
    @classmethod
    def _coerce_labour_optional_floats(cls, value: Any) -> Optional[float]:
        try:
            return coerce_optional_float(value)
        except ValueError as exc:
            raise ValueError("must be a number") from exc


class MachineryEntry(BaseModel):
    machinery_entry_id: Optional[str] = None
    completion_id: Optional[str] = None
    job_sheet_id: Optional[str] = None
    equipment_name: str = ""
    operator_staff_id: str = ""
    start_time: str = ""
    finish_time: str = ""
    duration_hours: Optional[float] = None
    billable: bool = False
    confirmation_status: str = "Suggested"
    charge_code: str = ""
    notes: str = ""
    source: str = ""
    created_at: Optional[Union[datetime, str]] = None
    updated_at: Optional[Union[datetime, str]] = None
    confidence: Optional[float] = None

    @field_validator("duration_hours", "confidence", mode="before")
    @classmethod
    def _coerce_machinery_optional_floats(cls, value: Any) -> Optional[float]:
        try:
            return coerce_optional_float(value)
        except ValueError as exc:
            raise ValueError("must be a number") from exc


class MaterialEntry(BaseModel):
    material_entry_id: Optional[str] = None
    completion_id: Optional[str] = None
    job_sheet_id: Optional[str] = None
    item_name: str = ""
    catalog_material_id: str = ""
    item_code: str = ""
    quantity: Optional[float] = None
    unit: str = ""
    billable: bool = False
    confirmation_status: str = "Suggested"
    notes: str = ""
    source: str = ""
    created_at: Optional[Union[datetime, str]] = None
    updated_at: Optional[Union[datetime, str]] = None
    confidence: Optional[float] = None

    @model_validator(mode="before")
    @classmethod
    def _coerce_material_quantity_and_unit(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        unit_in = str(out.get("unit") or "")
        normalised = normalise_material_quantity(out.get("quantity"), unit=unit_in)
        if not normalised.get("ok"):
            raise ValueError("must be a number")
        out["quantity"] = normalised.get("quantity")
        out["unit"] = str(normalised.get("unit") or unit_in)
        return out

    @field_validator("confidence", mode="before")
    @classmethod
    def _coerce_material_confidence(cls, value: Any) -> Optional[float]:
        try:
            return coerce_optional_float(value)
        except ValueError as exc:
            raise ValueError("must be a number") from exc


class JobCompletionOut(BaseModel):
    completion_id: str
    job_sheet_id: str
    completion_status: str = "Draft"
    work_summary: str = ""
    invoice_description: str = ""
    internal_notes: str = ""
    total_labour_hours: float = 0
    total_travel_hours: float = 0
    total_machinery_hours: float = 0
    billable_labour_hours: float = 0
    non_billable_labour_hours: float = 0
    variations: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    warning_resolutions: List[Dict[str, Any]] = Field(default_factory=list)
    created_by: str = ""
    created_at: Optional[Union[datetime, str]] = None
    updated_by: str = ""
    updated_at: Optional[Union[datetime, str]] = None
    finalised_by: str = ""
    finalised_at: Optional[Union[datetime, str]] = None
    reopened_by: str = ""
    reopened_at: Optional[Union[datetime, str]] = None
    reopen_reason: str = ""
    version: int = 1
    blocked: bool = False
    job_approval_status: str = ""
    job_processing_status: str = ""


class JobCompletionResponse(BaseModel):
    completion: Optional[JobCompletionOut] = None
    labour_entries: List[LabourEntry] = Field(default_factory=list)
    machinery_entries: List[MachineryEntry] = Field(default_factory=list)
    material_entries: List[MaterialEntry] = Field(default_factory=list)
    can_edit: bool = False
    can_finalise: bool = False
    can_reopen: bool = False
    can_generate: bool = False
    data_mode: str
    assumptions: List[str]


class CompletionListItem(BaseModel):
    completion_id: str
    job_sheet_id: str
    completion_status: str = ""
    updated_at: Optional[Union[datetime, str]] = None
    finalised_at: Optional[Union[datetime, str]] = None
    version: int = 1


class CompletionListResponse(BaseModel):
    items: List[CompletionListItem]
    data_mode: str
    assumptions: List[str]


class CompletionUpdateRequest(BaseModel):
    work_summary: Optional[str] = None
    invoice_description: Optional[str] = None
    internal_notes: Optional[str] = None
    variations: Optional[List[str]] = None
    warnings: Optional[List[str]] = None
    warning_resolutions: Optional[List[Dict[str, Any]]] = None
    completion_status: Optional[str] = None
    labour_entries: Optional[List[LabourEntry]] = None
    machinery_entries: Optional[List[MachineryEntry]] = None
    material_entries: Optional[List[MaterialEntry]] = None
    expected_version: Optional[int] = None
    # Client totals intentionally ignored server-side.
    total_labour_hours: Optional[float] = None
    total_travel_hours: Optional[float] = None
    total_machinery_hours: Optional[float] = None
    billable_labour_hours: Optional[float] = None
    non_billable_labour_hours: Optional[float] = None

    @field_validator(
        "total_labour_hours",
        "total_travel_hours",
        "total_machinery_hours",
        "billable_labour_hours",
        "non_billable_labour_hours",
        mode="before",
    )
    @classmethod
    def _coerce_update_optional_floats(cls, value: Any) -> Optional[float]:
        try:
            return coerce_optional_float(value)
        except ValueError as exc:
            raise ValueError("must be a number") from exc

    @field_validator("expected_version", mode="before")
    @classmethod
    def _coerce_expected_version(cls, value: Any) -> Optional[int]:
        if value is None:
            return None
        if isinstance(value, str) and not value.strip():
            return None
        if isinstance(value, bool):
            raise ValueError("must be a number")
        try:
            if isinstance(value, int):
                return value
            if isinstance(value, float):
                return int(value)
            s = str(value).strip()
            if not s:
                return None
            return int(s)
        except (TypeError, ValueError) as exc:
            raise ValueError("must be a number") from exc


class CompletionGenerateRequest(BaseModel):
    expected_version: Optional[int] = None
    staff_name: Optional[str] = None


class CompletionFinaliseRequest(BaseModel):
    expected_version: Optional[int] = None
    override_reason: Optional[str] = None


class CompletionReopenRequest(BaseModel):
    reopen_reason: str = Field(min_length=1, max_length=500)
    expected_version: Optional[int] = None


class JobListResponse(BaseModel):
    items: List[JobSummary]
    days: int
    data_mode: str
    assumptions: List[str]


class RecordingOut(BaseModel):
    recording_id: str
    job_sheet_id: str
    recording_file_url: str = ""
    recording_drive_file_id: str = ""
    recording_name: str = ""
    recording_order: int = 0
    duration_seconds: float = 0
    transcript: str = ""
    status: str = ""
    invalid_reason: str = ""
    created_by: str = ""
    created_at: Optional[Union[datetime, str]] = None


class JobDetailResponse(BaseModel):
    job: JobSummary
    recordings: List[RecordingOut]
    processing_started_at: Optional[Union[datetime, str]] = None
    processing_completed_at: Optional[Union[datetime, str]] = None
    data_mode: str
    assumptions: List[str]


class RecordingUploadResponse(BaseModel):
    status: str
    message: str
    recording_id: str
    recording_file_url: str
    recording_drive_file_id: str
    recording_order: int
    processing_triggered: bool
    processing_message: str


class InvalidateRecordingRequest(BaseModel):
    reason: str = Field(default="Marked invalid by user.", max_length=200)


class RecordingMutationResponse(BaseModel):
    status: str
    job_sheet_id: str
    recording_id: str
    recording_status: str
    message: str = ""
    invalid_reason: str = ""


class ProcessRequest(BaseModel):
    force_reprocess: bool = False


class CreateJobFromRecordingRequest(BaseModel):
    recording_id: str = Field(min_length=1, max_length=80)
    expected_processing_version: int = Field(ge=1)
    job: dict = Field(default_factory=dict)
    idempotency_key: str = Field(min_length=8, max_length=128)
    create_another: bool = False


class NewJobDictationDraftOut(BaseModel):
    recording_id: str
    source: str = ""
    status: str = ""
    filename: str = ""
    mime_type: str = ""
    byte_size: int = 0
    duration_seconds: float = 0
    recording_drive_file_id: str = ""
    recording_file_url: str = ""
    created_by: str = ""
    created_by_name: str = ""
    created_at: Optional[Union[datetime, str]] = None
    updated_at: Optional[Union[datetime, str]] = None
    processing_version: int = 1
    processing_type: str = "new_job_dictation"
    transcript: str = ""
    extraction: dict = Field(default_factory=dict)
    match_report: dict = Field(default_factory=dict)
    job_sheet_id: str = ""
    failure_reason: str = ""
    reviewed_by: str = ""
    created_job_by: str = ""


class NewJobDictationResponse(BaseModel):
    draft: NewJobDictationDraftOut
    data_mode: str = ""


class CreateJobFromRecordingResponse(BaseModel):
    job: dict
    recording_id: str
    link: Optional[dict] = None
    idempotent: bool = False
    draft: NewJobDictationDraftOut
    data_mode: str = ""


class JobCreateMastersResponse(BaseModel):
    customers: List[dict] = Field(default_factory=list)
    projects: List[dict] = Field(default_factory=list)
    staff: List[dict] = Field(default_factory=list)
    data_mode: str = ""


class DailyWorkSessionCreateRequest(BaseModel):
    work_date: str = ""
    staff_ids: List[str] = Field(default_factory=list)
    staff_names: List[str] = Field(default_factory=list)
    project_id: str = ""
    project_name: str = ""
    customer_name: str = ""
    site_address: str = ""
    starting_note: str = ""


class DailyWorkSessionPatchRequest(BaseModel):
    expected_version: Optional[int] = None
    work_date: Optional[str] = None
    staff_ids: Optional[List[str]] = None
    staff_names: Optional[List[str]] = None
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    customer_name: Optional[str] = None
    site_address: Optional[str] = None
    starting_note: Optional[str] = None
    reviewed_job_sheet: Optional[dict] = None


class DailyWorkCreateJobSheetRequest(BaseModel):
    expected_session_version: int = Field(ge=1)
    reviewed_job_sheet: dict = Field(default_factory=dict)
    idempotency_key: str = Field(min_length=8, max_length=128)


class DailyWorkReturnToReviewRequest(BaseModel):
    expected_session_version: int = Field(ge=1)


class DailyWorkSessionOut(BaseModel):
    work_session_id: str
    work_date: str = ""
    project_id: str = ""
    project_name: str = ""
    customer_name: str = ""
    staff_ids: List[str] = Field(default_factory=list)
    staff_names: List[str] = Field(default_factory=list)
    status: str = ""
    recording_count: int = 0
    created_by: str = ""
    created_at: Optional[Union[datetime, str]] = None
    updated_at: Optional[Union[datetime, str]] = None
    version: int = 1
    created_job_sheet_id: str = ""
    site_address: str = ""
    starting_note: str = ""
    recordings: List[dict] = Field(default_factory=list)
    extraction: dict = Field(default_factory=dict)
    failure_reason: str = ""
    create_failure_reason: str = ""
    create_failure_code: str = ""
    last_create_idempotency_key: str = ""
    processing_type: str = "daily_work_dictation"
    job_created: bool = False
    notice: str = ""


class DailyWorkSessionResponse(BaseModel):
    session: DailyWorkSessionOut
    data_mode: str = ""


class DailyWorkSessionListResponse(BaseModel):
    items: List[dict] = Field(default_factory=list)
    data_mode: str = ""


class DailyWorkCreateJobSheetResponse(BaseModel):
    job: dict
    session: DailyWorkSessionOut
    links: List[dict] = Field(default_factory=list)
    link_count: int = 0
    idempotent: bool = False
    data_mode: str = ""


class ProcessResponse(BaseModel):
    status: str
    action: str
    message: str
    record_id: Optional[str] = None
    timestamp: Optional[str] = None
    proxied: bool = True


class HealthResponse(BaseModel):
    status: str
    service: str = "fieldos-api"
    time: str
    env: str


class ReadyResponse(BaseModel):
    status: str
    data_mode: str
    checks: Dict[str, bool]
    message: str


class DashboardFilters(BaseModel):
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    completion_status: Optional[str] = None
    approval_status: Optional[str] = None
    customer: Optional[str] = None
    project: Optional[str] = None
    assigned_staff_id: Optional[str] = None
    billable: Optional[bool] = None
    q: Optional[str] = None


class DashboardItem(BaseModel):
    job_date: str = ""
    job_sheet_id: str
    completion_id: str
    customer_name: str = ""
    project_name: str = ""
    completion_status: str = ""
    approval_status: str = ""
    finalised_by: str = ""
    finalised_at: Optional[Union[datetime, str]] = None
    total_labour_hours: float = 0
    total_travel_hours: float = 0
    total_machinery_hours: float = 0
    billable_labour_hours: float = 0
    non_billable_labour_hours: float = 0
    unresolved_warning_count: int = 0
    invoice_ready: bool = False
    payroll_ready: bool = False
    export_status: str = ""
    version: int = 1


class DashboardSummary(BaseModel):
    job_count: int = 0
    finalised_jobs: int = 0
    draft_or_reopened_jobs: int = 0
    total_labour_hours: float = 0
    total_travel_hours: float = 0
    total_machinery_hours: float = 0
    billable_labour_hours: float = 0
    non_billable_labour_hours: float = 0
    unresolved_warnings: int = 0
    jobs_ready_for_invoice_export: int = 0
    jobs_ready_for_payroll_export: int = 0


class DashboardResponse(BaseModel):
    items: List[DashboardItem]
    filters: Dict[str, Any] = Field(default_factory=dict)
    summary: DashboardSummary
    data_mode: str
    assumptions: List[str]


class DashboardSummaryResponse(BaseModel):
    summary: DashboardSummary
    filters: Dict[str, Any] = Field(default_factory=dict)
    data_mode: str
    assumptions: List[str]


class ExportReadiness(BaseModel):
    invoice_ready: bool = False
    invoice_blockers: List[str] = Field(default_factory=list)
    payroll_ready: bool = False
    payroll_blockers: List[str] = Field(default_factory=list)
    warning_count: int = 0


class ExportReadinessResponse(BaseModel):
    completion_id: str
    job_sheet_id: str = ""
    readiness: ExportReadiness
    data_mode: str
    assumptions: List[str]


class ExportBatchOut(BaseModel):
    export_batch_id: str
    export_type: str
    date_from: str = ""
    date_to: str = ""
    filter_json: Dict[str, Any] = Field(default_factory=dict)
    status: str = "Draft"
    record_count: int = 0
    created_by: str = ""
    created_at: Optional[Union[datetime, str]] = None
    completed_at: Optional[Union[datetime, str]] = None
    file_name: str = ""
    checksum: str = ""
    notes: str = ""
    version: int = 1


class ExportBatchItemOut(BaseModel):
    export_batch_item_id: str
    export_batch_id: str
    job_sheet_id: str = ""
    completion_id: str = ""
    item_status: str = ""
    blocker_summary: str = ""
    created_at: Optional[Union[datetime, str]] = None


class ExportBatchResponse(BaseModel):
    export_batch: ExportBatchOut
    items: List[ExportBatchItemOut] = Field(default_factory=list)
    data_mode: str
    assumptions: List[str]


class ExportBatchListItem(BaseModel):
    export_batch_id: str
    export_type: str = ""
    status: str = ""
    record_count: int = 0
    date_from: str = ""
    date_to: str = ""
    created_at: Optional[Union[datetime, str]] = None
    file_name: str = ""
    version: int = 1


class ExportBatchListResponse(BaseModel):
    items: List[ExportBatchListItem]
    data_mode: str
    assumptions: List[str]


class CreateExportBatchRequest(BaseModel):
    export_type: str = "Completion Summary CSV"
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    filters: Optional[Dict[str, Any]] = None
    completion_ids: Optional[List[str]] = None
    notes: Optional[str] = None


class ExportBatchVersionRequest(BaseModel):
    expected_version: Optional[int] = None


# --------------------------------------------------------------------------
# Phase 3E — rates, financial mappings and completion pricing snapshots.
# Money crosses the API as decimal strings only; the server stores integer cents.
# --------------------------------------------------------------------------

Money = Optional[str]


class RateAuditFields(BaseModel):
    created_by: str = ""
    created_at: Optional[Union[datetime, str]] = None
    updated_by: str = ""
    updated_at: Optional[Union[datetime, str]] = None
    version: int = 1


class RateOverlap(BaseModel):
    a_id: str = ""
    b_id: str = ""
    message: str = ""


class RateRecordVersionRequest(BaseModel):
    expected_version: Optional[int] = None


class RateCardIn(BaseModel):
    card_name: Optional[str] = Field(default=None, max_length=200)
    description: Optional[str] = None
    currency: Optional[str] = Field(default=None, max_length=8)
    status: Optional[str] = None
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None
    notes: Optional[str] = None


class RateCardUpdateRequest(RateCardIn, RateRecordVersionRequest):
    pass


class RateCardOut(RateAuditFields):
    rate_card_id: str
    card_name: str = ""
    description: str = ""
    currency: str = ""
    status: str = ""
    effective_from: str = ""
    effective_to: str = ""
    notes: str = ""


class LabourRateIn(BaseModel):
    rate_card_id: Optional[str] = None
    staff_id: Optional[str] = None
    customer_id: Optional[str] = None
    project_id: Optional[str] = None
    role_code: Optional[str] = None
    activity_code: Optional[str] = None
    unit: Optional[str] = None
    sell_rate: Money = Field(default=None, description="Decimal string, e.g. '85.00'.")
    cost_rate: Money = None
    travel_rate: Money = None
    overtime_rate: Money = None
    status: Optional[str] = None
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None
    notes: Optional[str] = None


class LabourRateUpdateRequest(LabourRateIn, RateRecordVersionRequest):
    pass


class LabourRateOut(RateAuditFields):
    labour_rate_id: str
    rate_card_id: str = ""
    staff_id: str = ""
    customer_id: str = ""
    project_id: str = ""
    role_code: str = ""
    activity_code: str = ""
    unit: str = ""
    sell_rate: str = ""
    cost_rate: str = ""
    travel_rate: str = ""
    overtime_rate: str = ""
    status: str = ""
    effective_from: str = ""
    effective_to: str = ""
    notes: str = ""


class MachineryRateIn(BaseModel):
    rate_card_id: Optional[str] = None
    equipment_id: Optional[str] = None
    equipment_name: Optional[str] = None
    charge_code: Optional[str] = None
    unit: Optional[str] = None
    sell_rate: Money = None
    cost_rate: Money = None
    minimum_charge: Money = None
    status: Optional[str] = None
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None
    notes: Optional[str] = None


class MachineryRateUpdateRequest(MachineryRateIn, RateRecordVersionRequest):
    pass


class MachineryRateOut(RateAuditFields):
    machinery_rate_id: str
    rate_card_id: str = ""
    equipment_id: str = ""
    equipment_name: str = ""
    charge_code: str = ""
    unit: str = ""
    sell_rate: str = ""
    cost_rate: str = ""
    minimum_charge: str = ""
    status: str = ""
    effective_from: str = ""
    effective_to: str = ""
    notes: str = ""


class MaterialCatalogItemIn(BaseModel):
    item_code: Optional[str] = None
    item_name: Optional[str] = None
    description: Optional[str] = None
    unit: Optional[str] = None
    cost_price: Money = None
    sell_price: Money = None
    tax_code: Optional[str] = None
    account_code: Optional[str] = None
    supplier: Optional[str] = None
    active: Optional[str] = None
    notes: Optional[str] = None


class MaterialCatalogItemUpdateRequest(MaterialCatalogItemIn, RateRecordVersionRequest):
    pass


class MaterialCatalogItemOut(RateAuditFields):
    material_id: str
    item_code: str = ""
    item_name: str = ""
    description: str = ""
    unit: str = ""
    cost_price: str = ""
    sell_price: str = ""
    tax_code: str = ""
    account_code: str = ""
    supplier: str = ""
    active: str = ""
    notes: str = ""


class CustomerPricingIn(BaseModel):
    customer_id: Optional[str] = None
    project_id: Optional[str] = None
    rate_card_id: Optional[str] = None
    price_notes: Optional[str] = None
    status: Optional[str] = None
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None
    notes: Optional[str] = None


class CustomerPricingUpdateRequest(CustomerPricingIn, RateRecordVersionRequest):
    pass


class CustomerPricingOut(RateAuditFields):
    customer_pricing_id: str
    customer_id: str = ""
    project_id: str = ""
    rate_card_id: str = ""
    price_notes: str = ""
    status: str = ""
    effective_from: str = ""
    effective_to: str = ""
    notes: str = ""


class PayrollMappingIn(BaseModel):
    staff_id: Optional[str] = None
    employee_reference: Optional[str] = None
    ordinary_hours_code: Optional[str] = None
    overtime_hours_code: Optional[str] = None
    travel_hours_code: Optional[str] = None
    allowance_code: Optional[str] = None
    cost_centre: Optional[str] = None
    pay_calendar: Optional[str] = None
    # Captured for payroll handoff only — FieldOS never infers these.
    employment_classification: Optional[str] = None
    award_reference: Optional[str] = None
    status: Optional[str] = None
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None
    notes: Optional[str] = None


class PayrollMappingUpdateRequest(PayrollMappingIn, RateRecordVersionRequest):
    pass


class PayrollMappingOut(RateAuditFields):
    payroll_mapping_id: str
    staff_id: str = ""
    employee_reference: str = ""
    ordinary_hours_code: str = ""
    overtime_hours_code: str = ""
    travel_hours_code: str = ""
    allowance_code: str = ""
    cost_centre: str = ""
    pay_calendar: str = ""
    employment_classification: str = ""
    award_reference: str = ""
    status: str = ""
    effective_from: str = ""
    effective_to: str = ""
    notes: str = ""


class XeroMappingIn(BaseModel):
    entity_type: Optional[str] = None
    local_reference: Optional[str] = None
    xero_reference: Optional[str] = None
    account_code: Optional[str] = None
    tax_type: Optional[str] = None
    tax_rate_percent: Optional[float] = None
    tracking_category: Optional[str] = None
    tracking_option: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None


class XeroMappingUpdateRequest(XeroMappingIn, RateRecordVersionRequest):
    pass


class XeroMappingOut(RateAuditFields):
    xero_mapping_id: str
    entity_type: str = ""
    local_reference: str = ""
    xero_reference: str = ""
    account_code: str = ""
    tax_type: str = ""
    tax_rate_percent: Optional[Union[float, str]] = None
    tracking_category: str = ""
    tracking_option: str = ""
    status: str = ""
    notes: str = ""


class RateCardListResponse(BaseModel):
    items: List[RateCardOut] = Field(default_factory=list)
    overlaps: List[RateOverlap] = Field(default_factory=list)
    data_mode: str
    assumptions: List[str]


class RateCardResponse(BaseModel):
    item: RateCardOut
    data_mode: str
    assumptions: List[str]


class LabourRateListResponse(BaseModel):
    items: List[LabourRateOut] = Field(default_factory=list)
    overlaps: List[RateOverlap] = Field(default_factory=list)
    data_mode: str
    assumptions: List[str]


class LabourRateResponse(BaseModel):
    item: LabourRateOut
    data_mode: str
    assumptions: List[str]


class MachineryRateListResponse(BaseModel):
    items: List[MachineryRateOut] = Field(default_factory=list)
    overlaps: List[RateOverlap] = Field(default_factory=list)
    data_mode: str
    assumptions: List[str]


class MachineryRateResponse(BaseModel):
    item: MachineryRateOut
    data_mode: str
    assumptions: List[str]


class MaterialCatalogListResponse(BaseModel):
    items: List[MaterialCatalogItemOut] = Field(default_factory=list)
    overlaps: List[RateOverlap] = Field(default_factory=list)
    data_mode: str
    assumptions: List[str]


class MaterialCatalogItemResponse(BaseModel):
    item: MaterialCatalogItemOut
    data_mode: str
    assumptions: List[str]


class CustomerPricingListResponse(BaseModel):
    items: List[CustomerPricingOut] = Field(default_factory=list)
    overlaps: List[RateOverlap] = Field(default_factory=list)
    data_mode: str
    assumptions: List[str]


class CustomerPricingResponse(BaseModel):
    item: CustomerPricingOut
    data_mode: str
    assumptions: List[str]


class PayrollMappingListResponse(BaseModel):
    items: List[PayrollMappingOut] = Field(default_factory=list)
    overlaps: List[RateOverlap] = Field(default_factory=list)
    data_mode: str
    assumptions: List[str]


class PayrollMappingResponse(BaseModel):
    item: PayrollMappingOut
    data_mode: str
    assumptions: List[str]


class XeroMappingListResponse(BaseModel):
    items: List[XeroMappingOut] = Field(default_factory=list)
    overlaps: List[RateOverlap] = Field(default_factory=list)
    data_mode: str
    assumptions: List[str]


class XeroMappingResponse(BaseModel):
    item: XeroMappingOut
    data_mode: str
    assumptions: List[str]


class PricingIdentity(BaseModel):
    customer_id: str = ""
    project_id: str = ""
    customer_name: str = ""
    project_name: str = ""
    job_date: str = ""
    rate_card_id: str = ""
    match: str = ""


class PayrollMappingStatus(BaseModel):
    staff_id: str = ""
    work_date: str = ""
    resolved: bool = False
    source_id: str = ""
    blockers: List[str] = Field(default_factory=list)


class MaterialSuggestionMatch(BaseModel):
    material_id: str = ""
    item_code: str = ""
    item_name: str = ""


class MaterialSuggestion(BaseModel):
    source_row_id: str = ""
    item_name: str = ""
    suggested_matches: List[MaterialSuggestionMatch] = Field(default_factory=list)


class SampleRate(BaseModel):
    line_type: str = ""
    description: str = ""
    source_row_id: str = ""
    quantity: Optional[float] = None
    unit: str = ""
    unit_sell: str = ""
    resolved: bool = False
    rate_source_type: str = ""
    rate_source_id: str = ""
    non_billable_reason: str = ""
    blockers: List[str] = Field(default_factory=list)


class TotalsPreview(BaseModel):
    subtotal_ex_tax: str = ""
    tax_amount: str = ""
    total_inc_tax: str = ""
    tax_type: str = ""
    currency: str = "AUD"


class PricingReadinessResponse(BaseModel):
    completion_id: str
    job_sheet_id: str = ""
    identity: PricingIdentity
    invoice_pricing_ready: bool = False
    payroll_mapping_ready: bool = False
    invoice_blockers: List[str] = Field(default_factory=list)
    payroll_blockers: List[str] = Field(default_factory=list)
    blockers: List[str] = Field(default_factory=list)
    pricing_status: str = "Unresolved"
    xero_customer_reference: str = ""
    payroll_mappings: List[PayrollMappingStatus] = Field(default_factory=list)
    material_suggestions: List[MaterialSuggestion] = Field(default_factory=list)
    sample_rates: List[SampleRate] = Field(default_factory=list)
    totals_preview: TotalsPreview
    data_mode: str
    assumptions: List[str]


class FinancialLineOut(BaseModel):
    financial_line_id: str = ""
    financial_snapshot_id: str = ""
    completion_id: str = ""
    line_number: int = 0
    line_type: str = ""
    source_row_id: str = ""
    description: str = ""
    staff_id: str = ""
    equipment_id: str = ""
    material_id: str = ""
    quantity: Optional[float] = None
    unit: str = ""
    unit_sell: str = ""
    line_amount_ex_tax: str = ""
    tax_type: str = ""
    tax_rate_percent: Optional[float] = None
    tax_amount: str = ""
    line_total_inc_tax: str = ""
    account_code: str = ""
    rate_source_type: str = ""
    rate_source_id: str = ""
    billable: bool = False
    non_billable_reason: str = ""
    blockers: List[str] = Field(default_factory=list)
    created_at: Optional[Union[datetime, str]] = None


class FinancialSnapshotOut(BaseModel):
    financial_snapshot_id: str
    completion_id: str = ""
    job_sheet_id: str = ""
    customer_id: str = ""
    project_id: str = ""
    job_date: str = ""
    currency: str = "AUD"
    snapshot_status: str = ""
    pricing_status: str = ""
    rate_card_id: str = ""
    line_count: int = 0
    subtotal_ex_tax: str = ""
    tax_amount: str = ""
    total_inc_tax: str = ""
    tax_type: str = ""
    tax_rate_percent: Optional[float] = None
    account_code: str = ""
    draft_reference: str = ""
    xero_reference: str = ""
    blockers: List[str] = Field(default_factory=list)
    notes: str = ""
    created_by: str = ""
    created_at: Optional[Union[datetime, str]] = None
    validated_by: str = ""
    validated_at: Optional[Union[datetime, str]] = None
    approved_by: str = ""
    approved_at: Optional[Union[datetime, str]] = None
    superseded_by: str = ""
    superseded_at: Optional[Union[datetime, str]] = None
    version: int = 1


class FinancialSnapshotResponse(BaseModel):
    financial_snapshot: FinancialSnapshotOut
    lines: List[FinancialLineOut] = Field(default_factory=list)
    data_mode: str
    assumptions: List[str]


class FinancialSnapshotListItem(BaseModel):
    financial_snapshot_id: str
    completion_id: str = ""
    job_sheet_id: str = ""
    customer_id: str = ""
    project_id: str = ""
    job_date: str = ""
    snapshot_status: str = ""
    pricing_status: str = ""
    line_count: int = 0
    subtotal_ex_tax: str = ""
    tax_amount: str = ""
    total_inc_tax: str = ""
    draft_reference: str = ""
    xero_reference: str = ""
    created_at: Optional[Union[datetime, str]] = None
    version: int = 1


class FinancialSnapshotListResponse(BaseModel):
    items: List[FinancialSnapshotListItem] = Field(default_factory=list)
    data_mode: str
    assumptions: List[str]


class CreateFinancialSnapshotRequest(BaseModel):
    notes: Optional[str] = Field(default=None, max_length=500)


class FinancialSnapshotVersionRequest(BaseModel):
    expected_version: Optional[int] = None


class SupersedeFinancialSnapshotRequest(FinancialSnapshotVersionRequest):
    reason: str = Field(min_length=1, max_length=500)


# --------------------------------------------------------------------------
# Phase 3F — job report PDFs. Reports carry hours and narrative only; money,
# transcripts and Drive identifiers never appear in a rendered page.
# --------------------------------------------------------------------------


class ReportFilters(BaseModel):
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    customer: Optional[str] = None
    project: Optional[str] = None
    staff_id: Optional[str] = None
    assigned_staff_id: Optional[str] = None
    completion_status: Optional[str] = None
    approval_status: Optional[str] = None
    finalised_only: Optional[bool] = None
    billable: Optional[bool] = None
    job_sheet_ids: Optional[List[str]] = None
    q: Optional[str] = None


class ReportTypeOption(BaseModel):
    """One selectable report template — matches live Apps Script get_report_options."""

    report_type: str
    group_by: List[str] = Field(default_factory=list)
    allowed_group_by: List[str] = Field(default_factory=list)
    default_group_by: str = ""
    label: Optional[str] = None
    description: Optional[str] = None
    supports_landscape: Optional[bool] = None

    @model_validator(mode="before")
    @classmethod
    def _coerce_legacy_string_or_as_object(cls, value: Any) -> Any:
        # Local import avoids circular imports at module load.
        from app.services.report_math import normalise_report_type_option

        return normalise_report_type_option(value)

    @model_validator(mode="after")
    def _fill_label_and_group_alias(self) -> "ReportTypeOption":
        if not self.label:
            self.label = self.report_type
        # Keep group_by as the UI-facing alias of allowed_group_by.
        if not self.group_by and self.allowed_group_by:
            self.group_by = list(self.allowed_group_by)
        elif self.group_by and not self.allowed_group_by:
            self.allowed_group_by = list(self.group_by)
        if not self.default_group_by and self.group_by:
            self.default_group_by = self.group_by[0]
        return self


class ReportOptionsResponse(BaseModel):
    report_types: List[ReportTypeOption] = Field(default_factory=list)
    statuses: List[str] = Field(default_factory=list)
    report_statuses: List[str] = Field(default_factory=list)
    template_version: str = ""
    max_records: Optional[int] = None
    filter_keys: List[str] = Field(default_factory=list)
    scoped_to_staff_id: str = ""
    actor_role: str = ""
    default_filters: Dict[str, Any] = Field(default_factory=dict)
    landscape_defaults: Dict[str, bool] = Field(default_factory=dict)
    audiences: Dict[str, str] = Field(default_factory=dict)
    data_mode: str
    assumptions: List[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _align_apps_script_and_mock_fields(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        # Live Apps Script uses report_statuses; mock historically used statuses.
        statuses = data.get("statuses")
        report_statuses = data.get("report_statuses")
        if not statuses and isinstance(report_statuses, list):
            data["statuses"] = list(report_statuses)
        if not report_statuses and isinstance(statuses, list):
            data["report_statuses"] = list(statuses)
        return data


class ReportTotals(BaseModel):
    job_count: int = 0
    labour_hours: float = 0
    travel_hours: float = 0
    billable_labour_hours: float = 0
    machinery_hours: float = 0
    material_items: int = 0


class ReportPreviewItem(BaseModel):
    job_sheet_id: str = ""
    completion_id: str = ""
    job_date: str = ""
    customer_name: str = ""
    project_name: str = ""
    blocker_summary: str = ""


class ReportPreviewRequest(BaseModel):
    report_type: str = "Completion Register"
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    filters: Optional[ReportFilters] = None
    job_sheet_ids: Optional[List[str]] = None
    group_by: Optional[str] = None


class ReportPreviewResponse(BaseModel):
    report_type: str
    filters: Dict[str, Any] = Field(default_factory=dict)
    template_version: str = ""
    job_count: int = 0
    group_count: int = 0
    page_estimate: int = 0
    group_by: str = ""
    totals: ReportTotals
    blockers: List[str] = Field(default_factory=list)
    items: List[ReportPreviewItem] = Field(default_factory=list)
    data_mode: str
    assumptions: List[str]


class CreateReportBatchRequest(ReportPreviewRequest):
    """Same selection surface as preview, plus output shape and an audit note."""


    landscape: Optional[bool] = None
    notes: Optional[str] = Field(default=None, max_length=500)


class ReportBatchVersionRequest(BaseModel):
    expected_version: Optional[int] = None


class ReportBatchOut(BaseModel):
    report_batch_id: str
    report_type: str = ""
    date_from: str = ""
    date_to: str = ""
    filter_json: Dict[str, Any] = Field(default_factory=dict)
    status: str = "Draft"
    record_count: int = 0
    page_estimate: int = 0
    audience: str = "internal"
    landscape: bool = False
    template_version: str = ""
    created_by: str = ""
    created_at: Optional[Union[datetime, str]] = None
    generated_by: str = ""
    completed_at: Optional[Union[datetime, str]] = None
    file_name: str = ""
    checksum: str = ""
    byte_size: int = 0
    notes: str = ""
    version: int = 1


class ReportBatchItemOut(BaseModel):
    report_batch_item_id: str
    report_batch_id: str
    job_sheet_id: str = ""
    completion_id: str = ""
    item_status: str = ""
    blocker_summary: str = ""
    created_at: Optional[Union[datetime, str]] = None


class ReportBatchResponse(BaseModel):
    report_batch: ReportBatchOut
    items: List[ReportBatchItemOut] = Field(default_factory=list)
    data_mode: str
    assumptions: List[str]


class ReportBatchListItem(BaseModel):
    report_batch_id: str
    report_type: str = ""
    status: str = ""
    record_count: int = 0
    page_estimate: int = 0
    date_from: str = ""
    date_to: str = ""
    created_at: Optional[Union[datetime, str]] = None
    file_name: str = ""
    checksum: str = ""
    version: int = 1


class ReportBatchListResponse(BaseModel):
    items: List[ReportBatchListItem] = Field(default_factory=list)
    data_mode: str
    assumptions: List[str]


# --------------------------------------------------------------------------
# Phase 3G — PDF delivery, document control, job attachments.
# Email and Drive filing never auto-send; both are gated and off by default.
# --------------------------------------------------------------------------


class DeliveryOut(BaseModel):
    delivery_id: str
    report_batch_id: str = ""
    job_sheet_id: str = ""
    completion_id: str = ""
    document_type: str = ""
    recipient_type: str = ""
    recipient_email: str = ""
    delivery_method: str = ""
    status: str = ""
    sent_by: str = ""
    sent_at: Optional[Union[datetime, str]] = None
    failed_at: Optional[Union[datetime, str]] = None
    failure_reason: str = ""
    checksum: str = ""
    template_version: str = ""
    supersedes_delivery_id: str = ""
    idempotency_key: str = ""
    file_drive: bool = False
    attachment_ids: List[str] = Field(default_factory=list)
    subject: str = ""
    body_preview: str = ""
    version: int = 1
    created_at: Optional[Union[datetime, str]] = None
    created_by: str = ""


class EmailPreviewOut(BaseModel):
    to: str = ""
    subject: str = ""
    body: str = ""


class DeliveryOptionsResponse(BaseModel):
    profiles: List[str] = Field(default_factory=list)
    statuses: List[str] = Field(default_factory=list)
    delivery_methods: List[str] = Field(default_factory=list)
    template_version: str = ""
    email_enabled: bool = False
    drive_filing_enabled: bool = False
    email_gate_reason: str = ""
    drive_gate_reason: str = ""
    antivirus_boundary: str = ""
    auto_send: bool = False
    data_mode: str
    assumptions: List[str]


class CreateDeliveryDraftRequest(BaseModel):
    document_type: str
    recipient_email: Optional[str] = None
    recipient_type: Optional[str] = "client"
    delivery_method: Optional[str] = "email"
    report_batch_id: Optional[str] = None
    job_sheet_id: Optional[str] = None
    completion_id: Optional[str] = None
    attachment_ids: Optional[List[str]] = None
    supersedes_delivery_id: Optional[str] = None
    customer_name: Optional[str] = None
    project_name: Optional[str] = None


class UpdateDeliveryDraftRequest(BaseModel):
    expected_version: Optional[int] = None
    document_type: Optional[str] = None
    recipient_email: Optional[str] = None
    recipient_type: Optional[str] = None
    delivery_method: Optional[str] = None
    attachment_ids: Optional[List[str]] = None
    customer_name: Optional[str] = None
    project_name: Optional[str] = None


class DeliveryVersionRequest(BaseModel):
    expected_version: Optional[int] = None


class SendDeliveryRequest(DeliveryVersionRequest):
    confirm_send: bool = False
    customer_name: Optional[str] = None
    project_name: Optional[str] = None
    year: Optional[str] = None


class DeliveryResponse(BaseModel):
    delivery: DeliveryOut
    email_preview: Optional[EmailPreviewOut] = None
    replacement: Optional[DeliveryOut] = None
    sent: Optional[bool] = None
    idempotent: Optional[bool] = None
    confirm_required: Optional[bool] = None
    auto_send: Optional[bool] = None
    data_mode: str
    assumptions: List[str]


class DeliveryListResponse(BaseModel):
    items: List[DeliveryOut] = Field(default_factory=list)
    data_mode: str
    assumptions: List[str]


class AttachmentOut(BaseModel):
    attachment_id: str
    job_sheet_id: str = ""
    completion_id: str = ""
    attachment_type: str = "other"
    file_name: str = ""
    mime_type: str = ""
    byte_size: int = 0
    caption: str = ""
    uploaded_by: str = ""
    uploaded_at: Optional[Union[datetime, str]] = None
    client_visible: bool = False
    approved_by: str = ""
    approved_at: Optional[Union[datetime, str]] = None
    checksum: str = ""
    status: str = ""
    version: int = 1
    has_storage_ref: Optional[bool] = None


class UploadAttachmentRequest(BaseModel):
    job_sheet_id: str
    file_name: str
    mime_type: str
    byte_size: int
    attachment_type: str = "other"
    caption: Optional[str] = None
    completion_id: Optional[str] = None
    content_base64: Optional[str] = None
    checksum: Optional[str] = None


class SetAttachmentVisibilityRequest(BaseModel):
    client_visible: bool


class AttachmentResponse(BaseModel):
    attachment: AttachmentOut
    antivirus_boundary: Optional[str] = None
    data_mode: str
    assumptions: List[str]


class AttachmentListResponse(BaseModel):
    items: List[AttachmentOut] = Field(default_factory=list)
    antivirus_boundary: Optional[str] = None
    data_mode: str
    assumptions: List[str]
