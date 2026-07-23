from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile

from app.core.config import Settings, get_settings
from app.core.security import create_access_token, get_current_claims
from app.models.schemas import (
    HealthResponse,
    InvalidateRecordingRequest,
    JobDetailResponse,
    JobListResponse,
    JobSummary,
    LoginRequest,
    LoginResponse,
    ProcessRequest,
    ProcessResponse,
    ReadyResponse,
    RecordingMutationResponse,
    RecordingOut,
    RecordingUploadResponse,
    StaffOut,
)
from app.services.auth_store import AuthUserStore
from app.services.jobs import JobService
from datetime import datetime, timezone
from fastapi import HTTPException, status

router = APIRouter(prefix="/api/v1")


def job_service(settings: Settings = Depends(get_settings)) -> JobService:
    return JobService(settings)


def auth_store(settings: Settings = Depends(get_settings)) -> AuthUserStore:
    return AuthUserStore(settings)


def _job_summary(job: dict, settings: Settings) -> JobSummary:
    # Prefer normalized API fields from Apps Script gateway / mock adapters.
    raw_date = job.get("job_date") or job.get(settings.job_date_column)
    job_date = None
    if raw_date:
        try:
            job_date = date.fromisoformat(str(raw_date)[:10])
        except ValueError:
            job_date = None
    project = job.get("project_name")
    if project in (None, ""):
        project = job.get(settings.job_project_column) or ""
    customer = job.get("customer_name")
    if customer is None:
        customer = job.get(settings.job_customer_column) or ""
    return JobSummary(
        job_sheet_id=str(job.get("job_sheet_id", "")),
        job_date=job_date,
        project_name=str(project or ""),
        customer_name=str(customer or ""),
        processing_status=str(job.get("processing_status", "") or ""),
        approval_status=str(job.get("approval_status", "") or ""),
        processing_error=str(job.get("processing_error", "") or ""),
    )


@router.get("/health", response_model=HealthResponse)
def health(settings: Settings = Depends(get_settings)) -> HealthResponse:
    return HealthResponse(
        status="ok",
        time=datetime.now(timezone.utc).isoformat(),
        env=settings.fieldos_env,
    )


@router.get("/ready", response_model=ReadyResponse)
def ready(settings: Settings = Depends(get_settings)) -> ReadyResponse:
    mode = (settings.data_mode or "mock").strip().lower()
    apps_configured = bool(settings.apps_script_webapp_url and settings.apps_script_webhook_secret)
    drive_configured = bool(settings.recordings_folder_id and settings.google_application_credentials)
    checks = {
        "auth_store": True,
        "data_mode_mock": mode == "mock",
        "data_mode_apps_script": mode == "apps_script",
        "apps_script_configured": apps_configured,
        "drive_upload_configured": drive_configured,
        "jwt_secret_set": bool(settings.jwt_secret) and settings.jwt_secret != "dev-only-change-me",
    }
    if mode == "mock":
        ok = checks["auth_store"]
        message = "Ready for local mock mode"
    elif mode == "apps_script":
        ok = checks["auth_store"] and apps_configured
        message = "Ready for apps_script mode" if ok else "apps_script mode missing URL/secret"
    else:
        ok = False
        message = f"Unsupported DATA_MODE={settings.data_mode}"
    return ReadyResponse(
        status="ok" if ok else "degraded",
        data_mode=settings.data_mode,
        checks=checks,
        message=message,
    )


@router.post("/auth/login", response_model=LoginResponse)
def login(
    body: LoginRequest,
    settings: Settings = Depends(get_settings),
    store: AuthUserStore = Depends(auth_store),
) -> LoginResponse:
    user = store.authenticate(body.email, body.password)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    token = create_access_token(
        subject=str(user["staff_id"]),
        claims={
            "email": user["email"],
            "staff_name": user["staff_name"],
            "role": user.get("role", "Field Staff"),
        },
        settings=settings,
    )
    return LoginResponse(
        access_token=token,
        expires_in=settings.jwt_expire_minutes * 60,
        staff=StaffOut(
            staff_id=user["staff_id"],
            staff_name=user["staff_name"],
            email=user["email"],
            role=user.get("role", "Field Staff"),
        ),
    )


@router.post("/auth/logout")
def logout() -> dict:
    # Stateless JWT MVP — client discards token
    return {"status": "Success", "message": "Logged out"}


@router.get("/auth/me", response_model=StaffOut)
def me(
    claims: dict = Depends(get_current_claims),
    store: AuthUserStore = Depends(auth_store),
) -> StaffOut:
    user = store.get_by_staff_id(str(claims["sub"]))
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return StaffOut(
        staff_id=user["staff_id"],
        staff_name=user["staff_name"],
        email=user["email"],
        role=user.get("role", "Field Staff"),
    )


@router.get("/jobs/mine", response_model=JobListResponse)
async def jobs_mine(
    days: Optional[int] = Query(default=None, ge=1, le=90),
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobListResponse:
    jobs, day_count = await service.list_mine(str(claims["sub"]), days)
    return JobListResponse(
        items=[_job_summary(j, settings) for j in jobs],
        days=day_count,
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.get("/jobs/{job_sheet_id}", response_model=JobDetailResponse)
async def job_detail(
    job_sheet_id: str,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobDetailResponse:
    job = await service.get_job_for_staff(job_sheet_id, str(claims["sub"]))
    recordings = await service.list_recordings(job_sheet_id, str(claims["sub"]))
    return JobDetailResponse(
        job=_job_summary(job, settings),
        recordings=[RecordingOut.model_validate(r) for r in recordings],
        processing_started_at=job.get("processing_started_at"),
        processing_completed_at=job.get("processing_completed_at"),
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.get("/jobs/{job_sheet_id}/recordings", response_model=list[RecordingOut])
async def job_recordings(
    job_sheet_id: str,
    claims: dict = Depends(get_current_claims),
    service: JobService = Depends(job_service),
) -> list[RecordingOut]:
    recordings = await service.list_recordings(job_sheet_id, str(claims["sub"]))
    return [RecordingOut.model_validate(r) for r in recordings]


@router.post("/jobs/{job_sheet_id}/recordings", response_model=RecordingUploadResponse)
@router.post("/jobs/{job_sheet_id}/recordings/upload", response_model=RecordingUploadResponse)
async def upload_recording(
    job_sheet_id: str,
    file: UploadFile = File(...),
    duration_seconds: float = Form(0),
    trigger_processing: bool = Form(True),
    claims: dict = Depends(get_current_claims),
    service: JobService = Depends(job_service),
) -> RecordingUploadResponse:
    result = await service.save_recording(
        job_sheet_id=job_sheet_id,
        staff_id=str(claims["sub"]),
        staff_email=str(claims.get("email", "")),
        file=file,
        duration_seconds=duration_seconds,
        trigger_processing=trigger_processing,
    )
    return RecordingUploadResponse(**result)


@router.post(
    "/jobs/{job_sheet_id}/recordings/{recording_id}/invalidate",
    response_model=RecordingMutationResponse,
)
async def invalidate_recording(
    job_sheet_id: str,
    recording_id: str,
    body: InvalidateRecordingRequest,
    claims: dict = Depends(get_current_claims),
    service: JobService = Depends(job_service),
) -> RecordingMutationResponse:
    result = await service.invalidate_recording(
        job_sheet_id=job_sheet_id,
        recording_id=recording_id,
        staff_id=str(claims["sub"]),
        reason=body.reason,
    )
    return RecordingMutationResponse(**result)


@router.delete(
    "/jobs/{job_sheet_id}/recordings/{recording_id}",
    response_model=RecordingMutationResponse,
)
async def delete_recording(
    job_sheet_id: str,
    recording_id: str,
    claims: dict = Depends(get_current_claims),
    service: JobService = Depends(job_service),
) -> RecordingMutationResponse:
    result = await service.delete_recording(
        job_sheet_id=job_sheet_id,
        recording_id=recording_id,
        staff_id=str(claims["sub"]),
    )
    return RecordingMutationResponse(**result)


@router.post("/jobs/{job_sheet_id}/process", response_model=ProcessResponse)
async def process_job(
    job_sheet_id: str,
    body: ProcessRequest,
    claims: dict = Depends(get_current_claims),
    service: JobService = Depends(job_service),
) -> ProcessResponse:
    result = await service.trigger_process(
        job_sheet_id,
        str(claims["sub"]),
        str(claims.get("email", "")),
        body.force_reprocess,
    )
    return ProcessResponse(
        status=str(result.get("status", "Error")),
        action=str(result.get("action", "process_voice_dictation")),
        message=str(result.get("message", "")),
        record_id=result.get("record_id"),
        timestamp=result.get("timestamp"),
        proxied=bool(result.get("proxied", True)),
    )
