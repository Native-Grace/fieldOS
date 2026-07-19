# Apps Script proposed changes (Phase 2)

## Status (repo merge)

Reviewed gateway changes are now applied **locally in this repository**:

| Repo file | Status |
|---|---|
| `apps-script/FieldOSGateway.js` | Added (copy of this folder’s gateway) |
| `apps-script/Router.js` | Wired: secret verify, FieldOS actions, data-aware success response |

**Not done:** Google Apps Script editor upload, Web App redeploy, `.env` changes, or live Sheets access.

## Files in this folder

| File | Purpose |
|---|---|
| `FieldOSGateway.js` | Canonical proposed source (kept for review history) |
| `README.md` | Merge / deploy guide |

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
