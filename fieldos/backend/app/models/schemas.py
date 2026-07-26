from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, EmailStr, Field


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


class MaterialEntry(BaseModel):
    material_entry_id: Optional[str] = None
    completion_id: Optional[str] = None
    job_sheet_id: Optional[str] = None
    item_name: str = ""
    quantity: Optional[float] = None
    unit: str = ""
    billable: bool = False
    confirmation_status: str = "Suggested"
    notes: str = ""
    source: str = ""
    created_at: Optional[Union[datetime, str]] = None
    updated_at: Optional[Union[datetime, str]] = None
    confidence: Optional[float] = None


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
