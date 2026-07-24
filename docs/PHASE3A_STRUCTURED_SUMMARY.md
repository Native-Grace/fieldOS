# Phase 3A — GPT structured summary & job-sheet writeback

## JSON schema (strict)

```json
{
  "summary": "string",
  "client_requests": ["string"],
  "variations": ["string"],
  "safety_issues": ["string"],
  "manager_review_items": ["string"],
  "weather": "string",
  "travel_time": "string",
  "confidence_score": 0.0
}
```

`confidence_score` must be numeric in `[0, 1]`. Markdown fences and trailing prose are rejected on the first parse; one repair call may strip fences.

## Writeback mapping (`tbl_job_sheets`)

| JSON | Sheet column |
|---|---|
| (aggregate text) | `ai_transcript` |
| `summary` | `ai_summary` |
| `client_requests` | `client_requests` (newline-separated, de-duped) |
| `variations` | `variations` |
| `safety_issues` | `safety_issues` |
| `manager_review_items` | `manager_review_items` |
| `weather` | `weather` |
| `travel_time` | `travel_time` |
| `confidence_score` | `ai_confidence_score` |

`manager_review_items` must describe the actual unclear, contradictory, incomplete, truncated, or fragmentary content where possible (quote/paraphrase). Prefer wording such as "Recordings 4 and 5 contain incomplete sentence fragments and cannot be reliably interpreted." Do not invent missing meaning. Generic wording such as "Unclear details in recordings 4 and 5" is only acceptable when no more specific interpretation is possible.

Preserved / untouched: `manager_notes`, `approval_status`.  
On success: `processing_status=Completed`, `processing_error=""`.  
Queue still sets `processing_completed_at`.

Structured AI fields are written only after successful validated GPT output (single atomic `JobSheetRepository.update`). Parse/validation failure does not write partial structured fields (`ai_summary`, lists, weather, travel_time, confidence). `ai_transcript` may already have been written earlier so managers retain the aggregate text.

## Retry / repair

1. First `OpenAI.chatComplete` → strict JSON parse (no fence strip).
2. On failure → one repair prompt → parse allowing a single fence strip.
3. No further loops. Failure rethrows → Queue marks Failed. Recording transcripts already written are kept; structured fields are not partially written.

## Diagnostics (editor-only)

- `testFieldOSStructuredSummaryDryRun()` — GPT parse dry-run (no Sheet writes).
- `testFieldOSStructuredWritebackVerification()` — read-only AI field verification; logs transcript **character count** + short `ai_summary` preview only (never full `ai_transcript`).

## Migration note — existing duplicate `recording_order`

Do **not** auto-rewrite historical duplicates. Aggregation already tie-breaks by `recording_order` → `created_at` → `recording_id`.

Optional one-off repair (manual, job-scoped): for each duplicate group, keep the earliest `created_at` at the shared order and renumber later siblings to `max(order)+1`, `max+2`, … under an editor script with an explicit confirm token. Prefer leaving Invalid duplicates as-is if they are already skipped by processing.
