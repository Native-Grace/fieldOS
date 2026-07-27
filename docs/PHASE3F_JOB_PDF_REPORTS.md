"""
Phase 3F — Job Sheet PDF summaries and filtered operational reports.

## Architecture

Apps Script (or mock store) assembles **structured report data only**.
FastAPI renders the final PDF with **ReportLab** and streams it over an
authenticated download. Generated batches freeze a scrubbed JSON snapshot;
download re-renders from that snapshot so the PDF stays deterministic without
storing binary blobs in Sheets.

```
UI /reports  →  POST /reports/preview (no PDF)
             →  POST /reports (Draft batch)
             →  validate → generate (freeze snapshot)
             →  GET /reports/{id}/download (ReportLab → application/pdf)
GET /jobs/{id}/summary.pdf  →  convenience single-job PDF
```

## Renderer choice: ReportLab

Chosen over WeasyPrint / Playwright because:

- No Chromium or OS PDF libraries required in Docker/CI
- Deterministic layout with Helvetica (no remote fonts)
- Already compatible with FastAPI `StreamingResponse`
- Pure-Python dependency (`reportlab==4.2.5`)

Trade-off: HTML/CSS fidelity is lower than Chromium print, but Phase 3F
requires reliable server-side generation without browser print CSS.

## Template design

- A4 portrait by default; Completion Register defaults to landscape
- Native Grace header (dark green), restrained grey body text
- Repeated table headers (`repeatRows=1`)
- Footer: generated timestamp, actor, page X of Y, internal batch ref,
  template version, “Generated from Native Grace FieldOS”
- Long notes wrap; no remote CSS/logo fetch at render time

## Report types

| Type | Grouping | Audience |
|---|---|---|
| Job Sheet Summary | one job | internal |
| Staff Work Report | by staff | internal (staff may only run for self) |
| Client Job Report | by customer → project | **client** (strips internal notes/warnings) |
| Project Activity Report | by project | internal |
| Completion Register | condensed table | internal |

## Filters

`date_from` / `date_to` (inclusive, job date), staff / assigned staff,
customer, project, completion status, approval status, billable,
`job_sheet_id` / `job_sheet_ids`, free-text `q`.

Staff actors are scoped to jobs they are assigned to or have labour rows on.

## Task line-item source

No formal task table is reused. Display-only lines come from:

1. `manager_review_items` **only when** `approval_status = Approved`
2. `variations` (completion or job)

Source labels: `Manager review` / `Variation`. Quantities are never invented.
Raw `ai_transcript` is never converted into tasks.

## Privacy model

Forbidden keys (transcripts, Drive IDs, tokens, secrets, cost rates for client
audience) are scrubbed before freeze/render. Client reports never include
internal notes, warnings, payroll mappings, or cost rates. Internal notes
require manager/admin + explicit include flag on single-job PDF data.

## Report batch lifecycle

Draft → Validated → Generated | Cancelled

- Generated is immutable; regenerate creates a new batch
- Filters and included items frozen in `snapshot_json`
- SHA-256 checksum of rendered PDF stored on generate/download path
- No public URLs; no Drive write

Tables (non-destructive migration `migrateSchemaForJobReports`):

- `tbl_report_batches`
- `tbl_report_batch_items`

## Endpoint contracts

- `GET /api/v1/reports/options`
- `POST /api/v1/reports/preview`
- `POST /api/v1/reports` · `GET /api/v1/reports`
- `GET /api/v1/reports/{report_batch_id}`
- `POST .../validate` · `.../generate` · `.../cancel`
- `GET .../download` → `application/pdf` + `Content-Disposition`
- `GET /api/v1/jobs/{job_sheet_id}/summary.pdf`

Errors: 403 staff scope / role, 404 missing, 409 stale version, 422 state,
502 Apps Script / renderer failure.

## Apps Script actions

`get_report_options`, `preview_report`, `create_report_batch`,
`list_report_batches`, `get_report_batch`, `validate_report_batch`,
`generate_report_data`, `cancel_report_batch`, `get_report_batch_pdf_data`,
`get_job_pdf_data`

Lock: `REPORT_BATCH_{id}` around writes only — never during PDF render.

## Filenames

Examples:

- `nativegrace_job_sheet_summary_21759f5d.pdf`
- `nativegrace_staff_work_report_2026-07-01_to_2026-07-31.pdf`
- `nativegrace_completion_register_2026-07-01_to_2026-07-31.pdf`

## Audit

Whitelisted: action, actor, role, report type, filters, record count,
checksum, filename, template version, status transition.
Never log PDF bytes, transcripts, or full snapshots.

## Deployment

1. `pip install -r fieldos/backend/requirements.txt` (includes reportlab)
2. Push Apps Script: `JobReportHelpers.js`, `JobReports.js`, Gateway/Router/Repositories/Setup
3. Run `migrateSchemaForJobReports()` once
4. Redeploy backend + frontend (`/reports` route)
5. Do **not** auto-email or Drive-upload PDFs

## Rollback

Code rollback leaves empty report tables unused. Delete generated local
fixture artifacts under `fieldos/backend/tests/artifacts/reports/` if present.

## Manual verification (job 21759f5d / CMP-288481F1)

1. Open job → Download job PDF (or `/api/v1/jobs/21759f5d/summary.pdf`)
2. Confirm job date, project, Finalised/Approved, labour hours, staff, times
3. Confirm no transcript / Drive IDs / secrets
4. `/reports` → filter by date / staff / client / project → Preview (no PDF yet)
5. Create → Validate → Generate → Download Completion Register
6. Staff user: only Staff Work Report; other jobs 403

## Future boundaries

Email delivery and Drive archival are out of scope. Do not post to Xero or payroll.
