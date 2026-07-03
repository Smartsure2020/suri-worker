// =============================================================
// Suri — m365-renewal.js
// Automated Microsoft Graph webhook subscription renewal.
//
// Called from the worker's scheduled (cron) handler. Graph mail
// subscriptions live ~3 days max; this renews every cron run with
// a fresh ~2.5 day expiry, recreates the subscription if it has
// lapsed, and avoids duplicates by checking Graph's own list.
//
// Subscription state (id + expiration) is persisted in the existing
// system_constants table (key M365_SUBSCRIPTION_STATE) — no new
// schema needed, and updates are audited by the existing
// system_constants trigger.
//
// SECURITY: Graph tokens are never logged, audited, or persisted.
// Audit rows contain only subscription ids, timestamps, HTTP status
// codes and missing-config NAMES.
// =============================================================

export const SUBSCRIPTION_STATE_KEY = 'M365_SUBSCRIPTION_STATE';
export const SUBSCRIPTION_LIFETIME_MS = 2.5 * 24 * 60 * 60 * 1000;

const REQUIRED_CONFIG = [
  'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET',
  'M365_WEBHOOK_SECRET', 'SURI_MAILBOX',
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
];

export async function renewM365Subscription(env) {
  const missing = REQUIRED_CONFIG.filter(k => !env?.[k]);
  if (missing.length) {
    console.error(`M365 renewal skipped — missing config: ${missing.join(', ')}`);
    await auditRenewal(env, 'm365_renewal_failed',
      { missing_config: missing },
      'Renewal skipped: required configuration missing. Email intake will lapse when the current subscription expires.'
    ).catch(() => {});
    return { status: 'failed', reason: 'missing_config', missing };
  }

  try {
    const token = await getGraphToken(env);
    const state = await readSubscriptionState(env);
    let subId = state?.id || null;

    // No stored id: check Graph for an existing subscription to our
    // notification URL, so we never create duplicates.
    if (!subId) {
      const subs = await graphListSubscriptions(token);
      const ours = notificationUrl(env);
      const match = subs.find(s =>
        (ours && s.notificationUrl === ours) ||
        (s.resource || '').toLowerCase().includes(String(env.SURI_MAILBOX).toLowerCase())
      );
      if (match) subId = match.id;
    }

    const expiry = new Date(Date.now() + SUBSCRIPTION_LIFETIME_MS).toISOString();

    if (subId) {
      const renewed = await graphRenewSubscription(token, subId, expiry);
      if (renewed.ok) {
        await writeSubscriptionState(env, { id: subId, expiration: expiry });
        await auditRenewal(env, 'm365_subscription_renewed',
          { subscription_id: subId, expiration: expiry });
        return { status: 'renewed', id: subId, expiration: expiry };
      }
      if (renewed.status !== 404) {
        await auditRenewal(env, 'm365_renewal_failed',
          { subscription_id: subId, http_status: renewed.status },
          'Graph renewal call failed. Email intake will lapse when the current subscription expires.');
        return { status: 'failed', reason: `graph_renew_${renewed.status}` };
      }
      // 404: subscription already expired/deleted — fall through to recreate.
      subId = null;
    }

    const url = notificationUrl(env);
    if (!url) {
      await auditRenewal(env, 'm365_renewal_failed',
        { reason: 'no_worker_public_url' },
        'No active subscription found and WORKER_PUBLIC_URL is not set — cannot create one. Email intake is DOWN until this is fixed.');
      return { status: 'failed', reason: 'no_worker_public_url' };
    }
    const created = await graphCreateSubscription(token, env, url, expiry);
    if (!created.ok) {
      await auditRenewal(env, 'm365_renewal_failed',
        { http_status: created.status },
        'Graph subscription creation failed. Email intake is DOWN until this succeeds.');
      return { status: 'failed', reason: `graph_create_${created.status}` };
    }
    await writeSubscriptionState(env, {
      id: created.data.id, expiration: created.data.expirationDateTime,
    });
    await auditRenewal(env, 'm365_subscription_created',
      { subscription_id: created.data.id, expiration: created.data.expirationDateTime });
    return { status: 'created', id: created.data.id, expiration: created.data.expirationDateTime };
  } catch (err) {
    console.error('M365 renewal error:', err.message);
    await auditRenewal(env, 'm365_renewal_failed',
      { error: String(err.message || 'unknown').slice(0, 200) },
      'Unhandled renewal error — investigate. Email intake will lapse if this persists.'
    ).catch(() => {});
    return { status: 'failed', reason: 'exception' };
  }
}

function notificationUrl(env) {
  const base = String(env?.WORKER_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return base ? `${base}/webhooks/email` : null;
}

// ---------- Microsoft Graph ----------

async function getGraphToken(env) {
  const res = await fetch(
    `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     env.AZURE_CLIENT_ID,
        client_secret: env.AZURE_CLIENT_SECRET,
        scope:         'https://graph.microsoft.com/.default',
      }),
    }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error(`Graph token request failed (HTTP ${res.status})`);
  return data.access_token;
}

async function graphListSubscriptions(token) {
  const res = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.value || [];
}

async function graphRenewSubscription(token, subscriptionId, expiry) {
  const res = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expirationDateTime: expiry }),
  });
  return { ok: res.ok, status: res.status };
}

async function graphCreateSubscription(token, env, url, expiry) {
  const res = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      changeType:         'created',
      notificationUrl:    url,
      resource:           `users/${env.SURI_MAILBOX}/mailFolders/inbox/messages`,
      expirationDateTime: expiry,
      clientState:        env.M365_WEBHOOK_SECRET,
    }),
  });
  const data = res.ok ? await res.json() : null;
  return { ok: res.ok, status: res.status, data };
}

// ---------- Persistence (system_constants) ----------

function sbHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

export async function readSubscriptionState(env) {
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/system_constants?key=eq.${SUBSCRIPTION_STATE_KEY}&select=value&limit=1`,
      { headers: sbHeaders(env) }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0]?.value || null;
  } catch {
    return null;
  }
}

async function writeSubscriptionState(env, state) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/system_constants?on_conflict=key`,
    {
      method: 'POST',
      headers: { ...sbHeaders(env), Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        key: SUBSCRIPTION_STATE_KEY,
        value: state,
        data_type: 'json',
        category: 'system',
        description: 'M365 Graph webhook subscription state (id + expiration). Maintained automatically by the renewal cron. Not a tunable.',
        last_change_reason: 'M365 subscription renewal cron',
      }),
    }
  );
  if (!res.ok) console.error(`Failed to persist subscription state (HTTP ${res.status})`);
}

async function auditRenewal(env, action, afterState, notes = null) {
  if (!env?.SUPABASE_URL || !env?.SUPABASE_SERVICE_KEY) return;
  await fetch(`${env.SUPABASE_URL}/rest/v1/audit_log`, {
    method: 'POST',
    headers: sbHeaders(env),
    body: JSON.stringify({
      actor_type: 'system', action, after_state: afterState, notes,
    }),
  }).catch(err => console.error('Renewal audit insert failed:', err.message));
}
