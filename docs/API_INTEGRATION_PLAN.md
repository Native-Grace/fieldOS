# FieldOS API Integration Plan

**Document status:** Design proposal  
**Date:** 2026-07-18  
**Companion docs:** `FIELDOS_ARCHITECTURE.md`, `SYSTEM_ANALYSIS.md`  
**Constraint:** No Apps Script production changes; no implementation code in this document.

**Legend:** **Confirmed** = exists in repo today · **Proposed** = FieldOS must add · **Assumption** = needs live verification

---

## 1. Integration overview

Phase 1 FieldOS uses three integration surfaces:

| Surface | Role |
|---|---|
| **FieldOS FastAPI** (proposed) | Browser-facing authenticated API |
| **Google Sheets / Drive** (confirmed datastore) | Read jobs; write recordings |
| **Apps Script `doPost`** (confirmed) | Optional enqueue of voice processing |

The browser talks **only** to FieldOS. Apps Script secrets never ship to the client.

---

## 2. Existing endpoints (confirmed Apps Script)

Apps Script is **not** a REST API. It exposes a deployed Web App URL with action-based JSON and HTML/RPC helpers.

### 2.1 `POST` Web App — `doPost` (`Router.js`)

**Auth (confirmed):** body field `webhook_secret` must equal Script Property `WEBHOOK_SECRET`.

**Request:**

```json
{
  "action": "process_voice_dictation",
  "job_sheet_id": "JS-XXXXXXXX",
  "user_identity": "tech@example.com",
  "force_reprocess": false,
  "webhook_secret": "<SERVER_ONLY_SECRET>"
}
```

**Supported actions (confirmed):**

| `action` | Behaviour |
|---|---|
| `process_voice_dictation` | Queue job if not already `Completed` (unless `force_reprocess`); trigger worker |
| `execute_worker` | Manually trigger `Queue.triggerWorker()` |

**Success response (confirmed shape from `Utils.createJsonResponse`):**

```json
{
  "status": "Success",
  "action": "process_voice_dictation",
  "message": "Job successfully queued.",
  "record_id": "JS-XXXXXXXX",
  "timestamp": "2026-07-18T12:00:00.000Z"
}
```

**Error response (confirmed):**

```json
{
  "status": "Error",
  "action": "process_voice_dictation",
  "message": "Error: ...",
  "record_id": "JS-XXXXXXXX",
  "timestamp": "2026-07-18T12:00:00.000Z"
}
```

### 2.2 `GET` Web App — `doGet` (confirmed, conflicting)

Multiple `doGet` definitions exist (`Router.js`, `RecorderWebApp.js`, `DailySummaryPdf.js`). Behaviour in production is **ambiguous**.

| Intended params | Purpose |
|---|---|
| `mode=recorder&job_sheet_id=...&user_identity=...` | Router path → `serveRecorder_` |
| `job_sheet_id`, `user_identity`, `return_url` | Recorder template serve |

**FieldOS Phase 1:** do **not** depend on Apps Script `doGet` for the recorder UI.

### 2.3 Client RPC — `saveRecording` (confirmed)

Called from `Recorder.html` via `google.script.run.saveRecording`.

**Request payload (confirmed from HTML):**

```json
{
  "job_sheet_id": "JS-XXXXXXXX",
  "user_identity": "tech@example.com",
  "duration_seconds": 42,
  "audio_base64": "<base64-webm>"
}
```

**Success (RecorderWebApp.js confirmed):**

```json
{
  "status": "Success",
  "message": "Recording saved.",
  "recording_id": "REC-...",
  "recording_file_url": "https://drive.google.com/...",
  "recording_drive_file_id": "...",
  "recording_order": 1
}
```

**Conflict (confirmed):** `Recordert.js` defines an incompatible `saveRecording` (`base64_audio`, returns `{ success: true }`).

**FieldOS Phase 1:** do **not** call `saveRecording`; replace with FastAPI + Drive write.

### 2.4 Native AppSheet task — `appsheetTriggerRoute` (confirmed)

```text
appsheetTriggerRoute(job_sheet_id, user_identity, force_reprocess) → "Success: ..."
```

No `webhook_secret`. Reserved for AppSheet. FieldOS should use HTTP `doPost` instead.

### 2.5 Other callables (confirmed; not FieldOS Phase 1 HTTP APIs)

| Function | Notes |
|---|---|
| `queueProcessAll` | Trigger handler |
| `triggerVoiceProcessing` | Gemini path; schema mismatch risk |
| `runStaffDirectorySync` / `runTaskListSync` | QB Time manual sync |
| `migrateSchemaForManagerApproval` | One-off schema migration |

---

## 3. Missing endpoints (proposed FieldOS FastAPI)

These do **not** exist today. They must be added in FieldOS.

Base URL (proposed): `https://fieldos.<domain>/api/v1`

### 3.1 Auth

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/login` | Exchange credentials for tokens |
| `POST` | `/auth/logout` | Invalidate refresh session |
| `GET` | `/auth/me` | Current staff profile |

### 3.2 Jobs (My Jobs)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/jobs/mine` | List assigned job sheets |
| `GET` | `/jobs/{job_sheet_id}` | Job detail + summary fields |
| `GET` | `/jobs/{job_sheet_id}/recordings` | List recordings for a job |

### 3.3 Recordings

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/jobs/{job_sheet_id}/recordings` | Upload audio + create `tbl_recordings` row |
| `POST` | `/jobs/{job_sheet_id}/process` | Server-side trigger Apps Script `process_voice_dictation` |

### 3.4 Health / ops

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness |
| `GET` | `/ready` | Readiness (Sheets reachable, config present) |

---

## 4. Authentication method

### 4.1 Browser → FieldOS (proposed)

| Item | Design |
|---|---|
| Scheme | `Authorization: Bearer <access_jwt>` |
| Login body | `{ "email": "...", "password": "..." }` (or OTP variant) |
| Identity map | JWT `sub` → `tbl_staff.staff_id` / email |
| Inactive staff | Reject if `is_active` is not TRUE (**confirmed** staff column exists) |

**Login response example (proposed):**

```json
{
  "access_token": "<jwt>",
  "token_type": "bearer",
  "expires_in": 3600,
  "staff": {
    "staff_id": "STAFF-...",
    "staff_name": "Alex Technician",
    "email": "alex@nativegrace.com",
    "role": "Field Staff"
  }
}
```

### 4.2 FieldOS → Apps Script (confirmed + proposed usage)

| Item | Design |
|---|---|
| Scheme | Shared secret in JSON body: `webhook_secret` (**confirmed**) |
| Storage | FieldOS env `APPS_SCRIPT_WEBHOOK_SECRET` (**proposed name**) |
| Browser | Never receives this value |

### 4.3 FieldOS → Google (proposed)

Service account (or equivalent) with Sheets + Drive scopes. Credentials only in server env / mounted secret file.

---

## 5. Request and response examples (proposed FieldOS)

### 5.1 `GET /api/v1/jobs/mine`

**Response 200:**

```json
{
  "items": [
    {
      "job_sheet_id": "JS-ABC123",
      "processing_status": "Queued",
      "approval_status": "",
      "display_title": "Project / site label TBD",
      "updated_at": null
    }
  ]
}
```

`display_title` and filter fields depend on **live sheet headers** (Assumption until exported).

### 5.2 `GET /api/v1/jobs/{job_sheet_id}`

**Response 200:**

```json
{
  "job_sheet_id": "JS-ABC123",
  "processing_status": "Failed",
  "processing_error": "...",
  "approval_status": "Pending Review",
  "recordings_count": 2
}
```

### 5.3 `POST /api/v1/jobs/{job_sheet_id}/recordings`

**Request:** `multipart/form-data`

| Field | Type | Required |
|---|---|---|
| `file` | audio binary (`audio/webm` preferred) | Yes |
| `duration_seconds` | number | No |
| `trigger_processing` | boolean (`true`/`false`) | No (default false or true — decide at impl) |

**Response 201:**

```json
{
  "status": "Success",
  "message": "Recording saved.",
  "recording_id": "REC-1A2B3C4D",
  "recording_file_url": "https://drive.google.com/file/d/.../view",
  "recording_drive_file_id": "1abc...",
  "recording_order": 3,
  "processing_triggered": true,
  "processing_message": "Job successfully queued."
}
```

Shape intentionally mirrors **confirmed** `RecorderWebApp.js` success fields for operational familiarity, plus optional processing flags.

**Partial success (proposed):** recording saved, Apps Script enqueue failed:

```json
{
  "status": "Success",
  "message": "Recording saved.",
  "recording_id": "REC-1A2B3C4D",
  "recording_file_url": "https://drive.google.com/file/d/.../view",
  "recording_drive_file_id": "1abc...",
  "recording_order": 3,
  "processing_triggered": false,
  "processing_message": "Apps Script enqueue failed; recording retained."
}
```

HTTP status still `201` if the durable save succeeded; clients treat `processing_triggered` as advisory.

### 5.4 `POST /api/v1/jobs/{job_sheet_id}/process`

**Request:**

```json
{
  "force_reprocess": false
}
```

**Behaviour (proposed):** FieldOS server calls Apps Script:

```json
{
  "action": "process_voice_dictation",
  "job_sheet_id": "JS-ABC123",
  "user_identity": "<authenticated email>",
  "force_reprocess": false,
  "webhook_secret": "<from env>"
}
```

**Response:** map Apps Script JSON into FieldOS envelope; do not leak secret or raw stack traces to client.

### 5.5 Health

```json
{ "status": "ok", "service": "fieldos-api", "time": "2026-07-18T12:00:00+10:00" }
```

---

## 6. Upload strategy for audio

### 6.1 Rejected as primary FieldOS path

| Strategy | Why not |
|---|---|
| Browser → Apps Script base64 JSON | Confirmed size/fragility limits; duplicate `saveRecording` risk |
| Browser → Apps Script with secret | Would expose or proxy secret incorrectly |

### 6.2 Phase 1 primary (proposed)

```text
Browser MediaRecorder
  → multipart POST FieldOS
  → FastAPI validates auth + MIME + size
  → Google Drive create file in RECORDINGS_FOLDER_ID
  → Sheets append tbl_recordings (RecorderWebApp column set)
  → optional Apps Script doPost enqueue
```

### 6.3 Constraints (proposed)

| Constraint | Value (initial recommendation) |
|---|---|
| Max duration | 10 minutes (tune with field trial) |
| Max upload size | 25 MB Nginx + FastAPI limit |
| MIME | `audio/webm` preferred; accept `audio/mp4` if iOS requires |
| Naming | `JS-{job_sheet_id}-REC-{order}-{yyyyMMdd-HHmmss}.webm` (matches confirmed pattern) |

### 6.4 Later optimisation (out of Phase 1 scope)

Signed URL direct-to-Drive or S3 then reconcile Sheets row.

---

## 7. Job retrieval strategy

### 7.1 Source of truth (confirmed)

`tbl_job_sheets` in Google Sheets via `SPREADSHEET_ID`.

### 7.2 Phase 1 read strategy (proposed)

1. Authenticate staff → resolve `staff_id` / email from `tbl_staff`.
2. Query `tbl_job_sheets` where assignment matches staff.
3. Cache lightly in-memory/TTL optional; default is live Sheets read.
4. Detail view joins `tbl_recordings` by `job_sheet_id`.

### 7.3 Assignment rule — missing information (confirmed gap)

Apps Script export does **not** define which column links a job sheet to a staff member.

**Before implementation, export live headers and AppSheet security filters.** Until then, treat assignment as TBD.

**Candidate patterns (Assumption only):**

- `staff_id` / `assigned_staff_id`
- `technician_email` / `created_by`
- Project membership via `tbl_projects`

### 7.4 Status fields safe to display (confirmed)

`processing_status`, `processing_error`, `processing_started_at`, `processing_completed_at`, `approval_status`

### 7.5 What FieldOS will not compute in Phase 1

AI structuring, line items, materials, photos, daily summaries — tables may exist but Apps Script business logic for them is absent or incomplete in-repo.

---

## 8. Compatibility considerations

### 8.1 Must preserve

| Rule | Reason |
|---|---|
| No rename of `tbl_*` tables/columns | AppSheet + Apps Script compatibility |
| Continue writing recorder-compatible recording rows | Existing AppSheet views |
| Keep using `webhook_secret` for `doPost` | Confirmed contract |
| Leave AppSheet bots/`appsheetTriggerRoute` alone | Parallel UI coexistence |
| Redact secrets in logs | Confirmed good practice in `Router.js` |

### 8.2 Dual UI risks

| Risk | Mitigation |
|---|---|
| AppSheet and FieldOS both save recordings | Shared `recording_order` compute must re-read sheet at write time |
| Both enqueue processing | Rely on confirmed Completed skip + `force_reprocess` |
| Schema conflict transcription columns | FieldOS writes `transcript` + Drive IDs; track Apps Script fix separately |
| `RecordingRepository` bug in Apps Script | FieldOS writes Sheets via its own client, not that repository |

### 8.3 Endpoints FieldOS must not break

FieldOS must not change Apps Script deployment URL contracts used by AppSheet. Any FieldOS→Apps Script calls are additive clients.

### 8.4 Explicit non-endpoints for Phase 1

Do not build FieldOS APIs yet for:

- Materials / equipment / photos / attendance
- Approvals / PDF / daily summaries
- QB Time sync
- Odoo ERP sync

---

## 9. Endpoint inventory summary

| Endpoint | Exists today? | Phase 1 action |
|---|---|---|
| Apps Script `doPost` actions | **Confirmed** | Call from FieldOS server |
| Apps Script `doGet` recorder | **Confirmed (conflicted)** | Do not depend on |
| Apps Script `saveRecording` | **Confirmed (conflicted)** | Replace, do not call |
| `appsheetTriggerRoute` | **Confirmed** | Leave to AppSheet |
| FieldOS auth/jobs/recordings/health | **Missing** | **Must add** |

---

## 10. Acceptance checks for API layer (Phase 1)

1. Browser network tab shows **no** `webhook_secret` or Google credentials.
2. Upload creates Drive file + `tbl_recordings` row visible in AppSheet.
3. Optional process call returns Success/Error mapped from Apps Script without crashing save.
4. Staff A cannot fetch Staff B’s job by ID.
5. `/health` and `/ready` usable by Docker healthchecks.

---

*End of API_INTEGRATION_PLAN.md*
