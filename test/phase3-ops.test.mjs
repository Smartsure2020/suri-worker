// =============================================================
// Phase 3 — operational readiness tests: health endpoint safety,
// admin diagnostics protection, M365 renewal success/failure.
// Run with: npm test  (node --test)
// =============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../suri-worker.js';
import { renewM365Subscription } from '../m365-renewal.js';

const stubCtx = () => ({ waitUntil() {} });
const ok = (x) => new Response(JSON.stringify(x), { status: 200 });

const FULL_ENV = {
  SUPABASE_URL: 'http://sb.local', SUPABASE_SERVICE_KEY: 'sb-secret-value',
  TURNSTILE_SECRET: 'ts-secret-value', M365_WEBHOOK_SECRET: 'ws-secret-value',
  AZURE_TENANT_ID: 'tenant-1', AZURE_CLIENT_ID: 'client-1',
  AZURE_CLIENT_SECRET: 'azure-secret-value', SURI_MAILBOX: 'claims@smartsure.example',
  SURI_QUEUE: { send: async () => {} },
  WORKER_PUBLIC_URL: 'https://suri-worker.example',
};

// ---------- /health ----------

test('healthy worker returns ok with checks and no secret values', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('system_constants?select=key')) return ok([{ key: 'x' }]);
    if (u.includes('M365_SUBSCRIPTION_STATE')) {
      return ok([{ value: { id: 'sub-1', expiration: new Date(Date.now() + 2 * 86400e3).toISOString() } }]);
    }
    throw new Error('unexpected fetch: ' + u);
  };

  const res = await worker.fetch(new Request('https://w.example/health'), FULL_ENV, stubCtx());
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.status, 'ok');
  assert.equal(body.checks.supabase, 'ok');
  assert.equal(body.checks.env_config.status, 'ok');
  assert.equal(body.checks.m365_subscription.status, 'ok');
  assert.equal(body.checks.processor, 'unknown', 'unobservable checks must say unknown');
  // No secret VALUES anywhere in the response.
  for (const secret of ['sb-secret-value', 'ts-secret-value', 'ws-secret-value', 'azure-secret-value']) {
    assert.equal(text.includes(secret), false, `health response leaked ${secret}`);
  }
});

test('degraded worker returns 503 and names (only) of missing vars', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error('db down'); };

  const env = { ...FULL_ENV, TURNSTILE_SECRET: undefined, SUPABASE_SERVICE_KEY: undefined };
  const res = await worker.fetch(new Request('https://w.example/health'), env, stubCtx());
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, 'degraded');
  assert.equal(body.checks.supabase, 'fail');
  assert.deepEqual(
    [...body.checks.env_config.missing].sort(),
    ['SUPABASE_SERVICE_KEY', 'TURNSTILE_SECRET']
  );
});

test('expired M365 subscription state is reported', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('system_constants?select=key')) return ok([{ key: 'x' }]);
    if (u.includes('M365_SUBSCRIPTION_STATE')) {
      return ok([{ value: { id: 'sub-1', expiration: new Date(Date.now() - 3600e3).toISOString() } }]);
    }
    throw new Error('unexpected fetch: ' + u);
  };
  const res = await worker.fetch(new Request('https://w.example/health'), FULL_ENV, stubCtx());
  const body = await res.json();
  assert.equal(body.checks.m365_subscription.status, 'expired');
});

// ---------- /admin/diagnostics ----------

test('diagnostics is 404 when no admin secret is configured', async () => {
  const res = await worker.fetch(
    new Request('https://w.example/admin/diagnostics'), FULL_ENV, stubCtx()
  );
  assert.equal(res.status, 404);
});

test('diagnostics rejects wrong key with 401 and touches nothing', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error('must not query the database on auth failure'); };

  const env = { ...FULL_ENV, ADMIN_DIAGNOSTICS_SECRET: 'admin-secret-1' };
  const res = await worker.fetch(
    new Request('https://w.example/admin/diagnostics', { headers: { 'x-suri-admin-key': 'wrong' } }),
    env, stubCtx()
  );
  assert.equal(res.status, 401);
});

test('diagnostics returns counts/refs only with the correct key', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('status=eq.processing')) return ok([{ claim_ref: 'SS-2026-INF-00001', updated_at: '2026-07-01T10:00:00Z' }]);
    if (u.includes('status=eq.error'))      return ok([]);
    if (u.includes('ai_processing_failed')) return ok([{ claim_id: 'c1', created_at: '2026-07-02T08:00:00Z' }]);
    if (u.includes('banking_details_redacted')) return ok([{ created_at: '2026-07-02T09:00:00Z' }]);
    throw new Error('unexpected fetch: ' + u);
  };

  const env = { ...FULL_ENV, ADMIN_DIAGNOSTICS_SECRET: 'admin-secret-1' };
  const res = await worker.fetch(
    new Request('https://w.example/admin/diagnostics', { headers: { 'x-suri-admin-key': 'admin-secret-1' } }),
    env, stubCtx()
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.stuck_processing.count, 1);
  assert.equal(body.error_claims.count, 0);
  assert.equal(body.ai_processing_failures_7d.count, 1);
  assert.equal(body.banking_redactions.last_7_days, 1);
  // No sensitive fields in the payload — refs and timestamps only.
  for (const forbidden of ['insured_name', 'policy_number', 'broker_email', 'extracted_fields', 'body_html']) {
    assert.equal(text.includes(forbidden), false, `diagnostics leaked field ${forbidden}`);
  }
});

// ---------- M365 renewal ----------

const GRAPH_TOKEN = 'graph-token-SENTINEL-never-log';

function renewalEnv() {
  return {
    AZURE_TENANT_ID: 't1', AZURE_CLIENT_ID: 'c1', AZURE_CLIENT_SECRET: 'azsec',
    M365_WEBHOOK_SECRET: 'ws1', SURI_MAILBOX: 'claims@smartsure.example',
    SUPABASE_URL: 'http://sb.local', SUPABASE_SERVICE_KEY: 'k',
    WORKER_PUBLIC_URL: 'https://suri-worker.example',
  };
}

test('renewal succeeds for a stored subscription and never logs the token', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const supabaseBodies = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('login.microsoftonline.com')) return ok({ access_token: GRAPH_TOKEN });
    if (u.includes('system_constants?key=eq.M365_SUBSCRIPTION_STATE')) {
      return ok([{ value: { id: 'sub-42', expiration: '2026-07-04T00:00:00Z' } }]);
    }
    if (u.includes('graph.microsoft.com/v1.0/subscriptions/sub-42')) {
      assert.equal(init.method, 'PATCH');
      return ok({ id: 'sub-42' });
    }
    if (u.includes('sb.local')) { supabaseBodies.push(String(init.body || '')); return ok([{}]); }
    throw new Error('unexpected fetch: ' + u);
  };

  const result = await renewM365Subscription(renewalEnv());
  assert.equal(result.status, 'renewed');
  assert.equal(result.id, 'sub-42');
  const persisted = supabaseBodies.join('|');
  assert.ok(persisted.includes('m365_subscription_renewed'), 'renewal audited');
  assert.equal(persisted.includes(GRAPH_TOKEN), false, 'token must never reach the database');
});

test('renewal failure (Graph 500) is audited as m365_renewal_failed', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const supabaseBodies = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('login.microsoftonline.com')) return ok({ access_token: GRAPH_TOKEN });
    if (u.includes('system_constants?key=eq.M365_SUBSCRIPTION_STATE')) {
      return ok([{ value: { id: 'sub-42', expiration: 'x' } }]);
    }
    if (u.includes('graph.microsoft.com/v1.0/subscriptions/sub-42')) {
      return new Response('server error', { status: 500 });
    }
    if (u.includes('sb.local')) { supabaseBodies.push(String(init.body || '')); return ok([{}]); }
    throw new Error('unexpected fetch: ' + u);
  };

  const result = await renewM365Subscription(renewalEnv());
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'graph_renew_500');
  assert.ok(supabaseBodies.join('|').includes('m365_renewal_failed'));
});

test('lapsed subscription (404) is recreated and the new id persisted', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const supabaseBodies = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('login.microsoftonline.com')) return ok({ access_token: GRAPH_TOKEN });
    if (u.includes('system_constants?key=eq.M365_SUBSCRIPTION_STATE')) {
      return ok([{ value: { id: 'sub-old', expiration: 'x' } }]);
    }
    if (u.includes('subscriptions/sub-old')) return new Response('gone', { status: 404 });
    if (u.endsWith('graph.microsoft.com/v1.0/subscriptions') && init.method === 'POST') {
      const req = JSON.parse(init.body);
      assert.equal(req.notificationUrl, 'https://suri-worker.example/webhooks/email');
      return ok({ id: 'sub-new', expirationDateTime: '2026-07-06T00:00:00Z' });
    }
    if (u.includes('sb.local')) { supabaseBodies.push(String(init.body || '')); return ok([{}]); }
    throw new Error('unexpected fetch: ' + u);
  };

  const result = await renewM365Subscription(renewalEnv());
  assert.equal(result.status, 'created');
  assert.equal(result.id, 'sub-new');
  const persisted = supabaseBodies.join('|');
  assert.ok(persisted.includes('sub-new'), 'new subscription id persisted');
  assert.ok(persisted.includes('m365_subscription_created'));
});

test('missing config fails visibly without calling Microsoft', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const urls = [];
  globalThis.fetch = async (url, init = {}) => {
    urls.push(String(url));
    return ok([{}]);
  };

  const env = renewalEnv();
  delete env.AZURE_CLIENT_SECRET;
  delete env.SURI_MAILBOX;
  const result = await renewM365Subscription(env);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'missing_config');
  assert.deepEqual([...result.missing].sort(), ['AZURE_CLIENT_SECRET', 'SURI_MAILBOX']);
  assert.equal(urls.some(u => u.includes('microsoftonline') || u.includes('graph.microsoft')), false,
    'no Microsoft calls without full config');
  assert.ok(urls.some(u => u.includes('audit_log')), 'failure audited');
});
