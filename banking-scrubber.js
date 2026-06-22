// =============================================================
// Suri — banking-scrubber.js
// Smartsure Twenty20
//
// Defensive safety guard: strips any banking, payment, or account
// details from AI output BEFORE storage, logging, or display.
//
// Suri does not process payments and does not store banking details.
// This module enforces that boundary at the application layer,
// independent of the Claude prompt's instructions to the model.
//
// Usage:
//   import { sanitiseAiOutput, safeLog } from './banking-scrubber.js';
//   const { sanitised, bankingDetected, locations } = sanitiseAiOutput(claudeJson);
// =============================================================

const REDACTION_MARKER = '[REDACTED — banking details not stored by Suri]';

// Forbidden field names. Any key whose normalised form matches (or contains)
// one of these is DROPPED — the value never reaches storage or logs.
const FORBIDDEN_FIELD_NAMES = new Set([
  'banking_details', 'bank_details', 'banking', 'bank_account',
  'account_number', 'accountnumber', 'account_no', 'accno', 'acc_no', 'acc_number',
  'branch_code', 'branchcode', 'branch_no', 'branch_number',
  'swift_code', 'swiftcode', 'swift', 'iban', 'iban_number',
  'routing_number', 'routingnumber',
  'account_holder', 'accountholder', 'account_name',
  'bank_name', 'bankname',
  'beneficiary', 'beneficiary_details', 'beneficiary_account', 'beneficiary_bank',
  'payment_details', 'payment_method', 'payment_account', 'payment_information',
  'supplier_bank', 'supplier_banking', 'supplier_bank_details', 'supplier_account',
  'payee', 'payee_details', 'payee_account',
  'eft_details', 'eft',
]);

// In-text banking keywords used for proximity-based detection inside string values.
const BANKING_KEYWORDS = [
  'account number', 'account no', 'acc no', 'a/c no',
  'branch code', 'branch no',
  'swift code', 'swift', 'iban',
  'routing number',
  'account holder', 'beneficiary',
  'banking details', 'bank details',
  'payment details', 'eft details',
];

// South African bank names — strong banking signal when near digit sequences.
const ZA_BANK_NAMES = [
  'fnb', 'first national bank',
  'absa',
  'standard bank',
  'nedbank',
  'capitec',
  'investec',
  'african bank',
  'bidvest bank',
  'tymebank', 'tyme bank',
  'discovery bank',
  'old mutual bank',
  'mercantile bank',
];

// =============================================================
// MAIN ENTRY POINT
// =============================================================

/**
 * Sanitises an object (typically parsed Claude output) by:
 *  1. Dropping any field whose normalised key matches FORBIDDEN_FIELD_NAMES.
 *  2. Redacting banking patterns inside string values.
 *
 * @param {*} obj  - Object, array, string, or primitive.
 * @returns {{ sanitised, bankingDetected, redactionCount, locations }}
 */
export function sanitiseAiOutput(obj) {
  const ctx = {
    bankingDetected: false,
    redactionCount: 0,
    locations: [],
  };
  const sanitised = scrubRecursive(obj, ctx, '');
  return {
    sanitised,
    bankingDetected: ctx.bankingDetected,
    redactionCount: ctx.redactionCount,
    locations: ctx.locations,
  };
}

function scrubRecursive(obj, ctx, path) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return scrubString(obj, ctx, path);
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item, i) => scrubRecursive(item, ctx, `${path}[${i}]`));
  }
  if (typeof obj !== 'object') return obj;

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const normalisedKey = key.toLowerCase().replace(/[\s-]/g, '_');
    if (isForbiddenField(normalisedKey)) {
      ctx.bankingDetected = true;
      ctx.redactionCount++;
      ctx.locations.push(`${path ? path + '.' : ''}${key} (field dropped)`);
      continue;
    }
    result[key] = scrubRecursive(value, ctx, path ? `${path}.${key}` : key);
  }
  return result;
}

function isForbiddenField(key) {
  if (FORBIDDEN_FIELD_NAMES.has(key)) return true;
  // Catch composite keys like supplier_bank_account_number
  for (const forbidden of FORBIDDEN_FIELD_NAMES) {
    if (key.includes(forbidden)) return true;
  }
  return false;
}

function scrubString(str, ctx, path) {
  if (!str || typeof str !== 'string') return str;
  let scrubbed = str;
  let hit = false;

  // Pattern 1: banking keyword followed by digit sequence
  for (const keyword of BANKING_KEYWORDS) {
    const escaped = keyword
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s*');
    const pattern = new RegExp(`(${escaped})[:\\s\\-]*([\\d\\s\\-]{4,30})`, 'gi');
    if (pattern.test(scrubbed)) {
      scrubbed = scrubbed.replace(pattern, REDACTION_MARKER);
      hit = true;
    }
  }

  // Pattern 2: ZA bank name with nearby digits (≤80 chars away)
  for (const bankName of ZA_BANK_NAMES) {
    const escaped = bankName.replace(/\s+/g, '\\s+');
    const pattern = new RegExp(`\\b${escaped}\\b[\\s\\S]{0,80}?[\\d\\-]{4,}`, 'gi');
    if (pattern.test(scrubbed)) {
      scrubbed = scrubbed.replace(pattern, REDACTION_MARKER);
      hit = true;
    }
  }

  // Pattern 3: IBAN format (2 letters + 2 digits + 4–30 alphanumeric)
  const ibanPattern = /\b[A-Z]{2}\d{2}[\dA-Z]{4,30}\b/g;
  if (ibanPattern.test(scrubbed)) {
    scrubbed = scrubbed.replace(ibanPattern, REDACTION_MARKER);
    hit = true;
  }

  if (hit) {
    ctx.bankingDetected = true;
    ctx.redactionCount++;
    ctx.locations.push(path || '(root string)');
  }
  return scrubbed;
}

// =============================================================
// SAFE LOGGING
// Use safeLog() in place of console.log() whenever logging
// objects that may contain AI output.
// =============================================================

export function safeLog(label, obj) {
  if (typeof obj === 'object' && obj !== null) {
    const { sanitised } = sanitiseAiOutput(obj);
    console.log(label, JSON.stringify(sanitised).slice(0, 1500));
  } else {
    console.log(label, obj);
  }
}

export { REDACTION_MARKER };
