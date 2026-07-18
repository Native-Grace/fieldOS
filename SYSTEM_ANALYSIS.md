# Native Grace FieldOS — Production System Analysis

**Analysis date:** 2026-07-18  
**Scope:** Repository contents only (`README.md`, `.gitignore`, `apps-script/**`)  
**Constraint:** No Apps Script production files were modified for this analysis.

**Legend**

- **Confirmed:** Directly evidenced by repository source.
- **Assumption:** Inferred from naming, comments, README, or incomplete code paths; not fully implemented or verified in-repo.

---

## 1. Executive summary

This repository currently contains the **exported Apps Script production backend** plus empty placeholders for FieldOS (`fieldos/`), docs (`docs/`), and schema (`schema/`). There is **no FieldOS application code** yet.

**Confirmed** from code: the Apps Script project implements:

- An HTTP webhook gateway (`doPost` / `routeRequest`) that queues voice-dictation jobs.
- A time-based queue worker (`Queue` / `queueProcessAll`) intended to process job sheets.
- A custom HTML voice recorder web app (`Recorder.html` + save helpers).
- OpenAI Whisper / GPT-4o client helpers (`OpenAI`).
- Gemini multimodal transcription for recordings (`VoiceProcessingService`).
- QuickBooks Time staff and task sync (`QuickBooksTimeService`).
- A Sheets ORM layer (`DB` + `BaseRepository` + typed repositories).
- A one-off schema migration for manager-approval columns (`migrateSchemaForManagerApproval`).

**Critical gap:** Several workflows described as operational in `README.md` (AI job-sheet processing end-to-end, daily summaries, manager approval, PDF generation) are **not fully present** in this export. Notably:

- `Queue.processNext` calls `VoiceProcessing.executePipeline`, but **no `VoiceProcessing` object or `executePipeline` function exists**.
- `DailySummaryPdf.js` does **not** contain PDF/daily-summary logic; it is a duplicate recorder `doGet`.
- Multiple conflicting `doGet` / `saveRecording` definitions exist in the same project.

**Bottom line:** The repo documents an intended production architecture that is only partially implemented in the checked-in Apps Script sources. FieldOS migration planning must treat missing pipeline pieces and duplicate entry points as first-class risks.

---

## 2. Current architecture

### Confirmed components

```text
[AppSheet field UI]  (Assumption: primary UI — stated in README, not in-repo)
        |
        | HTTP webhook (doPost) OR Apps Script task (appsheetTriggerRoute)
        v
[Apps Script Web App / Project]
  Router.js      -> auth + action routing + queue enqueue
  Queue.js       -> claim jobs, call voice pipeline, log sync
  Recorder*.js   -> HTML recorder UI + Drive save
  VoiceProcessing.js -> Gemini transcription + ai_audit write
  OpenAI.js      -> Whisper + GPT-4o helpers (no in-repo callers)
  QuickBooksTime.js -> staff/tasks sync into Sheets
  DB / Repositories -> Google Sheets I/O
        |
        v
[Google Sheets]  (via SPREADSHEET_ID)
        |
        +--> Google Drive (recording files)
        +--> OpenAI API / Gemini API
        +--> QuickBooks Time (TSheets) API
```

### Deployment model (confirmed)

From `apps-script/appsscript.json`:

| Setting | Value |
|---|---|
| Runtime | V8 |
| Time zone | `Australia/Sydney` |
| Exception logging | `STACKDRIVER` |
| Web app executeAs | `USER_DEPLOYING` |
| Web app access | `ANYONE_ANONYMOUS` |

### Repository layout (confirmed)

| Path | Status |
|---|---|
| `apps-script/` | Full Apps Script export (17 files) |
| `fieldos/backend/`, `fieldos/frontend/` | Empty directories |
| `docs/`, `schema/` | Empty directories |
| `README.md` | High-level product intent |
| `SYSTEM_ANALYSIS.md` | This document |

---

## 3. Apps Script file inventory and purpose of each file

| File | Stated / observed purpose | Notes |
|---|---|---|
| `appsscript.json` | Project manifest (timezone, webapp ACL, V8) | Confirmed |
| `Config.js` | Script property accessors + queue status constants | Confirmed |
| `Code.js` | Empty stub `myFunction()` | Obsolete placeholder |
| `Router.js` | HTTP gateway: `doPost`, `routeRequest`, `appsheetTriggerRoute`, alternate `doGet` | Confirmed |
| `Queue.js` | Background worker, trigger management, job claim/process | Confirmed; calls missing pipeline |
| `Database.js` | Sheets ORM (`DB`) with lock-protected writes | Confirmed |
| `BaseRepository.js` | Repository factory over `DB` | Confirmed |
| `Repositories.js` | Concrete repositories for schema tables | Confirmed; `RecordingRepository` constructor mismatch |
| `Utilities.js` | `Utils` helpers: stack traces, JSON responses, locks | Confirmed |
| `OpenAI.js` | Whisper transcription + GPT-4o JSON chat | Confirmed module; **no callers in repo** |
| `VoiceProcessing.js` | Gemini transcription of recordings + `tbl_ai_audit` logging | Confirmed as `VoiceProcessingService` |
| `QuickBooksTime.js` | QB Time users/tasks sync into `tbl_staff` / `tbl_tasks` | Confirmed |
| `Setup.js` | Schema migration for approval columns | Confirmed |
| `Recorder.html` | Client-side voice recorder UI | Confirmed |
| `RecorderWebApp.js` | `doGet` for recorder + `saveRecording` (Drive + Sheets) | Confirmed |
| `Recordert.js` | Alternate `serveRecorder_` + alternate `saveRecording` | Confirmed duplicate / conflicting |
| `DailySummaryPdf.js` | Filename implies PDF; content is another recorder `doGet` | Confirmed misnamed / obsolete duplicate |

---

## 4. Apps Script entry points

### HTTP entry points

| Function | File | Confirmed behaviour |
|---|---|---|
| `doPost(e)` | `Router.js` | Parses JSON body, validates `webhook_secret`, calls `routeRequest`, returns JSON via `Utils.createJsonResponse` |
| `doGet(e)` | `Router.js` | If `mode=recorder`, calls `serveRecorder_(e)`; else returns plain HTML `"Native Grace FieldOS"` |
| `doGet(e)` | `RecorderWebApp.js` | Serves `Recorder.html` template with `job_sheet_id`, `user_identity`, `return_url` |
| `doGet(e)` | `DailySummaryPdf.js` | Same as `RecorderWebApp.js` recorder serve (duplicate) |

**Confirmed conflict:** three global `doGet` definitions. In Apps Script, duplicate globals collide; which one wins depends on project load order and is not defined in this repo.

### Callable / automation entry points

| Function | File | Purpose |
|---|---|---|
| `routeRequest(payload)` | `Router.js` | Internal action router |
| `appsheetTriggerRoute(job_sheet_id, user_identity, force_reprocess)` | `Router.js` | Native AppSheet → Apps Script task bypass (no webhook secret check) |
| `queueProcessAll()` | `Queue.js` | Time-driven trigger handler |
| `Queue.triggerWorker()` | `Queue.js` | Creates one-shot trigger for `queueProcessAll` after 500ms |
| `triggerVoiceProcessing(jobSheetId)` | `VoiceProcessing.js` | Manual/AppSheet target for Gemini transcription path |
| `saveRecording(payload)` | `RecorderWebApp.js` **and** `Recordert.js` | Client-callable from `google.script.run` (**duplicate**) |
| `serveRecorder_(e)` | `Recordert.js` | Recorder HTML serve used by `Router.js` `doGet` |
| `runStaffDirectorySync()` | `QuickBooksTime.js` | Manual QB staff sync |
| `runTaskListSync()` | `QuickBooksTime.js` | Manual QB task sync |
| `migrateSchemaForManagerApproval()` | `Setup.js` | Adds approval columns |
| `testDoPost()` | `Router.js` | Manual webhook simulation |
| `testProcessNextQueuedJob()` | `Queue.js` | Manual queue step |
| `testQueueFirstDraftJobSheet()` | `Queue.js` | Enqueue first eligible job |

### Triggers (confirmed in code, not in `appsscript.json`)

- **Dynamic time-based trigger:** `ScriptApp.newTrigger('queueProcessAll').timeBased().after(500).create()` in `Queue.triggerWorker`.
- No installable triggers are declared in `appsscript.json` (dependencies empty).
- **Assumption:** QB Time sync and schema migration are run manually or via external schedule not present in-repo.

### Empty / unused

| Function | File |
|---|---|
| `myFunction()` | `Code.js` (empty body) |

---

## 5. API routes and expected request / response formats

There is **no REST framework**. Routing is action-based JSON over the deployed Web App URL.

### `POST` — `doPost` (`Router.js`)

**Request body (JSON):**

```json
{
  "action": "process_voice_dictation | execute_worker",
  "job_sheet_id": "<required for process_voice_dictation>",
  "user_identity": "<optional, logged in tests>",
  "force_reprocess": false,
  "webhook_secret": "<required; must match Script Property WEBHOOK_SECRET>"
}
```

**Supported actions (confirmed):**

| `action` | Behaviour |
|---|---|
| `process_voice_dictation` | Validates job exists; skips if `processing_status === "Completed"` unless `force_reprocess === true`; sets status `Queued`; writes sync log; triggers worker |
| `execute_worker` | Calls `Queue.triggerWorker()` |

Any other action → error: `Routing Failure: Action '<action>' is unsupported.`

**Success response** (`Utils.createJsonResponse`):

```json
{
  "status": "Success",
  "action": "<action>",
  "message": "<human message>",
  "record_id": "<job_sheet_id or null>",
  "timestamp": "<ISO-8601>"
}
```

**Error response:**

```json
{
  "status": "Error",
  "action": "<action or unknown>",
  "message": "<error.toString()>",
  "record_id": "<job_sheet_id or null>",
  "timestamp": "<ISO-8601>"
}
```

### `GET` — recorder / default

**Confirmed query params (recorder paths):**

| Param | Used by |
|---|---|
| `mode=recorder` | `Router.js` `doGet` → `serveRecorder_` |
| `job_sheet_id` | All recorder serves |
| `user_identity` | Template injection |
| `return_url` | `RecorderWebApp.js` / `DailySummaryPdf.js` / `Recorder.html` (not set by `serveRecorder_`) |

### Client RPC — `saveRecording` (from `Recorder.html`)

**Payload sent by HTML (confirmed):**

```json
{
  "job_sheet_id": "...",
  "user_identity": "...",
  "duration_seconds": 0,
  "audio_base64": "<base64 webm>"
}
```

**Expected success shape (`RecorderWebApp.js`):**

```json
{
  "status": "Success",
  "message": "Recording saved.",
  "recording_id": "...",
  "recording_file_url": "...",
  "recording_drive_file_id": "...",
  "recording_order": 1
}
```

**Alternate shape (`Recordert.js`):** `{ success: true, recording_id, ... }` and expects `base64_audio` / `mime_type` — **incompatible** with `Recorder.html`.

### Native AppSheet call — `appsheetTriggerRoute`

**Args:** `(job_sheet_id, user_identity, force_reprocess)`  
**Returns:** string `"Success: ..."` or throws.  
**Confirmed:** does **not** require `webhook_secret`.

---

## 6. Google Sheets tables and columns referenced in code

There is **no formal schema file** in `schema/`. Columns below are reconstructed from code references only. Tables listed in `Repositories.js` but never written/read elsewhere are marked **declared only**.

### Tables with repository bindings (`Repositories.js`)

| Table | Key column | ID prefix | Usage in repo |
|---|---|---|---|
| `tbl_customers` | `customer_id` | `CUST` | Declared only |
| `tbl_projects` | `project_id` | `PROJ` | Declared only |
| `tbl_staff` | `staff_id` | `STAFF` | Written by QB sync |
| `tbl_tasks` | `task_id` | `TASK` | Written by QB sync |
| `tbl_job_sheets` | `job_sheet_id` | `JS` | Queue + router |
| `tbl_job_sheet_lines` | `line_id` | `JSL` | Declared only |
| `tbl_materials` | `material_line_id` | `MAT` | Declared only |
| `tbl_equipment` | `equipment_line_id` | `EQ` | Declared only |
| `tbl_follow_ups` | `follow_up_id` | `FU` | Declared only |
| `tbl_photos` | `photo_id` | `PH` | Declared only |
| `tbl_sync_logs` | `log_id` | `LOG` | Written widely |
| `tbl_ai_audit` | `audit_id` | `AI` | Written by VoiceProcessingService (raw sheet) / repo declared |
| `tbl_recordings` | `recording_id` | `REC` | Recorder + VoiceProcessing |

### Additional table (no repository)

| Table | Referenced by |
|---|---|
| `tbl_daily_job_summaries` | `Setup.js` migration only |

### Columns referenced by table

#### `tbl_job_sheets` (confirmed fields touched)

- `job_sheet_id`
- `processing_status` — values from `Config.QUEUE_STATUS`: `Queued`, `Processing`, `Completed`, `Failed`, `Cancelled`
- `processing_error`
- `processing_started_at`
- `processing_completed_at`
- `approval_status` — set to `"Pending Review"` on queue failure; column added by migration

#### `tbl_recordings` — **schema conflict across modules**

**Written by `RecorderWebApp.js` / `Recordert.js`:**

- `recording_id`, `job_sheet_id`
- `recording_file_url`, `recording_drive_file_id`, `recording_name`, `recording_order`
- `duration_seconds`, `transcript`, `status` (`Saved`), `created_by`, `created_at`

**Read/written by `VoiceProcessingService`:**

- `recording_id`, `job_sheet_id`
- `transcription` (not `transcript`)
- `status` (`Processed` / `Error: Transcription Failed`)
- `audio_file` **or** `file_path` (not Drive file id/url fields)

#### `tbl_sync_logs` (confirmed create payload keys)

- `log_id` (auto via repository if present)
- `record_id`
- `target_system` — examples: `HTTP_ROUTER`, `AppSheet_Webhook`, `APPS_SCRIPT_TASK`, `Queue_Worker`, `Recorder_Web_App`
- `status` — `Success` / `Failed`
- `request_payload`, `response_payload`, `timestamp`

#### `tbl_ai_audit` (confirmed)

- `audit_id`, `job_sheet_id`, `request_payload`, `response_payload`, `timestamp`
- Initial response written as `"PENDING_ANALYSIS"`

#### `tbl_staff` (confirmed)

- `staff_id`, `staff_name`, `email`, `is_active`, `quickbooks_time_user_id`, `role` (default `"Field Staff"` on create)
- Note: QB sync creates IDs as `"STF_" + uuid`, while repository prefix is `STAFF`

#### `tbl_tasks` (confirmed)

- `task_id`, `task_name`, `quickbooks_time_jobcode_id` (auto-added if missing)

#### `tbl_daily_job_summaries` (confirmed migration only)

- Adds `approved_by`, `approved_at` if missing
- **No other columns referenced in code**

#### Declared-only tables

No column usage found for: `tbl_customers`, `tbl_projects`, `tbl_job_sheet_lines`, `tbl_materials`, `tbl_equipment`, `tbl_follow_ups`, `tbl_photos`.

**Assumption:** those tables exist in the live spreadsheet for AppSheet UI / future AI structuring, but business logic for them is absent from this export.

---

## 7. Data flow between AppSheet, Google Sheets, Apps Script, OpenAI and QuickBooks Time

### Confirmed flows

#### A. Voice processing enqueue (AppSheet → Apps Script → Sheets)

1. AppSheet (Assumption) calls either:
   - HTTP `doPost` with `action: "process_voice_dictation"` + `webhook_secret`, or
   - Apps Script task `appsheetTriggerRoute(...)`.
2. `routeRequest` loads job from `tbl_job_sheets`, sets `processing_status = Queued`.
3. Writes row to `tbl_sync_logs`.
4. `Queue.triggerWorker` creates time-based trigger → `queueProcessAll`.

#### B. Queue worker (Apps Script → intended AI pipeline)

1. `Queue.processNext` finds first `Queued` job, claims it as `Processing`.
2. Calls `VoiceProcessing.executePipeline(jobToProcess)` — **function missing in repo**.
3. On success path: sets `processing_completed_at` (status update assumed inside missing pipeline).
4. On failure: sets `Failed`, `approval_status = "Pending Review"`, logs to `tbl_sync_logs`.

#### C. Alternate transcription path (Sheets + Drive + Gemini)

1. `triggerVoiceProcessing(jobSheetId)` → `VoiceProcessingService.processJobSheetRecordings`.
2. Reads `tbl_recordings`, resolves audio via Drive filename from `audio_file`/`file_path`.
3. Calls Gemini `gemini-1.5-flash` for transcription.
4. Updates recording row; appends `tbl_ai_audit` with `PENDING_ANALYSIS`.

#### D. Recorder path (Browser → Apps Script → Drive + Sheets)

1. AppSheet opens web app URL (Assumption) with job sheet params.
2. `Recorder.html` records WebM audio, posts base64 via `google.script.run.saveRecording`.
3. File stored in Drive folder (`RECORDINGS_FOLDER_ID` or auto-created folder name).
4. Row inserted into `tbl_recordings`.

#### E. QuickBooks Time sync (QB API → Sheets)

1. Manual `runStaffDirectorySync` / `runTaskListSync`.
2. Fetches users / custom-field task items from `rest.tsheets.com`.
3. Upserts `tbl_staff` / `tbl_tasks`.

#### F. OpenAI

- `OpenAI.transcribeAudio` / `OpenAI.chatComplete` exist.
- **Confirmed: no in-repo caller.**  
- **Assumption:** intended for structured job-sheet extraction after transcription, but not wired in this export.

### README vs code

`README.md` states AI job sheet processing, daily summaries, manager approval, and PDF generation are operational. **Those end-to-end flows are not evidenced as complete in this repository.** Treat README claims as **product intent / live-system claims**, not as confirmed by this codebase snapshot.

---

## 8. Voice recording and AI transcription workflow

### Recording capture (confirmed)

1. Web app serves `Recorder.html`.
2. Browser `MediaRecorder` captures `audio/webm`.
3. Client encodes base64 and calls `saveRecording`.
4. Server writes Drive file + `tbl_recordings` with `status: "Saved"` and empty `transcript`.

### Transcription path A — Gemini (`VoiceProcessingService`) (confirmed, partially disconnected)

1. Load recordings for `job_sheet_id`.
2. Skip if `transcription` present and `status === "Processed"`.
3. Else resolve file by **Drive filename** from `audio_file` or `file_path`.
4. Gemini multimodal generateContent → verbatim transcript.
5. Update row; aggregate segments; write `tbl_ai_audit` with analysis prompt and `PENDING_ANALYSIS`.

**Does not** call GPT for structured extraction. **Does not** update `tbl_job_sheets.processing_status` to `Completed`.

### Transcription path B — OpenAI Whisper (`OpenAI.transcribeAudio`) (confirmed unused)

Available helper only; not integrated into queue or recorder.

### Intended queue path (broken in this export)

`Queue.processNext` → `VoiceProcessing.executePipeline` — **missing**. Therefore the documented AppSheet webhook → queue → AI pipeline cannot complete as written.

### Schema mismatches blocking A↔recorder integration (confirmed)

| Recorder writes | VoiceProcessing expects |
|---|---|
| `transcript` | `transcription` |
| `recording_file_url` / `recording_drive_file_id` | `audio_file` / `file_path` |
| `status: Saved` | treats non-Processed as needing transcription |

---

## 9. Job sheet creation and processing workflow

### Creation

**Not implemented in Apps Script.**  
**Assumption:** AppSheet creates rows in `tbl_job_sheets` (and related child tables) directly in Google Sheets.

### Processing (confirmed intended sequence)

1. External trigger (`doPost` / `appsheetTriggerRoute`) queues job.
2. Worker claims job (`Queued` → `Processing`).
3. Pipeline should run (`VoiceProcessing.executePipeline`) — **missing**.
4. Success should mark completed (comment in `Queue.js` assumes pipeline updates status; worker only sets `processing_completed_at`).
5. Failure marks `Failed` + `approval_status: "Pending Review"`.

### Idempotency (confirmed)

- If `processing_status === "Completed"` and `force_reprocess !== true`, queue request is skipped.
- Claim lock per job id reduces double-processing races.

### Structured AI → line items

Repositories exist for lines/materials/equipment/follow-ups/photos, and OpenAI chat helper supports JSON responses, but **no code maps transcripts into those tables**.

---

## 10. Daily summary workflow

**Confirmed in repo:**

- Table name `tbl_daily_job_summaries` appears only in `Setup.js`.
- Migration adds `approved_by`, `approved_at`.
- Filename `DailySummaryPdf.js` suggests prior/planned PDF feature.

**Not found:**

- Creation of daily summary records
- Aggregation of job sheets by day/staff/project
- Scheduling of daily summary generation
- Any function named for daily summary processing

**Conclusion:** Daily summary workflow is **not analyzable as implemented code** in this export. README claim that daily summaries are operational is **not confirmed by repository contents**.

---

## 11. Manager approval workflow

**Confirmed:**

- `migrateSchemaForManagerApproval()` adds:
  - `tbl_daily_job_summaries.approved_by`, `approved_at`
  - `tbl_job_sheets.approval_status`
- On queue processing failure, `Queue.processNext` sets `approval_status: "Pending Review"`.

**Not found:**

- Functions to approve/reject job sheets or summaries
- AppSheet/API actions for approval
- Status transitions beyond failure → `"Pending Review"`
- Who may approve, notifications, or audit of approvals

**Assumption:** Approval UI lives in AppSheet and/or was never exported. Only schema preparation + failure flagging exist here.

---

## 12. PDF generation workflow

**Confirmed:**

- File `DailySummaryPdf.js` exists by name only.
- File contents are a **duplicate recorder `doGet`**, not PDF generation.
- No uses of `PdfApp`, Docs export, Drive PDF conversion, or HTML-to-PDF templates for summaries.

**Conclusion:** PDF generation workflow is **missing from this repository**. README claim is **not confirmed** by code.

---

## 13. Authentication and security mechanisms

### Confirmed controls

| Control | Detail |
|---|---|
| Webhook shared secret | `doPost` requires `payload.webhook_secret === Config.getWebhookSecret()` (`WEBHOOK_SECRET`) |
| Secret redaction | Sync logs redact webhook secret to `"REDACTED"` on success path |
| Script properties | Secrets stored in `PropertiesService` (not in source) |
| Sheet locks | `LockService` via `Utils.withLock` on DB writes and trigger creation |
| Job claim locks | Per-job claim before processing |

### Confirmed weaknesses / gaps

| Issue | Evidence |
|---|---|
| Web app is `ANYONE_ANONYMOUS` | `appsscript.json` |
| Recorder `doGet` has no secret/auth | Anyone with URL + `job_sheet_id` can open recorder |
| `appsheetTriggerRoute` skips webhook secret | By design comment; callable if Apps Script permissions allow |
| Gemini API key in query string | `VoiceProcessing.js` URL `?key=${apiKey}` |
| `saveRecording` has no webhook secret | Relies on web app session / obscurity |
| Duplicate `doGet`/`saveRecording` | Unpredictable deployed behaviour |
| Hardcoded test job id | `triggerVoiceProcessing` defaults to `"bcedd86f"` |

---

## 14. Configuration values and secrets expected by the system

### Required Script Properties (confirmed)

| Key | Used by | Required? |
|---|---|---|
| `SPREADSHEET_ID` | `Config`, QB, VoiceProcessing, Setup | Yes for most paths |
| `WEBHOOK_SECRET` | `Config.getWebhookSecret` / `doPost` | Yes for HTTP webhook |
| `OPENAI_API_KEY` | `OpenAI` | Yes if OpenAI used |
| `GEMINI_API_KEY` | `VoiceProcessingService._transcribeAudioFile` | Yes for Gemini path |
| `QB_TIME_ACCESS_TOKEN` | `QuickBooksTimeService` | Yes for QB sync |
| `RECORDINGS_FOLDER_ID` | `RecorderWebApp.saveRecording` via `Config.get` | Yes for that save path |

### Optional / fallback behaviour

| Key / behaviour | Detail |
|---|---|
| `Config.getOptional(key, fallback)` | Generic optional getter (unused by other modules in-repo) |
| VoiceProcessing without `SPREADSHEET_ID` | Falls back to `SpreadsheetApp.getActiveSpreadsheet()` |
| `Recordert.getOrCreateRecordingsFolder_` | Uses folder name `Native Grace FieldOS Recordings` instead of `RECORDINGS_FOLDER_ID` |

### Hardcoded integration constants

| Constant | Location | Meaning |
|---|---|---|
| Custom field shortcode/id `"42811253"` or name `"task"` | `QuickBooksTime.js` `fetchTasks` | QB Time task dropdown lookup |
| Model `whisper-1`, `gpt-4o` | `OpenAI.js` | OpenAI models |
| Model `gemini-1.5-flash` | `VoiceProcessing.js` | Gemini model |
| Timezone `Australia/Sydney` | `appsscript.json` | Project TZ |

No `.env` or secrets files are committed (`.gitignore` excludes `.env*`).

---

## 15. External integrations

| System | Direction | Confirmed endpoints / APIs | Status in code |
|---|---|---|---|
| Google Sheets | R/W | SpreadsheetApp via `SPREADSHEET_ID` | Core datastore |
| Google Drive | R/W | `DriveApp` file create/find for recordings | Recorder + Gemini path |
| AppSheet | Inbound | Webhook/`appsheetTriggerRoute` (Assumption: AppSheet config not in repo) | Partial |
| OpenAI | Outbound | `api.openai.com/v1/audio/transcriptions`, `/v1/chat/completions` | Helper only |
| Google Gemini | Outbound | `generativelanguage.googleapis.com/.../gemini-1.5-flash:generateContent` | Used by VoiceProcessingService |
| QuickBooks Time (TSheets) | Outbound | `rest.tsheets.com/api/v1/users`, `/customfields`, `/customfielditems` | Staff + task sync |
| Stackdriver / Cloud Logging | Logging | `exceptionLogging: STACKDRIVER` | Platform |

**Not present:** Odoo, AWS, email/SMS providers, QuickBooks Online accounting (only Time/TSheets).

---

## 16. Error handling and logging

### Patterns (confirmed)

1. **HTTP gateway try/catch** in `doPost`: logs failure to `tbl_sync_logs` (`target_system: HTTP_ROUTER`), still returns JSON error.
2. **Isolated logging catch:** if sync log write fails, `console.error` only — response still returned.
3. **Queue failures:** update job sheet + `SyncRepository.create` with stack from `Utils.getStackTrace`.
4. **Recorder failures:** return `{ status: "Failed", message }` and attempt sync log.
5. **QB sync:** `console.error` + rethrow; manual runners catch and `Logger.log`.
6. **VoiceProcessing per-recording errors:** mark recording status `Error: Transcription Failed`; aggregate failure throws if no transcripts.
7. **Platform:** Stackdriver exception logging enabled.

### Logging destinations

| Destination | Usage |
|---|---|
| `tbl_sync_logs` | Primary operational audit |
| `tbl_ai_audit` | AI request ledger (transcription aggregate) |
| `Logger.log` / `console.log` / `console.error` / `console.warn` | IDE / Stackdriver |

### Gaps

- No retry/backoff policy for OpenAI/Gemini/QB failures beyond queue re-trigger on iteration limit.
- No alerting/notification on `Failed` jobs.
- Failed Gemini recordings can leave job without aggregated transcript while other recordings succeed.

---

## 17. Duplicate, obsolete or conflicting code

| Issue | Files / symbols | Impact |
|---|---|---|
| Triple `doGet` | `Router.js`, `RecorderWebApp.js`, `DailySummaryPdf.js` | Unpredictable HTTP GET behaviour |
| Dual `saveRecording` | `RecorderWebApp.js`, `Recordert.js` | HTML expects `audio_base64` + `status`; alternate expects `base64_audio` + throws |
| Misnamed PDF file | `DailySummaryPdf.js` | Contains recorder serve, not PDF |
| Dual transcription stacks | Gemini (`VoiceProcessingService`) vs OpenAI Whisper (`OpenAI`) | Unclear production choice |
| Missing pipeline object | `Queue` calls `VoiceProcessing.executePipeline`; only `VoiceProcessingService` exists | Queue path broken |
| Recording schema mismatch | Recorder vs VoiceProcessing column names | Transcription path cannot consume recorder rows as written |
| `RecordingRepository` constructor | Object arg vs `(tableName, keyColumn, idPrefix)` | Likely broken ID generation / table binding |
| Empty stub | `Code.js` `myFunction` | Obsolete |
| Typo filename | `Recordert.js` | Suggests incomplete merge of recorder variants |
| Staff ID prefixes | `STF_` in QB sync vs `STAFF-` in repository | Inconsistent IDs |
| Hardcoded test job | `triggerVoiceProcessing` → `"bcedd86f"` | Dangerous default |

---

## 18. Technical risks and likely bugs

### High severity (confirmed from code)

1. **`VoiceProcessing.executePipeline` does not exist** — queue worker success path cannot run.
2. **Multiple `doGet` / `saveRecording` globals** — production may not match intended router/recorder design.
3. **`RecordingRepository` construction bug** in `Repositories.js`:
   ```js
   new BaseRepository({ tableName: 'tbl_recordings', idField: 'recording_id', idPrefix: 'REC' })
   ```
   `BaseRepository` expects positional args; object becomes `this.tableName`, leaving `keyColumn`/`idPrefix` undefined.
4. **Recorder ↔ VoiceProcessing schema mismatch** (`transcript` vs `transcription`, Drive id vs filename path).
5. **`Recordert.js` calls `Utilities.generateId('REC')`** — Apps Script `Utilities` has no `generateId` (that lives on `DB.generateId`). That save path throws if selected.
6. **Anonymous web app** exposes recorder and (depending on winning `doGet`) other surfaces without auth.

### Medium severity

7. Queue marks `processing_completed_at` even if pipeline only partially succeeded (depends on missing pipeline throwing).
8. `Queue.processNext` returns `true` on claim-lock failure, counting toward iteration limit without progress clarity.
9. Gemini file resolution uses `DriveApp.getFilesByName(...).next()` — ambiguous if duplicate filenames exist.
10. Large audio base64 in Gemini payload may hit Apps Script / API size limits (not handled).
11. `appsheetTriggerRoute` can enqueue without webhook secret.
12. No code ever sets `processing_status` to `Completed` in this export (only Queued/Processing/Failed).

### Lower severity / hygiene

13. Empty `myFunction` stub.
14. `DailySummaryPdf.js` name/content mismatch.
15. OpenAI module dead code relative to current call graph.
16. QB custom field ID hardcoded (`42811253`).

---

## 19. Features that can be reused directly by FieldOS

These are coherent enough to reuse as patterns or ported modules (with fixes noted):

| Feature | Source | Reuse value |
|---|---|---|
| Action-based webhook gateway + secret check | `Router.js` `doPost` / `routeRequest` | Good API shape for migration façade |
| Queue claim + trigger worker pattern | `Queue.js` | Useful async job model (needs pipeline) |
| Sheets ORM + repositories | `Database.js`, `BaseRepository.js`, `Repositories.js` | Temporary compatibility layer during coexistence |
| Sync log / AI audit ledgers | `tbl_sync_logs`, `tbl_ai_audit` usage | Operational observability model |
| OpenAI Whisper + GPT JSON helpers | `OpenAI.js` | Clean integration surface once wired |
| QB Time staff/task sync | `QuickBooksTime.js` | Operational sync; portable to backend job |
| Recorder UX + Drive storage idea | `Recorder.html` + save flow | Field voice capture UX reference |
| Config via secrets store | `Config.js` + Script Properties | Pattern maps to AWS Secrets Manager |
| Locking / concurrency helpers | `Utils.withLock` | Conceptually reusable |

---

## 20. Features that should eventually be migrated out of Apps Script

| Capability | Why migrate |
|---|---|
| AI transcription + structured extraction | Timeout/quota limits; better model orchestration on AWS |
| Background job queue | Apps Script 6-minute limit / fragile triggers (`Queue` already self-retriggers) |
| Voice recorder media upload | Large payloads unsuitable for Apps Script; use direct-to-S3/Drive signed uploads |
| QuickBooks Time sync | Better as scheduled worker with retries/metrics |
| PDF generation / daily summaries | Document pipeline belongs in app services |
| Manager approval workflow | Needs real authZ, audit, multi-user concurrency |
| HTTP API gateway | Replace anonymous Apps Script web app with authenticated FieldOS API |
| Google Sheets as system of record | Long-term: proper DB; Sheets retained only for AppSheet coexistence |

**Assumption:** During migration, Apps Script remains a compatibility façade for AppSheet webhooks while FieldOS takes over processing.

---

## 21. Missing information that prevents complete analysis

The following are required for a complete production picture but are **absent from the repository**:

1. **Live Google Spreadsheet schema export** (headers + sample rows for all `tbl_*` sheets).
2. **AppSheet app definition** (tables, bots, webhooks, column mappings, security filters).
3. **Deployed Apps Script project state** (which file versions are live; which `doGet` wins; installed triggers).
4. **Implementation of `VoiceProcessing.executePipeline`** (or confirmation it never existed in this export).
5. **Daily summary generation and PDF code** (referenced by README/filename, not present).
6. **Manager approval business rules** (states, roles, UI actions).
7. **OpenAI prompt templates / JSON schemas** for job-sheet structuring.
8. **Environment property values** (IDs/secrets themselves — correctly not committed).
9. **Network deployment URLs** (Web App URL, AppSheet webhook targets).
10. **Odoo / AWS FieldOS integration requirements** beyond README goal statement.
11. **Operational runbooks** (how QB sync is scheduled; how failures are triaged).
12. **Contents of empty `schema/`, `docs/`, `fieldos/`** — intended but not yet populated.
13. **Whether Gemini or OpenAI is the production transcription engine.**
14. **Recording column canonical schema** (AppSheet file column vs custom recorder Drive fields).

---

## Appendix A — Confirmed vs assumed production claims

| Claim (from README) | Repo evidence |
|---|---|
| AppSheet is field interface | Assumption (not in repo) |
| Google Sheets is datastore | Confirmed |
| Apps Script contains business logic | Confirmed (partial) |
| QB Time staff sync operational | Code present; runtime ops not verified |
| AI job sheet processing operational | **Not confirmed** — pipeline entry missing |
| Daily summaries operational | **Not confirmed** — no workflow code |
| Manager approval operational | **Not confirmed** — schema prep + failure flag only |
| PDF generation operational | **Not confirmed** — file misnamed/duplicate |

---

## Appendix B — Suggested next analysis inputs (not implementation)

When available, gather (read-only): live sheet header dumps, AppSheet automation export, Apps Script Executions logs for `queueProcessAll` / `doPost`, and confirmation of which recorder/PDF files are deployed. Only then should FieldOS implementation work begin.

---

*End of SYSTEM_ANALYSIS.md — based solely on repository contents as of analysis date.*
