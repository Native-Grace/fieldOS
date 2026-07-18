# FieldOS Migration Plan

**Document status:** Design proposal  
**Date:** 2026-07-18  
**Companion docs:** `FIELDOS_ARCHITECTURE.md`, `API_INTEGRATION_PLAN.md`, `AWS_DEPLOYMENT_PLAN.md`, `SYSTEM_ANALYSIS.md`  
**Constraint:** Phase work must keep Google Sheet table/column names stable and keep AppSheet usable until Phase 5.

**Legend:** **Confirmed** = current repo behaviour · **Proposed** = migration design · **Assumption** = needs live validation

---

## 1. Migration principles

1. **Coexistence first** — FieldOS runs beside AppSheet + Apps Script + Sheets.
2. **No Sheet renames** — tables/columns stay stable across all phases.
3. **Apps Script stays authoritative** for existing processing until a phase explicitly moves a capability.
4. **Odoo stays untouched** — FieldOS is a separate Docker stack on the same host.
5. **Secrets stay server-side** — never expose Apps Script webhook or Google credentials to browsers.
6. **Each phase ships a usable slice** with explicit acceptance tests before the next phase starts.
7. **Distinguish confirmed vs proposed** — do not assume README “operational” features are complete in the Apps Script export (`SYSTEM_ANALYSIS.md` gaps).

---

## 2. Current baseline (confirmed / assumed)

| Component | State |
|---|---|
| AppSheet | Current field UI (**Assumption** per README; config not in repo) |
| Google Sheets | Datastore (`tbl_*`) — **confirmed** |
| Apps Script | Business logic + integrations — **confirmed partial** |
| Voice recorder | `Recorder.html` + conflicting save/`doGet` paths — **confirmed** |
| Queue / AI pipeline | Queue exists; `VoiceProcessing.executePipeline` **missing** in export — **confirmed gap** |
| FieldOS app | Empty `fieldos/` placeholders — **confirmed** |
| Odoo on AWS | Target coexistence host — **Assumption** (not in repo) |

---

## 3. Phase 1 — Recorder and My Jobs

### 3.1 Objectives (proposed)

- Deploy FieldOS on AWS (Docker Compose) behind `fieldos.<domain>`.
- Mobile-friendly **My Jobs** list + job detail.
- Mobile-friendly **voice recorder** uploading to Drive + `tbl_recordings`.
- Optional server-side trigger of Apps Script `process_voice_dictation`.
- AppSheet workflows continue unchanged.

### 3.2 In scope

- FastAPI auth + jobs + recordings APIs.
- Frontend login, My Jobs, recorder.
- Sheets/Drive integration; Apps Script webhook client.
- Nginx, TLS, health checks, backups, logging, rollback runbooks.

### 3.3 Out of scope

- Attendance, photos, materials editing.
- Approvals, PDF, dashboards.
- Fixing Apps Script duplicate `doGet` / missing pipeline (track as dependency; do not block Phase 1 save path).
- Odoo integration.

### 3.4 Dependencies / blockers

| Item | Why needed |
|---|---|
| Live `tbl_job_sheets` headers + assignment rule | My Jobs filter |
| Live `tbl_recordings` headers | Correct write shape |
| Apps Script Web App URL + `WEBHOOK_SECRET` | Process trigger |
| `SPREADSHEET_ID`, `RECORDINGS_FOLDER_ID`, Google credentials | I/O |
| DNS + TLS for FieldOS subdomain | Public access |

### 3.5 Testing and acceptance criteria

| ID | Criterion | Pass condition |
|---|---|---|
| P1-A1 | Deploy isolation | FieldOS up; Odoo health unchanged after deploy |
| P1-A2 | Auth | Staff can log in; invalid creds rejected; JWT required on job APIs |
| P1-A3 | Secret hygiene | Browser never receives webhook/Google secrets |
| P1-A4 | My Jobs | Authenticated staff sees only assigned jobs (per agreed assignment rule) |
| P1-A5 | Recorder upload | Audio appears in Drive folder and as new `tbl_recordings` row |
| P1-A6 | AppSheet visibility | New recording visible in AppSheet without schema changes |
| P1-A7 | Process trigger | Optional enqueue returns mapped Apps Script Success/Error; save still durable on enqueue failure |
| P1-A8 | Compatibility | Existing AppSheet create/edit job flows still work |
| P1-A9 | Health | `/api/v1/health` and `/api/v1/ready` succeed |
| P1-A10 | Rollback drill | Documented rollback restores previous FieldOS version without touching Odoo |

**Exit gate:** all P1 acceptance tests pass on production (or agreed staging spreadsheet) and AppSheet regression smoke passes.

---

## 4. Phase 2 — Attendance, photos and materials

### 4.1 Objectives (proposed)

Extend FieldOS job detail to support day-to-day field capture beyond voice:

- Attendance / time presence against a job (exact UX TBD).
- Photo capture/upload linked to `tbl_photos` (**declared in repos; no Apps Script writers confirmed**).
- Materials line entry linked to `tbl_materials` (**declared only in export**).

### 4.2 In scope

- New FieldOS API endpoints for photos/materials/attendance.
- Mobile UI forms and camera upload.
- Write to existing sheet tables/columns only (discover live headers first).
- Continue Apps Script/AppSheet coexistence.

### 4.3 Out of scope

- Full job sheet structured editing / AI rewrite.
- Manager approval workflow.
- Leaving AppSheet.

### 4.4 Risks (from analysis)

- Photo/material column schemas are **not confirmed** in Apps Script code — live export required.
- AppSheet may already own validation rules; FieldOS must mirror them.

### 4.5 Testing and acceptance criteria

| ID | Criterion | Pass condition |
|---|---|---|
| P2-A1 | Photos | Upload stores file + `tbl_photos` row; visible in AppSheet |
| P2-A2 | Materials | Create/update material lines without renaming columns |
| P2-A3 | Attendance | Attendance records persist and appear in agreed AppSheet view |
| P2-A4 | AuthZ | Staff cannot mutate other staff’s jobs |
| P2-A5 | Regression | Phase 1 recorder + My Jobs still pass |
| P2-A6 | AppSheet dual-write | Edits from AppSheet and FieldOS do not corrupt rows (spot-check concurrent edit) |

**Exit gate:** field pilot (subset of staff) completes a full day using FieldOS for voice + photos + materials while AppSheet remains available as fallback.

---

## 5. Phase 3 — Job sheet editing and approvals

### 5.1 Objectives (proposed)

- Allow FieldOS to edit core job sheet fields and related lines (`tbl_job_sheet_lines`, equipment, follow-ups as applicable).
- Implement manager **approval** flows using existing columns where present (`approval_status`, `approved_by`, `approved_at` — **confirmed migration targets** in `Setup.js`).
- Decide whether processing/AI orchestration remains in Apps Script or moves to FieldOS workers.

### 5.2 In scope

- Job edit UI + validation.
- Approval queue for managers.
- Status transitions documented and enforced in FastAPI.
- Audit to `tbl_sync_logs`.

### 5.3 Out of scope

- Full retirement of AppSheet.
- Advanced analytics dashboards.

### 5.4 Confirmed gaps to resolve in this phase

| Gap | Plan |
|---|---|
| Missing `VoiceProcessing.executePipeline` | Either restore in Apps Script (separate production fix) or reimplement pipeline in FieldOS |
| Recorder vs Gemini column mismatch | Normalize writes/reads without renaming; possibly dual-write `transcript`/`transcription` if required |
| README PDF/daily summary claims incomplete in export | Only implement approvals that are evidenced by live process docs |

### 5.5 Testing and acceptance criteria

| ID | Criterion | Pass condition |
|---|---|---|
| P3-A1 | Edit | Field staff can update allowed job fields; AppSheet shows same values |
| P3-A2 | Validation | Illegal transitions rejected with clear errors |
| P3-A3 | Approval | Manager can approve/reject; `approval_status` / summary approval columns update correctly |
| P3-A4 | Audit | Approval actions recorded in `tbl_sync_logs` |
| P3-A5 | Processing | Agreed AI/process path completes or fails gracefully with `processing_status` updates |
| P3-A6 | Regression | Phases 1–2 acceptance still green |
| P3-A7 | Role separation | Non-managers cannot approve |

**Exit gate:** managers complete approvals in FieldOS for a defined pilot period; AppSheet approval path either mirrored or formally deprecated for the pilot group.

---

## 6. Phase 4 — Dashboards and reporting

### 6.1 Objectives (proposed)

- Operational dashboards for supervisors (job status, failures, recording completeness).
- Reporting exports (CSV/PDF) as needed.
- Daily summary visibility if/when generation logic is confirmed in production (not present in current Apps Script export).

### 6.2 In scope

- Read-optimised APIs / caching if Sheets performance requires it.
- Dashboard UI.
- Optional scheduled report jobs in FieldOS Compose stack.

### 6.3 Out of scope

- Full cutover from AppSheet (Phase 5).
- Deep Odoo BI merge (optional future track).

### 6.4 Notes on confirmed gaps

PDF generation and daily summary workflows are **not confirmed** in the repository. Phase 4 must start with a discovery spike against live production behaviour before building reports that claim parity.

### 6.5 Testing and acceptance criteria

| ID | Criterion | Pass condition |
|---|---|---|
| P4-A1 | Dashboard accuracy | Metrics match sheet spot-checks for sample dates |
| P4-A2 | Performance | Dashboard initial load acceptable on mobile network target (agree numeric SLO) |
| P4-A3 | Export | Report download matches on-screen filters |
| P4-A4 | Access control | Dashboards limited to manager/supervisor roles |
| P4-A5 | Regression | Phases 1–3 still pass |
| P4-A6 | Odoo isolation | Report jobs do not impact Odoo CPU/memory beyond agreed limits |

**Exit gate:** supervisors use FieldOS dashboards as primary monitoring tool for ≥2 weeks with AppSheet reports as fallback only.

---

## 7. Phase 5 — Migration away from AppSheet

### 7.1 Objectives (proposed)

- Make FieldOS the primary (and then sole) field UI.
- Retire AppSheet bots/webhooks that duplicate FieldOS.
- Narrow Apps Script to temporary adapters or retire it after capabilities move to FieldOS.
- Keep Sheets only as long as needed; plan eventual database cutover (post–Phase 5 track).

### 7.2 In scope

- Feature parity checklist vs AppSheet production app.
- User training and cutover schedule.
- Redirect/disable AppSheet access for field roles.
- Move remaining automations (QB sync, AI, PDFs) fully behind FieldOS jobs if still on Apps Script.
- Decommission plan for Apps Script anonymous web app.

### 7.3 Out of scope (follow-on)

- Full replacement of Google Sheets with Postgres/Odoo storage (recommended Phase 6+).
- Deep Odoo module merge.

### 7.4 Cutover strategy (proposed)

1. **Parity audit** — every AppSheet view/action mapped to FieldOS.
2. **Soft cutover** — FieldOS default; AppSheet read-only for emergency.
3. **Hard cutover** — AppSheet disabled for field staff.
4. **Adapter retirement** — remove AppSheet-triggered Apps Script entry points once unused.
5. **Security hardening** — shut down `ANYONE_ANONYMOUS` Apps Script web app when obsolete.

### 7.5 Testing and acceptance criteria

| ID | Criterion | Pass condition |
|---|---|---|
| P5-A1 | Parity | Signed parity checklist complete; no P0 gaps |
| P5-A2 | Pilot cutover | Entire crew operates ≥1 week without AppSheet |
| P5-A3 | Automation | No AppSheet bots required for critical path |
| P5-A4 | Support load | Support tickets related to FieldOS within agreed threshold |
| P5-A5 | Rollback readiness | AppSheet can be re-enabled within agreed RTO if emergency declared |
| P5-A6 | Secret surface reduced | Apps Script anonymous recorder no longer needed |
| P5-A7 | Odoo | Remains healthy; still unmodified by FieldOS |

**Exit gate:** business owner signs off AppSheet retirement for field operations; emergency re-enable plan documented and tested once.

---

## 8. Cross-phase testing strategy

### 8.1 Test types

| Type | Cadence |
|---|---|
| Unit tests (FastAPI services) | Every build |
| API contract tests | Every build |
| Sheet integration tests against a **sandbox spreadsheet** | Every build / nightly |
| Mobile smoke (My Jobs + recorder) | Every deploy |
| AppSheet regression smoke | Every deploy during Phases 1–4 |
| Odoo health check | Before/after every AWS deploy |
| Rollback drill | Each phase exit |

### 8.2 Environments (proposed)

| Env | Sheets | Purpose |
|---|---|---|
| Dev | Copy of schema | Feature work |
| Staging | Sanitised data copy | Acceptance |
| Production | Live Native Grace spreadsheet | Phased rollout |

**Do not** point dev at production Sheets.

### 8.3 Rollout pattern (proposed)

- Internal staff → one field crew → all crews.
- Feature flags for new modules where practical.

---

## 9. Phase dependency diagram

```text
Phase 1  Recorder + My Jobs
   │
   ▼
Phase 2  Attendance + Photos + Materials
   │
   ▼
Phase 3  Job editing + Approvals (+ AI path decision)
   │
   ▼
Phase 4  Dashboards + Reporting
   │
   ▼
Phase 5  Leave AppSheet
   │
   ▼
(Future) Sheets → proper DB / deeper Odoo alignment
```

---

## 10. Explicit non-work until later

| Item | Earliest phase |
|---|---|
| Implementing application code | After these docs accepted |
| Modifying Apps Script production files | Only when a phase requires a controlled fix |
| Odoo code/config changes | Not in this migration plan |
| Renaming Google columns | Never (compatibility rule) |

---

## 11. Success definition for the overall migration

Field staff complete daily job capture (voice, photos, materials, edits, approvals) in FieldOS on the AWS host beside Odoo, with Google Sheets remaining compatible during transition, AppSheet retired only after Phase 5 acceptance, and Odoo never destabilised by FieldOS operations.

---

*End of MIGRATION_PLAN.md*
