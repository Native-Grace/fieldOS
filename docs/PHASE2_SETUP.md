# Phase 2 Setup Guide (Apps Script mode)

**Do not deploy until you explicitly approve.** This guide prepares local FieldOS to talk to Apps Script after you manually merge and deploy the proposed gateway.

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
| `RECORDINGS_FOLDER_ID` | Drive folder for voice notes (already used by `RecorderWebApp.js`) |

---

## 3. Merge proposed gateway (manual)

1. Review `apps-script-proposed/FieldOSGateway.js` and `apps-script-proposed/README.md`.
2. Add the file to the Apps Script project.
3. Wire `Router.js` as described in the proposed README (secret compare + new actions + `data` in JSON responses).
4. **Do not** rename Sheets tabs/columns.

---

## 4. Deploy a new Apps Script Web App version

1. Deploy → New deployment → Web app  
2. Execute as: **Me**  
3. Who has access: **Anyone** (matches current `appsscript.json`; auth is `webhook_secret`)  
4. Copy the Web App URL.

---

## 5. Confirm live sheet column headers

Before switching FieldOS modes, export header row of `tbl_job_sheets` and set:

```bash
JOB_ASSIGNMENT_COLUMN=...   # staff assignment column as it actually appears
JOB_DATE_COLUMN=...
JOB_PROJECT_COLUMN=...
JOB_CUSTOMER_COLUMN=...
```

Defaults (`assigned_staff_id`, `job_date`, `project_name`, `customer_name`) are **assumptions**.

---

## 6. Local FieldOS `.env` for apps_script mode

Edit `fieldos/.env` (do not commit):

```bash
DATA_MODE=apps_script
APPS_SCRIPT_WEBAPP_URL=https://script.google.com/macros/s/XXXX/exec
APPS_SCRIPT_WEBHOOK_SECRET=<same as WEBHOOK_SECRET>
APPS_SCRIPT_TIMEOUT_SECONDS=30

# Drive upload from FastAPI (required for recordings in apps_script mode)
RECORDINGS_FOLDER_ID=<drive folder id>
GOOGLE_APPLICATION_CREDENTIALS=/path/inside/container/to/service-account.json
```

Mount the service account JSON into the API container (update `docker-compose.yml` volumes) so the path is valid. Share the Drive folder with the service account email.

Map demo login `DEMO_STAFF_ID` / email to a real `tbl_staff` identity used in assignment column values.

---

## 7. Restart Docker and check

```bash
cd fieldos
docker compose up --build -d
curl -fsS http://localhost:8000/api/v1/health
curl -fsS http://localhost:8000/api/v1/ready
```

Expect `ready.data_mode` = `apps_script` and `checks.apps_script_configured` = true.

Login smoke:

```bash
TOKEN=$(curl -fsS -X POST http://localhost:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"YOUR_EMAIL","password":"YOUR_PASSWORD"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

curl -fsS http://localhost:8000/api/v1/jobs/mine -H "Authorization: Bearer $TOKEN"
```

---

## 8. Switch safely back to mock

```bash
# In fieldos/.env
DATA_MODE=mock
# Optional: clear APPS_SCRIPT_* if desired

docker compose up -d
curl -fsS http://localhost:8000/api/v1/ready
```

Mock mode does not call live Sheets/Drive for job reads or recording storage.

---

## 9. Approval gate

Stop here until you approve:

1. Merging `FieldOSGateway.js` into production Apps Script  
2. Deploying a new Web App version  
3. Pointing local/staging FieldOS at that URL with real secrets  

No AWS deploy and no production data mutation are performed by this repository’s Phase 2 code path until you configure and approve the above.
