# Apps Script API Contract (FieldOS Phase 2)

**Date:** 2026-07-18  
**Sources:** `apps-script/` inspection + proposed extensions in `apps-script-proposed/`  
**Legend:** **Confirmed** = production export · **Proposed** = Phase 2 addition (not deployed)

---

## 1. Confirmed production `doPost` contract

**Endpoint:** Deployed Apps Script Web App URL (POST JSON).

**Auth:** Body field `webhook_secret` must equal Script Property `WEBHOOK_SECRET`.  
Missing/invalid → Error `"Unauthorized: Invalid or missing webhook_secret."`

### Confirmed actions

| `action` | Required fields | Behaviour |
|---|---|---|
| `process_voice_dictation` | `job_sheet_id` | Queue job (`processing_status=Queued`); skip if `Completed` unless `force_reprocess===true`; `Queue.triggerWorker()` |
| `execute_worker` | — | `Queue.triggerWorker()` only |

### Confirmed response shape (`Utils.createJsonResponse`)

```json
{
  "status": "Success|Error",
  "action": "<action>",
  "message": "<string>",
  "record_id": "<job_sheet_id or null>",
  "timestamp": "<ISO-8601>"
}
```

### Confirmed non-HTTP surfaces (not used by FieldOS HTTP)

| Surface | Notes |
|---|---|
| `saveRecording` | `google.script.run` only; base64 audio |
| `doGet` recorder | Conflicting definitions; FieldOS does not use |
| `appsheetTriggerRoute` | AppSheet task; no webhook secret |

### Confirmed job columns (touched in Apps Script code)

`job_sheet_id`, `processing_status`, `processing_error`, `processing_started_at`, `processing_completed_at`, `approval_status`

### Confirmed recording columns (`RecorderWebApp.js`)

`recording_id`, `job_sheet_id`, `recording_file_url`, `recording_drive_file_id`, `recording_name`, `recording_order`, `duration_seconds`, `transcript`, `status`, `created_by`, `created_at`

### Confirmed live `tbl_job_sheets` headers (Phase 2 env defaults)

`staff_id` (assignment), `date`, `project_id` — plus many AI/approval columns not used by My Jobs yet.

### Not on live job sheet (API display only)

`customer_name` / human `project_name` — resolve later via `tbl_projects` / `tbl_customers` (relationship not fully defined in Apps Script export). Gateway still accepts `customer_column` for forward compatibility.

---

## 2. Missing capabilities (must be proposed)

| Capability | Production today | Phase 2 approach |
|---|---|---|
| List jobs for staff + date window | Missing | Proposed `list_jobs_for_staff` |
| Get job + recordings | Missing as HTTP | Proposed `get_job_detail` |
| HTTP register recording (metadata) | Missing | Proposed `register_recording` (no large audio through Apps Script) |
| Process enqueue | **Confirmed** `process_voice_dictation` | Reuse as-is |

---

## 3. Proposed `doPost` actions (`apps-script-proposed/`)

All require `webhook_secret` (constant-time compare in proposed code).  
Secrets must never appear in responses or sync-log payloads (redact like production Router).

### 3.1 `list_jobs_for_staff`

**Request:**

```json
{
  "action": "list_jobs_for_staff",
  "webhook_secret": "<secret>",
  "staff_id": "STAFF-...",
  "days": 7,
  "assignment_column": "staff_id",
  "date_column": "date",
  "project_column": "project_id",
  "customer_column": "customer_name"
}
```

**Success data payload** (wrapped in FieldOS envelope — see below):

```json
{
  "status": "Success",
  "action": "list_jobs_for_staff",
  "message": "OK",
  "record_id": null,
  "timestamp": "...",
  "data": {
    "jobs": [
      {
        "job_sheet_id": "JS-...",
        "job_date": "2026-07-18",
        "project_name": "PROJ-...",
        "customer_name": "",
        "processing_status": "Queued",
        "approval_status": "",
        "processing_error": "",
        "processing_started_at": null,
        "processing_completed_at": null,
        "assigned_staff_id": "STAFF-..."
      }
    ]
  }
}
```

### 3.2 `get_job_detail`

**Request:**

```json
{
  "action": "get_job_detail",
  "webhook_secret": "<secret>",
  "job_sheet_id": "JS-...",
  "staff_id": "STAFF-...",
  "assignment_column": "staff_id",
  "date_column": "date",
  "project_column": "project_id",
  "customer_column": "customer_name"
}
```

**AuthZ:** Job must exist and `job[assignment_column] === staff_id`, else Error (not found / not authorised).

**Success `data`:** `{ "job": { ... }, "recordings": [ ... ] }` using confirmed recording columns.

### 3.3 `register_recording`

Registers a Drive file already uploaded by FieldOS (avoids large base64 through Apps Script).

```json
{
  "action": "register_recording",
  "webhook_secret": "<secret>",
  "job_sheet_id": "JS-...",
  "staff_id": "STAFF-...",
  "assignment_column": "staff_id",
  "recording_drive_file_id": "...",
  "recording_file_url": "https://drive.google.com/...",
  "recording_name": "JS-...-REC-1-....webm",
  "duration_seconds": 12.5,
  "created_by": "tech@example.com",
  "mime_type": "audio/webm"
}
```

Writes `tbl_recordings` with confirmed RecorderWebApp columns; `status: "Saved"`.

### 3.4 `process_voice_dictation` (confirmed — unchanged)

Used by FieldOS process + optional post-upload trigger.

---

## 4. FieldOS client rules

- Browser never sees `webhook_secret` or Apps Script URL.
- FastAPI sets timeouts (`APPS_SCRIPT_TIMEOUT_SECONDS`).
- Validate `status` field; map Error → 502/400 as appropriate without leaking secrets/stacks.
- `DATA_MODE=mock` never requires Apps Script.
- `DATA_MODE=apps_script` requires URL + secret; jobs/detail/register via proposed actions; process via confirmed action.

---

## 5. Audio upload strategy (Phase 2)

1. FastAPI validates MIME/size (unchanged Phase 1 limits).
2. If `GOOGLE_APPLICATION_CREDENTIALS` + `RECORDINGS_FOLDER_ID` set → upload bytes to Drive from FastAPI, then `register_recording`.
3. Else → reject with clear 503 explaining Drive credentials are required for `apps_script` mode (do **not** send large base64 through Apps Script).

Mock mode continues to write local files only.

---

*End of APPS_SCRIPT_API.md*
