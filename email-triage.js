// =============================================================
// Suri — email-triage.js
// Stage 1 (deterministic) helpers + Stage 2 (AI) email triage.
//
// Triage is routing intelligence ONLY — it never makes claims
// decisions, and its output is banking-scrubbed before storage.
// Raw model output is never stored or logged (same rule as the
// main processor — see BOUNDARY.md).
//
// Uses a cheap/fast Haiku-class model: this runs on every inbound
// email. The deep Opus extraction pipeline is untouched.
// =============================================================

import { sanitiseAiOutput } from './banking-scrubber.js';

export const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';
export const TRIAGE_PROMPT_VERSION = 'triage-v1';

export const TRIAGE_CLASSES = ['new_claim', 'follow_up', 'status_query', 'not_claim', 'uncertain'];
export const ESCALATION_FLAGS = [
  'complaint_or_escalation_language',
  'repudiation_coverage_liability_wording',
  'sensitive_or_unusual_documents',
];

const CLAIM_REF_PATTERN = /\bSS-\d{4}-[A-Z]{3}-\d{5}\b/i;

// =============================================================
// STAGE 1 — deterministic helpers (pure, no network)
// =============================================================

export function extractClaimRef(text) {
  const match = String(text || '').match(CLAIM_REF_PATTERN);
  return match ? match[0].toUpperCase() : null;
}

// Auto-reply / bounce / bulk suppression. Conservative: only well-known,
// safe indicators — a wrongly-suppressed real claim email is worse than a
// processed auto-reply (which triage would classify not_claim anyway).
export function isAutoReply(email) {
  const headers = {};
  for (const h of email?.internetMessageHeaders || []) {
    if (h?.name) headers[h.name.toLowerCase()] = String(h.value || '').toLowerCase();
  }
  if (headers['auto-submitted'] && headers['auto-submitted'] !== 'no') return true;
  if (headers['x-auto-response-suppress']) return true;
  if (headers['x-autoreply'] === 'yes' || headers['x-autorespond']) return true;
  if (headers['precedence'] === 'auto_reply' || headers['precedence'] === 'bulk') return true;
  if (headers['return-path'] === '<>') return true;
  const subject = String(email?.subject || '').toLowerCase();
  if (/^(automatic reply|auto(matic)?[ -]?reply|out of office|undeliverable|delivery status notification)/.test(subject)) return true;
  return false;
}

// RFC message ids referenced by this email (In-Reply-To + References),
// used to match replies to stored inbound_emails.internet_message_id.
export function parseReferencedMessageIds(email) {
  const ids = [];
  for (const h of email?.internetMessageHeaders || []) {
    const name = (h?.name || '').toLowerCase();
    if (name === 'in-reply-to' || name === 'references') {
      for (const m of String(h.value || '').match(/<[^<>\s]+>/g) || []) {
        if (!ids.includes(m)) ids.push(m);
      }
    }
  }
  return ids;
}

// Plain text from the email body (HTML crudely stripped, truncated for the
// triage prompt). Not used for storage — storage keeps the scrubbed original.
export function emailBodyText(email, maxChars = 3500) {
  const content = email?.body?.content || '';
  let text = content;
  if ((email?.body?.contentType || '').toLowerCase() === 'html') {
    text = content
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

// =============================================================
// STAGE 2 — AI triage call
// =============================================================

const TRIAGE_SYSTEM_PROMPT = `You are the email triage assistant for Suri, the claims intake system of Smartsure Twenty20, a South African short-term insurance administrator. You classify inbound emails to the newclaims mailbox. You do NOT make claims decisions.

SURI DOES NOT PROCESS PAYMENTS. Never repeat, transcribe, or include banking, account, branch, IBAN, SWIFT, beneficiary, or payment details in any field of your output.

Classify the email as exactly one of:
- "new_claim": reports a NEW incident/loss to be registered (no existing claim reference).
- "follow_up": supplies documents or information for an EXISTING claim.
- "status_query": asks about progress of an existing claim without new documents.
- "not_claim": marketing, spam, newsletters, supplier admin, or otherwise unrelated to a claim.
- "uncertain": you cannot tell with reasonable confidence.

Respond with ONLY a valid JSON object, no markdown fences:
{
  "classification": "new_claim" | "follow_up" | "status_query" | "not_claim" | "uncertain",
  "confidence": number,            // 0..1
  "claim_ref": string | null,      // e.g. "SS-2026-INF-00042" ONLY if visible
  "policy_number": string | null,  // ONLY if visible verbatim
  "insured_name": string | null,
  "incident_date": "YYYY-MM-DD" | null,
  "escalation_flags": string[],    // any of: "complaint_or_escalation_language", "repudiation_coverage_liability_wording", "sensitive_or_unusual_documents"
  "reason": string                 // max 20 words, no personal data, no banking details
}`;

/**
 * Classifies one email. NEVER throws — on any failure it returns an
 * 'uncertain' result so the email escalates to human review instead of
 * being dropped or misfiled.
 */
export async function classifyEmail(email, env) {
  const fallback = (why) => ({
    classification: 'uncertain', confidence: 0,
    claim_ref: null, policy_number: null, insured_name: null, incident_date: null,
    escalation_flags: [], reason: why, model: TRIAGE_MODEL,
  });

  if (!env?.ANTHROPIC_API_KEY) return fallback('triage_unavailable_no_api_key');

  const attachmentNames = (email.attachmentNames || []).slice(0, 20).join(', ');
  const userPrompt = `From: ${email.from?.emailAddress?.address || 'unknown'}
Subject: ${email.subject || '(no subject)'}
Attachments: ${attachmentNames || '(none listed)'}

Body:
${emailBodyText(email)}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: TRIAGE_MODEL,
        max_tokens: 500,
        system: TRIAGE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) return fallback(`triage_api_error_${res.status}`);

    const response = await res.json();
    if (response.stop_reason === 'max_tokens') return fallback('triage_truncated');
    const text = response.content?.find(b => b.type === 'text')?.text;
    if (!text) return fallback('triage_empty_response');

    const parsed = parseTriageJson(text);
    if (!parsed) return fallback('triage_invalid_json');

    // BANKING BOUNDARY: scrub before anything touches the result.
    const { sanitised } = sanitiseAiOutput(parsed);
    return normaliseTriage(sanitised);
  } catch (err) {
    console.error('Triage call failed:', err.message);
    return fallback('triage_call_failed');
  }
}

// Parses model JSON without ever placing raw model text into errors or
// logs (JSON.parse messages quote the input on modern V8 — withheld).
export function parseTriageJson(text) {
  const clean = String(text).replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try {
    const obj = JSON.parse(clean);
    return typeof obj === 'object' && obj !== null ? obj : null;
  } catch {
    console.warn(`Triage output not valid JSON (${clean.length} chars). Raw output withheld from logs (banking boundary).`);
    return null;
  }
}

function normaliseTriage(raw) {
  const classification = TRIAGE_CLASSES.includes(raw.classification) ? raw.classification : 'uncertain';
  const confidence = typeof raw.confidence === 'number'
    ? Math.min(1, Math.max(0, raw.confidence)) : 0;
  const flags = Array.isArray(raw.escalation_flags)
    ? raw.escalation_flags.filter(f => ESCALATION_FLAGS.includes(f)) : [];
  const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  return {
    classification,
    confidence,
    claim_ref: extractClaimRef(str(raw.claim_ref) || ''),
    policy_number: str(raw.policy_number, 60),
    insured_name: str(raw.insured_name, 120),
    incident_date: /^\d{4}-\d{2}-\d{2}$/.test(raw.incident_date || '') ? raw.incident_date : null,
    escalation_flags: flags,
    reason: str(raw.reason, 200) || 'no reason given',
    model: TRIAGE_MODEL,
  };
}
