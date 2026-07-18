# Apps Script proposed changes (Phase 2)

**Do not overwrite production `apps-script/` until reviewed and approved.**

## Files

| File | Purpose |
|---|---|
| `FieldOSGateway.js` | New `doPost` actions: `list_jobs_for_staff`, `get_job_detail`, `register_recording` |
| `README.md` | This merge guide |

## Merge steps (manual — do not auto-deploy)

1. In the Apps Script editor, add a new script file and paste `FieldOSGateway.js`.
2. In `Router.js` `doPost`, replace the `!==` secret check with `fieldosVerifyWebhookSecret_(providedSecret)`.
3. In `routeRequest`, before the `default` case, add:

```javascript
    case "list_jobs_for_staff":
    case "get_job_detail":
    case "register_recording": {
      const fieldosResult = fieldosRouteRequest(payload);
      if (!fieldosResult) throw new Error(`Routing Failure: Action '${action}' is unsupported.`);
      // Prefer returning data-aware JSON from doPost — see note below
      return fieldosResult;
    }
```

4. Update `doPost` success path to include `data` when present:

```javascript
    const result = routeRequest(payload);
    if (result.data !== undefined) {
      return fieldosJsonResponse("Success", result.action, result.message, result.job_sheet_id, result.data);
    }
    return Utils.createJsonResponse("Success", result.action, result.message, result.job_sheet_id);
```

5. Deploy a **new** Web App version (Execute as: Me; Who has access: Anyone — matching current `appsscript.json`). Copy the Web App URL into FieldOS `.env` as `APPS_SCRIPT_WEBAPP_URL`.
6. Ensure Script Property `WEBHOOK_SECRET` matches FieldOS `APPS_SCRIPT_WEBHOOK_SECRET`.
7. Confirm live sheet headers for assignment/date/project/customer; set FieldOS env column mappings accordingly. **Do not rename sheet columns.**

## Notes

- `RecordingRepository` in production export uses an invalid constructor; `register_recording` writes via `DB.insertRecord('tbl_recordings', ...)`.
- Large audio must **not** be posted to Apps Script; FieldOS uploads to Drive then calls `register_recording`.
- Existing `process_voice_dictation` is reused unchanged.
