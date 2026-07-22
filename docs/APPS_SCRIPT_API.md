# Apps Script API Contract (FieldOS Phase 2)

**Date:** 2026-07-22  
**Sources:** `apps-script/` (repo) + live verification via FieldOS `DATA_MODE=apps_script`  
**Legend:** **Confirmed** = production / verified · **Proposed** = documented but not required for FieldOS Phase 2 UI

---

## 1. Confirmed production `doPost` contract

**Endpoint:** Deployed Apps Script Web App URL (POST JSON).  
ContentService responses redirect (302) to `script.googleusercontent.com`; FieldOS `httpx` follows redirects.

**Auth:** Body field `webhook_secret` must equal Script Property `WEBHOOK_SECRET`.  
Missing/invalid → Error `"Unauthorized: Invalid or missing webhook_secret."`

### Confirmed actions (FieldOS uses)

| `action` | Required fields | Behaviour |
|---|---|---|
| `list_jobs_for_staff` | `staff_id`, `days`, column names | Jobs for staff in date window |
| `get_job_detail` | `job_sheet_id`, `staff_id`, column names | Job + recordings (assignment check) |
| `register_recording` | job + Drive metadata | Append `tbl_recordings` (`status: Saved`) |
| `process_voice_dictation` | `job_sheet_id` | Queue job (`processing_status=Queued`); skip if `Completed` unless `force_reprocess===true`; `Queue.triggerWorker()` |
| `execute_worker` | — | `Queue.triggerWorker()` only (not used by FieldOS UI) |

### Confirmed response shape (`Utils.createJsonResponse`)

```json
{
  "status": "Success|Error",
  "action": "<action>",
  "message": "<string>",
  "record_id": "<job_sheet_id or null>",
  "timestamp": "<ISO-8601>",
  "data": {}
}
```

FieldOS gateway actions include a `data` object (jobs list, job+recordings, or registered recording fields).

### Confirmed non-HTTP surfaces (not used by FieldOS HTTP)

| Surface | Notes |
|---|---|
| `saveRecording` | `google.script.run` only; base64 audio |
| `doGet` recorder | Conflicting definitions; FieldOS does not use (see `apps-script-proposed/DOGET_MERGE_PROPOSAL.md`) |
| `appsheetTriggerRoute` | AppSheet task; no webhook secret |

### Confirmed job columns (touched in Apps Script / live sheet)

`job_sheet_id`, `processing_status`, `processing_error`, `processing_started_at`, `processing_completed_at`, `approval_status`

### Confirmed live `tbl_job_sheets` headers (FieldOS env defaults)

| Role | Header |
|---|---|
| Assignment | `staff_id` |
| Date | `date` |
| Project | `project_id` |

`customer_name` is **not** on the live job sheet. FieldOSGateway resolves display names via `FieldOSDisplayLookup.js`:

`job.project_id` → `tbl_projects.project_id` → optional `customer_id` → `tbl_customers`

Assumed display columns (confirm against live headers before relying on enrichment): `project_name` / `customer_name` (fallback `name`). Missing rows degrade without failing the job list. When `project_id` does not match a project row, the raw sheet value is kept as `project_name` (observed live for some jobs).

**Smoke test staff ID:** `STAFF-9012C021` (local demo account mapping).

### Confirmed recording columns (`tbl_recordings` / RecorderWebApp shape)

`recording_id`, `job_sheet_id`, `recording_file_url`, `recording_drive_file_id`, `recording_name`, `recording_order`, `duration_seconds`, `transcript`, `status`, `created_by`, `created_at`

---

## 2. Audio upload strategy (Phase 2)

1. FastAPI validates MIME/size (Phase 1 limits).
2. Upload bytes to Shared Drive from FastAPI (`RECORDINGS_FOLDER_ID` + service account).
3. Call `register_recording` with Drive file id + URL metadata only (no large base64 through Apps Script).
4. On register failure, best-effort orphan cleanup (delete, then trash fallback on Shared Drive).

### Drive client requirements

| Item | Requirement |
|---|---|
| Scope | `https://www.googleapis.com/auth/drive` |
| Shared Drive | Yes — service accounts have no personal My Drive quota for this path |
| Flags | `supportsAllDrives=True` on get/create/delete/trash |
| Mount | `fieldos/secrets/service-account.json` → `/app/secrets/service-account.json` |
| Secrets | Never commit credentials |

Mock mode continues to write local files only.

---

## 3. Request examples

### 3.1 `list_jobs_for_staff`

```json
{
  "action": "list_jobs_for_staff",
  "webhook_secret": "<secret>",
  "staff_id": "STAFF-9012C021",
  "days": 7,
  "assignment_column": "staff_id",
  "date_column": "date",
  "project_column": "project_id",
  "customer_column": "customer_name"
}
```

### 3.2 `get_job_detail`

```json
{
  "action": "get_job_detail",
  "webhook_secret": "<secret>",
  "job_sheet_id": "21759f5d",
  "staff_id": "STAFF-9012C021",
  "assignment_column": "staff_id",
  "date_column": "date",
  "project_column": "project_id",
  "customer_column": "customer_name"
}
```

**AuthZ:** Job must exist and `job[assignment_column] === staff_id`.

### 3.3 `register_recording`

```json
{
  "action": "register_recording",
  "webhook_secret": "<secret>",
  "job_sheet_id": "21759f5d",
  "staff_id": "STAFF-9012C021",
  "assignment_column": "staff_id",
  "recording_drive_file_id": "<drive-file-id>",
  "recording_file_url": "<drive-view-url>",
  "recording_name": "21759f5d-REC-....webm",
  "duration_seconds": 12.5,
  "created_by": "tech@example.com",
  "mime_type": "audio/webm"
}
```

### 3.4 `process_voice_dictation` (confirmed)

Used by FieldOS `POST /api/v1/jobs/{id}/process` and optional post-upload trigger.

---

## 4. FieldOS client rules

- Browser never sees `webhook_secret` or Apps Script URL.
- FastAPI sets timeouts (`APPS_SCRIPT_TIMEOUT_SECONDS`).
- Validate `status` field; map Error → HTTP without leaking secrets/stacks.
- Follow ContentService redirects (`follow_redirects=True`).
- `DATA_MODE=mock` never requires Apps Script.
- `DATA_MODE=apps_script` requires URL + secret + Drive credentials for recordings.

---

## 5. Manual smoke helpers (Apps Script editor only)

| Helper | Location | Notes |
|---|---|---|
| `testFieldOSListJobs()` | `apps-script/FieldOSGateway.js` | Replace `staff_id` before Run; does not deploy; do not run `fieldosRouteRequest` from the Run menu without a payload |
| `testDoPost()` | `apps-script/Router.js` | Existing process_voice mock; replace job id |
| Display lookup unit tests | `apps-script/tests/display_lookup.test.mjs` | `node --test apps-script/tests/display_lookup.test.mjs` |

These are safe, documented editor/helpers — not production HTTP entry points beyond the gateway actions.

---

## 6. Known issues / future work

| Item | Notes |
|---|---|
| Live project/customer headers | Confirm `tbl_projects` / `tbl_customers` column names in the spreadsheet |
| `doGet` recorder conflict | **Deferred** — Phase 2 requires **doPost only**. Proposal: `apps-script-proposed/DOGET_MERGE_PROPOSAL.md`. Do not merge into production Router as part of Phase 2. |

---

*End of APPS_SCRIPT_API.md*
