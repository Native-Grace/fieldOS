# FieldOS AWS Deployment Plan

**Document status:** Design proposal  
**Date:** 2026-07-18  
**Companion docs:** `FIELDOS_ARCHITECTURE.md`, `API_INTEGRATION_PLAN.md`  
**Constraint:** Do not deploy yet. Do not modify Odoo. Do not modify Apps Script production files.

**Legend:** **Proposed** = FieldOS deployment design · **Assumption** = host-specific detail to confirm on the live server · **Confirmed** = from repo (e.g. `.gitignore` excludes `.env*`)

---

## 1. Goals

- Run FieldOS on the **same AWS server as Odoo**.
- Keep Odoo **native** and unmodified.
- Run FieldOS **separately** with Docker Compose.
- Give FieldOS its **own** application directory, configuration, services, and logs.
- Put **Nginx** in front on a **separate subdomain** with TLS.
- Include health checks, backups, logging, and rollback.
- Never expose Apps Script / Google secrets to the browser.

---

## 2. Host coexistence model (proposed)

```text
AWS EC2 (or equivalent)  — Assumption: single Ubuntu host
│
├── Odoo (native systemd/service)     ← DO NOT MODIFY
│     ports / db / addons (existing)
│
├── Host Nginx (or existing reverse proxy)  — Assumption: already used for Odoo
│     ├── odoo.<domain>      → Odoo
│     └── fieldos.<domain>   → FieldOS (new server block only)
│
└── /opt/nativegrace-fieldos/         ← FieldOS only
      docker compose stack
      .env, logs, backups, data
```

**Hard rule:** FieldOS install scripts and Compose files must not restart, reconfigure, upgrade, or bind over Odoo’s ports/files.

---

## 3. Proposed installation directory

```text
/opt/nativegrace-fieldos/
├── docker-compose.yml
├── .env                          # secrets; mode 600; not in git
├── .env.example                  # committed template only (in repo deploy/)
├── VERSION                       # deployed git sha or image tag
├── nginx/
│   └── fieldos.conf              # snippet for host Nginx include (optional copy)
├── data/
│   └── (optional local volumes)
├── logs/
│   ├── api/
│   ├── web/
│   └── deploy/
├── backups/
│   ├── env/
│   └── volumes/
└── scripts/
    ├── deploy.sh
    ├── backup.sh
    ├── restore.sh
    └── rollback.sh
```

**Assumption:** `/opt` is writable by the deploy user; adjust if the organisation standard differs (`/srv/nativegrace-fieldos/` is an acceptable alternate — pick one and document on the host).

Git checkout for releases may live at `/opt/nativegrace-fieldos/src` **or** images may be pulled from a registry with only Compose files on the host. Prefer **image tags + Compose** for production once CI exists; for first bring-up, Compose build from a checked-out tag is acceptable.

---

## 4. Docker Compose services (proposed)

| Service | Image / build | Role |
|---|---|---|
| `api` | Build `fieldos/backend` | FastAPI + Uvicorn |
| `web` | Build `fieldos/frontend` (static) **or** Nginx serving built assets | Mobile web UI |
| `proxy` (optional) | `nginx:alpine` | Internal reverse proxy if host Nginx only forwards to one port |

**Phase 1 minimum:** `api` + static `web`. Prefer host Nginx → `api:8000` and `web:80` **or** single internal nginx service on `127.0.0.1:8080`.

### 4.1 Recommended Compose shape (conceptual — not implementation)

```yaml
# conceptual outline only
services:
  api:
    build: ./backend
    env_file: .env
    restart: unless-stopped
    ports:
      - "127.0.0.1:18080:8000"   # localhost only
    volumes:
      - ./logs/api:/var/log/fieldos
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/api/v1/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  web:
    build: ./frontend
    restart: unless-stopped
    ports:
      - "127.0.0.1:18081:80"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/"]
      interval: 30s
      timeout: 5s
      retries: 3
```

**No FieldOS Postgres required in Phase 1** if Sheets remain system of record. If auth needs local storage, add a dedicated `db` service **only for FieldOS**, on the Compose network, not shared with Odoo’s database.

---

## 5. Ports (proposed)

| Listener | Bind | Purpose |
|---|---|---|
| Host `:443` / `:80` | public | Existing Nginx (Odoo + new FieldOS vhost) |
| `127.0.0.1:18080` | localhost | FieldOS API container |
| `127.0.0.1:18081` | localhost | FieldOS web static |
| Odoo ports | **unchanged** | Whatever Odoo already uses |

**Precaution:** never publish FieldOS ports on `0.0.0.0` if host Nginx already terminates TLS. Localhost bind avoids accidental public exposure of the app without auth headers/TLS.

Confirm free ports on the host before choosing `18080`/`18081` (**Assumption**).

---

## 6. Nginx configuration approach (proposed)

### 6.1 Principles

- Add a **new server block** for `fieldos.<domain>` only.
- Do not edit Odoo’s upstream definitions except where a shared include file is the organisation standard — prefer a separate file under `/etc/nginx/sites-available/fieldos.conf`.
- Reload Nginx (`nginx -t && systemctl reload nginx`), never blindly restart under load without test.

### 6.2 Conceptual vhost

```nginx
# conceptual — not deployed by this document
server {
  listen 443 ssl http2;
  server_name fieldos.example.com;

  # ssl_certificate ...;  # see SSL section

  client_max_body_size 25m;

  location /api/ {
    proxy_pass http://127.0.0.1:18080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location / {
    proxy_pass http://127.0.0.1:18081;
    proxy_set_header Host $host;
  }
}
```

HTTP `:80` should redirect to HTTPS for the FieldOS hostname only.

---

## 7. SSL approach (proposed)

| Option | When to use |
|---|---|
| **Let’s Encrypt (certbot)** | Preferred if DNS for `fieldos.<domain>` points at this host |
| **Existing wildcard cert** | If org already terminates `*.domain` on this Nginx |
| **ACM + attach** | If TLS is terminated on an AWS load balancer in front of the instance |

**Proposed default:** Let’s Encrypt certificate dedicated to `fieldos.<domain>`, managed by certbot deploy hooks that only reload Nginx.

**Precaution:** do not replace or overwrite Odoo certificates; use a distinct certificate name / path.

---

## 8. Environment variables (proposed)

All secrets via env (repo already ignores `.env*`). Example names for `/opt/nativegrace-fieldos/.env`:

### 8.1 Required for Phase 1

| Variable | Purpose |
|---|---|
| `FIELDOS_ENV` | `production` |
| `FIELDOS_BASE_URL` | `https://fieldos.<domain>` |
| `JWT_SECRET` | Sign access tokens |
| `SPREADSHEET_ID` | Same spreadsheet Apps Script uses (**confirmed property name**) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` | Sheets/Drive auth |
| `RECORDINGS_FOLDER_ID` | Drive folder (**confirmed Script Property name**) |
| `APPS_SCRIPT_WEBAPP_URL` | Deployed Apps Script URL |
| `APPS_SCRIPT_WEBHOOK_SECRET` | Maps to Apps Script `WEBHOOK_SECRET` (**confirmed**) |
| `CORS_ORIGINS` | FieldOS origin only |

### 8.2 Optional / later

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` / `GEMINI_API_KEY` | Not required for Phase 1 UI if processing stays in Apps Script |
| `QB_TIME_ACCESS_TOKEN` | Not Phase 1 |
| `LOG_LEVEL` | `INFO` / `DEBUG` |
| `MAX_UPLOAD_MB` | Align with Nginx `client_max_body_size` |

### 8.3 Security rules

- `.env` mode `600`, owned by deploy user.
- Back up `.env` encrypted to `backups/env/`.
- Never bake secrets into images.
- Never inject webhook secret into frontend build args.

---

## 9. Health checks, logging, backups

### 9.1 Health checks (proposed)

| Check | Target |
|---|---|
| Docker `api` healthcheck | `GET /api/v1/health` |
| Docker `web` healthcheck | `GET /` |
| Readiness | `GET /api/v1/ready` (Sheets credential + spreadsheet open) |
| External | Uptime monitor on `https://fieldos.<domain>/api/v1/health` |

### 9.2 Logging (proposed)

| Stream | Destination |
|---|---|
| API stdout | Docker logging + optional ship to `/opt/nativegrace-fieldos/logs/api` |
| Nginx access/error | Host Nginx logs; separate `fieldos` log files if possible |
| Deploy actions | `/opt/nativegrace-fieldos/logs/deploy/deploy-YYYYMMDD.log` |

Retain at least 14 days locally; do not log raw audio or secrets.

### 9.3 Backups (proposed)

| Asset | Frequency | Location |
|---|---|---|
| `.env` (encrypted) | On each deploy + weekly | `backups/env/` |
| Compose + `VERSION` | On each deploy | `backups/releases/` |
| FieldOS-only DB volume (if added) | Daily | `backups/volumes/` |
| Google Sheets / Drive | **Existing Google-side retention** — FieldOS does not replace this | N/A |

**Note:** Phase 1 system of record is Google; FieldOS backups focus on **config, auth store, and release artifacts**, not duplicating the entire spreadsheet.

---

## 10. Deployment commands (proposed runbook — do not execute yet)

Conceptual sequence for operators:

```bash
# 1. Confirm Odoo healthy BEFORE any FieldOS change
#    (use existing Odoo health URL/process check — Assumption)

# 2. Fetch release
cd /opt/nativegrace-fieldos
cp .env .env.bak.$(date +%Y%m%d%H%M%S)
# place new compose/images/tag; write VERSION

# 3. Validate compose
docker compose config

# 4. Bring up / upgrade FieldOS only
docker compose pull   # if using registry
docker compose up -d --remove-orphans

# 5. Verify FieldOS
curl -fsS https://fieldos.<domain>/api/v1/health
curl -fsS https://fieldos.<domain>/api/v1/ready

# 6. Re-verify Odoo still healthy
#    (same check as step 1)

# 7. Nginx (only if vhost changed)
sudo nginx -t && sudo systemctl reload nginx
```

---

## 11. Rollback process (proposed)

1. **Immediate traffic rollback (Nginx):** point `fieldos.<domain>` upstream back to previous localhost ports/containers if blue/green used; or:
2. **Compose rollback:**
   ```bash
   cd /opt/nativegrace-fieldos
   # restore previous compose + VERSION + images tag
   docker compose up -d
   ```
3. **Env rollback:** restore `.env` from `backups/env/` if config caused failure.
4. **Nginx config rollback:** restore previous `fieldos.conf` from sites-available backup; `nginx -t && reload`.
5. **Verify Odoo** after every rollback (FieldOS rollback must not require Odoo changes).

Keep at least the **previous two** image tags / release directories.

---

## 12. Precautions to avoid affecting Odoo

| Precaution | Detail |
|---|---|
| Separate directory | Only `/opt/nativegrace-fieldos` |
| Separate Compose project name | e.g. `name: nativegrace-fieldos` |
| No shared Docker network with Odoo DB | Unless a future integration explicitly requires it |
| No changes to Odoo systemd units | FieldOS scripts must not `systemctl restart odoo` |
| No shared Postgres | FieldOS never uses Odoo’s database |
| Localhost binds | Avoid port collisions on public interfaces |
| Separate Nginx site file | Do not edit Odoo site file contents |
| Separate TLS cert paths | Do not overwrite Odoo certs |
| Resource limits | Set Compose `mem_limit`/`cpus` so FieldOS cannot starve Odoo (**Assumption:** size after observing host) |
| Pre/post checks | Always health-check Odoo before and after FieldOS deploys |
| Firewall | Only 80/443 public; FieldOS app ports localhost-only |
| Cron | FieldOS backup cron must be named clearly and must not touch Odoo paths |

---

## 13. First-time bring-up checklist (proposed)

1. DNS `A`/`CNAME` for `fieldos.<domain>` → host.
2. Confirm Odoo baseline health and document it.
3. Create `/opt/nativegrace-fieldos` with correct ownership.
4. Place `.env` with Sheets/Drive/Apps Script values.
5. Start Compose on localhost ports.
6. Add Nginx site + TLS.
7. Run health/ready checks.
8. Smoke-test login + My Jobs + one recording against a **non-production** job if available; otherwise a designated test job sheet.
9. Confirm AppSheet still reads/writes Sheets normally.
10. Confirm Odoo still healthy.

---

## 14. Out of scope for this plan

- Actually deploying or changing the live server.
- Modifying Odoo.
- Changing Apps Script.
- CI/CD pipeline implementation (recommended follow-up).

---

*End of AWS_DEPLOYMENT_PLAN.md*
