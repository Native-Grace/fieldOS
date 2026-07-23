/**
 * Node tests for My Jobs date-range helpers.
 * Run: node --test fieldos/frontend/src/jobsRange.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_JOBS_DAYS,
  emptyJobsMessage,
  fetchMyJobs,
  jobsMinePath,
  loadJobsDays,
  normalizeJobsDays,
  saveJobsDays,
} from "./jobsRange.js";

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
  };
}

test("default 7-day request path", () => {
  assert.equal(DEFAULT_JOBS_DAYS, 7);
  assert.equal(normalizeJobsDays(undefined), 7);
  assert.equal(jobsMinePath(7), "/jobs/mine?days=7");
  assert.equal(jobsMinePath(DEFAULT_JOBS_DAYS), "/jobs/mine?days=7");
});

test("selecting 30 days builds days=30 path", () => {
  assert.equal(jobsMinePath(30), "/jobs/mine?days=30");
  assert.equal(normalizeJobsDays(30), 30);
});

test("updated empty-state text uses selected range", () => {
  assert.equal(emptyJobsMessage(7), "No jobs in the last 7 days.");
  assert.equal(emptyJobsMessage(30), "No jobs in the last 30 days.");
  assert.equal(emptyJobsMessage(14), "No jobs in the last 14 days.");
  assert.equal(emptyJobsMessage(90), "No jobs in the last 90 days.");
});

test("fetchMyJobs default days calls /jobs/mine?days=7", async () => {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    return { items: [{ job_sheet_id: "x" }], days: 7, assumptions: [] };
  };
  const result = await fetchMyJobs({ days: 7, api });
  assert.deepEqual(calls, ["/jobs/mine?days=7"]);
  assert.equal(result.items.length, 1);
  assert.equal(result.days, 7);
});

test("fetchMyJobs selecting 30 days requests days=30", async () => {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    return { items: [], days: 30, assumptions: [] };
  };
  const result = await fetchMyJobs({ days: 30, api });
  assert.deepEqual(calls, ["/jobs/mine?days=30"]);
  assert.equal(result.items.length, 0);
  assert.equal(emptyJobsMessage(result.days), "No jobs in the last 30 days.");
});

test("API failure handling propagates error message", async () => {
  const api = async () => {
    throw new Error("Network error");
  };
  await assert.rejects(() => fetchMyJobs({ days: 7, api }), /Network error/);
});

test("localStorage persistence round-trip", () => {
  const storage = memoryStorage();
  assert.equal(loadJobsDays(storage), 7);
  saveJobsDays(storage, 30);
  assert.equal(loadJobsDays(storage), 30);
  saveJobsDays(storage, 99);
  assert.equal(loadJobsDays(storage), 7);
});
