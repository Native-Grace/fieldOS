/**
 * Phase 3B manager review gateway tests.
 * Run: node --test apps-script/tests/manager_review.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helpersSrc = fs.readFileSync(
  path.join(__dirname, "..", "JobCompletionHelpers.js"),
  "utf8"
);
const gatewaySrc = fs.readFileSync(
  path.join(__dirname, "..", "FieldOSGateway.js"),
  "utf8"
);

function loadGateway(harness) {
  const headers = harness.headers || [
    "job_sheet_id",
    "staff_id",
    "date",
    "project_id",
    "processing_status",
    "processing_error",
    "processing_started_at",
    "processing_completed_at",
    "approval_status",
    "ai_summary",
    "client_requests",
    "variations",
    "safety_issues",
    "manager_review_items",
    "weather",
    "travel_time",
    "ai_confidence_score",
    "manager_notes",
    "approved_by",
    "approved_at",
    "returned_by",
    "returned_at",
    "return_reason",
    "ai_transcript",
  ];
  const context = {
    console,
    Utilities: {
      formatDate: () => "2026-07-01",
      getUuid: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    },
    Session: { getScriptTimeZone: () => "Australia/Sydney" },
    ContentService: {
      createTextOutput: (s) => ({
        setMimeType() {
          return s;
        },
        getContent() {
          return s;
        },
      }),
      MimeType: { JSON: "json" },
    },
    Logger: { log() {} },
    JobSheetRepository: {
      findById(id) {
        return harness.jobs[id] || null;
      },
      findAll() {
        return Object.values(harness.jobs);
      },
    },
    RecordingRepository: {
      find() {
        throw new Error("broken");
      },
    },
    SyncRepository: {
      create(row) {
        harness.sync.push(row);
      },
    },
    Utils: {
      withLock(_name, _timeout, fn) {
        return fn();
      },
    },
    DB: {
      getHeaders() {
        return headers.slice();
      },
      findWhere(table, cond) {
        return (harness.recordings || []).filter((r) =>
          Object.keys(cond).every((k) => String(r[k]) === String(cond[k]))
        );
      },
      findById() {
        return null;
      },
      updateRecord(table, key, id, patch) {
        harness.dbCalls.push({ op: "updateRecord", table, key, id, patch: { ...patch } });
        const row = harness.jobs[id];
        if (!row) throw new Error("missing");
        Object.assign(row, patch);
        return row;
      },
    },
    fieldosLoadDisplayMaps_: () => ({
      projectById: {},
      customerById: {},
      projectByExactName: {},
      projectByNormName: {},
    }),
    fieldosResolveProjectCustomer_: (key) => ({
      project_name: key,
      customer_name: "Customer",
      match: null,
      warning: null,
    }),
  };
  vm.createContext(context);
  vm.runInContext(helpersSrc, context);
  vm.runInContext(gatewaySrc, context);
  return context;
}

function baseJob(overrides = {}) {
  return {
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-9012C021",
    date: "2026-07-22",
    project_id: "Kat and James Dykes",
    processing_status: "Completed",
    processing_error: "",
    processing_started_at: "2026-07-24T01:00:00.000Z",
    processing_completed_at: "2026-07-24T01:05:00.000Z",
    approval_status: "Pending Review",
    ai_summary: "Mowed lawns.",
    client_requests: "",
    variations: "",
    safety_issues: "",
    manager_review_items: "Check fragments.",
    weather: "",
    travel_time: "",
    ai_confidence_score: 0.8,
    manager_notes: "Keep notes",
    approved_by: "",
    approved_at: "",
    returned_by: "",
    returned_at: "",
    return_reason: "",
    ai_transcript: "SECRET_TRANSCRIPT_TEXT",
    ...overrides,
  };
}

function baseHarness(overrides = {}) {
  return {
    jobs: { "21759f5d": baseJob() },
    recordings: [
      {
        recording_id: "REC-1",
        job_sheet_id: "21759f5d",
        recording_order: 1,
        status: "Processed",
        recording_drive_file_id: "drive-secret",
        transcript: "hello",
      },
    ],
    sync: [],
    dbCalls: [],
    ...overrides,
  };
}

test("get_job_detail exposes review fields without full transcript by default", () => {
  const harness = baseHarness();
  const ctx = loadGateway(harness);
  const out = ctx.FieldOSGateway.getJobDetail({
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-9012C021",
    actor_role: "staff",
  });
  assert.equal(out.data.job.ai_summary, "Mowed lawns.");
  assert.equal(out.data.job.manager_notes, "Keep notes");
  assert.equal(out.data.job.ai_confidence_score, 0.8);
  assert.equal(out.data.job.ai_transcript_character_count, "SECRET_TRANSCRIPT_TEXT".length);
  assert.equal(Object.prototype.hasOwnProperty.call(out.data.job, "ai_transcript"), false);
  assert.equal(out.data.recordings[0].recording_drive_file_id, "");
});

test("review list action returns all eligible jobs regardless of assignment", () => {
  const harness = baseHarness({
    jobs: {
      "21759f5d": baseJob(),
      "unassigned-job": baseJob({
        job_sheet_id: "unassigned-job",
        staff_id: "STAFF-OTHER",
        project_id: "Other Project",
        approval_status: "Approved",
      }),
    },
  });
  const ctx = loadGateway(harness);
  const out = ctx.FieldOSGateway.listJobsForReview({
    staff_id: "STAFF-MGR001",
    actor_role: "manager",
    days: 7,
  });
  assert.equal(
    Array.from(out.data.jobs, (job) => job.job_sheet_id).sort().join(","),
    "21759f5d,unassigned-job"
  );
});

test("review list filters and omits transcript and Drive identifiers", () => {
  const harness = baseHarness({
    jobs: {
      "21759f5d": baseJob(),
      "approved-other": baseJob({
        job_sheet_id: "approved-other",
        staff_id: "STAFF-OTHER",
        project_id: "Searchable Hedge",
        approval_status: "Approved",
      }),
    },
  });
  const ctx = loadGateway(harness);
  const out = ctx.FieldOSGateway.listJobsForReview({
    staff_id: "STAFF-MGR001",
    actor_role: "admin",
    days: 7,
    processing_status: "Completed",
    approval_status: "Approved",
    search: "hedge",
  });
  assert.equal(out.data.jobs.length, 1);
  assert.equal(out.data.jobs[0].job_sheet_id, "approved-other");
  const serialized = JSON.stringify(out.data.jobs);
  assert.doesNotMatch(serialized, /ai_transcript|SECRET_TRANSCRIPT|recording_drive_file_id/i);
});

test("staff cannot call review list action", () => {
  const ctx = loadGateway(baseHarness());
  assert.throws(
    () =>
      ctx.FieldOSGateway.listJobsForReview({
        staff_id: "STAFF-9012C021",
        actor_role: "staff",
        days: 7,
      }),
    /Manager or admin/
  );
});

test("manager can include transcript and see Drive id", () => {
  const harness = baseHarness();
  const ctx = loadGateway(harness);
  const out = ctx.FieldOSGateway.getJobDetail({
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-OTHER",
    actor_role: "manager",
    include_transcript: true,
  });
  assert.equal(out.data.job.ai_transcript, "SECRET_TRANSCRIPT_TEXT");
  assert.equal(out.data.recordings[0].recording_drive_file_id, "drive-secret");
});

test("staff update rejected", () => {
  const harness = baseHarness();
  const ctx = loadGateway(harness);
  assert.throws(
    () =>
      ctx.FieldOSGateway.updateJobReview({
        job_sheet_id: "21759f5d",
        staff_id: "STAFF-9012C021",
        actor_role: "staff",
        manager_notes: "Nope",
      }),
    /Manager or admin/
  );
});

test("manager update succeeds and preserves approval", () => {
  const harness = baseHarness();
  const ctx = loadGateway(harness);
  const out = ctx.FieldOSGateway.updateJobReview({
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-MGR",
    actor_role: "manager",
    manager_notes: "Reviewed locally",
    expected_approval_status: "Pending Review",
  });
  assert.equal(out.data.job.manager_notes, "Reviewed locally");
  assert.equal(out.data.job.approval_status, "Pending Review");
  assert.equal(harness.jobs["21759f5d"].manager_notes, "Reviewed locally");
});

test("approve requires Completed and sets metadata", () => {
  const harness = baseHarness({
    jobs: { "21759f5d": baseJob({ processing_status: "Queued" }) },
  });
  const ctx = loadGateway(harness);
  assert.throws(
    () =>
      ctx.FieldOSGateway.approveJobSheet({
        job_sheet_id: "21759f5d",
        staff_id: "STAFF-MGR",
        actor_role: "manager",
        actor_identity: "mgr@nativegrace.com",
      }),
    /Completed/
  );

  harness.jobs["21759f5d"].processing_status = "Completed";
  const out = ctx.FieldOSGateway.approveJobSheet({
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-MGR",
    actor_role: "admin",
    actor_identity: "mgr@nativegrace.com",
    ai_summary: "Final summary",
    expected_approval_status: "Pending Review",
  });
  assert.equal(out.data.job.approval_status, "Approved");
  assert.equal(out.data.job.approved_by, "mgr@nativegrace.com");
  assert.ok(out.data.job.approved_at);
  assert.equal(out.data.job.return_reason, "");
  assert.equal(harness.jobs["21759f5d"].ai_summary, "Final summary");
});

test("return requires reason and sets metadata", () => {
  const harness = baseHarness();
  const ctx = loadGateway(harness);
  assert.throws(
    () =>
      ctx.FieldOSGateway.returnJobSheet({
        job_sheet_id: "21759f5d",
        staff_id: "STAFF-MGR",
        actor_role: "manager",
        return_reason: "  ",
      }),
    /return_reason/
  );
  const out = ctx.FieldOSGateway.returnJobSheet({
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-MGR",
    actor_role: "manager",
    actor_identity: "mgr@nativegrace.com",
    return_reason: "Please clarify hedge work",
    manager_notes: "Needs hedge note",
  });
  assert.equal(out.data.job.approval_status, "Returned for Correction");
  assert.equal(out.data.job.return_reason, "Please clarify hedge work");
  assert.equal(out.data.job.returned_by, "mgr@nativegrace.com");
  assert.equal(out.data.job.approved_by, "");
});

test("reopen behaviour from Approved only", () => {
  const harness = baseHarness({
    jobs: {
      "21759f5d": baseJob({
        approval_status: "Approved",
        approved_by: "mgr@nativegrace.com",
        approved_at: "2026-07-24T02:00:00.000Z",
      }),
    },
  });
  const ctx = loadGateway(harness);
  const out = ctx.FieldOSGateway.reopenJobSheet({
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-MGR",
    actor_role: "manager",
    expected_approval_status: "Approved",
  });
  assert.equal(out.data.job.approval_status, "Pending Review");
  assert.equal(out.data.job.approved_by, "");
});

test("ordinary edit does not silently reopen Approved", () => {
  const harness = baseHarness({
    jobs: {
      "21759f5d": baseJob({ approval_status: "Approved" }),
    },
  });
  const ctx = loadGateway(harness);
  assert.throws(
    () =>
      ctx.FieldOSGateway.updateJobReview({
        job_sheet_id: "21759f5d",
        staff_id: "STAFF-MGR",
        actor_role: "manager",
        manager_notes: "silent reopen attempt",
      }),
    /explicit reopen/
  );
});

test("stale state rejected with Conflict", () => {
  const harness = baseHarness();
  const ctx = loadGateway(harness);
  assert.throws(
    () =>
      ctx.FieldOSGateway.updateJobReview({
        job_sheet_id: "21759f5d",
        staff_id: "STAFF-MGR",
        actor_role: "manager",
        manager_notes: "stale",
        expected_approval_status: "Approved",
      }),
    /Conflict/
  );
});

test("not found", () => {
  const harness = baseHarness({ jobs: {} });
  const ctx = loadGateway(harness);
  assert.throws(
    () =>
      ctx.FieldOSGateway.getJobDetail({
        job_sheet_id: "missing",
        staff_id: "STAFF-9012C021",
        actor_role: "staff",
      }),
    /not found|Forbidden|Job sheet/
  );
});

test("audit metadata sanitised — no transcript", () => {
  const harness = baseHarness();
  const ctx = loadGateway(harness);
  ctx.FieldOSGateway.approveJobSheet({
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-MGR",
    actor_role: "manager",
    actor_identity: "mgr@nativegrace.com",
  });
  const payload = harness.sync[0].request_payload;
  assert.doesNotMatch(payload, /SECRET_TRANSCRIPT/);
  assert.match(payload, /approve_job_sheet/);
  assert.match(payload, /fields_changed/);
});

test("atomic writeback applies edits with approval in one update", () => {
  const harness = baseHarness();
  const ctx = loadGateway(harness);
  ctx.FieldOSGateway.approveJobSheet({
    job_sheet_id: "21759f5d",
    staff_id: "STAFF-MGR",
    actor_role: "manager",
    actor_identity: "mgr@nativegrace.com",
    manager_notes: "Approved with note",
    weather: "Fine",
  });
  const updates = harness.dbCalls.filter((c) => c.op === "updateRecord");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch.approval_status, "Approved");
  assert.equal(updates[0].patch.manager_notes, "Approved with note");
  assert.equal(updates[0].patch.weather, "Fine");
});
