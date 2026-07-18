"""Job data repository protocol — mock and Apps Script backends."""

from __future__ import annotations

from datetime import date
from typing import Any, Protocol


class JobRepository(Protocol):
    def assumptions(self) -> list[str]: ...

    def list_jobs_for_staff(self, staff_id: str, since: date, days: int) -> list[dict[str, Any]]: ...

    def get_job_for_staff(self, job_sheet_id: str, staff_id: str) -> dict[str, Any]: ...

    def list_recordings(self, job_sheet_id: str, staff_id: str) -> list[dict[str, Any]]: ...

    def create_recording_local(
        self,
        row: dict[str, Any],
        file_bytes: bytes,
        content_type: str,
    ) -> dict[str, Any]: ...

    async def register_recording_remote(
        self,
        job_sheet_id: str,
        staff_id: str,
        staff_email: str,
        file_bytes: bytes,
        content_type: str,
        duration_seconds: float,
        recording_name: str,
    ) -> dict[str, Any]: ...

    async def trigger_process(
        self,
        job_sheet_id: str,
        staff_id: str,
        staff_email: str,
        force_reprocess: bool,
    ) -> dict[str, Any]: ...

    def update_job_status_local(self, job_sheet_id: str, updates: dict[str, Any]) -> None: ...
