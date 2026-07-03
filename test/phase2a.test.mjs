// =============================================================
// Phase 2A tests — CORS allowlisting, upload rate limiting,
// broker-email HTML escaping, portal audit IP capture.
// Run with: npm test  (node --test)
// =============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../suri-worker.js';
import { buildBrokerEmail } from '../suri-processor.js';

const stubCtx = () => {
  const calls = [];
  return { calls, waitUntil: (p) => { calls.push(p); } };
};

const PORTAL = 'https://claims.smartsure.example';
const baseEnv = { PORTAL_ORIGINS: `${PORTAL}, https://preview.smartsure.example` };

// ---------- CORS ----------

test('allowed origin is echoed with Vary: Origin', async () => {
  const req = new Request('https://worker.example/upload', {
    method: 'OPTIONS', headers: { Origin: PORTAL },
  });
  const res = await worker.fetch(req, baseEnv, stubCtx());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), PORTAL);
  assert.equal(res.headers.get('Vary'), 'Origin');
});

test('second allowlisted origin (comma-separated, with spaces) also works', async () => {
  const req = new Request('https://worker.example/upload', {
    method: 'OPTIONS', headers: { Origin: 'https://preview.smartsure.example' },
  });
  const res = await worker.fetch(req, baseEnv, stubCtx());
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://preview.smartsure.example');
});

test('disallowed origin gets NO Access-Control-Allow-Origin header', async () => {
  const req = new Request('https://worker.example/upload', {
    method: 'OPTIONS', headers: { Origin: 'https://evil.example' },
  });
  const res = await worker.fetch(req, baseEnv, stubCtx());
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(res.headers.get('Vary'), 'Origin', 'Vary must be set even on deny');
});

test('empty PORTAL_ORIGINS config allows no origin (no wildcard fallback)', async () => {
  const req = new Request('https://worker.example/upload', {
    method: 'OPTIONS', headers: { Origin: PORTAL },
  });
  const res = await worker.fetch(req, {}, stubCtx());
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

// ---------- Rate limiting ----------

test('rate limit exceeded returns 429 before any downstream work', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error('downstream work must not run when rate-limited'); };

  const limiterKeys = [];
  const env = {
    ...baseEnv,
    UPLOAD_RATE_LIMITER: { limit: async ({ key }) => { limiterKeys.push(key); return { success: false }; } },
  };
  const req = new Request('https://worker.example/upload', {
    method: 'POST',
    headers: { Origin: PORTAL, 'cf-connecting-ip': '203.0.113.9' },
    body: 'irrelevant',
  });
  const res = await worker.fetch(req, env, stubCtx());
  assert.equal(res.status, 429);
  assert.deepEqual(limiterKeys, ['203.0.113.9'], 'keyed by client IP');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), PORTAL, '429 still carries CORS for the portal');
});

test('missing rate-limit binding fails open', async () => {
  // No UPLOAD_RATE_LIMITER in env: request must proceed past the guard and
  // fail on the malformed multipart body instead (400, not 429).
  const req = new Request('https://worker.example/upload', {
    method: 'POST', headers: { Origin: PORTAL }, body: 'not-multipart',
  });
  const res = await worker.fetch(req, baseEnv, stubCtx());
  assert.equal(res.status, 400);
});

test('rate-limit binding errors fail open', async () => {
  const env = {
    ...baseEnv,
    UPLOAD_RATE_LIMITER: { limit: async () => { throw new Error('binding exploded'); } },
  };
  const req = new Request('https://worker.example/upload', {
    method: 'POST', headers: { Origin: PORTAL }, body: 'not-multipart',
  });
  const res = await worker.fetch(req, env, stubCtx());
  assert.equal(res.status, 400, 'proceeds to body parsing, not blocked');
});

// ---------- Broker email HTML escaping ----------

test('markup in extracted fields is escaped in the email body', () => {
  const { body } = buildBrokerEmail(
    { claim_ref: 'SS-2026-INF-00001', broker_name: '<b>Bad Broker</b>' },
    {
      extracted_fields: { insured_name: '<script>alert(1)</script>', policy_number: 'POL"1"<img src=x>' },
      classification: { peril_type: 'burst_geyser' },
    },
    { outstanding: [] },
    {}
  );
  assert.equal(body.includes('<script>'), false);
  assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(body.includes('<b>Bad Broker</b>'), false);
  assert.ok(body.includes('&lt;b&gt;Bad Broker&lt;/b&gt;'));
  assert.equal(body.includes('<img'), false);
  assert.ok(body.includes('Burst Geyser'), 'normal values still render');
});

test('normal names render unchanged and outstanding docs are escaped', () => {
  const { body } = buildBrokerEmail(
    { claim_ref: 'SS-2026-INF-00002', broker_name: 'Peter Broker' },
    { extracted_fields: { insured_name: 'Jane Mokoena' }, classification: {} },
    { outstanding: ['repair_quote'] },
    {}
  );
  assert.ok(body.includes('Jane Mokoena'));
  assert.ok(body.includes('Peter Broker'));
  assert.ok(body.includes('Repair / replacement quote'));
});

// ---------- Portal audit rows include IP (end-to-end upload) ----------

test('portal upload writes claim_received audit row with client IP', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const auditBodies = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const ok = (x) => new Response(JSON.stringify(x), { status: 200 });
    if (u.includes('challenges.cloudflare.com')) return ok({ success: true });
    if (u.includes('rpc/generate_claim_ref'))    return ok('SS-2026-INF-00042');
    if (u.includes('/rest/v1/claims'))           return ok([{ id: 'claim-1' }]);
    if (u.includes('/rest/v1/inbound_emails'))   return ok([{ id: 'email-1' }]);
    if (u.includes('/storage/v1/object/'))       return ok({});
    if (u.includes('/rest/v1/claim_documents'))  return ok([{ id: 'doc-1' }]);
    if (u.includes('/rest/v1/audit_log')) {
      auditBodies.push(JSON.parse(init.body));
      return ok([{ id: 'audit-1' }]);
    }
    throw new Error('unexpected fetch: ' + u);
  };

  const queueMessages = [];
  const env = {
    ...baseEnv,
    TURNSTILE_SECRET: 'ts-secret',
    SUPABASE_URL: 'http://sb.local',
    SUPABASE_SERVICE_KEY: 'k',
    SURI_QUEUE: { send: async (m) => { queueMessages.push(m); } },
    UPLOAD_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };

  const fd = new FormData();
  const fields = {
    submitter_role: 'broker', broker_name: 'Peter Broker', broker_email: 'peter@broker.example',
    insured_name: 'Jane Mokoena', policy_number: 'POL-1', insurer: 'infiniti',
    claim_type: 'non_motor', peril_type: 'burst_geyser', incident_date: '2026-06-20',
    cause_of_loss: 'Geyser burst', damage_description: 'Ceiling damaged',
    'cf-turnstile-response': 'token-1',
  };
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('documents', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'claim.pdf', { type: 'application/pdf' }));

  const ctx = stubCtx();
  const req = new Request('https://worker.example/upload', {
    method: 'POST',
    headers: { Origin: PORTAL, 'cf-connecting-ip': '203.0.113.9' },
    body: fd,
  });
  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 202);
  assert.equal((await res.json()).claim_ref, 'SS-2026-INF-00042');

  const received = auditBodies.find(b => b.action === 'claim_received');
  assert.ok(received, 'claim_received audit row written');
  assert.equal(received.ip_address, '203.0.113.9');

  await Promise.allSettled(ctx.calls);
  assert.equal(queueMessages.length, 1, 'claim queued for processing');
  assert.equal(queueMessages[0].claim_id, 'claim-1');
});
