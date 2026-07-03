// =============================================================
// Payment/banking boundary tests.
// Verifies the Phase 0 guarantees end to end at the unit level:
//  - model output never reaches errors/logs raw
//  - portal submission payloads are scrubbed before storage
//  - inbound email bodies are scrubbed before storage
//  - audit states passed through the scrubber carry no banking content
// Run with: npm test  (node --test)
// =============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitiseAiOutput, REDACTION_MARKER } from '../banking-scrubber.js';
import { parseClaudeJson } from '../suri-processor.js';

// ---------- Model output never leaks into errors ----------

test('parseClaudeJson parses valid JSON with markdown fences', () => {
  const out = parseClaudeJson('```json\n{"claim_summary":"ok","confidence_score":0.9}\n```');
  assert.equal(out.claim_summary, 'ok');
});

test('parseClaudeJson never includes raw model text in thrown errors', () => {
  const leaky = 'Here are the details: FNB account number 62012345678, branch 250655';
  assert.throws(
    () => parseClaudeJson(leaky),
    (err) => {
      assert.equal(err.message.includes('62012345678'), false);
      assert.equal(err.message.includes('250655'), false);
      assert.equal(err.message.toLowerCase().includes('fnb'), false);
      assert.ok(err.message.includes('not valid JSON'));
      return true;
    }
  );
});

// ---------- Portal submission payload scrubbing ----------

test('injected banking form fields are dropped from submission payload', () => {
  // The /upload endpoint is public: anyone can POST arbitrary field names.
  const payload = {
    insured_name: 'J Smith',
    policy_number: 'POL-889123',
    account_number: '62011122233',        // injected — must be dropped
    supplier_bank_details: 'Absa 405112', // injected — must be dropped
    damage_description: 'Storm damage to roof.',
  };
  const { sanitised, bankingDetected } = sanitiseAiOutput(payload);
  assert.equal('account_number' in sanitised, false);
  assert.equal('supplier_bank_details' in sanitised, false);
  assert.equal(sanitised.policy_number, 'POL-889123');
  assert.equal(bankingDetected, true);
});

test('banking details typed into free-text fields are redacted', () => {
  const payload = {
    damage_description:
      'Geyser burst. Please pay the plumber: Standard Bank, account number 62011122233, branch code 051001.',
  };
  const { sanitised, bankingDetected } = sanitiseAiOutput(payload);
  const flat = JSON.stringify(sanitised);
  assert.equal(flat.includes('62011122233'), false);
  assert.equal(flat.includes('051001'), false);
  assert.ok(sanitised.damage_description.includes(REDACTION_MARKER));
  assert.equal(bankingDetected, true);
});

// ---------- Inbound email body scrubbing ----------

test('email bodies with supplier banking details are redacted before storage', () => {
  const emailShape = {
    subject: 'Claim - burst geyser - POL-889123',
    body_text: 'Hi, quote attached. Supplier banking details: Capitec, acc no 1451234567.',
    body_html: '<p>Quote attached.</p><p>EFT details: Nedbank account no: 1122334455, branch no 198765</p>',
  };
  const { sanitised, bankingDetected } = sanitiseAiOutput(emailShape);
  const flat = JSON.stringify(sanitised);
  assert.equal(flat.includes('1451234567'), false);
  assert.equal(flat.includes('1122334455'), false);
  assert.equal(bankingDetected, true);
  assert.equal(sanitised.subject, emailShape.subject, 'clean subject must be preserved');
});

test('clean email bodies pass through unchanged', () => {
  const emailShape = {
    subject: 'Claim - hail damage',
    body_text: 'Please register a hail claim for our client. Photos and quote attached.',
    body_html: null,
  };
  const { sanitised, bankingDetected } = sanitiseAiOutput(emailShape);
  assert.deepEqual(sanitised, emailShape);
  assert.equal(bankingDetected, false);
});

// ---------- Audit state scrubbing ----------

test('audit-style state objects carry no banking content after scrub', () => {
  const afterState = {
    source: 'email',
    subject: 'Re: claim SS-2026-INF-00001',
    extracted: {
      supplier_name: 'ABC Plumbing',
      banking_details: 'FNB 62012345678 branch 250655', // must be dropped by key
      notes: 'Invoice shows banking details 62012345678 on page 2',
    },
  };
  const { sanitised } = sanitiseAiOutput(afterState);
  const flat = JSON.stringify(sanitised);
  assert.equal(flat.includes('62012345678'), false);
  assert.equal('banking_details' in sanitised.extracted, false);
  assert.equal(sanitised.extracted.supplier_name, 'ABC Plumbing');
});
