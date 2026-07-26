/**
 * Phase 3E — decimal-safe money + rate resolution helpers.
 * Safe for Apps Script and Node tests (no SpreadsheetApp / Drive).
 *
 * Money policy:
 * - Store/compute in integer cents (AUD).
 * - Quantities use micro-units (×1_000_000) then divide.
 * - Round half-up to cents at line level; sum rounded line cents.
 * - Never use binary float for currency totals.
 * - Never silently fall back to zero rates.
 */

var FIELDOS_CURRENCY_DEFAULT_ = "AUD";

var FIELDOS_RATE_STATUS_ = {
  ACTIVE: "Active",
  INACTIVE: "Inactive"
};

var FIELDOS_SNAPSHOT_STATUS_ = {
  DRAFT: "Draft",
  VALIDATED: "Validated",
  APPROVED: "Approved",
  SUPERSEDED: "Superseded",
  CANCELLED: "Cancelled"
};

var FIELDOS_LINE_TYPES_ = {
  LABOUR: "labour",
  TRAVEL: "travel",
  MACHINERY: "machinery",
  MATERIAL: "material"
};

var FIELDOS_RATE_SOURCE_ = {
  PROJECT: "customer_project_override",
  CUSTOMER: "customer_override",
  STAFF: "staff_specific",
  ROLE: "role_activity",
  DEFAULT_CARD: "default_rate_card",
  UNRESOLVED: "unresolved"
};

function fieldosMoneyIsBlank_(value) {
  return value == null || value === "";
}

/** Parse money-like input to integer cents. Rejects non-finite / empty. */
function fieldosParseMoneyToCents_(value) {
  if (fieldosMoneyIsBlank_(value)) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return fieldosRoundHalfUpToInt_(value * 100);
  }
  var s = String(value).trim().replace(/,/g, "");
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  var neg = s.charAt(0) === "-";
  if (neg) s = s.slice(1);
  var parts = s.split(".");
  var whole = parts[0] || "0";
  var frac = (parts[1] || "") + "00";
  frac = frac.slice(0, 2);
  // Capture third decimal for half-up when present.
  var third = (parts[1] || "").length > 2 ? Number((parts[1] || "").charAt(2)) : 0;
  var cents = Number(whole) * 100 + Number(frac);
  if (third >= 5) cents += 1;
  return neg ? -cents : cents;
}

function fieldosRoundHalfUpToInt_(n) {
  if (!Number.isFinite(n)) return null;
  return n >= 0 ? Math.floor(n + 0.5) : Math.ceil(n - 0.5);
}

function fieldosCentsToMoneyString_(cents) {
  if (cents == null || !Number.isFinite(Number(cents))) return null;
  var n = Math.trunc(Number(cents));
  var neg = n < 0;
  var abs = Math.abs(n);
  var whole = Math.floor(abs / 100);
  var frac = abs % 100;
  var s = whole + "." + (frac < 10 ? "0" : "") + frac;
  return neg ? "-" + s : s;
}

/**
 * Line amount in cents: quantity × unitRateCents, half-up.
 * quantity may be fractional (hours, units).
 */
function fieldosLineAmountCents_(quantity, unitRateCents) {
  if (unitRateCents == null || !Number.isFinite(Number(unitRateCents))) return null;
  if (quantity == null || quantity === "" || !Number.isFinite(Number(quantity))) return null;
  // Work in micro-cents: qty * 1e6 * rateCents / 1e6
  var qtyMicro = fieldosRoundHalfUpToInt_(Number(quantity) * 1000000);
  if (qtyMicro == null) return null;
  var product = qtyMicro * Number(unitRateCents);
  // Divide by 1e6 with half-up.
  var div = product / 1000000;
  return fieldosRoundHalfUpToInt_(div);
}

function fieldosSumCents_(values) {
  var total = 0;
  (values || []).forEach(function (v) {
    if (v == null || !Number.isFinite(Number(v))) return;
    total += Math.trunc(Number(v));
  });
  return total;
}

/**
 * Tax amount from exclusive subtotal cents + percent.
 * percent e.g. 10 for GST. Half-up to cents.
 */
function fieldosTaxAmountCents_(subtotalExTaxCents, taxRatePercent) {
  if (subtotalExTaxCents == null || taxRatePercent == null) return null;
  if (!Number.isFinite(Number(subtotalExTaxCents)) || !Number.isFinite(Number(taxRatePercent))) {
    return null;
  }
  // (cents * percent) / 100, half-up
  var raw = (Number(subtotalExTaxCents) * Number(taxRatePercent)) / 100;
  return fieldosRoundHalfUpToInt_(raw);
}

function fieldosDateEffective_(row, onDate) {
  var on = fieldosNormaliseCalendarDate_(onDate);
  if (!on) return false;
  var from = fieldosNormaliseCalendarDate_(row && row.effective_from);
  var to = fieldosNormaliseCalendarDate_(row && row.effective_to);
  if (from && on < from) return false;
  if (to && on > to) return false;
  return true;
}

function fieldosIsActiveStatus_(status) {
  return String(status || "").trim() === FIELDOS_RATE_STATUS_.ACTIVE;
}

/**
 * Detect overlapping active date ranges for rows sharing the same key.
 * Returns list of { a_id, b_id, message }.
 */
function fieldosFindEffectiveOverlaps_(rows, idField, keyFn) {
  var active = (rows || []).filter(function (r) {
    return fieldosIsActiveStatus_(r.status);
  });
  var issues = [];
  for (var i = 0; i < active.length; i++) {
    for (var j = i + 1; j < active.length; j++) {
      var a = active[i];
      var b = active[j];
      if (keyFn(a) !== keyFn(b)) continue;
      var aFrom = fieldosNormaliseCalendarDate_(a.effective_from) || "0000-01-01";
      var aTo = fieldosNormaliseCalendarDate_(a.effective_to) || "9999-12-31";
      var bFrom = fieldosNormaliseCalendarDate_(b.effective_from) || "0000-01-01";
      var bTo = fieldosNormaliseCalendarDate_(b.effective_to) || "9999-12-31";
      if (aFrom <= bTo && bFrom <= aTo) {
        issues.push({
          a_id: String(a[idField] || ""),
          b_id: String(b[idField] || ""),
          message:
            "Overlapping active records " +
            String(a[idField] || "") +
            " and " +
            String(b[idField] || "")
        });
      }
    }
  }
  return issues;
}

function fieldosUnresolvedRate_(blockers) {
  return {
    resolved: false,
    rate: null,
    rate_cents: null,
    unit: "",
    source_type: FIELDOS_RATE_SOURCE_.UNRESOLVED,
    source_id: "",
    effective_date: "",
    blockers: blockers || []
  };
}

function fieldosResolvedRate_(opts) {
  return {
    resolved: true,
    rate: fieldosCentsToMoneyString_(opts.rate_cents),
    rate_cents: opts.rate_cents,
    unit: opts.unit || "hour",
    source_type: opts.source_type,
    source_id: opts.source_id || "",
    effective_date: opts.effective_date || "",
    blockers: []
  };
}

/**
 * Deterministic labour sell-rate resolution.
 * context: { staff_id, role_code, activity_code, customer_id, project_id, on_date, rate_card_id? }
 * labourRates: array of labour rate rows
 * customerPricing: optional rows used to pick preferred rate_card_id
 */
function fieldosResolveLabourSellRate_(context, labourRates, customerPricing) {
  var onDate = fieldosNormaliseCalendarDate_(context && context.on_date);
  if (!onDate) {
    return fieldosUnresolvedRate_(["Job date required for labour rate resolution."]);
  }
  var staffId = String((context && context.staff_id) || "").trim();
  var roleCode = String((context && context.role_code) || "").trim();
  var activityCode = String((context && context.activity_code) || "").trim();
  var customerId = String((context && context.customer_id) || "").trim();
  var projectId = String((context && context.project_id) || "").trim();

  var preferredCard = String((context && context.rate_card_id) || "").trim();
  if (!preferredCard && customerId) {
    var pricing = (customerPricing || []).filter(function (p) {
      return (
        fieldosIsActiveStatus_(p.status) &&
        fieldosDateEffective_(p, onDate) &&
        String(p.customer_id || "") === customerId &&
        (!projectId || !p.project_id || String(p.project_id) === projectId)
      );
    });
    pricing.sort(function (a, b) {
      // Prefer project-specific pricing rows.
      var as = String(a.project_id || "") === projectId ? 0 : 1;
      var bs = String(b.project_id || "") === projectId ? 0 : 1;
      return as - bs;
    });
    if (pricing.length) preferredCard = String(pricing[0].rate_card_id || "").trim();
  }

  var candidates = (labourRates || []).filter(function (r) {
    return fieldosIsActiveStatus_(r.status) && fieldosDateEffective_(r, onDate);
  });
  if (preferredCard) {
    var scoped = candidates.filter(function (r) {
      return String(r.rate_card_id || "") === preferredCard;
    });
    if (scoped.length) candidates = scoped;
  }

  function match(row, pred) {
    return pred(row);
  }

  var tiers = [
    {
      type: FIELDOS_RATE_SOURCE_.PROJECT,
      pred: function (r) {
        return (
          projectId &&
          String(r.project_id || "") === projectId &&
          (!r.staff_id || String(r.staff_id) === staffId) &&
          (!r.customer_id || String(r.customer_id) === customerId)
        );
      }
    },
    {
      type: FIELDOS_RATE_SOURCE_.CUSTOMER,
      pred: function (r) {
        return (
          customerId &&
          String(r.customer_id || "") === customerId &&
          !String(r.project_id || "").trim() &&
          (!r.staff_id || String(r.staff_id) === staffId)
        );
      }
    },
    {
      type: FIELDOS_RATE_SOURCE_.STAFF,
      pred: function (r) {
        return (
          staffId &&
          String(r.staff_id || "") === staffId &&
          !String(r.customer_id || "").trim() &&
          !String(r.project_id || "").trim()
        );
      }
    },
    {
      type: FIELDOS_RATE_SOURCE_.ROLE,
      pred: function (r) {
        return (
          (roleCode || activityCode) &&
          !String(r.staff_id || "").trim() &&
          !String(r.customer_id || "").trim() &&
          !String(r.project_id || "").trim() &&
          ((roleCode && String(r.role_code || "") === roleCode) ||
            (activityCode && String(r.activity_code || "") === activityCode))
        );
      }
    },
    {
      type: FIELDOS_RATE_SOURCE_.DEFAULT_CARD,
      pred: function (r) {
        return (
          !String(r.staff_id || "").trim() &&
          !String(r.customer_id || "").trim() &&
          !String(r.project_id || "").trim() &&
          !String(r.role_code || "").trim() &&
          !String(r.activity_code || "").trim()
        );
      }
    }
  ];

  for (var t = 0; t < tiers.length; t++) {
    var tier = tiers[t];
    var hits = candidates.filter(function (r) {
      return match(r, tier.pred);
    });
    if (!hits.length) continue;
    hits.sort(function (a, b) {
      return String(a.labour_rate_id || "").localeCompare(String(b.labour_rate_id || ""));
    });
    var chosen = hits[0];
    var sellCents = fieldosParseMoneyToCents_(chosen.sell_rate);
    if (sellCents == null) {
      return fieldosUnresolvedRate_([
        "Labour rate " + String(chosen.labour_rate_id || "") + " has invalid sell_rate."
      ]);
    }
    return fieldosResolvedRate_({
      rate_cents: sellCents,
      unit: String(chosen.unit || "hour"),
      source_type: tier.type,
      source_id: String(chosen.labour_rate_id || ""),
      effective_date: onDate
    });
  }

  var who = staffId || "(no staff_id)";
  return fieldosUnresolvedRate_([
    "No active labour sell rate for " + who + " on " + onDate
  ]);
}

function fieldosResolveLabourCostRate_(context, labourRates, customerPricing) {
  var sell = fieldosResolveLabourSellRate_(context, labourRates, customerPricing);
  if (!sell.resolved) return sell;
  var row = (labourRates || []).find(function (r) {
    return String(r.labour_rate_id || "") === String(sell.source_id || "");
  });
  if (!row) return fieldosUnresolvedRate_(["Labour rate row missing for cost lookup."]);
  var costCents = fieldosParseMoneyToCents_(row.cost_rate);
  if (costCents == null) {
    return fieldosUnresolvedRate_([
      "Labour rate " + sell.source_id + " has invalid cost_rate."
    ]);
  }
  return fieldosResolvedRate_({
    rate_cents: costCents,
    unit: String(row.unit || "hour"),
    source_type: sell.source_type,
    source_id: sell.source_id,
    effective_date: sell.effective_date
  });
}

function fieldosResolveLabourTravelRate_(context, labourRates, customerPricing) {
  var sell = fieldosResolveLabourSellRate_(context, labourRates, customerPricing);
  if (!sell.resolved) return sell;
  var row = (labourRates || []).find(function (r) {
    return String(r.labour_rate_id || "") === String(sell.source_id || "");
  });
  if (!row) return fieldosUnresolvedRate_(["Labour rate row missing for travel lookup."]);
  if (fieldosMoneyIsBlank_(row.travel_rate)) {
    return fieldosUnresolvedRate_([
      "Labour rate " + sell.source_id + " has no travel_rate configured."
    ]);
  }
  var travelCents = fieldosParseMoneyToCents_(row.travel_rate);
  if (travelCents == null) {
    return fieldosUnresolvedRate_([
      "Labour rate " + sell.source_id + " has invalid travel_rate."
    ]);
  }
  return fieldosResolvedRate_({
    rate_cents: travelCents,
    unit: String(row.unit || "hour"),
    source_type: sell.source_type,
    source_id: sell.source_id,
    effective_date: sell.effective_date
  });
}

function fieldosResolveMachinerySellRate_(context, machineryRates) {
  var onDate = fieldosNormaliseCalendarDate_(context && context.on_date);
  if (!onDate) return fieldosUnresolvedRate_(["Job date required for machinery rate resolution."]);
  var equipmentId = String((context && context.equipment_id) || "").trim();
  var equipmentName = String((context && context.equipment_name) || "").trim();
  var chargeCode = String((context && context.charge_code) || "").trim();
  if (!equipmentId && !equipmentName) {
    return fieldosUnresolvedRate_(["Unknown equipment — equipment_id or equipment_name required."]);
  }
  var hits = (machineryRates || []).filter(function (r) {
    if (!fieldosIsActiveStatus_(r.status) || !fieldosDateEffective_(r, onDate)) return false;
    if (equipmentId && String(r.equipment_id || "") === equipmentId) return true;
    if (
      !equipmentId &&
      equipmentName &&
      String(r.equipment_name || "").toLowerCase() === equipmentName.toLowerCase()
    ) {
      return true;
    }
    if (chargeCode && String(r.charge_code || "") === chargeCode) return true;
    return false;
  });
  if (!hits.length) {
    return fieldosUnresolvedRate_([
      "No active machinery sell rate for " + (equipmentId || equipmentName) + " on " + onDate
    ]);
  }
  hits.sort(function (a, b) {
    return String(a.machinery_rate_id || "").localeCompare(String(b.machinery_rate_id || ""));
  });
  var chosen = hits[0];
  var sellCents = fieldosParseMoneyToCents_(chosen.sell_rate);
  if (sellCents == null) {
    return fieldosUnresolvedRate_([
      "Machinery rate " + String(chosen.machinery_rate_id || "") + " has invalid sell_rate."
    ]);
  }
  return fieldosResolvedRate_({
    rate_cents: sellCents,
    unit: String(chosen.unit || "hour"),
    source_type: "machinery_rate",
    source_id: String(chosen.machinery_rate_id || ""),
    effective_date: onDate,
    minimum_charge_cents: fieldosParseMoneyToCents_(chosen.minimum_charge)
  });
}

function fieldosResolveMaterialPrice_(context, catalog) {
  var materialId = String((context && context.material_id) || "").trim();
  var itemCode = String((context && context.item_code) || "").trim();
  var itemName = String((context && context.item_name) || "").trim();
  var hits = (catalog || []).filter(function (r) {
    if (String(r.active) === "FALSE" || r.active === false) return false;
    if (materialId && String(r.material_id || "") === materialId) return true;
    if (itemCode && String(r.item_code || "") === itemCode) return true;
    return false;
  });
  if (!hits.length) {
    var suggestions = [];
    if (itemName) {
      suggestions = (catalog || [])
        .filter(function (r) {
          if (String(r.active) === "FALSE" || r.active === false) return false;
          return String(r.item_name || "")
            .toLowerCase()
            .indexOf(itemName.toLowerCase()) >= 0;
        })
        .slice(0, 5)
        .map(function (r) {
          return {
            material_id: r.material_id,
            item_code: r.item_code,
            item_name: r.item_name
          };
        });
    }
    return {
      resolved: false,
      rate: null,
      rate_cents: null,
      unit: "",
      source_type: FIELDOS_RATE_SOURCE_.UNRESOLVED,
      source_id: "",
      effective_date: "",
      blockers: [
        "No confirmed material catalog match for " + (materialId || itemCode || itemName || "(blank)")
      ],
      suggested_matches: suggestions
    };
  }
  hits.sort(function (a, b) {
    return String(a.material_id || "").localeCompare(String(b.material_id || ""));
  });
  var chosen = hits[0];
  var sellCents = fieldosParseMoneyToCents_(chosen.sell_price);
  if (sellCents == null) {
    return fieldosUnresolvedRate_([
      "Material " + String(chosen.material_id || "") + " has invalid sell_price."
    ]);
  }
  return {
    resolved: true,
    rate: fieldosCentsToMoneyString_(sellCents),
    rate_cents: sellCents,
    cost_cents: fieldosParseMoneyToCents_(chosen.cost_price),
    unit: String(chosen.unit || ""),
    source_type: "material_catalog",
    source_id: String(chosen.material_id || ""),
    effective_date: fieldosNormaliseCalendarDate_((context && context.on_date) || "") || "",
    tax_code: String(chosen.tax_code || ""),
    account_code: String(chosen.account_code || ""),
    blockers: [],
    suggested_matches: []
  };
}

function fieldosResolvePayrollMapping_(staffId, mappings, onDate) {
  var sid = String(staffId || "").trim();
  var on = fieldosNormaliseCalendarDate_(onDate);
  if (!sid) return { resolved: false, blockers: ["staff_id required for payroll mapping."] };
  if (!on) return { resolved: false, blockers: ["work_date required for payroll mapping."] };
  var hits = (mappings || []).filter(function (r) {
    return (
      fieldosIsActiveStatus_(r.status) &&
      fieldosDateEffective_(r, on) &&
      String(r.staff_id || "") === sid
    );
  });
  if (!hits.length) {
    return {
      resolved: false,
      blockers: ["No active payroll mapping for " + sid + " on " + on]
    };
  }
  hits.sort(function (a, b) {
    return String(a.payroll_mapping_id || "").localeCompare(String(b.payroll_mapping_id || ""));
  });
  var m = hits[0];
  var blockers = [];
  if (!String(m.employee_reference || "").trim()) blockers.push("employee_reference missing");
  if (!String(m.ordinary_hours_code || "").trim()) blockers.push("ordinary_hours_code missing");
  if (!String(m.cost_centre || "").trim()) blockers.push("cost_centre missing");
  if (blockers.length) {
    return { resolved: false, blockers: blockers, mapping: m };
  }
  return {
    resolved: true,
    blockers: [],
    mapping: m,
    source_id: String(m.payroll_mapping_id || "")
  };
}

function fieldosResolveXeroMapping_(entityType, localReference, mappings) {
  var et = String(entityType || "").trim();
  var local = String(localReference || "").trim();
  var hits = (mappings || []).filter(function (r) {
    return (
      fieldosIsActiveStatus_(r.status) &&
      String(r.entity_type || "") === et &&
      String(r.local_reference || "") === local
    );
  });
  if (!hits.length) {
    return {
      resolved: false,
      blockers: ["No active Xero mapping for " + et + " / " + (local || "(blank)")]
    };
  }
  hits.sort(function (a, b) {
    return String(a.xero_mapping_id || "").localeCompare(String(b.xero_mapping_id || ""));
  });
  var m = hits[0];
  var blockers = [];
  if (!String(m.account_code || "").trim()) blockers.push("account_code missing");
  if (!String(m.tax_type || "").trim()) blockers.push("tax_type missing");
  // tax_rate_percent optional column — required to calculate tax amounts
  if (fieldosMoneyIsBlank_(m.tax_rate_percent) && m.tax_rate_percent !== 0) {
    blockers.push("tax_rate_percent not configured for tax_type " + String(m.tax_type || ""));
  }
  if (blockers.length) {
    return { resolved: false, blockers: blockers, mapping: m };
  }
  return { resolved: true, blockers: [], mapping: m, source_id: String(m.xero_mapping_id || "") };
}

function fieldosFinancialAuditPayload_(meta) {
  return {
    action: meta.action || "",
    actor_staff_id: meta.actor_staff_id || "",
    actor_role: meta.actor_role || "",
    resource_type: meta.resource_type || "",
    resource_id: meta.resource_id || "",
    completion_id: meta.completion_id || "",
    previous_status: meta.previous_status || "",
    new_status: meta.new_status || "",
    version: meta.version != null ? meta.version : null,
    changed_fields: meta.changed_fields || [],
    source_ids: meta.source_ids || [],
    correlation_id: meta.correlation_id || ""
  };
}
