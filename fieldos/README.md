# Native Grace FieldOS — Phase 1 (local)

Mobile-friendly field app for **My Jobs** and **voice recording**, talking to a FastAPI backend that proxies Apps Script processing secrets server-side.

## What this Phase includes

- Login (JWT + bcrypt; replaceable later)
- My Jobs (last 7 days, assigned staff only)
- Job detail (processing status / errors / recordings)
- Voice recorder (MediaRecorder, pause/resume, playback, retry)
- Audio upload with progress
- Optional Apps Script `process_voice_dictation` proxy
- Docker Compose local stack

## Modes

| `DATA_MODE` | Behaviour |
|---|---|
| `mock` (default) | Local demo jobs/recordings — no live Sheets |
| `apps_script` | FastAPI → Apps Script (proposed gateway + confirmed `process_voice_dictation`); Drive upload for audio |

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

Apps Script `WEBHOOK_SECRET` is **never** sent to the browser. Set `APPS_SCRIPT_WEBAPP_URL` + `APPS_SCRIPT_WEBHOOK_SECRET` in `.env` to proxy real enqueue calls.

## Backend tests (without Docker)

```bash
cd fieldos/backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pytest -q
```

## Frontend dev (optional)

```bash
cd fieldos/frontend
npm install
npm run dev
```

Vite proxies `/api` to `http://localhost:8000`.

## Safety

- Does not modify Odoo
- Does not modify `apps-script/` production files
- Does not rename Google Sheet tables/columns
- Does not deploy to AWS
- Does not change production data when `DATA_MODE=mock`
