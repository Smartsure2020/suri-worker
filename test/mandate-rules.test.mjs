// =============================================================
// Mandate rules engine tests — amount edge cases, unknown-as-warning
// behaviour, honest band reasons, fail-safes, and processor terminal
// failure behaviour.
// Run with: npm test  (node --test)
// =============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVALUATORS, runRulesEngine } from '../rules-engine.js';
import { markClaimProcessingFailed } from '../suri-processor.js';

const OPTS = { mandateLimit: 30000, criticalFieldThreshold: 0.85, stalenessDays: 120 };
const amount = EVALUATORS.amount_within_mandate;
const ctx = (extractedFields = {}, claim = {}) => ({ extractedFields, claim });

// ---------- Amount edge cases ----------

test('zero amounts never pass as within mandate', () => {
  const r = amount(ctx({ claimed_value: 0 }, { claimed_value: 0 }), {}, OPTS);
  assert.equal(r.result, 'unknown');
});

test('negative amounts fail as data errors', () => {
  const r = amount(ctx({ claimed_value: -500 }), {}, OPTS);
  assert.equal(r.result, 'fail');
  assert.ok(r.reason.toLowerCase().includes('negative'));
});

test('conflicting amounts use the highest — high invoice fails despite low claimed value', () => {
  const r = amount(ctx({ claimed_value: 8000, invoice_quote_amount: 80000 }), {}, OPTS);
  assert.equal(r.result, 'fail');
  assert.equal(r.details.effective_amount, 80000, 'must evaluate the highest amount, not the claimed value');
  assert.ok(r.reason.includes('conflicting'));
});

test('conflicting amounts both under limit pass, with the conflict surfaced', () => {
  const r = amount(ctx({ claimed_value: 8000, invoice_quote_amount: 9000 }), {}, OPTS);
  assert.equal(r.result, 'pass');
  assert.ok(r.reason.includes('conflicting'));
  assert.equal(r.details.effective_amount, 9000);
});

test('portal-submitted claim amount is considered even when extraction is empty', () => {
  const r = amount(ctx({}, { claimed_value: 50000 }), {}, OPTS);
  assert.equal(r.result, 'fail');
});

test('invoice-only amount is used when claimed value is missing', () => {
  const r = amount(ctx({ invoice_quote_amount: 12000 }), {}, OPTS);
  assert.equal(r.result, 'pass');
  assert.equal(r.details.effective_amount, 12000);
});

test('no amounts at all → unknown, never pass', () => {
  const r = amount(ctx({}, {}), {}, OPTS);
  assert.equal(r.result, 'unknown');
});

test('numeric strings from the database are handled', () => {
  const r = amount(ctx({}, { claimed_value: '45000.00' }), {}, OPTS);
  assert.equal(r.result, 'fail');
});

// ---------- Engine integration: bands and honest reasons ----------

const ENV = { SUPABASE_URL: 'http://sb.local', SUPABASE_SERVICE_KEY: 'k' };
const jsonRes = (x) => new Response(JSON.stringify(x), { status: 200 });

const baseRule = {
  is_active: true, applies_to_insurers: [], applies_to_claim_types: [], applies_to_perils: [],
  description: 'test rule', config: {},
};
const AMOUNT_RULE   = { ...baseRule, rule_code: 'AMOUNT_WITHIN_MANDATE', is_critical: true,  fail_action: 'block', evaluator_key: 'amount_within_mandate' };
const SUPPLIER_RULE = { ...baseRule, rule_code: 'SUPPLIER_APPEARS_VALID', is_critical: false, fail_action: 'warn',  evaluator_key: 'supplier_appears_valid' };

function stubSupabase(t, rules) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('system_constants')) {
      if (u.includes('CLAIMS_PRE_MANDATE_LIMIT')) return jsonRes([{ value: 30000, data_type: 'number' }]);
      return jsonRes([]); // other constants fall back to defaults
    }
    if (u.includes('mandate_rules')) return jsonRes(rules);
    throw new Error('unexpected fetch: ' + u);
  };
}

const engineContext = (extractedFields) => ({
  claim: {},
  extractedFields,
  classification: { claim_type: 'motor', insurer: 'infiniti' },
  documents: [],
  fraudFlags: [],
  rulePack: null,
  aiOutput: { confidence_score: 0.9 },
});

test('non-critical unknown produces Band 2 with an honest reason, not "all rules passed"', async (t) => {
  stubSupabase(t, [AMOUNT_RULE, SUPPLIER_RULE]);
  // Amount passes; supplier name missing → supplier rule = unknown.
  const result = await runRulesEngine(engineContext({ claimed_value: 12000 }), ENV);
  assert.equal(result.mandate_band, 'band_2');
  assert.ok(result.mandate_band_reason.includes('SUPPLIER_APPEARS_VALID (unknown)'));
  assert.equal(result.mandate_band_reason.toLowerCase().includes('all rules passed'), false);
  assert.equal(result.mandate_band_reason.toLowerCase().includes('approve aol'), false,
    'engine must not recommend approval wording');
});

test('genuinely clean claim reaches Band 3 with a truthful pass count', async (t) => {
  stubSupabase(t, [AMOUNT_RULE, SUPPLIER_RULE]);
  const result = await runRulesEngine(
    engineContext({ claimed_value: 12000, supplier_name: 'ABC Panelbeaters', supplier_contact: '011 555 0000' }),
    ENV
  );
  assert.equal(result.mandate_band, 'band_3');
  assert.ok(result.mandate_band_reason.includes('All 2 applicable rule(s) passed'));
});

test('zero applicable rules fails safe to Band 1', async (t) => {
  stubSupabase(t, []);
  const result = await runRulesEngine(engineContext({ claimed_value: 12000 }), ENV);
  assert.equal(result.mandate_band, 'band_1');
  assert.ok(result.critical_unknowns.includes('no_applicable_rules'));
});

test('over-mandate amount fails the critical rule and lands in Band 1', async (t) => {
  stubSupabase(t, [AMOUNT_RULE]);
  const result = await runRulesEngine(engineContext({ claimed_value: 95000 }), ENV);
  assert.equal(result.mandate_band, 'band_1');
  assert.ok(result.mandate_band_reason.includes('AMOUNT_WITHIN_MANDATE (fail)'));
});

// ---------- Processor terminal failure ----------

test('markClaimProcessingFailed sets status=error and writes an audit entry', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    return new Response('[]', { status: 200 });
  };

  await markClaimProcessingFailed(ENV, 'claim-123', 3, 'Claude API error 500');

  const patch = calls.find(c => c.method === 'PATCH' && c.url.includes('claims?id=eq.claim-123'));
  assert.ok(patch, 'claim PATCH issued');
  assert.equal(JSON.parse(patch.body).status, 'error');

  const audit = calls.find(c => c.method === 'POST' && c.url.includes('audit_log'));
  assert.ok(audit, 'audit entry inserted');
  const auditBody = JSON.parse(audit.body);
  assert.equal(auditBody.action, 'ai_processing_failed');
  assert.equal(auditBody.after_state.terminal, true);
});

test('markClaimProcessingFailed never throws even when the database is down', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  await assert.doesNotReject(markClaimProcessingFailed(ENV, 'claim-123', 3, 'boom'));
});
