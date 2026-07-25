# Phase 3B — Manager review, editing, and approval

## Workflow states

| `approval_status` | Meaning |
|---|---|
| `Pending Review` | Awaiting manager action |
| `Approved` | Manager approved; ordinary edits blocked until reopen |
| `Returned for Correction` | Returned to staff with `return_reason` |

Approve requires `processing_status=Completed`.

## Role matrix

| Capability | staff | manager | admin |
|---|---|---|---|
| View assigned job review fields | yes | yes | yes |
| View any job (not assigned) | no | yes | yes |
| Edit review fields | no | yes* | yes* |
| Approve | no | yes | yes |
| Return | no | yes | yes |
| Reopen Approved | no | yes | yes |
| Expand full `ai_transcript` | no | yes | yes |

\* Ordinary edit of an **Approved** job is rejected — use **Reopen** first.

### Temporary demo role mapping

- Staff: `DEMO_STAFF_*` (role `Field Staff`)
- Manager: `DEMO_MANAGER_*` (role `Manager`, enabled by `DEMO_MANAGER_ENABLED=true`)

Documented in `fieldos/.env.example`. Replace with real auth later.

## FastAPI endpoints

| Method | Path | Role |
|---|---|---|
| GET | `/api/v1/jobs` | manager / admin |
| GET | `/api/v1/jobs/{id}/review` | staff (assigned) / manager / admin |
| PATCH | `/api/v1/jobs/{id}/review` | manager / admin |
| POST | `/api/v1/jobs/{id}/approve` | manager / admin |
| POST | `/api/v1/jobs/{id}/return` | manager / admin |
| POST | `/api/v1/jobs/{id}/reopen` | manager / admin |

Query: `include_transcript=true` on GET review (manager/admin only).

Manager list query filters:

- `days` (1–90)
- `processing_status`
- `approval_status`
- `search` (job ID, customer, or project)

`GET /api/v1/jobs/mine` remains assignment-scoped for staff. Managers/admins use
`GET /api/v1/jobs`; staff calling it receive `403`.

## Apps Script actions

- `get_job_detail` — review fields; optional `include_transcript`; `actor_role`
- `list_jobs_for_review` — manager/admin list across assignments; summary allowlist only
- `update_job_review`
- `approve_job_sheet`
- `return_job_sheet`
- `reopen_job_sheet`

## Field mapping

Editable: `ai_summary`, `client_requests`, `variations`, `safety_issues`, `manager_review_items`, `weather`, `travel_time`, `manager_notes`  
Read-only: `ai_confidence_score`  
Approval metadata: `approval_status`, `approved_by`, `approved_at`, `returned_by`, `returned_at`, `return_reason`

Missing optional columns are skipped (header-safe) with warnings; `approval_status` is required.

## Concurrency

Optimistic check via:

- `expected_approval_status`
- `expected_processing_completed_at`

Mismatch → HTTP **409** / Apps Script `Conflict:…`

Writes run under `Utils.withLock("JOB_REVIEW_" + job_sheet_id)`.

## Audit

`tbl_sync_logs` via `SyncRepository` (`target_system=FieldOS_Review`). Payload includes action, actor, statuses, fields changed, return_reason presence — **never** full transcript.

## Deployment steps (manual)

1. Run Setup migration (or add columns) for: `manager_notes`, `approved_by`, `approved_at`, `returned_by`, `returned_at`, `return_reason` on `tbl_job_sheets` if missing.
2. Paste updated `FieldOSGateway.js`, `Router.js`, `Setup.js` into Apps Script; Save.
3. Deploy new Web App version.
4. Set FieldOS `.env` manager demo vars if testing locally.
5. Restart FieldOS API.
6. Do **not** auto-reprocess jobs.

## Rollback

1. Redeploy previous Apps Script Web App version.
2. Revert FieldOS frontend/API containers to prior image/commit.
3. Approval columns can remain (harmless).

## Manual test plan (job `21759f5d`)

1. Login as manager (`manager@nativegrace.com` locally).
2. Open job → Manager review section; confirm AI fields.
3. Save a clearly marked test `manager_notes` value **only in a non-prod / approved test window**.
4. Login as staff → confirm Approve hidden/403.
5. Manager Approve → confirm `approved_by` / `approved_at`.
6. Ordinary edit while Approved → rejected.
7. Reopen → Pending Review.
8. Return with reason → status + reason set.
9. Two tabs: approve in A, stale save in B → 409 + refresh.

Do not execute production mutations automatically from CI/agents.
