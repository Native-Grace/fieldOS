/**
 * FieldOS display-name resolution helpers (pure / injectable).
 *
 * Dual-read for legacy AppSheet Text labels in tbl_job_sheets.project_id:
 *   a) exact tbl_projects.project_id
 *   b) exact tbl_projects.project_name
 *   c) normalised exact tbl_projects.project_name
 *   d) fallback: project_name = raw, customer_name = ""
 *
 * When a project matches:
 *   project_name = project.project_name
 *   customer via project.customer_id → tbl_customers.customer_id
 *
 * Duplicate exact/normalised project names: do not pick arbitrarily; safe fallback + warning.
 * Batch maps loaded once per list/detail request (no N+1).
 *
 * Does not write Sheets. Does not rewrite historical job rows.
 */

/**
 * Normalise labels for exact-after-normalisation matching (no fuzzy).
 * trim → lowercase → strip common punctuation → collapse whitespace
 */
function fieldosNormalizeDisplayLabel_(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} projectKey raw tbl_job_sheets.project_id (may be PROJ- id or legacy label)
 * @param {object} displayMaps from fieldosBuildDisplayMaps_
 * @returns {{project_name: string, customer_name: string, match: string, warning: string|null}}
 */
function fieldosResolveProjectCustomer_(projectKey, displayMaps, maybeCustomerById) {
  // Backward compat: (key, projectById, customerById)
  let maps = displayMaps;
  if (
    maps &&
    typeof maps === "object" &&
    maps.projectById === undefined &&
    maybeCustomerById !== undefined
  ) {
    maps = fieldosBuildDisplayMaps_(
      Object.keys(displayMaps || {}).map(function (id) {
        return displayMaps[id];
      }),
      Object.keys(maybeCustomerById || {}).map(function (id) {
        return maybeCustomerById[id];
      })
    );
  }
  maps = maps || {};

  const raw = projectKey == null ? "" : String(projectKey).trim();
  if (!raw) {
    return {
      project_name: "",
      customer_name: "",
      match: "blank",
      warning: null
    };
  }

  try {
    const projectById = maps.projectById || {};
    const customerById = maps.customerById || {};
    const byExactName = maps.projectByExactName || {};
    const byNormName = maps.projectByNormName || {};

    let project = null;
    let match = "fallback";
    let warning = null;

    // a) exact project_id
    if (projectById[raw]) {
      project = projectById[raw];
      match = "project_id";
    }

    // b) exact project_name (only if no PK hit — PK takes precedence)
    if (!project) {
      const exactHits = byExactName[raw] || [];
      if (exactHits.length === 1) {
        project = exactHits[0];
        match = "project_name_exact";
      } else if (exactHits.length > 1) {
        warning =
          "ambiguous_exact_project_name:" +
          fieldosNormalizeDisplayLabel_(raw) +
          ":count=" +
          exactHits.length;
        return {
          project_name: raw,
          customer_name: "",
          match: "fallback",
          warning: warning
        };
      }
    }

    // c) normalised project_name
    if (!project) {
      const norm = fieldosNormalizeDisplayLabel_(raw);
      const normHits = norm ? byNormName[norm] || [] : [];
      if (normHits.length === 1) {
        project = normHits[0];
        match = "project_name_normalised";
      } else if (normHits.length > 1) {
        warning =
          "ambiguous_normalised_project_name:" + norm + ":count=" + normHits.length;
        return {
          project_name: raw,
          customer_name: "",
          match: "fallback",
          warning: warning
        };
      }
    }

    // d) fallback
    if (!project) {
      return {
        project_name: raw,
        customer_name: "",
        match: "fallback",
        warning: null
      };
    }

    const projectName = String(
      project.project_name || project.name || raw || ""
    ).trim();

    const customerId = String(project.customer_id || "").trim();
    if (!customerId) {
      return {
        project_name: projectName || raw,
        customer_name: "",
        match: match,
        warning: null
      };
    }

    const customer = customerById[customerId] || null;
    if (!customer) {
      return {
        project_name: projectName || raw,
        customer_name: "",
        match: match,
        warning: null
      };
    }

    const customerName = String(
      customer.customer_name || customer.name || ""
    ).trim();
    return {
      project_name: projectName || raw,
      customer_name: customerName,
      match: match,
      warning: null
    };
  } catch (err) {
    return {
      project_name: raw,
      customer_name: "",
      match: "fallback",
      warning: null
    };
  }
}

/**
 * Build lookup maps once per request (avoids N+1 findById).
 * @returns {{
 *   projectById: Object,
 *   customerById: Object,
 *   projectByExactName: Object.<string, Array>,
 *   projectByNormName: Object.<string, Array>
 * }}
 */
function fieldosBuildDisplayMaps_(projects, customers) {
  const projectById = {};
  const customerById = {};
  const projectByExactName = {};
  const projectByNormName = {};

  (projects || []).forEach(function (row) {
    if (!row) return;
    const id = String(row.project_id || "").trim();
    if (id) projectById[id] = row;

    const name = String(row.project_name || row.name || "").trim();
    if (name) {
      if (!projectByExactName[name]) projectByExactName[name] = [];
      projectByExactName[name].push(row);
      const norm = fieldosNormalizeDisplayLabel_(name);
      if (norm) {
        if (!projectByNormName[norm]) projectByNormName[norm] = [];
        projectByNormName[norm].push(row);
      }
    }
  });

  (customers || []).forEach(function (row) {
    if (!row) return;
    const id = String(row.customer_id || "").trim();
    if (id) customerById[id] = row;
  });

  return {
    projectById: projectById,
    customerById: customerById,
    projectByExactName: projectByExactName,
    projectByNormName: projectByNormName
  };
}

/**
 * Load maps from repositories; never throws.
 */
function fieldosLoadDisplayMaps_() {
  try {
    const projects =
      typeof ProjectRepository !== "undefined" && ProjectRepository.findAll
        ? ProjectRepository.findAll() || []
        : [];
    const customers =
      typeof CustomerRepository !== "undefined" && CustomerRepository.findAll
        ? CustomerRepository.findAll() || []
        : [];
    return fieldosBuildDisplayMaps_(projects, customers);
  } catch (err) {
    return {
      projectById: {},
      customerById: {},
      projectByExactName: {},
      projectByNormName: {}
    };
  }
}
