# Create Job from Recording

Manager/admin workflow: record or upload audio in FieldOS, review AI-extracted job details, then explicitly create a `tbl_job_sheets` row. Jobs are **never** created automatically from AI output.

## User workflow

1. Jobs page → **New Job from Recording** (manager/admin only).
2. Record with microphone or upload an audio file; play back; replace/delete before submit.
3. FieldOS uploads bytes to Google Drive (apps_script mode) and stores staging metadata locally. **Audio bytes are never sent to Apps Script.**
4. Processing type `new_job_dictation`: Whisper transcript + GPT structured extraction (or mock extractor in `DATA_MODE=mock`).
5. Review form shows transcript, confidence, match status (`Matched` / `Possible match` / `New value` / `Unresolved`), warnings, unresolved items, and editable fields.
6. Manager confirms **Create Job** (checkbox + button). Double-submit protected by mutation lock + idempotency key.
7. Success shows `job_sheet_id` and **Open Job**.

## Extraction schema

```json
{
  "transcript": "...",
  "job": {
    "customer_name": "",
    "project_name": "",
    "job_title": "",
    "job_description": "",
    "scheduled_date": "",
    "scheduled_time": "",
    "assigned_staff_names": [],
    "site_address": "",
    "contact_name": "",
    "contact_phone": "",
    "priority": "",
    "status": "Scheduled",
    "notes": ""
  },
  "confidence": {
    "customer_name": 0.0,
    "project_name": 0.0,
    "scheduled_date": 0.0,
    "assigned_staff_names": 0.0,
    "site_address": 0.0
  },
  "warnings": [],
  "unresolved": [],
  "relative_date_phrases": []
}
```

Rules: extract only clearly stated facts; do not invent customer/project/address/date/staff/contact. Relative dates resolve in `Australia/Sydney` against recording `created_at` (e.g. “next Tuesday” → absolute `YYYY-MM-DD`). Original phrase and resolved date are shown in the UI.

## Master-data matching

Exact → normalised name match → fuzzy **suggestions only**. Fuzzy matches are never silently selected.

## Job sheet persistence

Writable `tbl_job_sheets` fields used on create (header-safe):

- `job_sheet_id` (server `JS-…`)
- `staff_id`
- `date`
- `project_id` (legacy text label / project id string — **not** `customer_name`; that column is API display-only)
- `manager_notes` (title, description, site, contact, notes)
- `processing_status`, `processing_error`, `approval_status`

`customer_name` is **not** written to the sheet.

## Recording link

Optional migration `migrateSchemaForCreateJobFromRecording()` creates:

- `tbl_job_recording_links` — `link_id`, `job_sheet_id`, `recording_id`, `transcript_id`, `created_at`, `created_by`
- `tbl_new_job_from_recording_keys` — idempotency

When Drive file id is present, Apps Script also registers/updates `tbl_recordings` for the new job (metadata only).

## API

| Method | Path | Role |
|---|---|---|
| GET | `/api/v1/jobs/from-recording/masters` | manager/admin |
| POST | `/api/v1/jobs/from-recording/uploads` | manager/admin |
| GET | `/api/v1/jobs/from-recording/{recording_id}` | manager/admin |
| POST | `/api/v1/jobs/from-recording/{recording_id}/process` | manager/admin |
| POST | `/api/v1/jobs/from-recording` | manager/admin |

Create body:

```json
{
  "recording_id": "NJR-…",
  "expected_processing_version": 2,
  "idempotency_key": "…",
  "job": { }
}
```

Idempotency: same key + same payload hash → existing job; same key + different payload → **409**. One active job per recording unless `create_another=true`.

## Status lifecycle

`Uploaded` → `Processing` → `ReviewRequired` → `JobCreated`  
Failures: `TranscriptionFailed`, `ExtractionFailed`, `CreateFailed` (retry process without re-upload).

## Privacy

- No chain-of-thought stored.
- Audit stores actor ids, timestamps, model/provider ids, changed-field list, confidence — not hidden reasoning.
- Staging audio kept under `NEW_JOB_DICTATIONS_DIR` on the API host.

## Deployment

1. Run Apps Script `migrateSchemaForCreateJobFromRecording()`.
2. Add `NewJobFromRecording.js` to the Apps Script project; ensure `FieldOSGateway.js` / `Router.js` include the new actions.
3. Deploy Apps Script web app if required.
4. Set `OPENAI_API_KEY` on the FieldOS API for live transcription/extraction (`DATA_MODE=apps_script`). Mock mode uses a fixed staging transcript.
5. Redeploy FieldOS API + frontend.
6. Do not auto-retry production jobs.

## Staging test plan

Use a clip equivalent to:

> Create a job for Kat and James Dykes at their existing project. Schedule it for next Tuesday. Assign Alex. The job is to inspect the garden beds and prepare a maintenance list. Add a note to check irrigation.

Expect: transcript shown; matching suggestions; absolute date; **no** job until Create Job; recording/transcript linked after create.
