// =============================================================
// Phase 2B — portal upload idempotency tests.
// Run with: npm test  (node --test)
// =============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../suri-worker.js';

const PORTAL = 'https://claims.smartsure.example';
const IDEM_KEY = 'a1b2c3d4-0000-4000-8000-1234567890ab';

const ok = (x) => new Response(JSON.stringify(x), { status: 200 });

function makeFormData(extra = {}) {
  const fd = new FormData();
  const fields = {
    submitter_role: 'broker', broker_name: 'Peter Broker', broker_email: 'peter@broker.example',
    insured_name: 'Jane Mokoena', policy_number: 'POL-1', insurer: 'infiniti',
    claim_type: 'non_motor', peril_type: 'burst_geyser', incident_date: '2026-06-20',
    cause_of_loss: 'Geyser burst', damage_description: 'Ceiling damaged',
    'cf-turnstile-response': 'token-1',
    ...extra,
  };
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('documents', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'claim.pdf', { type: 'application/pdf' }));
  return fd;
}

function makeEnv(queueMessages) {
  return {
    PORTAL_ORIGINS: PORTAL,
    TURNSTILE_SECRET: 'ts-secret',
    SUPABASE_URL: 'http://sb.local',
    SUPABASE_SERVICE_KEY: 'k',
    SURI_QUEUE: { send: async (m) => { queueMessages.push(m); } },
  };
}

function makeRequest(fd) {
  return new Request('https://worker.example/upload', {
    method: 'POST',
    headers: { Origin: PORTAL, 'cf-connecting-ip': '203.0.113.9' },
    body: fd,
  });
}

const stubCtx = () => {
  const calls = [];
  return { calls, waitUntil: (p) => { calls.push(p); } };
};

// ---------- Duplicate returns existing claim, enqueues nothing ----------

test('duplicate upload returns the existing claim ref and does not queue', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const urls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('challenges.cloudflare.com')) return ok({ success: true });
    if (u.includes('submission_idempotency_key=eq.')) {
      return ok([{ id: 'claim-1', claim_ref: 'SS-2026-INF-00042' }]);
    }
    throw new Error('unexpected fetch: ' + u);
  };

  const queueMessages = [];
  const ctx = stubCtx();
  const res = await worker.fetch(
    makeRequest(makeFormData({ submission_idempotency_key: IDEM_KEY })),
    makeEnv(queueMessages), ctx
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.duplicate, true);
  assert.equal(body.claim_ref, 'SS-2026-INF-00042');
  assert.equal(queueMessages.length, 0, 'no second processing job');
  assert.equal(ctx.calls.length, 0, 'nothing scheduled');
  assert.equal(urls.some(u => u.includes('rpc/generate_claim_ref')), false, 'no new claim ref consumed');
  assert.equal(urls.some(u => u.includes('/storage/')), false, 'no documents uploaded');
});

// ---------- First submission stores the key, excludes it from payload ----------

test('first upload stores the key on the claim but not in submission_payload', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let claimInsertBody = null;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('challenges.cloudflare.com')) return ok({ success: true });
    if (u.includes('submission_idempotency_key=eq.')) return ok([]); // no duplicate yet
    if (u.includes('rpc/generate_claim_ref')) return ok('SS-2026-INF-00043');
    if (u.includes('/rest/v1/claims')) {
      claimInsertBody = JSON.parse(init.body);
      return ok([{ id: 'claim-2' }]);
    }
    if (u.includes('/rest/v1/inbound_emails'))  return ok([{ id: 'email-1' }]);
    if (u.includes('/storage/v1/object/'))      return ok({});
    if (u.includes('/rest/v1/claim_documents')) return ok([{ id: 'doc-1' }]);
    if (u.includes('/rest/v1/audit_log'))       return ok([{ id: 'audit-1' }]);
    throw new Error('unexpected fetch: ' + u);
  };

  const queueMessages = [];
  const ctx = stubCtx();
  const res = await worker.fetch(
    makeRequest(makeFormData({ submission_idempotency_key: IDEM_KEY })),
    makeEnv(queueMessages), ctx
  );

  assert.equal(res.status, 202);
  assert.equal(claimInsertBody.submission_idempotency_key, IDEM_KEY);
  assert.equal('submission_idempotency_key' in claimInsertBody.submission_payload, false,
    'key must be excluded from the stored payload');
  await Promise.allSettled(ctx.calls);
  assert.equal(queueMessages.length, 1, 'new claim queued exactly once');
});

// ---------- Unique-violation race falls back safely ----------

test('unique-constraint race returns the winner claim and does not queue', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let dupChecks = 0;
  const urls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    urls.push(u + '|' + (init.method || 'GET'));
    if (u.includes('challenges.cloudflare.com')) return ok({ success: true });
    if (u.includes('submission_idempotency_key=eq.')) {
      dupChecks++;
      // First check: no duplicate. After the failed insert: winner visible.
      return dupChecks === 1 ? ok([]) : ok([{ id: 'claim-9', claim_ref: 'SS-2026-INF-00099' }]);
    }
    if (u.includes('rpc/generate_claim_ref')) return ok('SS-2026-INF-00100');
    if (u.includes('/rest/v1/claims')) {
      return new Response(
        'duplicate key value violates unique constraint "idx_claims_idempotency_key" (23505)',
        { status: 409 }
      );
    }
    throw new Error('unexpected fetch: ' + u);
  };

  const queueMessages = [];
  const ctx = stubCtx();
  const res = await worker.fetch(
    makeRequest(makeFormData({ submission_idempotency_key: IDEM_KEY })),
    makeEnv(queueMessages), ctx
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.duplicate, true);
  assert.equal(body.claim_ref, 'SS-2026-INF-00099');
  assert.equal(queueMessages.length, 0, 'loser of the race must not queue');
  assert.equal(urls.some(u => u.includes('/storage/')), false, 'loser must not upload documents');
});

// ---------- Invalid keys are ignored, not stored ----------

test('malformed idempotency key is ignored and stored as null', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let claimInsertBody = null;
  const urls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('challenges.cloudflare.com')) return ok({ success: true });
    if (u.includes('rpc/generate_claim_ref'))    return ok('SS-2026-INF-00044');
    if (u.includes('/rest/v1/claims')) {
      claimInsertBody = JSON.parse(init.body);
      return ok([{ id: 'claim-3' }]);
    }
    if (u.includes('/rest/v1/inbound_emails'))  return ok([{ id: 'email-1' }]);
    if (u.includes('/storage/v1/object/'))      return ok({});
    if (u.includes('/rest/v1/claim_documents')) return ok([{ id: 'doc-1' }]);
    if (u.includes('/rest/v1/audit_log'))       return ok([{ id: 'audit-1' }]);
    throw new Error('unexpected fetch: ' + u);
  };

  const res = await worker.fetch(
    makeRequest(makeFormData({ submission_idempotency_key: 'bad key!! with spaces $$' })),
    makeEnv([]), stubCtx()
  );

  assert.equal(res.status, 202);
  assert.equal(claimInsertBody.submission_idempotency_key, null);
  assert.equal(urls.some(u => u.includes('submission_idempotency_key=eq.')), false,
    'no duplicate lookup for invalid keys');
});
