"""ContentService redirect handling for AppsScriptClient (POST /exec → GET echo)."""

from __future__ import annotations

from pathlib import Path
import httpx
import pytest

from app.core.config import get_settings
from app.services.apps_script import AppsScriptClient, AppsScriptError

EXEC_URL = "https://script.google.com/macros/s/fake/exec"
SIGNED_ECHO = (
    "https://script.googleusercontent.com/macros/echo"
    "?user_content_key=SIGNED_SECRET_VALUE&lib=LIB123"
)
_RealAsyncClient = httpx.AsyncClient


def _settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APPS_SCRIPT_WEBAPP_URL", EXEC_URL)
    monkeypatch.setenv("APPS_SCRIPT_WEBHOOK_SECRET", "test-webhook-secret")
    monkeypatch.setenv("APPS_SCRIPT_TIMEOUT_SECONDS", "90")
    monkeypatch.setenv("APPS_SCRIPT_REDIRECT_GET_TIMEOUT_SECONDS", "15")
    monkeypatch.setenv("JWT_SECRET", "test-secret-xxxxxxxxxxxxxxxx")
    get_settings.cache_clear()


def _patch_client(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    monkeypatch.setattr(
        "app.services.apps_script.httpx.AsyncClient",
        lambda *a, **k: _RealAsyncClient(
            *a, **{**k, "transport": httpx.MockTransport(handler)}
        ),
    )


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> AppsScriptClient:
    _settings(monkeypatch)
    return AppsScriptClient(get_settings())


@pytest.mark.asyncio
async def test_post_302_immediate_get_200_json(client: AppsScriptClient, monkeypatch) -> None:
    methods: list[str] = []
    urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        methods.append(request.method)
        urls.append(str(request.url))
        if request.method == "POST":
            assert request.url.host == "script.google.com"
            return httpx.Response(
                302, headers={"Location": SIGNED_ECHO}, request=request
            )
        assert request.method == "GET"
        assert str(request.url) == SIGNED_ECHO
        return httpx.Response(
            200,
            json={
                "status": "Success",
                "action": "list_job_create_masters",
                "message": "OK",
                "data": {"customers": [], "projects": [], "staff": []},
            },
            request=request,
        )

    monkeypatch.setattr(
        "app.services.apps_script.httpx.AsyncClient",
        lambda *a, **k: _RealAsyncClient(
            *a, **{**k, "transport": httpx.MockTransport(handler)}
        ),
    )
    out = await client.list_job_create_masters({})
    assert out["status"] == "Success"
    assert methods == ["POST", "GET"]
    assert urls[1] == SIGNED_ECHO


@pytest.mark.asyncio
async def test_redirect_get_not_post_and_query_preserved(
    client: AppsScriptClient, monkeypatch
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(302, headers={"Location": SIGNED_ECHO}, request=request)
        assert request.method == "GET"
        assert "user_content_key=SIGNED_SECRET_VALUE" in str(request.url)
        assert "lib=LIB123" in str(request.url)
        # Must not re-send webhook body.
        assert not request.content
        return httpx.Response(
            200,
            json={"status": "Success", "message": "OK", "data": {}},
            request=request,
        )

    monkeypatch.setattr(
        "app.services.apps_script.httpx.AsyncClient",
        lambda *a, **k: _RealAsyncClient(
            *a, **{**k, "transport": httpx.MockTransport(handler)}
        ),
    )
    await client._post("list_jobs_for_staff", {"staff_id": "S1", "days": 7})


@pytest.mark.asyncio
async def test_redirect_host_allowlist(client: AppsScriptClient, monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            302,
            headers={"Location": "https://evil.example/steal"},
            request=request,
        )

    monkeypatch.setattr(
        "app.services.apps_script.httpx.AsyncClient",
        lambda *a, **k: _RealAsyncClient(
            *a, **{**k, "transport": httpx.MockTransport(handler)}
        ),
    )
    with pytest.raises(AppsScriptError) as exc:
        await client._post("list_jobs_for_staff", {"staff_id": "S1", "days": 7})
    assert exc.value.code == "apps_script_redirect_host_rejected"


@pytest.mark.asyncio
async def test_redirect_back_to_exec_rejected(client: AppsScriptClient, monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"Location": EXEC_URL}, request=request)

    monkeypatch.setattr(
        "app.services.apps_script.httpx.AsyncClient",
        lambda *a, **k: _RealAsyncClient(
            *a, **{**k, "transport": httpx.MockTransport(handler)}
        ),
    )
    with pytest.raises(AppsScriptError) as exc:
        await client._post("list_jobs_for_staff", {"staff_id": "S1", "days": 7})
    assert exc.value.code == "apps_script_redirect_host_rejected"


@pytest.mark.asyncio
async def test_redirect_loop_rejected(client: AppsScriptClient, monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(302, headers={"Location": SIGNED_ECHO}, request=request)
        return httpx.Response(302, headers={"Location": SIGNED_ECHO}, request=request)

    monkeypatch.setattr(
        "app.services.apps_script.httpx.AsyncClient",
        lambda *a, **k: _RealAsyncClient(
            *a, **{**k, "transport": httpx.MockTransport(handler)}
        ),
    )
    with pytest.raises(AppsScriptError) as exc:
        await client._post("list_jobs_for_staff", {"staff_id": "S1", "days": 7})
    assert exc.value.code == "apps_script_redirect_loop"


@pytest.mark.asyncio
async def test_usercontent_404_classified_expired(client: AppsScriptClient, monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(302, headers={"Location": SIGNED_ECHO}, request=request)
        return httpx.Response(404, text="gone", request=request)

    monkeypatch.setattr(
        "app.services.apps_script.httpx.AsyncClient",
        lambda *a, **k: _RealAsyncClient(
            *a, **{**k, "transport": httpx.MockTransport(handler)}
        ),
    )
    with pytest.raises(AppsScriptError) as exc:
        await client._post("list_jobs_for_staff", {"staff_id": "S1", "days": 7})
    assert exc.value.code == "apps_script_redirect_expired"


@pytest.mark.asyncio
async def test_html_200_rejected(client: AppsScriptClient, monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(302, headers={"Location": SIGNED_ECHO}, request=request)
        return httpx.Response(
            200,
            text="<!DOCTYPE html><html>login</html>",
            headers={"content-type": "text/html"},
            request=request,
        )

    monkeypatch.setattr(
        "app.services.apps_script.httpx.AsyncClient",
        lambda *a, **k: _RealAsyncClient(
            *a, **{**k, "transport": httpx.MockTransport(handler)}
        ),
    )
    with pytest.raises(AppsScriptError) as exc:
        await client._post("list_jobs_for_staff", {"staff_id": "S1", "days": 7})
    assert exc.value.code == "apps_script_response_html"


@pytest.mark.asyncio
async def test_direct_200_json_still_succeeds(client: AppsScriptClient, monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        return httpx.Response(
            200,
            json={"status": "Success", "message": "OK", "data": {"ok": True}},
            request=request,
        )

    monkeypatch.setattr(
        "app.services.apps_script.httpx.AsyncClient",
        lambda *a, **k: _RealAsyncClient(
            *a, **{**k, "transport": httpx.MockTransport(handler)}
        ),
    )
    out = await client._post("list_jobs_for_staff", {"staff_id": "S1", "days": 7})
    assert out["proxied"] is True


@pytest.mark.asyncio
async def test_missing_location(client: AppsScriptClient, monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={}, request=request)

    monkeypatch.setattr(
        "app.services.apps_script.httpx.AsyncClient",
        lambda *a, **k: _RealAsyncClient(
            *a, **{**k, "transport": httpx.MockTransport(handler)}
        ),
    )
    with pytest.raises(AppsScriptError) as exc:
        await client._post("list_jobs_for_staff", {"staff_id": "S1", "days": 7})
    assert exc.value.code == "apps_script_missing_location"


@pytest.mark.asyncio
async def test_create_never_retries_post_on_redirect_failure(
    client: AppsScriptClient, monkeypatch
) -> None:
    post_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            post_count["n"] += 1
            return httpx.Response(302, headers={"Location": SIGNED_ECHO}, request=request)
        return httpx.Response(404, text="expired", request=request)

    monkeypatch.setattr(
        "app.services.apps_script.httpx.AsyncClient",
        lambda *a, **k: _RealAsyncClient(
            *a, **{**k, "transport": httpx.MockTransport(handler)}
        ),
    )
    with pytest.raises(AppsScriptError) as exc:
        await client.create_completed_job_sheet_from_recordings(
            {
                "work_session_id": "DWS-1",
                "idempotency_key": "k1",
                "payload_hash": "h1",
                "job_fields": {
                    "staff_id": "S1",
                    "date": "2026-08-01",
                    "project_id": "P1",
                    "manager_notes": "WORK COMPLETED\n- x",
                    "processing_status": "Completed",
                    "processing_error": "",
                    "approval_status": "Pending Review",
                },
                "recordings": [{"recording_id": "R1", "sequence": 1}],
            }
        )
    assert exc.value.code == "apps_script_redirect_expired"
    assert post_count["n"] == 1


@pytest.mark.asyncio
async def test_create_redirect_success_parses_envelope(
    client: AppsScriptClient, monkeypatch
) -> None:
    envelope = {
        "status": "Success",
        "action": "create_completed_job_sheet_from_recordings",
        "message": "Completed job sheet created",
        "record_id": "JS-ABC",
        "job_sheet_id": "JS-ABC",
        "job": {"job_sheet_id": "JS-ABC", "processing_status": "Completed"},
        "idempotent": False,
        "data": {
            "job_sheet_id": "JS-ABC",
            "record_id": "JS-ABC",
            "job": {"job_sheet_id": "JS-ABC", "processing_status": "Completed"},
            "links": [],
            "idempotent": False,
        },
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(302, headers={"Location": SIGNED_ECHO}, request=request)
        return httpx.Response(200, json=envelope, request=request)

    monkeypatch.setattr(
        "app.services.apps_script.httpx.AsyncClient",
        lambda *a, **k: _RealAsyncClient(
            *a, **{**k, "transport": httpx.MockTransport(handler)}
        ),
    )
    out = await client.create_completed_job_sheet_from_recordings(
        {
            "work_session_id": "DWS-1",
            "idempotency_key": "k1",
            "payload_hash": "h1",
            "job_fields": {
                "staff_id": "S1",
                "date": "2026-08-01",
                "project_id": "P1",
                "manager_notes": "WORK COMPLETED\n- x",
                "processing_status": "Completed",
                "processing_error": "",
                "approval_status": "Pending Review",
            },
            "recordings": [{"recording_id": "R1", "sequence": 1}],
        }
    )
    assert out["job_sheet_id"] == "JS-ABC"
    assert out["job"]["job_sheet_id"] == "JS-ABC"


@pytest.mark.asyncio
async def test_create_transport_error_reconciles_without_second_post(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATA_MODE", "apps_script")
    monkeypatch.setenv("DAILY_WORK_SESSIONS_DIR", str(tmp_path / "dws"))
    monkeypatch.setenv("JWT_SECRET", "test-secret-daily-work-xxxxxxxx")
    get_settings.cache_clear()
    from app.services.daily_work import DailyWorkService
    from app.services.daily_work_math import empty_extraction, payload_hash

    settings = get_settings()
    svc = DailyWorkService(settings)
    wid = "DWS-REDIR-SAFE"
    job = {
        "customer_name": "Acme",
        "project_name": "Acme",
        "project_id": "PROJ-1",
        "work_date": "2026-08-01",
        "staff_ids": ["STAFF-DEMO001"],
        "staff_names": ["Alex Technician"],
        "work_completed": [{"text": "Pruned hedges", "recording_ids": ["R1"]}],
        "materials_used": [],
        "equipment_used": [],
        "hours_or_times": [],
        "site_conditions": [],
        "issues_found": [],
        "client_requests": [],
        "follow_up_required": [],
        "safety_notes": [],
        "manager_notes": "WORK COMPLETED\n- Pruned hedges",
        "completion_summary": "Done",
        "site_address": "",
    }
    extraction = empty_extraction(wid, "2026-08-01")
    extraction["job_sheet"] = job
    svc.store.save(
        {
            "work_session_id": wid,
            "work_date": "2026-08-01",
            "staff_ids": ["STAFF-DEMO001"],
            "staff_names": ["Alex Technician"],
            "project_id": "PROJ-1",
            "status": "ReviewRequired",
            "recordings": [{"recording_id": "R1", "status": "Processed", "sequence": 1}],
            "extraction": extraction,
            "version": 1,
            "created_by": "STAFF-DEMO001",
        }
    )

    class FakeAS:
        def __init__(self) -> None:
            self.create_calls = 0
            self.reconcile_calls = 0

        async def create_completed_job_sheet_from_recordings(self, body):
            self.create_calls += 1
            raise AppsScriptError(
                "Apps Script ContentService redirect expired (404).",
                http_status=502,
                code="apps_script_redirect_expired",
            )

        async def get_completed_job_sheet_create_result(self, body):
            self.reconcile_calls += 1
            return {
                "status": "Success",
                "job_sheet_id": "JS-FROM-KEY",
                "data": {
                    "found": True,
                    "job_sheet_id": "JS-FROM-KEY",
                    "payload_hash": payload_hash(job, wid),
                    "job": {"job_sheet_id": "JS-FROM-KEY"},
                },
            }

    fake = FakeAS()
    svc.apps_script = fake
    out = await svc.create_job_sheet(
        wid,
        staff_id="STAFF-DEMO001",
        staff_name="Alex Technician",
        actor_role="staff",
        expected_session_version=1,
        reviewed_job_sheet=job,
        idempotency_key="idem-redir-1",
    )
    assert out["job"]["job_sheet_id"] == "JS-FROM-KEY"
    assert out["session"]["status"] == "JobCreated"
    assert fake.create_calls == 1
    assert fake.reconcile_calls == 1
