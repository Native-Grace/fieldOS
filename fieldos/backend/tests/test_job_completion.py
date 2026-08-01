"""Phase 3C job completion API tests (mock mode)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def _clear_settings():
    from app.core.config import get_settings

    get_settings.cache_clear()


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("DATA_MODE", "mock")
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
    return {"Authorization": f"Bearer {_login(client, 'manager@nativegrace.com', 'FieldOS-Manager-2026!')}"}


def _staff_headers(client: TestClient) -> dict[str, str]:
    return {"Authorization": f"Bearer {_login(client, 'alex@nativegrace.com', 'FieldOS-Demo-2026!')}"}


def _approve_demo_job(client: TestClient) -> str:
    headers = _manager_headers(client)
    job_id = "JS-DEMO001"
    # Enrich approved job content for draft extraction.
    from app.core.config import get_settings
    from app.services.mock_store import MockStore

    store = MockStore(get_settings())
    store.update_job_status(
        job_id,
        {
            "processing_status": "Completed",
            "approval_status": "Approved",
            "ai_summary": "Supply and planting of seven trees with earthworks to reshape the driveway.",
            "ai_transcript": "Planted seven trees. Had lunch. Actually no lunch today.",
            "manager_review_items": "Incomplete fragment about lunch.",
            "variations": "Driveway reshape",
            "staff_id": "STAFF-DEMO001",
        },
    )
    return job_id


def test_staff_cannot_generate_completion(client: TestClient) -> None:
    job_id = _approve_demo_job(client)
    response = client.post(
        f"/api/v1/jobs/{job_id}/completion/generate",
        headers=_staff_headers(client),
        json={},
    )
    assert response.status_code == 403


def test_manager_generate_save_finalise_reopen(client: TestClient) -> None:
    job_id = _approve_demo_job(client)
    headers = _manager_headers(client)

    generated = client.post(
        f"/api/v1/jobs/{job_id}/completion/generate",
        headers=headers,
        json={},
    )
    assert generated.status_code == 200, generated.text
    body = generated.json()
    assert body["completion"]["completion_status"] == "Draft"
    assert body["labour_entries"]
    assert any(m["quantity"] == 7 for m in body["material_entries"])
    # Client totals ignored — server recomputes.
    version = body["completion"]["version"]

    labour = body["labour_entries"]
    labour[0].update(
        {
            "start_time": "07:00",
            "finish_time": "15:00",
            "break_minutes": 30,
            "confirmation_status": "Confirmed",
            "billable": True,
            "travel_minutes": 20,
        }
    )
    machinery = body["machinery_entries"]
    for row in machinery:
        row.update({"duration_hours": 1.5, "confirmation_status": "Confirmed"})
    materials = body["material_entries"]
    for row in materials:
        row.update({"confirmation_status": "Confirmed"})

    patched = client.patch(
        f"/api/v1/jobs/{job_id}/completion",
        headers=headers,
        json={
            "expected_version": version,
            "work_summary": body["completion"]["work_summary"],
            "invoice_description": body["completion"]["invoice_description"],
            "labour_entries": labour,
            "machinery_entries": machinery,
            "material_entries": materials,
            "warnings": [],
            "total_labour_hours": 999,
        },
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["completion"]["total_labour_hours"] == 7.5
    assert patched.json()["completion"]["total_travel_hours"] == round(20 / 60, 2)
    version = patched.json()["completion"]["version"]

    stale = client.patch(
        f"/api/v1/jobs/{job_id}/completion",
        headers=headers,
        json={"expected_version": 1, "work_summary": "stale"},
    )
    assert stale.status_code == 409

    blocked = client.post(
        f"/api/v1/jobs/{job_id}/completion/finalise",
        headers=headers,
        json={"expected_version": version},
    )
    # May still need override for contradictory lunch warning depending on draft warnings retained.
    if blocked.status_code == 422:
        finalised = client.post(
            f"/api/v1/jobs/{job_id}/completion/finalise",
            headers=headers,
            json={"expected_version": version, "override_reason": "Reviewed lunch notes."},
        )
    else:
        finalised = blocked
    assert finalised.status_code == 200, finalised.text
    assert finalised.json()["completion"]["completion_status"] == "Finalised"
    version = finalised.json()["completion"]["version"]

    reopened = client.post(
        f"/api/v1/jobs/{job_id}/completion/reopen",
        headers=headers,
        json={"expected_version": version, "reopen_reason": "Adjust travel"},
    )
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["completion"]["completion_status"] == "Reopened"


def test_finalise_blocked_when_job_not_approved(client: TestClient) -> None:
    job_id = _approve_demo_job(client)
    headers = _manager_headers(client)
    generated = client.post(
        f"/api/v1/jobs/{job_id}/completion/generate",
        headers=headers,
        json={},
    ).json()
    from app.core.config import get_settings
    from app.services.mock_store import MockStore

    MockStore(get_settings()).update_job_status(job_id, {"approval_status": "Pending Review"})
    response = client.post(
        f"/api/v1/jobs/{job_id}/completion/finalise",
        headers=headers,
        json={"expected_version": generated["completion"]["version"]},
    )
    assert response.status_code == 422


def test_job_detail_is_independent_of_completion(client: TestClient) -> None:
    """Opening the job (GET /jobs/{id}) must not require or return completion data."""
    job_id = _approve_demo_job(client)
    headers = _manager_headers(client)

    detail = client.get(f"/api/v1/jobs/{job_id}", headers=headers)
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert "completion" not in body
    assert body["job"]["job_sheet_id"] == job_id

    # Completion lives behind its own endpoint and returns gracefully with no draft.
    completion = client.get(f"/api/v1/jobs/{job_id}/completion", headers=headers)
    assert completion.status_code == 200, completion.text
    assert completion.json()["completion"] is None


def test_completion_endpoint_returns_when_no_tables(client: TestClient) -> None:
    """Missing completion data must not error — returns an empty, fast response."""
    job_id = _approve_demo_job(client)
    response = client.get(f"/api/v1/jobs/{job_id}/completion", headers=_manager_headers(client))
    assert response.status_code == 200
    data = response.json()
    assert data["completion"] is None
    assert data["labour_entries"] == []
    assert data["can_generate"] is True


def test_staff_read_filters_labour(client: TestClient) -> None:
    job_id = _approve_demo_job(client)
    headers = _manager_headers(client)
    generated = client.post(
        f"/api/v1/jobs/{job_id}/completion/generate",
        headers=headers,
        json={},
    ).json()
    # Add another labour row for a different staff id.
    labour = generated["labour_entries"]
    labour.append(
        {
            "staff_id": "STAFF-OTHER",
            "staff_name": "Other",
            "work_date": "2026-07-22",
            "start_time": "08:00",
            "finish_time": "10:00",
            "break_minutes": 0,
            "travel_minutes": 0,
            "billable": False,
            "confirmation_status": "Confirmed",
        }
    )
    labour[0].update(
        {
            "start_time": "07:00",
            "finish_time": "15:00",
            "break_minutes": 0,
            "confirmation_status": "Confirmed",
        }
    )
    client.patch(
        f"/api/v1/jobs/{job_id}/completion",
        headers=headers,
        json={
            "expected_version": generated["completion"]["version"],
            "work_summary": "ok",
            "invoice_description": "ok",
            "labour_entries": labour,
            "machinery_entries": [],
            "material_entries": [],
            "warnings": [],
        },
    )
    staff_view = client.get(
        f"/api/v1/jobs/{job_id}/completion",
        headers=_staff_headers(client),
    )
    assert staff_view.status_code == 200, staff_view.text
    data = staff_view.json()
    assert all(row["staff_id"] == "STAFF-DEMO001" for row in data["labour_entries"])
    assert data["machinery_entries"] == []
    assert data["material_entries"] == []
    assert data["completion"]["internal_notes"] == ""
    assert data["can_edit"] is False


def test_blank_and_malformed_labour_errors_are_unique() -> None:
    from app.services.completion_math import compute_labour_entry, unique_messages, validate_for_finalise

    blank = compute_labour_entry({"start_time": "", "finish_time": "", "break_minutes": 0})
    assert blank["errors"] == ["Start time is required.", "Finish time is required."]
    assert blank["warnings"] == []

    malformed = compute_labour_entry({"start_time": "25:99", "finish_time": "noon", "break_minutes": 0})
    assert malformed["errors"] == [
        "Start time must use HH:MM.",
        "Finish time must use HH:MM.",
    ]
    assert not any("required" in e.lower() for e in malformed["errors"])

    job = {
        "approval_status": "Approved",
        "processing_status": "Completed",
    }
    gate = validate_for_finalise(
        {
            "completion_status": "Draft",
            "work_summary": "Work",
            "invoice_description": "Invoice",
            "warnings": [],
            "warning_resolutions": [],
            "labour_entries": [
                {
                    "start_time": "",
                    "finish_time": "",
                    "break_minutes": 0,
                    "confirmation_status": "Confirmed",
                }
            ],
            "machinery_entries": [],
            "material_entries": [],
        },
        job,
    )
    assert gate["ok"] is False
    assert len(gate["critical_errors"]) == len(unique_messages(gate["critical_errors"]))
    assert sum("Start time is required" in e for e in gate["critical_errors"]) == 1
    assert sum("Finish time is required" in e for e in gate["critical_errors"]) == 1
    assert not any("start_time and finish_time are required" in e for e in gate["critical_errors"])


def test_resolved_lunch_allows_finalise_unresolved_blocks() -> None:
    from app.services.completion_math import validate_for_finalise

    lunch = "Contradictory lunch information in source text — confirm unpaid break manually."
    job = {"approval_status": "Approved", "processing_status": "Completed"}
    base = {
        "completion_status": "Draft",
        "work_summary": "Planted trees",
        "invoice_description": "Seven trees",
        "warnings": [lunch],
        "labour_entries": [
            {
                "start_time": "07:00",
                "finish_time": "15:00",
                "break_minutes": 30,
                "confirmation_status": "Confirmed",
            }
        ],
        "machinery_entries": [],
        "material_entries": [],
    }
    blocked = validate_for_finalise({**base, "warning_resolutions": []}, job, override_reason="ignore")
    assert blocked["ok"] is False
    assert any("Resolve lunch/break contradiction" in e for e in blocked["critical_errors"])

    allowed = validate_for_finalise(
        {
            **base,
            "warning_resolutions": [
                {
                    "warning_key": "contradictory_lunch",
                    "warning_text": lunch,
                    "resolved": True,
                    "break_minutes": 30,
                    "resolution_note": "Confirmed unpaid break",
                }
            ],
        },
        job,
        override_reason="",
    )
    assert allowed["ok"] is True, allowed["critical_errors"]
    assert allowed["totals"]["total_labour_hours"] == 7.5


def test_invalid_arithmetic_cannot_be_overridden() -> None:
    from app.services.completion_math import validate_for_finalise

    gate = validate_for_finalise(
        {
            "completion_status": "Draft",
            "work_summary": "Planted trees",
            "invoice_description": "Seven trees",
            "warnings": [],
            "warning_resolutions": [],
            "labour_entries": [
                {
                    "start_time": "08:00",
                    "finish_time": "09:00",
                    "break_minutes": 90,
                    "confirmation_status": "Confirmed",
                }
            ],
            "machinery_entries": [],
            "material_entries": [],
        },
        {"approval_status": "Approved", "processing_status": "Completed"},
        override_reason="Please allow this",
    )
    assert gate["ok"] is False
    assert any("Break minutes cannot exceed" in e for e in gate["critical_errors"])


def test_clock_normaliser_formats_and_rejects_free_text() -> None:
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo

    from app.services.completion_math import describe_clock_time, normalise_clock_time

    assert normalise_clock_time("07:00") == "07:00"
    assert normalise_clock_time("7:00") == "07:00"
    assert normalise_clock_time(7 / 24) == "07:00"
    assert normalise_clock_time("7") is None
    assert normalise_clock_time("morning") is None
    assert normalise_clock_time("7ish") is None
    assert normalise_clock_time("7am to 5pm") is None

    sydney = ZoneInfo("Australia/Sydney")
    local_seven = datetime(2026, 7, 26, 7, 0, tzinfo=sydney)
    assert normalise_clock_time(local_seven) == "07:00"
    assert normalise_clock_time(local_seven.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")) == "07:00"
    assert normalise_clock_time("1899-12-30T07:00:00+10:00") == "07:00"

    diag = describe_clock_time(local_seven)
    assert diag["type"] == "datetime"
    assert diag["normalised"] == "07:00"
    assert diag["ok"] is True


def test_finalise_accepts_iso_times_from_sheets_coercion() -> None:
    from app.services.completion_math import validate_for_finalise

    gate = validate_for_finalise(
        {
            "completion_status": "Draft",
            "work_summary": "Planted trees",
            "invoice_description": "Seven trees",
            "warnings": [],
            "warning_resolutions": [],
            "labour_entries": [
                {
                    "start_time": "1899-12-30T07:00:00+10:00",
                    "finish_time": "1899-12-30T15:00:00+10:00",
                    "break_minutes": 30,
                    "confirmation_status": "Confirmed",
                }
            ],
            "machinery_entries": [],
            "material_entries": [],
        },
        {"approval_status": "Approved", "processing_status": "Completed"},
    )
    assert gate["ok"] is True, gate["critical_errors"]
    assert gate["totals"]["total_labour_hours"] == 7.5


@pytest.mark.asyncio
async def test_generate_transport_bounce_reconciles_via_get(monkeypatch) -> None:
    """After ContentService bounce, load draft via get — never re-POST generate."""
    from app.services.apps_script import AppsScriptError
    from app.services.apps_script_repository import AppsScriptJobRepository
    from app.core.config import Settings

    settings = Settings(
        _env_file=None,
        DATA_MODE="apps_script",
        JWT_SECRET="test-secret-xxxxxxxxxxxxxxxx",
        APPS_SCRIPT_WEBAPP_URL="https://script.google.com/macros/s/fake/exec",
        APPS_SCRIPT_WEBHOOK_SECRET="secret",
    )
    repo = AppsScriptJobRepository(settings)

    class FakeAS:
        def __init__(self) -> None:
            self.generate_calls = 0
            self.get_calls = 0

        async def generate_job_completion_draft(self, body):
            self.generate_calls += 1
            raise AppsScriptError(
                "Apps Script redirect host rejected (script.google.com).",
                http_status=502,
                code="apps_script_redirect_host_rejected",
            )

        async def get_job_completion(self, body):
            self.get_calls += 1
            return {
                "status": "Success",
                "data": {
                    "completion": {
                        "completion_id": "CMP-RECON",
                        "job_sheet_id": body["job_sheet_id"],
                        "completion_status": "Draft",
                        "version": 1,
                    },
                    "labour_entries": [{"labour_id": "L1"}],
                    "machinery_entries": [],
                    "material_entries": [],
                    "can_edit": True,
                    "can_finalise": True,
                    "can_reopen": False,
                    "can_generate": True,
                },
            }

    fake = FakeAS()
    repo.apps_script = fake
    out = await repo.acompletion_action(
        "generate_job_completion_draft",
        {
            "job_sheet_id": "JS-C405837D",
            "staff_id": "STAFF-MGR001",
            "actor_staff_id": "STAFF-MGR001",
            "actor_role": "manager",
        },
    )
    assert out["completion"]["completion_id"] == "CMP-RECON"
    assert fake.generate_calls == 1
    assert fake.get_calls == 1


@pytest.mark.asyncio
async def test_generate_transport_bounce_missing_draft_stays_error(monkeypatch) -> None:
    from fastapi import HTTPException

    from app.services.apps_script import AppsScriptError
    from app.services.apps_script_repository import AppsScriptJobRepository
    from app.core.config import Settings

    settings = Settings(
        _env_file=None,
        DATA_MODE="apps_script",
        JWT_SECRET="test-secret-xxxxxxxxxxxxxxxx",
        APPS_SCRIPT_WEBAPP_URL="https://script.google.com/macros/s/fake/exec",
        APPS_SCRIPT_WEBHOOK_SECRET="secret",
    )
    repo = AppsScriptJobRepository(settings)

    class FakeAS:
        def __init__(self) -> None:
            self.generate_calls = 0

        async def generate_job_completion_draft(self, body):
            self.generate_calls += 1
            raise AppsScriptError(
                "Apps Script redirect host rejected (script.google.com).",
                http_status=502,
                code="apps_script_redirect_host_rejected",
            )

        async def get_job_completion(self, body):
            return {
                "status": "Success",
                "data": {
                    "completion": None,
                    "labour_entries": [],
                    "machinery_entries": [],
                    "material_entries": [],
                    "can_edit": False,
                    "can_finalise": False,
                    "can_reopen": False,
                    "can_generate": True,
                },
            }

    fake = FakeAS()
    repo.apps_script = fake
    with pytest.raises(HTTPException) as exc:
        await repo.acompletion_action(
            "generate_job_completion_draft",
            {
                "job_sheet_id": "JS-MISSING",
                "staff_id": "STAFF-MGR001",
                "actor_role": "manager",
            },
        )
    assert exc.value.status_code == 502
    assert fake.generate_calls == 1


@pytest.mark.asyncio
async def test_generate_minimal_success_reloads_via_get(monkeypatch) -> None:
    from app.services.apps_script_repository import AppsScriptJobRepository
    from app.core.config import Settings

    settings = Settings(
        _env_file=None,
        DATA_MODE="apps_script",
        JWT_SECRET="test-secret-xxxxxxxxxxxxxxxx",
        APPS_SCRIPT_WEBAPP_URL="https://script.google.com/macros/s/fake/exec",
        APPS_SCRIPT_WEBHOOK_SECRET="secret",
    )
    repo = AppsScriptJobRepository(settings)

    class FakeAS:
        def __init__(self) -> None:
            self.generate_calls = 0
            self.get_calls = 0

        async def generate_job_completion_draft(self, body):
            self.generate_calls += 1
            return {
                "status": "Success",
                "action": "generate_job_completion_draft",
                "message": "Completion draft generated",
                "record_id": "CMP-MIN",
                "job_sheet_id": body["job_sheet_id"],
                "data": {
                    "completion_id": "CMP-MIN",
                    "job_sheet_id": body["job_sheet_id"],
                    "status": "Draft",
                    "labour_count": 2,
                    "machinery_count": 0,
                    "material_count": 1,
                    "generated": True,
                },
            }

        async def get_job_completion(self, body):
            self.get_calls += 1
            return {
                "status": "Success",
                "data": {
                    "completion": {
                        "completion_id": "CMP-MIN",
                        "job_sheet_id": body["job_sheet_id"],
                        "completion_status": "Draft",
                        "version": 1,
                    },
                    "labour_entries": [{}, {}],
                    "machinery_entries": [],
                    "material_entries": [{}],
                    "can_edit": True,
                    "can_finalise": True,
                    "can_reopen": False,
                    "can_generate": True,
                },
            }

    fake = FakeAS()
    repo.apps_script = fake
    out = await repo.acompletion_action(
        "generate_job_completion_draft",
        {
            "job_sheet_id": "JS-1",
            "staff_id": "STAFF-MGR001",
            "actor_role": "manager",
        },
    )
    assert out["completion"]["completion_id"] == "CMP-MIN"
    assert len(out["labour_entries"]) == 2
    assert fake.generate_calls == 1
    assert fake.get_calls == 1


def test_resolve_generate_completion_id_order() -> None:
    from app.services.apps_script_repository import AppsScriptJobRepository

    assert (
        AppsScriptJobRepository._resolve_generate_completion_id(
            {"data": {"completion_id": "CMP-A"}, "record_id": "CMP-B"}
        )
        == "CMP-A"
    )
    assert (
        AppsScriptJobRepository._resolve_generate_completion_id(
            {"completion_id": "CMP-C", "record_id": "CMP-D"}
        )
        == "CMP-C"
    )
    assert AppsScriptJobRepository._resolve_generate_completion_id({"record_id": "CMP-E"}) == "CMP-E"


@pytest.mark.asyncio
async def test_update_minimal_success_reloads_via_get(monkeypatch) -> None:
    from app.services.apps_script_repository import AppsScriptJobRepository
    from app.core.config import Settings

    settings = Settings(
        _env_file=None,
        DATA_MODE="apps_script",
        JWT_SECRET="test-secret-xxxxxxxxxxxxxxxx",
        APPS_SCRIPT_WEBAPP_URL="https://script.google.com/macros/s/fake/exec",
        APPS_SCRIPT_WEBHOOK_SECRET="secret",
    )
    repo = AppsScriptJobRepository(settings)

    class FakeAS:
        def __init__(self) -> None:
            self.update_calls = 0
            self.get_calls = 0

        async def update_job_completion(self, body):
            self.update_calls += 1
            return {
                "status": "Success",
                "action": "update_job_completion",
                "message": "Completion updated",
                "record_id": "CMP-UPD",
                "job_sheet_id": body["job_sheet_id"],
                "data": {
                    "completion_id": "CMP-UPD",
                    "job_sheet_id": body["job_sheet_id"],
                    "status": "Draft",
                    "version": 2,
                    "labour_count": 1,
                    "machinery_count": 0,
                    "material_count": 1,
                    "updated": True,
                },
            }

        async def get_job_completion(self, body):
            self.get_calls += 1
            return {
                "status": "Success",
                "data": {
                    "completion": {
                        "completion_id": "CMP-UPD",
                        "job_sheet_id": body["job_sheet_id"],
                        "completion_status": "Draft",
                        "work_summary": "Updated",
                        "version": 2,
                    },
                    "labour_entries": [{}],
                    "machinery_entries": [],
                    "material_entries": [{"quantity": 2.5}],
                    "can_edit": True,
                    "can_finalise": True,
                    "can_reopen": False,
                    "can_generate": True,
                },
            }

    fake = FakeAS()
    repo.apps_script = fake
    out = await repo.acompletion_action(
        "update_job_completion",
        {
            "job_sheet_id": "JS-1",
            "staff_id": "STAFF-MGR001",
            "actor_role": "manager",
            "expected_version": 1,
            "work_summary": "Updated",
        },
    )
    assert out["completion"]["completion_id"] == "CMP-UPD"
    assert out["completion"]["version"] == 2
    assert fake.update_calls == 1
    assert fake.get_calls == 1


@pytest.mark.asyncio
async def test_update_transport_bounce_reconciles_via_get() -> None:
    from app.services.apps_script import AppsScriptError
    from app.services.apps_script_repository import AppsScriptJobRepository
    from app.core.config import Settings

    settings = Settings(
        _env_file=None,
        DATA_MODE="apps_script",
        JWT_SECRET="test-secret-xxxxxxxxxxxxxxxx",
        APPS_SCRIPT_WEBAPP_URL="https://script.google.com/macros/s/fake/exec",
        APPS_SCRIPT_WEBHOOK_SECRET="secret",
    )
    repo = AppsScriptJobRepository(settings)

    class FakeAS:
        def __init__(self) -> None:
            self.update_calls = 0
            self.get_calls = 0

        async def update_job_completion(self, body):
            self.update_calls += 1
            raise AppsScriptError(
                "Apps Script redirect host rejected (script.google.com).",
                http_status=502,
                code="apps_script_redirect_host_rejected",
            )

        async def get_job_completion(self, body):
            self.get_calls += 1
            return {
                "status": "Success",
                "data": {
                    "completion": {
                        "completion_id": "CMP-RECON-U",
                        "job_sheet_id": body["job_sheet_id"],
                        "completion_status": "Draft",
                        "work_summary": "Persisted despite bounce",
                        "version": 3,
                    },
                    "labour_entries": [],
                    "machinery_entries": [],
                    "material_entries": [{"item_name": "Mulch"}],
                    "can_edit": True,
                    "can_finalise": True,
                    "can_reopen": False,
                    "can_generate": True,
                },
            }

    fake = FakeAS()
    repo.apps_script = fake
    out = await repo.acompletion_action(
        "update_job_completion",
        {
            "job_sheet_id": "JS-C405837D",
            "staff_id": "STAFF-MGR001",
            "actor_role": "manager",
            "expected_version": 2,
            "work_summary": "Persisted despite bounce",
            "material_entries": [{"item_name": "Mulch"}],
        },
    )
    assert out["completion"]["completion_id"] == "CMP-RECON-U"
    assert out["completion"]["version"] == 3
    assert fake.update_calls == 1
    assert fake.get_calls == 1


@pytest.mark.asyncio
async def test_update_transport_bounce_missing_change_returns_502() -> None:
    from fastapi import HTTPException

    from app.services.apps_script import AppsScriptError
    from app.services.apps_script_repository import AppsScriptJobRepository
    from app.core.config import Settings

    settings = Settings(
        _env_file=None,
        DATA_MODE="apps_script",
        JWT_SECRET="test-secret-xxxxxxxxxxxxxxxx",
        APPS_SCRIPT_WEBAPP_URL="https://script.google.com/macros/s/fake/exec",
        APPS_SCRIPT_WEBHOOK_SECRET="secret",
    )
    repo = AppsScriptJobRepository(settings)

    class FakeAS:
        def __init__(self) -> None:
            self.update_calls = 0

        async def update_job_completion(self, body):
            self.update_calls += 1
            raise AppsScriptError(
                "Apps Script redirect host rejected (script.google.com).",
                http_status=502,
                code="apps_script_redirect_host_rejected",
            )

        async def get_job_completion(self, body):
            return {
                "status": "Success",
                "data": {
                    "completion": {
                        "completion_id": "CMP-OLD",
                        "job_sheet_id": body["job_sheet_id"],
                        "completion_status": "Draft",
                        "work_summary": "Old summary",
                        "version": 2,
                    },
                    "labour_entries": [],
                    "machinery_entries": [],
                    "material_entries": [],
                    "can_edit": True,
                    "can_finalise": True,
                    "can_reopen": False,
                    "can_generate": True,
                },
            }

    fake = FakeAS()
    repo.apps_script = fake
    with pytest.raises(HTTPException) as exc:
        await repo.acompletion_action(
            "update_job_completion",
            {
                "job_sheet_id": "JS-1",
                "staff_id": "STAFF-MGR001",
                "actor_role": "manager",
                "expected_version": 2,
                "work_summary": "New summary that never landed",
            },
        )
    assert exc.value.status_code == 502
    assert fake.update_calls == 1


@pytest.mark.asyncio
async def test_update_409_returns_latest_version_safely() -> None:
    from fastapi import HTTPException

    from app.services.apps_script import AppsScriptError
    from app.services.apps_script_repository import AppsScriptJobRepository
    from app.core.config import Settings

    settings = Settings(
        _env_file=None,
        DATA_MODE="apps_script",
        JWT_SECRET="test-secret-xxxxxxxxxxxxxxxx",
        APPS_SCRIPT_WEBAPP_URL="https://script.google.com/macros/s/fake/exec",
        APPS_SCRIPT_WEBHOOK_SECRET="secret",
    )
    repo = AppsScriptJobRepository(settings)

    class FakeAS:
        def __init__(self) -> None:
            self.update_calls = 0
            self.get_calls = 0

        async def update_job_completion(self, body):
            self.update_calls += 1
            raise AppsScriptError(
                "Conflict: completion version changed since you loaded this record.",
                http_status=409,
            )

        async def get_job_completion(self, body):
            self.get_calls += 1
            return {
                "status": "Success",
                "data": {
                    "completion": {
                        "completion_id": "CMP-LIVE",
                        "job_sheet_id": body["job_sheet_id"],
                        "completion_status": "Draft",
                        "version": 5,
                    },
                    "labour_entries": [],
                    "machinery_entries": [],
                    "material_entries": [],
                    "can_edit": True,
                    "can_finalise": True,
                    "can_reopen": False,
                    "can_generate": True,
                },
            }

    fake = FakeAS()
    repo.apps_script = fake
    with pytest.raises(HTTPException) as exc:
        await repo.acompletion_action(
            "update_job_completion",
            {
                "job_sheet_id": "JS-1",
                "staff_id": "STAFF-MGR001",
                "actor_role": "manager",
                "expected_version": 4,
            },
        )
    assert exc.value.status_code == 409
    detail = exc.value.detail
    assert isinstance(detail, dict)
    assert detail["version"] == 5
    assert detail["completion_id"] == "CMP-LIVE"
    assert fake.update_calls == 1
    assert fake.get_calls == 1


def test_normalise_material_quantity_helpers() -> None:
    from app.services.completion_math import normalise_material_quantity

    assert normalise_material_quantity(2)["quantity"] == 2.0
    assert normalise_material_quantity("2.5")["quantity"] == 2.5
    assert normalise_material_quantity(" 0 ")["quantity"] == 0.0
    assert normalise_material_quantity("  ")["blank"] is True
    split = normalise_material_quantity("2 bags")
    assert split["ok"] is True
    assert split["quantity"] == 2.0
    assert split["unit"] == "bags"
    assert normalise_material_quantity("several")["ok"] is False
    assert normalise_material_quantity("N/A")["ok"] is False


def test_material_entry_schema_coerces_numeric_strings_and_splits_units() -> None:
    from app.models.schemas import LabourEntry, MachineryEntry, MaterialEntry
    from pydantic import ValidationError

    assert MaterialEntry.model_validate({"quantity": 2}).quantity == 2.0
    assert MaterialEntry.model_validate({"quantity": "2.5"}).quantity == 2.5
    assert MaterialEntry.model_validate({"quantity": "  "}).quantity is None
    split = MaterialEntry.model_validate({"quantity": "2 bags", "unit": ""})
    assert split.quantity == 2.0
    assert split.unit == "bags"
    assert LabourEntry.model_validate({"break_minutes": "30", "labour_hours": ""}).break_minutes == 30.0
    assert LabourEntry.model_validate({"break_minutes": "30", "labour_hours": ""}).labour_hours is None
    assert MachineryEntry.model_validate({"duration_hours": ""}).duration_hours is None
    assert MachineryEntry.model_validate({"duration_hours": "1.25"}).duration_hours == 1.25
    with pytest.raises(ValidationError):
        MaterialEntry.model_validate({"quantity": "several"})


def test_patch_completion_accepts_numeric_strings_without_apps_script() -> None:
    from app.models.schemas import CompletionUpdateRequest, LabourEntry, MachineryEntry, MaterialEntry

    body = CompletionUpdateRequest.model_validate(
        {
            "expected_version": "2",
            "material_entries": [
                {"item_name": "Soil", "quantity": "2 bags", "unit": ""},
                {"item_name": "Optional", "quantity": "", "unit": ""},
                {"item_name": "Decimal", "quantity": "2.5", "unit": "m3"},
            ],
            "labour_entries": [
                {
                    "staff_id": "STAFF-DEMO001",
                    "break_minutes": "30",
                    "travel_minutes": "15",
                    "labour_hours": "",
                    "start_time": "07:00",
                    "finish_time": "15:00",
                }
            ],
            "machinery_entries": [{"equipment_name": "Excavator", "duration_hours": "2.5"}],
        }
    )
    assert body.expected_version == 2
    assert body.material_entries is not None
    assert body.material_entries[0].quantity == 2.0
    assert body.material_entries[0].unit == "bags"
    assert body.material_entries[1].quantity is None
    assert body.material_entries[2].quantity == 2.5
    assert body.labour_entries is not None
    assert body.labour_entries[0].break_minutes == 30.0
    assert body.labour_entries[0].labour_hours is None
    assert body.machinery_entries is not None
    assert body.machinery_entries[0].duration_hours == 2.5
    # Zero preserved.
    assert LabourEntry.model_validate({"break_minutes": 0}).break_minutes == 0.0
    assert MaterialEntry.model_validate({"quantity": "0"}).quantity == 0.0
    assert MachineryEntry.model_validate({"duration_hours": "0"}).duration_hours == 0.0


def test_patch_completion_rejects_arbitrary_text_with_row_field(
    client: TestClient,
) -> None:
    job_id = _approve_demo_job(client)
    headers = _manager_headers(client)
    gen = client.post(f"/api/v1/jobs/{job_id}/completion/generate", headers=headers, json={})
    assert gen.status_code == 200, gen.text
    version = gen.json()["completion"]["version"]

    bad = client.patch(
        f"/api/v1/jobs/{job_id}/completion",
        headers=headers,
        json={
            "expected_version": version,
            "material_entries": [
                {"item_name": "Ok", "quantity": 1},
                {"item_name": "Bad", "quantity": "several"},
            ],
        },
    )
    assert bad.status_code == 422, bad.text
    detail = bad.json()["detail"]
    assert isinstance(detail, str)
    assert "Material row 2 quantity must be a number" in detail
    assert "unable to parse string as a number" not in detail.lower()


def test_format_completion_validation_loc() -> None:
    from app.services.completion_math import format_completion_validation_loc

    assert (
        format_completion_validation_loc(("body", "material_entries", 1, "quantity"))
        == "Material row 2 quantity must be a number."
    )
    assert (
        format_completion_validation_loc(("body", "labour_entries", 0, "labour_hours"))
        == "Labour row 1 labour hours must be a number."
    )