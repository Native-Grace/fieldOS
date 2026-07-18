# Native Grace FieldOS — Production Architecture (Phase 1)

**Document status:** Design proposal  
**Date:** 2026-07-18  
**Inputs:** `SYSTEM_ANALYSIS.md`, repository layout, `README.md`  
**Constraint:** No Apps Script production files are modified by this design. No deployment or implementation code in this document.

**Legend**

- **Confirmed:** Evidenced by repository / `SYSTEM_ANALYSIS.md`.
- **Proposed:** FieldOS design decisions for first production architecture.
- **Assumption:** Required for design but not verified in-repo (e.g. live AppSheet config, Odoo host paths).

---

## 1. Purpose

FieldOS is a custom field operations application that will eventually replace AppSheet as the primary field UI, while remaining compatible with the existing Google Sheets + Apps Script backend during migration.

**Phase 1 goal (proposed):** ship a mobile-friendly web app with:

1. **My Jobs** — list and open assigned job sheets.
2. **Voice recorder** — capture and upload voice notes against a job sheet.

During Phase 1, Google Sheets remains the system of record, Apps Script continues processing, and AppSheet workflows continue unchanged.

---

## 2. Confirmed current system vs proposed FieldOS

| Layer | Confirmed today | Proposed FieldOS Phase 1 |
|---|---|---|
| Field UI | AppSheet (README; not in repo) + Apps Script `Recorder.html` | FieldOS mobile web app (My Jobs + recorder) |
| API | Apps Script web app `doPost` / `doGet` / `google.script.run.saveRecording` | FastAPI behind Nginx subdomain; server-side calls to Apps Script / Sheets |
| Datastore | Google Sheets (`tbl_*`) | Same Sheets tables/columns (no renames) |
| Business logic | Apps Script (partial; pipeline gaps noted in analysis) | Apps Script remains authoritative for enqueue/processing |
| Hosting | Google Apps Script web app (`ANYONE_ANONYMOUS`) | AWS host shared with Odoo; FieldOS isolated via Docker Compose |
| Secrets | Script Properties | Env vars in FieldOS only; never sent to browser |

---

## 3. System diagram

### 3.1 Phase 1 coexistence (proposed)

```text
                    ┌─────────────────────────────┐
                    │  Field staff (mobile browser)│
                    └──────────────┬──────────────┘
                                   │ HTTPS
                                   ▼
                    ┌─────────────────────────────┐
                    │  Nginx (fieldos.<domain>)   │  Proposed
                    │  TLS termination            │
                    └──────┬──────────────┬───────┘
                           │              │
              /api/*       │              │  /*
                           ▼              ▼
              ┌────────────────┐   ┌─────────────────┐
              │ FieldOS API    │   │ FieldOS Frontend│  Proposed
              │ (FastAPI)      │   │ (static SPA)    │
              └───────┬────────┘   └─────────────────┘
                      │
         server-only  │  (WEBHOOK_SECRET, Google creds stay here)
                      │
        ┌─────────────┼──────────────────────────┐
        │             │                          │
        ▼             ▼                          ▼
┌───────────────┐ ┌────────────────┐   ┌──────────────────┐
│ Apps Script   │ │ Google Sheets  │   │ Google Drive     │
│ doPost /      │ │ tbl_job_sheets │   │ recordings folder│
│ saveRecording │ │ tbl_recordings │   │                  │
│ (confirmed)   │ │ tbl_staff ...  │   │                  │
└───────┬───────┘ └───────▲────────┘   └────────▲─────────┘
        │                 │                     │
        └─────────────────┴─────────────────────┘
                  existing production path

┌──────────────────────────────────────────────────────────┐
│ AppSheet (confirmed as current UI per README)            │
│ Continues reading/writing same Sheets; unchanged bots    │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ Same AWS EC2/host                                        │
│  ├── Odoo (native install) — DO NOT MODIFY  (Assumption) │
│  └── /opt/nativegrace-fieldos/ — Docker Compose (Proposed)│
└──────────────────────────────────────────────────────────┘
```

### 3.2 What FieldOS does and does not own in Phase 1

| Owns (proposed) | Does not own (confirmed remains elsewhere) |
|---|---|
| Auth for FieldOS users | AppSheet auth |
| My Jobs UI + recorder UI | AI transcription pipeline (`VoiceProcessingService` / missing `executePipeline`) |
| Audio upload orchestration | Queue worker (`Queue.js`) |
| Thin read adapters over Sheets | QB Time sync (`QuickBooksTime.js`) |
| Nginx + Docker lifecycle | Odoo |

---

## 4. Frontend architecture (proposed)

### 4.1 Goals

- Mobile-first progressive web experience (phone browsers in the field).
- Fast first paint for My Jobs and one-tap record.
- Works on intermittent connectivity where practical (optimistic UI + retry for uploads).

### 4.2 Stack (proposed)

| Choice | Rationale |
|---|---|
| SPA (React or Vue — decide at implementation) | Clear API boundary; easy to host as static assets |
| Mobile-first CSS | Field use on phones |
| Served by Nginx as static files | Same Compose stack as API |
| Talks only to FieldOS `/api/*` | Never holds Apps Script `WEBHOOK_SECRET`, Google keys, or Drive tokens |

### 4.3 Screens (Phase 1)

| Screen | Purpose |
|---|---|
| Login | Authenticate field staff |
| My Jobs | List job sheets assigned to the signed-in staff member |
| Job detail | Show job summary + recordings list + CTA to record |
| Recorder | Capture WebM (or equivalent) audio, upload, show save status |
| Error / offline notice | Clear failure states for upload and auth |

### 4.4 Recorder UX reuse (confirmed → proposed)

**Confirmed:** `apps-script/Recorder.html` implements MediaRecorder (`audio/webm`), timer, base64 encode, and `google.script.run.saveRecording`.

**Proposed:** FieldOS recorder reuses the same capture pattern (MediaRecorder → blob → upload) but posts to FieldOS API multipart/binary upload instead of Apps Script base64 RPC, to avoid Apps Script payload size limits.

### 4.5 Frontend ↔ backend contract

Frontend never calls Apps Script or Google APIs directly. All integration is via FieldOS FastAPI.

---

## 5. Backend architecture (proposed)

### 5.1 Stack

| Component | Choice |
|---|---|
| Language | Python 3.12+ |
| Framework | FastAPI |
| ASGI server | Uvicorn (or Gunicorn+Uvicorn workers) |
| Config | Pydantic Settings from environment variables |
| HTTP client | `httpx` for Apps Script webhook calls |
| Google access | Service account or OAuth (server-side only) for Sheets/Drive |
| Logging | Structured JSON logs to stdout → Docker log driver / files under FieldOS log dir |

### 5.2 Logical modules

```text
fieldos/backend/
  app/
    main.py                 # FastAPI app, health routes
    api/                    # route modules
      auth.py
      jobs.py
      recordings.py
      health.py
    services/
      sheets_client.py      # read/write tbl_* (no column renames)
      drive_client.py       # upload audio files
      apps_script_client.py # server-side doPost with webhook secret
      auth_service.py
    models/                 # Pydantic schemas (API shapes)
    core/
      config.py
      security.py
      logging.py
  tests/
```

### 5.3 Responsibilities by layer

| Layer | Responsibility |
|---|---|
| API routes | Auth, validation, HTTP status codes |
| Services | Sheets/Drive/Apps Script orchestration |
| Clients | Idempotent external I/O with timeouts/retries |
| Config | Env-only secrets |

### 5.4 Phase 1 write path for recordings (proposed)

1. Client uploads audio to `POST /api/v1/recordings`.
2. Backend validates job ownership / assignment.
3. Backend writes file to Google Drive recordings folder (**confirmed concept:** `RECORDINGS_FOLDER_ID` in Apps Script).
4. Backend appends row to `tbl_recordings` using **existing column names** preferred by the working recorder path:
   - Prefer columns written by `RecorderWebApp.js` (`recording_file_url`, `recording_drive_file_id`, `transcript`, `status: Saved`, …).
5. Backend optionally triggers processing via Apps Script `doPost` `action: process_voice_dictation` (**confirmed action**), using server-held `WEBHOOK_SECRET`.
6. Backend writes a sync-style audit entry to `tbl_sync_logs` with `target_system: FieldOS_API` (**proposed extension** of confirmed sync-log pattern; column names unchanged).

### 5.5 Phase 1 read path for My Jobs (proposed)

1. Authenticated staff identity maps to `tbl_staff` (`email` / `staff_id`) — **confirmed columns exist**.
2. Backend queries `tbl_job_sheets` filtered by assignment field(s).
3. **Gap (confirmed missing info):** assignment column name(s) for “my jobs” are not defined in Apps Script export. Must be discovered from live sheet/AppSheet before implementation (candidates often include staff FK / email / created_by — **Assumption until verified**).

---

## 6. Authentication (proposed)

### 6.1 Goals

- Field staff authenticate to FieldOS without exposing Apps Script secrets.
- AppSheet continues its own auth independently.
- Odoo users/passwords are **not** required for Phase 1 (**Assumption:** separate identity until later SSO decision).

### 6.2 Phase 1 approach (proposed)

| Item | Design |
|---|---|
| Method | Email + password or magic-link OTP (choose one at implementation) |
| Session | Short-lived JWT (access) + optional refresh cookie (`HttpOnly`, `Secure`, `SameSite`) |
| Staff source of truth | `tbl_staff` for identity mapping (`email`, `staff_id`, `is_active`, `role`) |
| Password store | FieldOS-managed credential table **or** hashed secrets file/DB local to FieldOS — **not** Google Sheets |
| Authorization | Staff can only read/write job sheets assigned to them; managers later |

### 6.3 What must never reach the browser

| Secret | Confirmed location today | FieldOS rule |
|---|---|---|
| `WEBHOOK_SECRET` | Apps Script Script Properties | Server env only |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` | Script Properties | Not used by Phase 1 frontend; remain Apps Script or future server env |
| `QB_TIME_ACCESS_TOKEN` | Script Properties | Not used by Phase 1 UI |
| Google service account JSON | N/A in repo | Server env / mounted secret file only |
| `SPREADSHEET_ID` | Script Properties | Server env only |

### 6.4 Contrast with confirmed Apps Script auth

**Confirmed:** Apps Script web app is `ANYONE_ANONYMOUS`; `doPost` checks `webhook_secret` in body; recorder `saveRecording` has no webhook secret.

**Proposed:** FieldOS closes that gap for the new UI by requiring user auth on all job/recording endpoints. Apps Script anonymous surface remains for AppSheet compatibility until later phases harden or retire it.

---

## 7. Voice recording flow

### 7.1 Confirmed Apps Script flow (baseline)

1. Open recorder HTML with `job_sheet_id`, `user_identity`, optional `return_url`.
2. Browser records WebM via MediaRecorder.
3. Client base64-encodes audio and calls `saveRecording`.
4. Server saves to Drive + inserts `tbl_recordings` (`status: Saved`).
5. Separately, AppSheet/automation may call `process_voice_dictation` or `appsheetTriggerRoute` / `triggerVoiceProcessing`.

**Confirmed risks:** duplicate `doGet`/`saveRecording`, `RecordingRepository` constructor bug, recorder↔Gemini column mismatch (`transcript` vs `transcription`).

### 7.2 Proposed FieldOS flow (Phase 1)

```text
[FieldOS Recorder UI]
   MediaRecorder (webm)
        │
        │ multipart/form-data (binary)
        ▼
[FastAPI POST /api/v1/jobs/{job_sheet_id}/recordings]
   authn + authz
   upload to Drive (RECORDINGS_FOLDER_ID)
   insert tbl_recordings (existing columns)
   append tbl_sync_logs (FieldOS_API)
   optional: POST Apps Script doPost process_voice_dictation
        │
        ▼
[Apps Script Queue / VoiceProcessing]  ← unchanged production code
```

### 7.3 Upload strategy summary

| Approach | Status |
|---|---|
| Base64 inside JSON to Apps Script | Confirmed existing; avoid for FieldOS primary path |
| Multipart upload to FastAPI → Drive | **Proposed** Phase 1 primary |
| Direct browser → Drive signed URL | Possible later optimisation; not required for Phase 1 |

---

## 8. My Jobs flow (proposed)

```text
[Login] → JWT
   │
   ▼
[GET /api/v1/jobs/mine]
   resolve staff from token → tbl_staff
   query tbl_job_sheets by assignment rule (TBD from live schema)
   return list DTO (job_sheet_id, status fields, display fields)
   │
   ▼
[Job detail GET /api/v1/jobs/{job_sheet_id}]
   include recordings from tbl_recordings
   CTA → Recorder screen
```

**Display fields (proposed mapping from confirmed columns where known):**

- `job_sheet_id`
- `processing_status`
- `approval_status` (if present)
- plus live-sheet display columns once exported (customer/project/date — **Assumption**)

---

## 9. Data model

### 9.1 Compatibility rule (hard requirement)

- **Do not rename** existing Google Sheet tables or columns.
- FieldOS may add **new tables** only if required for FieldOS-only concerns (e.g. auth credentials). Prefer not adding Sheets columns in Phase 1 unless unavoidable and coordinated with AppSheet.

### 9.2 Confirmed tables FieldOS Phase 1 will use

| Table | Phase 1 use |
|---|---|
| `tbl_job_sheets` | My Jobs list/detail; queue status display |
| `tbl_recordings` | Create/list recordings |
| `tbl_staff` | Map login identity |
| `tbl_sync_logs` | Audit FieldOS actions |

### 9.3 Confirmed recording columns to prefer (RecorderWebApp path)

`recording_id`, `job_sheet_id`, `recording_file_url`, `recording_drive_file_id`, `recording_name`, `recording_order`, `duration_seconds`, `transcript`, `status`, `created_by`, `created_at`

### 9.4 Confirmed job sheet columns FieldOS may show

`job_sheet_id`, `processing_status`, `processing_error`, `processing_started_at`, `processing_completed_at`, `approval_status`

### 9.5 Declared-only tables (later phases)

`tbl_customers`, `tbl_projects`, `tbl_job_sheet_lines`, `tbl_materials`, `tbl_equipment`, `tbl_follow_ups`, `tbl_photos`, `tbl_daily_job_summaries`, `tbl_tasks`, `tbl_ai_audit`

### 9.6 Known schema conflict (confirmed) — design stance

VoiceProcessing expects `transcription` / `audio_file|file_path`. Recorder writes `transcript` / Drive IDs.

**Proposed Phase 1 stance:** FieldOS writes the **RecorderWebApp** column set so AppSheet + existing recorder rows stay consistent. Fixing Gemini path column alignment is an Apps Script production fix **outside** this design’s “do not modify Apps Script yet” boundary; track as a dependency for AI processing reliability.

### 9.7 FieldOS-local data (proposed, not in Sheets)

| Store | Purpose |
|---|---|
| Auth credentials / sessions | Passwords, refresh tokens |
| Operational logs | Container logs under FieldOS directory |
| Optional Redis | Later rate limiting / job cache (not required Phase 1) |

---

## 10. Apps Script integration

### 10.1 Confirmed surfaces FieldOS may call

| Surface | Method | Auth | Use in Phase 1 |
|---|---|---|---|
| `doPost` + `action: process_voice_dictation` | HTTP POST JSON | `webhook_secret` in body | Optional enqueue after recording save |
| `doPost` + `action: execute_worker` | HTTP POST JSON | `webhook_secret` | Ops/debug only |
| `saveRecording` | `google.script.run` only | Web app session | **Not used** by FieldOS (replace with FastAPI+Drive) |
| `appsheetTriggerRoute` | Apps Script task | AppSheet domain | Leave for AppSheet; FieldOS uses `doPost` |
| `triggerVoiceProcessing` | Callable | Manual/AppSheet | Do not call from FieldOS Phase 1 (Gemini path / schema issues) |

### 10.2 Integration principles (proposed)

1. FieldOS is a **client** of Apps Script for processing triggers only.
2. FieldOS may **read/write Sheets directly** for My Jobs and recordings to avoid depending on broken/duplicate Apps Script entry points.
3. All Apps Script calls are server-side with timeouts, redacted logging (mirror confirmed redaction of `webhook_secret`).
4. If Apps Script returns Error JSON, FieldOS surfaces a user-safe message and logs full detail server-side.

### 10.3 Dual-write / dual-UI coexistence

| Actor | May create recordings | May enqueue processing |
|---|---|---|
| AppSheet + Apps Script recorder | Yes (confirmed path) | Yes |
| FieldOS | Yes (proposed path, same tables) | Yes via `doPost` |

Both UIs share Sheets; no exclusive lock. Idempotency relies on confirmed job status skip when `processing_status === Completed` unless `force_reprocess`.

---

## 11. Error handling (proposed)

| Layer | Behaviour |
|---|---|
| API validation | 400 with field errors |
| Auth failures | 401 / 403 |
| Missing job / not assigned | 404 / 403 |
| Drive/Sheets transient errors | Retry with backoff; 503 if exhausted |
| Apps Script webhook failure | Recording still saved if Drive+Sheets succeeded; return warning flag; log `tbl_sync_logs` Failed |
| Frontend | Non-blocking toast + retry for uploads; never show secrets |

Align with confirmed Apps Script pattern: prefer durable audit in `tbl_sync_logs` even when the primary operation partially fails.

---

## 12. Security (proposed)

| Control | Design |
|---|---|
| TLS | Nginx terminates HTTPS on FieldOS subdomain |
| AuthN/AuthZ | Required on all job/recording APIs |
| Secrets | Env vars / Docker secrets; `.env` gitignored (confirmed pattern in repo `.gitignore`) |
| CORS | Allow only FieldOS origin |
| Upload limits | Max audio size/duration enforced in FastAPI + Nginx `client_max_body_size` |
| PII | Minimize logging of audio; store Drive URLs not blobs in logs |
| Network | FieldOS containers on isolated Compose network; do not join Odoo DB network unless explicitly required later |
| Apps Script | Continue treating webhook secret as server-only |

---

## 13. Project folder structure (proposed)

```text
NativeGrace-FieldOS/                 # git repo (existing)
├── README.md
├── SYSTEM_ANALYSIS.md
├── apps-script/                     # production export — DO NOT MODIFY in Phase 1 design work
├── docs/
│   ├── FIELDOS_ARCHITECTURE.md      # this file
│   ├── API_INTEGRATION_PLAN.md
│   ├── AWS_DEPLOYMENT_PLAN.md
│   └── MIGRATION_PLAN.md
├── schema/                          # future sheet header dumps / OpenAPI exports
└── fieldos/
    ├── backend/                     # FastAPI app (to be implemented later)
    ├── frontend/                    # mobile web SPA (to be implemented later)
    ├── deploy/                      # docker-compose, nginx snippets, env templates
    │   ├── docker-compose.yml
    │   ├── nginx/
    │   └── .env.example
    └── README.md

On AWS host (proposed — see AWS_DEPLOYMENT_PLAN.md):
/opt/nativegrace-fieldos/
├── docker-compose.yml
├── .env                             # secrets — not in git
├── data/                            # optional local volumes
├── logs/
├── backups/
└── nginx/                           # or host nginx conf.d drop-in
```

Odoo remains in its existing native installation path (**Assumption:** e.g. `/opt/odoo` or distro default) and is never altered by FieldOS deploy scripts.

---

## 14. Non-goals for this architecture document

- Implementing FastAPI/frontend code.
- Fixing Apps Script duplicates or missing `VoiceProcessing.executePipeline`.
- Migrating AI, approvals, PDFs, or dashboards (later phases).
- Integrating with Odoo data models in Phase 1.

---

## 15. Open questions before implementation

1. Live `tbl_job_sheets` headers — especially assignment fields for My Jobs.
2. Canonical `tbl_recordings` headers in production (recorder vs AppSheet file columns).
3. Deployed Apps Script web app URL and which `doGet` wins.
4. FieldOS subdomain name and TLS DNS ownership.
5. Exact Odoo host layout (ports, Nginx ownership).
6. Staff authentication method preference (password vs OTP).

---

*End of FIELDOS_ARCHITECTURE.md*
