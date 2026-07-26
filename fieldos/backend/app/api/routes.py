from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status

from app.core.config import Settings, get_settings
from app.core.roles import actor_identity, is_manager_or_admin, normalize_role, require_manager_or_admin
from app.core.security import create_access_token, get_current_claims
from app.models.schemas import (
    ApproveJobRequest,
    CompletionFinaliseRequest,
    CompletionGenerateRequest,
    CompletionListResponse,
    CompletionReopenRequest,
    CompletionUpdateRequest,
    CreateExportBatchRequest,
    DashboardResponse,
    DashboardSummaryResponse,
    ExportBatchListResponse,
    ExportBatchResponse,
    ExportBatchVersionRequest,
    ExportReadinessResponse,
    HealthResponse,
    InvalidateRecordingRequest,
    JobCompletionOut,
    JobCompletionResponse,
    JobDetailResponse,
    JobListResponse,
    JobReviewFields,
    JobReviewResponse,
    JobSummary,
    LabourEntry,
    LoginRequest,
    LoginResponse,
    MachineryEntry,
    MaterialEntry,
    ProcessRequest,
    ProcessResponse,
    ReadyResponse,
    RecordingMutationResponse,
    RecordingOut,
    RecordingUploadResponse,
    ReopenJobRequest,
    ReturnJobRequest,
    ReviewEditRequest,
    StaffOut,
)
from app.services.auth_store import AuthUserStore
from app.services.jobs import JobService

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


def _confidence(value) -> Optional[float]:

    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _job_review_fields(job: dict, settings: Settings, *, include_transcript: bool) -> JobReviewFields:
    summary = _job_summary(job, settings)
    transcript = str(job.get("ai_transcript") or "")
    return JobReviewFields(
        job_sheet_id=summary.job_sheet_id,
        job_date=summary.job_date,
        project_name=summary.project_name,
        customer_name=summary.customer_name,
        processing_status=summary.processing_status,
        approval_status=summary.approval_status,
        processing_error=summary.processing_error,
        processing_started_at=job.get("processing_started_at"),
        processing_completed_at=job.get("processing_completed_at"),
        assigned_staff_id=str(job.get("assigned_staff_id") or job.get(settings.job_assignment_column) or ""),
        ai_summary=str(job.get("ai_summary") or ""),
        client_requests=str(job.get("client_requests") or ""),
        variations=str(job.get("variations") or ""),
        safety_issues=str(job.get("safety_issues") or ""),
        manager_review_items=str(job.get("manager_review_items") or ""),
        weather=str(job.get("weather") or ""),
        travel_time=str(job.get("travel_time") or ""),
        ai_confidence_score=_confidence(job.get("ai_confidence_score")),
        manager_notes=str(job.get("manager_notes") or ""),
        approved_by=str(job.get("approved_by") or ""),
        approved_at=job.get("approved_at"),
        returned_by=str(job.get("returned_by") or ""),
        returned_at=job.get("returned_at"),
        return_reason=str(job.get("return_reason") or ""),
        ai_transcript_character_count=int(job.get("ai_transcript_character_count") or len(transcript)),
        ai_transcript=transcript if include_transcript else None,
    )


def _review_body(model) -> dict:
    data = model.model_dump(exclude_none=True)
    return data


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


@router.get("/jobs", response_model=JobListResponse)
async def jobs_for_review(
    days: Optional[int] = Query(default=None, ge=1, le=90),
    processing_status: Optional[str] = Query(default=None, max_length=100),
    approval_status: Optional[str] = Query(default=None, max_length=100),
    search: Optional[str] = Query(default=None, max_length=200),
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobListResponse:
    role = require_manager_or_admin(claims)
    jobs, day_count = await service.list_reviewable(
        staff_id=str(claims["sub"]),
        actor_role=role,
        days=days,
        processing_status=processing_status,
        approval_status=approval_status,
        search=search,
    )
    return JobListResponse(
        items=[_job_summary(job, settings) for job in jobs],
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
    role = normalize_role(str(claims.get("role") or ""))
    job = await service.get_job_for_staff(
        job_sheet_id,
        str(claims["sub"]),
        actor_role=role,
        include_transcript=False,
    )
    recordings = await service.list_recordings(
        job_sheet_id,
        str(claims["sub"]),
        actor_role=role,
    )
    return JobDetailResponse(
        job=_job_summary(job, settings),
        recordings=[RecordingOut.model_validate(r) for r in recordings],
        processing_started_at=job.get("processing_started_at"),
        processing_completed_at=job.get("processing_completed_at"),
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.get("/jobs/{job_sheet_id}/review", response_model=JobReviewResponse)
async def job_review(
    job_sheet_id: str,
    include_transcript: bool = Query(default=False),
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobReviewResponse:
    role = normalize_role(str(claims.get("role") or ""))
    manager = is_manager_or_admin(role)
    if include_transcript and not manager:
        raise HTTPException(status_code=403, detail="Manager or admin role required for transcript.")
    job = await service.get_job_for_staff(
        job_sheet_id,
        str(claims["sub"]),
        actor_role=role,
        include_transcript=include_transcript and manager,
    )
    # Mock path may still hold transcript on the row — strip for staff.
    if not manager:
        job = dict(job)
        job.pop("ai_transcript", None)
    recordings = await service.list_recordings(
        job_sheet_id,
        str(claims["sub"]),
        actor_role=role,
    )
    if not manager:
        recordings = [
            {**r, "recording_drive_file_id": ""} if isinstance(r, dict) else r for r in recordings
        ]
    can_edit = manager and str(job.get("approval_status") or "") != "Approved"
    can_approve = manager and str(job.get("processing_status") or "").strip() == "Completed"
    return JobReviewResponse(
        job=_job_review_fields(job, settings, include_transcript=include_transcript and manager),
        recordings=[RecordingOut.model_validate(r) for r in recordings],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
        can_edit=can_edit,
        can_approve=can_approve,
    )


async def _review_mutation_response(
    *,
    action: str,
    job_sheet_id: str,
    claims: dict,
    settings: Settings,
    service: JobService,
    body: dict,
) -> JobReviewResponse:
    role = require_manager_or_admin(claims)
    result = await service.review_action(
        action,
        job_sheet_id=job_sheet_id,
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body=body,
    )
    job = result["job"]
    recordings = await service.list_recordings(
        job_sheet_id,
        str(claims["sub"]),
        actor_role=role,
    )
    return JobReviewResponse(
        job=_job_review_fields(job, settings, include_transcript=False),
        recordings=[RecordingOut.model_validate(r) for r in recordings],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
        warnings=list(result.get("warnings") or []),
        can_edit=str(job.get("approval_status") or "") != "Approved",
        can_approve=str(job.get("processing_status") or "").strip() == "Completed",
    )


@router.patch("/jobs/{job_sheet_id}/review", response_model=JobReviewResponse)
async def patch_job_review(
    job_sheet_id: str,
    body: ReviewEditRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobReviewResponse:
    return await _review_mutation_response(
        action="update_job_review",
        job_sheet_id=job_sheet_id,
        claims=claims,
        settings=settings,
        service=service,
        body=_review_body(body),
    )


@router.post("/jobs/{job_sheet_id}/approve", response_model=JobReviewResponse)
async def approve_job(
    job_sheet_id: str,
    body: ApproveJobRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobReviewResponse:
    return await _review_mutation_response(
        action="approve_job_sheet",
        job_sheet_id=job_sheet_id,
        claims=claims,
        settings=settings,
        service=service,
        body=_review_body(body),
    )


@router.post("/jobs/{job_sheet_id}/return", response_model=JobReviewResponse)
async def return_job(
    job_sheet_id: str,
    body: ReturnJobRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobReviewResponse:
    return await _review_mutation_response(
        action="return_job_sheet",
        job_sheet_id=job_sheet_id,
        claims=claims,
        settings=settings,
        service=service,
        body=_review_body(body),
    )


@router.post("/jobs/{job_sheet_id}/reopen", response_model=JobReviewResponse)
async def reopen_job(
    job_sheet_id: str,
    body: ReopenJobRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobReviewResponse:
    return await _review_mutation_response(
        action="reopen_job_sheet",
        job_sheet_id=job_sheet_id,
        claims=claims,
        settings=settings,
        service=service,
        body=_review_body(body),
    )


def _completion_response(result: dict, settings: Settings, service: JobService) -> JobCompletionResponse:
    completion = result.get("completion")
    return JobCompletionResponse(
        completion=JobCompletionOut.model_validate(completion) if completion else None,
        labour_entries=[LabourEntry.model_validate(row) for row in (result.get("labour_entries") or [])],
        machinery_entries=[
            MachineryEntry.model_validate(row) for row in (result.get("machinery_entries") or [])
        ],
        material_entries=[
            MaterialEntry.model_validate(row) for row in (result.get("material_entries") or [])
        ],
        can_edit=bool(result.get("can_edit")),
        can_finalise=bool(result.get("can_finalise")),
        can_reopen=bool(result.get("can_reopen")),
        can_generate=bool(result.get("can_generate")),
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.get("/completions", response_model=CompletionListResponse)
async def list_completions(
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> CompletionListResponse:
    role = require_manager_or_admin(claims)
    result = await service.list_completions(str(claims["sub"]), role)
    from app.models.schemas import CompletionListItem

    return CompletionListResponse(
        items=[CompletionListItem.model_validate(item) for item in (result.get("items") or [])],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


def _dashboard_filters(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    completion_status: Optional[str] = None,
    approval_status: Optional[str] = None,
    customer: Optional[str] = None,
    project: Optional[str] = None,
    assigned_staff_id: Optional[str] = None,
    billable: Optional[bool] = None,
    q: Optional[str] = None,
) -> dict:
    return {
        "date_from": date_from,
        "date_to": date_to,
        "completion_status": completion_status,
        "approval_status": approval_status,
        "customer": customer,
        "project": project,
        "assigned_staff_id": assigned_staff_id,
        "billable": billable,
        "q": q,
    }


@router.get("/completions/dashboard", response_model=DashboardResponse)
async def completions_dashboard(
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    completion_status: Optional[str] = Query(None),
    approval_status: Optional[str] = Query(None),
    customer: Optional[str] = Query(None),
    project: Optional[str] = Query(None),
    assigned_staff_id: Optional[str] = Query(None),
    billable: Optional[bool] = Query(None),
    q: Optional[str] = Query(None),
) -> DashboardResponse:
    role = require_manager_or_admin(claims)
    result = await service.completion_dashboard(
        str(claims["sub"]),
        role,
        _dashboard_filters(
            date_from,
            date_to,
            completion_status,
            approval_status,
            customer,
            project,
            assigned_staff_id,
            billable,
            q,
        ),
    )
    from app.models.schemas import DashboardItem, DashboardSummary

    return DashboardResponse(
        items=[DashboardItem.model_validate(item) for item in (result.get("items") or [])],
        filters=result.get("filters") or {},
        summary=DashboardSummary.model_validate(result.get("summary") or {}),
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.get("/completions/dashboard/summary", response_model=DashboardSummaryResponse)
async def completions_dashboard_summary(
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    completion_status: Optional[str] = Query(None),
    approval_status: Optional[str] = Query(None),
    customer: Optional[str] = Query(None),
    project: Optional[str] = Query(None),
    assigned_staff_id: Optional[str] = Query(None),
    billable: Optional[bool] = Query(None),
    q: Optional[str] = Query(None),
) -> DashboardSummaryResponse:
    role = require_manager_or_admin(claims)
    result = await service.completion_dashboard_summary(
        str(claims["sub"]),
        role,
        _dashboard_filters(
            date_from,
            date_to,
            completion_status,
            approval_status,
            customer,
            project,
            assigned_staff_id,
            billable,
            q,
        ),
    )
    from app.models.schemas import DashboardSummary

    return DashboardSummaryResponse(
        summary=DashboardSummary.model_validate(result.get("summary") or {}),
        filters=result.get("filters") or {},
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.get("/completions/{completion_id}/readiness", response_model=ExportReadinessResponse)
async def completion_export_readiness(
    completion_id: str,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> ExportReadinessResponse:
    role = require_manager_or_admin(claims)
    result = await service.completion_export_readiness(str(claims["sub"]), role, completion_id)
    from app.models.schemas import ExportReadiness

    return ExportReadinessResponse(
        completion_id=str(result.get("completion_id") or completion_id),
        job_sheet_id=str(result.get("job_sheet_id") or ""),
        readiness=ExportReadiness.model_validate(result.get("readiness") or {}),
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


def _export_batch_response(result: dict, settings: Settings, service: JobService) -> ExportBatchResponse:
    from app.models.schemas import ExportBatchItemOut, ExportBatchOut

    batch = result.get("export_batch") or result
    return ExportBatchResponse(
        export_batch=ExportBatchOut.model_validate(batch),
        items=[ExportBatchItemOut.model_validate(item) for item in (result.get("items") or [])],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.get("/exports", response_model=ExportBatchListResponse)
async def list_exports(
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> ExportBatchListResponse:
    role = require_manager_or_admin(claims)
    result = await service.export_action(
        "list_export_batches",
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body={},
    )
    from app.models.schemas import ExportBatchListItem

    return ExportBatchListResponse(
        items=[ExportBatchListItem.model_validate(item) for item in (result.get("items") or [])],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.post("/exports", response_model=ExportBatchResponse)
async def create_export(
    body: CreateExportBatchRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> ExportBatchResponse:
    role = require_manager_or_admin(claims)
    result = await service.export_action(
        "create_export_batch",
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body=body.model_dump(exclude_none=True),
    )
    return _export_batch_response(result, settings, service)


@router.get("/exports/{export_batch_id}", response_model=ExportBatchResponse)
async def get_export(
    export_batch_id: str,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> ExportBatchResponse:
    role = require_manager_or_admin(claims)
    result = await service.export_action(
        "get_export_batch",
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body={"export_batch_id": export_batch_id},
    )
    return _export_batch_response(result, settings, service)


@router.post("/exports/{export_batch_id}/validate", response_model=ExportBatchResponse)
async def validate_export(
    export_batch_id: str,
    body: ExportBatchVersionRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> ExportBatchResponse:
    role = require_manager_or_admin(claims)
    result = await service.export_action(
        "validate_export_batch",
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body={"export_batch_id": export_batch_id, **body.model_dump(exclude_none=True)},
    )
    return _export_batch_response(result, settings, service)


@router.post("/exports/{export_batch_id}/generate", response_model=ExportBatchResponse)
async def generate_export(
    export_batch_id: str,
    body: ExportBatchVersionRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> ExportBatchResponse:
    role = require_manager_or_admin(claims)
    result = await service.export_action(
        "generate_export_batch",
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body={"export_batch_id": export_batch_id, **body.model_dump(exclude_none=True)},
    )
    return _export_batch_response(result, settings, service)


@router.post("/exports/{export_batch_id}/cancel", response_model=ExportBatchResponse)
async def cancel_export(
    export_batch_id: str,
    body: ExportBatchVersionRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> ExportBatchResponse:
    role = require_manager_or_admin(claims)
    result = await service.export_action(
        "cancel_export_batch",
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body={"export_batch_id": export_batch_id, **body.model_dump(exclude_none=True)},
    )
    return _export_batch_response(result, settings, service)


@router.get("/exports/{export_batch_id}/download")
async def download_export(
    export_batch_id: str,
    claims: dict = Depends(get_current_claims),
    service: JobService = Depends(job_service),
):
    role = require_manager_or_admin(claims)
    result = await service.export_action(
        "get_export_batch_csv",
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body={"export_batch_id": export_batch_id},
    )
    csv_text = str(result.get("csv_text") or "")
    file_name = str(result.get("file_name") or "export.csv").replace('"', "")
    return Response(
        content=csv_text.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{file_name}"',
            "X-Export-Checksum": str(result.get("checksum") or ""),
        },
    )


@router.get("/jobs/{job_sheet_id}/completion", response_model=JobCompletionResponse)
async def get_job_completion(
    job_sheet_id: str,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobCompletionResponse:
    role = normalize_role(str(claims.get("role") or ""))
    result = await service.get_completion(job_sheet_id, str(claims["sub"]), role)
    return _completion_response(result, settings, service)


@router.post("/jobs/{job_sheet_id}/completion", response_model=JobCompletionResponse)
async def create_job_completion(
    job_sheet_id: str,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobCompletionResponse:
    role = require_manager_or_admin(claims)
    result = await service.completion_action(
        "create_job_completion_draft",
        job_sheet_id=job_sheet_id,
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body={},
    )
    return _completion_response(result, settings, service)


@router.post("/jobs/{job_sheet_id}/completion/generate", response_model=JobCompletionResponse)
async def generate_job_completion(
    job_sheet_id: str,
    body: CompletionGenerateRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobCompletionResponse:
    role = require_manager_or_admin(claims)
    result = await service.completion_action(
        "generate_job_completion_draft",
        job_sheet_id=job_sheet_id,
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body=body.model_dump(exclude_none=True),
    )
    return _completion_response(result, settings, service)


@router.patch("/jobs/{job_sheet_id}/completion", response_model=JobCompletionResponse)
async def patch_job_completion(
    job_sheet_id: str,
    body: CompletionUpdateRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobCompletionResponse:
    role = require_manager_or_admin(claims)
    payload = body.model_dump(exclude_none=True)
    if body.labour_entries is not None:
        payload["labour_entries"] = [row.model_dump(exclude_none=True) for row in body.labour_entries]
    if body.machinery_entries is not None:
        payload["machinery_entries"] = [
            row.model_dump(exclude_none=True) for row in body.machinery_entries
        ]
    if body.material_entries is not None:
        payload["material_entries"] = [
            row.model_dump(exclude_none=True) for row in body.material_entries
        ]
    result = await service.completion_action(
        "update_job_completion",
        job_sheet_id=job_sheet_id,
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body=payload,
    )
    return _completion_response(result, settings, service)


@router.post("/jobs/{job_sheet_id}/completion/finalise", response_model=JobCompletionResponse)
async def finalise_job_completion(
    job_sheet_id: str,
    body: CompletionFinaliseRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobCompletionResponse:
    role = require_manager_or_admin(claims)
    result = await service.completion_action(
        "finalise_job_completion",
        job_sheet_id=job_sheet_id,
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body=body.model_dump(exclude_none=True),
    )
    return _completion_response(result, settings, service)


@router.post("/jobs/{job_sheet_id}/completion/reopen", response_model=JobCompletionResponse)
async def reopen_job_completion(
    job_sheet_id: str,
    body: CompletionReopenRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> JobCompletionResponse:
    role = require_manager_or_admin(claims)
    result = await service.completion_action(
        "reopen_job_completion",
        job_sheet_id=job_sheet_id,
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body=body.model_dump(exclude_none=True),
    )
    return _completion_response(result, settings, service)


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
