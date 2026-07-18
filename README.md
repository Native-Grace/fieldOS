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
