"""Phase 3G delivery / attachment / privacy tests."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.services.attachment_math import (
    antivirus_boundary_note,
    validate_attachment_upload,
)
from app.services.delivery_math import (
    PROFILE_CLIENT_JOB_SUMMARY,
    PROFILE_INTERNAL_JOB_SHEET,
    STATUS_FAILED,
    STATUS_READY,
    STATUS_SENT,
    apply_pdf_profile,
    build_idempotency_key,
    client_payload_is_clean,
    delivery_transition_allowed,
    email_send_allowed,
    drive_filing_allowed,
)


def _clear_settings() -> None:
    from app.core.config import get_settings

    get_settings.cache_clear()


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("DATA_MODE", "mock")
    monkeypatch.setenv("FIELDOS_ENV", "development")
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    monkeypatch.setenv("AUTH_USERS_FILE", str(tmp_path / "auth_users.json"))
    monkeypatch.setenv("MOCK_DATA_DIR", str(tmp_path / "mock"))
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "recordings"))
    monkeypatch.setenv("DEMO_STAFF_EMAIL", "alex@nativegrace.com")
    monkeypatch.setenv("DEMO_STAFF_PASSWORD", "FieldOS-Demo-2026!")
    monkeypatch.setenv("DEMO_STAFF_ID", "STAFF-DEMO001")
    monkeypatch.setenv("DEMO_MANAGER_ENABLED", "true")
    monkeypatch.setenv("DEMO_MANAGER_EMAIL", "manager@nativegrace.com")
    monkeypatch.setenv("DEMO_MANAGER_PASSWORD", "FieldOS-Manager-2026!")
    monkeypatch.setenv("DEMO_MANAGER_ID", "STAFF-MGR001")
    monkeypatch.setenv("DOCUMENT_EMAIL_ENABLED", "false")
    monkeypatch.setenv("DOCUMENT_DRIVE_FILING_ENABLED", "false")
    _clear_settings()
    from app.main import app

    with TestClient(app) as c:
        yield c
    _clear_settings()


def _login(client: TestClient, email: str, password: str) -> str:
    resp = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _manager_headers(client: TestClient) -> dict[str, str]:
    token = _login(client, "manager@nativegrace.com", "FieldOS-Manager-2026!")
    return {"Authorization": f"Bearer {token}"}


def _staff_headers(client: TestClient) -> dict[str, str]:
    token = _login(client, "alex@nativegrace.com", "FieldOS-Demo-2026!")
    return {"Authorization": f"Bearer {token}"}


def test_client_profile_strips_forbidden_fields() -> None:
    dirty = {
        "job": {"job_sheet_id": "21759f5d", "customer_name": "Kat"},
        "completion": {
            "completion_id": "CMP-1",
            "work_summary": "Planted trees",
            "internal_notes": "SECRET NOTE",
            "warnings": ["pay issue"],
        },
        "internal_notes": "top secret",
        "drive_file_id": "DRIVESECRET",
        "ai_transcript": "TRANSCRIPT",
        "cost_rate": 99,
        "labour_entries": [{"staff_id": "S1", "notes": "private"}],
    }
    cleaned = apply_pdf_profile(dirty, PROFILE_CLIENT_JOB_SUMMARY)
    assert cleaned["audience"] == "client"
    assert "internal_notes" not in cleaned
    assert "drive_file_id" not in cleaned
    assert "ai_transcript" not in cleaned
    assert "cost_rate" not in cleaned
    assert "internal_notes" not in (cleaned.get("completion") or {})
    assert "warnings" not in (cleaned.get("completion") or {})
    leaks = client_payload_is_clean(cleaned)
    assert leaks == []

    internal = apply_pdf_profile(dirty, PROFILE_INTERNAL_JOB_SHEET)
    assert internal["audience"] == "internal"


def test_email_and_drive_gates_block_mock_and_local() -> None:
    ok, reason = email_send_allowed(data_mode="mock", email_enabled=True, fieldos_env="production")
    assert ok is False
    assert "mock" in reason.lower()

    ok, reason = email_send_allowed(
        data_mode="apps_script", email_enabled=False, fieldos_env="production"
    )
    assert ok is False

    ok, reason = drive_filing_allowed(
        data_mode="mock", drive_enabled=True, fieldos_env="production"
    )
    assert ok is False
    assert "mock" in reason.lower()


def test_idempotency_key_stable() -> None:
    a = build_idempotency_key(
        report_batch_id="RPT-1",
        job_sheet_id="21759f5d",
        document_type=PROFILE_CLIENT_JOB_SUMMARY,
        recipient_email="Client@Example.com",
        checksum="abc",
    )
    b = build_idempotency_key(
        report_batch_id="RPT-1",
        job_sheet_id="21759f5d",
        document_type=PROFILE_CLIENT_JOB_SUMMARY,
        recipient_email="client@example.com",
        checksum="abc",
    )
    assert a == b
    assert len(a) == 64


def test_attachment_rejects_executables_and_oversize() -> None:
    blockers = validate_attachment_upload(
        filename="payload.exe",
        mime_type="application/x-msdownload",
        byte_size=1000,
        attachment_type="other",
    )
    assert any("Executable" in b or "not allowed" in b for b in blockers)

    blockers = validate_attachment_upload(
        filename="plan.pdf",
        mime_type="application/pdf",
        byte_size=16,
        attachment_type="plan",
    )
    assert any("too small" in b for b in blockers)

    note = antivirus_boundary_note()
    assert "public links" in note.lower()
    assert "MIME" in note or "mime" in note.lower()


def test_delivery_transitions() -> None:
    assert delivery_transition_allowed("Draft", "Ready")
    assert delivery_transition_allowed("Ready", "Sent")
    assert delivery_transition_allowed("Failed", "Ready")
    assert not delivery_transition_allowed("Sent", "Draft")
    assert not delivery_transition_allowed("Cancelled", "Sent")


def test_staff_cannot_create_delivery(client: TestClient) -> None:
    staff = _staff_headers(client)
    resp = client.post(
        "/api/v1/deliveries",
        headers=staff,
        json={
            "document_type": PROFILE_CLIENT_JOB_SUMMARY,
            "recipient_email": "client@example.com",
            "job_sheet_id": "21759f5d",
            "delivery_method": "download_only",
        },
    )
    assert resp.status_code == 403


def test_create_delivery_requires_job_or_report_id(client: TestClient) -> None:
    headers = _manager_headers(client)
    missing = client.post(
        "/api/v1/deliveries",
        headers=headers,
        json={
            "document_type": PROFILE_CLIENT_JOB_SUMMARY,
            "recipient_email": "client@example.com",
            "delivery_method": "download_only",
        },
    )
    assert missing.status_code == 422
    assert "report_batch_id or job_sheet_id" in missing.json()["detail"].lower()

    job_ok = client.post(
        "/api/v1/deliveries",
        headers=headers,
        json={
            "document_type": PROFILE_CLIENT_JOB_SUMMARY,
            "recipient_email": "client@example.com",
            "job_sheet_id": "21759f5d",
            "delivery_method": "download_only",
        },
    )
    assert job_ok.status_code == 200, job_ok.text
    assert job_ok.json()["delivery"]["job_sheet_id"] == "21759f5d"
    assert not job_ok.json()["delivery"]["report_batch_id"]


def test_delivery_ignores_frontend_actor_role_and_uses_claims(client: TestClient) -> None:
    """Staff JWT cannot escalate via body.actor_role; manager claims authorise."""
    from tests.test_job_reports import seed_finalised_job

    seed_finalised_job(job_sheet_id="21759f5d", completion_id="CMP-288481F1")

    staff = _staff_headers(client)
    denied = client.post(
        "/api/v1/deliveries",
        headers=staff,
        json={
            "document_type": PROFILE_INTERNAL_JOB_SHEET,
            "recipient_email": "ops@nativegrace.com",
            "job_sheet_id": "21759f5d",
            "delivery_method": "download_only",
            "actor_role": "manager",
            "role": "Manager",
        },
    )
    assert denied.status_code == 403

    headers = _manager_headers(client)
    created = client.post(
        "/api/v1/deliveries",
        headers=headers,
        json={
            "document_type": PROFILE_INTERNAL_JOB_SHEET,
            "recipient_email": "ops@nativegrace.com",
            "job_sheet_id": "21759f5d",
            "delivery_method": "download_only",
            "actor_role": "staff",  # must be ignored
        },
    )
    assert created.status_code == 200, created.text
    delivery = created.json()["delivery"]
    validated = client.post(
        f"/api/v1/deliveries/{delivery['delivery_id']}/validate",
        headers=headers,
        json={"expected_version": delivery["version"], "actor_role": "staff"},
    )
    assert validated.status_code == 200, validated.text
    assert validated.json()["delivery"]["status"] == STATUS_READY


def test_apps_script_client_delivery_action_allowlists_before_post(monkeypatch: pytest.MonkeyPatch) -> None:
    """delivery_action must not forward secrets in the business body passed to _post."""
    from app.core.config import Settings
    from app.services.apps_script import AppsScriptClient
    import asyncio

    settings = Settings(
        APPS_SCRIPT_WEBAPP_URL="https://example.invalid/exec",
        APPS_SCRIPT_WEBHOOK_SECRET="transport-only-secret",
    )
    client = AppsScriptClient(settings)
    captured: dict = {}

    async def fake_post(action, body):
        captured["action"] = action
        captured["body"] = dict(body)
        return {"status": "Success", "action": action, "data": {"delivery": {"delivery_id": "DLV-X"}}}

    monkeypatch.setattr(client, "_post", fake_post)
    result = asyncio.run(
        client.delivery_action(
            "record_delivery_outcome",
            {
                "delivery_id": "DLV-X",
                "status": "Ready",
                "checksum": "abc",
                "actor_role": "Manager",
                "staff_id": "STAFF-MGR001",
                "webhook_secret": "leak",
                "smtp_password": "leak",
                "pdf_bytes": b"%PDF",
                "email_body": "hi",
            },
        )
    )
    assert result["status"] == "Success"
    body = captured["body"]
    assert body["delivery_id"] == "DLV-X"
    assert body["actor_role"] == "manager"
    assert "webhook_secret" not in body
    assert "smtp_password" not in body
    assert "pdf_bytes" not in body
    assert "email_body" not in body


def test_delivery_lifecycle_requires_confirm_and_never_autosends(client: TestClient) -> None:
    headers = _manager_headers(client)
    opts = client.get("/api/v1/deliveries/options", headers=headers)
    assert opts.status_code == 200, opts.text
    assert opts.json()["auto_send"] is False
    assert opts.json()["email_enabled"] is False

    created = client.post(
        "/api/v1/deliveries",
        headers=headers,
        json={
            "document_type": PROFILE_INTERNAL_JOB_SHEET,
            "recipient_email": "ops@nativegrace.com",
            "job_sheet_id": "21759f5d",
            "delivery_method": "download_only",
        },
    )
    assert created.status_code == 200, created.text
    delivery = created.json()["delivery"]
    assert delivery["status"] == "Draft"
    assert created.json()["email_preview"]["subject"]

    # Seed a job completion so job PDF payload exists for validate/render.
    from tests.test_job_reports import seed_finalised_job

    seed_finalised_job(job_sheet_id="21759f5d", completion_id="CMP-288481F1")

    no_confirm = client.post(
        f"/api/v1/deliveries/{delivery['delivery_id']}/send",
        headers=headers,
        json={"expected_version": delivery["version"], "confirm_send": False},
    )
    assert no_confirm.status_code == 422
    assert "confirm_send" in no_confirm.json()["detail"].lower()

    validated = client.post(
        f"/api/v1/deliveries/{delivery['delivery_id']}/validate",
        headers=headers,
        json={"expected_version": delivery["version"]},
    )
    assert validated.status_code == 200, validated.text
    delivery = validated.json()["delivery"]
    assert delivery["status"] == STATUS_READY
    assert delivery["idempotency_key"]
    assert delivery["checksum"]

    sent = client.post(
        f"/api/v1/deliveries/{delivery['delivery_id']}/send",
        headers=headers,
        json={"expected_version": delivery["version"], "confirm_send": True},
    )
    assert sent.status_code == 200, sent.text
    delivery = sent.json()["delivery"]
    assert delivery["status"] == STATUS_SENT
    assert sent.json()["sent"] is True

    # Duplicate identical draft blocked at validate when another Sent shares key.
    dup = client.post(
        "/api/v1/deliveries",
        headers=headers,
        json={
            "document_type": PROFILE_INTERNAL_JOB_SHEET,
            "recipient_email": "ops@nativegrace.com",
            "job_sheet_id": "21759f5d",
            "delivery_method": "download_only",
        },
    )
    assert dup.status_code == 200
    dup_id = dup.json()["delivery"]["delivery_id"]
    dup_v = dup.json()["delivery"]["version"]
    blocked = client.post(
        f"/api/v1/deliveries/{dup_id}/validate",
        headers=headers,
        json={"expected_version": dup_v},
    )
    assert blocked.status_code == 409


def test_email_send_fails_closed_in_mock_then_retry(client: TestClient) -> None:
    from tests.test_job_reports import seed_finalised_job

    seed_finalised_job(job_sheet_id="21759f5d", completion_id="CMP-288481F1")
    headers = _manager_headers(client)
    created = client.post(
        "/api/v1/deliveries",
        headers=headers,
        json={
            "document_type": PROFILE_INTERNAL_JOB_SHEET,
            "recipient_email": "ops@nativegrace.com",
            "job_sheet_id": "21759f5d",
            "delivery_method": "email",
        },
    )
    delivery = created.json()["delivery"]
    validated = client.post(
        f"/api/v1/deliveries/{delivery['delivery_id']}/validate",
        headers=headers,
        json={"expected_version": delivery["version"]},
    )
    delivery = validated.json()["delivery"]
    sent = client.post(
        f"/api/v1/deliveries/{delivery['delivery_id']}/send",
        headers=headers,
        json={"expected_version": delivery["version"], "confirm_send": True},
    )
    assert sent.status_code == 200, sent.text
    assert sent.json()["delivery"]["status"] == STATUS_FAILED
    assert "mock" in sent.json()["delivery"]["failure_reason"].lower() or "disabled" in sent.json()[
        "delivery"
    ]["failure_reason"].lower()

    retried = client.post(
        f"/api/v1/deliveries/{delivery['delivery_id']}/retry",
        headers=headers,
        json={
            "expected_version": sent.json()["delivery"]["version"],
            "confirm_send": True,
        },
    )
    assert retried.status_code == 200
    assert retried.json()["delivery"]["status"] == STATUS_FAILED


def test_supersede_creates_replacement_draft(client: TestClient) -> None:
    from tests.test_job_reports import seed_finalised_job

    seed_finalised_job(job_sheet_id="21759f5d", completion_id="CMP-288481F1")
    headers = _manager_headers(client)
    created = client.post(
        "/api/v1/deliveries",
        headers=headers,
        json={
            "document_type": PROFILE_INTERNAL_JOB_SHEET,
            "recipient_email": "ops@nativegrace.com",
            "job_sheet_id": "21759f5d",
            "delivery_method": "download_only",
        },
    )
    delivery = created.json()["delivery"]
    validated = client.post(
        f"/api/v1/deliveries/{delivery['delivery_id']}/validate",
        headers=headers,
        json={"expected_version": delivery["version"]},
    ).json()["delivery"]
    sent = client.post(
        f"/api/v1/deliveries/{validated['delivery_id']}/send",
        headers=headers,
        json={"expected_version": validated["version"], "confirm_send": True},
    ).json()["delivery"]
    assert sent["status"] == STATUS_SENT

    superseded = client.post(
        f"/api/v1/deliveries/{sent['delivery_id']}/supersede",
        headers=headers,
        json={"expected_version": sent["version"]},
    )
    assert superseded.status_code == 200, superseded.text
    assert superseded.json()["delivery"]["status"] == "Superseded"
    assert superseded.json()["replacement"]["status"] == "Draft"
    assert superseded.json()["replacement"]["supersedes_delivery_id"] == sent["delivery_id"]


def test_attachment_upload_and_client_visibility(client: TestClient) -> None:
    headers = _manager_headers(client)
    bad = client.post(
        "/api/v1/attachments",
        headers=headers,
        json={
            "job_sheet_id": "21759f5d",
            "file_name": "run.exe",
            "mime_type": "application/x-msdownload",
            "byte_size": 2048,
            "attachment_type": "other",
        },
    )
    assert bad.status_code == 422

    ok = client.post(
        "/api/v1/attachments",
        headers=headers,
        json={
            "job_sheet_id": "21759f5d",
            "file_name": "site-photo.jpg",
            "mime_type": "image/jpeg",
            "byte_size": 4096,
            "attachment_type": "photo",
            "caption": "Gate access",
        },
    )
    assert ok.status_code == 200, ok.text
    att = ok.json()["attachment"]
    assert att["client_visible"] is False
    assert "drive_file_id" not in att
    assert "public" not in str(att).lower()

    visible = client.post(
        f"/api/v1/attachments/{att['attachment_id']}/client-visible",
        headers=headers,
        json={"client_visible": True},
    )
    assert visible.status_code == 200
    assert visible.json()["attachment"]["client_visible"] is True

    listing = client.get("/api/v1/jobs/21759f5d/attachments", headers=headers)
    assert listing.status_code == 200
    assert any(row["attachment_id"] == att["attachment_id"] for row in listing.json()["items"])


# --- Phase 3G.1 apps_script orchestration (FakeRepo, no live Apps Script) ---


def _minimal_job_pdf_envelope() -> dict:
    job = {
        "job": {
            "job_sheet_id": "21759f5d",
            "customer_name": "Acme",
            "project_name": "Garden",
            "date": "2026-07-16",
        },
        "completion": {
            "completion_id": "CMP-288481F1",
            "work_summary": "Planted trees",
            "completion_status": "Finalised",
        },
        "labour_entries": [],
        "machinery_entries": [],
        "material_entries": [],
        "totals": {"labour_hours": 7.5, "travel_hours": 0.5},
    }
    return {
        "status": "Success",
        "data": {
            "snapshot": {
                "report_type": "Job Sheet Summary",
                "template_version": "3G.1",
                "jobs": [job],
                "job": job["job"],
                "completion": job["completion"],
                "totals": job["totals"],
                "record_count": 1,
            }
        },
    }


class _FakeAppsScriptDeliveryRepo:
    """In-memory stand-in for AppsScriptRepository delivery + PDF snapshot calls."""

    def __init__(self) -> None:
        self.deliveries: dict[str, dict] = {}
        self.calls: list[tuple[str, dict]] = []
        self._seq = 0

    def _next_id(self) -> str:
        self._seq += 1
        return f"DLV-FAKE{self._seq:04d}"

    async def aget_job_pdf_data(self, job_sheet_id, staff_id, actor_role, *, actor_identity=""):
        return _minimal_job_pdf_envelope()

    async def areport_action(self, action, body):
        return _minimal_job_pdf_envelope()

    async def adelivery_action(self, action: str, body: dict) -> dict:
        self.calls.append((action, dict(body)))
        for forbidden in (
            "pdf_bytes",
            "pdf_base64",
            "content_base64",
            "Authorization",
            "token",
            "webhook_secret",
            "drive_url",
            "public_url",
            "email_body",
            "body",
        ):
            assert forbidden not in body or body.get(forbidden) in (None, ""), (
                f"Apps Script payload must not include {forbidden}"
            )

        if action == "get_delivery":
            row = self.deliveries.get(str(body.get("delivery_id") or ""))
            if not row:
                from fastapi import HTTPException

                raise HTTPException(status_code=404, detail="Delivery not found.")
            return {"delivery": dict(row)}

        if action == "list_deliveries":
            return {"items": [dict(r) for r in self.deliveries.values()]}

        if action == "create_delivery_draft":
            delivery_id = self._next_id()
            row = {
                "delivery_id": delivery_id,
                "report_batch_id": str(body.get("report_batch_id") or ""),
                "job_sheet_id": str(body.get("job_sheet_id") or ""),
                "completion_id": str(body.get("completion_id") or ""),
                "document_type": str(body.get("document_type") or PROFILE_CLIENT_JOB_SUMMARY),
                "recipient_type": str(body.get("recipient_type") or "client"),
                "recipient_email": str(body.get("recipient_email") or ""),
                "delivery_method": str(body.get("delivery_method") or "email"),
                "status": "Draft",
                "sent_by": "",
                "sent_at": None,
                "failed_at": None,
                "failure_reason": "",
                "checksum": "",
                "template_version": "3G.1",
                "supersedes_delivery_id": str(body.get("supersedes_delivery_id") or ""),
                "idempotency_key": "",
                "drive_file_id": "",
                "attachment_ids": list(body.get("attachment_ids") or []),
                "subject": "preview subject",
                "body_preview": "preview body",
                "version": 1,
                "created_by": str(body.get("staff_id") or ""),
                "created_at": "2026-07-26T09:00:00Z",
            }
            self.deliveries[delivery_id] = row
            return {"delivery": dict(row), "email_preview": {"to": row["recipient_email"], "subject": row["subject"], "body": row["body_preview"]}}

        if action == "record_delivery_outcome":
            row = self.deliveries.get(str(body.get("delivery_id") or ""))
            if not row:
                from fastapi import HTTPException

                raise HTTPException(status_code=404, detail="Delivery not found.")
            expected = body.get("expected_version")
            if expected not in (None, "") and int(row.get("version") or 0) != int(expected):
                from fastapi import HTTPException

                raise HTTPException(status_code=409, detail="Conflict: delivery version changed.")
            if (
                str(row.get("status")) == STATUS_SENT
                and str(body.get("status")) == STATUS_SENT
                and str(body.get("idempotency_key") or "") == str(row.get("idempotency_key") or "")
                and row.get("idempotency_key")
            ):
                if body.get("checksum") and body.get("checksum") != row.get("checksum"):
                    from fastapi import HTTPException

                    raise HTTPException(
                        status_code=409,
                        detail="Conflict: idempotency key reused with a different checksum payload.",
                    )
                return {"delivery": dict(row), "idempotent": True}
            patch = {
                "status": str(body.get("status") or row["status"]),
                "checksum": str(body.get("checksum") or row.get("checksum") or ""),
                "idempotency_key": str(body.get("idempotency_key") or row.get("idempotency_key") or ""),
                "template_version": str(body.get("template_version") or row.get("template_version") or "3G.1"),
                "version": int(row.get("version") or 1) + 1,
            }
            if body.get("clear_failure") or patch["status"] == STATUS_SENT:
                patch["failure_reason"] = ""
                patch["failed_at"] = None
            elif "failure_reason" in body:
                patch["failure_reason"] = str(body.get("failure_reason") or "")
            if body.get("sent_by"):
                patch["sent_by"] = body["sent_by"]
            if body.get("sent_at"):
                patch["sent_at"] = body["sent_at"]
            if body.get("failed_at"):
                patch["failed_at"] = body["failed_at"]
            if body.get("drive_file_id"):
                patch["drive_file_id"] = body["drive_file_id"]
            row.update(patch)
            return {"delivery": dict(row)}

        if action == "update_delivery_draft":
            row = self.deliveries.get(str(body.get("delivery_id") or ""))
            if not row:
                from fastapi import HTTPException

                raise HTTPException(status_code=404, detail="Delivery not found.")
            row["version"] = int(row.get("version") or 1) + 1
            if body.get("recipient_email") is not None:
                row["recipient_email"] = body["recipient_email"]
            return {"delivery": dict(row)}

        return {}


@pytest.mark.asyncio
async def test_apps_script_orchestrator_download_only_lifecycle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATA_MODE", "apps_script")
    monkeypatch.setenv("FIELDOS_ENV", "production")
    monkeypatch.setenv("DOCUMENT_EMAIL_ENABLED", "false")
    monkeypatch.setenv("DOCUMENT_DRIVE_FILING_ENABLED", "false")
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "recordings"))
    _clear_settings()
    from app.core.config import get_settings
    from app.services.delivery_orchestrator import DeliveryOrchestrator

    settings = get_settings()
    repo = _FakeAppsScriptDeliveryRepo()
    orch = DeliveryOrchestrator(settings, repo)

    created = await repo.adelivery_action(
        "create_delivery_draft",
        {
            "staff_id": "STAFF-MGR001",
            "actor_role": "manager",
            "document_type": PROFILE_INTERNAL_JOB_SHEET,
            "recipient_email": "ops@nativegrace.com",
            "job_sheet_id": "21759f5d",
            "delivery_method": "download_only",
        },
    )
    delivery_id = created["delivery"]["delivery_id"]

    with pytest.raises(Exception) as no_confirm:
        await orch.execute(
            "send_delivery",
            {
                "delivery_id": delivery_id,
                "staff_id": "STAFF-MGR001",
                "actor_role": "manager",
                "confirm_send": False,
                "expected_version": 1,
            },
        )
    assert no_confirm.value.status_code == 422
    assert "confirm_send" in str(no_confirm.value.detail).lower()

    validated = await orch.execute(
        "validate_delivery",
        {
            "delivery_id": delivery_id,
            "staff_id": "STAFF-MGR001",
            "actor_role": "manager",
            "expected_version": 1,
        },
    )
    assert validated["delivery"]["status"] == STATUS_READY
    assert validated["delivery"]["checksum"]
    assert validated["delivery"]["idempotency_key"]
    assert len(validated["delivery"]["checksum"]) == 64

    sent = await orch.execute(
        "send_delivery",
        {
            "delivery_id": delivery_id,
            "staff_id": "STAFF-MGR001",
            "actor_role": "manager",
            "confirm_send": True,
            "expected_version": validated["delivery"]["version"],
        },
    )
    assert sent["sent"] is True
    assert sent["delivery"]["status"] == STATUS_SENT

    again = await orch.execute(
        "send_delivery",
        {
            "delivery_id": delivery_id,
            "staff_id": "STAFF-MGR001",
            "actor_role": "manager",
            "confirm_send": True,
            "expected_version": sent["delivery"]["version"],
        },
    )
    assert again.get("idempotent") is True
    assert again["delivery"]["status"] == STATUS_SENT

    record_calls = [c for c in repo.calls if c[0] == "record_delivery_outcome"]
    assert record_calls
    for _, payload in record_calls:
        assert "pdf_bytes" not in payload
        assert "pdf_base64" not in payload


@pytest.mark.asyncio
async def test_apps_script_orchestrator_provider_disabled_fail_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATA_MODE", "apps_script")
    monkeypatch.setenv("FIELDOS_ENV", "production")
    monkeypatch.setenv("DOCUMENT_EMAIL_ENABLED", "false")
    monkeypatch.setenv("DOCUMENT_DRIVE_FILING_ENABLED", "false")
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "recordings"))
    _clear_settings()
    from app.core.config import get_settings
    from app.services.delivery_orchestrator import DeliveryOrchestrator
    from fastapi import HTTPException

    settings = get_settings()
    repo = _FakeAppsScriptDeliveryRepo()
    orch = DeliveryOrchestrator(settings, repo)
    created = await repo.adelivery_action(
        "create_delivery_draft",
        {
            "staff_id": "STAFF-MGR001",
            "actor_role": "manager",
            "document_type": PROFILE_CLIENT_JOB_SUMMARY,
            "recipient_email": "client@example.com",
            "job_sheet_id": "21759f5d",
            "delivery_method": "email",
        },
    )
    delivery_id = created["delivery"]["delivery_id"]
    validated = await orch.execute(
        "validate_delivery",
        {
            "delivery_id": delivery_id,
            "staff_id": "STAFF-MGR001",
            "actor_role": "manager",
            "expected_version": 1,
        },
    )
    # Client profile must not leak forbidden fields into rendered checksum path.
    assert validated["delivery"]["checksum"]

    sent = await orch.execute(
        "send_delivery",
        {
            "delivery_id": delivery_id,
            "staff_id": "STAFF-MGR001",
            "actor_role": "manager",
            "confirm_send": True,
            "expected_version": validated["delivery"]["version"],
        },
    )
    assert sent["sent"] is False
    assert sent["delivery"]["status"] == STATUS_FAILED
    assert "DOCUMENT_EMAIL_ENABLED" in sent["delivery"]["failure_reason"] or "disabled" in sent[
        "delivery"
    ]["failure_reason"].lower()

    with pytest.raises(HTTPException) as staff_exc:
        await orch.execute(
            "send_delivery",
            {
                "delivery_id": delivery_id,
                "staff_id": "STAFF-DEMO001",
                "actor_role": "staff",
                "confirm_send": True,
            },
        )
    assert staff_exc.value.status_code == 403


@pytest.mark.asyncio
async def test_apps_script_orchestrator_idempotency_conflict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATA_MODE", "apps_script")
    monkeypatch.setenv("FIELDOS_ENV", "production")
    monkeypatch.setenv("DOCUMENT_EMAIL_ENABLED", "false")
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "recordings"))
    _clear_settings()
    from app.core.config import get_settings
    from app.services.delivery_orchestrator import DeliveryOrchestrator
    from fastapi import HTTPException

    settings = get_settings()
    repo = _FakeAppsScriptDeliveryRepo()
    orch = DeliveryOrchestrator(settings, repo)

    first = await repo.adelivery_action(
        "create_delivery_draft",
        {
            "staff_id": "STAFF-MGR001",
            "actor_role": "manager",
            "document_type": PROFILE_INTERNAL_JOB_SHEET,
            "recipient_email": "ops@nativegrace.com",
            "job_sheet_id": "21759f5d",
            "delivery_method": "download_only",
        },
    )
    v1 = await orch.execute(
        "validate_delivery",
        {
            "delivery_id": first["delivery"]["delivery_id"],
            "staff_id": "STAFF-MGR001",
            "actor_role": "manager",
            "expected_version": 1,
        },
    )
    await orch.execute(
        "send_delivery",
        {
            "delivery_id": first["delivery"]["delivery_id"],
            "staff_id": "STAFF-MGR001",
            "actor_role": "manager",
            "confirm_send": True,
            "expected_version": v1["delivery"]["version"],
        },
    )

    second = await repo.adelivery_action(
        "create_delivery_draft",
        {
            "staff_id": "STAFF-MGR001",
            "actor_role": "manager",
            "document_type": PROFILE_INTERNAL_JOB_SHEET,
            "recipient_email": "ops@nativegrace.com",
            "job_sheet_id": "21759f5d",
            "delivery_method": "download_only",
        },
    )
    with pytest.raises(HTTPException) as conflict:
        await orch.execute(
            "validate_delivery",
            {
                "delivery_id": second["delivery"]["delivery_id"],
                "staff_id": "STAFF-MGR001",
                "actor_role": "manager",
                "expected_version": 1,
            },
        )
    assert conflict.value.status_code == 409


def test_attachment_storage_and_job_service_strips_bytes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "recordings"))
    monkeypatch.setenv("DATA_MODE", "mock")
    monkeypatch.setenv("MOCK_DATA_DIR", str(tmp_path / "mock"))
    monkeypatch.setenv("FIELDOS_ENV", "development")
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    _clear_settings()
    from app.core.config import get_settings
    from app.services.attachment_storage import store_attachment_bytes
    from app.services.jobs import JobService
    from app.services.mock_repository import MockJobRepository
    import asyncio
    import base64

    settings = get_settings()
    raw = b"%PDF-1.4 attachment-bytes-padded-for-min-size-check!!"

    stored = store_attachment_bytes(
        settings,
        job_sheet_id="21759f5d",
        file_name="site.pdf",
        raw=raw,
    )
    assert stored["storage_ref"].startswith("local://attachments/")
    assert stored["checksum"]
    assert Path(stored["path"]).read_bytes() == raw

    class _CaptureRepo(MockJobRepository):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.last_upload = None

        async def aattachment_action(self, action, body):
            if action == "upload_attachment":
                self.last_upload = dict(body)
            return await super().aattachment_action(action, body)

    service = JobService(settings)
    cap = _CaptureRepo(settings)
    service.repo = cap

    result = asyncio.run(
        service.attachment_action(
            "upload_attachment",
            staff_id="STAFF-MGR001",
            actor_role="manager",
            actor_identity="STAFF-MGR001",
            body={
                "job_sheet_id": "21759f5d",
                "file_name": "site-photo.jpg",
                "mime_type": "image/jpeg",
                "byte_size": len(raw),
                "attachment_type": "photo",
                "content_base64": base64.b64encode(raw).decode("ascii"),
                "public_url": "https://evil.example/public",
            },
        )
    )
    assert result["attachment"]["attachment_id"]
    assert "content_base64" not in (cap.last_upload or {})
    assert "public_url" not in (cap.last_upload or {})
    assert (cap.last_upload or {}).get("storage_ref", "").startswith("local://")
