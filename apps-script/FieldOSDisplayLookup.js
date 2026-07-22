/**
 * FieldOS display-name resolution helpers (pure / injectable).
 *
 * Intended join (when live headers confirm):
 *   tbl_job_sheets.project_id → tbl_projects.project_id
 *   tbl_projects.customer_id  → tbl_customers.customer_id
 *
 * Display columns (assumed until live header dump confirms):
 *   tbl_projects.project_name (fallback: name)
 *   tbl_customers.customer_name (fallback: name)
 *
 * Behaviour:
 * - Blank project_id → empty project_name + customer_name
 * - Project missing → keep raw project_id as project_name (preserves sheets that store a display string in project_id); customer_name ""
 * - Project found, customer missing → project display name; customer_name ""
 * - Lookup errors never throw to callers (return safe fallback)
 *
 * Apps Script loads this file as a sibling script. Node tests import the same functions
 * via apps-script/tests/display_lookup.test.mjs (duplicated require-free copy below is
 * the source of truth loaded by FieldOSGateway).
 */

/**
 * @param {string} projectId
 * @param {Object.<string, object>|null} projectById
 * @param {Object.<string, object>|null} customerById
 * @returns {{project_name: string, customer_name: string}}
 */
function fieldosResolveProjectCustomer_(projectId, projectById, customerById) {
  const raw = projectId == null ? "" : String(projectId).trim();
  if (!raw) {
    return { project_name: "", customer_name: "" };
  }

  try {
    const projects = projectById || {};
    const customers = customerById || {};
    const project = projects[raw] || null;
    if (!project) {
      // Preserve human-readable sheet values when project_id is not a tbl_projects key.
      return { project_name: raw, customer_name: "" };
    }

    const projectName = String(
      project.project_name || project.name || raw || ""
    ).trim();

    const customerId = String(project.customer_id || "").trim();
    if (!customerId) {
      return { project_name: projectName || raw, customer_name: "" };
    }

    const customer = customers[customerId] || null;
    if (!customer) {
      return { project_name: projectName || raw, customer_name: "" };
    }

    const customerName = String(
      customer.customer_name || customer.name || ""
    ).trim();
    return {
      project_name: projectName || raw,
      customer_name: customerName
    };
  } catch (err) {
    return { project_name: raw, customer_name: "" };
  }
}

/**
 * Build id→row maps once per request (avoids N+1 findById).
 * @param {Array<object>|null} projects
 * @param {Array<object>|null} customers
 * @returns {{projectById: Object.<string, object>, customerById: Object.<string, object>}}
 */
function fieldosBuildDisplayMaps_(projects, customers) {
  const projectById = {};
  const customerById = {};
  (projects || []).forEach(function (row) {
    if (!row) return;
    const id = String(row.project_id || "").trim();
    if (id) projectById[id] = row;
  });
  (customers || []).forEach(function (row) {
    if (!row) return;
    const id = String(row.customer_id || "").trim();
    if (id) customerById[id] = row;
  });
  return { projectById: projectById, customerById: customerById };
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
    return { projectById: {}, customerById: {} };
  }
}
