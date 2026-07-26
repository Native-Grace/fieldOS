# Phase 3E — Rates, financial mappings, and priced completion snapshots

## Architecture

Phase 3D staged completions as **hours and items with no money**. Phase 3E adds the missing
rate source of truth and turns a finalised completion into a **priced, immutable financial
snapshot** — still without posting anything to Xero or payroll.

```
Finalised completion (3C) + dashboard/exports (3D)
    → Rate cards / labour / machinery / material catalog        (what things cost)
    → Customer pricing                                          (which card applies)
    → Payroll + Xero mappings                                   (how codes translate)
    → Pricing readiness (blockers, resolved rates, totals preview)
    → Financial snapshot: Draft → Validated → Approved → Superseded
```

**Boundary:** staging only. No Xero API calls, no payroll file posting, no invoice numbers
issued, no GST rate assumed. `draft_reference` (`DRAFT-INV-…`) is a local label, never an
invoice number.

```
React Rates & Financial page (manager/admin)
    → FastAPI /api/v1/rate-cards | /rates/* | /materials/catalog | /pricing/customer
              /mappings/* | /completions/{id}/pricing/readiness | financial-snapshots
        → mock store   OR   Apps Script FieldOSRatesFinancial
            → tbl_rate_cards / tbl_labour_rates / tbl_machinery_rates
            → tbl_material_catalog / tbl_customer_pricing
            → tbl_payroll_mappings / tbl_xero_mappings
            → tbl_completion_financials / tbl_completion_financial_lines
            → tbl_sync_logs (target_system = FieldOS_Rates)
```

Pure calculation lives in two mirrored modules that must stay behaviourally identical:

| Runtime | Module |
|---|---|
| Backend | `fieldos/backend/app/services/rates_math.py` |
| Apps Script | `apps-script/RatesFinancialHelpers.js` |

## Rate resolution precedence

Labour sell/cost/travel rates resolve by **most specific match wins**. The first tier with a
candidate row terminates the search — lower tiers are never consulted.

| # | `rate_source_type` | Match condition |
|---|---|---|
| 1 | `customer_project_override` | row `project_id` = job project (staff/customer must match or be blank) |
| 2 | `customer_override` | row `customer_id` = job customer, blank `project_id` |
| 3 | `staff_specific` | row `staff_id` = labour staff, blank customer/project |
| 4 | `role_activity` | row `role_code` **or** `activity_code` matches, all IDs blank |
| 5 | `default_rate_card` | staff/customer/project/role/activity all blank |

Before tiering, candidates are filtered to **Active + effective on `job_date`**. If customer
pricing resolves a `rate_card_id` for that customer/project/date, candidates are further scoped
to that card; project-scoped customer pricing beats customer-wide pricing. Ties inside a tier
break deterministically on ascending row ID.

Other line types do not tier:

- **Machinery** — `machinery_rate` by `equipment_id`, else exact `equipment_name`, else `charge_code`.
- **Material** — `material_catalog` by `material_id` or `item_code` **only**. Name similarity
  produces *suggestions* in the readiness response and never a price.
- **Non-billable rows** — `non_billable`, sell 0, always carrying an explicit reason string.
- **Nothing found** — `unresolved`: `unit_sell` stays blank and the line records a blocker.
  Zero is never used as a fallback for a missing rate.

The UI shows the precedence chain and the tier number that produced each resolved line.

## Effective dating

- Rate selection uses **`job_date`** (the job sheet calendar date), never `finalised_at` and
  never "today". Repricing an old job after a rate change still returns the old rate.
- `effective_from` / `effective_to` are **inclusive**; blank means open-ended in that direction.
- Dates are normalised to `YYYY-MM-DD` in the spreadsheet timezone via
  `fieldosNormaliseCalendarDate_` / `normalise_calendar_date` before comparison.
- Only `status = Active` rows are considered (material catalog uses `active` where anything
  other than `FALSE` counts as active).
- List endpoints return an `overlaps[]` array whenever two Active rows with the same scope key
  have intersecting ranges. The UI renders this as a warning — overlaps are not rejected at
  write time, because closing one range often has to happen after adding the replacement.
- Rate rows are **never edited in place for history**: to change a price, close the old row with
  an `effective_to` and add a new row.

## Naming deviations from the Phase 3E brief

| Brief | Implemented | Reason |
|---|---|---|
| `tbl_staff_payroll_mappings` | `tbl_payroll_mappings` | Matches existing `tbl_*_mappings` convention |
| `overtime_code` / `travel_code` | `overtime_hours_code` / `travel_hours_code` | Disambiguates hour codes from allowance codes |
| labour `material_id` on completion rows | `catalog_material_id` on `tbl_job_materials` | Avoids clashing with the legacy `tbl_materials.material_line_id` |

`employment_classification` and `award_reference` are stored on payroll mappings but are
**never inferred** — they exist only to carry manager-entered values to a future payroll export.

## Data model

Created by `migrateSchemaForRatesFinancial()` in `apps-script/Setup.js`. Every table carries
`created_by`, `created_at`, `updated_by`, `updated_at`, `version`.

| Table | Key | Scope columns | Value columns |
|---|---|---|---|
| `tbl_rate_cards` | `rate_card_id` (`RC`) | `card_name`, `currency`, `status`, `effective_from/to` | `description`, `notes` |
| `tbl_labour_rates` | `labour_rate_id` (`LR`) | `rate_card_id`, `staff_id`, `customer_id`, `project_id`, `role_code`, `activity_code`, `status`, `effective_from/to` | `unit`, `sell_rate`, `cost_rate`, `travel_rate`, `overtime_rate` |
| `tbl_machinery_rates` | `machinery_rate_id` (`MR`) | `rate_card_id`, `equipment_id`, `equipment_name`, `charge_code`, `status`, `effective_from/to` | `unit`, `sell_rate`, `cost_rate`, `minimum_charge` |
| `tbl_material_catalog` | `material_id` (`MATC`) | `item_code`, `item_name`, `active` | `unit`, `cost_price`, `sell_price`, `tax_code`, `account_code`, `supplier` |
| `tbl_customer_pricing` | `customer_pricing_id` (`CP`) | `customer_id`, `project_id`, `status`, `effective_from/to` | `rate_card_id`, `price_notes` |
| `tbl_payroll_mappings` | `payroll_mapping_id` (`PM`) | `staff_id`, `status`, `effective_from/to` | `employee_reference`, `ordinary_hours_code`, `overtime_hours_code`, `travel_hours_code`, `allowance_code`, `cost_centre`, `pay_calendar` |
| `tbl_xero_mappings` | `xero_mapping_id` (`XM`) | `entity_type`, `local_reference`, `status` | `xero_reference`, `account_code`, `tax_type`, `tax_rate_percent`, `tracking_category`, `tracking_option` |
| `tbl_completion_financials` | `financial_snapshot_id` (`CFS`) | `completion_id`, `job_sheet_id`, `customer_id`, `project_id`, `job_date`, `snapshot_status`, `pricing_status` | `line_count`, `subtotal_ex_tax`, `tax_amount`, `total_inc_tax`, `tax_type`, `tax_rate_percent`, `account_code`, `draft_reference`, `xero_reference`, `blockers`, lifecycle actor/timestamp columns |
| `tbl_completion_financial_lines` | `financial_line_id` (`CFL`) | `financial_snapshot_id`, `completion_id`, `line_number`, `line_type`, `source_row_id` | `description`, `staff_id`, `equipment_id`, `material_id`, `quantity`, `unit`, `unit_sell`, `line_amount_ex_tax`, `tax_type`, `tax_rate_percent`, `tax_amount`, `line_total_inc_tax`, `account_code`, `rate_source_type`, `rate_source_id`, `billable`, `non_billable_reason`, `blockers` |

Repositories are registered in `apps-script/Repositories.js`.

### Migration

`migrateSchemaForRatesFinancial()` is **non-destructive**: it creates missing tabs with headers
and appends missing columns to existing tabs. It never writes rate values, never deletes
columns, and never reorders existing ones. Re-running it is safe and idempotent.

Run order for a fresh sheet: `migrateSchemaForManagerApproval()` →
`migrateSchemaForJobCompletion()` → `migrateSchemaForCompletionExports()` →
`migrateSchemaForRatesFinancial()`.

## Snapshot lifecycle

| Status | Meaning | Allowed next |
|---|---|---|
| `Draft` | Lines priced from current rates; blockers recorded | `Draft`, `Validated`, `Cancelled` |
| `Validated` | Every billable line has a sell rate, tax type, and account code | `Draft`, `Validated`, `Approved`, `Cancelled` |
| `Approved` | **Immutable.** Financial record of what the job is worth | `Superseded` |
| `Superseded` | Terminal. Reason appended to notes | — |
| `Cancelled` | Terminal | — |

Rules:

- Manager/admin only for every action.
- **Create** re-prices from live rate tables and writes both the header and its lines.
  A completion may hold at most one Approved snapshot — creating another returns **409** until
  the existing one is superseded.
- **Validate** re-checks the stored lines. If any blocker remains, the snapshot is pushed back
  to `Draft` with `pricing_status = Unresolved` rather than being marked Validated.
- **Approve** refuses (422) when blockers are present, requires a UI confirmation, and records
  `approved_by` / `approved_at`.
- **Supersede** requires a non-blank `reason`; it is the only way out of `Approved`.
- Every mutation takes `expected_version` and bumps `version`; a mismatch returns **409**.
- `pricing_status` (`Unresolved` / `Ready` / `Validated` / `Approved`) tracks pricing quality and
  is deliberately distinct from `snapshot_status`, which tracks the approval lifecycle.

## Decimal policy

Currency is never held in binary floating point.

1. **Storage/compute unit:** integer **cents** (AUD). Money-like input parses through
   `parse_money_to_cents` / `fieldosParseMoneyToCents_`; blank or non-numeric input returns
   `null` — **never** zero.
2. **Quantities:** scaled to micro-units (1e6) before multiplication so fractional hours do not
   drift.
3. **Line rounding:** `round(quantity_micro × rate_cents ÷ 1e6)` using **half-up** (away from
   zero) at the **line** level.
4. **Totals:** sum the already-rounded line cents. Never round the sum of unrounded products.
5. **Tax:** computed per line as `round_half_up(line_ex_tax_cents × rate_percent ÷ 100)`, then
   summed. A line with a `0` amount gets `0` tax; a line with an unknown rate gets a blocker.
6. **Display:** `cents_to_money_string` emits a fixed 2-decimal string. The React layer only
   formats strings it was given (`formatMoneyDisplay`) and never recomputes a total.

Zero only ever appears as a sell value when a row is explicitly non-billable, and it always
carries `non_billable_reason`.

## Tax boundary

- There is **no default GST rate anywhere in the code.** `tax_rate_percent` comes only from an
  Active `tbl_xero_mappings` row.
- Tax type is resolved per line: `travel` uses the `labour` entity type; the resolver tries the
  line's specific references (role, staff, charge code, equipment, material, item code, tax code)
  and finally falls back to the bare entity type.
- A billable line with no resolved mapping records blockers (`tax_type unresolved`,
  `account_code unresolved`) and cannot be validated.
- Snapshot header `tax_type` / `account_code` show the single value when lines agree, otherwise
  `Mixed`.
- Non-billable lines do not require a tax mapping.

## Xero boundary

| Item | Status in 3E |
|---|---|
| Contact / customer | mapped via `entity_type = customer`, surfaced as `xero_customer_reference` |
| Account codes | from mappings, per line |
| Tax type / rate | from mappings, per line |
| Tracking category / option | stored on mappings; not yet applied to lines |
| Invoice creation / numbering | **not implemented** — `draft_reference` is local only |
| API calls, OAuth, webhooks | **none** |

## Payroll boundary

| Item | Status in 3E |
|---|---|
| Employee reference, ordinary/overtime/travel codes, cost centre, pay calendar | stored and validated per staff + work date |
| Readiness | requires `employee_reference`, `ordinary_hours_code`, `cost_centre` on an Active, effective mapping |
| Pay rates | labour `cost_rate` is a costing input only — it is not a wage instruction |
| Overtime | priced **only** when `overtime_hours` is explicitly recorded on the labour entry; never inferred from shift length |
| File generation / posting | **none** |

## Endpoint contracts

All manager/admin only; staff receive **403**.

| Method | Path |
|---|---|
| GET / POST | `/api/v1/rate-cards` |
| PATCH | `/api/v1/rate-cards/{rate_card_id}` |
| GET / POST | `/api/v1/rates/labour`, `/api/v1/rates/machinery` |
| PATCH | `/api/v1/rates/labour/{id}`, `/api/v1/rates/machinery/{id}` |
| GET / POST | `/api/v1/materials/catalog` |
| PATCH | `/api/v1/materials/catalog/{material_id}` |
| GET / POST | `/api/v1/pricing/customer` |
| PATCH | `/api/v1/pricing/customer/{customer_pricing_id}` |
| GET / POST | `/api/v1/mappings/payroll`, `/api/v1/mappings/xero` |
| PATCH | `/api/v1/mappings/payroll/{id}`, `/api/v1/mappings/xero/{id}` |
| GET | `/api/v1/completions/{completion_id}/pricing/readiness` |
| GET / POST | `/api/v1/completions/{completion_id}/financial-snapshots` |
| GET | `/api/v1/financial-snapshots/{snapshot_id}` |
| POST | `/api/v1/financial-snapshots/{snapshot_id}/validate` \| `/approve` \| `/supersede` |

List filters: `on_date`, `include_inactive`, plus `rate_card_id`, `customer_id`, `staff_id`,
`entity_type` where meaningful. List responses include `items[]` and `overlaps[]`.

Error mapping:

- staff → **403**
- unknown rate row / completion / snapshot → **404**
- stale `expected_version`, or a second Approved snapshot → **409**
- invalid money, disallowed transition, approving with blockers, missing supersede reason → **422**

## Apps Script actions

Routed in `Router.js`, dispatched in `FieldOSGateway.js`, implemented by
`FieldOSRatesFinancial` in `RatesFinancial.js` with pure helpers in `RatesFinancialHelpers.js`:

`list_rate_cards`, `create_rate_card`, `update_rate_card`,
`list_labour_rates`, `create_labour_rate`, `update_labour_rate`,
`list_machinery_rates`, `create_machinery_rate`, `update_machinery_rate`,
`list_material_catalog`, `create_material_catalog_item`, `update_material_catalog_item`,
`list_customer_pricing`, `create_customer_pricing`, `update_customer_pricing`,
`list_payroll_mappings`, `create_payroll_mapping`, `update_payroll_mapping`,
`list_xero_mappings`, `create_xero_mapping`, `update_xero_mapping`,
`get_completion_pricing_readiness`, `create_financial_snapshot`, `list_financial_snapshots`,
`get_financial_snapshot`, `validate_financial_snapshot`, `approve_financial_snapshot`,
`supersede_financial_snapshot`

Missing tables raise
`Validation Error: <table> missing — run migrateSchemaForRatesFinancial().`

Concurrency is optimistic (`expected_version` → `Conflict: … changed since you loaded this
record.`) rather than lock-based, because each action writes a single header row plus its own
child lines.

## Audit strategy

`tbl_sync_logs` with `target_system = FieldOS_Rates`, payload built by an allow-list
(`financial_audit_payload` / its Apps Script mirror):

`action`, `actor_staff_id`, `actor_role`, `resource_type`, `resource_id`, `completion_id`,
`previous_status`, `new_status`, `version`, `changed_fields`, `source_ids`, `correlation_id`

Never logged: money amounts, rate values, customer or staff names, transcripts, note bodies,
Authorization headers, tokens, API keys, Drive IDs.

## Deployment (manual — do not auto-deploy)

1. Push Apps Script files: `RatesFinancialHelpers.js`, `RatesFinancial.js`, and the updated
   `FieldOSGateway.js`, `Router.js`, `Repositories.js`, `Setup.js`, `JobCompletion.js`.
2. Run `migrateSchemaForRatesFinancial()` once against a **non-production** spreadsheet copy and
   confirm nine tabs exist with the documented headers.
3. Redeploy the FieldOS backend and frontend.
4. Smoke-test in `mock` data mode first (`/rates` page, all eight tabs).
5. Switch a staging deployment to `apps_script` mode and repeat against the staging spreadsheet.
6. Enter real rate data via the UI — the migration deliberately seeds nothing.
7. Only then run the migration against the production spreadsheet.

## Rollback

1. Hide the "Rates" nav links and the `/rates` route; the rest of the app is unaffected.
2. Stop calling the Phase 3E endpoints.
3. Leave the nine tables in place — the migration is additive and Approved snapshots are
   financial records that must not be deleted.
4. Redeploy the previous backend / frontend / Apps Script revision. Baseline immediately before
   Phase 3E: commit `2479ae0335967ebe29fd0a650feef69a38245c5f`
   ("Add completion dashboard and staged CSV exports").

## Manual verification — job `21759f5d` / staff `STAFF-9012C021`

Staging spreadsheet only. Do **not** post to Xero or payroll at any point.

1. Sign in as a manager; confirm "Rates" appears on both Jobs and the Completion Dashboard, and
   that a staff login is redirected away from `/rates`.
2. **Rate card** — create `Standard 2026` (AUD, Active, `effective_from` = a date on or before
   job `21759f5d`'s `job_date`, `effective_to` blank). Note its `RC-…` id.
3. **Labour rate** — create a `default_rate_card` row on that card: blank staff/customer/project,
   `unit = hour`, `sell_rate`, `cost_rate`, `travel_rate`, same effective window.
4. **Staff override** — create a second labour rate with `staff_id = STAFF-9012C021` and a
   different `sell_rate`. Confirm the list shows both and no overlap warning appears (different
   scope keys).
5. **Machinery / material** — add a machinery rate matching the completion's equipment and a
   catalog item whose `item_code` matches the recorded material.
6. **Customer pricing** — map job `21759f5d`'s `customer_id` to the rate card for the job date.
7. **Xero mappings** — add Active rows for `customer` (that `customer_id` → contact reference)
   and for `labour`, `machinery`, `material`, each with `account_code`, `tax_type`, and an
   explicit `tax_rate_percent`.
8. **Payroll mapping** — add an Active row for `STAFF-9012C021` with `employee_reference`,
   `ordinary_hours_code`, and `cost_centre` covering the job date.
9. **Readiness** — on the Financial snapshots tab, enter the completion_id for `21759f5d` and
   load readiness. Verify:
   - identity resolves customer/project/job date and the expected rate card;
   - the `STAFF-9012C021` labour line reports source `3. Staff specific` (not
     `5. Default rate card`), proving precedence;
   - totals preview is populated and tax type matches the mapping;
   - payroll mapping shows Resolved.
10. **Blocker path** — deactivate the machinery rate and reload readiness; confirm an explicit
    "No active machinery sell rate…" blocker appears and `unit_sell` stays blank (not `0.00`).
    Reactivate it.
11. **Overlap path** — add a second Active default labour rate with an overlapping window;
    confirm the amber overlap warning lists both IDs. Close one with an `effective_to`.
12. **Snapshot** — create a draft snapshot. Check `line_count`, that labour/travel/machinery/
    material lines are present, and that non-billable rows show `0.00` with a reason.
13. **Validate** — validate the snapshot. With blockers it must return to `Draft`; with none it
    becomes `Validated`.
14. **Approve** — approve, confirming the dialog text names the total and immutability. Verify
    `approved_by` / `approved_at` are set and Validate/Approve are now disabled.
15. **Immutability** — attempt to create another snapshot for the same completion; expect the
    409 conflict message telling you to supersede first.
16. **Stale conflict** — open the same snapshot in two tabs, act in one, then act in the other;
    expect the "changed elsewhere (409)" message.
17. **Supersede** — supersede with a reason, confirm the reason is appended to notes and a new
    draft can now be created.
18. **Audit** — inspect `tbl_sync_logs` for `FieldOS_Rates` rows covering create/validate/
    approve/supersede, and confirm no money values or names were logged.
19. **Repricing check** — change a rate with a *future* `effective_from`, re-create a snapshot for
    the same job, and confirm the original job-date rate is still used.

## Unresolved business decisions

These are blocking a move from staging to real invoicing. None are guessed in code.

| # | Decision | Current behaviour | Needed from the business |
|---|---|---|---|
| 1 | **`customer_id` on job sheets** | Identity comes from the job row's `customer_id` / `project_id` only; display names are never used as identifiers. Jobs without a populated `customer_id` produce a "Customer identity unresolved" blocker and cannot be priced. | Confirm `tbl_job_sheets.customer_id` is reliably populated (and backfill history), or define the authoritative alternative link. |
| 2 | **GST rate and treatment** | No default rate. Every billable line requires an explicit `tax_rate_percent` on an Active Xero mapping, otherwise it blocks. | Confirm the GST percentage, which tax types apply per line type (labour vs machinery vs materials), and whether any customer is tax-exempt. |
| 3 | **Material catalog linkage** | Materials price only on `material_id` / `item_code`. Free-text item names produce suggestions, never prices. | Decide whether field-recorded material names get mapped to catalog codes at capture time, by a manager review step, or via an alias table. |
| 4 | **Overtime rules** | Overtime is priced only from an explicitly recorded `overtime_hours` value against a configured `overtime_rate`. Nothing is inferred from shift length, day of week, or public holidays. | Supply the award/agreement rules: daily and weekly thresholds, weekend/public-holiday multipliers, and whether the system should derive them at all. |
| 5 | **Minimum charges** | `minimum_charge` is stored on machinery rates but not yet applied to line amounts. | Confirm whether minimums apply per job, per day, or per mobilisation. |
| 6 | **Cost vs sell reporting** | `cost_rate` / `cost_price` are captured but no margin reporting exists. | Confirm whether margin should be surfaced to managers and to whom. |

## Files of record

- Apps Script: `RatesFinancialHelpers.js`, `RatesFinancial.js`, `FieldOSGateway.js`, `Router.js`,
  `Repositories.js`, `Setup.js`, `JobCompletion.js`
- Backend: `rates_math.py`, `mock_rates.py`, `mock_repository.py`, `mock_store.py`, `jobs.py`,
  `apps_script.py`, `apps_script_repository.py`, `schemas.py`, `routes.py`
- Frontend: `pages/RatesFinancialPage.jsx`, `ratesFinancialHelpers.mjs`, `App.jsx`, `JobsPage.jsx`,
  `CompletionsDashboardPage.jsx`
- Tests: `apps-script/tests/rates_financial.test.mjs`,
  `fieldos/backend/tests/test_rates_financial.py`,
  `fieldos/frontend/src/ratesFinancial.test.mjs`
