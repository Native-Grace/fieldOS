"""Phase 3F job report PDF tests (mock mode)."""

from __future__ import annotations

import base64
import json
import re
import zlib
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.services.report_math import (
    MAX_REPORT_PDF_BYTES,
    REPORT_CLIENT_JOB_REPORT,
    REPORT_COMPLETION_REGISTER,
    REPORT_JOB_SHEET_SUMMARY,
    REPORT_PROJECT_ACTIVITY_REPORT,
    REPORT_STAFF_WORK_REPORT,
    REPORT_TYPES,
    TEMPLATE_VERSION,
    extract_task_lines,
    safe_report_filename,
    scrub_report_record,
    sha256_hex,
    validate_pdf_bytes,
)

TRANSCRIPT_MARKER = "SECRETTRANSCRIPTMUSTNOTPRINT"
DRIVE_MARKER = "DRIVEIDMUSTNOTPRINT"

# Money, invoice numbers and ledger status never belong on a Phase 3F report.
POSTING_MARKERS = (
    "posted to xero",
    "auto-posted",
    "autopost",
    "invoice_number",
    "invoice number",
    "tax invoice",
    "gst",
    "amount due",
    "unit_cost",
    "cost_rate",
    "sell_rate",
)


def _clear_settings() -> None:
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
    token = _login(client, "manager@nativegrace.com", "FieldOS-Manager-2026!")
    return {"Authorization": f"Bearer {token}"}


def _staff_headers(client: TestClient) -> dict[str, str]:
    token = _login(client, "alex@nativegrace.com", "FieldOS-Demo-2026!")
    return {"Authorization": f"Bearer {token}"}


def _store():
    from app.core.config import get_settings
    from app.services.mock_store import MockStore

    return MockStore(get_settings())


def seed_finalised_job(
    *,
    job_sheet_id: str,
    completion_id: str,
    job_date: str = "2026-07-16",
    customer_name: str = "Kat and James Dykes",
    project_name: str = "Dykes Garden Stage 2",
    staff_id: str = "STAFF-DEMO001",
    staff_name: str = "Alex Demo",
    labour_rows: int = 1,
    machinery_rows: int = 1,
    material_rows: int = 1,
) -> dict[str, Any]:
    """Write a finalised job + completion straight into the mock store."""
    store = _store()
    jobs = store._read(store.jobs_path)
    job = {
        "job_sheet_id": job_sheet_id,
        "staff_id": staff_id,
        "date": job_date,
        "job_date": job_date,
        "project_id": project_name,
        "project_name": project_name,
        "customer_name": customer_name,
        "processing_status": "Completed",
        "approval_status": "Approved",
        "ai_summary": "Planted seven trees and reshaped the driveway.",
        "manager_review_items": "Confirm gate access with owner.\nReplace two failed shrubs.",
        "variations": "Driveway reshape",
        # Both markers must be scrubbed out of every rendered report.
        "ai_transcript": TRANSCRIPT_MARKER,
        "drive_folder_id": DRIVE_MARKER,
        "approved_by": "manager@nativegrace.com",
        "approved_at": "2026-07-16T05:00:00+00:00",
    }
    jobs = [row for row in jobs if str(row.get("job_sheet_id")) != job_sheet_id]
    jobs.append(job)
    store._write(store.jobs_path, jobs)

    labour = [
        {
            "labour_id": f"LAB-{job_sheet_id}-{index}",
            "completion_id": completion_id,
            "job_sheet_id": job_sheet_id,
            "staff_id": staff_id,
            "staff_name": staff_name,
            "work_date": job_date,
            "start_time": "07:00",
            "finish_time": "15:00",
            "break_minutes": 30,
            "labour_hours": 7.5,
            "travel_minutes": 20,
            "travel_hours": 0.33,
            "role_or_activity": "Planting and site tidy",
            "billable": True,
            "confirmation_status": "Confirmed",
            "notes": "Long-form note that should wrap across the printed column without truncation.",
            "source": "manual",
        }
        for index in range(labour_rows)
    ]
    machinery = [
        {
            "machinery_entry_id": f"MCH-{job_sheet_id}-{index}",
            "completion_id": completion_id,
            "job_sheet_id": job_sheet_id,
            "equipment_name": "Excavator",
            "operator_staff_id": staff_id,
            "duration_hours": 1.5,
            "billable": True,
            "confirmation_status": "Confirmed",
            "charge_code": "EX-01",
            "notes": "Driveway reshape",
        }
        for index in range(machinery_rows)
    ]
    materials = [
        {
            "material_entry_id": f"JMT-{job_sheet_id}-{index}",
            "completion_id": completion_id,
            "job_sheet_id": job_sheet_id,
            "item_name": "Trees (supply and planting)",
            "quantity": 7,
            "unit": "each",
            "billable": True,
            "confirmation_status": "Confirmed",
            "notes": "",
        }
        for index in range(material_rows)
    ]
    completion = {
        "completion_id": completion_id,
        "job_sheet_id": job_sheet_id,
        "completion_status": "Finalised",
        "work_summary": "Planted seven trees along the northern boundary and reshaped the driveway.",
        "invoice_description": "Supply and plant seven trees; reshape gravel driveway.",
        "internal_notes": "Owner asked about a follow-up visit in spring.",
        "variations": ["Driveway reshape"],
        "warnings": [],
        "warning_resolutions": [],
        "labour_entries": labour,
        "machinery_entries": machinery,
        "material_entries": materials,
        "total_labour_hours": 7.5 * labour_rows,
        "total_travel_hours": 0.33 * labour_rows,
        "total_machinery_hours": 1.5 * machinery_rows,
        "billable_labour_hours": 7.5 * labour_rows,
        "non_billable_labour_hours": 0,
        "finalised_by": "manager@nativegrace.com",
        "finalised_at": "2026-07-16T06:00:00+00:00",
        "created_by": "manager@nativegrace.com",
        "created_at": "2026-07-16T05:30:00+00:00",
        "version": 2,
        "ai_transcript": TRANSCRIPT_MARKER,
        "recording_drive_file_id": DRIVE_MARKER,
    }
    store.upsert_completion(completion)
    return {"job": job, "completion": completion}


def run_report_lifecycle(
    client: TestClient,
    headers: dict[str, str],
    report_type: str,
    **body: Any,
) -> dict[str, Any]:
    payload = {
        "report_type": report_type,
        "date_from": "2020-01-01",
        "date_to": "2030-12-31",
        **body,
    }
    created = client.post("/api/v1/reports", headers=headers, json=payload)
    assert created.status_code == 200, created.text
    batch = created.json()["report_batch"]
    assert batch["status"] == "Draft"

    validated = client.post(
        f"/api/v1/reports/{batch['report_batch_id']}/validate",
        headers=headers,
        json={"expected_version": batch["version"]},
    )
    assert validated.status_code == 200, validated.text
    validated_batch = validated.json()["report_batch"]
    assert validated_batch["status"] == "Validated", validated.json()["items"]

    generated = client.post(
        f"/api/v1/reports/{batch['report_batch_id']}/generate",
        headers=headers,
        json={"expected_version": validated_batch["version"]},
    )
    assert generated.status_code == 200, generated.text
    return generated.json()["report_batch"]


def pdf_page_count(pdf: bytes) -> int:
    counts = [int(value) for value in re.findall(rb"/Count\s+(\d+)", pdf)]
    return max(counts) if counts else 0


def pdf_text(pdf: bytes) -> str:
    """Best-effort text extraction from page content streams.

    ReportLab writes streams as ASCII85 over Flate, so undo both before reading.
    """
    chunks: list[str] = []
    for match in re.finditer(rb"stream\r?\n(.*?)endstream", pdf, re.S):
        raw = match.group(1).strip()
        if raw.endswith(b"~>"):
            try:
                raw = base64.a85decode(raw, adobe=True)
            except ValueError:
                pass
        try:
            raw = zlib.decompress(raw)
        except zlib.error:
            pass
        chunks.append(raw.decode("latin-1", errors="replace"))
    return "\n".join(chunks)


def test_report_typed_schemas_smoke() -> None:
    from app.models.schemas import (
        CreateReportBatchRequest,
        ReportBatchItemOut,
        ReportBatchListItem,
        ReportBatchOut,
        ReportFilters,
        ReportPreviewItem,
        ReportPreviewRequest,
        ReportTotals,
    )

    assert REPORT_TYPES == (
        REPORT_JOB_SHEET_SUMMARY,
        REPORT_STAFF_WORK_REPORT,
        REPORT_CLIENT_JOB_REPORT,
        REPORT_PROJECT_ACTIVITY_REPORT,
        REPORT_COMPLETION_REGISTER,
    )
    assert TEMPLATE_VERSION == "3F.1"

    preview = ReportPreviewRequest(
        report_type=REPORT_STAFF_WORK_REPORT,
        filters=ReportFilters(date_from="2026-07-01", staff_id="STAFF-DEMO001"),
    )
    assert preview.filters is not None
    assert preview.filters.staff_id == "STAFF-DEMO001"

    create = CreateReportBatchRequest(report_type=REPORT_COMPLETION_REGISTER, landscape=True)
    assert create.landscape is True
    assert create.notes is None

    batch = ReportBatchOut.model_validate(
        {
            "report_batch_id": "RPT-ABCD1234",
            "report_type": REPORT_COMPLETION_REGISTER,
            "status": "Generated",
            "record_count": 3,
            "checksum": "0" * 64,
            "version": 3,
        }
    )
    assert batch.audience == "internal"
    assert batch.byte_size == 0

    item = ReportBatchItemOut.model_validate(
        {"report_batch_item_id": "RPI-1", "report_batch_id": "RPT-ABCD1234"}
    )
    assert item.item_status == ""
    assert ReportBatchListItem.model_validate(
        {"report_batch_id": "RPT-ABCD1234"}
    ).page_estimate == 0
    assert ReportTotals().job_count == 0
    assert ReportPreviewItem().job_sheet_id == ""
    assert safe_report_filename(REPORT_COMPLETION_REGISTER, "2026-07-01", "2026-07-31").endswith(
        ".pdf"
    )


def test_validate_pdf_bytes_rejects_empty_and_junk() -> None:
    assert validate_pdf_bytes(b"%PDF-1.4\nrest") == 13

    with pytest.raises(ValueError, match="empty"):
        validate_pdf_bytes(b"")
    with pytest.raises(ValueError, match="empty"):
        validate_pdf_bytes(None)
    with pytest.raises(ValueError, match="%PDF header"):
        validate_pdf_bytes(b"<html>not a pdf</html>")
    with pytest.raises(ValueError, match="raw bytes"):
        validate_pdf_bytes("%PDF-1.4")
    with pytest.raises(ValueError, match="limit"):
        validate_pdf_bytes(b"%PDF" + b"0" * MAX_REPORT_PDF_BYTES)

    assert sha256_hex(b"%PDF-1.4") == sha256_hex("%PDF-1.4")
    assert len(sha256_hex(b"abc")) == 64


def test_scrub_removes_transcript_drive_and_client_private_fields() -> None:
    record = {
        "job_sheet_id": "21759f5d",
        "ai_transcript": TRANSCRIPT_MARKER,
        "drive_folder_id": DRIVE_MARKER,
        "recording_drive_file_id": DRIVE_MARKER,
        "access_token": "Bearer abc.def",
        "webhook_secret": "shhh",
        "internal_notes": "Internal only",
        "warnings": ["Shift exceeds 12 hours."],
        "labour": [{"staff_id": "S1", "cost_rate": "42.00", "ai_transcript": TRANSCRIPT_MARKER}],
    }

    internal = scrub_report_record(record)
    blob = json.dumps(internal)
    assert TRANSCRIPT_MARKER not in blob
    assert DRIVE_MARKER not in blob
    assert "Bearer" not in blob
    assert "shhh" not in blob
    # Internal reports keep internal commentary.
    assert internal["internal_notes"] == "Internal only"
    assert internal["warnings"] == ["Shift exceeds 12 hours."]

    client_copy = scrub_report_record(record, audience="client")
    client_blob = json.dumps(client_copy)
    assert TRANSCRIPT_MARKER not in client_blob
    assert "internal_notes" not in client_copy
    assert "warnings" not in client_copy
    assert "cost_rate" not in client_copy["labour"][0]
    assert client_copy["labour"][0]["staff_id"] == "S1"


def test_task_lines_only_come_from_approved_review_and_variations() -> None:
    job = {
        "approval_status": "Approved",
        "manager_review_items": "Confirm gate access.\nReplace two shrubs.",
        "variations": "Driveway reshape",
    }
    lines = extract_task_lines(job, {"variations": ["Driveway reshape"]})
    assert [line["text"] for line in lines] == [
        "Confirm gate access.",
        "Replace two shrubs.",
        "Driveway reshape",
    ]
    assert {line["source"] for line in lines} == {"Manager review", "Variation"}

    # Nothing is inferred while the job is still awaiting approval.
    pending = extract_task_lines(
        {**job, "approval_status": "Pending Review"}, {"variations": ["Driveway reshape"]}
    )
    assert [line["source"] for line in pending] == ["Variation"]


def test_report_options_and_preview_by_role(client: TestClient) -> None:
    seed_finalised_job(job_sheet_id="21759f5d", completion_id="CMP-288481F1")
    manager = _manager_headers(client)
    staff = _staff_headers(client)

    options = client.get("/api/v1/reports/options", headers=manager)
    assert options.status_code == 200, options.text
    body = options.json()
    assert body["report_types"] == list(REPORT_TYPES)
    assert body["template_version"] == TEMPLATE_VERSION
    assert body["audiences"][REPORT_CLIENT_JOB_REPORT] == "client"
    assert body["landscape_defaults"][REPORT_COMPLETION_REGISTER] is True

    staff_options = client.get("/api/v1/reports/options", headers=staff)
    assert staff_options.status_code == 200
    assert staff_options.json()["report_types"] == [REPORT_STAFF_WORK_REPORT]

    preview = client.post(
        "/api/v1/reports/preview",
        headers=manager,
        json={
            "report_type": REPORT_COMPLETION_REGISTER,
            "date_from": "2020-01-01",
            "date_to": "2030-12-31",
        },
    )
    assert preview.status_code == 200, preview.text
    preview_body = preview.json()
    assert preview_body["job_count"] == 1
    assert preview_body["page_estimate"] >= 1
    assert preview_body["totals"]["labour_hours"] == 7.5
    assert preview_body["items"][0]["job_sheet_id"] == "21759f5d"
    assert TRANSCRIPT_MARKER not in preview.text
    assert DRIVE_MARKER not in preview.text


def test_staff_forbidden_on_client_report_and_scoped_to_own_labour(client: TestClient) -> None:
    seed_finalised_job(job_sheet_id="21759f5d", completion_id="CMP-288481F1")
    seed_finalised_job(
        job_sheet_id="JS-OTHER01",
        completion_id="CMP-OTHER001",
        staff_id="STAFF-OTHER",
        staff_name="Other Person",
        customer_name="Someone Else",
    )
    staff = _staff_headers(client)

    for report_type in (
        REPORT_CLIENT_JOB_REPORT,
        REPORT_JOB_SHEET_SUMMARY,
        REPORT_PROJECT_ACTIVITY_REPORT,
        REPORT_COMPLETION_REGISTER,
    ):
        forbidden = client.post(
            "/api/v1/reports",
            headers=staff,
            json={"report_type": report_type, "date_from": "2020-01-01", "date_to": "2030-12-31"},
        )
        assert forbidden.status_code == 403, f"{report_type}: {forbidden.text}"
        assert "Manager or admin role required" in forbidden.json()["detail"]

        preview = client.post(
            "/api/v1/reports/preview",
            headers=staff,
            json={"report_type": report_type},
        )
        assert preview.status_code == 403, f"{report_type}: {preview.text}"

    allowed = client.post(
        "/api/v1/reports",
        headers=staff,
        json={
            "report_type": REPORT_STAFF_WORK_REPORT,
            "date_from": "2020-01-01",
            "date_to": "2030-12-31",
        },
    )
    assert allowed.status_code == 200, allowed.text
    # Staff selection is forced onto their own staff_id, so the other job is excluded.
    assert allowed.json()["report_batch"]["record_count"] == 1
    assert allowed.json()["items"][0]["job_sheet_id"] == "21759f5d"

    # A manager batch is not visible to staff.
    manager_batch = run_report_lifecycle(client, _manager_headers(client), REPORT_CLIENT_JOB_REPORT)
    denied = client.get(
        f"/api/v1/reports/{manager_batch['report_batch_id']}", headers=staff
    )
    assert denied.status_code == 403, denied.text
    denied_download = client.get(
        f"/api/v1/reports/{manager_batch['report_batch_id']}/download", headers=staff
    )
    assert denied_download.status_code == 403


def test_register_download_is_a_valid_pdf_with_checksum_and_filename(client: TestClient) -> None:
    seed_finalised_job(job_sheet_id="21759f5d", completion_id="CMP-288481F1")
    headers = _manager_headers(client)
    batch = run_report_lifecycle(client, headers, REPORT_COMPLETION_REGISTER)

    assert batch["status"] == "Generated"
    assert batch["file_name"] == safe_report_filename(
        REPORT_COMPLETION_REGISTER, "2020-01-01", "2030-12-31"
    )
    assert batch["file_name"].endswith(".pdf")
    assert len(batch["checksum"]) == 64
    assert batch["byte_size"] > 0
    assert batch["template_version"] == TEMPLATE_VERSION

    download = client.get(f"/api/v1/reports/{batch['report_batch_id']}/download", headers=headers)
    assert download.status_code == 200, download.text
    assert download.headers["content-type"] == "application/pdf"
    disposition = download.headers["content-disposition"]
    assert "attachment" in disposition
    assert f'filename="{batch["file_name"]}"' in disposition

    pdf = download.content
    assert pdf.startswith(b"%PDF")
    assert validate_pdf_bytes(pdf) == len(pdf)
    # The stored checksum survives a re-render from the frozen snapshot.
    assert download.headers["x-report-checksum"] == batch["checksum"]
    assert sha256_hex(pdf) == batch["checksum"]
    assert int(download.headers["content-length"]) == len(pdf)

    # Generated reports are immutable and cannot be cancelled.
    regenerate = client.post(
        f"/api/v1/reports/{batch['report_batch_id']}/generate",
        headers=headers,
        json={"expected_version": batch["version"]},
    )
    assert regenerate.status_code == 422
    cancel = client.post(
        f"/api/v1/reports/{batch['report_batch_id']}/cancel",
        headers=headers,
        json={"expected_version": batch["version"]},
    )
    assert cancel.status_code == 422

    listing = client.get("/api/v1/reports", headers=headers)
    assert listing.status_code == 200
    assert any(
        row["report_batch_id"] == batch["report_batch_id"] for row in listing.json()["items"]
    )


def test_cancel_and_stale_version_conflict(client: TestClient) -> None:
    seed_finalised_job(job_sheet_id="21759f5d", completion_id="CMP-288481F1")
    headers = _manager_headers(client)
    created = client.post(
        "/api/v1/reports",
        headers=headers,
        json={
            "report_type": REPORT_STAFF_WORK_REPORT,
            "date_from": "2020-01-01",
            "date_to": "2030-12-31",
        },
    )
    assert created.status_code == 200, created.text
    batch = created.json()["report_batch"]

    conflict = client.post(
        f"/api/v1/reports/{batch['report_batch_id']}/validate",
        headers=headers,
        json={"expected_version": 999},
    )
    assert conflict.status_code == 409

    # Downloading before generate is refused rather than returning an empty file.
    early = client.get(f"/api/v1/reports/{batch['report_batch_id']}/download", headers=headers)
    assert early.status_code == 422

    cancelled = client.post(
        f"/api/v1/reports/{batch['report_batch_id']}/cancel",
        headers=headers,
        json={"expected_version": batch["version"]},
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["report_batch"]["status"] == "Cancelled"


def test_multi_page_landscape_register(client: TestClient) -> None:
    for index in range(45):
        seed_finalised_job(
            job_sheet_id=f"JS-REG{index:03d}",
            completion_id=f"CMP-REG{index:05d}",
            job_date=f"2026-06-{(index % 28) + 1:02d}",
            customer_name=f"Customer {index:03d} with a long trading name",
            project_name=f"Project {index:03d} boundary and driveway works",
        )
    headers = _manager_headers(client)
    batch = run_report_lifecycle(client, headers, REPORT_COMPLETION_REGISTER)
    assert batch["record_count"] == 45
    assert batch["landscape"] is True

    download = client.get(f"/api/v1/reports/{batch['report_batch_id']}/download", headers=headers)
    assert download.status_code == 200
    pdf = download.content
    assert pdf.startswith(b"%PDF")
    assert pdf_page_count(pdf) >= 2, "45-job register should span multiple pages"
    # A4 landscape is 841.89 x 595.28 pt.
    assert b"/MediaBox [ 0 0 841.8898 595.2756 ]" in pdf

    text = pdf_text(pdf)
    assert "Native Grace" in text
    assert "Page 1 of" in text
    assert "Generated from Native Grace FieldOS" in text
    assert batch["report_batch_id"] in text


def test_staff_and_client_report_pdfs_render(client: TestClient) -> None:
    seed_finalised_job(job_sheet_id="21759f5d", completion_id="CMP-288481F1")
    headers = _manager_headers(client)

    for report_type in (
        REPORT_STAFF_WORK_REPORT,
        REPORT_CLIENT_JOB_REPORT,
        REPORT_PROJECT_ACTIVITY_REPORT,
        REPORT_JOB_SHEET_SUMMARY,
    ):
        batch = run_report_lifecycle(client, headers, report_type)
        download = client.get(
            f"/api/v1/reports/{batch['report_batch_id']}/download", headers=headers
        )
        assert download.status_code == 200, f"{report_type}: {download.text}"
        assert download.content.startswith(b"%PDF"), report_type
        assert download.headers["content-type"] == "application/pdf"
        assert report_type.lower().replace(" ", "_") in download.headers["content-disposition"]

        text = pdf_text(download.content)
        assert TRANSCRIPT_MARKER not in text, report_type
        assert DRIVE_MARKER not in text, report_type
        if report_type == REPORT_CLIENT_JOB_REPORT:
            # Client-facing pages carry no internal commentary.
            assert "Internal notes" not in text
            assert "Owner asked about a follow-up visit" not in text
        if report_type == REPORT_STAFF_WORK_REPORT:
            assert "Alex Demo" in text


def test_no_transcript_or_drive_ids_in_frozen_snapshot(client: TestClient) -> None:
    seed_finalised_job(job_sheet_id="21759f5d", completion_id="CMP-288481F1")
    headers = _manager_headers(client)
    batch = run_report_lifecycle(client, headers, REPORT_CLIENT_JOB_REPORT)

    stored = _store().get_report_batch(batch["report_batch_id"])
    assert stored is not None
    snapshot_blob = json.dumps(stored["snapshot"])
    assert TRANSCRIPT_MARKER not in snapshot_blob
    assert DRIVE_MARKER not in snapshot_blob
    assert "ai_transcript" not in snapshot_blob
    assert "drive_file_id" not in snapshot_blob
    assert "recording_drive_file_id" not in snapshot_blob
    # Client audience also drops internal commentary from the frozen data.
    assert "internal_notes" not in snapshot_blob
    assert "Owner asked about a follow-up visit" not in snapshot_blob
    assert stored["snapshot"]["audience"] == "client"


def test_reports_carry_no_automatic_posting_markers(client: TestClient) -> None:
    seed_finalised_job(job_sheet_id="21759f5d", completion_id="CMP-288481F1")
    headers = _manager_headers(client)
    batch = run_report_lifecycle(client, headers, REPORT_CLIENT_JOB_REPORT)
    download = client.get(f"/api/v1/reports/{batch['report_batch_id']}/download", headers=headers)
    assert download.status_code == 200

    text = pdf_text(download.content).lower()
    snapshot_blob = json.dumps(_store().get_report_batch(batch["report_batch_id"])["snapshot"]).lower()
    for marker in POSTING_MARKERS:
        assert marker not in text, f"PDF contains posting marker: {marker}"
        assert marker not in snapshot_blob, f"snapshot contains posting marker: {marker}"
    assert "$" not in text
    # Reports state recorded hours, never a payable amount.
    assert "recorded hours" in text


def test_job_summary_pdf_for_fixture_job(client: TestClient) -> None:
    seeded = seed_finalised_job(job_sheet_id="21759f5d", completion_id="CMP-288481F1")
    assert seeded["completion"]["completion_id"] == "CMP-288481F1"
    manager = _manager_headers(client)

    resp = client.get("/api/v1/jobs/21759f5d/summary.pdf", headers=manager)
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/pdf"
    assert 'filename="nativegrace_job_sheet_summary_21759f5d.pdf"' in (
        resp.headers["content-disposition"]
    )
    pdf = resp.content
    assert pdf.startswith(b"%PDF")
    assert validate_pdf_bytes(pdf) == len(pdf)
    assert resp.headers["x-report-checksum"] == sha256_hex(pdf)
    assert pdf_page_count(pdf) == 1

    text = pdf_text(pdf)
    assert "21759f5d" in text
    assert "CMP-288481F1" in text
    assert "Kat and James Dykes" in text
    assert "Confirm gate access with owner." in text
    assert "Planted seven trees" in text
    assert TRANSCRIPT_MARKER not in text
    assert DRIVE_MARKER not in text

    # Staff may pull a summary for their own job, but not for someone else's.
    staff = _staff_headers(client)
    own = client.get("/api/v1/jobs/21759f5d/summary.pdf", headers=staff)
    assert own.status_code == 200
    seed_finalised_job(
        job_sheet_id="JS-OTHER01", completion_id="CMP-OTHER001", staff_id="STAFF-OTHER"
    )
    other = client.get("/api/v1/jobs/JS-OTHER01/summary.pdf", headers=staff)
    assert other.status_code == 403

    missing = client.get("/api/v1/jobs/JS-DEMO002/summary.pdf", headers=manager)
    assert missing.status_code == 404


def test_multi_page_job_summary(client: TestClient) -> None:
    # Enough labour rows that the table itself must split across pages.
    seed_finalised_job(
        job_sheet_id="21759f5d",
        completion_id="CMP-288481F1",
        labour_rows=60,
        machinery_rows=12,
        material_rows=20,
    )
    headers = _manager_headers(client)
    resp = client.get("/api/v1/jobs/21759f5d/summary.pdf", headers=headers)
    assert resp.status_code == 200, resp.text
    assert pdf_page_count(resp.content) >= 2

    text = pdf_text(resp.content)
    # Repeated table headers appear on every page a table spans.
    assert text.count("Finish") >= 2
    assert "Page 1 of" in text
    assert "Page 2 of" in text


@pytest.mark.skip(
    reason="Minimum charge is a Phase 3E pricing rule; Phase 3F reports print hours, not money."
)
def test_minimum_charge_appears_on_report() -> None:
    raise AssertionError("Not applicable to Phase 3F reporting.")
