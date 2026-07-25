# Phase 3C — Job completion (timesheets, labour, machinery, materials)

## Architecture

Approved, processed jobs can be converted into a **manager-confirmed job completion
record** with labour, travel, machinery, materials, invoice-ready description, and
payroll-oriented hour totals.

```
Approved job (3B)
    → Generate / create completion draft (heuristic + optional OpenAI enrichment)
    → Manager edits rows + billable confirmation
    → Ready for Final Review
    → Finalise (read-only)
    → Explicit Reopen (audited)
```

**Boundaries:** structured output only. No invoice creation, no payroll posting, no Xero.

## Data model discovery

| Existing | Finding |
|---|---|
| `tbl_job_completions` / `tbl_job_labour` / `tbl_job_machinery` / `tbl_job_materials` | **Did not exist** — created by Phase 3C Setup migration |
| `tbl_materials` / `tbl_equipment` / `tbl_job_sheet_lines` | Declared-only legacy repos; **not reused** (unknown live columns) |
| `tbl_job_sheets.travel_time` | Free-text from Phase 3A — completion stores explicit `travel_minutes` on labour rows |
| Pricing / rate tables | **None** — no `unit_cost` / `unit_price` / billable amounts |

### New tables (no pricing columns)

See Setup helper `migrateSchemaForJobCompletion()` headers in `JobCompletion.js`:

- `tbl_job_completions` — header + totals + audit metadata + `version`
- `tbl_job_labour` — timesheet rows
- `tbl_job_machinery` — equipment duration rows
- `tbl_job_materials` — quantity rows (no rates)

## Workflow states

| `completion_status` | Meaning |
|---|---|
| `Draft` | Editable working copy |
| `Ready for Final Review` | Manager marked ready |
| `Finalised` | Read-only; requires explicit reopen |
| `Reopened` | Editable again after audited reopen |

Eligibility to create/generate: `processing_status=Completed` **and** `approval_status=Approved`.

If approval stops being Approved, a **non-finalised** completion becomes **blocked** (no further edits/finalise). An already **Finalised** record is left unchanged when the job review is later reopened.

## Role matrix

| Capability | staff | manager | admin |
|---|---|---|---|
| View own labour rows on assigned job | yes | yes | yes |
| View machinery / materials / internal notes | no | yes | yes |
| Create / generate / edit / finalise / reopen | no | yes | yes |
| List all completions | no | yes | yes |

## FastAPI endpoints

| Method | Path | Role |
|---|---|---|
| GET | `/api/v1/jobs/{id}/completion` | staff (scoped) / manager / admin |
| POST | `/api/v1/jobs/{id}/completion` | manager / admin (empty draft) |
| POST | `/api/v1/jobs/{id}/completion/generate` | manager / admin |
| PATCH | `/api/v1/jobs/{id}/completion` | manager / admin |
| POST | `/api/v1/jobs/{id}/completion/finalise` | manager / admin |
| POST | `/api/v1/jobs/{id}/completion/reopen` | manager / admin |
| GET | `/api/v1/completions` | manager / admin |

Errors: `403` unauthorised, `404` missing, `409` stale version, `422` validation, `502` upstream.

Client-supplied totals are **ignored**; server/Apps Script recomputes from rows.

## Apps Script actions

- `get_job_completion`
- `create_job_completion_draft`
- `generate_job_completion_draft`
- `update_job_completion`
- `finalise_job_completion`
- `reopen_job_completion`
- `list_job_completions`

Lock: `Utils.withLock("JOB_COMPLETION_" + job_sheet_id)`.
Concurrency token: `expected_version`.

## Calculation rules

For each labour row:

- `gross_minutes = finish - start` (same-day only; overnight not supported)
- `net_labour_minutes = gross_minutes - break_minutes`
- `labour_hours` derived server-side (2 d.p. display)
- `travel_minutes` stored separately; never folded into labour
- Reject negative break; reject break > gross; flag shifts over 12 hours

## Billable classification

Each labour / machinery / material row has:

- `billable` boolean (default **false** for AI drafts)
- `confirmation_status`: `Suggested` | `Confirmed` | `Excluded`

AI never makes a row billable or Confirmed. Manager must confirm or exclude before finalise.

## AI extraction

Primary: deterministic `fieldosBuildCompletionDraftFromJob_` / `build_completion_draft_from_job`.

Optional Apps Script enrichment via `OpenAI.chatComplete` when `OPENAI_API_KEY` is set.
Candidate JSON keys: `work_summary`, `invoice_description`, `labour_entries`,
`machinery_entries`, `material_entries`, `variations`, `warnings`, `overall_confidence`.

Rules: no fabricated staff IDs, rates, prices, or times; blank when unknown;
contradictory lunch → warning; “all day” without times → warning.

## Finalisation requirements

Block when:

- job not Approved / not Completed
- missing work_summary or invoice_description
- invalid time arithmetic
- Suggested rows remain
- unresolved contradictory warnings without `override_reason`
- already Finalised / stale version

Override allowed only for non-arithmetic warning classes; actor + reason audited.

## Audit

`tbl_sync_logs` with `target_system=FieldOS_Completion`.
Never logs full transcript, internal notes body, auth tokens, API keys, or Drive IDs.

## Deployment steps (manual — do not auto-run from agents)

1. In Apps Script, paste `JobCompletionHelpers.js`, `JobCompletion.js`, updated `FieldOSGateway.js`, `Router.js`, `Setup.js`, `Repositories.js`.
2. Run `migrateSchemaForJobCompletion()` once (creates/extends sheets).
3. Deploy a new Apps Script Web App version.
4. Rebuild/restart FieldOS API + web containers on the target commit.
5. Do **not** reprocess recordings or mutate production jobs during deploy verification.

## Rollback

1. Redeploy previous Apps Script Web App version.
2. Revert FieldOS API/web to prior image/commit.
3. New completion sheets may remain empty (harmless).

## Controlled verification plan (job `21759f5d`) — prepare only

Do **not** execute from CI/agents against production:

1. Confirm job remains Approved + Completed.
2. Generate completion draft.
3. Expect suggestions for seven trees, earthworks/driveway, Luke/assigned labour, lunch contradiction warning.
4. Confirm no invented rates/prices.
5. Enter start/finish/break manually; verify net hours.
6. Leave travel blank unless entered.
7. Save draft; two-tab stale save → 409.
8. Mark Ready; attempt finalise with Suggested rows → blocked.
9. Confirm rows; finalise; reopen with reason; check audit metadata.

## Performance & isolation (post-3C hotfix)

Job detail and completion are strictly decoupled to prevent a slow/extra Apps Script
round-trip on job open:

- `get_job_detail` returns only core job fields + recording summaries + review fields.
  It never reads completion tables, never calls OpenAI, acquires no locks, writes nothing,
  and runs no migrations.
- `get_job_detail` skips the `tbl_projects` / `tbl_customers` master scans when the job row
  already carries a customer name; otherwise it does targeted single-record lookups.
- Sanitised stage timing is logged (`fieldos_timing: get_job_detail`) with per-stage ms only —
  no transcript, notes, Drive IDs, or customer text.
- Read-only editor diagnostic: `testFieldOSGetJobDetailTiming('21759f5d')`.
- The frontend `JobCompletionPanel` is **lazy** — it fetches `GET /jobs/{id}/completion`
  only when the user opens it, so opening a job is a single `get_job_detail` request and
  completion slowness/failure never blocks core detail rendering.
- `get_job_completion` treats missing completion tabs (pre-migration) as "no completion"
  instead of throwing, keeping the panel request fast and safe.

## Future Xero / payroll boundary

Completion totals and confirmed billable flags are staging inputs only.
Xero invoice lines and payroll exports are out of scope until authoritative rate tables exist.
