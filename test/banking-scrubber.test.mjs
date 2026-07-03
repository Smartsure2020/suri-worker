// =============================================================
// Banking scrubber unit tests — the module the payment/banking
// boundary rests on. Run with: npm test  (node --test)
// =============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitiseAiOutput, REDACTION_MARKER } from '../banking-scrubber.js';

// ---------- Forbidden field names (keys dropped entirely) ----------

test('drops forbidden field names', () => {
  const { sanitised, bankingDetected, locations } = sanitiseAiOutput({
    insured_name: 'J Smith',
    account_number: '62012345678',
    bank_details: 'FNB 62012345678',
  });
  assert.equal(sanitised.insured_name, 'J Smith');
  assert.equal('account_number' in sanitised, false);
  assert.equal('bank_details' in sanitised, false);
  assert.equal(bankingDetected, true);
  assert.ok(locations.some(l => l.includes('account_number')));
});

test('drops composite forbidden keys (substring match)', () => {
  const { sanitised, bankingDetected } = sanitiseAiOutput({
    supplier_bank_account_number: '123456789',
    beneficiary_bank_name: 'Absa',
  });
  assert.deepEqual(sanitised, {});
  assert.equal(bankingDetected, true);
});

test('normalises key case, spaces and hyphens before matching', () => {
  const { sanitised } = sanitiseAiOutput({
    'Account Number': '123456789',
    'bank-details': 'x',
    'BRANCH CODE': '250655',
  });
  assert.deepEqual(sanitised, {});
});

// ---------- In-text pattern redaction ----------

test('redacts keyword + digits (account number)', () => {
  const { sanitised, bankingDetected } = sanitiseAiOutput({
    note: 'Please pay into account number: 62012345678 thanks',
  });
  assert.equal(sanitised.note.includes('62012345678'), false);
  assert.ok(sanitised.note.includes(REDACTION_MARKER));
  assert.equal(bankingDetected, true);
});

test('redacts branch code + digits', () => {
  const { sanitised } = sanitiseAiOutput({ note: 'Branch code 250655' });
  assert.equal(sanitised.note.includes('250655'), false);
  assert.ok(sanitised.note.includes(REDACTION_MARKER));
});

test('redacts ZA bank name near digit sequence', () => {
  const { sanitised, bankingDetected } = sanitiseAiOutput({
    note: 'Deposit to Standard Bank acc 62012345678',
  });
  assert.equal(sanitised.note.includes('62012345678'), false);
  assert.equal(bankingDetected, true);
});

test('redacts IBAN format', () => {
  const { sanitised } = sanitiseAiOutput({ note: 'IBAN GB29NWBK60161331926819 for transfer' });
  assert.equal(sanitised.note.includes('GB29NWBK60161331926819'), false);
});

// ---------- Recursion, passthrough, clean data ----------

test('scrubs nested objects and arrays, reports path locations', () => {
  const { sanitised, locations } = sanitiseAiOutput({
    a: { b: ['clean text', 'banking details: 12345678'] },
  });
  assert.equal(sanitised.a.b[0], 'clean text');
  assert.equal(sanitised.a.b[1].includes('12345678'), false);
  assert.ok(locations.includes('a.b[1]'));
});

test('leaves clean claim data untouched', () => {
  const clean = {
    insured_name: 'Jane Mokoena',
    claimed_value: 12500,
    excess_amount: 0,
    third_party_involved: false,
    supplier_name: null,
    damage_description: 'Geyser burst, ceiling and carpets damaged. Plumber quote attached.',
  };
  const { sanitised, bankingDetected, redactionCount } = sanitiseAiOutput(clean);
  assert.deepEqual(sanitised, clean);
  assert.equal(bankingDetected, false);
  assert.equal(redactionCount, 0);
});

test('passes through primitives, null and undefined', () => {
  assert.equal(sanitiseAiOutput(42).sanitised, 42);
  assert.equal(sanitiseAiOutput(true).sanitised, true);
  assert.equal(sanitiseAiOutput(null).sanitised, null);
  assert.equal(sanitiseAiOutput(undefined).sanitised, undefined);
});

test('scrubbing is stable — second pass finds nothing new', () => {
  const first = sanitiseAiOutput({ note: 'Account number: 62012345678' });
  const second = sanitiseAiOutput(first.sanitised);
  assert.equal(second.bankingDetected, false);
  assert.deepEqual(second.sanitised, first.sanitised);
});
