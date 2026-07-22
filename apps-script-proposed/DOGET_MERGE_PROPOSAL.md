# Apps Script `doGet` conflict — inventory and merge proposal

**Date:** 2026-07-19  
**Status:** Proposal only — **not applied** to production behaviour; **not deployed**.  
**Scope:** Inventory every `doGet` / recorder serve path and propose one canonical web entry point.

---

## 1. Inventory (confirmed in repo)

| Location | Symbol | What it does |
|---|---|---|
| `Router.js` L178 | `doGet(e)` | If `mode=recorder` → `serveRecorder_(e)`; else plain HTML `"Native Grace FieldOS"` |
| `RecorderWebApp.js` L6 | `doGet(e)` | Always serves `Recorder.html` with `job_sheet_id`, `user_identity`, `return_url` |
| `DailySummaryPdf.js` L6 | `doGet(e)` | **Duplicate** of `RecorderWebApp.js` `doGet` (file is misnamed; no PDF) |
| `Recordert.js` L1 | `serveRecorder_(e)` | Not `doGet`, but used by Router: validates job exists; serves recorder **without** `returnUrl` |

### Related (not `doGet`, but affects recorder)

| Location | Symbol | Notes |
|---|---|---|
| `RecorderWebApp.js` | `saveRecording` | Matches `Recorder.html` (`audio_base64`, `{ status: "Success" }`) |
| `Recordert.js` | `saveRecording` | **Incompatible** (`base64_audio`, `{ success: true }`, `Utilities.generateId` invalid) |

### Apps Script load-order reality

In a single Apps Script project, **only one global `doGet` wins**. Which file “wins” depends on editor load order and is **not defined in this repo**. That is why production GET behaviour is ambiguous today.

---

## 2. Classification

| Implementation | Verdict | Rationale |
|---|---|---|
| `DailySummaryPdf.js` `doGet` | **Obsolete** | Misnamed; identical to `RecorderWebApp.js`; filename implies PDF that does not exist |
| `RecorderWebApp.js` `doGet` | **Obsolete as a second global `doGet`** | Behaviour should be folded into the single router entry point; keep `saveRecording` (canonical for HTML) |
| `Router.js` `doGet` | **Keep as sole web entry point** | Already acts as a mode switch; correct place for routing |
| `Recordert.js` `serveRecorder_` | **Keep logic, merge into router path** | Job existence check is valuable; must also set `returnUrl` for HTML |

---

## 3. Functionality that must be preserved

From the three `doGet` / serve paths combined:

1. **Default landing** — simple HTML `"Native Grace FieldOS"` when no recorder mode.
2. **Recorder HTML** — serve `Recorder.html` template.
3. **Query params**
   - `job_sheet_id` (required for recorder)
   - `user_identity` (optional)
   - `return_url` (optional; used by `Recorder.html` “Back to Job Sheet”)
4. **Optional mode switch** — `mode=recorder` (Router style) **and** backward-compatible “any GET with `job_sheet_id` opens recorder” (RecorderWebApp style), so existing AppSheet deep links keep working.
5. **Validation** — reject missing / unknown `job_sheet_id` with clear HTML (from `serveRecorder_`).
6. **Frame embedding** — `XFrameOptionsMode.ALLOWALL` for AppSheet / iframe use.
7. **Title** — recorder title (prefer `"Native Grace Recorder"` as in RecorderWebApp).

`saveRecording` is out of scope for `doGet` merge but must remain the **RecorderWebApp** variant (compatible with `Recorder.html`). The `Recordert.js` `saveRecording` should be marked obsolete in a follow-up (separate change).

---

## 4. Recommended sole entry point

**Keep only `Router.js` `doGet`.**  
Remove / stop defining `doGet` in `RecorderWebApp.js` and `DailySummaryPdf.js` after review approval.

Suggested behaviour:

```text
GET /
  → "Native Grace FieldOS"

GET /?mode=recorder&job_sheet_id=...&user_identity=...&return_url=...
GET /?job_sheet_id=...&user_identity=...&return_url=...   (compat)
  → validate job → serve Recorder.html (with returnUrl)
```

---

## 5. Proposed merged implementation (review only)

Proposed file: `apps-script-proposed/DoGetMerged.js`  
**Do not copy to production until approved.**

```javascript
/**
 * Proposed sole doGet for Router.js (REVIEW ONLY — not applied).
 * Replaces conflicting doGet definitions in RecorderWebApp.js / DailySummaryPdf.js.
 */
function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const mode = String(params.mode || "").trim();
  const jobSheetId = String(params.job_sheet_id || "").trim();

  // Explicit recorder mode, or legacy deep-link that only passes job_sheet_id
  const wantsRecorder = mode === "recorder" || jobSheetId !== "";

  if (wantsRecorder) {
    return serveRecorderPage_(params);
  }

  return HtmlService.createHtmlOutput("Native Grace FieldOS");
}

/**
 * Canonical recorder serve — merges Router serveRecorder_ + RecorderWebApp doGet.
 */
function serveRecorderPage_(params) {
  const jobSheetId = String(params.job_sheet_id || "").trim();
  const userIdentity = String(params.user_identity || "").trim();
  const returnUrl = String(params.return_url || "").trim();

  if (!jobSheetId) {
    return HtmlService.createHtmlOutput("Missing job_sheet_id");
  }

  const jobSheet = JobSheetRepository.findById(jobSheetId);
  if (!jobSheet) {
    return HtmlService.createHtmlOutput("Job sheet not found");
  }

  const template = HtmlService.createTemplateFromFile("Recorder");
  template.jobSheetId = jobSheetId;
  template.userIdentity = userIdentity;
  template.returnUrl = returnUrl;

  return template
    .evaluate()
    .setTitle("Native Grace Recorder")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
```

### After approval (apply plan — not executed now)

1. Replace `Router.js` `doGet` with the merged version above (or call `serveRecorderPage_` from Router).
2. Delete `doGet` from `RecorderWebApp.js` (keep `saveRecording`).
3. Delete or empty `DailySummaryPdf.js` `doGet` (prefer delete whole obsolete file once confirmed unused).
4. Update `serveRecorder_` in `Recordert.js` to either:
   - become an alias of `serveRecorderPage_`, or
   - be removed once Router no longer calls it.
5. Separately deprecate `Recordert.js` `saveRecording` (incompatible with HTML).

---

## 6. Assumptions

| Assumption | Note |
|---|---|
| AppSheet may open recorder with only `job_sheet_id` (no `mode=recorder`) | Compat path preserves that |
| AppSheet may use `mode=recorder` | Router path preserves that |
| `return_url` is optional | Empty string is OK for HTML |
| No real PDF feature lives in `DailySummaryPdf.js` | Confirmed by file contents |

## 7. Risks

| Risk | Mitigation |
|---|---|
| Live deploy currently depends on whichever `doGet` wins | Merge then redeploy one Web App version after review |
| Removing always-on recorder `doGet` breaks links that assumed every GET opens recorder | Compat: any GET with `job_sheet_id` still opens recorder |
| FieldOS Phase 1/2 UI already replaced Apps Script recorder for new work | Apps Script recorder still needed for AppSheet coexistence |

---

## 8. Stop point

No production Apps Script files were modified for this proposal beyond documentation in `apps-script-proposed/`.  
Await review/approval before applying the merge or deploying.
