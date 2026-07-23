# Phase 2 Implementation

**Date:** 2026-07-22  
**Status:** Verified against live Apps Script + Shared Drive (local Docker FieldOS).  
**Scope:** Connect FieldOS to Apps Script for real jobs, Drive recording upload, `register_recording`, and `process_voice_dictation` enqueue, while preserving `DATA_MODE=mock`.

---

## 1. Verified end-to-end

| Capability | Result |
|---|---|
| Apps Script job reads (`list_jobs_for_staff`) | Working |
| Job detail (`get_job_detail`) | Working |
| Google Drive recording upload | Working (Shared Drive + full Drive scope) |
| `register_recording` → `tbl_recordings` | Working |
| Frontend recording display | Working |
| `process_voice_dictation` queueing | Working |
| Duplicate recording rows | None observed in smoke |
| Orphan Drive files after failed register | Cleaned (delete, with Shared Drive trash fallback) |
| Secret leaks in API logs | None observed in smoke |
| Backend tests | Passing |

---

## 2. What was implemented

| Area | Change |
|---|---|
| Mode | `DATA_MODE=mock` (default) + `DATA_MODE=apps_script` |
| Abstraction | `MockJobRepository` / `AppsScriptJobRepository` via `JobService` |
| Apps Script client | Gateway actions + confirmed `process_voice_dictation`; timeouts; validated responses; redirects followed; secrets redacted from logs |
| Apps Script (repo) | `apps-script/FieldOSGateway.js` + Router wiring for FieldOS actions |
| Recordings | Drive upload from FastAPI + `register_recording` (no large audio through Apps Script) |
| Drive | Full scope `https://www.googleapis.com/auth/drive`; `supportsAllDrives=True`; orphan delete/trash fallback |
| Process | Reuses confirmed `process_voice_dictation` |
| Tests | Mock mode + mocked Apps Script HTTP + Drive upload unit tests |
| Docs | `APPS_SCRIPT_API.md`, `PHASE2_IMPLEMENTATION.md`, `PHASE2_SETUP.md` |

---

## 3. Confirmed live schema (`tbl_job_sheets`)

| FieldOS env | Live header | Notes |
|---|---|---|
| `JOB_ASSIGNMENT_COLUMN` | `staff_id` | Staff assignment |
| `JOB_DATE_COLUMN` | `date` | Job date |
| `JOB_PROJECT_COLUMN` | `project_id` | **AppSheet Text** (not Ref). Stores legacy client/project label; name is misleading. FieldOS surfaces as `project_name`. |
| `JOB_CUSTOMER_COLUMN` | `customer_name` | **Not a job-sheet column** — API display via dual-read (`FieldOSDisplayLookup`); blank when no master match |

Also confirmed on jobs / processing paths: `job_sheet_id`, `processing_status`, `processing_error`, `approval_status`, and related processing timestamps.

**Local test account (apps_script smoke):** demo login mapped to staff ID `STAFF-9012C021` via `DEMO_STAFF_ID` in local `.env` (never commit real `.env`).

---

## 4. Google Drive (recordings)

| Requirement | Detail |
|---|---|
| OAuth scope | Full Drive: `https://www.googleapis.com/auth/drive` (`drive.file` is insufficient for the existing Shared Drive folder) |
| Folder | Shared Drive folder ID in `RECORDINGS_FOLDER_ID` |
| Access | Service account email as **Content manager** (or equivalent write/delete) on that Shared Drive / folder |
| API flags | `supportsAllDrives=True` on `files().get`, `files().create`, `files().delete`, and trash fallback `files().update` |
| Credentials | Host path `fieldos/secrets/service-account.json` → container `/app/secrets/service-account.json` (compose bind mount, read-only) |
| Env | `GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/service-account.json` |
| Secrets | Never commit `secrets/`, service-account JSON, webhook secrets, or `.env` |

On Shared Drives, permanent `files().delete` can return `notFound`; FieldOS falls back to trash so orphans leave the active folder.

---

## 5. Safety

- Browser never receives `webhook_secret` or Apps Script URL
- FastAPI logs redact secrets; do not log raw payloads or credential contents
- `.env` and `fieldos/secrets/` stay local / gitignored
- This finalize pass does **not** deploy Apps Script or AWS

---

## 6. Verification checklist

See **Phase 2 verification checklist** in `docs/PHASE2_SETUP.md`.

---

## 7. Out of scope / known issues / future work

| Item | Status |
|---|---|
| Customer display via `project_id` → `tbl_projects` → `tbl_customers` | **Deployed / verified** — dual-read resolves legacy Text labels; masters seeded (Babidge, Kat and James Dykes; batch `SEED-APPLY-20260723-221344`). Job `21759f5d` live-verified. `smith` unseeded (manual review). Historical job rows unchanged. |
| Apps Script `doGet` recorder conflict | **Deferred** — Phase 2 FieldOS only uses `doPost`. Proposal remains in `apps-script-proposed/DOGET_MERGE_PROPOSAL.md`. Do not merge until a dedicated Apps Script web-entry cleanup. |
| AWS hosting / Odoo cutover | Future |
| Local Python | Use **3.12** for backend venv (Docker already 3.12); see `fieldos/README.md` |

### Confirmed table PKs (from `Repositories.js`)

| Table | PK |
|---|---|
| `tbl_job_sheets` | `job_sheet_id` |
| `tbl_projects` | `project_id` |
| `tbl_customers` | `customer_id` |

**Confirmed FK on jobs:** none today — `tbl_job_sheets.project_id` is a **legacy text label** (AppSheet Text), not a FK to `tbl_projects`.  
**Masters:** safe labels seeded (`PROJ-/CUST-8BC1502B` Babidge, `PROJ-/CUST-6002C0A0` Kat and James Dykes). Dual-read lookup does not rewrite historical job text.
