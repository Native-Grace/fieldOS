/**
 * Node tests for Whisper blob diagnostic DB table-name safety.
 * Run: node --test apps-script/tests/whisper_blob_diag.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const diagSrc = fs.readFileSync(
  path.join(__dirname, "..", "FieldOSDisplayDiagnostics.js"),
  "utf8"
);

function loadDiag(dbFindById) {
  const calls = [];
  const context = {
    console,
    Logger: { log: function () {} },
    DB: {
      findById: function (tableName, keyColumn, id) {
        calls.push({ tableName, keyColumn, id });
        if (typeof tableName !== "string") {
          throw new Error("Database Error: Table '" + tableName + "' missing.");
        }
        return dbFindById ? dbFindById(tableName, keyColumn, id) : null;
      },
    },
    // Broken constructor shape (matches live Repositories.js export)
    RecordingRepository: {
      findById: function () {
        throw new Error("Database Error: Table '[object Object]' missing.");
      },
    },
  };
  context.__calls = calls;
  vm.createContext(context);
  vm.runInContext(diagSrc, context);
  return context;
}

test("fieldosDiagAssertTableName_ rejects object table identifiers", () => {
  const ctx = loadDiag();
  assert.throws(
    () =>
      ctx.fieldosDiagAssertTableName_(
        { tableName: "tbl_recordings" },
        "test"
      ),
    /table name must be a non-empty string, got \[object Object\]/
  );
  assert.equal(ctx.fieldosDiagAssertTableName_("tbl_recordings", "test"), "tbl_recordings");
});

test("fieldosDiagFindRecordingById_ uses string tbl_recordings and recording_id key", () => {
  const ctx = loadDiag(function (table, key, id) {
    assert.equal(table, "tbl_recordings");
    assert.equal(key, "recording_id");
    assert.equal(id, "REC-819FC620");
    return {
      recording_id: id,
      recording_name: "21759f5d-REC.webm",
      recording_drive_file_id: "drive-file-1",
    };
  });
  const row = ctx.fieldosDiagFindRecordingById_("REC-819FC620");
  assert.equal(row.recording_id, "REC-819FC620");
  assert.equal(ctx.__calls.length, 1);
  assert.equal(typeof ctx.__calls[0].tableName, "string");
  assert.equal(ctx.__calls[0].tableName, "tbl_recordings");
  assert.equal(ctx.__calls[0].keyColumn, "recording_id");
});

test("diagnostic find helper uses DB.findById with string table, not RecordingRepository.findById calls", () => {
  // Executable call must not invoke RecordingRepository.findById(
  assert.doesNotMatch(diagSrc, /RecordingRepository\.findById\s*\(/);
  assert.match(diagSrc, /DB\.findById\(table,\s*"recording_id"/);
});

test("accidental object table passed to DB.findById is caught by assert helper", () => {
  const ctx = loadDiag();
  // Simulate what broken BaseRepository would do
  assert.throws(() => {
    const badTable = { tableName: "tbl_recordings", idField: "recording_id" };
    ctx.fieldosDiagAssertTableName_(badTable, "simBrokenRepo");
    ctx.DB.findById(badTable, "recording_id", "REC-1");
  }, /\[object Object\]/);
  assert.equal(ctx.__calls.length, 0);
});
