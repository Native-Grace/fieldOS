# FieldOS recording management (API contracts)

Do **not** put secrets, Drive file IDs (in mutation UX), transcripts, or webhook values in client logs.

## A. Upload audio file

`POST /api/v1/jobs/{job_sheet_id}/recordings`  
`POST /api/v1/jobs/{job_sheet_id}/recordings/upload` (alias)

Multipart form:

| Field | Required | Notes |
|---|---|---|
| `file` | yes | Supported: webm/wav/mp3/m4a/mp4/ogg/oga/mpeg/mpga/flac |
| `duration_seconds` | no | default `0` |
| `trigger_processing` | no | default `true` on both routes; UI file upload sends `false` |

Auth: `Authorization: Bearer <jwt>` (job must be assigned to staff).

Success `200`:

```json
{
  "status": "Success",
  "message": "Recording saved.",
  "recording_id": "REC-…",
  "recording_file_url": "…",
  "recording_drive_file_id": "…",
  "recording_order": 2,
  "processing_triggered": false,
  "processing_message": "…"
}
```

Errors: `401`, `403`, `422` (unsupported / tiny / oversized / bad filename), `503` (Drive/Apps Script not configured).

Validation rejects **before** Drive upload and `register_recording`.

## B. Mark invalid

`POST /api/v1/jobs/{job_sheet_id}/recordings/{recording_id}/invalidate`

```json
{ "reason": "Marked invalid by user." }
```

Success `200`:

```json
{
  "status": "success",
  "job_sheet_id": "…",
  "recording_id": "…",
  "recording_status": "Invalid",
  "invalid_reason": "…",
  "message": "Recording marked Invalid."
}
```

Blocked with `409` while job `processing_status=Processing`. Idempotent if already Invalid. Apps Script action: `invalidate_recording`.

## C. Delete recording

`DELETE /api/v1/jobs/{job_sheet_id}/recordings/{recording_id}`

Success `200`:

```json
{
  "status": "success",
  "job_sheet_id": "…",
  "recording_id": "…",
  "recording_status": "Deleted",
  "message": "Recording deleted."
}
```

Drive sequence (apps_script): permanent delete → trash fallback on supported permission failures → delete `tbl_recordings` row only after Drive cleanup succeeds. Apps Script action: `delete_recording`.

## Permissions

JWT staff must own the job (assignment column). Manager/admin roles are not separately modelled in Phase 2 — ownership uses the same assignment gate as other job APIs.
