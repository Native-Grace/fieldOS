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
