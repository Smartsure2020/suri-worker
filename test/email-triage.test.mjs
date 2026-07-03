// =============================================================
// Phase C1 — email triage module unit tests.
// Run with: npm test  (node --test)
// =============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractClaimRef, isAutoReply, parseReferencedMessageIds,
  emailBodyText, classifyEmail, parseTriageJson, TRIAGE_MODEL,
} from '../email-triage.js';

const ok = (x) => new Response(JSON.stringify(x), { status: 200 });
const anthropicReply = (obj) => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  stop_reason: 'end_turn',
});

// ---------- Deterministic helpers ----------

test('extractClaimRef finds refs case-insensitively and normalises', () => {
  assert.equal(extractClaimRef('RE: ss-2026-inf-00042 more docs'), 'SS-2026-INF-00042');
  assert.equal(extractClaimRef('Claim SS-2026-HOU-00007 attached'), 'SS-2026-HOU-00007');
  assert.equal(extractClaimRef('no reference here'), null);
  assert.equal(extractClaimRef('SS-26-INF-42 malformed'), null);
});

test('isAutoReply detects standard auto-reply signals', () => {
  const withHeader = (name, value) => ({ subject: 'hi', internetMessageHeaders: [{ name, value }] });
  assert.equal(isAutoReply(withHeader('Auto-Submitted', 'auto-replied')), true);
  assert.equal(isAutoReply(withHeader('Auto-Submitted', 'no')), false);
  assert.equal(isAutoReply(withHeader('X-Auto-Response-Suppress', 'All')), true);
  assert.equal(isAutoReply(withHeader('Precedence', 'bulk')), true);
  assert.equal(isAutoReply({ subject: 'Automatic reply: Storm claim', internetMessageHeaders: [] }), true);
  assert.equal(isAutoReply({ subject: 'Out of office', internetMessageHeaders: [] }), true);
  assert.equal(isAutoReply({ subject: 'New storm claim - Mokoena', internetMessageHeaders: [] }), false);
});

test('parseReferencedMessageIds collects and dedupes In-Reply-To + References', () => {
  const email = {
    internetMessageHeaders: [
      { name: 'In-Reply-To', value: '<a@x.example>' },
      { name: 'References', value: '<a@x.example> <b@x.example>' },
    ],
  };
  assert.deepEqual(parseReferencedMessageIds(email), ['<a@x.example>', '<b@x.example>']);
  assert.deepEqual(parseReferencedMessageIds({ internetMessageHeaders: [] }), []);
});

test('emailBodyText strips HTML and truncates', () => {
  const email = {
    body: { contentType: 'html', content: '<p>Geyser <b>burst</b></p><style>p{}</style>&nbsp;flooded' },
  };
  const text = emailBodyText(email);
  assert.ok(text.includes('Geyser burst'));
  assert.equal(text.includes('<'), false);
});

// ---------- AI triage: scrubbing and fail-safe behaviour ----------

test('triage output is scrubbed before it is returned', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ok(anthropicReply({
    classification: 'follow_up', confidence: 0.9,
    claim_ref: null, policy_number: 'POL-1',
    insured_name: 'J Smith', incident_date: '2026-06-20',
    escalation_flags: [],
    account_number: '62012345678', // forbidden key — must be dropped
    reason: 'mentions account number 62012345678 for payment',
  }));

  const result = await classifyEmail(
    { subject: 's', body: { contentType: 'text', content: 'b' }, from: { emailAddress: { address: 'a@b.c' } } },
    { ANTHROPIC_API_KEY: 'k' }
  );
  assert.equal(result.classification, 'follow_up');
  assert.equal('account_number' in result, false, 'forbidden keys never survive');
  assert.equal(JSON.stringify(result).includes('62012345678'), false, 'banking digits never survive');
});

test('invalid triage JSON falls back to uncertain without leaking model text', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ok({
    content: [{ type: 'text', text: 'Bank details: FNB 123456789 — not JSON' }],
    stop_reason: 'end_turn',
  });
  const result = await classifyEmail(
    { subject: 's', body: { contentType: 'text', content: 'b' } },
    { ANTHROPIC_API_KEY: 'k' }
  );
  assert.equal(result.classification, 'uncertain');
  assert.equal(result.confidence, 0);
  assert.equal(result.reason, 'triage_invalid_json');
});

test('parseTriageJson never returns non-objects and never throws', () => {
  assert.equal(parseTriageJson('FNB account 12345 not json'), null);
  assert.equal(parseTriageJson('"just a string"'), null);
  assert.deepEqual(parseTriageJson('```json\n{"classification":"not_claim"}\n```'), { classification: 'not_claim' });
});

test('triage API errors and missing key fail safe to uncertain', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let fetchCount = 0;
  globalThis.fetch = async () => { fetchCount++; return new Response('err', { status: 500 }); };
  const apiErr = await classifyEmail({ subject: 's', body: {} }, { ANTHROPIC_API_KEY: 'k' });
  assert.equal(apiErr.classification, 'uncertain');
  assert.equal(apiErr.reason, 'triage_api_error_500');

  const noKey = await classifyEmail({ subject: 's', body: {} }, {});
  assert.equal(noKey.classification, 'uncertain');
  assert.equal(noKey.reason, 'triage_unavailable_no_api_key');
  assert.equal(fetchCount, 1, 'no API call attempted without a key');
});

test('unknown classification values and junk fields are normalised', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ok(anthropicReply({
    classification: 'approve_the_claim', confidence: 7,
    escalation_flags: ['complaint_or_escalation_language', 'made_up_flag'],
    incident_date: 'yesterday',
    claim_ref: 'SS-2026-INF-00042 (probably)',
    reason: 'x'.repeat(500),
  }));
  const result = await classifyEmail({ subject: 's', body: {} }, { ANTHROPIC_API_KEY: 'k' });
  assert.equal(result.classification, 'uncertain', 'unknown class collapses to uncertain');
  assert.equal(result.confidence, 1, 'confidence clamped to [0,1]');
  assert.deepEqual(result.escalation_flags, ['complaint_or_escalation_language']);
  assert.equal(result.incident_date, null);
  assert.equal(result.claim_ref, 'SS-2026-INF-00042', 'ref extracted via strict pattern');
  assert.equal(result.reason.length <= 200, true);
  assert.equal(result.model, TRIAGE_MODEL);
});
