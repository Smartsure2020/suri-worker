// =============================================================
// Microsoft Graph webhook intake tests.
//  - validation handshake arrives as POST with validationToken
//  - clientState is verified per notification body item
//  - message-id dedupe remains intact
// Run with: npm test  (node --test)
// =============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { filterAuthorisedNotifications, processEmailNotification } from '../suri-worker.js';

const stubCtx = () => {
  const calls = [];
  return { calls, waitUntil: (p) => { calls.push(p); } };
};

// ---------- Validation handshake ----------

test('Graph validation POST echoes validationToken as text/plain', async () => {
  const req = new Request('https://worker.example/webhooks/email?validationToken=tok-abc-123', {
    method: 'POST',
  });
  const res = await worker.fetch(req, {}, stubCtx());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'text/plain');
  assert.equal(await res.text(), 'tok-abc-123');
});

test('Graph validation GET still echoes validationToken', async () => {
  const req = new Request('https://worker.example/webhooks/email?validationToken=tok-get', {
    method: 'GET',
  });
  const res = await worker.fetch(req, {}, stubCtx());
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'tok-get');
});

// ---------- clientState per notification item ----------

test('filterAuthorisedNotifications accepts only matching clientState', () => {
  const { valid, rejectedCount } = filterAuthorisedNotifications(
    [
      { clientState: 'secret', resourceData: { id: 'm1' } },
      { clientState: 'WRONG',  resourceData: { id: 'm2' } },
      { resourceData: { id: 'm3' } }, // missing clientState
    ],
    'secret'
  );
  assert.equal(valid.length, 1);
  assert.equal(valid[0].resourceData.id, 'm1');
  assert.equal(rejectedCount, 2);
});

test('filterAuthorisedNotifications fails closed without a configured secret', () => {
  const { valid, rejectedCount } = filterAuthorisedNotifications(
    [{ clientState: 'anything', resourceData: { id: 'm1' } }],
    undefined
  );
  assert.equal(valid.length, 0);
  assert.equal(rejectedCount, 1);
});

test('webhook POST with only invalid clientState processes nothing', async () => {
  const ctx = stubCtx();
  const req = new Request('https://worker.example/webhooks/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: [{ clientState: 'WRONG', resourceData: { id: 'm1' } }] }),
  });
  const res = await worker.fetch(req, { M365_WEBHOOK_SECRET: 'secret' }, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'no_notifications' });
  assert.equal(ctx.calls.length, 0, 'no background processing should be scheduled');
});

test('webhook POST with valid clientState is accepted (202)', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  // Dedupe query returns an existing row so processing stops immediately.
  globalThis.fetch = async () => new Response(JSON.stringify([{ id: 'existing' }]), { status: 200 });

  const ctx = stubCtx();
  const req = new Request('https://worker.example/webhooks/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: [{ clientState: 'secret', resourceData: { id: 'm1' } }] }),
  });
  const res = await worker.fetch(
    req,
    { M365_WEBHOOK_SECRET: 'secret', SUPABASE_URL: 'http://sb.local', SUPABASE_SERVICE_KEY: 'k' },
    ctx
  );
  assert.equal(res.status, 202);
  assert.equal(ctx.calls.length, 1, 'background processing scheduled');
  await ctx.calls[0]; // let the scheduled work settle under the stub
});

// ---------- Message-id dedupe ----------

test('processEmailNotification skips already-ingested message ids', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify([{ id: 'already-there' }]), { status: 200 });
  };

  await processEmailNotification(
    { clientState: 'secret', resourceData: { id: 'MSG-DUP-1' } },
    { SUPABASE_URL: 'http://sb.local', SUPABASE_SERVICE_KEY: 'k' }
  );

  assert.equal(requests.length, 1, 'only the dedupe lookup should run');
  assert.ok(requests[0].includes('inbound_emails'));
  assert.ok(requests[0].includes('message_id=eq.MSG-DUP-1'));
  assert.equal(requests.some(u => u.includes('login.microsoftonline.com')), false,
    'Graph must not be called for duplicate messages');
});
