# Daily Work Job Sheet from Recordings

Completed-work workflow for Native Grace FieldOS. Staff/managers add multiple voice
recordings through a workday, review AI extraction, then explicitly create **one**
completed job sheet.

## Difference from Create Job from Recording

| | **New Job from Recording** | **Daily Work Job Sheet** |
|---|---|---|
| Purpose | Future / scheduled work | Work already completed |
| Processing type | `new_job_dictation` | `daily_work_dictation` |
| Recordings | One | Many (session) |
| Prompt | Future-tense job fields | Past-tense completed work |
| UI | `/jobs/new-from-recording` | `/jobs/daily-work` |
| API | `/api/v1/jobs/from-recording/*` | `/api/v1/daily-work-sessions/*` |
| Apps Script | `create_job_sheet_from_recording` | `create_completed_job_sheet_from_recordings` |
| Auto-create job? | Never | Never — review required |

Do not merge the extraction prompts or UI wizards. Shared utilities (Drive upload,
Whisper, multipart validation) are fine; shared business meaning is not.

## Storage ownership

**FastAPI owns staging state:**

- Session JSON under `DAILY_WORK_SESSIONS_DIR` (default `./data/daily_work_sessions`)
- Audio files under `{dir}/audio`
- Per-recording transcripts, aggregated transcript, extraction JSON, version, audit

**Sheets / Apps Script on create only:**

- One `tbl_job_sheets` row (create-safe columns only)
- One `tbl_job_recording_links` row per recording (`work_session_id`, `sequence` when migrated)
- Optional metadata row in `tbl_daily_work_sessions`
- Idempotency row in `tbl_daily_work_create_keys`

Audio bytes never pass through Apps Script.

## Session lifecycle

Statuses: `Recording` → `Processing` → `ReviewRequired` → `JobCreated`

Failures: `TranscriptionFailed`, `ExtractionFailed`, `CreateFailed`

Sessions persist across refresh, browser close, and resume later the same day.

## Multi-recording pipeline

1. Create session (`POST /daily-work-sessions`)
2. Add recordings anytime (`POST .../recordings`) — browser or file upload via FastAPI → Drive
3. Transcribe each recording independently (`.../process` or `.../process-all`)
4. Aggregate with markers — never merge unmarked text:

```
[08:12 — Recording 1]
...
[10:46 — Recording 2]
```

5. Extract completed-work JSON (`POST .../extract`) — **does not create a job**
6. Human review / edit / move completed ↔ follow-up
7. Explicit create (`POST .../create-job-sheet`)

## Extraction schema (summary)

```json
{
  "work_session_id": "DWS-...",
  "work_date": "2026-08-01",
  "aggregated_transcript": "...",
  "recordings": [{ "recording_id": "...", "recorded_at": "...", "transcript": "..." }],
  "job_sheet": {
    "customer_name": "",
    "project_name": "",
    "project_id": "",
    "work_date": "",
    "staff_ids": [],
    "staff_names": [],
    "work_completed": [{ "text": "", "recording_ids": [] }],
    "materials_used": [],
    "equipment_used": [],
    "hours_or_times": [],
    "site_conditions": [],
    "issues_found": [],
    "client_requests": [],
    "follow_up_required": [],
    "safety_notes": [],
    "manager_notes": "",
    "completion_summary": ""
  },
  "confidence": {},
  "warnings": [],
  "unresolved": [],
  "source_map": {}
}
```

Rules: past-tense completed work only; future needs → `follow_up_required`; client asks →
`client_requests` (+ follow-up if action needed); do not invent facts; contradictions →
warnings + retain both statements.

## `tbl_job_sheets` mapping (create-safe)

| Column | Value |
|---|---|
| `job_sheet_id` | Server-generated |
| `staff_id` | Primary staff from reviewed sheet |
| `date` | `work_date` |
| `project_id` | Selected project id or legacy project text |
| `manager_notes` | Deterministic completed-work report |
| `processing_status` | `Completed` |
| `processing_error` | blank |
| `approval_status` | Existing policy (typically `Pending Review`) |

Do **not** write `customer_name` (API display-only). Do not invent unsupported columns.

### `manager_notes` format

```
WORK COMPLETED
- ...

MATERIALS USED
- ...

ISSUES FOUND
- ...

CLIENT REQUESTS
- ...

FOLLOW-UP REQUIRED
- ...

SAFETY / SITE NOTES
- ...

SUMMARY
...
```

## API routes

- `POST   /api/v1/daily-work-sessions`
- `GET    /api/v1/daily-work-sessions`
- `GET    /api/v1/daily-work-sessions/masters`
- `GET    /api/v1/daily-work-sessions/{id}`
- `PATCH  /api/v1/daily-work-sessions/{id}`
- `POST   /api/v1/daily-work-sessions/{id}/recordings` (multipart)
- `DELETE /api/v1/daily-work-sessions/{id}/recordings/{recording_id}`
- `GET    /api/v1/daily-work-sessions/{id}/recordings/{recording_id}/audio`
- `POST   /api/v1/daily-work-sessions/{id}/recordings/{recording_id}/process`
- `POST   /api/v1/daily-work-sessions/{id}/process-all`
- `POST   /api/v1/daily-work-sessions/{id}/extract`
- `POST   /api/v1/daily-work-sessions/{id}/create-job-sheet`

Create body:

```json
{
  "expected_session_version": 1,
  "reviewed_job_sheet": { },
  "idempotency_key": "..."
}
```

## Idempotency

- Same key + same reviewed payload → same job
- Same key + different payload → `409`
- One work session → one active job sheet
- After `JobCreated`, adding recordings requires an explicit amendment workflow (blocked with `409`)
- Never silently modify a completed job after creation

## Roles

- Staff: create/own sessions, add recordings, submit reviewed sheet (`Pending Review`)
- Manager/admin: same + broader session visibility
- Staff cannot create sessions on behalf of unrelated staff unless manager/admin

## Failure recovery

- Retry one failed transcription without re-running successes
- Re-extract without creating a job
- `CreateFailed` leaves session open for retry with a new idempotency key (if no job id stored)

## Migration

Run Apps Script `migrateSchemaForDailyWorkSessions()`:

- Creates `tbl_daily_work_sessions`
- Creates `tbl_daily_work_create_keys`
- Adds `work_session_id` / `sequence` on `tbl_job_recording_links` when missing

Does **not** alter `tbl_job_sheets` headers.

## Deployment steps

1. Deploy FastAPI with `DAILY_WORK_SESSIONS_DIR` (and optional `OPENAI_API_KEY` for live Whisper/extract)
2. Add `DailyWorkJobSheet.js` to the Apps Script project
3. Ensure `FieldOSGateway.js` / `Router.js` include `create_completed_job_sheet_from_recordings`
4. Run `migrateSchemaForDailyWorkSessions()`
5. Deploy frontend route `/jobs/daily-work`
6. Smoke: session for Kat and James Dykes with three sample recordings; confirm review classification; confirm no job until Create
