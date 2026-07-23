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
