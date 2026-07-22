# Native Grace FieldOS

This repository contains:

- The existing Apps Script production backend
- The new Native Grace FieldOS application
- System documentation
- Database and integration schemas

## Current production system

- AppSheet is the current field interface
- Google Sheets is the datastore
- Apps Script contains business logic and integrations
- QuickBooks Time staff sync is operational
- AI job sheet processing is operational
- Daily summaries are operational
- Manager approval and PDF generation are operational

## Goal

Build a custom FieldOS application hosted on AWS beside Odoo.

The new application must remain compatible with the existing Google Sheets, AppSheet and Apps Script workflows during migration.

## Phase 1 (local)

FieldOS Phase 1 (login, My Jobs, voice recorder) runs locally via Docker:

```bash
cd fieldos
cp .env.example .env
docker compose up --build -d
```

- UI: http://localhost:8080  
- Docs: `fieldos/README.md`, `docs/PHASE1_IMPLEMENTATION.md`, `docs/PHASE1_VALIDATION.md`  
- Architecture: `docs/FIELDOS_ARCHITECTURE.md`

## Phase 2 (Apps Script + Drive)

Phase 2 connects FieldOS to live Apps Script for jobs/recordings and uploads audio to a Shared Drive folder from FastAPI.

**Verified locally:** job list/detail, Drive upload, `register_recording`, frontend recording list, `process_voice_dictation` queueing.

```bash
cd fieldos
# Configure .env for DATA_MODE=apps_script (see docs/PHASE2_SETUP.md)
# Place service-account.json under fieldos/secrets/ (gitignored)
docker compose up --build -d
curl -fsS http://localhost:8000/api/v1/ready
```

| Doc | Purpose |
|---|---|
| `docs/PHASE2_SETUP.md` | Setup, Drive requirements, verification checklist |
| `docs/PHASE2_IMPLEMENTATION.md` | What shipped + confirmed schema |
| `docs/APPS_SCRIPT_API.md` | Apps Script HTTP contract |

**Confirmed live job columns:** `staff_id`, `date`, `project_id` (`customer_name` not on `tbl_job_sheets`).  
**Drive:** full Drive scope + Shared Drive + `supportsAllDrives` — see Phase 2 setup.  
**Never commit** `.env`, webhook secrets, or `fieldos/secrets/*`.
