// =============================================================
// Suri — rules-engine.js
// Smartsure Twenty20
//
// Deterministic rules engine for pre-mandate band assignment.
// No AI calls inside this module. All rules are evaluated against
// pre-extracted data from Claude + system_constants + mandate_rules.
//
// Public API:
//   runRulesEngine(context, env) -> {
//     mandate_band, mandate_band_reason, critical_unknowns,
//     rule_results, rules_engine_version
//   }
//
// context shape:
//   {
//     claim,                  -- claim record
//     extractedFields,        -- Claude extracted_fields (sanitised)
//     classification,         -- Claude classification (sanitised)
//     documents,              -- claim_documents rows
//     fraudFlags,             -- fraud_flags rows for this claim
//     rulePack,               -- matched insurer_rule_pack row (nullable)
//     aiOutput,               -- { confidence_score, ... }
//   }
// =============================================================

// v1.1: safest-amount mandate check (max of claimed/invoice, zero/negative
// never pass), non-critical unknowns treated as warnings, honest band
// reasons, fail-safe when no rules were applicable/evaluated.
const RULES_ENGINE_VERSION = 'v1.1';

// =============================================================
// MAIN ENTRY
// =============================================================

export async function runRulesEngine(context, env) {
  // 1. Load mandate limit. Fail safe to Band 1 if unreadable or invalid.
  const mandateLimit = await loadSystemConstant(env, 'CLAIMS_PRE_MANDATE_LIMIT');
  const overallConfidenceThreshold = await loadSystemConstant(
    env, 'AI_OVERALL_CONFIDENCE_THRESHOLD', 0.7
  );
  const criticalFieldThreshold = await loadSystemConstant(
    env, 'AI_CRITICAL_FIELD_CONFIDENCE_THRESHOLD', 0.85
  );
  const stalenessDays = await loadSystemConstant(
    env, 'CLAIM_VALUE_STALENESS_DAYS', 120
  );

  if (mandateLimit === null || typeof mandateLimit !== 'number' || isNaN(mandateLimit)) {
    return failSafeBand1(
      'system_constant_unreadable',
      'CLAIMS_PRE_MANDATE_LIMIT could not be read or is invalid. Defaulting to Band 1 for safety.'
    );
  }

  // 2. Hard guard: low overall AI confidence → Band 1
  const overallConfidence = context.aiOutput?.confidence_score ?? 1.0;
  if (overallConfidence < overallConfidenceThreshold) {
    return failSafeBand1(
      'low_ai_confidence',
      `Overall AI confidence ${overallConfidence.toFixed(2)} below threshold ${overallConfidenceThreshold}.`
    );
  }

  // 3. Hard guard: specialist claims always Band 1
  if (context.classification?.claim_type === 'specialist') {
    return {
      mandate_band: 'band_1',
      mandate_band_reason: 'Specialist claims are not eligible for pre-mandate authorisation. Always Band 1.',
      critical_unknowns: [],
      rule_results: {},
      rules_engine_version: RULES_ENGINE_VERSION,
    };
  }

  // 4. Load active rules
  let allRules;
  try {
    allRules = await loadActiveRules(env);
  } catch (err) {
    return failSafeBand1(
      'rules_load_failure',
      `Could not load mandate_rules: ${err.message}. Defaulting to Band 1.`
    );
  }

  // 5. Filter to applicable rules for this claim
  const applicableRules = allRules.filter(rule => isRuleApplicable(rule, context));

  // 6. Evaluate each rule
  const opts = { mandateLimit, criticalFieldThreshold, stalenessDays };
  const ruleResults = {};
  const criticalUnknowns = [];
  let hasCriticalFailOrUnknown = false;
  let hasNonCriticalWarn = false;

  for (const rule of applicableRules) {
    const evaluator = EVALUATORS[rule.evaluator_key];
    let result;

    if (!evaluator) {
      result = {
        result: 'unknown',
        reason: `Evaluator '${rule.evaluator_key}' not implemented in rules engine ${RULES_ENGINE_VERSION}.`,
      };
    } else {
      try {
        result = await evaluator(context, rule, opts);
      } catch (err) {
        result = {
          result: 'unknown',
          reason: `Evaluator threw error: ${err.message}`,
          details: { error: true },
        };
      }
    }

    ruleResults[rule.rule_code] = {
      ...result,
      is_critical: rule.is_critical,
      fail_action: rule.fail_action,
      description: rule.description,
    };

    // Band assignment tally.
    // Non-critical 'unknown' counts as a warning too — an unevaluable check
    // must never silently count as a pass.
    if (result.result === 'fail' || result.result === 'unknown') {
      if (rule.is_critical) {
        hasCriticalFailOrUnknown = true;
        if (result.result === 'unknown') criticalUnknowns.push(rule.rule_code);
      } else {
        hasNonCriticalWarn = true;
      }
    }
  }

  // 6b. Fail safe: if no rules were applicable at all, nothing was actually
  // checked — that must not read as "all rules passed".
  if (Object.keys(ruleResults).length === 0) {
    return failSafeBand1(
      'no_applicable_rules',
      'No active mandate rules were applicable to this claim. Nothing was checked — defaulting to Band 1 for safety.'
    );
  }

  // 7. Deterministic band assignment with honest reasons
  const describe = ([code, r]) => `${code} (${r.result})`;
  let band, reason;
  if (hasCriticalFailOrUnknown) {
    band = 'band_1';
    const failed = Object.entries(ruleResults)
      .filter(([_, r]) => r.is_critical && (r.result === 'fail' || r.result === 'unknown'))
      .map(describe);
    reason = `Critical rule(s) did not pass: ${failed.join(', ')}. Routed to admin review.`;
  } else if (hasNonCriticalWarn) {
    band = 'band_2';
    const warns = Object.entries(ruleResults)
      .filter(([_, r]) => !r.is_critical && (r.result === 'fail' || r.result === 'unknown'))
      .map(describe);
    reason = `All critical rules passed, but non-critical check(s) need handler attention: ${warns.join(', ')}. Handler to confirm cover, excess and policy status before any decision.`;
  } else {
    const counts = Object.values(ruleResults).reduce(
      (acc, r) => { acc[r.result] = (acc[r.result] || 0) + 1; return acc; }, {}
    );
    if (!counts.pass) {
      return failSafeBand1(
        'no_rules_evaluated',
        'Every applicable rule was not-applicable to this claim — nothing was actually checked. Defaulting to Band 1 for safety.'
      );
    }
    band = 'band_3';
    const naNote = counts.not_applicable ? ` (${counts.not_applicable} not applicable)` : '';
    reason = `All ${counts.pass} applicable rule(s) passed${naNote}. Claim eligible for pre-mandate authorisation recommendation. Handler to confirm and approve.`;
  }

  return {
    mandate_band: band,
    mandate_band_reason: reason,
    critical_unknowns: criticalUnknowns,
    rule_results: ruleResults,
    rules_engine_version: RULES_ENGINE_VERSION,
  };
}

function failSafeBand1(code, reason) {
  return {
    mandate_band: 'band_1',
    mandate_band_reason: reason,
    critical_unknowns: [code],
    rule_results: {
      [code.toUpperCase()]: {
        result: 'unknown',
        reason,
        is_critical: true,
        fail_action: 'block',
      },
    },
    rules_engine_version: RULES_ENGINE_VERSION,
  };
}

// =============================================================
// EVALUATORS
// Each returns { result, reason, details? }
// result is 'pass' | 'fail' | 'unknown' | 'not_applicable'
// =============================================================

// Accepts numbers and clean numeric strings (PostgREST can serialise
// decimals either way). Anything else is treated as not-a-value.
function normaliseAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return parseFloat(value.trim());
  }
  return null;
}

// Exported for tests.
export const EVALUATORS = {
  // Evaluates the SAFEST amount: the maximum of all known amounts across the
  // AI extraction and the submitted claim record. Zero and negative amounts
  // never pass; conflicting figures are surfaced in the reason.
  amount_within_mandate(ctx, rule, opts) {
    const sources = {
      extracted_claimed:  normaliseAmount(ctx.extractedFields?.claimed_value),
      extracted_invoice:  normaliseAmount(ctx.extractedFields?.invoice_quote_amount),
      submitted_claimed:  normaliseAmount(ctx.claim?.claimed_value),
      submitted_invoice:  normaliseAmount(ctx.claim?.invoice_quote_amount),
    };
    const known = Object.entries(sources).filter(([, v]) => v !== null);

    if (known.length === 0) {
      return { result: 'unknown', reason: 'No claimed or invoice/quote amount could be established from the submission or documents.' };
    }
    const negatives = known.filter(([, v]) => v < 0);
    if (negatives.length > 0) {
      return {
        result: 'fail',
        reason: `Negative amount detected (${negatives.map(([k, v]) => `${k}: R${v.toLocaleString()}`).join(', ')}). Amounts cannot be negative — data error, handler review required.`,
        details: { sources },
      };
    }
    const effective = Math.max(...known.map(([, v]) => v));
    if (effective === 0) {
      return {
        result: 'unknown',
        reason: 'All known claimed/invoice amounts are zero — claim value could not be established.',
        details: { sources },
      };
    }
    const distinct = [...new Set(known.map(([, v]) => v).filter(v => v > 0))];
    const conflictNote = distinct.length > 1
      ? ` Using highest of conflicting amounts (${distinct.map(v => `R${v.toLocaleString()}`).join(', ')}).`
      : '';
    if (effective > opts.mandateLimit) {
      return {
        result: 'fail',
        reason: `Highest known amount R${effective.toLocaleString()} exceeds pre-mandate limit R${opts.mandateLimit.toLocaleString()}.${conflictNote}`,
        details: { effective_amount: effective, limit: opts.mandateLimit, sources },
      };
    }
    return {
      result: 'pass',
      reason: `Highest known amount R${effective.toLocaleString()} within pre-mandate limit R${opts.mandateLimit.toLocaleString()}.${conflictNote}`,
      details: { effective_amount: effective, limit: opts.mandateLimit, sources },
    };
  },

  claim_type_eligible(ctx, rule, opts) {
    const claimType = ctx.classification?.claim_type;
    const eligible = rule.config?.eligible_types || ['motor', 'non_motor'];
    if (!claimType) {
      return { result: 'unknown', reason: 'Claim type not classified.' };
    }
    if (!eligible.includes(claimType)) {
      return {
        result: 'fail',
        reason: `Claim type '${claimType}' not eligible for pre-mandate. Eligible: ${eligible.join(', ')}.`,
      };
    }
    return { result: 'pass', reason: `Claim type '${claimType}' eligible for pre-mandate.` };
  },

  policy_appears_active(ctx, rule, opts) {
    const status = ctx.extractedFields?.policy_status_assessment;
    const confidence = ctx.extractedFields?.policy_status_confidence ?? 0;
    if (!status || status === 'unknown') {
      return { result: 'unknown', reason: 'Policy status could not be determined from documents.' };
    }
    if (status === 'lapsed' || status === 'cancelled') {
      return {
        result: 'fail',
        reason: `Policy appears ${status} in supplied documents.`,
        details: { status, confidence },
      };
    }
    if (status === 'active' && confidence < opts.criticalFieldThreshold) {
      return {
        result: 'unknown',
        reason: `Policy indicated as active but confidence ${confidence.toFixed(2)} below threshold ${opts.criticalFieldThreshold}.`,
        details: { status, confidence },
      };
    }
    return {
      result: 'pass',
      reason: 'Policy appears active in supplied documents.',
      details: { status, confidence },
    };
  },

  date_of_loss_valid(ctx, rule, opts) {
    const dateStr = ctx.extractedFields?.date_of_loss || ctx.extractedFields?.incident_date;
    if (!dateStr) {
      return { result: 'unknown', reason: 'Date of loss not extracted.' };
    }
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      return { result: 'unknown', reason: `Date of loss '${dateStr}' could not be parsed.` };
    }
    const now = new Date();
    if (date > now) {
      return { result: 'fail', reason: 'Date of loss is in the future.', details: { date_of_loss: dateStr } };
    }
    const daysOld = Math.floor((now - date) / (1000 * 60 * 60 * 24));
    if (daysOld > opts.stalenessDays) {
      return {
        result: 'fail',
        reason: `Date of loss is ${daysOld} days old, exceeds staleness threshold of ${opts.stalenessDays} days.`,
        details: { date_of_loss: dateStr, days_old: daysOld },
      };
    }
    // Check against policy period if known
    const polStart = ctx.extractedFields?.policy_period_start;
    const polEnd   = ctx.extractedFields?.policy_period_end;
    if (polStart && polEnd) {
      const start = new Date(polStart), end = new Date(polEnd);
      if (!isNaN(start) && !isNaN(end)) {
        if (date < start || date > end) {
          return {
            result: 'fail',
            reason: `Date of loss ${dateStr} falls outside policy period ${polStart} to ${polEnd}.`,
            details: { date_of_loss: dateStr, policy_period: [polStart, polEnd] },
          };
        }
      }
    }
    return {
      result: 'pass',
      reason: `Date of loss ${dateStr} is valid (${daysOld} days old).`,
      details: { date_of_loss: dateStr, days_old: daysOld },
    };
  },

  required_documents_present(ctx, rule, opts) {
    if (!ctx.rulePack) {
      return {
        result: 'unknown',
        reason: 'Insurer rule pack not matched — cannot evaluate required documents.',
      };
    }
    const required = ctx.rulePack.required_documents || [];
    const present  = new Set(
      (ctx.documents || []).filter(d => d.document_type).map(d => d.document_type)
    );
    const missing  = required.filter(d => !present.has(d));
    if (missing.length > 0) {
      return {
        result: 'fail',
        reason: `Missing required documents: ${missing.join(', ')}.`,
        details: { required, missing, present: required.filter(d => present.has(d)) },
      };
    }
    return {
      result: 'pass',
      reason: 'All required documents present.',
      details: { required, present: required },
    };
  },

  invoice_or_quote_uploaded(ctx, rule, opts) {
    const indicator = ctx.extractedFields?.invoice_or_quote;
    const docTypes = new Set((ctx.documents || []).map(d => d.document_type));
    const hasQuoteOrInvoice = docTypes.has('repair_quote')
      || docTypes.has('contractors_quote')
      || docTypes.has('invoice');
    if (indicator === 'neither' && !hasQuoteOrInvoice) {
      return { result: 'fail', reason: 'No invoice or quote document detected.' };
    }
    if (['invoice', 'quote', 'both'].includes(indicator) || hasQuoteOrInvoice) {
      return {
        result: 'pass',
        reason: indicator === 'both'
          ? 'Invoice and quote documents detected.'
          : `${(indicator || 'Invoice/quote').toString().charAt(0).toUpperCase() + (indicator || 'invoice/quote').toString().slice(1)} document(s) detected.`,
      };
    }
    return { result: 'unknown', reason: 'Could not determine invoice/quote status.' };
  },

  supplier_appears_valid(ctx, rule, opts) {
    const name    = ctx.extractedFields?.supplier_name;
    const contact = ctx.extractedFields?.supplier_contact;
    if (!name) {
      return { result: 'unknown', reason: 'Supplier name not extracted.' };
    }
    if (!contact) {
      return {
        result: 'fail',
        reason: 'Supplier contact details not extracted.',
        details: { supplier_name: name },
      };
    }
    return {
      result: 'pass',
      reason: 'Supplier name and contact details present.',
      details: { supplier_name: name },
    };
  },

  cause_sudden_unforeseen(ctx, rule, opts) {
    if (ctx.classification?.claim_type !== 'non_motor') {
      return { result: 'not_applicable', reason: 'Rule applies only to non-motor claims.' };
    }
    const assessment = ctx.extractedFields?.cause_appears_sudden_unforeseen;
    const confidence = ctx.extractedFields?.cause_sudden_unforeseen_confidence ?? 0;
    if (!assessment || assessment === 'unclear') {
      return {
        result: 'unknown',
        reason: 'Cause of loss could not be confidently assessed as sudden and unforeseen.',
      };
    }
    if (assessment === 'no') {
      return {
        result: 'fail',
        reason: 'Cause of loss does not appear sudden and unforeseen — possible exclusion concern.',
      };
    }
    if (assessment === 'yes' && confidence < opts.criticalFieldThreshold) {
      return {
        result: 'unknown',
        reason: `Cause assessed as sudden/unforeseen but confidence ${confidence.toFixed(2)} below threshold ${opts.criticalFieldThreshold}.`,
      };
    }
    return {
      result: 'pass',
      reason: 'Cause of loss appears sudden and unforeseen.',
      details: { confidence },
    };
  },

  excess_identifiable(ctx, rule, opts) {
    const identified = ctx.extractedFields?.excess_identified;
    const amount     = ctx.extractedFields?.excess_amount;
    if (identified === 'yes' && amount && amount > 0) {
      return {
        result: 'pass',
        reason: `Excess identified as R${amount.toLocaleString()}.`,
        details: { excess_amount: amount },
      };
    }
    if (identified === 'no') {
      return { result: 'fail', reason: 'Excess could not be identified from documents.' };
    }
    return { result: 'unknown', reason: 'Excess identification status unclear.' };
  },

  no_exclusion_triggered(ctx, rule, opts) {
    const detected = ctx.extractedFields?.exclusion_language_detected;
    const phrases  = ctx.extractedFields?.exclusion_phrases || [];
    if (detected === true) {
      return {
        result: 'fail',
        reason: `Possible exclusion language detected. Handler review required.`,
        details: { phrase_count: phrases.length },
      };
    }
    if (detected === false) {
      return { result: 'pass', reason: 'No exclusion language detected.' };
    }
    return { result: 'unknown', reason: 'Exclusion check could not be performed.' };
  },

  no_fraud_flag(ctx, rule, opts) {
    const open = (ctx.fraudFlags || []).filter(
      f => f.status === 'open' || f.status === 'under_review'
    );
    if (open.length > 0) {
      return {
        result: 'fail',
        reason: `${open.length} open fraud flag(s) on this claim.`,
        details: { flag_count: open.length, flag_types: open.map(f => f.flag_type) },
      };
    }
    return { result: 'pass', reason: 'No open fraud flags for this claim.' };
  },

  no_management_referral(ctx, rule, opts) {
    const insurer = ctx.classification?.insurer;
    const docTypes = new Set(
      (ctx.documents || []).filter(d => d.document_type).map(d => d.document_type)
    );

    // Hollard outsourced requires BDO authorisation
    if (insurer === 'hollard_outsourced' && !docTypes.has('bdo_authorisation')) {
      return {
        result: 'fail',
        reason: 'Hollard outsourced claims require BDO authorisation — management referral needed.',
        details: { insurer, missing_referral_doc: 'bdo_authorisation' },
      };
    }

    // Future: per-insurer referral rules read from insurer_rule_packs.special_conditions

    return { result: 'pass', reason: 'No management referral rule triggered.' };
  },
};

// =============================================================
// RULE APPLICABILITY FILTER
// =============================================================

function isRuleApplicable(rule, context) {
  if (!rule.is_active) return false;

  if (rule.applies_to_insurers?.length > 0 && context.classification?.insurer) {
    if (!rule.applies_to_insurers.includes(context.classification.insurer)) return false;
  }
  if (rule.applies_to_claim_types?.length > 0 && context.classification?.claim_type) {
    if (!rule.applies_to_claim_types.includes(context.classification.claim_type)) return false;
  }
  if (rule.applies_to_perils?.length > 0 && context.classification?.peril_type) {
    if (!rule.applies_to_perils.includes(context.classification.peril_type)) return false;
  }
  return true;
}

// =============================================================
// SUPABASE READ HELPERS
// =============================================================

async function loadSystemConstant(env, key, fallback = null) {
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/system_constants?key=eq.${encodeURIComponent(key)}&select=value,data_type&limit=1`,
      { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) return fallback;
    const rows = await res.json();
    if (!rows.length) return fallback;
    return rows[0].value;
  } catch (err) {
    console.error(`Failed to load system_constant ${key}:`, err.message);
    return fallback;
  }
}

async function loadActiveRules(env) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/mandate_rules?is_active=eq.true&order=display_order.asc`,
    { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
  );
  if (!res.ok) throw new Error(`mandate_rules load failed: ${res.status}`);
  return res.json();
}

export { RULES_ENGINE_VERSION, loadSystemConstant, loadActiveRules };
