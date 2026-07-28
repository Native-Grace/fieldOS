from datetime import date, datetime, timezone
from io import BytesIO
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import StreamingResponse

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
    CreateFinancialSnapshotRequest,
    CreateReportBatchRequest,
    CustomerPricingIn,
    CustomerPricingListResponse,
    CustomerPricingResponse,
    CustomerPricingUpdateRequest,
    DashboardResponse,
    DashboardSummaryResponse,
    ExportBatchListResponse,
    ExportBatchResponse,
    ExportBatchVersionRequest,
    ExportReadinessResponse,
    FinancialSnapshotListResponse,
    FinancialSnapshotResponse,
    FinancialSnapshotVersionRequest,
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
    LabourRateIn,
    LabourRateListResponse,
    LabourRateResponse,
    LabourRateUpdateRequest,
    LoginRequest,
    LoginResponse,
    MachineryEntry,
    MachineryRateIn,
    MachineryRateListResponse,
    MachineryRateResponse,
    MachineryRateUpdateRequest,
    MaterialCatalogItemIn,
    MaterialCatalogItemResponse,
    MaterialCatalogItemUpdateRequest,
    MaterialCatalogListResponse,
    MaterialEntry,
    PayrollMappingIn,
    PayrollMappingListResponse,
    PayrollMappingResponse,
    PayrollMappingUpdateRequest,
    PricingReadinessResponse,
    ProcessRequest,
    ProcessResponse,
    RateCardIn,
    RateCardListResponse,
    RateCardResponse,
    RateCardUpdateRequest,
    ReadyResponse,
    RecordingMutationResponse,
    RecordingOut,
    RecordingUploadResponse,
    ReopenJobRequest,
    ReportBatchListResponse,
    ReportBatchResponse,
    ReportBatchVersionRequest,
    ReportOptionsResponse,
    ReportPreviewRequest,
    ReportPreviewResponse,
    ReturnJobRequest,
    ReviewEditRequest,
    SendDeliveryRequest,
    SetAttachmentVisibilityRequest,
    StaffOut,
    SupersedeFinancialSnapshotRequest,
    UpdateDeliveryDraftRequest,
    UploadAttachmentRequest,
    AttachmentListResponse,
    AttachmentOut,
    AttachmentResponse,
    CreateDeliveryDraftRequest,
    DeliveryListResponse,
    DeliveryOptionsResponse,
    DeliveryOut,
    DeliveryResponse,
    DeliveryVersionRequest,
    EmailPreviewOut,
    XeroMappingIn,
    XeroMappingListResponse,
    XeroMappingResponse,
    XeroMappingUpdateRequest,
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
            # Display role preserved for UI; authorisation always normalises.
            "role": user.get("role", "Field Staff"),
            "role_display": user.get("role", "Field Staff"),
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


# --------------------------------------------------------------------------
# Phase 3F — job report PDFs. Managers reach every report type; staff are
# limited to the Staff Work Report over their own labour, plus a summary for a
# job sheet assigned to them. PDFs are rendered here from report data and
# validated before any bytes reach the client.
# --------------------------------------------------------------------------


def _report_role(claims: dict) -> str:
    return normalize_role(str(claims.get("role") or ""))


async def _report_call(
    action: str,
    *,
    claims: dict,
    service: JobService,
    body: dict,
) -> dict:
    return await service.report_action(
        action,
        staff_id=str(claims["sub"]),
        actor_role=_report_role(claims),
        actor_identity=actor_identity(claims),
        body=body,
    )


def _report_batch_response(
    result: dict, settings: Settings, service: JobService
) -> ReportBatchResponse:
    from app.models.schemas import ReportBatchItemOut, ReportBatchOut

    batch = result.get("report_batch") or result
    return ReportBatchResponse(
        report_batch=ReportBatchOut.model_validate(batch),
        items=[ReportBatchItemOut.model_validate(item) for item in (result.get("items") or [])],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


def _report_selection_body(body: ReportPreviewRequest) -> dict:
    payload = body.model_dump(exclude_none=True)
    if body.filters is not None:
        payload["filters"] = body.filters.model_dump(exclude_none=True)
    return payload


def _pdf_response(rendered: dict) -> StreamingResponse:
    file_name = str(rendered.get("file_name") or "report.pdf").replace('"', "")
    pdf = rendered["pdf_bytes"]
    return StreamingResponse(
        BytesIO(pdf),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{file_name}"',
            "Content-Length": str(len(pdf)),
            "X-Report-Checksum": str(rendered.get("checksum") or ""),
            "Cache-Control": "no-store",
        },
    )


@router.get("/reports/options", response_model=ReportOptionsResponse)
async def report_options(
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> ReportOptionsResponse:
    result = await _report_call("report_options", claims=claims, service=service, body={})
    return ReportOptionsResponse(
        **result,
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.post("/reports/preview", response_model=ReportPreviewResponse)
async def preview_report(
    body: ReportPreviewRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> ReportPreviewResponse:
    result = await _report_call(
        "report_preview",
        claims=claims,
        service=service,
        body=_report_selection_body(body),
    )
    from app.models.schemas import ReportPreviewItem, ReportTotals

    return ReportPreviewResponse(
        report_type=str(result.get("report_type") or body.report_type),
        filters=result.get("filters") or {},
        template_version=str(result.get("template_version") or ""),
        job_count=int(result.get("job_count") or 0),
        group_count=int(result.get("group_count") or 0),
        page_estimate=int(result.get("page_estimate") or 0),
        group_by=str(result.get("group_by") or body.group_by or ""),
        totals=ReportTotals.model_validate(result.get("totals") or {}),
        blockers=[str(b) for b in (result.get("blockers") or [])],
        items=[ReportPreviewItem.model_validate(item) for item in (result.get("items") or [])],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.get("/reports", response_model=ReportBatchListResponse)
async def list_reports(
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> ReportBatchListResponse:
    result = await _report_call("list_report_batches", claims=claims, service=service, body={})
    from app.models.schemas import ReportBatchListItem

    return ReportBatchListResponse(
        items=[ReportBatchListItem.model_validate(item) for item in (result.get("items") or [])],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.post("/reports", response_model=ReportBatchResponse)
async def create_report(
    body: CreateReportBatchRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> ReportBatchResponse:
    result = await _report_call(
        "create_report_batch",
        claims=claims,
        service=service,
        body=_report_selection_body(body),
    )
    return _report_batch_response(result, settings, service)


@router.get("/reports/{report_batch_id}", response_model=ReportBatchResponse)
async def get_report(
    report_batch_id: str,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> ReportBatchResponse:
    result = await _report_call(
        "get_report_batch",
        claims=claims,
        service=service,
        body={"report_batch_id": report_batch_id},
    )
    return _report_batch_response(result, settings, service)


@router.post("/reports/{report_batch_id}/validate", response_model=ReportBatchResponse)
async def validate_report(
    report_batch_id: str,
    body: ReportBatchVersionRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> ReportBatchResponse:
    result = await _report_call(
        "validate_report_batch",
        claims=claims,
        service=service,
        body={"report_batch_id": report_batch_id, **body.model_dump(exclude_none=True)},
    )
    return _report_batch_response(result, settings, service)


@router.post("/reports/{report_batch_id}/generate", response_model=ReportBatchResponse)
async def generate_report(
    report_batch_id: str,
    body: ReportBatchVersionRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> ReportBatchResponse:
    result = await _report_call(
        "generate_report_batch",
        claims=claims,
        service=service,
        body={"report_batch_id": report_batch_id, **body.model_dump(exclude_none=True)},
    )
    return _report_batch_response(result, settings, service)


@router.post("/reports/{report_batch_id}/cancel", response_model=ReportBatchResponse)
async def cancel_report(
    report_batch_id: str,
    body: ReportBatchVersionRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> ReportBatchResponse:
    result = await _report_call(
        "cancel_report_batch",
        claims=claims,
        service=service,
        body={"report_batch_id": report_batch_id, **body.model_dump(exclude_none=True)},
    )
    return _report_batch_response(result, settings, service)


@router.get("/reports/{report_batch_id}/download")
async def download_report(
    report_batch_id: str,
    claims: dict = Depends(get_current_claims),
    service: JobService = Depends(job_service),
) -> StreamingResponse:
    rendered = await service.report_pdf(
        report_batch_id,
        staff_id=str(claims["sub"]),
        actor_role=_report_role(claims),
        actor_identity=actor_identity(claims),
    )
    return _pdf_response(rendered)


@router.get("/jobs/{job_sheet_id}/summary.pdf")
async def job_summary_pdf(
    job_sheet_id: str,
    claims: dict = Depends(get_current_claims),
    service: JobService = Depends(job_service),
) -> StreamingResponse:
    rendered = await service.job_summary_pdf(
        job_sheet_id,
        staff_id=str(claims["sub"]),
        actor_role=_report_role(claims),
        actor_identity=actor_identity(claims),
    )
    return _pdf_response(rendered)


# --------------------------------------------------------------------------
# Phase 3G — document deliveries and job attachments (manager/admin for send).
# --------------------------------------------------------------------------


async def _delivery_call(
    action: str,
    *,
    claims: dict,
    service: JobService,
    body: dict,
) -> dict:
    role = require_manager_or_admin(claims, endpoint=f"deliveries:{action}")
    # Never trust client-supplied role fields — claims only.
    from app.core.roles import strip_client_role_fields

    safe_body = strip_client_role_fields(body)
    return await service.delivery_action(
        action,
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body=safe_body,
    )


def _delivery_response(result: dict, settings: Settings, service: JobService) -> DeliveryResponse:
    preview = result.get("email_preview")
    replacement = result.get("replacement")
    return DeliveryResponse(
        delivery=DeliveryOut.model_validate(result.get("delivery") or {}),
        email_preview=EmailPreviewOut.model_validate(preview) if isinstance(preview, dict) else None,
        replacement=DeliveryOut.model_validate(replacement) if isinstance(replacement, dict) else None,
        sent=result.get("sent"),
        idempotent=result.get("idempotent"),
        confirm_required=result.get("confirm_required"),
        auto_send=result.get("auto_send"),
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.get("/deliveries/options", response_model=DeliveryOptionsResponse)
async def delivery_options(
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> DeliveryOptionsResponse:
    result = await _delivery_call("delivery_options", claims=claims, service=service, body={})
    return DeliveryOptionsResponse(
        **result,
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.get("/deliveries", response_model=DeliveryListResponse)
async def list_deliveries(
    job_sheet_id: Optional[str] = None,
    report_batch_id: Optional[str] = None,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> DeliveryListResponse:
    body: dict = {}
    if job_sheet_id:
        body["job_sheet_id"] = job_sheet_id
    if report_batch_id:
        body["report_batch_id"] = report_batch_id
    result = await _delivery_call("list_deliveries", claims=claims, service=service, body=body)
    return DeliveryListResponse(
        items=[DeliveryOut.model_validate(item) for item in (result.get("items") or [])],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.get("/deliveries/{delivery_id}", response_model=DeliveryResponse)
async def get_delivery(
    delivery_id: str,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> DeliveryResponse:
    result = await _delivery_call(
        "get_delivery",
        claims=claims,
        service=service,
        body={"delivery_id": delivery_id},
    )
    return _delivery_response(result, settings, service)


@router.post("/deliveries", response_model=DeliveryResponse)
async def create_delivery_draft(
    body: CreateDeliveryDraftRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> DeliveryResponse:
    result = await _delivery_call(
        "create_delivery_draft",
        claims=claims,
        service=service,
        body=body.model_dump(exclude_none=True),
    )
    return _delivery_response(result, settings, service)


@router.patch("/deliveries/{delivery_id}", response_model=DeliveryResponse)
async def update_delivery_draft(
    delivery_id: str,
    body: UpdateDeliveryDraftRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> DeliveryResponse:
    result = await _delivery_call(
        "update_delivery_draft",
        claims=claims,
        service=service,
        body={"delivery_id": delivery_id, **body.model_dump(exclude_none=True)},
    )
    return _delivery_response(result, settings, service)


@router.post("/deliveries/{delivery_id}/preview", response_model=DeliveryResponse)
async def preview_delivery(
    delivery_id: str,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> DeliveryResponse:
    result = await _delivery_call(
        "preview_delivery",
        claims=claims,
        service=service,
        body={"delivery_id": delivery_id},
    )
    return _delivery_response(result, settings, service)


@router.post("/deliveries/{delivery_id}/validate", response_model=DeliveryResponse)
async def validate_delivery(
    delivery_id: str,
    body: DeliveryVersionRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> DeliveryResponse:
    result = await _delivery_call(
        "validate_delivery",
        claims=claims,
        service=service,
        body={"delivery_id": delivery_id, **body.model_dump(exclude_none=True)},
    )
    return _delivery_response(result, settings, service)


@router.post("/deliveries/{delivery_id}/send", response_model=DeliveryResponse)
async def send_delivery(
    delivery_id: str,
    body: SendDeliveryRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> DeliveryResponse:
    result = await _delivery_call(
        "send_delivery",
        claims=claims,
        service=service,
        body={"delivery_id": delivery_id, **body.model_dump(exclude_none=True)},
    )
    return _delivery_response(result, settings, service)


@router.post("/deliveries/{delivery_id}/retry", response_model=DeliveryResponse)
async def retry_delivery(
    delivery_id: str,
    body: SendDeliveryRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> DeliveryResponse:
    result = await _delivery_call(
        "retry_delivery",
        claims=claims,
        service=service,
        body={"delivery_id": delivery_id, **body.model_dump(exclude_none=True)},
    )
    return _delivery_response(result, settings, service)


@router.post("/deliveries/{delivery_id}/cancel", response_model=DeliveryResponse)
async def cancel_delivery(
    delivery_id: str,
    body: DeliveryVersionRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> DeliveryResponse:
    result = await _delivery_call(
        "cancel_delivery",
        claims=claims,
        service=service,
        body={"delivery_id": delivery_id, **body.model_dump(exclude_none=True)},
    )
    return _delivery_response(result, settings, service)


@router.post("/deliveries/{delivery_id}/supersede", response_model=DeliveryResponse)
async def supersede_delivery(
    delivery_id: str,
    body: DeliveryVersionRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> DeliveryResponse:
    result = await _delivery_call(
        "supersede_delivery",
        claims=claims,
        service=service,
        body={"delivery_id": delivery_id, **body.model_dump(exclude_none=True)},
    )
    return _delivery_response(result, settings, service)


@router.get("/jobs/{job_sheet_id}/attachments", response_model=AttachmentListResponse)
async def list_job_attachments(
    job_sheet_id: str,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> AttachmentListResponse:
    result = await service.attachment_action(
        "list_attachments",
        staff_id=str(claims["sub"]),
        actor_role=_report_role(claims),
        actor_identity=actor_identity(claims),
        body={"job_sheet_id": job_sheet_id},
    )
    return AttachmentListResponse(
        items=[AttachmentOut.model_validate(item) for item in (result.get("items") or [])],
        antivirus_boundary=result.get("antivirus_boundary"),
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.post("/attachments", response_model=AttachmentResponse)
async def upload_attachment(
    body: UploadAttachmentRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> AttachmentResponse:
    result = await service.attachment_action(
        "upload_attachment",
        staff_id=str(claims["sub"]),
        actor_role=_report_role(claims),
        actor_identity=actor_identity(claims),
        body=body.model_dump(exclude_none=True),
    )
    return AttachmentResponse(
        attachment=AttachmentOut.model_validate(result.get("attachment") or {}),
        antivirus_boundary=result.get("antivirus_boundary"),
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.delete("/attachments/{attachment_id}", response_model=AttachmentResponse)
async def delete_attachment(
    attachment_id: str,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> AttachmentResponse:
    require_manager_or_admin(claims)
    result = await service.attachment_action(
        "delete_attachment",
        staff_id=str(claims["sub"]),
        actor_role=_report_role(claims),
        actor_identity=actor_identity(claims),
        body={"attachment_id": attachment_id},
    )
    return AttachmentResponse(
        attachment=AttachmentOut.model_validate(result.get("attachment") or {}),
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.post("/attachments/{attachment_id}/client-visible", response_model=AttachmentResponse)
async def set_attachment_client_visible(
    attachment_id: str,
    body: SetAttachmentVisibilityRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> AttachmentResponse:
    require_manager_or_admin(claims)
    result = await service.attachment_action(
        "set_attachment_client_visible",
        staff_id=str(claims["sub"]),
        actor_role=_report_role(claims),
        actor_identity=actor_identity(claims),
        body={"attachment_id": attachment_id, **body.model_dump()},
    )
    return AttachmentResponse(
        attachment=AttachmentOut.model_validate(result.get("attachment") or {}),
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


# --------------------------------------------------------------------------
# Phase 3E — rates, financial mappings and completion pricing snapshots.
# Every endpoint below is manager/admin only.
# --------------------------------------------------------------------------


async def _rates_call(
    action: str,
    *,
    claims: dict,
    service: JobService,
    body: dict,
) -> dict:
    role = require_manager_or_admin(claims)
    return await service.rates_action(
        action,
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body=body,
    )


def _rate_filters(
    on_date: Optional[str] = None,
    include_inactive: bool = False,
    **extra: Optional[str],
) -> dict:
    filters: dict = {"include_inactive": include_inactive}
    if on_date:
        filters["on_date"] = on_date
    for key, value in extra.items():
        if value:
            filters[key] = value
    return filters


@router.get("/rate-cards", response_model=RateCardListResponse)
async def list_rate_cards(
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
    on_date: Optional[str] = Query(None),
    include_inactive: bool = Query(False),
) -> RateCardListResponse:
    result = await _rates_call(
        "list_rate_cards",
        claims=claims,
        service=service,
        body=_rate_filters(on_date, include_inactive),
    )
    return RateCardListResponse(
        items=result.get("items") or [],
        overlaps=result.get("overlaps") or [],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.post("/rate-cards", response_model=RateCardResponse)
async def create_rate_card(
    body: RateCardIn,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> RateCardResponse:
    result = await _rates_call(
        "create_rate_card",
        claims=claims,
        service=service,
        body={"record": body.model_dump(exclude_none=True)},
    )
    return RateCardResponse(
        item=result["item"], data_mode=settings.data_mode, assumptions=service.assumptions()
    )


@router.patch("/rate-cards/{rate_card_id}", response_model=RateCardResponse)
async def update_rate_card(
    rate_card_id: str,
    body: RateCardUpdateRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> RateCardResponse:
    payload = body.model_dump(exclude_none=True)
    expected_version = payload.pop("expected_version", None)
    result = await _rates_call(
        "update_rate_card",
        claims=claims,
        service=service,
        body={
            "rate_card_id": rate_card_id,
            "expected_version": expected_version,
            "record": payload,
        },
    )
    return RateCardResponse(
        item=result["item"], data_mode=settings.data_mode, assumptions=service.assumptions()
    )


@router.get("/rates/labour", response_model=LabourRateListResponse)
async def list_labour_rates(
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
    on_date: Optional[str] = Query(None),
    include_inactive: bool = Query(False),
    rate_card_id: Optional[str] = Query(None),
    customer_id: Optional[str] = Query(None),
    staff_id: Optional[str] = Query(None),
) -> LabourRateListResponse:
    result = await _rates_call(
        "list_labour_rates",
        claims=claims,
        service=service,
        body=_rate_filters(
            on_date,
            include_inactive,
            rate_card_id=rate_card_id,
            customer_id=customer_id,
            staff_id_filter=staff_id,
        ),
    )
    return LabourRateListResponse(
        items=result.get("items") or [],
        overlaps=result.get("overlaps") or [],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.post("/rates/labour", response_model=LabourRateResponse)
async def create_labour_rate(
    body: LabourRateIn,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> LabourRateResponse:
    result = await _rates_call(
        "create_labour_rate",
        claims=claims,
        service=service,
        body={"record": body.model_dump(exclude_none=True)},
    )
    return LabourRateResponse(
        item=result["item"], data_mode=settings.data_mode, assumptions=service.assumptions()
    )


@router.patch("/rates/labour/{labour_rate_id}", response_model=LabourRateResponse)
async def update_labour_rate(
    labour_rate_id: str,
    body: LabourRateUpdateRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> LabourRateResponse:
    payload = body.model_dump(exclude_none=True)
    expected_version = payload.pop("expected_version", None)
    result = await _rates_call(
        "update_labour_rate",
        claims=claims,
        service=service,
        body={
            "labour_rate_id": labour_rate_id,
            "expected_version": expected_version,
            "record": payload,
        },
    )
    return LabourRateResponse(
        item=result["item"], data_mode=settings.data_mode, assumptions=service.assumptions()
    )


@router.get("/rates/machinery", response_model=MachineryRateListResponse)
async def list_machinery_rates(
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
    on_date: Optional[str] = Query(None),
    include_inactive: bool = Query(False),
    rate_card_id: Optional[str] = Query(None),
) -> MachineryRateListResponse:
    result = await _rates_call(
        "list_machinery_rates",
        claims=claims,
        service=service,
        body=_rate_filters(on_date, include_inactive, rate_card_id=rate_card_id),
    )
    return MachineryRateListResponse(
        items=result.get("items") or [],
        overlaps=result.get("overlaps") or [],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.post("/rates/machinery", response_model=MachineryRateResponse)
async def create_machinery_rate(
    body: MachineryRateIn,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> MachineryRateResponse:
    result = await _rates_call(
        "create_machinery_rate",
        claims=claims,
        service=service,
        body={"record": body.model_dump(exclude_none=True)},
    )
    return MachineryRateResponse(
        item=result["item"], data_mode=settings.data_mode, assumptions=service.assumptions()
    )


@router.patch("/rates/machinery/{machinery_rate_id}", response_model=MachineryRateResponse)
async def update_machinery_rate(
    machinery_rate_id: str,
    body: MachineryRateUpdateRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> MachineryRateResponse:
    payload = body.model_dump(exclude_none=True)
    expected_version = payload.pop("expected_version", None)
    result = await _rates_call(
        "update_machinery_rate",
        claims=claims,
        service=service,
        body={
            "machinery_rate_id": machinery_rate_id,
            "expected_version": expected_version,
            "record": payload,
        },
    )
    return MachineryRateResponse(
        item=result["item"], data_mode=settings.data_mode, assumptions=service.assumptions()
    )


@router.get("/materials/catalog", response_model=MaterialCatalogListResponse)
async def list_material_catalog(
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
    include_inactive: bool = Query(False),
) -> MaterialCatalogListResponse:
    result = await _rates_call(
        "list_material_catalog",
        claims=claims,
        service=service,
        body=_rate_filters(None, include_inactive),
    )
    return MaterialCatalogListResponse(
        items=result.get("items") or [],
        overlaps=result.get("overlaps") or [],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.post("/materials/catalog", response_model=MaterialCatalogItemResponse)
async def create_material_catalog_item(
    body: MaterialCatalogItemIn,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> MaterialCatalogItemResponse:
    result = await _rates_call(
        "create_material_catalog_item",
        claims=claims,
        service=service,
        body={"record": body.model_dump(exclude_none=True)},
    )
    return MaterialCatalogItemResponse(
        item=result["item"], data_mode=settings.data_mode, assumptions=service.assumptions()
    )


@router.patch("/materials/catalog/{material_id}", response_model=MaterialCatalogItemResponse)
async def update_material_catalog_item(
    material_id: str,
    body: MaterialCatalogItemUpdateRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> MaterialCatalogItemResponse:
    payload = body.model_dump(exclude_none=True)
    expected_version = payload.pop("expected_version", None)
    result = await _rates_call(
        "update_material_catalog_item",
        claims=claims,
        service=service,
        body={
            "material_id": material_id,
            "expected_version": expected_version,
            "record": payload,
        },
    )
    return MaterialCatalogItemResponse(
        item=result["item"], data_mode=settings.data_mode, assumptions=service.assumptions()
    )


@router.get("/pricing/customer", response_model=CustomerPricingListResponse)
async def list_customer_pricing(
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
    on_date: Optional[str] = Query(None),
    include_inactive: bool = Query(False),
    customer_id: Optional[str] = Query(None),
    rate_card_id: Optional[str] = Query(None),
) -> CustomerPricingListResponse:
    result = await _rates_call(
        "list_customer_pricing",
        claims=claims,
        service=service,
        body=_rate_filters(
            on_date, include_inactive, customer_id=customer_id, rate_card_id=rate_card_id
        ),
    )
    return CustomerPricingListResponse(
        items=result.get("items") or [],
        overlaps=result.get("overlaps") or [],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.post("/pricing/customer", response_model=CustomerPricingResponse)
async def create_customer_pricing(
    body: CustomerPricingIn,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> CustomerPricingResponse:
    result = await _rates_call(
        "create_customer_pricing",
        claims=claims,
        service=service,
        body={"record": body.model_dump(exclude_none=True)},
    )
    return CustomerPricingResponse(
        item=result["item"], data_mode=settings.data_mode, assumptions=service.assumptions()
    )


@router.patch("/pricing/customer/{customer_pricing_id}", response_model=CustomerPricingResponse)
async def update_customer_pricing(
    customer_pricing_id: str,
    body: CustomerPricingUpdateRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> CustomerPricingResponse:
    payload = body.model_dump(exclude_none=True)
    expected_version = payload.pop("expected_version", None)
    result = await _rates_call(
        "update_customer_pricing",
        claims=claims,
        service=service,
        body={
            "customer_pricing_id": customer_pricing_id,
            "expected_version": expected_version,
            "record": payload,
        },
    )
    return CustomerPricingResponse(
        item=result["item"], data_mode=settings.data_mode, assumptions=service.assumptions()
    )


@router.get("/mappings/payroll", response_model=PayrollMappingListResponse)
async def list_payroll_mappings(
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
    on_date: Optional[str] = Query(None),
    include_inactive: bool = Query(False),
    staff_id: Optional[str] = Query(None),
) -> PayrollMappingListResponse:
    result = await _rates_call(
        "list_payroll_mappings",
        claims=claims,
        service=service,
        body=_rate_filters(on_date, include_inactive, staff_id_filter=staff_id),
    )
    return PayrollMappingListResponse(
        items=result.get("items") or [],
        overlaps=result.get("overlaps") or [],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.post("/mappings/payroll", response_model=PayrollMappingResponse)
async def create_payroll_mapping(
    body: PayrollMappingIn,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> PayrollMappingResponse:
    result = await _rates_call(
        "create_payroll_mapping",
        claims=claims,
        service=service,
        body={"record": body.model_dump(exclude_none=True)},
    )
    return PayrollMappingResponse(
        item=result["item"], data_mode=settings.data_mode, assumptions=service.assumptions()
    )


@router.patch("/mappings/payroll/{payroll_mapping_id}", response_model=PayrollMappingResponse)
async def update_payroll_mapping(
    payroll_mapping_id: str,
    body: PayrollMappingUpdateRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> PayrollMappingResponse:
    payload = body.model_dump(exclude_none=True)
    expected_version = payload.pop("expected_version", None)
    result = await _rates_call(
        "update_payroll_mapping",
        claims=claims,
        service=service,
        body={
            "payroll_mapping_id": payroll_mapping_id,
            "expected_version": expected_version,
            "record": payload,
        },
    )
    return PayrollMappingResponse(
        item=result["item"], data_mode=settings.data_mode, assumptions=service.assumptions()
    )


@router.get("/mappings/xero", response_model=XeroMappingListResponse)
async def list_xero_mappings(
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
    include_inactive: bool = Query(False),
    entity_type: Optional[str] = Query(None),
) -> XeroMappingListResponse:
    result = await _rates_call(
        "list_xero_mappings",
        claims=claims,
        service=service,
        body=_rate_filters(None, include_inactive, entity_type=entity_type),
    )
    return XeroMappingListResponse(
        items=result.get("items") or [],
        overlaps=result.get("overlaps") or [],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.post("/mappings/xero", response_model=XeroMappingResponse)
async def create_xero_mapping(
    body: XeroMappingIn,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> XeroMappingResponse:
    result = await _rates_call(
        "create_xero_mapping",
        claims=claims,
        service=service,
        body={"record": body.model_dump(exclude_none=True)},
    )
    return XeroMappingResponse(
        item=result["item"], data_mode=settings.data_mode, assumptions=service.assumptions()
    )


@router.patch("/mappings/xero/{xero_mapping_id}", response_model=XeroMappingResponse)
async def update_xero_mapping(
    xero_mapping_id: str,
    body: XeroMappingUpdateRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> XeroMappingResponse:
    payload = body.model_dump(exclude_none=True)
    expected_version = payload.pop("expected_version", None)
    result = await _rates_call(
        "update_xero_mapping",
        claims=claims,
        service=service,
        body={
            "xero_mapping_id": xero_mapping_id,
            "expected_version": expected_version,
            "record": payload,
        },
    )
    return XeroMappingResponse(
        item=result["item"], data_mode=settings.data_mode, assumptions=service.assumptions()
    )


@router.get(
    "/completions/{completion_id}/pricing/readiness", response_model=PricingReadinessResponse
)
async def completion_pricing_readiness(
    completion_id: str,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> PricingReadinessResponse:
    role = require_manager_or_admin(claims)
    result = await service.pricing_readiness(
        staff_id=str(claims["sub"]), actor_role=role, completion_id=completion_id
    )
    return PricingReadinessResponse(
        **{**result, "completion_id": str(result.get("completion_id") or completion_id)},
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


async def _snapshot_call(
    action: str,
    *,
    claims: dict,
    service: JobService,
    body: dict,
) -> dict:
    role = require_manager_or_admin(claims)
    return await service.financial_snapshot_action(
        action,
        staff_id=str(claims["sub"]),
        actor_role=role,
        actor_identity=actor_identity(claims),
        body=body,
    )


def _snapshot_response(
    result: dict, settings: Settings, service: JobService
) -> FinancialSnapshotResponse:
    return FinancialSnapshotResponse(
        financial_snapshot=result.get("financial_snapshot") or {},
        lines=result.get("lines") or [],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.post(
    "/completions/{completion_id}/financial-snapshots", response_model=FinancialSnapshotResponse
)
async def create_financial_snapshot(
    completion_id: str,
    body: CreateFinancialSnapshotRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> FinancialSnapshotResponse:
    result = await _snapshot_call(
        "create_financial_snapshot",
        claims=claims,
        service=service,
        body={"completion_id": completion_id, **body.model_dump(exclude_none=True)},
    )
    return _snapshot_response(result, settings, service)


@router.get(
    "/completions/{completion_id}/financial-snapshots",
    response_model=FinancialSnapshotListResponse,
)
async def list_completion_financial_snapshots(
    completion_id: str,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
    snapshot_status: Optional[str] = Query(None),
) -> FinancialSnapshotListResponse:
    result = await _snapshot_call(
        "list_financial_snapshots",
        claims=claims,
        service=service,
        body={"completion_id": completion_id, "snapshot_status": snapshot_status or ""},
    )
    return FinancialSnapshotListResponse(
        items=result.get("items") or [],
        data_mode=settings.data_mode,
        assumptions=service.assumptions(),
    )


@router.get("/financial-snapshots/{snapshot_id}", response_model=FinancialSnapshotResponse)
async def get_financial_snapshot(
    snapshot_id: str,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> FinancialSnapshotResponse:
    result = await _snapshot_call(
        "get_financial_snapshot",
        claims=claims,
        service=service,
        body={"financial_snapshot_id": snapshot_id},
    )
    return _snapshot_response(result, settings, service)


@router.post(
    "/financial-snapshots/{snapshot_id}/validate", response_model=FinancialSnapshotResponse
)
async def validate_financial_snapshot(
    snapshot_id: str,
    body: FinancialSnapshotVersionRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> FinancialSnapshotResponse:
    result = await _snapshot_call(
        "validate_financial_snapshot",
        claims=claims,
        service=service,
        body={"financial_snapshot_id": snapshot_id, **body.model_dump(exclude_none=True)},
    )
    return _snapshot_response(result, settings, service)


@router.post(
    "/financial-snapshots/{snapshot_id}/approve", response_model=FinancialSnapshotResponse
)
async def approve_financial_snapshot(
    snapshot_id: str,
    body: FinancialSnapshotVersionRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> FinancialSnapshotResponse:
    result = await _snapshot_call(
        "approve_financial_snapshot",
        claims=claims,
        service=service,
        body={"financial_snapshot_id": snapshot_id, **body.model_dump(exclude_none=True)},
    )
    return _snapshot_response(result, settings, service)


@router.post(
    "/financial-snapshots/{snapshot_id}/supersede", response_model=FinancialSnapshotResponse
)
async def supersede_financial_snapshot(
    snapshot_id: str,
    body: SupersedeFinancialSnapshotRequest,
    claims: dict = Depends(get_current_claims),
    settings: Settings = Depends(get_settings),
    service: JobService = Depends(job_service),
) -> FinancialSnapshotResponse:
    result = await _snapshot_call(
        "supersede_financial_snapshot",
        claims=claims,
        service=service,
        body={"financial_snapshot_id": snapshot_id, **body.model_dump(exclude_none=True)},
    )
    return _snapshot_response(result, settings, service)


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
