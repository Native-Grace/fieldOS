# FieldOS Phase 1 — no Apps Script production changes

Phase 1 FieldOS does **not** require modifications to files under `apps-script/`.

| Need | Approach |
|---|---|
| Save recording | FastAPI writes Drive/Sheets (or local mock) using confirmed `tbl_recordings` columns |
| Enqueue processing | Backend proxies existing `doPost` → `process_voice_dictation` |

Do **not** copy these notes into production Apps Script. If a future HTTP save endpoint is ever needed on Apps Script, add a proposed `.js` file here first for review.
