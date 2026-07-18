# Phase 1 Implementation Checklist

**Date:** 2026-07-18  
**Scope:** Login, My Jobs, job detail, voice recorder, audio upload, Apps Script process proxy, Docker local stack.

---

## 1. Confirmed Apps Script APIs (available today)

| Surface | Auth | FieldOS use |
|---|---|---|
| `POST` Web App `doPost` → `action: process_voice_dictation` | `webhook_secret` in JSON body | **Yes** — backend proxies after upload / process button |
| `POST` Web App `doPost` → `action: execute_worker` | `webhook_secret` | Ops only (not exposed to browser) |
| `GET` Web App `doGet` (recorder HTML) | None (`ANYONE_ANONYMOUS`) | **No** — conflicting definitions; FieldOS serves its own UI |
| `google.script.run.saveRecording` | Web app session | **No** — not HTTP; FieldOS uploads via FastAPI |
| `appsheetTriggerRoute(...)` | AppSheet task | **No** — leave for AppSheet |

Confirmed recording write columns (`RecorderWebApp.js`):  
`recording_id`, `job_sheet_id`, `recording_file_url`, `recording_drive_file_id`, `recording_name`, `recording_order`, `duration_seconds`, `transcript`, `status`, `created_by`, `created_at`

Confirmed job status columns:  
`job_sheet_id`, `processing_status`, `processing_error`, `processing_started_at`, `processing_completed_at`, `approval_status`

Confirmed staff columns:  
`staff_id`, `staff_name`, `email`, `is_active`, `role`, `quickbooks_time_user_id`

---

## 2. Missing APIs (built in FieldOS FastAPI)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/auth/login` | JWT login |
| `POST` | `/api/v1/auth/logout` | Client-side token drop (stateless MVP) |
| `GET` | `/api/v1/auth/me` | Current staff |
| `GET` | `/api/v1/jobs/mine` | My Jobs (last 7 days default) |
| `GET` | `/api/v1/jobs/{job_sheet_id}` | Job detail + status/errors |
| `GET` | `/api/v1/jobs/{job_sheet_id}/recordings` | List recordings |
| `POST` | `/api/v1/jobs/{job_sheet_id}/recordings` | Upload audio |
| `POST` | `/api/v1/jobs/{job_sheet_id}/process` | Proxy Apps Script enqueue |
| `GET` | `/api/v1/health` | Liveness |
| `GET` | `/api/v1/ready` | Readiness |

**No Apps Script production changes required for Phase 1.**  
Recording save is implemented in FastAPI (local mock files using confirmed `tbl_recordings` column names). Process enqueue uses existing `doPost`.  
See `apps-script-proposed/README.md` — no proposed production patches for Phase 1.

---

## 3. Assumptions and temporary mock data

| Assumption | Detail |
|---|---|
| `DATA_MODE=mock` default for local Docker | File-backed mock store so stack runs without Google credentials |
| Assignment column | `assigned_staff_id` on `tbl_job_sheets` (**not confirmed** in Apps Script export) |
| Job date column | `job_date` (ISO date) for 7-day filter (**assumption**) |
| Display columns | `project_name`, `customer_name` (**assumption**; mock populates them) |
| Auth store | Local JSON with bcrypt hashes — replaceable later |
| Demo user | `alex@nativegrace.com` / see `fieldos/.env.example` |
| Apps Script URL empty in mock | Process returns simulated Success unless `APPS_SCRIPT_WEBAPP_URL` + secret set |
| `DATA_MODE=sheets` | Returns 501 in this Phase 1 local build — Sheets/Drive wiring is a follow-up |

---

## 4. Implementation checklist

### Docs / structure
- [x] This file (`docs/PHASE1_IMPLEMENTATION.md`)
- [x] `fieldos/README.md` local setup
- [x] `fieldos/.env.example`
- [x] `fieldos/docker-compose.yml`
- [x] `apps-script-proposed/README.md` (no production overwrite)

### Backend
- [x] FastAPI app + structured JSON logging
- [x] Config from env (Pydantic Settings)
- [x] Auth: bcrypt + JWT (no plaintext passwords)
- [x] Mock data store (Phase 1 local)
- [x] Jobs mine/detail/recordings
- [x] Recording upload validation (size, MIME, empty reject)
- [x] Apps Script proxy client (secret server-only)
- [x] Health + ready
- [x] Automated tests (`pytest` — 7 passed)

### Frontend
- [x] Mobile-first login
- [x] My Jobs (7-day default, assigned staff only)
- [x] Job detail (status + errors + recordings + process CTA)
- [x] Recorder: MediaRecorder, mic on Record tap, pause/resume/stop/playback/delete/re-record
- [x] Upload progress, localStorage draft until success, retry
- [x] No secrets in frontend

### Validation
- [x] Tests
- [x] Lint (none configured for Phase 1 — N/A)
- [x] Docker build + up
- [x] Health check via Docker
- [x] `docs/PHASE1_VALIDATION.md`

---

*Phase 1 local implementation complete. Do not deploy to AWS yet.*
