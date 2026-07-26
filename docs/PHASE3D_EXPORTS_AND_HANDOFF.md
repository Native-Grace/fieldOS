# Phase 3D — Completion dashboard, exports, and controlled handoff

## Architecture

Phase 3D adds a **manager/admin completion dashboard** and **export-batch staging** for
invoice, payroll, machinery, materials, and completion-summary CSVs.

```
Finalised completions (3C)
    → Dashboard filters + summary metrics
    → Export readiness (invoice / payroll blockers)
    → Draft export batch (frozen item list)
    → Validate → Generate CSV snapshot
    → Authenticated download
```

**Boundary:** staging and download only. No Xero posting, no payroll posting, no invoice
numbers, no monetary totals, no Drive export-file writes by default.

```
React Completions Dashboard
    → FastAPI /api/v1/completions/dashboard|exports…
        → mock store   OR   Apps Script FieldOSCompletionExports
            → tbl_job_completions (+ labour/machinery/materials)
            → tbl_export_batches / tbl_export_batch_items
            → tbl_sync_logs (FieldOS_Export audits)
```

## Data model discovery

| Area | Finding |
|---|---|
| Existing export / dashboard tables | **None** prior to 3D |
| Pricing / rate source of truth | **None** — no unit cost, sell rate, GST, or payroll codes |
| Completion source | Phase 3C `tbl_job_completions` + child tables |
| Audit sink | Reuse `tbl_sync_logs` with `target_system = FieldOS_Export` |

### New tables

Created by `migrateSchemaForCompletionExports()` in `Setup.js`:

**`tbl_export_batches`**
`export_batch_id`, `export_type`, `date_from`, `date_to`, `filter_json`, `status`,
`record_count`, `created_by`, `created_at`, `completed_at`, `file_name`, `checksum`,
`notes`, `snapshot_json`, `version`

**`tbl_export_batch_items`**
`export_batch_item_id`, `export_batch_id`, `job_sheet_id`, `completion_id`,
`item_status`, `blocker_summary`, `created_at`

## Dashboard date field

Primary inclusion date is **`job_date`** from the job sheet (not `finalised_at`).

Sheets `Date` values and locale strings such as
`Thu Jul 16 2026 00:00:00 GMT+1000 (Australian Eastern Standard Time)` are normalised via
`fieldosNormaliseCalendarDate_` → `YYYY-MM-DD` in the spreadsheet timezone before
filter comparison, dashboard responses, readiness, CSV rows, and labour `work_date`.

Inclusive bounds: `date_from <= job_date <= date_to`.

Optional dedicated filters: `finalised_from` / `finalised_to` (calendar date of
`finalised_at` in spreadsheet TZ) — do not replace `job_date`.

Read-only diagnostic: `testFieldOSCompletionDashboardDiagnostic('21759f5d')`.

Default range: **last 30 days** (inclusive).

| Filter | Notes |
|---|---|
| `date_from` / `date_to` | Job date |
| `completion_status` | Draft / Finalised / Reopened |
| `approval_status` | Job approval |
| `customer` / `project` | Case-insensitive contains |
| `assigned_staff_id` | Exact |
| `billable` | Has / has-not billable labour hours |
| `q` | Text search across job id, customer, project, summaries |

Managers/admins see all matching completions. Staff receive **403** on dashboard/export APIs.
Staff job-detail completion reads remain assignment-scoped from Phase 3C.

Dashboard does **not** expose: raw transcript, Drive IDs, API secrets, auth tokens.

## Summary metrics

For the filtered set:

- job count, finalised, draft/reopened
- total labour / travel / machinery hours
- billable / non-billable labour hours
- unresolved warnings
- jobs ready for invoice export
- jobs ready for payroll export

No monetary totals until authoritative rates exist.

## Readiness rules

Returned as:

```json
{
  "invoice_ready": false,
  "invoice_blockers": ["Invoice description is blank"],
  "payroll_ready": true,
  "payroll_blockers": [],
  "warning_count": 0
}
```

### Invoice ready when

- `completion_status = Finalised`
- job `approval_status = Approved`
- `work_summary` present
- `invoice_description` present
- no unresolved critical/ack warnings
- every labour/machinery/material row is Confirmed or Excluded
- no invalid labour time arithmetic
- no blank required invoice fields above

### Payroll ready when

- `completion_status = Finalised`
- each Confirmed labour row has `staff_id`, `work_date`, `start_time`, `finish_time`
- `break_minutes` / `travel_minutes` valid
- labour hours derived server-side
- confirmation_status = Confirmed (Excluded rows omitted)
- payroll-critical arithmetic errors absent

## Export batch model

| Status | Meaning |
|---|---|
| Draft | Item list frozen for selected filters / completion IDs |
| Validated | Item readiness evaluated; blockers recorded |
| Exported | CSV snapshot + checksum frozen; **immutable** |
| Cancelled | Terminal for non-exported batches |

Rules:

- manager/admin only
- regenerate requires a **new** batch
- short lock `EXPORT_BATCH_{id}` around sheet mutations only (Apps Script)
- CSV generated in API/Apps Script memory — not written to public web dirs or Drive by default

## Endpoint contracts

| Method | Path | Role |
|---|---|---|
| GET | `/api/v1/completions/dashboard` | manager/admin |
| GET | `/api/v1/completions/dashboard/summary` | manager/admin |
| GET | `/api/v1/completions/{completion_id}/readiness` | manager/admin |
| POST | `/api/v1/exports` | manager/admin create Draft |
| GET | `/api/v1/exports` | manager/admin |
| GET | `/api/v1/exports/{export_batch_id}` | manager/admin |
| POST | `/api/v1/exports/{export_batch_id}/validate` | manager/admin |
| POST | `/api/v1/exports/{export_batch_id}/generate` | manager/admin |
| POST | `/api/v1/exports/{export_batch_id}/cancel` | manager/admin |
| GET | `/api/v1/exports/{export_batch_id}/download` | manager/admin CSV |

Error mapping:

- staff → **403**
- missing batch/completion → **404**
- stale `expected_version` → **409**
- invalid state / blocked generate → **422**

Download: `text/csv; charset=utf-8` + `Content-Disposition: attachment; filename="…"`.
Auth via Bearer header only (no token query params).

## Apps Script actions

`list_completion_dashboard`, `get_completion_dashboard_summary`,
`get_completion_export_readiness`, `create_export_batch`, `list_export_batches`,
`get_export_batch`, `validate_export_batch`, `generate_export_batch`,
`get_export_batch_csv`, `cancel_export_batch`

Gateway: `FieldOSCompletionExports` in `CompletionExports.js` + helpers in
`CompletionExportHelpers.js`.

## CSV schemas

Stable column order; deterministic sort by `job_sheet_id` then row identity.

### Invoice CSV

`job_sheet_id`, `job_date`, `customer_name`, `project_name`, `invoice_description`,
`work_summary`, `variation_summary`, `billable_labour_hours`, `billable_machinery_hours`,
`billable_material_items`, `pricing_status` (= `Rates not configured`), `finalised_by`,
`finalised_at`

### Payroll CSV

One row per confirmed labour entry — times as HH:MM; hours derived; no pay rates.

### Machinery / Materials CSV

Confirmed rows only; no unit cost / sell price / GST.

### Completion Summary CSV

One row per completion including `invoice_ready` / `payroll_ready` flags.

Never include: transcript, Drive IDs, secrets, invoice numbers, cost/sell rates, GST totals.

## CSV safety

- Prefix cells starting with `=`, `+`, `-`, `@` with `'`
- RFC 4180 quoting for commas / quotes / newlines
- UTF-8, CRLF line endings
- Stable headers + deterministic row order

## Audit strategy

`tbl_sync_logs` / mock sync log with whitelist payload via `fieldosExportAuditPayload_`:

- action, actor, role, export type, batch id, date range, record count, checksum, status transition

Never log: full CSV, transcripts, note bodies, Authorization headers, tokens, API keys, Drive IDs.

## Xero boundary (future)

Documented mapping targets — all currently **unresolved**:

| Field | Status |
|---|---|
| Contact / customer ID | unresolved |
| Project / reference | unresolved |
| Invoice description | staged in CSV only |
| Line items | hours/items staged; no amounts |
| Tax type / account code | unresolved |
| Tracking categories | unresolved |
| Invoice status / number | unresolved — do not invent |

## Payroll boundary (future)

| Requirement | Status |
|---|---|
| Employee / staff mapping | staff_id staged; payroll employee IDs unresolved |
| Ordinary / overtime / awards | unresolved — do not infer |
| Allowances / travel codes | travel minutes staged only |
| Cost centre / job code | unresolved |

## Future rate-source requirements

Before monetary invoice/payroll exports:

1. Authoritative sell rates and GST treatment
2. Authoritative labour / award / payroll codes
3. Explicit Xero contact + account mappings
4. Signed manager approval of priced lines

## Deployment steps (manual — do not auto-deploy)

1. Deploy Apps Script files including `CompletionExportHelpers.js`, `CompletionExports.js`,
   updated Gateway/Router/Repositories/Setup.
2. Run `migrateSchemaForCompletionExports()` once against the **non-production** spreadsheet first.
3. Redeploy FieldOS backend + frontend.
4. Smoke-test mock mode, then apps_script mode against a staging spreadsheet.
5. Only then consider production spreadsheet migration.

## Rollback steps

1. Hide Completions nav / route if needed.
2. Stop calling export endpoints.
3. Leave tables in place (non-destructive); do not delete exported audit rows.
4. Redeploy prior backend/frontend/Apps Script revision
   (baseline commit `66e208f8572dd3940adc228e68167db54d01847f` before Phase 3D).

## Manual test plan (staging — job `21759f5d`)

Prepare but **do not** execute production Xero/payroll posts.

1. Open Completion Dashboard; confirm job `21759f5d` appears in range.
2. Confirm summary hours match the finalised completion.
3. Open readiness for its completion_id — verify blockers or ready flags.
4. Create Draft **Completion Summary CSV** batch including that job.
5. Validate → Generate (confirm dialog) → Download locally.
6. Inspect CSV: expected columns; no transcript; no Drive IDs; no money; formula injection safe;
   stable ordering.
7. Confirm Exported batch rejects regenerate/cancel.
8. Do not post to Xero or payroll.

## Files of record

- Apps Script: `CompletionExportHelpers.js`, `CompletionExports.js`, Gateway/Router/Repositories/Setup
- Backend: `export_math.py`, `mock_export.py`, schemas, routes, jobs service, apps_script client
- Frontend: `CompletionsDashboardPage.jsx`, `completionDashboardHelpers.mjs`, `api.js` download helpers
- Tests: `apps-script/tests/completion_exports.test.mjs`,
  `fieldos/backend/tests/test_completion_exports.py`,
  `fieldos/frontend/src/completionDashboard.test.mjs`
