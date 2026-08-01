/**
 * Daily Work open-session load policy + page wiring tests.
 * Run: node --test fieldos/frontend/src/dailyWorkSessionLoad.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  OPEN_SESSIONS_REASONS,
  buildStartNewSessionDetailsForm,
  isStaleOpenSessionsResponse,
  nextOpenSessionsRequestId,
  shouldAutoResumeOnOpenSessionsLoad,
  shouldSkipOverlappingOpenSessionsFetch,
  canCreateCompletedJobSheet,
} from "./dailyWorkSessionLoad.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageSrc = fs.readFileSync(
  path.join(__dirname, "pages", "DailyWorkJobSheetPage.jsx"),
  "utf8"
);

test("request ids increment and stale responses are ignored", () => {
  const a = nextOpenSessionsRequestId(0);
  const b = nextOpenSessionsRequestId(a);
  assert.equal(a, 1);
  assert.equal(b, 2);
  assert.equal(
    isStaleOpenSessionsResponse({ requestId: 1, latestRequestId: 2, aborted: false }),
    true
  );
  assert.equal(
    isStaleOpenSessionsResponse({ requestId: 2, latestRequestId: 2, aborted: false }),
    false
  );
  assert.equal(
    isStaleOpenSessionsResponse({ requestId: 2, latestRequestId: 2, aborted: true }),
    true
  );
});

test("auto-resume only on initial load", () => {
  assert.equal(shouldAutoResumeOnOpenSessionsLoad(OPEN_SESSIONS_REASONS.INITIAL, true), true);
  assert.equal(shouldAutoResumeOnOpenSessionsLoad(OPEN_SESSIONS_REASONS.REFRESH, true), false);
  assert.equal(shouldAutoResumeOnOpenSessionsLoad(OPEN_SESSIONS_REASONS.POST_CREATE, true), false);
  assert.equal(shouldAutoResumeOnOpenSessionsLoad(OPEN_SESSIONS_REASONS.INITIAL, false), false);
});

test("overlapping in-flight fetches are skipped by policy helper", () => {
  assert.equal(shouldSkipOverlappingOpenSessionsFetch(false, "refresh"), false);
  assert.equal(shouldSkipOverlappingOpenSessionsFetch(true, "refresh"), true);
});

test("Start new session form reset clears project/customer and keeps staff", () => {
  const form = buildStartNewSessionDetailsForm(
    { staff_id: "STAFF-1", staff_name: "Alex" },
    () => "2026-08-01"
  );
  assert.equal(form.work_date, "2026-08-01");
  assert.equal(form.customer_name, "");
  assert.equal(form.project_id, "");
  assert.deepEqual(form.staff_ids, ["STAFF-1"]);
  assert.deepEqual(form.staff_names, ["Alex"]);
});

test("simulated late response does not reset Details → Sessions", () => {
  let step = "list";
  let openSessions = [];
  let latest = 0;
  const applyList = (requestId, items, { resumeApply } = {}) => {
    if (isStaleOpenSessionsResponse({ requestId, latestRequestId: latest })) return;
    openSessions = items;
    // Mimic page: only auto-resume while still on list.
    if (resumeApply && step === "list") {
      step = "recordings";
    }
  };

  latest = nextOpenSessionsRequestId(latest); // 1 = initial
  const initialId = latest;
  // User starts new session before initial returns
  step = "details";
  // Late initial response arrives
  applyList(initialId, [{ work_session_id: "DWS-OLD" }], { resumeApply: true });
  assert.equal(step, "details", "late fetch must not leave Details");
  assert.equal(openSessions.length, 1, "list data may update");

  // Explicit refresh while on details — still must not change step
  latest = nextOpenSessionsRequestId(latest);
  applyList(latest, [{ work_session_id: "DWS-A" }, { work_session_id: "DWS-B" }], {
    resumeApply: false,
  });
  assert.equal(step, "details");
  assert.equal(openSessions.length, 2);
});

test("open-session fetch once on mount; no render-time call; no polling", () => {
  assert.match(pageSrc, /const loadOpenSessions = useCallback/);
  assert.match(
    pageSrc,
    /useEffect\(\(\) => \{\s*if \(!allowed\) return;\s*loadOpenSessions\(OPEN_SESSIONS_REASONS\.INITIAL/
  );
  assert.match(pageSrc, /\[allowed, loadOpenSessions\]/);
  // Must not depend on openSessions / step / busy / error in that effect.
  assert.doesNotMatch(
    pageSrc,
    /loadOpenSessions\(OPEN_SESSIONS_REASONS\.INITIAL[\s\S]*?\}, \[allowed, loadOpenSessions, openSessions/
  );
  assert.doesNotMatch(pageSrc, /setInterval\([^)]*loadOpenSessions/);
  assert.doesNotMatch(pageSrc, /\{loadOpenSessions\(/); // not invoked from JSX expressions
  assert.match(pageSrc, /onClick=\{refreshOpenSessions\}/);
  assert.match(pageSrc, /POST_CREATE/);
});

test("applySession must not depend on unstable getStaff\(\) object", () => {
  assert.match(pageSrc, /staffRef\.current = staff/);
  assert.doesNotMatch(pageSrc, /\[persistSessionId, staff\]/);
  assert.match(pageSrc, /\[persistSessionId, setWizardStep\]/);
});

test("Start new session sets details and clears resume; does not load open sessions", () => {
  assert.match(pageSrc, /function startNewSession\(\)/);
  const startFn = pageSrc.slice(
    pageSrc.indexOf("function startNewSession()"),
    pageSrc.indexOf("function backToSessions()")
  );
  assert.match(startFn, /setWizardStep\("details"\)/);
  assert.match(startFn, /clearPersistedSession/);
  assert.match(startFn, /setSession\(null\)/);
  assert.doesNotMatch(startFn, /void loadOpenSessions|loadOpenSessions\(/);
  assert.match(pageSrc, /Back to sessions/);
});

test("AbortController / request-id stale guard present", () => {
  assert.match(pageSrc, /AbortController/);
  assert.match(pageSrc, /isStaleOpenSessionsResponse/);
  assert.match(pageSrc, /openSessionsRequestIdRef/);
  assert.match(pageSrc, /logOpenSessionsFetch/);
});

test("state update from openSessions response cannot recreate loadOpenSessions via applySession staff object", () => {
  // Regression: getStaff() new object → applySession new → effect loop.
  assert.doesNotMatch(pageSrc, /\}, \[allowed, applySession\]\);/);
  // Mount effect deps are only allowed + loadOpenSessions
  const mountIdx = pageSrc.indexOf("loadOpenSessions(OPEN_SESSIONS_REASONS.INITIAL");
  const depsSlice = pageSrc.slice(mountIdx, mountIdx + 800);
  assert.match(depsSlice, /\[allowed, loadOpenSessions\]/);
});

test("CreateFailed recovery UI and return-to-review wiring", () => {
  assert.match(pageSrc, /Return to review/);
  assert.match(pageSrc, /return-to-review/);
  assert.match(pageSrc, /Your recordings and reviewed work have been kept/);
  assert.match(pageSrc, /Confirm review — enable create/);
  assert.match(pageSrc, /function returnToReview/);
  assert.doesNotMatch(pageSrc, /Start over/);
  // No automatic retry from CreateFailed
  assert.match(pageSrc, /session\.status === "CreateFailed"/);
  assert.match(pageSrc, /Return to review first/);
});

test("canCreateCompletedJobSheet gate", () => {
  assert.equal(
    canCreateCompletedJobSheet({
      status: "CreateFailed",
      reviewConfirmed: true,
    }),
    false
  );
  assert.equal(
    canCreateCompletedJobSheet({
      status: "ReviewRequired",
      reviewConfirmed: false,
    }),
    false
  );
  assert.equal(
    canCreateCompletedJobSheet({
      status: "ReviewRequired",
      reviewConfirmed: true,
    }),
    true
  );
  assert.equal(
    canCreateCompletedJobSheet({
      status: "ReviewRequired",
      reviewConfirmed: true,
      jobCreated: true,
    }),
    false
  );
});
