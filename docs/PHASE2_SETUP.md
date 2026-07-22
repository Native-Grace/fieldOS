# Phase 2 Setup Guide (Apps Script mode)

Use this guide to run FieldOS against live Apps Script + Shared Drive recordings.  
**Do not commit `.env`, webhook secrets, or service-account JSON.**

---

## 0. Stay on mock until ready

```bash
cd fieldos
# Ensure DATA_MODE=mock in your existing .env
docker compose up -d
curl -fsS http://localhost:8000/api/v1/health
```

UI: http://localhost:8080

---

## 1. Generate a secure webhook secret

```bash
openssl rand -hex 32
```

Use the same value in:

1. Apps Script Script Property `WEBHOOK_SECRET`
2. FieldOS `.env` → `APPS_SCRIPT_WEBHOOK_SECRET`

Never put this value in the frontend, Git, or query strings.

---

## 2. Configure Apps Script Script Properties

In the Apps Script project (Project Settings → Script properties):

| Property | Notes |
|---|---|
| `WEBHOOK_SECRET` | Value from step 1 |
| `SPREADSHEET_ID` | Existing production spreadsheet (already required by production code) |
| `RECORDINGS_FOLDER_ID` | Shared Drive folder for voice notes (same folder FieldOS uploads into) |

---

## 3. Deploy Apps Script gateway (manual)

Repo already contains:

- `apps-script/FieldOSGateway.js`
- `apps-script/Router.js` (wired for FieldOS actions)

In the Google Apps Script editor (when you choose to update the live deployment):

1. Add/update `FieldOSGateway` from `apps-script/FieldOSGateway.js`.
2. Update `Router` from `apps-script/Router.js` (or equivalent wiring).
3. Deploy a **new** Web App version (Execute as: Me; Who has access: Anyone — auth is `webhook_secret`).
4. Copy the Web App URL into FieldOS `.env` as `APPS_SCRIPT_WEBAPP_URL`.

**Do not** rename Sheets tabs/columns.

Optional (not required for FieldOS Phase 2): review `apps-script-proposed/DOGET_MERGE_PROPOSAL.md` for consolidating conflicting `doGet` recorder entry points. FieldOS does **not** use Apps Script `doGet` for recording.

---

## 4. Confirmed live sheet column headers

Set FieldOS `.env` to match live `tbl_job_sheets`:

```bash
JOB_ASSIGNMENT_COLUMN=staff_id
JOB_DATE_COLUMN=date
JOB_PROJECT_COLUMN=project_id
JOB_CUSTOMER_COLUMN=customer_name   # not on job sheet; display via project→customer lookup TBD
```

| Mapping | Live header | Status |
|---|---|---|
| Assignment | `staff_id` | Confirmed |
| Date | `date` | Confirmed |
| Project | `project_id` | Confirmed |
| Customer | `customer_name` | **Absent** from `tbl_job_sheets` — gateway resolves via `tbl_projects` / `tbl_customers` when rows match; otherwise empty |

Map demo login to a real assignment value, e.g. local test account staff ID **`STAFF-9012C021`**:

```bash
DEMO_STAFF_ID=STAFF-9012C021
```

---

## 5. Google Drive requirements

| Requirement | Value / notes |
|---|---|
| Scope used by FieldOS | `https://www.googleapis.com/auth/drive` (full Drive; **not** `drive.file` / `drive.readonly`) |
| Folder type | **Shared Drive** folder (`RECORDINGS_FOLDER_ID`) |
| Service account role | **Content manager** (or write + delete) on that Shared Drive / folder |
| API | All Drive file ops use `supportsAllDrives=True` |
| Host credential path | `fieldos/secrets/service-account.json` (**gitignored** — never commit) |
| Container mount | `./secrets/service-account.json:/app/secrets/service-account.json:ro` (see `docker-compose.yml`) |
| Env | `GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/service-account.json` |

Create the host file before starting Compose:

```bash
mkdir -p fieldos/secrets
# place service-account.json there (do not commit)
```

---

## 6. Local FieldOS `.env` for apps_script mode

Edit `fieldos/.env` (do not commit):

```bash
DATA_MODE=apps_script
APPS_SCRIPT_WEBAPP_URL=https://script.google.com/macros/s/XXXX/exec
APPS_SCRIPT_WEBHOOK_SECRET=<same as WEBHOOK_SECRET>
APPS_SCRIPT_TIMEOUT_SECONDS=30

RECORDINGS_FOLDER_ID=<shared-drive-folder-id>
GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/service-account.json

JOB_ASSIGNMENT_COLUMN=staff_id
JOB_DATE_COLUMN=date
JOB_PROJECT_COLUMN=project_id
JOB_CUSTOMER_COLUMN=customer_name

DEMO_STAFF_ID=STAFF-9012C021
```

---

## 7. Restart Docker and check readiness

```bash
cd fieldos
docker compose up --build -d
curl -fsS http://localhost:8000/api/v1/health
curl -fsS http://localhost:8000/api/v1/ready
```

Expect:

- `data_mode` = `apps_script`
- `checks.apps_script_configured` = true
- `checks.drive_upload_configured` = true

---

## 8. Phase 2 verification checklist

Run against a known assigned job (smoke used `21759f5d`). Prefer **one** short recording; do not retry failed register loops.

| # | Check | How |
|---|---|---|
| 1 | `/ready` | `curl -fsS http://localhost:8000/api/v1/ready` → apps_script + Apps Script + Drive configured |
| 2 | `jobs/mine` | Login → `GET /api/v1/jobs/mine` returns assigned jobs |
| 3 | Job detail | `GET /api/v1/jobs/{id}` returns job + existing recordings |
| 4 | Recording upload | UI recorder or `POST .../recordings` with short `audio/webm` |
| 5 | `tbl_recordings` row | Upload Success + new `recording_id`; detail count +1 |
| 6 | Frontend display | Job detail lists the new recording (`Saved`) |
| 7 | Process queue | `POST /api/v1/jobs/{id}/process` → Success / “queued”; `processing_status` → `Queued` |
| 8 | Drive orphan check | After Success, Drive file exists and is not trashed; after register failure, orphan cleaned |
| 9 | Secret-log check | API logs must not contain webhook secrets, private keys, access tokens, or full credential JSON |

Safe smoke notes:

- Keep audio short (a few seconds).
- Never print `.env`, tokens, or Drive URLs in shared logs.
- Manual Apps Script editor helper: `testFieldOSListJobs()` in `FieldOSGateway.js` (replace staff id before run; editor only).

---

## 9. Switch safely back to mock

```bash
# In fieldos/.env
DATA_MODE=mock

docker compose up -d
curl -fsS http://localhost:8000/api/v1/ready
```

Mock mode does not call live Sheets/Drive for job reads or recording storage.

---

## 10. Deploy / mutate gate

Do not:

- Commit secrets or `.env`
- Redeploy Apps Script unless explicitly approved
- Deploy FieldOS to AWS from this guide alone

## 11. Known issues / future work

| Item | Notes |
|---|---|
| Customer enrichment | Requires live confirmation of `tbl_projects` / `tbl_customers` headers (`project_name`, `customer_id`, `customer_name`). Lookup code is in `FieldOSDisplayLookup.js` and degrades safely when rows/columns are missing. |
| `doGet` conflict | **Deferred.** Phase 2 FieldOS uses **doPost only**. See `apps-script-proposed/DOGET_MERGE_PROPOSAL.md`. Do not merge `doGet` as part of Phase 2. |
| Local Python | Backend Docker image is 3.12; recreate local venv with `python3.12` (see `fieldos/README.md`). |