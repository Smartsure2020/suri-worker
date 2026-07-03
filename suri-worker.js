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
        return jsonResponse({ status: 'ok', service: 'suri-worker', ts: new Date().toISOString() });
      }
      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('Unhandled Worker error:', err);
      await logSystemError(env, err, url.pathname);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  },
};

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

  // 2. Build submission payload from all form fields (preserves what broker typed)
  const submissionPayload = {};
  for (const [key, value] of formData.entries()) {
    if (key === 'documents' || key === 'cf-turnstile-response') continue;
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
  const { claimId, claimRef } = await createClaimFromPortal(
    dataScrub.sanitised, payloadScrub.sanitised, files, env, bankingScrub, clientIp
  );

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

async function createClaimFromPortal(data, submissionPayload, files, env, bankingScrub = {}, clientIp = null) {
  const claimRef = await generateClaimRef(env, data.insurer);

  const submittedRole = data.submitter_role === 'client' ? 'client' : 'broker';

  const claimRecord = await supabaseInsert(env, 'claims', {
    claim_ref:            claimRef,
    status:               'received',
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
  if (!isLikelyClaimEmail(email)) {
    // Audit skipped emails so non-matching claim emails do not silently vanish.
    await auditLog(env, {
      actor_type: 'system', action: 'email_skipped_not_claim',
      after_state: {
        message_id: messageId,
        from: email.from?.emailAddress?.address || '',
        subject: email.subject || '',
      },
      notes: 'Inbound email did not match claim keywords and was not ingested. Review the mailbox if this was a genuine claim.',
    });
    return;
  }
  const attachments = await fetchGraphAttachments(messageId, env);
  const { claimId } = await createClaimFromEmail(email, attachments, env);
  await env.SURI_QUEUE.send({ type: 'process_claim', claim_id: claimId, source: 'email' });
}

async function createClaimFromEmail(email, attachments, env) {
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
    thread_id:    email.conversationId || null,
    source:       'outlook',
    raw_headers:  email.internetMessageHeaders || {},
    received_at:  email.receivedDateTime || new Date().toISOString(),
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
    `https://graph.microsoft.com/v1.0/users/${env.SURI_MAILBOX}/messages/${messageId}?$select=id,subject,from,toRecipients,body,receivedDateTime,conversationId,internetMessageHeaders`,
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

function isLikelyClaimEmail(email) {
  const subject = (email.subject || '').toLowerCase();
  const keywords = ['claim','damage','loss','incident','accident','theft','hijack','flood','fire','geyser','hail'];
  return keywords.some(kw => subject.includes(kw));
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
