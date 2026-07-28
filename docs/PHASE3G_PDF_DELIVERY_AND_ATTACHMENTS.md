# Phase 3G — PDF delivery, document control, and job attachments

Manager-confirmed PDF delivery with privacy profiles, optional private Drive
filing, delivery audit, reissue/supersede, and job attachments.

**No automatic email. No automatic Drive upload. No Xero/payroll posting.**

## Phase 3G.1 — live Apps Script orchestration

With `DATA_MODE=apps_script`, FastAPI owns the delivery lifecycle for:

`preview_delivery`, `validate_delivery`, `send_delivery`, `retry_delivery`,
`cancel_delivery`, `supersede_delivery`, `update_delivery_draft`

Flow:

1. Load draft from Apps Script (`get_delivery`)
2. Validate actor role (manager/admin)
3. Load report/job PDF snapshot from Apps Script
4. Apply selected PDF privacy profile
5. Render PDF in FastAPI + checksum (bytes never stored in Sheets)
6. Validate recipient / method / profile
7. Require `confirm_send=true` on send/retry
8. Enforce idempotency key
9. Call email / Drive provider gates (default off → structured Failed/skipped)
10. Persist outcome via Apps Script `record_delivery_outcome`

Apps Script also exposes `update_delivery_draft` and safe diagnostic
`testFieldOSDocumentDeliveryModule()` (`defined`, `supported_actions`,
`delivery_tables_present`, `attachment_tables_present` only).

Attachment bytes are stored under FastAPI `LOCAL_RECORDINGS_DIR/attachments/…`
(`local://…` refs); only metadata is written to Sheets.

## Architecture

```
Manager UI (DeliveryPanel)
    │  create draft → preview → validate → confirm_send
    ▼
FastAPI /deliveries/*  +  /attachments/*
    │  render PDF from frozen report/job snapshot via profile allowlist
    │  email_send_allowed / drive_filing_allowed gates (off in mock/local/test)
    ▼
Apps Script FieldOSDocumentDelivery  (metadata + audit only)
    │  tbl_document_deliveries / tbl_job_attachments
    ▼
Optional: SMTP/API provider  |  private Drive writer
```

PDF bytes are rendered in FastAPI (ReportLab), same as Phase 3F. Sheets never
store PDF blobs. Drive file IDs may be stored on delivery rows for managers but
never appear on client-facing PDF payloads.

## Privacy model

| Profile | Audience | Notes |
|---|---|---|
| Internal Job Sheet | internal | may include internal notes / warnings |
| Client Job Summary | client | strips notes, warnings, payroll, costs, mappings, AI metadata, Drive IDs |
| Staff Work Record | internal | staff labour focus |
| Completion Register | internal | register layout |

Client allowlist + explicit denylist are enforced in `delivery_math.apply_pdf_profile`.

## Schema

### `tbl_document_deliveries`

`delivery_id`, `report_batch_id`, `job_sheet_id`, `completion_id`, `document_type`,
`recipient_type`, `recipient_email`, `delivery_method`, `status`, `sent_by`,
`sent_at`, `failed_at`, `failure_reason`, `checksum`, `template_version`,
`supersedes_delivery_id`, `idempotency_key`, `drive_file_id` (internal),
`attachment_ids_json`, `subject`, `body_preview`, `created_by`, `created_at`, `version`

States: **Draft → Ready → Sent | Failed | Cancelled**; Sent/Failed → **Superseded**
(replacement Draft created).

### `tbl_job_attachments`

`attachment_id`, `job_sheet_id`, `completion_id`, `attachment_type`, `file_name`,
`mime_type`, `byte_size`, `caption`, `uploaded_by`, `uploaded_at`, `client_visible`,
`approved_by`, `approved_at`, `storage_ref`, `checksum`, `status`, `version`

Types: photo, plan, receipt, signed_document, other. Executables rejected.

Migration: `migrateSchemaForDocumentDelivery()`.

## Endpoints

| Method | Path | Role |
|---|---|---|
| GET | `/api/v1/deliveries/options` | manager |
| GET | `/api/v1/deliveries` | manager |
| GET | `/api/v1/deliveries/{id}` | manager |
| POST | `/api/v1/deliveries` | manager (draft) |
| PATCH | `/api/v1/deliveries/{id}` | manager |
| POST | `/api/v1/deliveries/{id}/preview` | manager |
| POST | `/api/v1/deliveries/{id}/validate` | manager |
| POST | `/api/v1/deliveries/{id}/send` | manager (`confirm_send=true`) |
| POST | `/api/v1/deliveries/{id}/retry` | manager |
| POST | `/api/v1/deliveries/{id}/cancel` | manager |
| POST | `/api/v1/deliveries/{id}/supersede` | manager |
| GET | `/api/v1/jobs/{id}/attachments` | staff/manager |
| POST | `/api/v1/attachments` | staff/manager |
| DELETE | `/api/v1/attachments/{id}` | manager |
| POST | `/api/v1/attachments/{id}/client-visible` | manager |

## Apps Script actions

`delivery_options`, `list_deliveries`, `get_delivery`, `create_delivery_draft`,
`update_delivery_draft`, `record_delivery_outcome`, `list_attachments`,
`upload_attachment`, `set_attachment_client_visible`
(+ Router aliases for FastAPI lifecycle names; FastAPI orchestrates PDF/gates).

Files: `DocumentDeliveryHelpers.js`, `DocumentDelivery.js`,
`delivery_orchestrator.py`, Setup/Gateway/Router/Repositories.

## Delivery lifecycle

1. Create Draft (recipient + profile + method)
2. Preview subject/body
3. Validate → Ready (renders PDF, sets checksum + idempotency key)
4. Explicit Confirm send (`confirm_send=true`)
5. Email/Drive gates: mock/local/test always refuse real send; download_only can mark Sent
6. Failed → Retry (still requires confirm)
7. Sent/Failed → Supersede → new Draft (new Drive file on next send)

Idempotency key: `sha256(batch|job|doc|email|checksum|template)`.

## Attachment lifecycle

Upload (MIME/size/extension allowlist) → Uploaded → manager marks client-visible
(Approved) → optional include on delivery draft. Delete soft-sets Deleted.

**Antivirus boundary:** FieldOS enforces allowlists; malware scanning is an ops
control at storage. FieldOS never creates public links.

## Config (all default off)

- `DOCUMENT_EMAIL_ENABLED=false`
- `DOCUMENT_EMAIL_PROVIDER=`
- `DOCUMENT_DRIVE_FILING_ENABLED=false`
- `DOCUMENT_DRIVE_ROOT_FOLDER_ID=`
- `MAX_ATTACHMENT_MB=15`

## Deployment

1. Push Apps Script: `DocumentDeliveryHelpers.js`, `DocumentDelivery.js`, Gateway/Router/Repositories/Setup
2. Run `migrateSchemaForDocumentDelivery()` once
3. Redeploy backend + frontend
4. Leave email/Drive flags **false** until provider + private folder are configured
5. Do not enable auto-send (there is no auto-send flag — confirm is always required)

## Rollback

Code rollback leaves empty delivery/attachment tables unused.

## Manual verification

1. Manager opens job → Deliver PDF → create draft → preview → validate → confirm send
2. Mock: email method ends Failed with gate reason; download_only can Sent
3. Client profile PDF has no internal notes / Drive IDs
4. Attachment `.exe` rejected; `.jpg` uploads; client-visible requires manager
5. Staff cannot POST `/deliveries`

## Future boundaries

Wire real SMTP/API + Shared Drive folder writer behind the existing gates.
Do not add public links or automatic sends.
