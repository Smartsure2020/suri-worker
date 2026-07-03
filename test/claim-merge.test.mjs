// =============================================================
// Claim update merge tests — Claude nulls must never clobber
// portal/email-submitted claim data; valid zeros are preserved.
// Run with: npm test  (node --test)
// =============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaimUpdates } from '../suri-processor.js';

const routing = { queue: 'motor_handlers', handler_queue: 'motor' };
const rulesResult = { mandate_band: 'band_2', mandate_band_reason: 'test reason' };

const existingClaim = {
  insured_name: 'Jane Mokoena',
  policy_number: 'POL-889123',
  insurer: 'infiniti',
  claim_type: 'motor',
  incident_date: '2026-06-20',
  claimed_value: 0,          // legitimate zero entered at submission
  vat_amount: 450,
  vehicle_registration: 'ND123456',
  insurer_rule_id: 'rule-1',
  banking_details_detected: false,
  banking_details_detected_notes: null,
};

test('Claude nulls and empty strings do not overwrite submitted data', () => {
  const validated = {
    extracted_fields: {
      insured_name: null,
      policy_number: '',
      claimed_value: null,
      vat_amount: null,
      vehicle_registration: null,
      excess_amount: 3500,       // genuinely new value — should be taken
    },
    classification: {},           // Claude classified nothing
    confidence_score: 0.8,
  };
  const u = buildClaimUpdates(validated, routing, null, rulesResult, false, existingClaim);

  assert.equal(u.insured_name, 'Jane Mokoena');
  assert.equal(u.policy_number, 'POL-889123');
  assert.equal(u.insurer, 'infiniti');
  assert.equal(u.claim_type, 'motor');
  assert.equal(u.incident_date, '2026-06-20');
  assert.equal(u.vehicle_registration, 'ND123456');
  assert.equal(u.vat_amount, 450);
  assert.equal(u.excess_amount, 3500, 'new AI value should be applied');
  assert.equal(u.insurer_rule_id, 'rule-1', 'unmatched rule pack must not null the stored one');
});

test('valid zero values are preserved in both directions', () => {
  // Existing zero survives an AI null
  const aiNull = buildClaimUpdates(
    { extracted_fields: { claimed_value: null }, classification: {}, confidence_score: 0.8 },
    routing, null, rulesResult, false, existingClaim
  );
  assert.equal(aiNull.claimed_value, 0);

  // AI zero is treated as a meaningful value, not coerced to null
  const aiZero = buildClaimUpdates(
    { extracted_fields: { excess_amount: 0 }, classification: {}, confidence_score: 0.8 },
    routing, null, rulesResult, false, existingClaim
  );
  assert.equal(aiZero.excess_amount, 0);
});

test('meaningful Claude values do overwrite submitted data', () => {
  const validated = {
    extracted_fields: { policy_number: 'POL-CORRECTED-1', claimed_value: 15000 },
    classification: { claim_type: 'motor', peril_type: 'hail', insurer: 'infiniti' },
    confidence_score: 0.9,
  };
  const u = buildClaimUpdates(validated, routing, { id: 'rule-2' }, rulesResult, false, existingClaim);
  assert.equal(u.policy_number, 'POL-CORRECTED-1');
  assert.equal(u.claimed_value, 15000);
  assert.equal(u.peril_type, 'hail');
  assert.equal(u.insurer_rule_id, 'rule-2');
});

test('ingestion-set banking flag is never cleared by a clean AI run', () => {
  const flaggedClaim = {
    ...existingClaim,
    banking_details_detected: true,
    banking_details_detected_notes: 'Banking details detected in portal submission text and redacted before storage. Content not retained by Suri.',
  };
  const u = buildClaimUpdates(
    { extracted_fields: { banking_details_detected: false }, classification: {}, confidence_score: 0.9 },
    routing, null, rulesResult, false, flaggedClaim
  );
  assert.equal(u.banking_details_detected, true);
  assert.ok(u.banking_details_detected_notes.includes('redacted before storage'));
});
