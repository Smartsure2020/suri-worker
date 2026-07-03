// =============================================================
// Phase C1 — email routing integration tests (triageAndRouteEmail).
// Follow-ups must NEVER create claims; uncertain cases must escalate.
// Run with: npm test  (node --test)
// =============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triageAndRouteEmail } from '../suri-worker.js';

const ok = (x) => new Response(JSON.stringify(x), { status: 200 });
const anthropicReply = (obj) => ok({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  stop_reason: 'end_turn',
});

const PDF_ATTACHMENT = {
  name: 'quote.pdf', contentType: 'application/pdf', size: 100,
  contentBytes: Buffer.from('fake-pdf').toString('base64'),
};

function makeEmail(over = {}) {
  return {
    id: 'graph-msg-1',
    subject: 'Claim documents',
    from: { emailAddress: { address: 'broker@x.example' } },
    toRecipients: [{ emailAddress: { address: 'newclaims@smartsure.example' } }],
    body: { contentType: 'text', content: 'Please find attached.' },
    conversationId: null,
    internetMessageId: '<msg1@x.example>',
    internetMessageHeaders: [],
    receivedDateTime: '2026-07-03T08:00:00Z',
    ...over,
  };
}

function makeEnv(queueMessages = []) {
  return {
    SUPABASE_URL: 'http://sb.local', SUPABASE_SERVICE_KEY: 'k',
    ANTHROPIC_API_KEY: 'ak',
    AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's',
    SURI_MAILBOX: 'newclaims@smartsure.example', M365_WEBHOOK_SECRET: 'ws',
    SURI_QUEUE: { send: async (m) => { queueMessages.push(m); } },
  };
}

// Stub fetch router: overrides (checked first, in order) + safe defaults.
function installStub(t, overrides = {}) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    calls.push({ u, method, body: init.body ? String(init.body) : null });
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (u.includes(pattern)) return typeof handler === 'function' ? handler(u, init) : ok(handler);
    }
    if (u.includes('login.microsoftonline.com')) return ok({ access_token: 'graph-tok' });
    if (u.includes('graph.microsoft.com') && u.includes('/attachments')) return ok({ value: [] });
    if (u.includes('graph.microsoft.com') && method === 'PATCH') return ok({});
    if (u.includes('api.anthropic.com')) return anthropicReply({ classification: 'uncertain', confidence: 0, reason: 'default stub' });
    if (u.includes('system_constants')) return ok([]);
    if (u.includes('/rest/v1/inbound_emails') && method === 'POST') return ok([{ id: 'ie-1' }]);
    if (u.includes('/rest/v1/inbound_emails')) return ok([]);
    if (u.includes('/rest/v1/review_items')) return ok([{ id: 'ri-1' }]);
    if (u.includes('/rest/v1/audit_log')) return ok([{ id: 'a-1' }]);
    if (u.includes('/rest/v1/claims') && method === 'POST') return ok([{ id: 'c-new' }]);
    if (u.includes('/rest/v1/claims')) return ok([]);
    if (u.includes('/rest/v1/claim_documents')) return ok([{ id: 'd-1' }]);
    if (u.includes('/storage/')) return ok({});
    if (u.includes('rpc/generate_claim_ref')) return ok('SS-2026-INF-00777');
    throw new Error('unexpected fetch: ' + u);
  };
  return calls;
}

const claimsCreated = (calls) =>
  calls.filter(c => c.u.includes('/rest/v1/claims') && c.method === 'POST');
const reviewItems = (calls) =>
  calls.filter(c => c.u.includes('/rest/v1/review_items') && c.method === 'POST')
    .map(c => JSON.parse(c.body));
const audits = (calls) =>
  calls.filter(c => c.u.includes('/rest/v1/audit_log') && c.method === 'POST')
    .map(c => JSON.parse(c.body));
const categoryPatches = (calls) =>
  calls.filter(c => c.u.includes('graph.microsoft.com') && c.method === 'PATCH' && c.u.includes('/messages/'))
    .map(c => JSON.parse(c.body));
const anthropicCalls = (calls) => calls.filter(c => c.u.includes('api.anthropic.com'));

// ---------- Rung 1: claim ref in subject/body ----------

test('claim ref in subject attaches to existing claim — never a new claim', async (t) => {
  const calls = installStub(t, {
    'claims?claim_ref=eq.SS-2026-INF-00042': [{ id: 'c-42', claim_ref: 'SS-2026-INF-00042', status: 'pending_review' }],
    '/attachments': { value: [PDF_ATTACHMENT] },
  });
  const queue = [];
  const result = await triageAndRouteEmail(
    makeEmail({ subject: 'RE: SS-2026-INF-00042 — further documents' }), makeEnv(queue)
  );
  assert.equal(result.outcome, 'attached');
  assert.equal(result.method, 'claim_ref');
  assert.equal(claimsCreated(calls).length, 0, 'follow-up must not create a claim');
  assert.equal(anthropicCalls(calls).length, 0, 'deterministic match needs no AI');
  const emailInsert = JSON.parse(calls.find(c => c.u.includes('inbound_emails') && c.method === 'POST').body);
  assert.equal(emailInsert.claim_id, 'c-42');
  assert.equal(emailInsert.match_method, 'claim_ref');
  assert.deepEqual(queue, [{ type: 'process_claim', claim_id: 'c-42', source: 'email_followup' }]);
  assert.ok(audits(calls).some(a => a.action === 'followup_attached'));
  assert.ok(categoryPatches(calls).some(p => p.categories.includes('Suri/Attached')));
});

// ---------- Rung 2: conversation thread ----------

test('known conversationId attaches via thread match', async (t) => {
  const calls = installStub(t, {
    'inbound_emails?thread_id=eq.conv-9': [{ claim_id: 'c-9' }],
    'claims?id=eq.c-9': [{ id: 'c-9', claim_ref: 'SS-2026-INF-00009', status: 'pending_review' }],
  });
  const result = await triageAndRouteEmail(makeEmail({ conversationId: 'conv-9' }), makeEnv());
  assert.equal(result.outcome, 'attached');
  assert.equal(result.method, 'thread');
  assert.equal(claimsCreated(calls).length, 0);
  assert.equal(anthropicCalls(calls).length, 0);
});

// ---------- Rung 3: In-Reply-To / References headers ----------

test('In-Reply-To header pointing at a stored message attaches via reply_headers', async (t) => {
  const encoded = encodeURIComponent('<orig@x.example>');
  const calls = installStub(t, {
    [`internet_message_id=eq.${encoded}`]: [{ claim_id: 'c-7' }],
    'claims?id=eq.c-7': [{ id: 'c-7', claim_ref: 'SS-2026-INF-00007', status: 'pending_review' }],
  });
  const result = await triageAndRouteEmail(
    makeEmail({ internetMessageHeaders: [{ name: 'In-Reply-To', value: '<orig@x.example>' }] }),
    makeEnv()
  );
  assert.equal(result.outcome, 'attached');
  assert.equal(result.method, 'reply_headers');
  assert.equal(claimsCreated(calls).length, 0);
});

// ---------- Rung 4: sender + exact policy number ----------

test('sender + policy number matching exactly one open claim attaches', async (t) => {
  const calls = installStub(t, {
    'api.anthropic.com': () => anthropicReply({
      classification: 'follow_up', confidence: 0.9, policy_number: 'POL-77', reason: 'docs for existing claim',
    }),
    'policy_number=eq.POL-77': [{ id: 'c-77', claim_ref: 'SS-2026-INF-00077', status: 'pending_review' }],
  });
  const result = await triageAndRouteEmail(makeEmail(), makeEnv());
  assert.equal(result.outcome, 'attached');
  assert.equal(result.method, 'policy_sender');
  assert.equal(claimsCreated(calls).length, 0);
});

test('ambiguous policy match (2 claims) creates a review item, attaches nothing', async (t) => {
  const calls = installStub(t, {
    'api.anthropic.com': () => anthropicReply({
      classification: 'follow_up', confidence: 0.9, policy_number: 'POL-77', reason: 'docs',
    }),
    'policy_number=eq.POL-77': [
      { id: 'c-77', claim_ref: 'SS-2026-INF-00077', status: 'pending_review' },
      { id: 'c-78', claim_ref: 'SS-2026-INF-00078', status: 'pending_review' },
    ],
  });
  const result = await triageAndRouteEmail(makeEmail(), makeEnv());
  assert.equal(result.outcome, 'ambiguous_followup');
  assert.equal(claimsCreated(calls).length, 0);
  assert.equal(calls.some(c => c.u.includes('claim_documents')), false, 'no documents attached');
  const items = reviewItems(calls);
  assert.equal(items.length, 1);
  assert.ok(items[0].reasons.includes('ambiguous_followup_match'));
  assert.ok(items[0].notes.includes('SS-2026-INF-00077'));
});

// ---------- Fuzzy: AI-suggested match never auto-attaches ----------

test('AI-suggested claim ref becomes a suggestion on a review item, not an attach', async (t) => {
  const calls = installStub(t, {
    'api.anthropic.com': () => anthropicReply({
      classification: 'follow_up', confidence: 0.8,
      claim_ref: 'SS-2026-INF-00042', reason: 'ref visible on attached quote',
    }),
    'claims?claim_ref=eq.SS-2026-INF-00042': [{ id: 'c-42', claim_ref: 'SS-2026-INF-00042' }],
  });
  const result = await triageAndRouteEmail(makeEmail(), makeEnv());
  assert.equal(result.outcome, 'unmatched_followup');
  assert.equal(claimsCreated(calls).length, 0);
  assert.equal(calls.some(c => c.u.includes('claim_documents')), false);
  const items = reviewItems(calls);
  assert.equal(items[0].suggested_claim_id, 'c-42');
  assert.ok(items[0].reasons.includes('unmatched_followup'));
  const emailInsert = JSON.parse(calls.find(c => c.u.includes('inbound_emails') && c.method === 'POST').body);
  assert.equal(emailInsert.claim_id, undefined, 'stored unlinked');
});

// ---------- New claim path ----------

test('confident new_claim email still creates a claim normally', async (t) => {
  const calls = installStub(t, {
    'api.anthropic.com': () => anthropicReply({
      classification: 'new_claim', confidence: 0.92, reason: 'storm damage reported',
    }),
    '/attachments': { value: [PDF_ATTACHMENT] },
  });
  const queue = [];
  const result = await triageAndRouteEmail(
    makeEmail({ subject: 'New storm damage claim - Mokoena' }), makeEnv(queue)
  );
  assert.equal(result.outcome, 'new_claim');
  assert.equal(claimsCreated(calls).length, 1);
  assert.deepEqual(queue, [{ type: 'process_claim', claim_id: 'c-new', source: 'email' }]);
  assert.ok(categoryPatches(calls).some(p => p.categories.includes('Suri/New claim')));
  const emailInsert = JSON.parse(calls.find(c => c.u.includes('inbound_emails') && c.method === 'POST').body);
  assert.equal(emailInsert.triage_class, 'new_claim');
});

test('possible duplicate blocks claim creation and opens a review item', async (t) => {
  const calls = installStub(t, {
    'api.anthropic.com': () => anthropicReply({
      classification: 'new_claim', confidence: 0.9, policy_number: 'POL-9', reason: 'new claim',
    }),
    'policy_number=eq.POL-9': [{ id: 'c-1', claim_ref: 'SS-2026-INF-00001' }],
  });
  const result = await triageAndRouteEmail(makeEmail(), makeEnv());
  assert.equal(result.outcome, 'possible_duplicate');
  assert.equal(claimsCreated(calls).length, 0, 'no second claim');
  const items = reviewItems(calls);
  assert.ok(items[0].reasons.includes('possible_duplicate'));
  assert.equal(items[0].suggested_claim_id, 'c-1');
  assert.ok(audits(calls).some(a => a.action === 'possible_duplicate_flagged'));
});

test('low-confidence new_claim escalates instead of creating a claim', async (t) => {
  const calls = installStub(t, {
    'api.anthropic.com': () => anthropicReply({
      classification: 'new_claim', confidence: 0.4, reason: 'vague email',
    }),
  });
  const result = await triageAndRouteEmail(makeEmail(), makeEnv());
  assert.equal(result.outcome, 'escalated');
  assert.equal(claimsCreated(calls).length, 0);
  assert.ok(reviewItems(calls)[0].reasons.includes('low_triage_confidence'));
  assert.ok(categoryPatches(calls).some(p => p.categories.includes('Suri/Needs review')));
});

// ---------- Non-claim and auto-reply ----------

test('not_claim email creates nothing, is audited and categorised', async (t) => {
  const calls = installStub(t, {
    'api.anthropic.com': () => anthropicReply({
      classification: 'not_claim', confidence: 0.95, reason: 'marketing newsletter',
    }),
  });
  const result = await triageAndRouteEmail(makeEmail({ subject: 'Winter tyre special!' }), makeEnv());
  assert.equal(result.outcome, 'not_claim');
  assert.equal(claimsCreated(calls).length, 0);
  assert.equal(calls.some(c => c.u.includes('inbound_emails') && c.method === 'POST'), false, 'not stored');
  assert.ok(audits(calls).some(a => a.action === 'email_skipped_not_claim'));
  assert.ok(categoryPatches(calls).some(p => p.categories.includes('Suri/Not claim')));
});

test('auto-replies are suppressed before any AI or claim work', async (t) => {
  const calls = installStub(t, {});
  const result = await triageAndRouteEmail(
    makeEmail({ internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }),
    makeEnv()
  );
  assert.equal(result.outcome, 'auto_reply_suppressed');
  assert.equal(anthropicCalls(calls).length, 0);
  assert.equal(claimsCreated(calls).length, 0);
  assert.ok(audits(calls).some(a => a.action === 'auto_reply_suppressed'));
  assert.ok(categoryPatches(calls).some(p => p.categories.includes('Suri/Ignored auto-reply')));
});

// ---------- Quoted ref that does not exist ----------

test('quoted claim ref with no matching claim escalates as claim_ref_not_found', async (t) => {
  const calls = installStub(t, {
    'claims?claim_ref=eq.SS-2026-INF-99999': [],
  });
  const result = await triageAndRouteEmail(
    makeEmail({ subject: 'RE: SS-2026-INF-99999' }), makeEnv()
  );
  assert.equal(result.outcome, 'ref_not_found');
  assert.equal(claimsCreated(calls).length, 0);
  assert.ok(reviewItems(calls)[0].reasons.includes('claim_ref_not_found'));
});

// ---------- Banking boundary on stored follow-up ----------

test('banking details in a follow-up body are redacted and flagged, attach still works', async (t) => {
  const calls = installStub(t, {
    'claims?claim_ref=eq.SS-2026-INF-00042': [{ id: 'c-42', claim_ref: 'SS-2026-INF-00042', status: 'pending_review' }],
  });
  const result = await triageAndRouteEmail(
    makeEmail({
      subject: 'RE: SS-2026-INF-00042 supplier details',
      body: { contentType: 'text', content: 'Supplier banking details: FNB account number 62012345678, branch code 250655.' },
    }),
    makeEnv()
  );
  assert.equal(result.outcome, 'attached');
  const emailInsert = JSON.parse(calls.find(c => c.u.includes('inbound_emails') && c.method === 'POST').body);
  assert.equal(JSON.stringify(emailInsert).includes('62012345678'), false, 'banking digits never stored');
  assert.ok(audits(calls).some(a => a.action === 'banking_details_redacted'));
  const items = reviewItems(calls);
  assert.ok(items.some(i => i.reasons.includes('banking_details_detected')), 'informational review item');
});
