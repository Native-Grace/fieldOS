/**
 * FieldOS — READ-ONLY diagnostics for project/customer display mapping.
 *
 * Manual Apps Script editor entry points (Run menu):
 *   1) testFieldOSProjectCustomerHeaders()
 *   2) testFieldOSJob21759f5dProjectMapping()
 *   3) testFieldOSProjectCustomerReconciliation()
 *   4) testFieldOSMasterSeedDryRun()
 *   5) testFieldOSMasterSeedApply()  — writes ONLY when CONFIRM_APPLY === "APPLY"
 *   6) testFieldOSDisplayResolveSample() — read-only dual-read sample (no AuthZ bypass of FieldOS API)
 *   7) testFieldOSRecordingWhisperBlobMeta() — read-only Drive blob metadata for Whisper upload diagnosis
 *
 * Confirmed AppSheet config (Phase 0):
 *   - tbl_job_sheets.project_id is Text (not Ref)
 *   - UI label shown as "client"; Sheet stores human-readable text
 *   - Treat values as legacy_project_label (not FK)
 *
 * Safety:
 * - Reads only; never writes Sheets
 * - Does NOT call process_voice_dictation / register_recording / uploads
 * - Does NOT change FieldOSDisplayLookup production resolution
 * - Does NOT seed tbl_projects / tbl_customers
 *
 * Repo expectations (from Repositories.js):
 *   tbl_projects  PK=project_id (prefix PROJ)
 *   tbl_customers PK=customer_id (prefix CUST)
 */

var FIELDOS_DIAG_JOB_SHEET_ID_ = "21759f5d";
var FIELDOS_DIAG_SAMPLE_ROWS_ = 5;

/**
 * Classify a header for safe logging.
 * @returns {"pk"|"display"|"customer_fk"|"sensitive"|"other"}
 */
function fieldosDiagClassifyHeader_(tableName, header) {
  const h = String(header || "").trim();
  const hl = h.toLowerCase();
  if (!hl) return "other";

  // Never log values for these (names only in header list).
  if (
    hl.indexOf("email") !== -1 ||
    hl.indexOf("phone") !== -1 ||
    hl.indexOf("mobile") !== -1 ||
    hl.indexOf("address") !== -1 ||
    hl.indexOf("street") !== -1 ||
    hl.indexOf("suburb") !== -1 ||
    hl.indexOf("postcode") !== -1 ||
    hl.indexOf("zip") !== -1 ||
    hl.indexOf("abn") !== -1 ||
    hl.indexOf("acn") !== -1 ||
    hl.indexOf("secret") !== -1 ||
    hl.indexOf("token") !== -1 ||
    hl.indexOf("password") !== -1 ||
    hl.indexOf("notes") !== -1 ||
    hl.indexOf("comment") !== -1
  ) {
    return "sensitive";
  }

  if (tableName === "tbl_projects") {
    if (hl === "project_id") return "pk";
    if (hl === "customer_id" || hl === "client_id") return "customer_fk";
    if (
      hl === "project_name" ||
      hl === "name" ||
      hl === "title" ||
      hl === "display_name" ||
      hl === "project"
    ) {
      return "display";
    }
  }

  if (tableName === "tbl_customers") {
    if (hl === "customer_id" || hl === "client_id") return "pk";
    if (
      hl === "customer_name" ||
      hl === "client_name" ||
      hl === "name" ||
      hl === "display_name" ||
      hl === "company_name" ||
      hl === "business_name"
    ) {
      return "display";
    }
  }

  if (tableName === "tbl_job_sheets") {
    if (hl === "job_sheet_id") return "pk";
    if (hl === "project_id") return "other";
  }

  // Generic patterns
  if (hl.endsWith("_id") && (hl.indexOf("customer") !== -1 || hl.indexOf("client") !== -1)) {
    return "customer_fk";
  }
  if (hl.endsWith("_id")) return "pk";
  if (hl.endsWith("_name") || hl === "name" || hl === "title") return "display";

  return "other";
}

function fieldosDiagTruncate_(value, maxLen) {
  const s = value == null ? "" : String(value);
  const lim = maxLen || 80;
  return s.length > lim ? s.slice(0, lim) + "…" : s;
}

/**
 * Read headers + up to N rows; return redacted diagnostic object (no writes).
 */
function fieldosDiagInspectTable_(tableName, maxRows) {
  const out = {
    table: tableName,
    exists: false,
    header_count: 0,
    headers: [],
    headers_by_class: {
      pk: [],
      display: [],
      customer_fk: [],
      sensitive: [],
      other: []
    },
    sample_row_count: 0,
    samples: [],
    error: null
  };

  try {
    const sheet = DB.getSheet(tableName);
    out.exists = true;
    const lastCol = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();
    if (lastCol < 1) {
      return out;
    }

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
      return String(h || "").trim();
    });
    out.headers = headers;
    out.header_count = headers.length;

    headers.forEach(function (h) {
      const cls = fieldosDiagClassifyHeader_(tableName, h);
      out.headers_by_class[cls].push(h);
    });

    const dataRows = Math.max(0, lastRow - 1);
    const take = Math.min(maxRows || FIELDOS_DIAG_SAMPLE_ROWS_, dataRows);
    out.sample_row_count = take;
    if (take < 1) {
      return out;
    }

    const values = sheet.getRange(2, 1, 1 + take, lastCol).getValues();
    values.forEach(function (row, rowIdx) {
      const sample = { row_number: rowIdx + 2, fields: {} };
      headers.forEach(function (h, colIdx) {
        const cls = fieldosDiagClassifyHeader_(tableName, h);
        if (cls === "sensitive" || cls === "other") {
          // Header name already listed; omit unrelated/sensitive values.
          return;
        }
        const raw = row[colIdx];
        sample.fields[h] = {
          class: cls,
          value: fieldosDiagTruncate_(raw, 80),
          empty: raw == null || String(raw).trim() === ""
        };
      });
      out.samples.push(sample);
    });
  } catch (err) {
    out.error = String(err && err.message ? err.message : err);
  }

  return out;
}

/**
 * MANUAL TEST 1 — Inspect tbl_projects + tbl_customers headers/samples (read-only).
 * Run from Apps Script editor after pasting this file into the project.
 */
function testFieldOSProjectCustomerHeaders() {
  const report = {
    diagnostic: "testFieldOSProjectCustomerHeaders",
    read_only: true,
    repo_pk_expectations: {
      tbl_projects: "project_id",
      tbl_customers: "customer_id"
    },
    current_lookup_assumes: {
      tbl_projects_display: ["project_name", "name"],
      tbl_projects_customer_fk: ["customer_id"],
      tbl_customers_display: ["customer_name", "name"]
    },
    tbl_projects: fieldosDiagInspectTable_("tbl_projects", FIELDOS_DIAG_SAMPLE_ROWS_),
    tbl_customers: fieldosDiagInspectTable_("tbl_customers", FIELDOS_DIAG_SAMPLE_ROWS_)
  };

  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * MANUAL TEST 2 — Map job 21759f5d.project_id against projects/customers (read-only).
 */
function testFieldOSJob21759f5dProjectMapping() {
  const jobSheetId = FIELDOS_DIAG_JOB_SHEET_ID_;
  const report = {
    diagnostic: "testFieldOSJob21759f5dProjectMapping",
    read_only: true,
    job_sheet_id: jobSheetId,
    job_found: false,
    raw_project_id: null,
    raw_project_id_looks_like: null,
    matches_project_pk: false,
    matches_project_display_field: false,
    matched_project_pk: null,
    matched_display_header: null,
    project_row_found: false,
    project_customer_fk_header: null,
    project_customer_fk_value: null,
    customer_row_found: false,
    customer_display_header: null,
    customer_display_value: null,
    error: null
  };

  try {
    const job = JobSheetRepository.findById(jobSheetId);
    if (!job) {
      report.error = "Job sheet not found.";
      Logger.log(JSON.stringify(report, null, 2));
      return report;
    }
    report.job_found = true;

    const raw = String(job.project_id == null ? "" : job.project_id).trim();
    report.raw_project_id = fieldosDiagTruncate_(raw, 120);
    report.raw_project_id_looks_like = fieldosDiagGuessIdOrDisplay_(raw);

    const projectsProbe = fieldosDiagInspectTable_("tbl_projects", 0);
    const customersProbe = fieldosDiagInspectTable_("tbl_customers", 0);
    const projectPkHeader =
      projectsProbe.headers_by_class.pk.indexOf("project_id") !== -1
        ? "project_id"
        : projectsProbe.headers_by_class.pk[0] || "project_id";
    const projectDisplayHeaders = projectsProbe.headers_by_class.display.slice();
    const projectFkHeaders = projectsProbe.headers_by_class.customer_fk.slice();
    const customerPkHeader =
      customersProbe.headers_by_class.pk.indexOf("customer_id") !== -1
        ? "customer_id"
        : customersProbe.headers_by_class.pk[0] || "customer_id";
    const customerDisplayHeaders = customersProbe.headers_by_class.display.slice();

    report.detected_headers = {
      tbl_projects_pk: projectPkHeader,
      tbl_projects_display: projectDisplayHeaders,
      tbl_projects_customer_fk: projectFkHeaders,
      tbl_customers_pk: customerPkHeader,
      tbl_customers_display: customerDisplayHeaders
    };

    // Match by primary key
    let project = null;
    try {
      project = ProjectRepository.findById(raw);
    } catch (err) {
      project = null;
    }
    if (project) {
      report.matches_project_pk = true;
      report.project_row_found = true;
      report.matched_project_pk = fieldosDiagTruncate_(project[projectPkHeader] || raw, 80);
    }

    // Match by any display-name field (scan findAll once; read-only)
    if (!project) {
      const allProjects = ProjectRepository.findAll() || [];
      for (let i = 0; i < allProjects.length; i++) {
        const row = allProjects[i];
        for (let d = 0; d < projectDisplayHeaders.length; d++) {
          const dh = projectDisplayHeaders[d];
          if (String(row[dh] || "").trim() === raw) {
            project = row;
            report.matches_project_display_field = true;
            report.matched_display_header = dh;
            report.project_row_found = true;
            report.matched_project_pk = fieldosDiagTruncate_(
              row[projectPkHeader] || "",
              80
            );
            break;
          }
        }
        if (project) break;
      }
    }

    if (project) {
      // Prefer classified FK headers; fall back to customer_id/client_id
      const fkCandidates = projectFkHeaders.length
        ? projectFkHeaders
        : ["customer_id", "client_id"];
      let fkHeader = null;
      let fkValue = "";
      for (let f = 0; f < fkCandidates.length; f++) {
        const h = fkCandidates[f];
        const v = String(project[h] || "").trim();
        if (v) {
          fkHeader = h;
          fkValue = v;
          break;
        }
      }
      report.project_customer_fk_header = fkHeader;
      report.project_customer_fk_value = fieldosDiagTruncate_(fkValue, 80);

      if (fkValue) {
        let customer = null;
        try {
          customer = CustomerRepository.findById(fkValue);
        } catch (err) {
          customer = null;
        }
        // If PK header is not customer_id, try findByField
        if (!customer && customerPkHeader && customerPkHeader !== "customer_id") {
          try {
            customer = CustomerRepository.findByField(customerPkHeader, fkValue);
          } catch (err) {
            customer = null;
          }
        }
        if (customer) {
          report.customer_row_found = true;
          const displayHeader =
            customerDisplayHeaders[0] ||
            (customer.customer_name != null
              ? "customer_name"
              : customer.name != null
                ? "name"
                : null);
          report.customer_display_header = displayHeader;
          if (displayHeader) {
            report.customer_display_value = fieldosDiagTruncate_(
              customer[displayHeader],
              80
            );
          }
        }
      }
    }
  } catch (err) {
    report.error = String(err && err.message ? err.message : err);
  }

  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * Heuristic: PROJ-/CUST- style ids vs free-text display strings.
 */
function fieldosDiagGuessIdOrDisplay_(value) {
  const v = String(value || "").trim();
  if (!v) return "blank";
  if (/^(PROJ|CUST|JS|STAFF)-[A-Za-z0-9]+$/i.test(v)) return "prefixed_id";
  if (/^[0-9a-f]{8}$/i.test(v)) return "hex_id_like";
  if (/\s/.test(v) || (/[A-Za-z]{3,}/.test(v) && v.length > 12)) return "display_string";
  if (/^[A-Za-z0-9_-]{6,}$/.test(v) && !/\s/.test(v)) return "id_or_code";
  return "unknown";
}

/**
 * Normalise legacy labels for duplicate detection (casing / punctuation / whitespace).
 */
function fieldosDiagNormalizeLabel_(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic preview IDs for reconciliation reports only (never written to Sheets).
 * Same normalised label → same CUST-/PROJ- preview. Extends hash width on rare collisions
 * when a usedIds map is provided.
 */
function fieldosDiagPreviewSeedId_(prefix, label, usedIds) {
  const norm = fieldosDiagNormalizeLabel_(label) || "blank";
  let h1 = 5381;
  let h2 = 0;
  for (let i = 0; i < norm.length; i++) {
    const c = norm.charCodeAt(i);
    h1 = (h1 * 33) ^ c;
    h2 = (Math.imul(h2, 31) + c) >>> 0;
  }
  const hex =
    (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
  let width = 8;
  let id = String(prefix) + "-" + hex.slice(0, width).toUpperCase();
  const used = usedIds || null;
  while (used && used[id] && used[id] !== norm && width < hex.length) {
    width += 4;
    id = String(prefix) + "-" + hex.slice(0, width).toUpperCase();
  }
  if (used) used[id] = norm;
  return id;
}

function fieldosDiagJobDateKey_(job, dateColumn) {
  const col = dateColumn || "date";
  const raw = job ? job[col] : null;
  if (!raw) return "";
  if (Object.prototype.toString.call(raw) === "[object Date]" && !isNaN(raw.getTime())) {
    const y = raw.getFullYear();
    const m = String(raw.getMonth() + 1).padStart(2, "0");
    const d = String(raw.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }
  return String(raw).slice(0, 10);
}

/**
 * Pure reconciliation builder (injectable arrays — unit-testable; read-only).
 *
 * @param {Array<object>} jobs
 * @param {Array<object>} projects
 * @param {Array<object>} customers
 * @param {object=} options
 * @returns {object} report
 */
function fieldosDiagBuildReconciliationReport_(jobs, projects, customers, options) {
  const opts = options || {};
  const labelColumn = opts.label_column || "project_id";
  const dateColumn = opts.date_column || "date";
  const projectNameColumn = opts.project_name_column || "project_name";
  const customerNameColumn = opts.customer_name_column || "customer_name";
  // Exact legacy labels explicitly reviewed as one shared customer/project despite reuse.
  const reviewedReuseAllowlist = {};
  (opts.reviewed_reuse_allowlist || []).forEach(function (label) {
    const key = String(label || "").trim();
    if (key) reviewedReuseAllowlist[key] = true;
  });

  const projectRows = projects || [];
  const customerRows = customers || [];
  const mastersEmpty = projectRows.length === 0 && customerRows.length === 0;

  const byExactLabel = {};
  const blankJobCount = { count: 0, job_sheet_ids: [] };
  const warnings = [];

  (jobs || []).forEach(function (job) {
    if (!job) return;
    const raw = String(job[labelColumn] == null ? "" : job[labelColumn]).trim();
    const jobId = String(job.job_sheet_id || "");
    const jobDate = fieldosDiagJobDateKey_(job, dateColumn);

    if (!raw) {
      blankJobCount.count += 1;
      if (blankJobCount.job_sheet_ids.length < 20 && jobId) {
        blankJobCount.job_sheet_ids.push(jobId);
      }
      return;
    }

    if (!byExactLabel[raw]) {
      byExactLabel[raw] = {
        legacy_project_label: raw,
        usage_count: 0,
        first_job_date: jobDate || null,
        last_job_date: jobDate || null,
        job_sheet_ids: [],
        job_sheet_ids_sample: []
      };
    }
    const agg = byExactLabel[raw];
    agg.usage_count += 1;
    if (jobDate) {
      if (!agg.first_job_date || jobDate < agg.first_job_date) agg.first_job_date = jobDate;
      if (!agg.last_job_date || jobDate > agg.last_job_date) agg.last_job_date = jobDate;
    }
    if (jobId && agg.job_sheet_ids.indexOf(jobId) === -1) {
      agg.job_sheet_ids.push(jobId);
    }
    if (agg.job_sheet_ids_sample.length < 5 && jobId) {
      agg.job_sheet_ids_sample.push(jobId);
    }
  });

  if (blankJobCount.count > 0) {
    warnings.push({
      code: "blank_labels",
      message: "Jobs with blank legacy_project_label (project_id Text).",
      count: blankJobCount.count
    });
  }

  const distinctLabels = Object.keys(byExactLabel).sort();
  distinctLabels.forEach(function (label) {
    if (byExactLabel[label].usage_count > 1) {
      warnings.push({
        code: "label_reused_across_jobs",
        message:
          "Label appears on multiple jobs (may be same client reused, or unrelated jobs sharing text).",
        legacy_project_label: label,
        usage_count: byExactLabel[label].usage_count
      });
    }
  });

  // Index masters by exact and normalised display names
  const projectsByExactName = {};
  const projectsByNormName = {};
  projectRows.forEach(function (row) {
    const name = String(row[projectNameColumn] == null ? "" : row[projectNameColumn]).trim();
    if (!name) return;
    if (!projectsByExactName[name]) projectsByExactName[name] = [];
    projectsByExactName[name].push(row);
    const n = fieldosDiagNormalizeLabel_(name);
    if (!n) return;
    if (!projectsByNormName[n]) projectsByNormName[n] = [];
    projectsByNormName[n].push(row);
  });

  const customersByExactName = {};
  const customersByNormName = {};
  customerRows.forEach(function (row) {
    const name = String(row[customerNameColumn] == null ? "" : row[customerNameColumn]).trim();
    if (!name) return;
    if (!customersByExactName[name]) customersByExactName[name] = [];
    customersByExactName[name].push(row);
    const n = fieldosDiagNormalizeLabel_(name);
    if (!n) return;
    if (!customersByNormName[n]) customersByNormName[n] = [];
    customersByNormName[n].push(row);
  });

  // Group distinct raw labels by normalised form
  const byNorm = {};
  distinctLabels.forEach(function (label) {
    const n = fieldosDiagNormalizeLabel_(label);
    if (!byNorm[n]) byNorm[n] = [];
    byNorm[n].push(label);
  });

  Object.keys(byNorm).forEach(function (n) {
    if (byNorm[n].length > 1) {
      warnings.push({
        code: "likely_duplicates_after_normalisation",
        message: "Distinct labels collapse to the same normalised form (punctuation/casing).",
        normalised: n,
        variants: byNorm[n].slice()
      });
    }
  });

  const exact_project_matches = [];
  const exact_customer_matches = [];
  const normalised_matches = [];
  const duplicate_ambiguous_matches = [];
  const safe_for_seed = [];
  const manual_review = [];
  const candidate_seed_labels = [];

  const usedCustIds = {};
  const usedProjIds = {};

  distinctLabels.forEach(function (label) {
    const agg = byExactLabel[label];
    const norm = fieldosDiagNormalizeLabel_(label);
    const variants = byNorm[norm] || [label];
    const hasNormCollision = variants.length > 1;

    const exactProjects = mastersEmpty ? [] : projectsByExactName[label] || [];
    const exactCustomers = mastersEmpty ? [] : customersByExactName[label] || [];
    const normProjects = mastersEmpty ? [] : projectsByNormName[norm] || [];
    const normCustomers = mastersEmpty ? [] : customersByNormName[norm] || [];

    const entryBase = {
      legacy_project_label: label,
      normalised: norm,
      usage_count: agg.usage_count,
      first_job_date: agg.first_job_date,
      last_job_date: agg.last_job_date,
      job_sheet_ids: agg.job_sheet_ids.slice()
    };

    if (!mastersEmpty && exactProjects.length === 1) {
      exact_project_matches.push(
        Object.assign({}, entryBase, {
          matched_project_id: String(exactProjects[0].project_id || "")
        })
      );
    }
    if (!mastersEmpty && exactCustomers.length === 1) {
      exact_customer_matches.push(
        Object.assign({}, entryBase, {
          matched_customer_id: String(exactCustomers[0].customer_id || "")
        })
      );
    }

    const normOnlyProject =
      !mastersEmpty &&
      exactProjects.length === 0 &&
      normProjects.length >= 1 &&
      !normProjects.some(function (r) {
        return String(r[projectNameColumn] || "").trim() === label;
      });
    const normOnlyCustomer =
      !mastersEmpty &&
      exactCustomers.length === 0 &&
      normCustomers.length >= 1 &&
      !normCustomers.some(function (r) {
        return String(r[customerNameColumn] || "").trim() === label;
      });

    if (normOnlyProject || normOnlyCustomer) {
      normalised_matches.push(
        Object.assign({}, entryBase, {
          project_match_count: normProjects.length,
          customer_match_count: normCustomers.length
        })
      );
    }

    const ambiguous =
      hasNormCollision ||
      exactProjects.length > 1 ||
      exactCustomers.length > 1 ||
      normProjects.length > 1 ||
      normCustomers.length > 1;

    if (ambiguous) {
      duplicate_ambiguous_matches.push(
        Object.assign({}, entryBase, {
          reason: hasNormCollision
            ? "normalised_variant_group"
            : "multiple_master_matches",
          variant_labels: variants.slice(),
          exact_project_match_count: exactProjects.length,
          exact_customer_match_count: exactCustomers.length,
          normalised_project_match_count: normProjects.length,
          normalised_customer_match_count: normCustomers.length
        })
      );
      manual_review.push(
        Object.assign({}, entryBase, {
          reason: hasNormCollision
            ? "inconsistent_punctuation_or_casing_variants"
            : "ambiguous_master_or_label_match"
        })
      );
      return;
    }

    const conflictingMasters =
      !mastersEmpty &&
      (exactProjects.length > 0 ||
        exactCustomers.length > 0 ||
        normProjects.length > 0 ||
        normCustomers.length > 0);

    // Masters empty → candidate seeds (not existing matches)
    if (mastersEmpty) {
      const previewCust = fieldosDiagPreviewSeedId_("CUST", label, usedCustIds);
      const previewProj = fieldosDiagPreviewSeedId_("PROJ", label, usedProjIds);
      const previewIdsValid =
        /^CUST-[A-F0-9]+$/.test(previewCust) && /^PROJ-[A-F0-9]+$/.test(previewProj);
      const preview = {
        customer_name: label,
        project_name: label,
        preview_customer_id: previewCust,
        preview_project_id: previewProj,
        source: "legacy_job_label",
        dry_run: true
      };
      candidate_seed_labels.push(Object.assign({}, entryBase, { proposed_seed: preview }));

      const reuseApproved = !!reviewedReuseAllowlist[label];
      const reuseBlocked = agg.usage_count > 1 && !reuseApproved;

      if (reuseBlocked) {
        manual_review.push(
          Object.assign({}, entryBase, {
            reason: "repeated_legacy_label_requires_confirmation",
            proposed_seed: preview
          })
        );
        return;
      }

      // safe_for_seed: non-blank (already), usage_count===1 OR allowlisted,
      // no norm/ambiguity (already returned), no conflicting masters, valid preview IDs
      if (previewIdsValid && !conflictingMasters) {
        safe_for_seed.push(
          Object.assign({}, entryBase, {
            proposed_seed: preview,
            reuse_allowlisted: reuseApproved
          })
        );
      } else {
        manual_review.push(
          Object.assign({}, entryBase, {
            reason: previewIdsValid
              ? "conflicting_or_incomplete_seed_preview"
              : "invalid_preview_ids",
            proposed_seed: preview
          })
        );
      }
      return;
    }

    // Masters present: unmatched unique labels → manual_review (seed is for empty masters).
    const matched =
      exactProjects.length === 1 ||
      exactCustomers.length === 1 ||
      normProjects.length === 1 ||
      normCustomers.length === 1;
    if (!matched) {
      manual_review.push(
        Object.assign({}, entryBase, {
          reason: "unmatched_with_populated_masters"
        })
      );
    }
  });

  // Inconsistent punctuation warning already covered; add casing-only note if raw differs only by case
  distinctLabels.forEach(function (label) {
    const norm = fieldosDiagNormalizeLabel_(label);
    const variants = byNorm[norm] || [];
    if (variants.length > 1) {
      warnings.push({
        code: "inconsistent_punctuation_or_casing",
        message: "Multiple spellings for one normalised client label.",
        normalised: norm,
        variants: variants.slice()
      });
    }
  });

  // Deduplicate warnings by code+label/normalised
  const seenWarn = {};
  const dedupedWarnings = [];
  warnings.forEach(function (w) {
    const key =
      w.code +
      "|" +
      (w.legacy_project_label || "") +
      "|" +
      (w.normalised || "") +
      "|" +
      (w.variants ? w.variants.join("^") : "");
    if (seenWarn[key]) return;
    seenWarn[key] = true;
    dedupedWarnings.push(w);
  });

  return {
    diagnostic: "fieldosDiagBuildReconciliationReport_",
    read_only: true,
    dry_run: true,
    appsheet_project_id: {
      type: "Text",
      ref_table: null,
      ui_label: "client",
      fieldos_treat_as: "legacy_project_label",
      note: "Column name project_id is misleading; stores human-readable client/project text."
    },
    masters: {
      tbl_projects_row_count: projectRows.length,
      tbl_customers_row_count: customerRows.length,
      empty: mastersEmpty
    },
    blank_labels: blankJobCount,
    distinct_label_count: distinctLabels.length,
    distinct_labels: distinctLabels.map(function (label) {
      const a = byExactLabel[label];
      return {
        legacy_project_label: label,
        usage_count: a.usage_count,
        first_job_date: a.first_job_date,
        last_job_date: a.last_job_date,
        job_sheet_ids: a.job_sheet_ids.slice(),
        job_sheet_ids_sample: a.job_sheet_ids_sample
      };
    }),
    exact_project_matches: exact_project_matches,
    exact_customer_matches: exact_customer_matches,
    normalised_matches: normalised_matches,
    duplicate_ambiguous_matches: duplicate_ambiguous_matches,
    candidate_seed_labels: candidate_seed_labels,
    safe_for_seed: safe_for_seed,
    manual_review: manual_review,
    warnings: dedupedWarnings,
    policy: {
      do_not_attempt_pk_only_joins: true,
      do_not_rewrite_historical_rows: true,
      do_not_seed_masters_in_phase_0: true,
      master_population: "separate_approved_migration",
      safe_for_seed_requires_single_usage_unless_allowlisted: true,
      reviewed_reuse_allowlist: Object.keys(reviewedReuseAllowlist)
    }
  };
}

/**
 * MANUAL TEST 3 — Phase 0 reconciliation of legacy Text project_id labels (read-only).
 * Treats tbl_job_sheets.project_id as legacy_project_label (AppSheet Text, not Ref).
 *
 * Optional: pass reviewed reuse allowlist by editing REVIEWED_REUSE_ALLOWLIST below
 * before Run (exact labels that may share one customer/project despite usage_count>1).
 */
function testFieldOSProjectCustomerReconciliation() {
  const REVIEWED_REUSE_ALLOWLIST = [
    // e.g. "smith"  // only after explicit human confirmation that all jobs share one client
  ];

  const report = {
    diagnostic: "testFieldOSProjectCustomerReconciliation",
    read_only: true,
    dry_run: true,
    error: null
  };

  try {
    const jobs = JobSheetRepository.findAll() || [];
    let projects = [];
    let customers = [];
    try {
      projects = ProjectRepository.findAll() || [];
    } catch (err) {
      projects = [];
    }
    try {
      customers = CustomerRepository.findAll() || [];
    } catch (err) {
      customers = [];
    }

    const built = fieldosDiagBuildReconciliationReport_(jobs, projects, customers, {
      label_column: "project_id",
      date_column: "date",
      project_name_column: "project_name",
      customer_name_column: "customer_name",
      reviewed_reuse_allowlist: REVIEWED_REUSE_ALLOWLIST
    });

    Object.keys(built).forEach(function (k) {
      report[k] = built[k];
    });
    report.diagnostic = "testFieldOSProjectCustomerReconciliation";
    report.job_row_count = jobs.length;
  } catch (err) {
    report.error = String(err && err.message ? err.message : err);
  }

  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * Approved Phase-1 seed labels (explicit human approval). smith is intentionally excluded.
 */
var FIELDOS_APPROVED_SEED_LABELS_ = ["Babidge", "Kat and James Dykes"];

function fieldosDiagApprovedSeedLabelSet_(labels) {
  const set = {};
  (labels || FIELDOS_APPROVED_SEED_LABELS_).forEach(function (label) {
    const key = String(label || "").trim();
    if (key) set[key] = true;
  });
  return set;
}

/**
 * Restrict a reconciliation report's safe_for_seed to the approved label list.
 */
function fieldosDiagFilterApprovedSafeSeeds_(reconciliationReport, approvedLabels) {
  const report = reconciliationReport || {};
  const allow = fieldosDiagApprovedSeedLabelSet_(approvedLabels);
  const safe = (report.safe_for_seed || []).filter(function (row) {
    return allow[String(row.legacy_project_label || "").trim()];
  });
  const filtered = {};
  Object.keys(report).forEach(function (k) {
    filtered[k] = report[k];
  });
  filtered.safe_for_seed = safe;
  filtered.approved_seed_labels = Object.keys(allow).sort();
  filtered.safe_for_seed_filtered_to_approved = true;
  return filtered;
}

/**
 * Keep only object keys that exist on the sheet header row (DB.insertRecord validates strictly).
 */
function fieldosDiagPickWritableFields_(headers, obj) {
  const headerSet = {};
  (headers || []).forEach(function (h) {
    const key = String(h || "").trim();
    if (key) headerSet[key] = true;
  });
  const out = {};
  Object.keys(obj || {}).forEach(function (k) {
    if (headerSet[k]) out[k] = obj[k];
  });
  return out;
}

/**
 * Build a read-only dry-run seed manifest from safe_for_seed (optionally filtered to approved labels).
 * Never writes Sheets. Preview IDs are reporting-only.
 */
function fieldosDiagBuildMasterSeedDryRunManifest_(reconciliationReport, options) {
  const opts = options || {};
  const report = reconciliationReport || {};
  const approvedLabels = opts.approved_seed_labels || FIELDOS_APPROVED_SEED_LABELS_;
  const filteredReport = opts.skip_approved_filter
    ? report
    : fieldosDiagFilterApprovedSafeSeeds_(report, approvedLabels);
  const safe = filteredReport.safe_for_seed || [];
  const batchId =
    opts.migration_batch_id ||
    "SEED-DRYRUN-" + String(Date.now());

  const customers = [];
  const projects = [];

  safe.forEach(function (row) {
    const seed = row.proposed_seed || {};
    const label = row.legacy_project_label;
    customers.push({
      customer_id: seed.preview_customer_id,
      customer_name: seed.customer_name || label,
      source: seed.source || "legacy_job_label",
      migration_batch_id: batchId,
      original_legacy_label: label,
      usage_count: row.usage_count,
      affected_job_sheet_ids: (row.job_sheet_ids || []).slice(),
      dry_run: true
    });
    projects.push({
      project_id: seed.preview_project_id,
      project_name: seed.project_name || label,
      customer_id: seed.preview_customer_id,
      source: seed.source || "legacy_job_label",
      migration_batch_id: batchId,
      original_legacy_label: label,
      usage_count: row.usage_count,
      affected_job_sheet_ids: (row.job_sheet_ids || []).slice(),
      dry_run: true
    });
  });

  return {
    diagnostic: "fieldosDiagBuildMasterSeedDryRunManifest_",
    read_only: true,
    dry_run: true,
    migration_batch_id: batchId,
    approved_seed_labels: (approvedLabels || []).slice(),
    policy: {
      includes_only_safe_for_seed: true,
      filtered_to_approved_labels: !opts.skip_approved_filter,
      does_not_write_sheets: true,
      does_not_modify_historical_job_rows: true,
      excluded_blank_labels: true,
      excluded_smith_and_manual_review: true,
      excluded_manual_review_unless_allowlisted: true
    },
    counts: {
      safe_for_seed: safe.length,
      customer_rows: customers.length,
      project_rows: projects.length,
      manual_review_excluded: (report.manual_review || []).length,
      candidate_not_safe: Math.max(
        0,
        (report.candidate_seed_labels || []).length - (report.safe_for_seed || []).length
      )
    },
    customers: customers,
    projects: projects
  };
}

/**
 * Apply seed rows. Requires confirmApply === "APPLY". Always expects a prior dry-run manifest.
 * Does not touch tbl_job_sheets.
 */
function fieldosDiagApplyMasterSeed_(dryRunManifest, options) {
  const opts = options || {};
  const confirm = String(opts.confirm_apply || "");
  const manifest = dryRunManifest || {};
  const result = {
    diagnostic: "fieldosDiagApplyMasterSeed_",
    dry_run: confirm !== "APPLY",
    confirm_apply: confirm === "APPLY" ? "APPLY" : "(not APPLY)",
    migration_batch_id: manifest.migration_batch_id || null,
    wrote: false,
    customers_written: [],
    projects_written: [],
    skipped: [],
    errors: [],
    rollback_manifest: null,
    policy: {
      does_not_modify_historical_job_rows: true,
      requires_explicit_APPLY: true,
      requires_final_dry_run_first: true
    }
  };

  if (!manifest.customers || !manifest.projects) {
    result.errors.push("Missing dry-run manifest customers/projects.");
    return result;
  }

  if (confirm !== "APPLY") {
    result.message =
      "Dry-run only. Set confirm_apply to exactly \"APPLY\" to write tbl_customers / tbl_projects.";
    result.rollback_manifest = {
      migration_batch_id: manifest.migration_batch_id,
      note: "No rows written.",
      delete_customer_ids: [],
      delete_project_ids: []
    };
    return result;
  }

  // Live write path
  let customerHeaders = [];
  let projectHeaders = [];
  try {
    customerHeaders = DB.getHeaders("tbl_customers") || [];
    projectHeaders = DB.getHeaders("tbl_projects") || [];
  } catch (err) {
    result.errors.push(String(err && err.message ? err.message : err));
    return result;
  }

  const batchId = manifest.migration_batch_id || "SEED-APPLY-" + String(Date.now());
  result.migration_batch_id = batchId;

  (manifest.customers || []).forEach(function (row) {
    try {
      const existing = CustomerRepository.findById(row.customer_id);
      if (existing) {
        result.skipped.push({
          table: "tbl_customers",
          customer_id: row.customer_id,
          reason: "already_exists"
        });
        return;
      }
      const payload = fieldosDiagPickWritableFields_(customerHeaders, {
        customer_id: row.customer_id,
        customer_name: row.customer_name,
        source: row.source,
        migration_batch_id: batchId,
        original_legacy_label: row.original_legacy_label
      });
      if (!payload.customer_id || !payload.customer_name) {
        result.errors.push(
          "Customer row missing required writable fields for " + row.original_legacy_label
        );
        return;
      }
      CustomerRepository.create(payload);
      result.customers_written.push({
        customer_id: payload.customer_id,
        customer_name: payload.customer_name,
        original_legacy_label: row.original_legacy_label,
        affected_job_sheet_ids: (row.affected_job_sheet_ids || []).slice()
      });
    } catch (err) {
      result.errors.push(
        "tbl_customers " +
          row.customer_id +
          ": " +
          String(err && err.message ? err.message : err)
      );
    }
  });

  (manifest.projects || []).forEach(function (row) {
    try {
      const existing = ProjectRepository.findById(row.project_id);
      if (existing) {
        result.skipped.push({
          table: "tbl_projects",
          project_id: row.project_id,
          reason: "already_exists"
        });
        return;
      }
      const payload = fieldosDiagPickWritableFields_(projectHeaders, {
        project_id: row.project_id,
        project_name: row.project_name,
        customer_id: row.customer_id,
        source: row.source,
        migration_batch_id: batchId,
        original_legacy_label: row.original_legacy_label
      });
      if (!payload.project_id || !payload.project_name) {
        result.errors.push(
          "Project row missing required writable fields for " + row.original_legacy_label
        );
        return;
      }
      ProjectRepository.create(payload);
      result.projects_written.push({
        project_id: payload.project_id,
        project_name: payload.project_name,
        customer_id: payload.customer_id || null,
        original_legacy_label: row.original_legacy_label,
        affected_job_sheet_ids: (row.affected_job_sheet_ids || []).slice()
      });
    } catch (err) {
      result.errors.push(
        "tbl_projects " +
          row.project_id +
          ": " +
          String(err && err.message ? err.message : err)
      );
    }
  });

  result.wrote =
    result.customers_written.length > 0 || result.projects_written.length > 0;
  result.rollback_manifest = {
    migration_batch_id: batchId,
    note:
      "To roll back: delete the listed rows from tbl_customers and tbl_projects only. Do NOT modify tbl_job_sheets.project_id.",
    delete_customer_ids: result.customers_written.map(function (r) {
      return r.customer_id;
    }),
    delete_project_ids: result.projects_written.map(function (r) {
      return r.project_id;
    }),
    customers_written: result.customers_written.slice(),
    projects_written: result.projects_written.slice()
  };
  return result;
}

/**
 * MANUAL TEST 4 — Dry-run master seed manifest for approved labels only (read-only).
 * Approved: Babidge, Kat and James Dykes. Does not seed smith. Does not write Sheets.
 */
function testFieldOSMasterSeedDryRun() {
  const recon = testFieldOSProjectCustomerReconciliation();
  const manifest = {
    diagnostic: "testFieldOSMasterSeedDryRun",
    read_only: true,
    dry_run: true,
    error: null
  };

  try {
    if (recon && recon.error) {
      manifest.error = recon.error;
      Logger.log(JSON.stringify(manifest, null, 2));
      return manifest;
    }
    const batchId =
      typeof Utilities !== "undefined" && Utilities.formatDate
        ? "SEED-DRYRUN-" +
          Utilities.formatDate(
            new Date(),
            typeof Session !== "undefined" && Session.getScriptTimeZone
              ? Session.getScriptTimeZone()
              : "UTC",
            "yyyyMMdd-HHmmss"
          )
        : "SEED-DRYRUN-" + String(Date.now());
    const built = fieldosDiagBuildMasterSeedDryRunManifest_(recon, {
      migration_batch_id: batchId,
      approved_seed_labels: FIELDOS_APPROVED_SEED_LABELS_
    });
    Object.keys(built).forEach(function (k) {
      manifest[k] = built[k];
    });
    manifest.diagnostic = "testFieldOSMasterSeedDryRun";
    manifest.reconciliation_summary = {
      job_row_count: recon.job_row_count,
      distinct_label_count: recon.distinct_label_count,
      blank_label_count: recon.blank_labels ? recon.blank_labels.count : null,
      safe_for_seed_labels: (recon.safe_for_seed || []).map(function (r) {
        return r.legacy_project_label;
      }),
      approved_seed_labels: FIELDOS_APPROVED_SEED_LABELS_.slice(),
      manual_review_labels: (recon.manual_review || []).map(function (r) {
        return {
          legacy_project_label: r.legacy_project_label,
          reason: r.reason,
          usage_count: r.usage_count
        };
      })
    };
  } catch (err) {
    manifest.error = String(err && err.message ? err.message : err);
  }

  Logger.log(JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * MANUAL TEST 5 — Seed approved master rows (Babidge, Kat and James Dykes).
 *
 * Safety gate:
 *   1) Always runs a final dry-run first and logs it.
 *   2) Writes ONLY when CONFIRM_APPLY is exactly "APPLY".
 *   3) Never rewrites tbl_job_sheets.project_id.
 *   4) Never seeds smith / blanks.
 *
 * After a successful APPLY, save the logged rollback_manifest.
 */
function testFieldOSMasterSeedApply() {
  // ========== EXPLICIT CONFIRMATION GATE ==========
  // Leave as "" for dry-run only. Set to exactly APPLY to write.
  const CONFIRM_APPLY = "";
  // ================================================

  const out = {
    diagnostic: "testFieldOSMasterSeedApply",
    error: null
  };

  try {
    const recon = testFieldOSProjectCustomerReconciliation();
    if (recon && recon.error) {
      out.error = recon.error;
      Logger.log(JSON.stringify(out, null, 2));
      return out;
    }

    const batchId =
      typeof Utilities !== "undefined" && Utilities.formatDate
        ? "SEED-" +
          (CONFIRM_APPLY === "APPLY" ? "APPLY-" : "DRYRUN-") +
          Utilities.formatDate(
            new Date(),
            typeof Session !== "undefined" && Session.getScriptTimeZone
              ? Session.getScriptTimeZone()
              : "UTC",
            "yyyyMMdd-HHmmss"
          )
        : "SEED-" + (CONFIRM_APPLY === "APPLY" ? "APPLY-" : "DRYRUN-") + String(Date.now());

    const dryRun = fieldosDiagBuildMasterSeedDryRunManifest_(recon, {
      migration_batch_id: batchId,
      approved_seed_labels: FIELDOS_APPROVED_SEED_LABELS_
    });
    out.final_dry_run = dryRun;

    if (!dryRun.customers || dryRun.customers.length !== 2 || dryRun.projects.length !== 2) {
      out.error =
        "Final dry-run must contain exactly 2 customers and 2 projects (Babidge, Kat and James Dykes). Aborting.";
      Logger.log(JSON.stringify(out, null, 2));
      return out;
    }

    const applyResult = fieldosDiagApplyMasterSeed_(dryRun, {
      confirm_apply: CONFIRM_APPLY
    });
    out.apply = applyResult;
    out.message =
      CONFIRM_APPLY === "APPLY"
        ? applyResult.errors.length
          ? "APPLY finished with errors — inspect apply.errors and rollback_manifest."
          : "APPLY completed. Save rollback_manifest. Job sheets were not modified."
        : "Dry-run only. Re-run with CONFIRM_APPLY=\"APPLY\" to write.";
  } catch (err) {
    out.error = String(err && err.message ? err.message : err);
  }

  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * Build sanitised dual-read sample rows (pure / injectable).
 * Does not write. Does not call FieldOS HTTP APIs.
 *
 * @param {Array<object>} jobs job rows with job_sheet_id + project_id
 * @param {object} displayMaps from fieldosBuildDisplayMaps_ / fieldosLoadDisplayMaps_
 * @returns {Array<{job_sheet_id:string, raw_project_id:string, project_name:string, customer_name:string, match:string}>}
 */
function fieldosDiagBuildDisplayResolveSampleRows_(jobs, displayMaps) {
  const rows = [];
  (jobs || []).forEach(function (job) {
    if (!job) return;
    const jobSheetId = String(job.job_sheet_id || "").trim();
    if (!jobSheetId) return;
    const raw = String(job.project_id == null ? "" : job.project_id).trim();
    const resolved =
      typeof fieldosResolveProjectCustomer_ === "function"
        ? fieldosResolveProjectCustomer_(raw, displayMaps || {})
        : { project_name: raw, customer_name: "", match: "fallback" };
    rows.push({
      job_sheet_id: jobSheetId,
      raw_project_id: raw,
      project_name: String(resolved.project_name || ""),
      customer_name: String(resolved.customer_name || ""),
      match: String(resolved.match || "fallback")
    });
  });
  return rows;
}

/**
 * MANUAL TEST 6 — Read-only dual-read sample for known labels (editor only).
 * Reports only job_sheet_id, raw project_id, resolved project_name, customer_name.
 * Does NOT bypass FieldOS API AuthZ (not an HTTP endpoint). Does NOT write.
 */
function testFieldOSDisplayResolveSample() {
  const TARGET_IDS = [
    "21759f5d", // Kat and James Dykes
    "9d395bbd", // Babidge
    "e17cc590", // smith
    "bcedd86f" // smith
  ];

  const report = {
    diagnostic: "testFieldOSDisplayResolveSample",
    read_only: true,
    writes: false,
    bypasses_fieldos_api_authz: false,
    note:
      "Editor-only sample. Uses JobSheetRepository + dual-read maps. Not exposed via doPost.",
    rows: [],
    blank_sample: null,
    limitations: {
      smith_unseeded: true,
      blank_labels_remain_blank: true
    },
    error: null
  };

  try {
    const maps =
      typeof fieldosLoadDisplayMaps_ === "function"
        ? fieldosLoadDisplayMaps_()
        : { projectById: {}, customerById: {}, projectByExactName: {}, projectByNormName: {} };

    const jobs = [];
    const missing = [];
    TARGET_IDS.forEach(function (id) {
      const job =
        typeof JobSheetRepository !== "undefined" && JobSheetRepository.findById
          ? JobSheetRepository.findById(id)
          : null;
      if (job) jobs.push(job);
      else missing.push(id);
    });

    const resolved = fieldosDiagBuildDisplayResolveSampleRows_(jobs, maps);
    resolved.forEach(function (row) {
      row.job_found = true;
      report.rows.push(row);
    });
    missing.forEach(function (id) {
      report.rows.push({
        job_sheet_id: id,
        raw_project_id: null,
        project_name: null,
        customer_name: null,
        match: null,
        job_found: false
      });
    });

    // One blank-label sample if present (for verify blank → empty names)
    if (typeof JobSheetRepository !== "undefined" && JobSheetRepository.findAll) {
      const all = JobSheetRepository.findAll() || [];
      for (let i = 0; i < all.length; i++) {
        const raw = String(all[i].project_id == null ? "" : all[i].project_id).trim();
        if (!raw) {
          const blankRows = fieldosDiagBuildDisplayResolveSampleRows_([all[i]], maps);
          report.blank_sample = blankRows[0] || null;
          if (report.blank_sample) report.blank_sample.job_found = true;
          break;
        }
      }
    }
  } catch (err) {
    report.error = String(err && err.message ? err.message : err);
  }

  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * MANUAL TEST 7 — Read-only Whisper upload metadata for a recording (default REC-819FC620).
 * Logs Drive name/MIME, blob name/MIME, byte length, and normalised upload name/MIME.
 * Does NOT call OpenAI. Does NOT log file bytes or secrets.
 *
 * NOTE: Do NOT call RecordingRepository.findById — Repositories.js constructs
 * RecordingRepository with an options object, so BaseRepository.tableName becomes
 * [object Object] and DB throws "Table '[object Object]' missing."
 * Use DB.findById("tbl_recordings", "recording_id", id) instead (same pattern as FieldOSGateway).
 *
 * @param {string=} recordingIdOpt
 */
function fieldosDiagAssertTableName_(tableName, caller) {
  if (typeof tableName !== "string" || !String(tableName).trim()) {
    const got =
      tableName !== null && typeof tableName === "object"
        ? "[object Object]"
        : typeof tableName;
    throw new Error(
      (caller || "fieldosDiag") +
        ": table name must be a non-empty string, got " +
        got
    );
  }
  return String(tableName).trim();
}

/**
 * Read-only load of one tbl_recordings row by recording_id.
 * @param {string} recordingId
 * @returns {object|null}
 */
function fieldosDiagFindRecordingById_(recordingId) {
  const id = String(recordingId == null ? "" : recordingId).trim();
  if (!id) throw new Error("fieldosDiagFindRecordingById_: recording_id is required.");

  const table = fieldosDiagAssertTableName_(
    "tbl_recordings",
    "fieldosDiagFindRecordingById_"
  );

  if (typeof DB === "undefined" || typeof DB.findById !== "function") {
    throw new Error("DB.findById is unavailable.");
  }

  // Signature: DB.findById(tableName, keyColumn, id) — all strings.
  return DB.findById(table, "recording_id", id);
}

function testFieldOSRecordingWhisperBlobMeta(recordingIdOpt) {
  const recordingId = String(
    recordingIdOpt == null || recordingIdOpt === ""
      ? "REC-819FC620"
      : recordingIdOpt
  ).trim();

  const report = {
    diagnostic: "testFieldOSRecordingWhisperBlobMeta",
    read_only: true,
    calls_openai: false,
    recording_id: recordingId,
    recording_drive_file_id_present: false,
    recording_name: null,
    stored_mime_fields: null,
    drive_filename: null,
    drive_mime_type: null,
    raw_blob_name: null,
    raw_blob_content_type: null,
    raw_blob_byte_length: null,
    proposed_normalised_filename: null,
    proposed_normalised_content_type: null,
    format_supported: null,
    error: null
  };

  try {
    const row = fieldosDiagFindRecordingById_(recordingId);
    if (!row) {
      report.error = "Recording not found.";
      Logger.log(JSON.stringify(report, null, 2));
      return report;
    }

    const driveId = String(row.recording_drive_file_id || "").trim();
    report.recording_drive_file_id_present = !!driveId;
    report.recording_name = String(row.recording_name || "");
    report.stored_mime_fields = {
      mime_type: row.mime_type != null ? String(row.mime_type) : null,
      content_type: row.content_type != null ? String(row.content_type) : null,
      recording_mime: row.recording_mime != null ? String(row.recording_mime) : null
    };

    if (!driveId) {
      report.error = "recording_drive_file_id is blank.";
      Logger.log(JSON.stringify(report, null, 2));
      return report;
    }

    const file = DriveApp.getFileById(driveId);
    report.drive_filename = String(file.getName() || "");
    report.drive_mime_type = String(file.getMimeType() || "");

    const blob = file.getBlob();
    const rawBytes = blob.getBytes();
    report.raw_blob_name = String(blob.getName() || "");
    report.raw_blob_content_type = String(blob.getContentType() || "");
    report.raw_blob_byte_length = rawBytes && rawBytes.length ? rawBytes.length : 0;

    if (typeof fieldosVpPrepareWhisperUploadBlob_ === "function") {
      try {
        const normalised = fieldosVpPrepareWhisperUploadBlob_(blob, {
          recording_id: recordingId,
          recording_name: row.recording_name,
          drive_file_name: file.getName()
        });
        report.proposed_normalised_filename = String(normalised.getName() || "");
        report.proposed_normalised_content_type = String(
          normalised.getContentType() || ""
        );
        report.format_supported = true;
      } catch (normErr) {
        report.format_supported = false;
        report.error = String(normErr && normErr.message ? normErr.message : normErr);
      }
    } else {
      report.format_supported = null;
      report.error =
        "fieldosVpPrepareWhisperUploadBlob_ unavailable — update VoiceProcessing.gs first";
    }
  } catch (err) {
    report.error = String(err && err.message ? err.message : err);
  }

  Logger.log(JSON.stringify(report, null, 2));
  return report;
}
