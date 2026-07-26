/**
 * Phase 3E — rates, financial mappings and completion pricing snapshots.
 * Depends on: RatesFinancialHelpers.js, JobCompletionHelpers.js, JobCompletion.js,
 * CompletionExports.js (_loadCompletionBundle), Database.js, Repositories.js,
 * Utilities.js, FieldOSDisplayLookup.js, FieldOSGateway role helpers.
 *
 * Money policy (see RatesFinancialHelpers.js):
 * - All arithmetic in integer cents; stored amounts are decimal strings.
 * - An unresolved rate is never treated as zero. Zero only ever comes from an
 *   explicit non-billable flag, and always carries a reason.
 */

var FIELDOS_RATE_CARD_HEADERS_ = [
  "rate_card_id",
  "card_name",
  "description",
  "currency",
  "status",
  "effective_from",
  "effective_to",
  "notes",
  "created_by",
  "created_at",
  "updated_by",
  "updated_at",
  "version"
];

var FIELDOS_LABOUR_RATE_HEADERS_ = [
  "labour_rate_id",
  "rate_card_id",
  "staff_id",
  "customer_id",
  "project_id",
  "role_code",
  "activity_code",
  "unit",
  "sell_rate",
  "cost_rate",
  "travel_rate",
  "overtime_rate",
  "status",
  "effective_from",
  "effective_to",
  "notes",
  "created_by",
  "created_at",
  "updated_by",
  "updated_at",
  "version"
];

var FIELDOS_MACHINERY_RATE_HEADERS_ = [
  "machinery_rate_id",
  "rate_card_id",
  "equipment_id",
  "equipment_name",
  "charge_code",
  "unit",
  "sell_rate",
  "cost_rate",
  "minimum_charge",
  "status",
  "effective_from",
  "effective_to",
  "notes",
  "created_by",
  "created_at",
  "updated_by",
  "updated_at",
  "version"
];

var FIELDOS_MATERIAL_CATALOG_HEADERS_ = [
  "material_id",
  "item_code",
  "item_name",
  "description",
  "unit",
  "cost_price",
  "sell_price",
  "tax_code",
  "account_code",
  "supplier",
  "active",
  "notes",
  "created_by",
  "created_at",
  "updated_by",
  "updated_at",
  "version"
];

var FIELDOS_CUSTOMER_PRICING_HEADERS_ = [
  "customer_pricing_id",
  "customer_id",
  "project_id",
  "rate_card_id",
  "price_notes",
  "status",
  "effective_from",
  "effective_to",
  "notes",
  "created_by",
  "created_at",
  "updated_by",
  "updated_at",
  "version"
];

var FIELDOS_PAYROLL_MAPPING_HEADERS_ = [
  "payroll_mapping_id",
  "staff_id",
  "employee_reference",
  "ordinary_hours_code",
  "overtime_hours_code",
  "travel_hours_code",
  "allowance_code",
  "cost_centre",
  "pay_calendar",
  // Captured for payroll handoff only — never inferred by FieldOS.
  "employment_classification",
  "award_reference",
  "status",
  "effective_from",
  "effective_to",
  "notes",
  "created_by",
  "created_at",
  "updated_by",
  "updated_at",
  "version"
];

var FIELDOS_XERO_MAPPING_HEADERS_ = [
  "xero_mapping_id",
  "entity_type",
  "local_reference",
  "xero_reference",
  "account_code",
  "tax_type",
  "tax_rate_percent",
  "tracking_category",
  "tracking_option",
  "status",
  "notes",
  "created_by",
  "created_at",
  "updated_by",
  "updated_at",
  "version"
];

var FIELDOS_COMPLETION_FINANCIAL_HEADERS_ = [
  "financial_snapshot_id",
  "completion_id",
  "job_sheet_id",
  "customer_id",
  "project_id",
  "job_date",
  "currency",
  "snapshot_status",
  "pricing_status",
  "rate_card_id",
  "line_count",
  "subtotal_ex_tax",
  "tax_amount",
  "total_inc_tax",
  "tax_type",
  "tax_rate_percent",
  "account_code",
  "draft_reference",
  "xero_reference",
  "blockers",
  "notes",
  "created_by",
  "created_at",
  "validated_by",
  "validated_at",
  "approved_by",
  "approved_at",
  "superseded_by",
  "superseded_at",
  "version"
];

var FIELDOS_COMPLETION_FINANCIAL_LINE_HEADERS_ = [
  "financial_line_id",
  "financial_snapshot_id",
  "completion_id",
  "line_number",
  "line_type",
  "source_row_id",
  "description",
  "staff_id",
  "equipment_id",
  "material_id",
  "quantity",
  "unit",
  "unit_sell",
  "line_amount_ex_tax",
  "tax_type",
  "tax_rate_percent",
  "tax_amount",
  "line_total_inc_tax",
  "account_code",
  "rate_source_type",
  "rate_source_id",
  "billable",
  "non_billable_reason",
  "blockers",
  "created_at"
];

/** Pricing readiness / snapshot pricing state (distinct from snapshot lifecycle status). */
var FIELDOS_PRICING_STATUS_ = {
  UNRESOLVED: "Unresolved",
  READY: "Ready",
  VALIDATED: "Validated",
  APPROVED: "Approved"
};

/** Allowed snapshot lifecycle transitions. Approved is immutable except supersede. */
var FIELDOS_SNAPSHOT_TRANSITIONS_ = {
  Draft: ["Draft", "Validated", "Cancelled"],
  Validated: ["Draft", "Validated", "Approved", "Cancelled"],
  Approved: ["Superseded"],
  Superseded: [],
  Cancelled: []
};

function fieldosSnapshotTransitionAllowed_(currentStatus, targetStatus) {
  var current = String(currentStatus || "").trim();
  var target = String(targetStatus || "").trim();
  var allowed = FIELDOS_SNAPSHOT_TRANSITIONS_[current];
  if (!allowed) return false;
  return allowed.indexOf(target) >= 0;
}

function fieldosAssertSnapshotTransition_(currentStatus, targetStatus) {
  if (fieldosSnapshotTransitionAllowed_(currentStatus, targetStatus)) return true;
  var current = String(currentStatus || "").trim();
  if (current === FIELDOS_SNAPSHOT_STATUS_.APPROVED) {
    throw new Error(
      "Validation Error: Approved financial snapshots are immutable — supersede the snapshot to reprice."
    );
  }
  if (current === FIELDOS_SNAPSHOT_STATUS_.SUPERSEDED || current === FIELDOS_SNAPSHOT_STATUS_.CANCELLED) {
    throw new Error("Validation Error: " + current + " financial snapshots cannot be changed.");
  }
  throw new Error(
    "Validation Error: cannot move financial snapshot from " +
      (current || "(blank)") +
      " to " +
      String(targetStatus || "(blank)") +
      "."
  );
}

function fieldosFinancialIsTrue_(value) {
  return value === true || value === "TRUE" || value === "true" || value === 1 || value === "1";
}

function fieldosFinancialNumber_(value) {
  if (value == null || value === "") return null;
  var n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Confirmed labour hours from stored hours, else recomputed from clock times. */
function fieldosFinancialLabourHours_(entry) {
  var stored = fieldosFinancialNumber_(entry && entry.labour_hours);
  if (stored != null && stored >= 0) return stored;
  if (typeof fieldosComputeLabourEntry_ !== "function") return null;
  var calc = fieldosComputeLabourEntry_(entry || {});
  return calc && calc.labour_hours != null ? calc.labour_hours : null;
}

function fieldosFinancialTravelHours_(entry) {
  var minutes = fieldosFinancialNumber_(entry && entry.travel_minutes);
  if (minutes == null || minutes <= 0) return 0;
  return Math.round((minutes / 60) * 100) / 100;
}

/**
 * Xero tax/account resolution for a snapshot line.
 * Tries specific local references first, then the generic entity-type reference.
 */
function fieldosResolveLineTaxMapping_(lineType, localReferences, xeroMappings) {
  var entityType =
    String(lineType) === FIELDOS_LINE_TYPES_.TRAVEL ? FIELDOS_LINE_TYPES_.LABOUR : String(lineType);
  var refs = [];
  (localReferences || []).forEach(function (ref) {
    var value = String(ref == null ? "" : ref).trim();
    if (value && refs.indexOf(value) < 0) refs.push(value);
  });
  if (refs.indexOf(entityType) < 0) refs.push(entityType);
  var lastBlockers = [];
  for (var i = 0; i < refs.length; i++) {
    var result = fieldosResolveXeroMapping_(entityType, refs[i], xeroMappings);
    if (result.resolved) {
      return {
        resolved: true,
        entity_type: entityType,
        local_reference: refs[i],
        mapping: result.mapping,
        blockers: []
      };
    }
    lastBlockers = result.blockers || [];
  }
  return {
    resolved: false,
    entity_type: entityType,
    local_reference: refs.length ? refs[refs.length - 1] : entityType,
    mapping: null,
    blockers: lastBlockers.length
      ? lastBlockers
      : ["No active Xero mapping for " + entityType + "."]
  };
}

/**
 * Pure snapshot line builder — no Sheets access, safe for Node tests.
 *
 * input: {
 *   completion_id, job_date, identity: { customer_id, project_id, rate_card_id },
 *   labour_entries, machinery_entries, material_entries,
 *   tables: { labour_rates, machinery_rates, material_catalog, customer_pricing, xero_mappings }
 * }
 *
 * Rules:
 * - job_date (normalised job sheet date) selects effective rates, never finalised_at.
 * - Only Confirmed rows are priced.
 * - Non-billable rows price at 0 with an explicit reason.
 * - Unresolved rates leave unit_sell blank and record line blockers — never zero.
 * - Overtime is never inferred; it is priced only when overtime hours are explicit.
 */
function fieldosBuildFinancialLines_(input) {
  var opts = input || {};
  var jobDate = fieldosNormaliseCalendarDate_(opts.job_date) || "";
  var identity = opts.identity || {};
  var tables = opts.tables || {};
  var labourRates = tables.labour_rates || [];
  var machineryRates = tables.machinery_rates || [];
  var catalog = tables.material_catalog || [];
  var customerPricing = tables.customer_pricing || [];
  var xeroMappings = tables.xero_mappings || [];

  var lines = [];
  var blockers = [];
  var suggestions = [];
  var lineNumber = 0;

  if (!jobDate) {
    blockers.push("Job date unresolved — rates cannot be selected for this completion.");
  }

  function addBlockers(list) {
    (list || []).forEach(function (message) {
      var text = String(message || "").trim();
      if (text && blockers.indexOf(text) < 0) blockers.push(text);
    });
  }

  function buildLine(spec) {
    lineNumber += 1;
    var lineBlockers = (spec.blockers || []).slice();
    var billable = spec.billable !== false;
    var quantity = spec.quantity;
    var unitSellCents = spec.unit_sell_cents;
    var amountCents = null;
    if (unitSellCents != null && quantity != null) {
      amountCents = fieldosLineAmountCents_(quantity, unitSellCents);
      if (amountCents == null) {
        lineBlockers.push("Line amount could not be calculated for line " + lineNumber + ".");
      }
    }

    var tax = spec.tax || { resolved: false, mapping: null, blockers: [] };
    var taxType = "";
    var accountCode = "";
    var taxRatePercent = null;
    if (tax.resolved && tax.mapping) {
      taxType = String(tax.mapping.tax_type || "");
      accountCode = String(tax.mapping.account_code || "");
      taxRatePercent = fieldosFinancialNumber_(tax.mapping.tax_rate_percent);
    } else if (billable) {
      lineBlockers = lineBlockers.concat(tax.blockers || []);
    }

    var taxAmountCents = null;
    if (amountCents != null && taxRatePercent != null) {
      taxAmountCents = fieldosTaxAmountCents_(amountCents, taxRatePercent);
    } else if (amountCents === 0) {
      taxAmountCents = 0;
    }

    var totalCents =
      amountCents != null && taxAmountCents != null ? amountCents + taxAmountCents : null;

    var line = {
      line_number: lineNumber,
      line_type: spec.line_type,
      source_row_id: String(spec.source_row_id || ""),
      description: String(spec.description || ""),
      staff_id: String(spec.staff_id || ""),
      equipment_id: String(spec.equipment_id || ""),
      material_id: String(spec.material_id || ""),
      quantity: quantity != null ? Math.round(quantity * 10000) / 10000 : null,
      unit: String(spec.unit || ""),
      unit_sell_cents: unitSellCents,
      unit_sell: unitSellCents == null ? "" : fieldosCentsToMoneyString_(unitSellCents),
      line_amount_cents: amountCents,
      line_amount_ex_tax: amountCents == null ? "" : fieldosCentsToMoneyString_(amountCents),
      tax_type: taxType,
      tax_rate_percent: taxRatePercent,
      tax_amount_cents: taxAmountCents,
      tax_amount: taxAmountCents == null ? "" : fieldosCentsToMoneyString_(taxAmountCents),
      line_total_cents: totalCents,
      line_total_inc_tax: totalCents == null ? "" : fieldosCentsToMoneyString_(totalCents),
      account_code: accountCode,
      rate_source_type: String(spec.rate_source_type || FIELDOS_RATE_SOURCE_.UNRESOLVED),
      rate_source_id: String(spec.rate_source_id || ""),
      billable: billable,
      non_billable_reason: String(spec.non_billable_reason || ""),
      blockers: fieldosUniqueMessages_(lineBlockers)
    };
    lines.push(line);
    addBlockers(line.blockers);
    return line;
  }

  (opts.labour_entries || []).forEach(function (entry) {
    if (!fieldosIsConfirmedRow_(entry)) return;
    var sourceId = String(entry.labour_id || "");
    var staffId = String(entry.staff_id || "");
    var staffLabel = String(entry.staff_name || "") || staffId || "(unnamed staff)";
    var role = String(entry.role_or_activity || "");
    var billable = fieldosFinancialIsTrue_(entry.billable);
    var hours = fieldosFinancialLabourHours_(entry);
    var entryBlockers = [];
    if (hours == null) {
      entryBlockers.push("Labour " + (sourceId || staffLabel) + " has no computable hours.");
    }
    if (!staffId) {
      entryBlockers.push("Labour " + (sourceId || staffLabel) + " is missing staff_id.");
    }

    var rateContext = {
      staff_id: staffId,
      role_code: role,
      activity_code: role,
      customer_id: identity.customer_id,
      project_id: identity.project_id,
      rate_card_id: identity.rate_card_id,
      on_date: jobDate
    };

    var sellCents = null;
    var sourceType = FIELDOS_RATE_SOURCE_.UNRESOLVED;
    var rateSourceId = "";
    var unit = "hour";
    var nonBillableReason = "";
    var rate = null;
    if (billable) {
      rate = fieldosResolveLabourSellRate_(rateContext, labourRates, customerPricing);
      if (rate.resolved) {
        sellCents = rate.rate_cents;
        sourceType = rate.source_type;
        rateSourceId = rate.source_id;
        unit = rate.unit || "hour";
      } else {
        entryBlockers = entryBlockers.concat(rate.blockers || []);
      }
    } else {
      sellCents = 0;
      sourceType = "non_billable";
      nonBillableReason = "Marked non-billable on the completion — zero sell value recorded.";
    }

    buildLine({
      line_type: FIELDOS_LINE_TYPES_.LABOUR,
      source_row_id: sourceId,
      description: "Labour — " + staffLabel + (role ? " (" + role + ")" : ""),
      staff_id: staffId,
      quantity: hours,
      unit: unit,
      unit_sell_cents: sellCents,
      billable: billable,
      non_billable_reason: nonBillableReason,
      rate_source_type: sourceType,
      rate_source_id: rateSourceId,
      tax: fieldosResolveLineTaxMapping_(FIELDOS_LINE_TYPES_.LABOUR, [role, staffId], xeroMappings),
      blockers: entryBlockers
    });

    // Overtime is never inferred from shift length. Priced only when explicitly supplied.
    var overtimeHours = fieldosFinancialNumber_(entry.overtime_hours);
    if (billable && overtimeHours != null && overtimeHours > 0) {
      var overtimeBlockers = [];
      var overtimeCents = null;
      var overtimeRow = rate && rate.resolved
        ? (labourRates || []).filter(function (row) {
            return String(row.labour_rate_id || "") === String(rate.source_id || "");
          })[0]
        : null;
      if (!overtimeRow) {
        overtimeBlockers.push(
          "Overtime hours recorded for " + staffLabel + " but no labour rate row resolved."
        );
      } else {
        overtimeCents = fieldosParseMoneyToCents_(overtimeRow.overtime_rate);
        if (overtimeCents == null) {
          overtimeBlockers.push(
            "Labour rate " +
              String(overtimeRow.labour_rate_id || "") +
              " has no overtime_rate configured but overtime hours were recorded."
          );
        }
      }
      buildLine({
        line_type: FIELDOS_LINE_TYPES_.LABOUR,
        source_row_id: sourceId,
        description: "Overtime — " + staffLabel,
        staff_id: staffId,
        quantity: overtimeHours,
        unit: "hour",
        unit_sell_cents: overtimeCents,
        billable: true,
        rate_source_type: overtimeCents == null ? FIELDOS_RATE_SOURCE_.UNRESOLVED : sourceType,
        rate_source_id: overtimeRow ? String(overtimeRow.labour_rate_id || "") : "",
        tax: fieldosResolveLineTaxMapping_(FIELDOS_LINE_TYPES_.LABOUR, [role, staffId], xeroMappings),
        blockers: overtimeBlockers
      });
    }

    var travelHours = fieldosFinancialTravelHours_(entry);
    if (travelHours > 0) {
      var travelBlockers = [];
      var travelCents = null;
      var travelSourceType = FIELDOS_RATE_SOURCE_.UNRESOLVED;
      var travelSourceId = "";
      var travelReason = "";
      if (billable) {
        var travelRate = fieldosResolveLabourTravelRate_(rateContext, labourRates, customerPricing);
        if (travelRate.resolved) {
          travelCents = travelRate.rate_cents;
          travelSourceType = travelRate.source_type;
          travelSourceId = travelRate.source_id;
        } else {
          travelBlockers = travelBlockers.concat(travelRate.blockers || []);
        }
      } else {
        travelCents = 0;
        travelSourceType = "non_billable";
        travelReason = "Travel attached to non-billable labour — zero sell value recorded.";
      }
      buildLine({
        line_type: FIELDOS_LINE_TYPES_.TRAVEL,
        source_row_id: sourceId,
        description: "Travel — " + staffLabel,
        staff_id: staffId,
        quantity: travelHours,
        unit: "hour",
        unit_sell_cents: travelCents,
        billable: billable,
        non_billable_reason: travelReason,
        rate_source_type: travelSourceType,
        rate_source_id: travelSourceId,
        tax: fieldosResolveLineTaxMapping_(FIELDOS_LINE_TYPES_.TRAVEL, [role, staffId], xeroMappings),
        blockers: travelBlockers
      });
    }
  });

  (opts.machinery_entries || []).forEach(function (entry) {
    if (!fieldosIsConfirmedRow_(entry)) return;
    var sourceId = String(entry.machinery_entry_id || "");
    var equipmentName = String(entry.equipment_name || "");
    var equipmentId = String(entry.equipment_id || "");
    var chargeCode = String(entry.charge_code || "");
    var billable = fieldosFinancialIsTrue_(entry.billable);
    var hours = fieldosFinancialNumber_(entry.duration_hours);
    var entryBlockers = [];
    if (hours == null) {
      entryBlockers.push(
        "Machinery " + (sourceId || equipmentName || "(unknown)") + " has no duration_hours."
      );
    }

    var sellCents = null;
    var sourceType = FIELDOS_RATE_SOURCE_.UNRESOLVED;
    var rateSourceId = "";
    var unit = "hour";
    var nonBillableReason = "";
    if (billable) {
      var rate = fieldosResolveMachinerySellRate_(
        {
          equipment_id: equipmentId,
          equipment_name: equipmentName,
          charge_code: chargeCode,
          on_date: jobDate
        },
        machineryRates
      );
      if (rate.resolved) {
        sellCents = rate.rate_cents;
        sourceType = rate.source_type;
        rateSourceId = rate.source_id;
        unit = rate.unit || "hour";
      } else {
        entryBlockers = entryBlockers.concat(rate.blockers || []);
      }
    } else {
      sellCents = 0;
      sourceType = "non_billable";
      nonBillableReason = "Marked non-billable on the completion — zero sell value recorded.";
    }

    buildLine({
      line_type: FIELDOS_LINE_TYPES_.MACHINERY,
      source_row_id: sourceId,
      description: "Machinery — " + (equipmentName || equipmentId || "(unknown equipment)"),
      equipment_id: equipmentId,
      quantity: hours,
      unit: unit,
      unit_sell_cents: sellCents,
      billable: billable,
      non_billable_reason: nonBillableReason,
      rate_source_type: sourceType,
      rate_source_id: rateSourceId,
      tax: fieldosResolveLineTaxMapping_(
        FIELDOS_LINE_TYPES_.MACHINERY,
        [chargeCode, equipmentId],
        xeroMappings
      ),
      blockers: entryBlockers
    });
  });

  (opts.material_entries || []).forEach(function (entry) {
    if (!fieldosIsConfirmedRow_(entry)) return;
    var sourceId = String(entry.material_entry_id || "");
    var itemName = String(entry.item_name || "");
    var billable = fieldosFinancialIsTrue_(entry.billable);
    var quantity = fieldosFinancialNumber_(entry.quantity);
    var entryBlockers = [];
    if (quantity == null) {
      entryBlockers.push("Material " + (sourceId || itemName || "(unknown)") + " has no quantity.");
    }

    var price = fieldosResolveMaterialPrice_(
      {
        material_id: entry.catalog_material_id || entry.material_id,
        item_code: entry.item_code,
        item_name: itemName,
        on_date: jobDate
      },
      catalog
    );
    if (!price.resolved && (price.suggested_matches || []).length) {
      suggestions.push({
        source_row_id: sourceId,
        item_name: itemName,
        suggested_matches: price.suggested_matches
      });
    }

    var sellCents = null;
    var sourceType = FIELDOS_RATE_SOURCE_.UNRESOLVED;
    var rateSourceId = "";
    var unit = String(entry.unit || "");
    var nonBillableReason = "";
    if (!price.resolved) {
      entryBlockers = entryBlockers.concat(price.blockers || []);
    } else {
      rateSourceId = price.source_id;
      sourceType = price.source_type;
      unit = price.unit || unit;
    }
    if (!billable) {
      sellCents = 0;
      sourceType = "non_billable";
      nonBillableReason = "Marked non-billable on the completion — zero sell value recorded.";
    } else if (price.resolved) {
      sellCents = price.rate_cents;
    }

    buildLine({
      line_type: FIELDOS_LINE_TYPES_.MATERIAL,
      source_row_id: sourceId,
      description: itemName || "(unnamed material)",
      material_id: price.resolved ? price.source_id : "",
      quantity: quantity,
      unit: unit,
      unit_sell_cents: sellCents,
      billable: billable,
      non_billable_reason: nonBillableReason,
      rate_source_type: sourceType,
      rate_source_id: rateSourceId,
      tax: fieldosResolveLineTaxMapping_(
        FIELDOS_LINE_TYPES_.MATERIAL,
        [price.resolved ? price.source_id : "", entry.item_code, price.tax_code],
        xeroMappings
      ),
      blockers: entryBlockers
    });
  });

  var subtotalCents = fieldosSumCents_(
    lines.map(function (line) {
      return line.line_amount_cents;
    })
  );
  var taxCents = fieldosSumCents_(
    lines.map(function (line) {
      return line.tax_amount_cents;
    })
  );

  var taxTypes = [];
  var accountCodes = [];
  var taxRates = [];
  lines.forEach(function (line) {
    if (line.tax_type && taxTypes.indexOf(line.tax_type) < 0) taxTypes.push(line.tax_type);
    if (line.account_code && accountCodes.indexOf(line.account_code) < 0) {
      accountCodes.push(line.account_code);
    }
    if (line.tax_rate_percent != null && taxRates.indexOf(line.tax_rate_percent) < 0) {
      taxRates.push(line.tax_rate_percent);
    }
  });

  var unresolvedLines = lines.filter(function (line) {
    return line.blockers.length > 0;
  });

  return {
    job_date: jobDate,
    lines: lines,
    blockers: fieldosUniqueMessages_(blockers),
    suggestions: suggestions,
    unresolved_line_count: unresolvedLines.length,
    subtotal_ex_tax_cents: subtotalCents,
    tax_amount_cents: taxCents,
    total_inc_tax_cents: subtotalCents + taxCents,
    subtotal_ex_tax: fieldosCentsToMoneyString_(subtotalCents),
    tax_amount: fieldosCentsToMoneyString_(taxCents),
    total_inc_tax: fieldosCentsToMoneyString_(subtotalCents + taxCents),
    tax_type: taxTypes.length === 1 ? taxTypes[0] : taxTypes.length > 1 ? "Mixed" : "",
    tax_rate_percent: taxRates.length === 1 ? taxRates[0] : null,
    account_code: accountCodes.length === 1 ? accountCodes[0] : accountCodes.length > 1 ? "Mixed" : ""
  };
}

var FieldOSRatesFinancial = {
  _assertManager: function (actorRole) {
    if (!fieldosIsManagerOrAdmin_(actorRole)) {
      throw new Error("Forbidden: manager or admin role required.");
    }
  },

  _nowIso: function () {
    try {
      return Utilities.formatDate(
        new Date(),
        Session.getScriptTimeZone(),
        "yyyy-MM-dd'T'HH:mm:ssXXX"
      );
    } catch (e) {
      return new Date().toISOString();
    }
  },

  _resources: {
    rate_cards: {
      table: "tbl_rate_cards",
      idField: "rate_card_id",
      prefix: "RC",
      label: "rate card",
      headers: FIELDOS_RATE_CARD_HEADERS_,
      required: ["card_name"],
      money: [],
      dated: true,
      overlapKey: function (row) {
        return String(row.card_name || "").trim().toLowerCase();
      }
    },
    labour_rates: {
      table: "tbl_labour_rates",
      idField: "labour_rate_id",
      prefix: "LR",
      label: "labour rate",
      headers: FIELDOS_LABOUR_RATE_HEADERS_,
      required: ["sell_rate"],
      money: ["sell_rate", "cost_rate", "travel_rate", "overtime_rate"],
      dated: true,
      overlapKey: function (row) {
        return [
          String(row.rate_card_id || ""),
          String(row.staff_id || ""),
          String(row.customer_id || ""),
          String(row.project_id || ""),
          String(row.role_code || ""),
          String(row.activity_code || "")
        ].join("|");
      }
    },
    machinery_rates: {
      table: "tbl_machinery_rates",
      idField: "machinery_rate_id",
      prefix: "MR",
      label: "machinery rate",
      headers: FIELDOS_MACHINERY_RATE_HEADERS_,
      required: ["sell_rate"],
      money: ["sell_rate", "cost_rate", "minimum_charge"],
      dated: true,
      overlapKey: function (row) {
        return [
          String(row.rate_card_id || ""),
          String(row.equipment_id || ""),
          String(row.equipment_name || "").trim().toLowerCase(),
          String(row.charge_code || "")
        ].join("|");
      }
    },
    material_catalog: {
      table: "tbl_material_catalog",
      idField: "material_id",
      prefix: "MATC",
      label: "material catalog item",
      headers: FIELDOS_MATERIAL_CATALOG_HEADERS_,
      required: ["item_name", "sell_price"],
      money: ["cost_price", "sell_price"],
      dated: false,
      activeField: "active",
      overlapKey: function (row) {
        return String(row.item_code || "").trim().toLowerCase();
      }
    },
    customer_pricing: {
      table: "tbl_customer_pricing",
      idField: "customer_pricing_id",
      prefix: "CP",
      label: "customer pricing rule",
      headers: FIELDOS_CUSTOMER_PRICING_HEADERS_,
      required: ["customer_id", "rate_card_id"],
      money: [],
      dated: true,
      overlapKey: function (row) {
        return String(row.customer_id || "") + "|" + String(row.project_id || "");
      }
    },
    payroll_mappings: {
      table: "tbl_payroll_mappings",
      idField: "payroll_mapping_id",
      prefix: "PM",
      label: "payroll mapping",
      headers: FIELDOS_PAYROLL_MAPPING_HEADERS_,
      required: ["staff_id", "employee_reference", "ordinary_hours_code", "cost_centre"],
      money: [],
      dated: true,
      overlapKey: function (row) {
        return String(row.staff_id || "");
      }
    },
    xero_mappings: {
      table: "tbl_xero_mappings",
      idField: "xero_mapping_id",
      prefix: "XM",
      label: "Xero mapping",
      headers: FIELDOS_XERO_MAPPING_HEADERS_,
      required: ["entity_type", "local_reference", "account_code", "tax_type"],
      money: [],
      dated: false,
      overlapKey: function (row) {
        return String(row.entity_type || "") + "|" + String(row.local_reference || "");
      }
    }
  },

  _resource: function (name) {
    var spec = this._resources[name];
    if (!spec) throw new Error("Validation Error: unknown rates resource '" + name + "'.");
    return spec;
  },

  _tableExists: function (tableName) {
    try {
      DB.getSheet(tableName);
      return true;
    } catch (e) {
      return false;
    }
  },

  _assertTable: function (spec) {
    if (!this._tableExists(spec.table)) {
      throw new Error(
        "Validation Error: " + spec.table + " missing — run migrateSchemaForRatesFinancial()."
      );
    }
  },

  _readTable: function (tableName) {
    if (!this._tableExists(tableName)) return [];
    try {
      return DB.findAll(tableName) || [];
    } catch (e) {
      return [];
    }
  },

  _parseJson: function (raw, fallback) {
    if (raw == null || raw === "") return fallback;
    if (typeof raw === "object") return raw;
    try {
      return JSON.parse(String(raw));
    } catch (e) {
      return fallback;
    }
  },

  _writeAudit: function (meta) {
    try {
      SyncRepository.create({
        record_id: meta.resource_id || meta.completion_id || "FIELDOS_RATES",
        target_system: "FieldOS_Rates",
        status: "Success",
        request_payload: JSON.stringify(fieldosFinancialAuditPayload_(meta)),
        response_payload: String(meta.new_status || ""),
        timestamp: new Date()
      });
    } catch (err) {
      if (typeof Logger !== "undefined" && Logger.log) {
        Logger.log("Rates audit write failed: " + err);
      }
    }
  },

  _checkVersion: function (row, expectedVersion, label) {
    if (expectedVersion == null || expectedVersion === "") return;
    if (Number(row.version || 0) !== Number(expectedVersion)) {
      throw new Error("Conflict: " + label + " changed since you loaded this record.");
    }
  },

  _recordFromPayload: function (spec, source, base) {
    var record = base || {};
    var input = source || {};
    spec.headers.forEach(function (header) {
      if (header === spec.idField) return;
      if (Object.prototype.hasOwnProperty.call(input, header)) {
        var value = input[header];
        record[header] = value == null ? "" : value;
      }
    });
    return record;
  },

  _validateRecord: function (spec, record) {
    (spec.required || []).forEach(function (field) {
      var value = record[field];
      if (value == null || String(value).trim() === "") {
        throw new Error("Validation Error: " + field + " is required for a " + spec.label + ".");
      }
    });
    (spec.money || []).forEach(function (field) {
      var value = record[field];
      if (value == null || value === "") return;
      if (fieldosParseMoneyToCents_(value) == null) {
        throw new Error(
          "Validation Error: " + field + " must be a decimal amount (received '" + String(value) + "')."
        );
      }
    });
    if (spec.dated) {
      ["effective_from", "effective_to"].forEach(function (field) {
        var value = record[field];
        if (value == null || value === "") return;
        if (!fieldosNormaliseCalendarDate_(value)) {
          throw new Error("Validation Error: " + field + " must be a valid calendar date.");
        }
      });
      var from = fieldosNormaliseCalendarDate_(record.effective_from);
      var to = fieldosNormaliseCalendarDate_(record.effective_to);
      if (from && to && to < from) {
        throw new Error("Validation Error: effective_to cannot be before effective_from.");
      }
    }
    if (spec.headers.indexOf("status") >= 0) {
      var status = String(record.status || "").trim();
      if (status && status !== FIELDOS_RATE_STATUS_.ACTIVE && status !== FIELDOS_RATE_STATUS_.INACTIVE) {
        throw new Error("Validation Error: status must be Active or Inactive.");
      }
    }
  },

  _assertNoOverlap: function (spec, candidate, existingRows, excludeId) {
    var isActive = spec.activeField
      ? !(String(candidate[spec.activeField]) === "FALSE" || candidate[spec.activeField] === false)
      : fieldosIsActiveStatus_(candidate.status);
    if (!isActive) return;
    var others = (existingRows || []).filter(function (row) {
      if (excludeId && String(row[spec.idField] || "") === String(excludeId)) return false;
      if (spec.activeField) {
        return !(String(row[spec.activeField]) === "FALSE" || row[spec.activeField] === false);
      }
      return fieldosIsActiveStatus_(row.status);
    });

    if (!spec.dated) {
      var key = spec.overlapKey(candidate);
      if (!key || key.replace(/\|/g, "") === "") return;
      var clash = others.filter(function (row) {
        return spec.overlapKey(row) === key;
      });
      if (clash.length) {
        throw new Error(
          "Validation Error: an active " +
            spec.label +
            " already exists for this key (" +
            String(clash[0][spec.idField] || "") +
            ")."
        );
      }
      return;
    }

    var normalisedCandidate = {};
    spec.headers.forEach(function (header) {
      normalisedCandidate[header] = candidate[header];
    });
    normalisedCandidate[spec.idField] = candidate[spec.idField] || "(new)";
    var issues = fieldosFindEffectiveOverlaps_(
      others.concat([normalisedCandidate]),
      spec.idField,
      spec.overlapKey
    );
    var relevant = issues.filter(function (issue) {
      return (
        issue.a_id === String(normalisedCandidate[spec.idField]) ||
        issue.b_id === String(normalisedCandidate[spec.idField])
      );
    });
    if (relevant.length) {
      throw new Error(
        "Validation Error: effective date range overlaps an existing active " +
          spec.label +
          " — " +
          relevant[0].message +
          "."
      );
    }
  },

  _toApi: function (spec, row) {
    var out = {};
    spec.headers.forEach(function (header) {
      var value = row[header];
      out[header] = value == null ? "" : value;
    });
    out.version = Number(row.version) || 1;
    return out;
  },

  _crudList: function (name, action, payload) {
    this._assertManager(payload.actor_role);
    var spec = this._resource(name);
    var self = this;
    var rows = this._readTable(spec.table);
    var onDate = fieldosNormaliseCalendarDate_(payload.on_date);
    var includeInactive =
      payload.include_inactive === true ||
      payload.include_inactive === "true" ||
      payload.include_inactive === "TRUE";
    var filtered = rows.filter(function (row) {
      if (!includeInactive) {
        if (spec.activeField) {
          if (String(row[spec.activeField]) === "FALSE" || row[spec.activeField] === false) {
            return false;
          }
        } else if (row.status !== "" && row.status != null && !fieldosIsActiveStatus_(row.status)) {
          return false;
        }
      }
      if (onDate && spec.dated && !fieldosDateEffective_(row, onDate)) return false;
      if (payload.rate_card_id && String(row.rate_card_id || "") !== String(payload.rate_card_id)) {
        return false;
      }
      if (payload.staff_id_filter && String(row.staff_id || "") !== String(payload.staff_id_filter)) {
        return false;
      }
      if (payload.customer_id && String(row.customer_id || "") !== String(payload.customer_id)) {
        return false;
      }
      if (payload.entity_type && String(row.entity_type || "") !== String(payload.entity_type)) {
        return false;
      }
      return true;
    });
    filtered.sort(function (a, b) {
      return String(a[spec.idField] || "").localeCompare(String(b[spec.idField] || ""));
    });
    return {
      action: action,
      message: "OK",
      data: {
        items: filtered.map(function (row) {
          return self._toApi(spec, row);
        }),
        overlaps: spec.dated
          ? fieldosFindEffectiveOverlaps_(rows, spec.idField, spec.overlapKey)
          : []
      }
    };
  },

  _crudCreate: function (name, action, payload) {
    this._assertManager(payload.actor_role);
    var spec = this._resource(name);
    this._assertTable(spec);
    var self = this;
    var actor = String(payload.actor_identity || payload.staff_id || "");
    var now = this._nowIso();
    var source = payload.record || payload;
    return Utils.withLock("RATES_" + spec.table, 30000, function () {
      var record = self._recordFromPayload(spec, source, {});
      record[spec.idField] = DB.generateId(spec.prefix);
      if (spec.headers.indexOf("status") >= 0 && !String(record.status || "").trim()) {
        record.status = FIELDOS_RATE_STATUS_.ACTIVE;
      }
      if (spec.activeField && (record[spec.activeField] == null || record[spec.activeField] === "")) {
        record[spec.activeField] = "TRUE";
      }
      if (spec.headers.indexOf("currency") >= 0 && !String(record.currency || "").trim()) {
        record.currency = FIELDOS_CURRENCY_DEFAULT_;
      }
      record.created_by = actor;
      record.created_at = now;
      record.updated_by = actor;
      record.updated_at = now;
      record.version = 1;
      self._validateRecord(spec, record);
      self._assertNoOverlap(spec, record, DB.findAll(spec.table) || [], null);
      DB.insertRecord(spec.table, record, { alreadyLocked: true });
      self._writeAudit({
        action: action,
        actor_staff_id: payload.staff_id,
        actor_role: fieldosNormalizeRole_(payload.actor_role),
        resource_type: spec.table,
        resource_id: record[spec.idField],
        new_status: String(record.status || record[spec.activeField] || ""),
        version: record.version,
        changed_fields: Object.keys(record)
      });
      return {
        action: action,
        message: spec.label.charAt(0).toUpperCase() + spec.label.slice(1) + " created.",
        data: { item: self._toApi(spec, record) }
      };
    });
  },

  _crudUpdate: function (name, action, payload) {
    this._assertManager(payload.actor_role);
    var spec = this._resource(name);
    this._assertTable(spec);
    var self = this;
    var source = payload.record || payload;
    var recordId = String(payload[spec.idField] || (source && source[spec.idField]) || "");
    if (!recordId) {
      throw new Error("Missing required attribute: " + spec.idField + ".");
    }
    var actor = String(payload.actor_identity || payload.staff_id || "");
    var now = this._nowIso();
    return Utils.withLock("RATES_" + spec.table, 30000, function () {
      var rows = DB.findWhere(spec.table, self._idCondition(spec, recordId)) || [];
      if (!rows.length) {
        throw new Error("Not Found: " + spec.label + " " + recordId + " does not exist.");
      }
      var existing = rows[0];
      self._checkVersion(existing, payload.expected_version, spec.label);
      var merged = self._recordFromPayload(spec, source, self._toApi(spec, existing));
      merged[spec.idField] = recordId;
      merged.updated_by = actor;
      merged.updated_at = now;
      merged.version = Number(existing.version || 1) + 1;
      self._validateRecord(spec, merged);
      self._assertNoOverlap(spec, merged, DB.findAll(spec.table) || [], recordId);
      var patch = {};
      spec.headers.forEach(function (header) {
        if (header === spec.idField) return;
        if (header === "created_by" || header === "created_at") return;
        patch[header] = merged[header];
      });
      DB.updateRecord(spec.table, spec.idField, recordId, patch);
      self._writeAudit({
        action: action,
        actor_staff_id: payload.staff_id,
        actor_role: fieldosNormalizeRole_(payload.actor_role),
        resource_type: spec.table,
        resource_id: recordId,
        previous_status: String(existing.status || ""),
        new_status: String(merged.status || merged[spec.activeField] || ""),
        version: merged.version,
        changed_fields: Object.keys(patch)
      });
      return {
        action: action,
        message: spec.label.charAt(0).toUpperCase() + spec.label.slice(1) + " updated.",
        data: { item: self._toApi(spec, merged) }
      };
    });
  },

  _idCondition: function (spec, id) {
    var cond = {};
    cond[spec.idField] = id;
    return cond;
  },

  listRateCards: function (payload) {
    return this._crudList("rate_cards", "list_rate_cards", payload);
  },
  createRateCard: function (payload) {
    return this._crudCreate("rate_cards", "create_rate_card", payload);
  },
  updateRateCard: function (payload) {
    return this._crudUpdate("rate_cards", "update_rate_card", payload);
  },

  listLabourRates: function (payload) {
    return this._crudList("labour_rates", "list_labour_rates", payload);
  },
  createLabourRate: function (payload) {
    return this._crudCreate("labour_rates", "create_labour_rate", payload);
  },
  updateLabourRate: function (payload) {
    return this._crudUpdate("labour_rates", "update_labour_rate", payload);
  },

  listMachineryRates: function (payload) {
    return this._crudList("machinery_rates", "list_machinery_rates", payload);
  },
  createMachineryRate: function (payload) {
    return this._crudCreate("machinery_rates", "create_machinery_rate", payload);
  },
  updateMachineryRate: function (payload) {
    return this._crudUpdate("machinery_rates", "update_machinery_rate", payload);
  },

  listMaterialCatalog: function (payload) {
    return this._crudList("material_catalog", "list_material_catalog", payload);
  },
  createMaterialCatalogItem: function (payload) {
    return this._crudCreate("material_catalog", "create_material_catalog_item", payload);
  },
  updateMaterialCatalogItem: function (payload) {
    return this._crudUpdate("material_catalog", "update_material_catalog_item", payload);
  },

  listCustomerPricing: function (payload) {
    return this._crudList("customer_pricing", "list_customer_pricing", payload);
  },
  createCustomerPricing: function (payload) {
    return this._crudCreate("customer_pricing", "create_customer_pricing", payload);
  },
  updateCustomerPricing: function (payload) {
    return this._crudUpdate("customer_pricing", "update_customer_pricing", payload);
  },

  listPayrollMappings: function (payload) {
    return this._crudList("payroll_mappings", "list_payroll_mappings", payload);
  },
  createPayrollMapping: function (payload) {
    return this._crudCreate("payroll_mappings", "create_payroll_mapping", payload);
  },
  updatePayrollMapping: function (payload) {
    return this._crudUpdate("payroll_mappings", "update_payroll_mapping", payload);
  },

  listXeroMappings: function (payload) {
    return this._crudList("xero_mappings", "list_xero_mappings", payload);
  },
  createXeroMapping: function (payload) {
    return this._crudCreate("xero_mappings", "create_xero_mapping", payload);
  },
  updateXeroMapping: function (payload) {
    return this._crudUpdate("xero_mappings", "update_xero_mapping", payload);
  },

  _loadRateTables: function () {
    return {
      rate_cards: this._readTable("tbl_rate_cards"),
      labour_rates: this._readTable("tbl_labour_rates"),
      machinery_rates: this._readTable("tbl_machinery_rates"),
      material_catalog: this._readTable("tbl_material_catalog"),
      customer_pricing: this._readTable("tbl_customer_pricing"),
      payroll_mappings: this._readTable("tbl_payroll_mappings"),
      xero_mappings: this._readTable("tbl_xero_mappings")
    };
  },

  _completionRow: function (completionId) {
    var id = String(completionId || "");
    if (!id) throw new Error("Missing required attribute: completion_id.");
    var rows = DB.findWhere("tbl_job_completions", { completion_id: id }) || [];
    if (!rows.length) throw new Error("Not Found: completion " + id + " does not exist.");
    return rows[0];
  },

  _bundle: function (completionRow) {
    return FieldOSCompletionExports._loadCompletionBundle(completionRow);
  },

  /**
   * Customer / project identity for pricing. IDs only come from real lookups —
   * display names are never used as identifiers.
   */
  _resolveIdentity: function (jobSheetId, tables) {
    var identity = {
      job_sheet_id: String(jobSheetId || ""),
      customer_id: "",
      project_id: "",
      customer_name: "",
      project_name: "",
      job_date: "",
      rate_card_id: "",
      match: "none"
    };
    var job = null;
    try {
      job = JobSheetRepository.findById(String(jobSheetId || "")) || null;
    } catch (e) {
      job = null;
    }
    if (!job) return identity;

    identity.job_date = fieldosNormaliseCalendarDate_(job.date || job.job_date) || "";
    identity.customer_id = String(job.customer_id || "").trim();
    var rawProject = String(job.project_id || "").trim();

    var maps = null;
    try {
      if (typeof fieldosLoadDisplayMaps_ === "function") maps = fieldosLoadDisplayMaps_();
    } catch (eMaps) {
      maps = null;
    }
    if (maps && typeof fieldosResolveProjectCustomer_ === "function") {
      var resolved = fieldosResolveProjectCustomer_(rawProject, maps) || {};
      identity.project_name = String(resolved.project_name || "");
      identity.customer_name = String(resolved.customer_name || "");
      identity.match = String(resolved.match || "");
      var projectRow = (maps.projectById || {})[rawProject] || null;
      if (!projectRow) {
        var exactHits = (maps.projectByExactName || {})[rawProject] || [];
        if (exactHits.length === 1) projectRow = exactHits[0];
      }
      if (!projectRow && typeof fieldosNormalizeDisplayLabel_ === "function") {
        var norm = fieldosNormalizeDisplayLabel_(rawProject);
        var normHits = norm ? (maps.projectByNormName || {})[norm] || [] : [];
        if (normHits.length === 1) projectRow = normHits[0];
      }
      if (projectRow) {
        identity.project_id = String(projectRow.project_id || "");
        if (!identity.customer_id) identity.customer_id = String(projectRow.customer_id || "");
      }
    }

    var pricing = ((tables && tables.customer_pricing) || []).filter(function (row) {
      return (
        fieldosIsActiveStatus_(row.status) &&
        (!identity.job_date || fieldosDateEffective_(row, identity.job_date)) &&
        String(row.customer_id || "") === identity.customer_id &&
        identity.customer_id &&
        (!String(row.project_id || "").trim() ||
          String(row.project_id || "") === identity.project_id)
      );
    });
    pricing.sort(function (a, b) {
      var aScore = String(a.project_id || "") === identity.project_id && identity.project_id ? 0 : 1;
      var bScore = String(b.project_id || "") === identity.project_id && identity.project_id ? 0 : 1;
      return aScore - bScore;
    });
    if (pricing.length) identity.rate_card_id = String(pricing[0].rate_card_id || "");
    return identity;
  },

  _identityBlockers: function (identity) {
    var blockers = [];
    if (!identity.customer_id) blockers.push("Customer identity unresolved");
    if (!identity.job_date) blockers.push("Job date unresolved");
    return blockers;
  },

  _payrollReadiness: function (bundle, identity, tables) {
    var blockers = [];
    var mappings = [];
    var seen = {};
    (bundle.labour_entries || []).forEach(function (entry) {
      if (!fieldosIsConfirmedRow_(entry)) return;
      var staffId = String(entry.staff_id || "");
      if (!staffId) {
        var missing = "Labour " + String(entry.labour_id || "") + " is missing staff_id.";
        if (blockers.indexOf(missing) < 0) blockers.push(missing);
        return;
      }
      if (seen[staffId]) return;
      seen[staffId] = true;
      var workDate = fieldosNormaliseCalendarDate_(entry.work_date) || identity.job_date;
      var mapping = fieldosResolvePayrollMapping_(staffId, tables.payroll_mappings, workDate);
      mappings.push({
        staff_id: staffId,
        work_date: workDate,
        resolved: mapping.resolved,
        source_id: mapping.source_id || "",
        blockers: mapping.blockers || []
      });
      (mapping.blockers || []).forEach(function (message) {
        var text = staffId + ": " + message;
        if (blockers.indexOf(text) < 0) blockers.push(text);
      });
    });
    return { mappings: mappings, blockers: blockers };
  },

  _priceCompletion: function (completionRow) {
    var tables = this._loadRateTables();
    var bundle = this._bundle(completionRow);
    var identity = this._resolveIdentity(bundle.completion.job_sheet_id, tables);
    if (!identity.job_date) {
      identity.job_date = fieldosNormaliseCalendarDate_(bundle.job.job_date) || "";
    }
    var built = fieldosBuildFinancialLines_({
      completion_id: bundle.completion.completion_id,
      job_date: identity.job_date,
      identity: identity,
      labour_entries: bundle.labour_entries,
      machinery_entries: bundle.machinery_entries,
      material_entries: bundle.material_entries,
      tables: tables
    });
    var customerMapping = identity.customer_id
      ? fieldosResolveXeroMapping_("customer", identity.customer_id, tables.xero_mappings)
      : { resolved: false, blockers: ["Customer identity unresolved"] };
    var payroll = this._payrollReadiness(bundle, identity, tables);
    return {
      tables: tables,
      bundle: bundle,
      identity: identity,
      built: built,
      customer_mapping: customerMapping,
      payroll: payroll
    };
  },

  getCompletionPricingReadiness: function (payload) {
    this._assertManager(payload.actor_role);
    var completionRow = this._completionRow(payload.completion_id);
    var priced = this._priceCompletion(completionRow);
    var identityBlockers = this._identityBlockers(priced.identity);
    var invoiceBlockers = identityBlockers.concat(priced.built.blockers);
    if (priced.bundle.completion.completion_status !== FIELDOS_COMPLETION_STATUSES_.FINALISED) {
      invoiceBlockers = invoiceBlockers.concat(["Completion is not Finalised."]);
    }
    if (!priced.built.lines.length) {
      invoiceBlockers = invoiceBlockers.concat(["No confirmed labour, machinery or material rows to price."]);
    }
    var payrollBlockers = priced.payroll.blockers.slice();
    if (!priced.identity.job_date) payrollBlockers.push("Job date unresolved");

    invoiceBlockers = fieldosUniqueMessages_(invoiceBlockers);
    payrollBlockers = fieldosUniqueMessages_(payrollBlockers);

    return {
      action: "get_completion_pricing_readiness",
      message: "OK",
      data: {
        completion_id: priced.bundle.completion.completion_id,
        job_sheet_id: priced.bundle.completion.job_sheet_id,
        identity: {
          customer_id: priced.identity.customer_id,
          project_id: priced.identity.project_id,
          customer_name: priced.identity.customer_name,
          project_name: priced.identity.project_name,
          job_date: priced.identity.job_date,
          rate_card_id: priced.identity.rate_card_id,
          match: priced.identity.match
        },
        invoice_pricing_ready: invoiceBlockers.length === 0,
        payroll_mapping_ready: payrollBlockers.length === 0,
        invoice_blockers: invoiceBlockers,
        payroll_blockers: payrollBlockers,
        blockers: fieldosUniqueMessages_(invoiceBlockers.concat(payrollBlockers)),
        pricing_status:
          invoiceBlockers.length === 0 ? FIELDOS_PRICING_STATUS_.READY : FIELDOS_PRICING_STATUS_.UNRESOLVED,
        xero_customer_reference: priced.customer_mapping.resolved
          ? String(priced.customer_mapping.mapping.xero_reference || "")
          : "",
        payroll_mappings: priced.payroll.mappings,
        material_suggestions: priced.built.suggestions,
        sample_rates: priced.built.lines.map(function (line) {
          return {
            line_type: line.line_type,
            description: line.description,
            source_row_id: line.source_row_id,
            quantity: line.quantity,
            unit: line.unit,
            unit_sell: line.unit_sell,
            resolved: line.blockers.length === 0,
            rate_source_type: line.rate_source_type,
            rate_source_id: line.rate_source_id,
            non_billable_reason: line.non_billable_reason,
            blockers: line.blockers
          };
        }),
        totals_preview: {
          subtotal_ex_tax: priced.built.subtotal_ex_tax,
          tax_amount: priced.built.tax_amount,
          total_inc_tax: priced.built.total_inc_tax,
          tax_type: priced.built.tax_type,
          currency: FIELDOS_CURRENCY_DEFAULT_
        }
      }
    };
  },

  _draftReference: function (completionId, snapshotId) {
    var parts = String(snapshotId || "").split("-");
    var short = String(parts[parts.length - 1] || snapshotId || "")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 6)
      .toUpperCase();
    return "DRAFT-INV-" + String(completionId || "") + "-" + short;
  },

  _snapshotHeaderRow: function (context) {
    var built = context.built;
    var identity = context.identity;
    var blockers = fieldosUniqueMessages_(
      this._identityBlockers(identity).concat(built.blockers)
    );
    return {
      financial_snapshot_id: context.snapshot_id,
      completion_id: context.completion_id,
      job_sheet_id: context.job_sheet_id,
      customer_id: identity.customer_id,
      project_id: identity.project_id,
      job_date: identity.job_date,
      currency: FIELDOS_CURRENCY_DEFAULT_,
      snapshot_status: FIELDOS_SNAPSHOT_STATUS_.DRAFT,
      pricing_status: blockers.length
        ? FIELDOS_PRICING_STATUS_.UNRESOLVED
        : FIELDOS_PRICING_STATUS_.READY,
      rate_card_id: identity.rate_card_id,
      line_count: built.lines.length,
      subtotal_ex_tax: built.subtotal_ex_tax,
      tax_amount: built.tax_amount,
      total_inc_tax: built.total_inc_tax,
      tax_type: built.tax_type,
      tax_rate_percent: built.tax_rate_percent == null ? "" : built.tax_rate_percent,
      account_code: built.account_code,
      draft_reference: this._draftReference(context.completion_id, context.snapshot_id),
      xero_reference: context.xero_reference || "",
      blockers: JSON.stringify(blockers),
      notes: String(context.notes || ""),
      created_by: context.actor,
      created_at: context.now,
      validated_by: "",
      validated_at: "",
      approved_by: "",
      approved_at: "",
      superseded_by: "",
      superseded_at: "",
      version: 1
    };
  },

  _lineRow: function (line, snapshotId, completionId, now) {
    return {
      financial_line_id: DB.generateId("CFL"),
      financial_snapshot_id: snapshotId,
      completion_id: completionId,
      line_number: line.line_number,
      line_type: line.line_type,
      source_row_id: line.source_row_id,
      description: line.description,
      staff_id: line.staff_id,
      equipment_id: line.equipment_id,
      material_id: line.material_id,
      quantity: line.quantity == null ? "" : line.quantity,
      unit: line.unit,
      unit_sell: line.unit_sell,
      line_amount_ex_tax: line.line_amount_ex_tax,
      tax_type: line.tax_type,
      tax_rate_percent: line.tax_rate_percent == null ? "" : line.tax_rate_percent,
      tax_amount: line.tax_amount,
      line_total_inc_tax: line.line_total_inc_tax,
      account_code: line.account_code,
      rate_source_type: line.rate_source_type,
      rate_source_id: line.rate_source_id,
      billable: line.billable ? "TRUE" : "FALSE",
      non_billable_reason: line.non_billable_reason,
      blockers: JSON.stringify(line.blockers || []),
      created_at: now
    };
  },

  _getSnapshot: function (snapshotId) {
    var id = String(snapshotId || "");
    if (!id) throw new Error("Missing required attribute: financial_snapshot_id.");
    var rows = DB.findWhere("tbl_completion_financials", { financial_snapshot_id: id }) || [];
    if (!rows.length) {
      throw new Error("Not Found: financial snapshot " + id + " does not exist.");
    }
    return rows[0];
  },

  _assembleSnapshot: function (header) {
    var self = this;
    var lines =
      DB.findWhere("tbl_completion_financial_lines", {
        financial_snapshot_id: header.financial_snapshot_id
      }) || [];
    lines.sort(function (a, b) {
      return (Number(a.line_number) || 0) - (Number(b.line_number) || 0);
    });
    return {
      financial_snapshot: {
        financial_snapshot_id: String(header.financial_snapshot_id || ""),
        completion_id: String(header.completion_id || ""),
        job_sheet_id: String(header.job_sheet_id || ""),
        customer_id: String(header.customer_id || ""),
        project_id: String(header.project_id || ""),
        job_date: String(header.job_date || ""),
        currency: String(header.currency || FIELDOS_CURRENCY_DEFAULT_),
        snapshot_status: String(header.snapshot_status || ""),
        pricing_status: String(header.pricing_status || ""),
        rate_card_id: String(header.rate_card_id || ""),
        line_count: Number(header.line_count) || 0,
        subtotal_ex_tax: String(header.subtotal_ex_tax || ""),
        tax_amount: String(header.tax_amount || ""),
        total_inc_tax: String(header.total_inc_tax || ""),
        tax_type: String(header.tax_type || ""),
        tax_rate_percent: header.tax_rate_percent === "" ? null : Number(header.tax_rate_percent),
        account_code: String(header.account_code || ""),
        draft_reference: String(header.draft_reference || ""),
        xero_reference: String(header.xero_reference || ""),
        blockers: self._parseJson(header.blockers, []),
        notes: String(header.notes || ""),
        created_by: String(header.created_by || ""),
        created_at: header.created_at || null,
        validated_by: String(header.validated_by || ""),
        validated_at: header.validated_at || null,
        approved_by: String(header.approved_by || ""),
        approved_at: header.approved_at || null,
        superseded_by: String(header.superseded_by || ""),
        superseded_at: header.superseded_at || null,
        version: Number(header.version) || 1
      },
      lines: lines.map(function (row) {
        return {
          financial_line_id: String(row.financial_line_id || ""),
          financial_snapshot_id: String(row.financial_snapshot_id || ""),
          completion_id: String(row.completion_id || ""),
          line_number: Number(row.line_number) || 0,
          line_type: String(row.line_type || ""),
          source_row_id: String(row.source_row_id || ""),
          description: String(row.description || ""),
          staff_id: String(row.staff_id || ""),
          equipment_id: String(row.equipment_id || ""),
          material_id: String(row.material_id || ""),
          quantity: row.quantity === "" || row.quantity == null ? null : Number(row.quantity),
          unit: String(row.unit || ""),
          unit_sell: String(row.unit_sell || ""),
          line_amount_ex_tax: String(row.line_amount_ex_tax || ""),
          tax_type: String(row.tax_type || ""),
          tax_rate_percent:
            row.tax_rate_percent === "" || row.tax_rate_percent == null
              ? null
              : Number(row.tax_rate_percent),
          tax_amount: String(row.tax_amount || ""),
          line_total_inc_tax: String(row.line_total_inc_tax || ""),
          account_code: String(row.account_code || ""),
          rate_source_type: String(row.rate_source_type || ""),
          rate_source_id: String(row.rate_source_id || ""),
          billable: String(row.billable || "") === "TRUE",
          non_billable_reason: String(row.non_billable_reason || ""),
          blockers: self._parseJson(row.blockers, [])
        };
      })
    };
  },

  createFinancialSnapshot: function (payload) {
    this._assertManager(payload.actor_role);
    if (!this._tableExists("tbl_completion_financials")) {
      throw new Error(
        "Validation Error: financial tables missing — run migrateSchemaForRatesFinancial()."
      );
    }
    var self = this;
    var completionRow = this._completionRow(payload.completion_id);
    var completionId = String(completionRow.completion_id || "");

    // Pricing calculation runs outside the lock — only writes are serialised.
    var priced = this._priceCompletion(completionRow);
    var actor = String(payload.actor_identity || payload.staff_id || "");
    var now = this._nowIso();

    return Utils.withLock("FINANCIAL_" + completionId, 30000, function () {
      var existing = DB.findWhere("tbl_completion_financials", { completion_id: completionId }) || [];
      var approved = existing.filter(function (row) {
        return String(row.snapshot_status || "") === FIELDOS_SNAPSHOT_STATUS_.APPROVED;
      });
      if (approved.length) {
        throw new Error(
          "Conflict: completion " +
            completionId +
            " already has an Approved financial snapshot (" +
            String(approved[0].financial_snapshot_id || "") +
            ") — supersede it before creating a new one."
        );
      }
      var snapshotId = DB.generateId("CFS");
      var header = self._snapshotHeaderRow({
        snapshot_id: snapshotId,
        completion_id: completionId,
        job_sheet_id: priced.bundle.completion.job_sheet_id,
        identity: priced.identity,
        built: priced.built,
        xero_reference: priced.customer_mapping.resolved
          ? String(priced.customer_mapping.mapping.xero_reference || "")
          : "",
        notes: payload.notes,
        actor: actor,
        now: now
      });
      DB.insertRecord("tbl_completion_financials", header, { alreadyLocked: true });
      priced.built.lines.forEach(function (line) {
        DB.insertRecord(
          "tbl_completion_financial_lines",
          self._lineRow(line, snapshotId, completionId, now),
          { alreadyLocked: true }
        );
      });
      self._writeAudit({
        action: "create_financial_snapshot",
        actor_staff_id: payload.staff_id,
        actor_role: fieldosNormalizeRole_(payload.actor_role),
        resource_type: "tbl_completion_financials",
        resource_id: snapshotId,
        completion_id: completionId,
        new_status: FIELDOS_SNAPSHOT_STATUS_.DRAFT,
        version: 1,
        source_ids: priced.built.lines.map(function (line) {
          return line.rate_source_id;
        })
      });
      return {
        action: "create_financial_snapshot",
        message: "Draft financial snapshot created.",
        data: self._assembleSnapshot(header)
      };
    });
  },

  listFinancialSnapshots: function (payload) {
    this._assertManager(payload.actor_role);
    var rows = this._readTable("tbl_completion_financials");
    var completionId = String(payload.completion_id || "");
    var status = String(payload.snapshot_status || "");
    var filtered = rows.filter(function (row) {
      if (completionId && String(row.completion_id || "") !== completionId) return false;
      if (status && String(row.snapshot_status || "") !== status) return false;
      return true;
    });
    filtered.sort(function (a, b) {
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });
    return {
      action: "list_financial_snapshots",
      message: "OK",
      data: {
        items: filtered.map(function (row) {
          return {
            financial_snapshot_id: String(row.financial_snapshot_id || ""),
            completion_id: String(row.completion_id || ""),
            job_sheet_id: String(row.job_sheet_id || ""),
            customer_id: String(row.customer_id || ""),
            project_id: String(row.project_id || ""),
            job_date: String(row.job_date || ""),
            snapshot_status: String(row.snapshot_status || ""),
            pricing_status: String(row.pricing_status || ""),
            line_count: Number(row.line_count) || 0,
            subtotal_ex_tax: String(row.subtotal_ex_tax || ""),
            tax_amount: String(row.tax_amount || ""),
            total_inc_tax: String(row.total_inc_tax || ""),
            draft_reference: String(row.draft_reference || ""),
            xero_reference: String(row.xero_reference || ""),
            created_at: row.created_at || null,
            version: Number(row.version) || 1
          };
        })
      }
    };
  },

  getFinancialSnapshot: function (payload) {
    this._assertManager(payload.actor_role);
    var header = this._getSnapshot(payload.financial_snapshot_id);
    return {
      action: "get_financial_snapshot",
      message: "OK",
      data: this._assembleSnapshot(header)
    };
  },

  validateFinancialSnapshot: function (payload) {
    this._assertManager(payload.actor_role);
    var self = this;
    var snapshotId = String(payload.financial_snapshot_id || "");
    var actor = String(payload.actor_identity || payload.staff_id || "");
    var header = this._getSnapshot(snapshotId);
    var completionId = String(header.completion_id || "");
    return Utils.withLock("FINANCIAL_" + completionId, 30000, function () {
      var current = self._getSnapshot(snapshotId);
      self._checkVersion(current, payload.expected_version, "financial snapshot");
      var previous = String(current.snapshot_status || "");
      fieldosAssertSnapshotTransition_(previous, FIELDOS_SNAPSHOT_STATUS_.VALIDATED);

      var assembled = self._assembleSnapshot(current);
      var blockers = [];
      assembled.lines.forEach(function (line) {
        (line.blockers || []).forEach(function (message) {
          var text = "Line " + line.line_number + ": " + message;
          if (blockers.indexOf(text) < 0) blockers.push(text);
        });
      });
      if (!String(current.customer_id || "").trim()) blockers.push("Customer identity unresolved");
      if (!String(current.job_date || "").trim()) blockers.push("Job date unresolved");
      if (!assembled.lines.length) blockers.push("Snapshot has no priced lines.");
      var billableLines = assembled.lines.filter(function (line) {
        return line.billable;
      });
      billableLines.forEach(function (line) {
        if (!line.tax_type) blockers.push("Line " + line.line_number + ": tax_type unresolved.");
        if (!line.account_code) {
          blockers.push("Line " + line.line_number + ": account_code unresolved.");
        }
        if (line.unit_sell === "") {
          blockers.push("Line " + line.line_number + ": sell rate unresolved.");
        }
      });
      blockers = fieldosUniqueMessages_(blockers);

      var nextStatus = blockers.length
        ? FIELDOS_SNAPSHOT_STATUS_.DRAFT
        : FIELDOS_SNAPSHOT_STATUS_.VALIDATED;
      var patch = {
        snapshot_status: nextStatus,
        pricing_status: blockers.length
          ? FIELDOS_PRICING_STATUS_.UNRESOLVED
          : FIELDOS_PRICING_STATUS_.VALIDATED,
        blockers: JSON.stringify(blockers),
        validated_by: blockers.length ? "" : actor,
        validated_at: blockers.length ? "" : self._nowIso(),
        version: Number(current.version || 1) + 1
      };
      DB.updateRecord("tbl_completion_financials", "financial_snapshot_id", snapshotId, patch);
      var merged = {};
      Object.keys(current).forEach(function (key) {
        merged[key] = current[key];
      });
      Object.assign(merged, patch);
      self._writeAudit({
        action: "validate_financial_snapshot",
        actor_staff_id: payload.staff_id,
        actor_role: fieldosNormalizeRole_(payload.actor_role),
        resource_type: "tbl_completion_financials",
        resource_id: snapshotId,
        completion_id: completionId,
        previous_status: previous,
        new_status: nextStatus,
        version: patch.version
      });
      return {
        action: "validate_financial_snapshot",
        message: blockers.length
          ? "Snapshot has blockers and remains Draft."
          : "Snapshot validated.",
        data: self._assembleSnapshot(merged)
      };
    });
  },

  approveFinancialSnapshot: function (payload) {
    this._assertManager(payload.actor_role);
    var self = this;
    var snapshotId = String(payload.financial_snapshot_id || "");
    var actor = String(payload.actor_identity || payload.staff_id || "");
    var header = this._getSnapshot(snapshotId);
    var completionId = String(header.completion_id || "");
    return Utils.withLock("FINANCIAL_" + completionId, 30000, function () {
      var current = self._getSnapshot(snapshotId);
      self._checkVersion(current, payload.expected_version, "financial snapshot");
      var previous = String(current.snapshot_status || "");
      fieldosAssertSnapshotTransition_(previous, FIELDOS_SNAPSHOT_STATUS_.APPROVED);
      var storedBlockers = self._parseJson(current.blockers, []);
      if (storedBlockers.length) {
        throw new Error("Validation Error: resolve snapshot blockers before approving.");
      }
      var patch = {
        snapshot_status: FIELDOS_SNAPSHOT_STATUS_.APPROVED,
        pricing_status: FIELDOS_PRICING_STATUS_.APPROVED,
        approved_by: actor,
        approved_at: self._nowIso(),
        version: Number(current.version || 1) + 1
      };
      DB.updateRecord("tbl_completion_financials", "financial_snapshot_id", snapshotId, patch);
      var merged = {};
      Object.keys(current).forEach(function (key) {
        merged[key] = current[key];
      });
      Object.assign(merged, patch);
      self._writeAudit({
        action: "approve_financial_snapshot",
        actor_staff_id: payload.staff_id,
        actor_role: fieldosNormalizeRole_(payload.actor_role),
        resource_type: "tbl_completion_financials",
        resource_id: snapshotId,
        completion_id: completionId,
        previous_status: previous,
        new_status: FIELDOS_SNAPSHOT_STATUS_.APPROVED,
        version: patch.version
      });
      return {
        action: "approve_financial_snapshot",
        message: "Snapshot approved and locked.",
        data: self._assembleSnapshot(merged)
      };
    });
  },

  supersedeFinancialSnapshot: function (payload) {
    this._assertManager(payload.actor_role);
    var self = this;
    var snapshotId = String(payload.financial_snapshot_id || "");
    var actor = String(payload.actor_identity || payload.staff_id || "");
    var reason = String(payload.reason || "").trim();
    if (!reason) {
      throw new Error("Validation Error: reason is required to supersede an approved snapshot.");
    }
    var header = this._getSnapshot(snapshotId);
    var completionId = String(header.completion_id || "");
    return Utils.withLock("FINANCIAL_" + completionId, 30000, function () {
      var current = self._getSnapshot(snapshotId);
      self._checkVersion(current, payload.expected_version, "financial snapshot");
      var previous = String(current.snapshot_status || "");
      fieldosAssertSnapshotTransition_(previous, FIELDOS_SNAPSHOT_STATUS_.SUPERSEDED);
      var existingNotes = String(current.notes || "");
      var patch = {
        snapshot_status: FIELDOS_SNAPSHOT_STATUS_.SUPERSEDED,
        superseded_by: actor,
        superseded_at: self._nowIso(),
        notes: existingNotes ? existingNotes + " | Superseded: " + reason : "Superseded: " + reason,
        version: Number(current.version || 1) + 1
      };
      DB.updateRecord("tbl_completion_financials", "financial_snapshot_id", snapshotId, patch);
      var merged = {};
      Object.keys(current).forEach(function (key) {
        merged[key] = current[key];
      });
      Object.assign(merged, patch);
      self._writeAudit({
        action: "supersede_financial_snapshot",
        actor_staff_id: payload.staff_id,
        actor_role: fieldosNormalizeRole_(payload.actor_role),
        resource_type: "tbl_completion_financials",
        resource_id: snapshotId,
        completion_id: completionId,
        previous_status: previous,
        new_status: FIELDOS_SNAPSHOT_STATUS_.SUPERSEDED,
        version: patch.version
      });
      return {
        action: "supersede_financial_snapshot",
        message: "Snapshot superseded — a new snapshot can now be created.",
        data: self._assembleSnapshot(merged)
      };
    });
  }
};
