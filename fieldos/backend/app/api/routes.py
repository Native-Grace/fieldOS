from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile

from app.core.config import Settings, get_settings
from app.core.security import create_access_token, get_current_claims
from app.models.schemas import (
    HealthResponse,
    JobDetailResponse,
    JobListResponse,
    JobSummary,
    LoginRequest,
    LoginResponse,
    ProcessRequest,
    ProcessResponse,
    ReadyResponse,
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
    raw_date = job.get(settings.job_date_column)
    job_date = None
    if raw_date:
        job_date = date.fromisoformat(str(raw_date)[:10])
    return JobSummary(
        job_sheet_id=str(job.get("job_sheet_id", "")),
        job_date=job_date,
        project_name=str(job.get(settings.job_project_column, "") or ""),
        customer_name=str(job.get(settings.job_customer_column, "") or ""),
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
    checks = {
        "auth_store": True,
        "data_mode_mock": settings.data_mode == "mock",
        "apps_script_configured": bool(settings.apps_script_webapp_url and settings.apps_script_webhook_secret),
        "jwt_secret_set": bool(settings.jwt_secret) and settings.jwt_secret != "dev-only-change-me",
    }
    # Ready for local mock if auth works; apps script optional
    ok = checks["auth_store"] and settings.data_mode in ("mock", "sheets")
    return ReadyResponse(
        status="ok" if ok else "degraded",
        data_mode=settings.data_mode,
        checks=checks,
        message="Ready for local mock mode" if ok else "Not ready",
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
def jobs_mine(
    days: Optional[int] = Query(default=None, ge=1, le=90),
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobListResponse:
    jobs, day_count = service.list_mine(str(claims["sub"]), days)
    return JobListResponse(
        items=[_job_summary(j, settings) for j in jobs],
        days=day_count,
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.get("/jobs/{job_sheet_id}", response_model=JobDetailResponse)
def job_detail(
    job_sheet_id: str,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobDetailResponse:
    job = service.get_job_for_staff(job_sheet_id, str(claims["sub"]))
    recordings = service.list_recordings(job_sheet_id, str(claims["sub"]))
    return JobDetailResponse(
        job=_job_summary(job, settings),
        recordings=[RecordingOut.model_validate(r) for r in recordings],
        processing_started_at=job.get("processing_started_at"),
        processing_completed_at=job.get("processing_completed_at"),
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.get("/jobs/{job_sheet_id}/recordings", response_model=list[RecordingOut])
def job_recordings(
    job_sheet_id: str,
    claims: dict = Depends(get_current_claims),
    service: JobService = Depends(job_service),
) -> list[RecordingOut]:
    recordings = service.list_recordings(job_sheet_id, str(claims["sub"]))
    return [RecordingOut.model_validate(r) for r in recordings]


@router.post("/jobs/{job_sheet_id}/recordings", response_model=RecordingUploadResponse)
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
