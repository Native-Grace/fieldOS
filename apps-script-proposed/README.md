# Apps Script proposed changes (Phase 2)

## Status (repo + live)

Reviewed gateway changes are in the repo (`apps-script/FieldOSGateway.js`, Router wiring).

**Verified with FieldOS `DATA_MODE=apps_script`:** list jobs, job detail, Drive upload, `register_recording`, process queue.

Live Web App URL / secrets remain in local `.env` only (never commit). Further Apps Script editor deploys are still a manual gate.

## Files in this folder

| File | Purpose |
|---|---|
| `FieldOSGateway.js` | Canonical proposed source (kept for review history; mirrored in `apps-script/`) |
| `FieldOSDisplayLookup.js` | Project/customer display-name helpers (mirrored in `apps-script/`) |
| `README.md` | Merge / deploy guide |
| `DOGET_MERGE_PROPOSAL.md` | Inventory + plan for conflicting Apps Script `doGet` recorder entry points. **Deferred:** Phase 2 FieldOS uses doPost only; do not merge `doGet` for Phase 2. |
| `DoGetMerged.js` | Proposed sole `doGet` implementation for review only — **not** wired into production `Router.js` |
| `FieldOSDisplayDiagnostics.js` | Read-only diagnostics + gated master seed apply + `testFieldOSDisplayResolveSample` (editor-only dual-read sample; not a doPost AuthZ bypass) |
| `VoiceProcessing.js` | Queue facade `VoiceProcessing.executePipeline` + OpenAI Whisper FieldOS bridge (mirrored from `apps-script/`). Skips `Invalid` and already-`Processed` recordings. |
| `OpenAI.js` | Whisper `transcribeAudio` helper (mirrored from `apps-script/`) |
| `FieldOSGateway.js` | Includes `invalidate_recording` / `delete_recording` (Drive cleanup before row delete) |
| `RatesFinancialHelpers.js` | Phase 3E pure money/rate-resolution helpers (integer cents, half-up per line). Mirrors `fieldos/backend/app/services/rates_math.py` |
| `RatesFinancial.js` | Phase 3E `FieldOSRatesFinancial` — rate cards, labour/machinery rates, material catalog, customer pricing, payroll/Xero mappings, pricing readiness, financial snapshots |
| `Repositories.js` | Adds the nine Phase 3E repositories (`RC`, `LR`, `MR`, `MATC`, `CP`, `PM`, `XM`, `CFS`, `CFL`) |
| `Setup.js` | Adds `migrateSchemaForRatesFinancial()` and `migrateSchemaForJobReports()` — non-destructive tab/column creation |
| `Router.js` | Routes the 28 Phase 3E actions plus the 9 Phase 3F report actions |
| `JobCompletion.js` | Completion reads used by pricing readiness |
| `JobReportHelpers.js` | Phase 3F pure report helpers — forbidden-key scrub, display-only task lines, filters, grouping, page estimate, PDF data shape, filenames, audit payload |
| `JobReports.js` | Phase 3F `FieldOSJobReports` — report options, preview, report batches (Draft → Validated → Generated / Cancelled) and single-job PDF data |
| `DocumentDeliveryHelpers.js` | Phase 3G pure delivery/attachment helpers — PDF profiles, client scrub, idempotency, attachment allowlists |
| `DocumentDelivery.js` | Phase 3G `FieldOSDocumentDelivery` — delivery drafts, attachment metadata, audit (PDF/email/Drive gated in FastAPI) |
| `Repositories.js` | Also adds the two Phase 3F repositories (`RPT`, `RPI`) and Phase 3G (`DLV`, `ATT`) |
| `Setup.js` | Adds `migrateSchemaForRatesFinancial()`, `migrateSchemaForJobReports()`, and `migrateSchemaForDocumentDelivery()` |

### Phase 3E deploy note

Push `RatesFinancialHelpers.js` and `RatesFinancial.js` alongside the updated Gateway / Router /
Repositories / Setup / JobCompletion, then run `migrateSchemaForRatesFinancial()` against a
non-production spreadsheet first. The migration seeds no rate values — managers enter them via
the `/rates` UI. See `docs/PHASE3E_RATES_AND_FINANCIAL_STAGING.md`.

### Phase 3F deploy note

Push `JobReportHelpers.js` and `JobReports.js` alongside the updated Gateway / Router /
Repositories / Setup, then run `migrateSchemaForJobReports()` against a non-production
spreadsheet first. The migration only creates `tbl_report_batches` and
`tbl_report_batch_items`. Report batches freeze scrubbed report **data** in
`snapshot_json` — never PDF bytes, transcripts, Drive identifiers or secrets. Generated
batches are immutable; regenerating means creating a new batch.

### Phase 3G deploy note

Push `DocumentDeliveryHelpers.js` and `DocumentDelivery.js` alongside Gateway / Router /
Repositories / Setup, then run `migrateSchemaForDocumentDelivery()`. Leave
`DOCUMENT_EMAIL_ENABLED` and `DOCUMENT_DRIVE_FILING_ENABLED` false until providers are
wired. Sends always require `confirm_send=true` — there is no auto-send. See
`docs/PHASE3G_PDF_DELIVERY_AND_ATTACHMENTS.md`.

### Live verification (Phase 2 voice path)

- Job `21759f5d` completed end to end via Queue → `VoiceProcessing.executePipeline` → OpenAI Whisper.
- Invalid recordings skipped; valid recording processed; `processing_status=Completed`; `processing_error` cleared.
- Customer/project dual-read enrichment already live separately.
- Do **not** commit secrets, transcripts, Drive IDs, or execution logs.

## Remaining manual steps in Google Apps Script (after approval)

1. In the live Apps Script project, add/update script file `FieldOSGateway` with contents of `apps-script/FieldOSGateway.js`.
2. Replace live `Router` with contents of `apps-script/Router.js` (or apply the same three edits).
3. Deploy a **new** Web App version (Execute as: Me; Who has access: Anyone — matching `appsscript.json`).
4. Copy the Web App URL into FieldOS `.env` as `APPS_SCRIPT_WEBAPP_URL` (only when ready).
5. Ensure Script Property `WEBHOOK_SECRET` matches FieldOS `APPS_SCRIPT_WEBHOOK_SECRET`.
6. Confirm live sheet headers for assignment/date/project/customer; set FieldOS env column mappings. **Do not rename sheet columns.**
7. Keep FieldOS `DATA_MODE=mock` until you explicitly switch to `apps_script`.

## Notes

- `register_recording` writes via `DB.insertRecord('tbl_recordings', ...)`.
- Large audio must **not** be posted to Apps Script; FieldOS uploads to Drive then calls `register_recording`.
- Existing `process_voice_dictation` is unchanged.
