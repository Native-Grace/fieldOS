# Phase 2 Implementation

**Date:** 2026-07-18  
**Scope:** Connect FieldOS to Apps Script for real jobs + recording registration + process enqueue, while preserving `DATA_MODE=mock`.

---

## 1. Discovered production API (summary)

Confirmed `doPost` actions only:

- `process_voice_dictation` (webhook_secret)
- `execute_worker` (webhook_secret)

Missing HTTP for list jobs, job detail, register recording. Full contract: `docs/APPS_SCRIPT_API.md`.

## 2. What was implemented

| Area | Change |
|---|---|
| Mode | `DATA_MODE=mock` (unchanged) + `DATA_MODE=apps_script` |
| Abstraction | `MockJobRepository` / `AppsScriptJobRepository` via `JobService` |
| Apps Script client | Expanded actions; timeouts; validated responses; secrets redacted from logs |
| Proposed Apps Script | `apps-script-proposed/FieldOSGateway.js` — **not** applied to production `apps-script/` |
| Recordings | Drive upload from FastAPI + `register_recording` (no large audio through Apps Script) |
| Process | Reuses confirmed `process_voice_dictation` |
| Tests | Mock mode + mocked Apps Script HTTP |
| Docs | `APPS_SCRIPT_API.md`, `PHASE2_IMPLEMENTATION.md`, `PHASE2_SETUP.md` |

## 3. Column mapping status

| Field | Status |
|---|---|
| `job_sheet_id`, `processing_*`, `approval_status` | **Confirmed** in Apps Script + live headers |
| `staff_id`, `date`, `project_id` | **Confirmed** live `tbl_job_sheets` headers (FieldOS env defaults) |
| `customer_name` | **Not on job sheet** — API display field; resolve via `project_id` → `tbl_projects` → customer (lookup TBD) |

## 4. Safety

- Production `apps-script/` untouched
- No deploy performed
- Secrets never returned to browser
- `.env` not overwritten by tooling beyond `.env.example` template

## 5. Stop point

Do **not** deploy Apps Script or connect production Sheets until you approve the proposed gateway merge and confirm live column headers.
