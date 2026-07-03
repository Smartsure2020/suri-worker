// =============================================================
// Suri claims intake — Cloudflare Worker (Phase B)
// Smartsure Twenty20
//
// Changes from v1:
//  - /upload now validates Cloudflare Turnstile (instead of static API key)
//  - Accepts expanded form fields from the Next.js portal
//  - Saves full submission_payload + submission_source + submitted_role
// =============================================================

import { sanitiseAiOutput } from './banking-scrubber.js';
import { renewM365Subscription, readSubscriptionState } from './m365-renewal.js';
import { loadSystemConstant } from './rules-engine.js';
import {
  classifyEmail, extractClaimRef, isAutoReply,
  parseReferencedMessageIds, emailBodyText,
} from './email-triage.js';

// Outlook categories Suri applies so the mailbox itself shows what
// happened to each email. Metadata only — never sends anything.
const CATEGORY_NEW_CLAIM    = 'Suri/New claim';
const CATEGORY_ATTACHED     = 'Suri/Attached';
const CATEGORY_NEEDS_REVIEW = 'Suri/Needs review';
const CATEGORY_NOT_CLAIM    = 'Suri/Not claim';
const CATEGORY_AUTO_REPLY   = 'Suri/Ignored auto-reply';

const SURI_WORKER_VERSION = '0.4.0-c1';

// Env vars/secrets the ingestion worker needs to be fully operational.
// /health reports NAMES of missing ones only — never values.
const REQUIRED_ENV_VARS = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TURNSTILE_SECRET',
  'M365_WEBHOOK_SECRET', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET', 'SURI_MAILBOX',
];

const STUCK_PROCESSING_HOURS = 2;

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const MAX_FILE_SIZE_BYTES  = 20 * 1024 * 1024;
const MAX_TOTAL_SIZE_BYTES = 80 * 1024 * 1024;

// CORS allowlist comes from the PORTAL_ORIGINS env var (comma-separated
// browser origins, e.g. "https://claims.smartsure.co.za"). No wildcard:
// requests from origins not in the list get no Access-Control-Allow-Origin
// header. Requests without an Origin header (curl, server-to-server,
// Graph webhooks) are unaffected — CORS only gates browsers.

// =============================================================
// MAIN ROUTER
// =============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return corsResponse(null, 204, request, env);

    try {
      if (url.pathname === '/webhooks/email' && request.method === 'POST') {
        return await handleEmailWebhook(request, env, ctx);
      }
      if (url.pathname === '/upload' && request.method === 'POST') {
        return await handleWebPortalUpload(request, env, ctx);
      }
      if (url.pathname === '/webhooks/email' && request.method === 'GET') {
        return await handleWebhookValidation(request);
      }
      if (url.pathname === '/health') {
        return await handleHealth(env);
      }
      if (url.pathname === '/admin/diagnostics' && request.method === 'GET') {
        return await handleDiagnostics(request, env);
      }
      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('Unhandled Worker error:', err);
      await logSystemError(env, err, url.pathname);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  },

  // Cron (see [triggers] in wrangler.toml): keeps the M365 Graph webhook
  // subscription alive. Without this, email intake dies every ~3 days.
  async scheduled(controller, env, ctx) {
    const result = await renewM365Subscription(env);
    console.log(`M365 subscription renewal run: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  },
};

// =============================================================
// HEALTH CHECK
// Safe for operational use: reports presence/absence and statuses only.
// Never includes secret values, claim data, or model output.
// =============================================================

async function handleHealth(env) {
  const missing = REQUIRED_ENV_VARS.filter(k => !env?.[k]);

  let supabase = 'fail';
  if (env?.SUPABASE_URL && env?.SUPABASE_SERVICE_KEY) {
    try {
      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/system_constants?select=key&limit=1`,
        { headers: supabaseHeaders(env) }
      );
      supabase = res.ok ? 'ok' : 'fail';
    } catch {
      supabase = 'fail';
    }
  }

  // M365 subscription freshness from persisted state (renewed by cron).
  let m365Subscription = { status: 'unknown' };
  if (supabase === 'ok') {
    const state = await readSubscriptionState(env);
    if (state?.expiration) {
      const msLeft = new Date(state.expiration).getTime() - Date.now();
      m365Subscription = {
        status: msLeft <= 0 ? 'expired' : (msLeft < 12 * 3600 * 1000 ? 'expiring' : 'ok'),
        expiration: state.expiration,
      };
    }
  }

  const checks = {
    supabase,
    env_config: missing.length ? { status: 'incomplete', missing } : { status: 'ok' },
    queue_binding: env?.SURI_QUEUE ? 'present' : 'missing',
    rate_limiter: env?.UPLOAD_RATE_LIMITER ? 'present' : 'missing (fail-open by design)',
    m365_subscription: m365Subscription,
    // The queue consumer runs in a separate worker and cannot be observed
    // from here. Explicitly unknown — use /admin/diagnostics for DB-visible
    // processing signals (stuck/error claims).
    processor: 'unknown',
  };

  const healthy = supabase === 'ok' && missing.length === 0 && !!env?.SURI_QUEUE;
  return jsonResponse({
    status: healthy ? 'ok' : 'degraded',
    service: 'suri-worker',
    version: SURI_WORKER_VERSION,
    ts: new Date().toISOString(),
    checks,
  }, healthy ? 200 : 503);
}

// =============================================================
// ADMIN DIAGNOSTICS
// Protected by ADMIN_DIAGNOSTICS_SECRET (x-suri-admin-key header).
// Disabled (404) when the secret is not configured. Returns counts,
// claim refs and timestamps ONLY — never personal data, documents,
// banking content, prompts, or model output.
// =============================================================

async function handleDiagnostics(request, env) {
  const secret = env?.ADMIN_DIAGNOSTICS_SECRET;
  if (!secret) return jsonResponse({ error: 'Not found' }, 404);
  const provided = request.headers.get('x-suri-admin-key') || '';
  if (provided !== secret) return jsonResponse({ error: 'Unauthorised' }, 401);

  const sinceIso = (days) => new Date(Date.now() - days * 86400 * 1000).toISOString();
  const stuckBefore = new Date(Date.now() - STUCK_PROCESSING_HOURS * 3600 * 1000).toISOString();

  const [stuck, errored, failed7d, redactions7d, redactions30d] = await Promise.all([
    sbRows(env, `claims?status=eq.processing&updated_at=lt.${stuckBefore}&select=claim_ref,updated_at&order=updated_at.asc&limit=50`),
    sbRows(env, `claims?status=eq.error&select=claim_ref,updated_at&order=updated_at.desc&limit=50`),
    sbRows(env, `audit_log?action=eq.ai_processing_failed&created_at=gte.${sinceIso(7)}&select=claim_id,created_at&order=created_at.desc&limit=50`),
    sbRows(env, `audit_log?action=eq.banking_details_redacted&created_at=gte.${sinceIso(7)}&select=created_at&limit=1000`),
    sbRows(env, `audit_log?action=eq.banking_details_redacted&created_at=gte.${sinceIso(30)}&select=created_at&limit=1000`),
  ]);

  return jsonResponse({
    generated_at: new Date().toISOString(),
    thresholds: { stuck_processing_hours: STUCK_PROCESSING_HOURS },
    stuck_processing: { count: stuck.length, claims: stuck },
    error_claims: { count: errored.length, claims: errored },
    ai_processing_failures_7d: { count: failed7d.length, latest: failed7d[0]?.created_at || null },
    banking_redactions: {
      last_7_days: redactions7d.length,
      last_30_days: redactions30d.length,
      note: 'Counts only — redacted content is never stored or returned. Persistently high counts indicate prompt/model drift; see BOUNDARY.md.',
    },
  });
}

async function sbRows(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Diagnostics query failed: ${res.status}`);
  return res.json();
}

// =============================================================
// WEB PORTAL UPLOAD — TURNSTILE-AUTHENTICATED
// =============================================================

async function handleWebPortalUpload(request, env, ctx) {
  // Rate limit FIRST — before body parsing, Turnstile, Supabase or queue work.
  const rateLimited = await checkUploadRateLimit(request, env);
  if (rateLimited) return rateLimited;

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return corsResponse({ error: 'Invalid multipart form data' }, 400, request, env);
  }

  // 1. Validate Turnstile token (replaces old x-suri-portal-key header)
  const turnstileToken = formData.get('cf-turnstile-response');
  if (!turnstileToken) {
    return corsResponse({ error: 'Captcha verification required' }, 401, request, env);
  }
  const captchaValid = await validateTurnstile(turnstileToken, request, env);
  if (!captchaValid) {
    return corsResponse({ error: 'Captcha verification failed' }, 401, request, env);
  }

  // 2. Idempotency: the portal sends one key per form session so retries and
  //    double-submits map to the same claim. Invalid/absent keys are ignored.
  //    Lookup happens only after captcha passed, so unauthenticated callers
  //    cannot probe claim references.
  const rawIdemKey = formData.get('submission_idempotency_key');
  const idempotencyKey =
    typeof rawIdemKey === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(rawIdemKey)
      ? rawIdemKey : null;
  if (idempotencyKey) {
    const existing = await findClaimByIdempotencyKey(env, idempotencyKey);
    if (existing) return duplicateResponse(existing.claim_ref, request, env);
  }

  // 3. Build submission payload from all form fields (preserves what broker typed)
  const submissionPayload = {};
  for (const [key, value] of formData.entries()) {
    if (key === 'documents' || key === 'cf-turnstile-response' || key === 'submission_idempotency_key') continue;
    submissionPayload[key] = value;
  }

  // 3. Required fields
  const data = {
    submitter_role:       formData.get('submitter_role') || 'broker',
    broker_name:          formData.get('broker_name'),
    broker_email:         formData.get('broker_email'),
    broker_phone:         formData.get('broker_phone') || null,
    broker_ref:           formData.get('broker_ref') || null,
    insured_name:         formData.get('insured_name'),
    policy_number:        formData.get('policy_number'),
    insurer:              formData.get('insurer'),
    claim_type:           formData.get('claim_type'),
    peril_type:           formData.get('peril_type'),
    incident_date:        formData.get('incident_date'),
    cause_of_loss:        formData.get('cause_of_loss'),
    damage_description:   formData.get('damage_description'),
    claimed_value:        parseDecimal(formData.get('claimed_value')),
    vehicle_registration: formData.get('vehicle_registration') || null,
    property_address:     formData.get('property_address') || null,
    supplier_name:        formData.get('supplier_name') || null,
    supplier_contact:     formData.get('supplier_contact') || null,
    supplier_address:     formData.get('supplier_address') || null,
    invoice_or_quote:     formData.get('invoice_or_quote') || null,
    invoice_quote_amount: parseDecimal(formData.get('invoice_quote_amount')),
    vat_amount:           parseDecimal(formData.get('vat_amount')),
    submission_source:    formData.get('submission_source') || 'web_portal',
  };

  const validationErrors = validatePortalSubmission(data);
  if (validationErrors.length) {
    return corsResponse({ error: 'Validation failed', details: validationErrors }, 422, request, env);
  }

  // 4. File validation
  const files = formData.getAll('documents');
  if (!files.length) {
    return corsResponse({ error: 'At least one document is required' }, 422, request, env);
  }
  const fileErrors = await validateFiles(files);
  if (fileErrors.length) {
    return corsResponse({ error: 'File validation failed', details: fileErrors }, 422, request, env);
  }

  // 5. BANKING BOUNDARY — scrub everything the submitter typed before it is
  //    stored or passed downstream. Forbidden keys (e.g. account_number posted
  //    directly to this public endpoint) are dropped; banking patterns inside
  //    free-text values are redacted. Only a detection flag is kept.
  const payloadScrub = sanitiseAiOutput(submissionPayload);
  const dataScrub    = sanitiseAiOutput(data);
  const bankingScrub = {
    bankingDetected: payloadScrub.bankingDetected || dataScrub.bankingDetected,
    redactionCount:  payloadScrub.redactionCount + dataScrub.redactionCount,
    locations:       [...payloadScrub.locations, ...dataScrub.locations],
  };

  // POPIA: log access origin on portal-originated audit rows (see PRIVACY.md).
  const clientIp = request.headers.get('cf-connecting-ip') || null;

  // 6. Create claim + upload docs + queue processing
  const created = await createClaimFromPortal(
    dataScrub.sanitised, payloadScrub.sanitised, files, env, bankingScrub, clientIp, idempotencyKey
  );

  // Insert race lost to a concurrent identical submission — return the
  // winner's reference; that claim is already queued for processing.
  if (created.duplicate) return duplicateResponse(created.claimRef, request, env);

  const { claimId, claimRef } = created;

  ctx.waitUntil(
    env.SURI_QUEUE.send({ type: 'process_claim', claim_id: claimId, source: 'web_portal' })
  );

  return corsResponse({
    status: 'received',
    claim_ref: claimRef,
    message: 'Your claim has been received. You will receive a confirmation email shortly.',
  }, 202, request, env);
}

// =============================================================
// IDEMPOTENCY HELPERS
// =============================================================

async function findClaimByIdempotencyKey(env, key) {
  const rows = await supabaseQuery(env, 'claims', 'select', {
    submission_idempotency_key: `eq.${key}`,
    select: 'id,claim_ref',
    limit: '1',
  });
  return rows?.length ? rows[0] : null;
}

function duplicateResponse(claimRef, request, env) {
  return corsResponse({
    status: 'received',
    duplicate: true,
    claim_ref: claimRef,
    message: 'This claim was already received. Your reference is unchanged.',
  }, 200, request, env);
}

// =============================================================
// UPLOAD RATE LIMITING
// Uses the Workers Rate Limiting binding (see [[ratelimits]] in
// wrangler.toml), keyed by client IP. FAIL-OPEN by design: if the
// binding is missing or errors, the request proceeds (Turnstile still
// gates it) so config drift can never block legitimate submissions.
// =============================================================

async function checkUploadRateLimit(request, env) {
  const limiter = env?.UPLOAD_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') {
    console.warn('UPLOAD_RATE_LIMITER binding unavailable — rate limiting disabled (fail-open).');
    return null;
  }
  try {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await limiter.limit({ key: ip });
    if (!success) {
      return corsResponse(
        { error: 'Too many submissions from this connection. Please wait a minute and try again.' },
        429, request, env
      );
    }
  } catch (err) {
    console.warn('Rate limit check failed — allowing request (fail-open):', err.message);
  }
  return null;
}

// =============================================================
// TURNSTILE VALIDATION
// =============================================================

async function validateTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET) {
    console.error('TURNSTILE_SECRET not configured');
    return false;
  }
  try {
    const ip = request.headers.get('cf-connecting-ip') || '';
    const res = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret:   env.TURNSTILE_SECRET,
          response: token,
          remoteip: ip,
        }),
      }
    );
    const data = await res.json();
    if (!data.success) {
      console.warn('Turnstile failed:', JSON.stringify(data['error-codes']));
    }
    return data.success === true;
  } catch (err) {
    console.error('Turnstile validation error:', err);
    return false;
  }
}

// =============================================================
// CLAIM CREATION — PORTAL PATH
// =============================================================

async function createClaimFromPortal(data, submissionPayload, files, env, bankingScrub = {}, clientIp = null, idempotencyKey = null) {
  const claimRef = await generateClaimRef(env, data.insurer);

  const submittedRole = data.submitter_role === 'client' ? 'client' : 'broker';

  let claimRecord;
  try {
    claimRecord = await supabaseInsert(env, 'claims', {
      claim_ref:            claimRef,
      status:               'received',
      submission_idempotency_key: idempotencyKey,
    banking_details_detected: bankingScrub.bankingDetected || false,
    banking_details_detected_notes: bankingScrub.bankingDetected
      ? 'Banking details detected in portal submission text and redacted before storage. Content not retained by Suri.'
      : null,
    source:               'web_portal',
    submission_source:    data.submission_source,
    submitted_role:       submittedRole,
    submitted_at:         new Date().toISOString(),
    submission_payload:   submissionPayload,
    broker_name:          data.broker_name,
    broker_email:         data.broker_email,
    broker_ref:           data.broker_ref,
    insured_name:         data.insured_name,
    policy_number:        data.policy_number,
    insurer:              data.insurer,
    claim_type:           data.claim_type,
    peril_type:           data.peril_type,
    incident_date:        data.incident_date,
    incident_description: [data.cause_of_loss, data.damage_description].filter(Boolean).join(' — '),
    claimed_value:        data.claimed_value,
    vehicle_registration: data.vehicle_registration,
    property_address:     data.property_address,
    supplier_name:        data.supplier_name,
    supplier_contact:     data.supplier_contact,
    supplier_address:     data.supplier_address,
    invoice_or_quote:     data.invoice_or_quote,
    invoice_quote_amount: data.invoice_quote_amount,
    vat_amount:           data.vat_amount,
    });
  } catch (err) {
    // Unique-violation race: a concurrent identical submission won the
    // insert. Return the winner's claim instead of failing; the caller
    // skips document upload and queueing for duplicates.
    if (
      idempotencyKey &&
      /duplicate key|23505/i.test(err.message || '') &&
      /idempotency/i.test(err.message || '')
    ) {
      const winner = await findClaimByIdempotencyKey(env, idempotencyKey);
      if (winner) return { claimId: winner.id, claimRef: winner.claim_ref, duplicate: true };
    }
    throw err;
  }

  const claimId = claimRecord.id;

  await supabaseInsert(env, 'inbound_emails', {
    claim_id:     claimId,
    from_address: data.broker_email,
    subject:      `Portal submission — ${data.insured_name || 'unknown'}`,
    body_text:    [data.cause_of_loss, data.damage_description].filter(Boolean).join('\n\n'),
    source:       'web_portal',
  });

  await uploadFiles(files, claimId, null, env);

  await auditLog(env, {
    claim_id:   claimId,
    actor_type: 'system',
    action:     'claim_received',
    ip_address: clientIp,
    after_state: {
      source: 'web_portal',
      submitter_role: submittedRole,
      broker_email: data.broker_email,
      insurer: data.insurer,
      claim_type: data.claim_type,
    },
  });

  // Location strings only (e.g. 'damage_description') — never the content.
  if (bankingScrub.bankingDetected) {
    await auditLog(env, {
      claim_id:   claimId,
      actor_type: 'system',
      action:     'banking_details_redacted',
      ip_address: clientIp,
      after_state: {
        source: 'web_portal',
        redaction_count: bankingScrub.redactionCount,
        locations: bankingScrub.locations,
      },
      notes: 'Banking details detected in portal submission and redacted before storage. Content not retained by Suri.',
    });
  }

  return { claimId, claimRef };
}

// =============================================================
// EMAIL WEBHOOK (unchanged from v1)
// =============================================================

async function handleEmailWebhook(request, env, ctx) {
  // Microsoft Graph sends the subscription validation handshake as a POST
  // with a validationToken query parameter. It must be echoed back as
  // text/plain within 10 seconds or the subscription cannot be created.
  const url = new URL(request.url);
  const validationToken = url.searchParams.get('validationToken');
  if (validationToken) {
    return new Response(validationToken, {
      status: 200, headers: { 'Content-Type': 'text/plain' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  // Graph puts clientState inside each notification item, not in a header.
  const { valid, rejectedCount } = filterAuthorisedNotifications(
    body?.value, env.M365_WEBHOOK_SECRET
  );
  if (rejectedCount > 0) {
    console.warn(`Rejected ${rejectedCount} Graph notification(s) with missing/invalid clientState`);
  }
  if (!valid.length) return jsonResponse({ status: 'no_notifications' });

  ctx.waitUntil(Promise.allSettled(valid.map(n => processEmailNotification(n, env))));
  return jsonResponse({ status: 'accepted' }, 202);
}

// Exported for tests. Fails closed: if the secret is not configured,
// every notification is rejected.
export function filterAuthorisedNotifications(notifications, secret) {
  const list = Array.isArray(notifications) ? notifications : [];
  if (!secret) return { valid: [], rejectedCount: list.length };
  const valid = list.filter(n => n?.clientState === secret);
  return { valid, rejectedCount: list.length - valid.length };
}

// Exported for tests (message-id dedupe).
export async function processEmailNotification(notification, env) {
  const messageId = notification?.resourceData?.id;
  if (!messageId) return;
  const existing = await supabaseQuery(env, 'inbound_emails', 'select', { message_id: `eq.${messageId}` });
  if (existing?.length > 0) {
    console.log(`Skipping already-ingested message ${messageId}`);
    return;
  }
  const email = await fetchGraphEmail(messageId, env);
  if (!email) {
    await auditLog(env, {
      actor_type: 'system', action: 'email_fetch_failed',
      after_state: { message_id: messageId },
      notes: 'Graph email fetch failed — message not ingested. Check mailbox and Graph credentials.',
    });
    return;
  }
  await triageAndRouteEmail(email, env);
}

// =============================================================
// EMAIL TRIAGE & ROUTING (Phase C1)
// Stage 1: deterministic checks (free, safe). Stage 2: Haiku triage.
// Follow-ups attach to existing claims — they NEVER create new ones.
// Uncertain/ambiguous cases become review_items, visibly categorised.
// Exported for tests.
// =============================================================

export async function triageAndRouteEmail(email, env) {
  const from = (email.from?.emailAddress?.address || '').toLowerCase();

  // Stage 1a — auto-reply/bounce suppression (prevents loops and noise)
  if (isAutoReply(email)) {
    await auditLog(env, {
      actor_type: 'system', action: 'auto_reply_suppressed',
      after_state: { message_id: email.id, from, subject: email.subject || '' },
    });
    await applyCategory(env, email.id, CATEGORY_AUTO_REPLY);
    return { outcome: 'auto_reply_suppressed' };
  }

  // Stage 1b — sender denylist (optional, from system_constants)
  const denylist = await loadSystemConstant(env, 'SURI_SENDER_DENYLIST', []);
  if (Array.isArray(denylist) && from && denylist.includes(from)) {
    await auditLog(env, {
      actor_type: 'system', action: 'email_skipped_not_claim',
      after_state: { message_id: email.id, from, subject: email.subject || '', reason: 'sender_denylisted' },
    });
    await applyCategory(env, email.id, CATEGORY_NOT_CLAIM);
    return { outcome: 'denylisted' };
  }

  const bodyText = emailBodyText(email);

  // Stage 1c — deterministic follow-up matching (rungs 1–3)
  const det = await findDeterministicMatch(email, bodyText, env);
  if (det?.claim) {
    return attachFollowupToClaim(email, det.claim, det.method, env, {
      classification: 'follow_up', confidence: 1, reason: `deterministic:${det.method}`,
    });
  }
  if (det?.refNotFound) {
    // A claim ref is quoted but no such claim exists — human must look.
    const inboundEmailId = await storeUnlinkedEmail(email, env, {
      classification: 'follow_up', confidence: 1, reason: `claim ref ${det.refNotFound} not found`,
    });
    await createReviewItem(env, {
      inbound_email_id: inboundEmailId,
      reasons: ['claim_ref_not_found'],
      notes: `Email quotes claim ref ${det.refNotFound}, which does not exist in Suri.`,
    });
    await auditLog(env, {
      actor_type: 'system', action: 'followup_unmatched',
      after_state: { message_id: email.id, from, quoted_ref: det.refNotFound },
    });
    await applyCategory(env, email.id, CATEGORY_NEEDS_REVIEW);
    return { outcome: 'ref_not_found' };
  }

  // Stage 2 — AI triage (cheap/fast model; never throws, falls back to 'uncertain')
  const attachmentNames = await fetchGraphAttachmentNames(email.id, env);
  const triage = await classifyEmail({ ...email, attachmentNames }, env);
  const threshold = await loadSystemConstant(env, 'TRIAGE_CONFIDENCE_THRESHOLD', 0.7);

  await auditLog(env, {
    actor_type: 'system', action: 'email_triaged',
    after_state: {
      message_id: email.id, from,
      classification: triage.classification,
      confidence: triage.confidence,
      escalation_flags: triage.escalation_flags,
      model: triage.model,
      reason: triage.reason,
    },
  });

  switch (triage.classification) {
    case 'follow_up':
    case 'status_query':
      return routeFollowup(email, triage, from, env);

    case 'new_claim': {
      if (triage.confidence < threshold) {
        return escalateEmail(email, env, triage, ['low_triage_confidence'],
          `Triage says new_claim but confidence ${triage.confidence.toFixed(2)} is below threshold ${threshold}.`);
      }
      const duplicate = await detectPossibleDuplicate(env, from, triage);
      if (duplicate) {
        const inboundEmailId = await storeUnlinkedEmail(email, env, triage);
        await createReviewItem(env, {
          inbound_email_id: inboundEmailId,
          suggested_claim_id: duplicate.id,
          reasons: ['possible_duplicate', ...triage.escalation_flags],
          notes: `Looks like a new claim but may duplicate ${duplicate.claim_ref} (${duplicate.matched_on}). No claim created.`,
        });
        await auditLog(env, {
          actor_type: 'system', action: 'possible_duplicate_flagged',
          after_state: { message_id: email.id, from, existing_claim_ref: duplicate.claim_ref, matched_on: duplicate.matched_on },
        });
        await applyCategory(env, email.id, CATEGORY_NEEDS_REVIEW);
        return { outcome: 'possible_duplicate' };
      }
      const attachments = await fetchGraphAttachments(email.id, env);
      const { claimId, inboundEmailId } = await createClaimFromEmail(email, attachments, env, triage);
      await env.SURI_QUEUE.send({ type: 'process_claim', claim_id: claimId, source: 'email' });
      await applyCategory(env, email.id, CATEGORY_NEW_CLAIM);
      if (triage.escalation_flags.length) {
        await createReviewItem(env, {
          inbound_email_id: inboundEmailId, claim_id: claimId,
          reasons: triage.escalation_flags,
          notes: 'Claim was created, but the email language needs human attention.',
        });
        await applyCategory(env, email.id, CATEGORY_NEEDS_REVIEW);
      }
      return { outcome: 'new_claim', claimId };
    }

    case 'not_claim': {
      if (triage.confidence < threshold) {
        return escalateEmail(email, env, triage, ['uncertain_classification'],
          `Triage says not_claim but confidence ${triage.confidence.toFixed(2)} is below threshold ${threshold}.`);
      }
      await auditLog(env, {
        actor_type: 'system', action: 'email_skipped_not_claim',
        after_state: { message_id: email.id, from, subject: email.subject || '', triage_reason: triage.reason },
        notes: 'Triage classified this email as not claim-related. Review the mailbox category if this was a genuine claim.',
      });
      await applyCategory(env, email.id, CATEGORY_NOT_CLAIM);
      return { outcome: 'not_claim' };
    }

    default: // 'uncertain'
      return escalateEmail(email, env, triage, ['uncertain_classification'],
        `Triage could not classify this email (${triage.reason}).`);
  }
}

// Rung 4 (sender + exact policy number, exactly one open claim) plus the
// escalation paths for everything fuzzier.
async function routeFollowup(email, triage, from, env) {
  if (triage.policy_number && from) {
    const rows = await supabaseSelect(env,
      `claims?broker_email=eq.${encodeURIComponent(from)}` +
      `&policy_number=eq.${encodeURIComponent(triage.policy_number)}` +
      `&status=not.in.(closed,error)&select=id,claim_ref,status`);
    if (rows.length === 1) {
      return attachFollowupToClaim(email, rows[0], 'policy_sender', env, triage);
    }
    if (rows.length > 1) {
      const inboundEmailId = await storeUnlinkedEmail(email, env, triage);
      await createReviewItem(env, {
        inbound_email_id: inboundEmailId,
        reasons: ['ambiguous_followup_match', ...triage.escalation_flags],
        notes: `Sender + policy number matches ${rows.length} open claims: ${rows.map(r => r.claim_ref).join(', ')}. Human must pick.`,
      });
      await auditLog(env, {
        actor_type: 'system', action: 'followup_unmatched',
        after_state: { message_id: email.id, from, reason: 'ambiguous_policy_match', candidate_count: rows.length },
      });
      await applyCategory(env, email.id, CATEGORY_NEEDS_REVIEW);
      return { outcome: 'ambiguous_followup' };
    }
  }

  // AI-suggested ref (e.g. read off an attachment) — suggestion only, never auto-attach.
  let suggestedClaimId = null;
  let suggestionNote = '';
  if (triage.claim_ref) {
    const rows = await supabaseSelect(env,
      `claims?claim_ref=eq.${encodeURIComponent(triage.claim_ref)}&select=id,claim_ref&limit=1`);
    if (rows.length === 1) {
      suggestedClaimId = rows[0].id;
      suggestionNote = ` AI suggests ${rows[0].claim_ref} — confirm before attaching.`;
    }
  }

  const inboundEmailId = await storeUnlinkedEmail(email, env, triage);
  await createReviewItem(env, {
    inbound_email_id: inboundEmailId,
    suggested_claim_id: suggestedClaimId,
    reasons: ['unmatched_followup', ...triage.escalation_flags],
    notes: `Triage: ${triage.classification} (${triage.reason}). No deterministic claim match.${suggestionNote}`,
  });
  await auditLog(env, {
    actor_type: 'system', action: 'followup_unmatched',
    after_state: { message_id: email.id, from, suggested_claim_id: suggestedClaimId },
  });
  await applyCategory(env, email.id, CATEGORY_NEEDS_REVIEW);
  return { outcome: 'unmatched_followup' };
}

async function escalateEmail(email, env, triage, reasons, notes) {
  const inboundEmailId = await storeUnlinkedEmail(email, env, triage);
  await createReviewItem(env, {
    inbound_email_id: inboundEmailId,
    reasons: [...reasons, ...triage.escalation_flags],
    notes,
  });
  await applyCategory(env, email.id, CATEGORY_NEEDS_REVIEW);
  return { outcome: 'escalated', reasons };
}

// Deterministic rungs 1–3: claim ref in text, known conversation thread,
// In-Reply-To/References header pointing at a stored message.
async function findDeterministicMatch(email, bodyText, env) {
  const ref = extractClaimRef(`${email.subject || ''}\n${bodyText}`);
  if (ref) {
    const rows = await supabaseSelect(env,
      `claims?claim_ref=eq.${encodeURIComponent(ref)}&select=id,claim_ref,status&limit=1`);
    if (rows.length) return { claim: rows[0], method: 'claim_ref' };
    return { refNotFound: ref };
  }
  if (email.conversationId) {
    const rows = await supabaseSelect(env,
      `inbound_emails?thread_id=eq.${encodeURIComponent(email.conversationId)}&claim_id=not.is.null&select=claim_id&limit=1`);
    if (rows.length) {
      const claim = await getClaimById(env, rows[0].claim_id);
      if (claim) return { claim, method: 'thread' };
    }
  }
  for (const refId of parseReferencedMessageIds(email).slice(0, 5)) {
    const rows = await supabaseSelect(env,
      `inbound_emails?internet_message_id=eq.${encodeURIComponent(refId)}&claim_id=not.is.null&select=claim_id&limit=1`);
    if (rows.length) {
      const claim = await getClaimById(env, rows[0].claim_id);
      if (claim) return { claim, method: 'reply_headers' };
    }
  }
  return null;
}

// Attaches a follow-up email (and its attachments) to an EXISTING claim.
// Never creates a claim. Re-queues processing only when new documents arrived.
async function attachFollowupToClaim(email, claim, method, env, triage = {}) {
  const emailScrub = sanitiseAiOutput({
    subject:   email.subject || '',
    body_text: email.body?.contentType === 'text' ? email.body.content : null,
    body_html: email.body?.contentType === 'html' ? email.body.content : null,
  });
  const safeEmail = emailScrub.sanitised;

  const inboundEmailRecord = await supabaseInsert(env, 'inbound_emails', {
    claim_id:     claim.id,
    from_address: email.from?.emailAddress?.address || '',
    to_address:   email.toRecipients?.[0]?.emailAddress?.address || '',
    subject:      safeEmail.subject,
    body_text:    safeEmail.body_text,
    body_html:    safeEmail.body_html,
    message_id:   email.id,
    internet_message_id: email.internetMessageId || null,
    thread_id:    email.conversationId || null,
    source:       'outlook',
    raw_headers:  email.internetMessageHeaders || {},
    received_at:  email.receivedDateTime || new Date().toISOString(),
    triage_class: triage.classification || 'follow_up',
    triage_confidence: triage.confidence ?? null,
    triage_model: triage.model || null,
    triage_reason: triage.reason || null,
    matched_claim_id: claim.id,
    match_method: method,
  });

  const attachments = await fetchGraphAttachments(email.id, env);
  await uploadAttachments(attachments, claim.id, inboundEmailRecord.id, env);

  await auditLog(env, {
    claim_id: claim.id, actor_type: 'system', action: 'followup_attached',
    after_state: {
      message_id: email.id, claim_ref: claim.claim_ref,
      match_method: method, attachment_count: attachments.length,
    },
  });

  if (emailScrub.bankingDetected) {
    await supabaseUpdate(env, 'claims', claim.id, {
      banking_details_detected: true,
      banking_details_detected_notes: 'Banking details detected in a follow-up email body and redacted before storage. Content not retained by Suri.',
    });
    await auditLog(env, {
      claim_id: claim.id, actor_type: 'system', action: 'banking_details_redacted',
      after_state: { source: 'followup_email', redaction_count: emailScrub.redactionCount, locations: emailScrub.locations },
      notes: 'Banking details detected in follow-up email and redacted before storage. Content not retained by Suri.',
    });
    await createReviewItem(env, {
      inbound_email_id: inboundEmailRecord.id, claim_id: claim.id,
      reasons: ['banking_details_detected'],
      notes: 'Informational: banking details appeared in a follow-up email and were redacted. Payments remain outside Suri.',
    });
  }

  if (attachments.length > 0) {
    await env.SURI_QUEUE.send({ type: 'process_claim', claim_id: claim.id, source: 'email_followup' });
  }
  await applyCategory(env, email.id, CATEGORY_ATTACHED);
  return { outcome: 'attached', claimId: claim.id, method, attachmentCount: attachments.length };
}

// Stores an email that could not be safely routed (claim_id null) so review
// items can reference it and message-id dedupe covers re-notifications.
async function storeUnlinkedEmail(email, env, triage = {}) {
  const emailScrub = sanitiseAiOutput({
    subject:   email.subject || '',
    body_text: email.body?.contentType === 'text' ? email.body.content : null,
    body_html: email.body?.contentType === 'html' ? email.body.content : null,
  });
  const safeEmail = emailScrub.sanitised;
  const record = await supabaseInsert(env, 'inbound_emails', {
    from_address: email.from?.emailAddress?.address || '',
    to_address:   email.toRecipients?.[0]?.emailAddress?.address || '',
    subject:      safeEmail.subject,
    body_text:    safeEmail.body_text,
    body_html:    safeEmail.body_html,
    message_id:   email.id,
    internet_message_id: email.internetMessageId || null,
    thread_id:    email.conversationId || null,
    source:       'outlook',
    raw_headers:  email.internetMessageHeaders || {},
    received_at:  email.receivedDateTime || new Date().toISOString(),
    triage_class: triage.classification || null,
    triage_confidence: triage.confidence ?? null,
    triage_model: triage.model || null,
    triage_reason: triage.reason || null,
  });
  return record.id;
}

async function createReviewItem(env, { inbound_email_id = null, claim_id = null, suggested_claim_id = null, reasons, notes = null }) {
  const uniqueReasons = [...new Set(reasons)];
  await supabaseInsert(env, 'review_items', {
    inbound_email_id, claim_id, suggested_claim_id,
    reasons: uniqueReasons, notes,
  });
  await auditLog(env, {
    claim_id, actor_type: 'system', action: 'review_item_opened',
    after_state: { inbound_email_id, suggested_claim_id, reasons: uniqueReasons },
    notes,
  });
}

// Duplicate guard before creating a claim from a new_claim email:
// (a) same sender + exact policy number on an open claim;
// (b) same insured name + incident date within the configured window.
async function detectPossibleDuplicate(env, from, triage) {
  if (from && triage.policy_number) {
    const rows = await supabaseSelect(env,
      `claims?broker_email=eq.${encodeURIComponent(from)}` +
      `&policy_number=eq.${encodeURIComponent(triage.policy_number)}` +
      `&status=not.in.(closed,error)&select=id,claim_ref&limit=1`);
    if (rows.length) return { ...rows[0], matched_on: 'sender + policy number' };
  }
  if (triage.insured_name && triage.incident_date) {
    const windowDays = await loadSystemConstant(env, 'DUPLICATE_CLAIM_WINDOW_DAYS', 30);
    const d = new Date(triage.incident_date).getTime();
    if (!isNaN(d)) {
      const fromDate = new Date(d - windowDays * 86400e3).toISOString().slice(0, 10);
      const toDate   = new Date(d + windowDays * 86400e3).toISOString().slice(0, 10);
      const rows = await supabaseSelect(env,
        `claims?insured_name=ilike.${encodeURIComponent(triage.insured_name)}` +
        `&incident_date=gte.${fromDate}&incident_date=lte.${toDate}` +
        `&status=not.in.(closed,error)&select=id,claim_ref&limit=1`);
      if (rows.length) return { ...rows[0], matched_on: 'insured name + incident date window' };
    }
  }
  return null;
}

// Outlook category — metadata only, best-effort, never blocks the pipeline.
async function applyCategory(env, messageId, category) {
  try {
    if (!env?.AZURE_TENANT_ID || !env?.SURI_MAILBOX) return;
    const token = await getGraphToken(env);
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${env.SURI_MAILBOX}/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories: [category] }),
      }
    );
    if (!res.ok) console.warn(`Category apply failed (${res.status}) for ${messageId}`);
  } catch (err) {
    console.warn('Category apply error (non-fatal):', err.message);
  }
}

async function getClaimById(env, claimId) {
  const rows = await supabaseSelect(env,
    `claims?id=eq.${encodeURIComponent(claimId)}&select=id,claim_ref,status&limit=1`);
  return rows.length ? rows[0] : null;
}

// Attachment names only (for the triage prompt) — cheap $select, no bytes.
async function fetchGraphAttachmentNames(messageId, env) {
  try {
    const token = await getGraphToken(env);
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${env.SURI_MAILBOX}/messages/${messageId}/attachments?$select=name`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.value || []).map(a => a.name).filter(Boolean);
  } catch {
    return [];
  }
}

async function supabaseSelect(env, pathAndQuery) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase select failed: ${res.status}`);
  return res.json();
}

async function createClaimFromEmail(email, attachments, env, triage = {}) {
  // BANKING BOUNDARY — broker emails routinely quote supplier banking details
  // in the body. Redact before storage; keep only a detection flag. The
  // original email remains in the source mailbox for the payment workflow.
  const emailScrub = sanitiseAiOutput({
    subject:   email.subject || '',
    body_text: email.body?.contentType === 'text' ? email.body.content : null,
    body_html: email.body?.contentType === 'html' ? email.body.content : null,
  });
  const safeEmail = emailScrub.sanitised;

  const inboundEmailRecord = await supabaseInsert(env, 'inbound_emails', {
    from_address: email.from?.emailAddress?.address || '',
    to_address:   email.toRecipients?.[0]?.emailAddress?.address || '',
    subject:      safeEmail.subject,
    body_text:    safeEmail.body_text,
    body_html:    safeEmail.body_html,
    message_id:   email.id,
    internet_message_id: email.internetMessageId || null,
    thread_id:    email.conversationId || null,
    source:       'outlook',
    raw_headers:  email.internetMessageHeaders || {},
    received_at:  email.receivedDateTime || new Date().toISOString(),
    triage_class: triage.classification || null,
    triage_confidence: triage.confidence ?? null,
    triage_model: triage.model || null,
    triage_reason: triage.reason || null,
  });
  const inboundEmailId = inboundEmailRecord.id;

  const claimRef = await generateClaimRef(env, null);
  const claimRecord = await supabaseInsert(env, 'claims', {
    claim_ref:         claimRef,
    status:            'received',
    source:            'email',
    submission_source: 'email',
    submitted_at:      new Date().toISOString(),
    broker_email:      email.from?.emailAddress?.address || null,
    broker_name:       email.from?.emailAddress?.name || null,
    banking_details_detected: emailScrub.bankingDetected || false,
    banking_details_detected_notes: emailScrub.bankingDetected
      ? 'Banking details detected in inbound email body and redacted before storage. Content not retained by Suri.'
      : null,
  });
  const claimId = claimRecord.id;
  await supabaseUpdate(env, 'inbound_emails', inboundEmailId, { claim_id: claimId });
  await uploadAttachments(attachments, claimId, inboundEmailId, env);
  await auditLog(env, {
    claim_id: claimId, actor_type: 'system', action: 'claim_received',
    after_state: { source: 'email', from: email.from?.emailAddress?.address, subject: safeEmail.subject },
  });
  // Location strings only (e.g. 'body_html') — never the content.
  if (emailScrub.bankingDetected) {
    await auditLog(env, {
      claim_id: claimId, actor_type: 'system', action: 'banking_details_redacted',
      after_state: {
        source: 'email',
        redaction_count: emailScrub.redactionCount,
        locations: emailScrub.locations,
      },
      notes: 'Banking details detected in inbound email and redacted before storage. Content not retained by Suri.',
    });
  }
  return { claimId, inboundEmailId };
}

async function handleWebhookValidation(request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('validationToken');
  if (!token) return new Response('Missing validationToken', { status: 400 });
  return new Response(token, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

// =============================================================
// FILE UPLOAD HELPERS
// =============================================================

async function uploadAttachments(attachments, claimId, inboundEmailId, env) {
  for (const a of attachments) {
    if (!a.contentBytes) continue;
    const buffer = base64ToUint8Array(a.contentBytes);
    const storagePath = `claims/${claimId}/${Date.now()}-${sanitiseFilename(a.name)}`;
    await supabaseStorageUpload(env, storagePath, buffer, a.contentType);
    await supabaseInsert(env, 'claim_documents', {
      claim_id: claimId, inbound_email_id: inboundEmailId,
      storage_path: storagePath, original_filename: a.name,
      mime_type: a.contentType, file_size_bytes: buffer.byteLength, ocr_status: 'pending',
    });
  }
}

async function uploadFiles(files, claimId, inboundEmailId, env) {
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const storagePath = `claims/${claimId}/${Date.now()}-${sanitiseFilename(file.name)}`;
    await supabaseStorageUpload(env, storagePath, new Uint8Array(buffer), file.type);
    await supabaseInsert(env, 'claim_documents', {
      claim_id: claimId, inbound_email_id: inboundEmailId,
      storage_path: storagePath, original_filename: file.name,
      mime_type: file.type, file_size_bytes: buffer.byteLength, ocr_status: 'pending',
    });
  }
}

// =============================================================
// MICROSOFT GRAPH
// =============================================================

async function getGraphToken(env) {
  const res = await fetch(`https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.AZURE_CLIENT_ID,
      client_secret: env.AZURE_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to obtain Graph token');
  return data.access_token;
}

async function fetchGraphEmail(messageId, env) {
  const token = await getGraphToken(env);
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${env.SURI_MAILBOX}/messages/${messageId}?$select=id,subject,from,toRecipients,body,receivedDateTime,conversationId,internetMessageHeaders,internetMessageId`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  return res.json();
}

async function fetchGraphAttachments(messageId, env) {
  const token = await getGraphToken(env);
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${env.SURI_MAILBOX}/messages/${messageId}/attachments`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.value || []).filter(a =>
    ALLOWED_MIME_TYPES.has(a.contentType) && a.size <= MAX_FILE_SIZE_BYTES
  );
}

// =============================================================
// SUPABASE HELPERS
// =============================================================

async function supabaseQuery(env, table, method, params = {}) {
  const qs = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${qs}`, { headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase query failed: ${res.status}`);
  return res.json();
}

async function supabaseInsert(env, table, data) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...supabaseHeaders(env), 'Prefer': 'return=representation' },
    body: JSON.stringify(data),
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Supabase insert ${table}: ${err}`); }
  const rows = await res.json();
  return rows[0];
}

async function supabaseUpdate(env, table, id, data) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(env), 'Prefer': 'return=representation' },
    body: JSON.stringify(data),
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Supabase update ${table}: ${err}`); }
  return res.json();
}

async function supabaseStorageUpload(env, path, buffer, contentType) {
  const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/claim-documents/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'false',
    },
    body: buffer,
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Storage upload failed: ${err}`); }
}

function supabaseHeaders(env) {
  return {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function generateClaimRef(env, insurer) {
  const p_insurer = insurer || 'infiniti';
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/generate_claim_ref`, {
    method: 'POST',
    headers: supabaseHeaders(env),
    body: JSON.stringify({ p_insurer }),
  });
  if (!res.ok) throw new Error('Failed to generate claim ref');
  return res.json();
}

async function auditLog(env, { claim_id = null, actor_id = null, actor_type, action, before_state = null, after_state = null, notes = null, ip_address = null }) {
  // BANKING BOUNDARY: scrub state objects before insert (email subjects and
  // free text can carry banking details).
  const safeBefore = before_state ? sanitiseAiOutput(before_state).sanitised : null;
  const safeAfter  = after_state  ? sanitiseAiOutput(after_state).sanitised  : null;
  await supabaseInsert(env, 'audit_log', {
    claim_id, actor_id, actor_type, action,
    before_state: safeBefore, after_state: safeAfter, notes, ip_address,
  }).catch(err => console.error('Audit insert failed:', err));
}

// =============================================================
// VALIDATION
// =============================================================

function validatePortalSubmission(data) {
  const errors = [];
  if (!data.broker_name?.trim())  errors.push('broker_name is required');
  if (!data.broker_email?.trim()) errors.push('broker_email is required');
  if (!isValidEmail(data.broker_email)) errors.push('broker_email is not a valid email address');
  if (!data.insured_name?.trim()) errors.push('insured_name is required');
  if (!data.policy_number?.trim()) errors.push('policy_number is required');
  if (!data.insurer) errors.push('insurer is required');
  if (!data.claim_type) errors.push('claim_type is required');
  if (!data.peril_type) errors.push('peril_type is required');
  if (!data.incident_date) errors.push('incident_date is required');
  if (!data.cause_of_loss?.trim()) errors.push('cause_of_loss is required');
  if (!data.damage_description?.trim()) errors.push('damage_description is required');
  return errors;
}

async function validateFiles(files) {
  const errors = [];
  let total = 0;
  for (const f of files) {
    if (!ALLOWED_MIME_TYPES.has(f.type)) errors.push(`${f.name}: unsupported file type (${f.type})`);
    if (f.size > MAX_FILE_SIZE_BYTES) errors.push(`${f.name}: exceeds 20MB limit`);
    total += f.size;
  }
  if (total > MAX_TOTAL_SIZE_BYTES) errors.push('Total upload size exceeds 80MB limit');
  return errors;
}

// =============================================================
// UTILITIES
// =============================================================

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
}

function sanitiseFilename(name) {
  return (name || 'document').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

function parseDecimal(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? null : n;
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function parseAllowedOrigins(env) {
  return String(env?.PORTAL_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function corsResponse(data, status = 200, request, env) {
  const origin  = request?.headers.get('Origin');
  const allowed = parseAllowedOrigins(env);
  const headers = {
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
  // Echo the origin ONLY when allowlisted. Otherwise no CORS headers are
  // set and the browser blocks the response.
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin']  = origin;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  const body = data !== null ? JSON.stringify(data) : null;
  return new Response(body, { status, headers });
}

async function logSystemError(env, err, path) {
  try {
    await supabaseInsert(env, 'audit_log', {
      actor_type: 'system', action: 'worker_error',
      after_state: { path, message: err.message, stack: err.stack?.slice(0, 500) },
    });
  } catch {
    console.error('Failed to log system error');
  }
}
