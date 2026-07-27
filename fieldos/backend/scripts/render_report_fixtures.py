#!/usr/bin/env python3
"""Render Phase 3F fixture PDFs for visual QA (not production output).

Writes under fieldos/backend/tests/artifacts/reports/ — keep out of production.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))
sys.path.insert(0, str(ROOT))

from app.services.pdf_reports import render_report  # noqa: E402
from app.services.report_math import (  # noqa: E402
    REPORT_CLIENT_JOB_REPORT,
    REPORT_COMPLETION_REGISTER,
    REPORT_JOB_SHEET_SUMMARY,
    REPORT_STAFF_WORK_REPORT,
    TEMPLATE_VERSION,
)


def _meta(report_type: str, *, landscape: bool = False) -> dict:
    return {
        "report_type": report_type,
        "report_title": report_type,
        "generated_at": "2026-07-26T12:00:00+10:00",
        "generated_by": "fixture@nativegrace.com",
        "internal_ref": "RPT-FIXTURE",
        "template_version": TEMPLATE_VERSION,
        "audience": "client" if report_type == REPORT_CLIENT_JOB_REPORT else "internal",
        "landscape": landscape,
    }


def _bundle(job_sheet_id: str, *, long_notes: bool = False) -> dict:
    note = ("Long labour note. " * 40) if long_notes else "Site tidy"
    return {
        "job": {
            "job_sheet_id": job_sheet_id,
            "job_date": "2026-07-16",
            "customer_name": "Kat and James Dykes",
            "project_name": "Dykes Garden Stage 2",
            "approval_status": "Approved",
            "assigned_staff_id": "STAFF-9012C021",
        },
        "completion": {
            "completion_id": "CMP-288481F1",
            "completion_status": "Finalised",
            "work_summary": "Planted seven trees along the northern boundary.",
            "invoice_description": "Supply and plant seven trees.",
            "finalised_by": "manager@nativegrace.com",
            "finalised_at": "2026-07-26T10:25:20.645Z",
            "total_labour_hours": 7.5,
            "total_travel_hours": 0.5,
            "total_machinery_hours": 1.5,
            "billable_labour_hours": 0,
            "non_billable_labour_hours": 7.5,
        },
        "labour_entries": [
            {
                "staff_name": "Alex",
                "staff_id": "STAFF-9012C021",
                "work_date": "2026-07-16",
                "start_time": "09:18",
                "finish_time": "17:18",
                "break_minutes": 30,
                "labour_hours": 7.5,
                "travel_hours": 0.5,
                "role_or_activity": "Planting",
                "billable": False,
                "confirmation_status": "Confirmed",
                "notes": note,
            }
        ],
        "machinery_entries": [
            {
                "equipment_name": "Excavator",
                "operator_staff_id": "STAFF-9012C021",
                "duration_hours": 1.5,
                "billable": True,
                "charge_code": "EX-01",
                "notes": "",
            }
        ],
        "material_entries": [
            {
                "item_name": "Tree stock",
                "item_code": "TREE-01",
                "quantity": 7,
                "unit": "each",
                "billable": True,
                "notes": "",
            }
        ],
        "task_lines": [
            {"source": "Manager review", "text": "Confirm gate access with owner."},
            {"source": "Variation", "text": "Driveway reshape"},
        ],
        "recording_summary": {"count": 2, "processed": 2},
        "readiness": {"invoice_ready": False, "payroll_ready": True},
    }


def main() -> None:
    out = ROOT / "tests" / "artifacts" / "reports"
    out.mkdir(parents=True, exist_ok=True)

    fixtures = [
        (
            "one_page_job_summary.pdf",
            REPORT_JOB_SHEET_SUMMARY,
            {"bundles": [_bundle("21759f5d")], **_bundle("21759f5d")},
            False,
        ),
        (
            "multi_page_job_summary.pdf",
            REPORT_JOB_SHEET_SUMMARY,
            {
                "bundles": [
                    {
                        **_bundle("21759f5d", long_notes=True),
                        "labour_entries": [
                            {
                                **_bundle("21759f5d", long_notes=True)["labour_entries"][0],
                                "staff_id": f"STAFF-{i:03d}",
                                "staff_name": f"Worker {i}",
                                "notes": ("Wrap-friendly labour note paragraph. " * 12),
                            }
                            for i in range(40)
                        ],
                    }
                ]
            },
            False,
        ),
        (
            "staff_work_report.pdf",
            REPORT_STAFF_WORK_REPORT,
            {
                "groups": [
                    {
                        "key": "STAFF-9012C021",
                        "label": "STAFF-9012C021",
                        "bundles": [_bundle("21759f5d"), _bundle("job-b")],
                    }
                ]
            },
            False,
        ),
        (
            "client_job_report.pdf",
            REPORT_CLIENT_JOB_REPORT,
            {
                "groups": [
                    {
                        "key": "Kat and James Dykes",
                        "label": "Kat and James Dykes",
                        "bundles": [_bundle("21759f5d"), _bundle("job-c")],
                    }
                ]
            },
            False,
        ),
        (
            "landscape_completion_register.pdf",
            REPORT_COMPLETION_REGISTER,
            {
                "rows": [
                    {
                        "job_date": "2026-07-16",
                        "job_sheet_id": "21759f5d",
                        "customer_name": "Kat and James Dykes",
                        "project_name": "Dykes Garden Stage 2",
                        "completion_status": "Finalised",
                        "approval_status": "Approved",
                        "labour_hours": 7.5,
                        "warning_count": 0,
                        "invoice_ready": False,
                        "payroll_ready": True,
                    }
                    for _ in range(12)
                ]
            },
            True,
        ),
    ]

    for name, report_type, data, landscape in fixtures:
        pdf = render_report(report_type, data, _meta(report_type, landscape=landscape))
        path = out / name
        path.write_bytes(pdf)
        assert pdf.startswith(b"%PDF"), name
        print(f"wrote {path} ({len(pdf)} bytes)")


if __name__ == "__main__":
    main()
