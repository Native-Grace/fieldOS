# Native Grace FieldOS — local app (Phases 1–2)

Mobile-friendly field app for **My Jobs** and **voice recording**, talking to a FastAPI backend that proxies Apps Script secrets server-side and uploads audio to Google Drive.

## What this includes

- Login (JWT + bcrypt; replaceable later)
- My Jobs (last 7 days, assigned staff only)
- Job detail (processing status / errors / recordings)
- Voice recorder (MediaRecorder, pause/resume, playback, retry)
- Audio upload with progress → Drive + `tbl_recordings`
- Apps Script `process_voice_dictation` proxy
- Docker Compose local stack

## Modes

| `DATA_MODE` | Behaviour |
|---|---|
| `mock` (default) | Local demo jobs/recordings — no live Sheets |
| `apps_script` | FastAPI → Apps Script gateway + confirmed `process_voice_dictation`; Drive upload for audio |

See `docs/PHASE2_SETUP.md` before enabling `apps_script`.

## Quick start (Docker)

```bash
cd fieldos
cp .env.example .env
docker compose up --build -d
curl -fsS http://localhost:8000/api/v1/health
open http://localhost:8080
```

Demo login (from `.env.example`):

- Email: `alex@nativegrace.com`
- Password: `FieldOS-Demo-2026!`

For live Apps Script smoke, set `DEMO_STAFF_ID` to the assigned sheet value (verified test account: `STAFF-9012C021`) and configure Drive + Apps Script as in Phase 2 setup.

## API (browser → FieldOS only)

| Method | Path |
|---|---|
| GET | `/api/v1/health` |
| GET | `/api/v1/ready` |
| POST | `/api/v1/auth/login` |
| GET | `/api/v1/jobs/mine` |
| GET | `/api/v1/jobs/{id}` |
| POST | `/api/v1/jobs/{id}/recordings` |
| POST | `/api/v1/jobs/{id}/process` |

Apps Script `WEBHOOK_SECRET` is **never** sent to the browser. Set `APPS_SCRIPT_WEBAPP_URL` + `APPS_SCRIPT_WEBHOOK_SECRET` in `.env` for live mode.

## Drive credentials (apps_script recordings)

| Item | Value |
|---|---|
| Host file | `fieldos/secrets/service-account.json` (gitignored) |
| Mount | `./secrets/service-account.json:/app/secrets/service-account.json:ro` |
| Env | `GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/service-account.json` |
| Scope | Full Drive (`https://www.googleapis.com/auth/drive`) |
| Folder | Shared Drive folder ID in `RECORDINGS_FOLDER_ID`; SA as Content manager |

## Confirmed live column defaults

```bash
JOB_ASSIGNMENT_COLUMN=staff_id
JOB_DATE_COLUMN=date
JOB_PROJECT_COLUMN=project_id
JOB_CUSTOMER_COLUMN=customer_name   # not on tbl_job_sheets
```

## Backend tests (without Docker)

Requires **Python 3.12** locally (matches `Dockerfile`; see `.python-version`).

```bash
cd fieldos/backend
# Recreate venv on 3.12 (do not reuse a 3.9 venv):
#   brew install python@3.12   # macOS, if needed
rm -rf .venv
python3.12 -m venv .venv
source .venv/bin/activate
python -V   # expect Python 3.12.x
pip install -r requirements.txt
pytest -q
```

Do not delete an existing `.venv` unless you are ready to recreate it with the commands above.
## Frontend dev (optional)

```bash
cd fieldos/frontend
npm install
npm run dev
```

Vite proxies `/api` to `http://localhost:8000`.

## Phase 2 verification

Use the checklist in `docs/PHASE2_SETUP.md` (§8): `/ready`, jobs, detail, upload, sheet row, UI, process queue, Drive orphan check, secret-log check.

## Safety

- Does not modify Odoo
- Does not rename Google Sheet tables/columns
- Does not deploy to AWS from this README
- Does not change production data when `DATA_MODE=mock`
- Never commit `.env` or `secrets/`
