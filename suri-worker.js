// =============================================================
// Suri claims intake — Cloudflare Worker (Phase B)
// Smartsure Twenty20
//
// Changes from v1:
//  - /upload now validates Cloudflare Turnstile (instead of static API key)
//  - Accepts expanded form fields from the Next.js portal
//  - Saves full submission_payload + submission_source + submitted_role
// =============================================================

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

// CORS — tighten to portal domain in production
const PORTAL_ORIGINS = ['*']; // e.g. ['https://claims.smartsure.co.za']

// =============================================================
// MAIN ROUTER
// =============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return corsResponse(null, 204, request);

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
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return corsResponse({ error: 'Invalid multipart form data' }, 400, request);
  }

  // 1. Validate Turnstile token (replaces old x-suri-portal-key header)
  const turnstileToken = formData.get('cf-turnstile-response');
  if (!turnstileToken) {
    return corsResponse({ error: 'Captcha verification required' }, 401, request);
  }
  const captchaValid = await validateTurnstile(turnstileToken, request, env);
  if (!captchaValid) {
    return corsResponse({ error: 'Captcha verification failed' }, 401, request);
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
    return corsResponse({ error: 'Validation failed', details: validationErrors }, 422, request);
  }

  // 4. File validation
  const files = formData.getAll('documents');
  if (!files.length) {
    return corsResponse({ error: 'At least one document is required' }, 422, request);
  }
  const fileErrors = await validateFiles(files);
  if (fileErrors.length) {
    return corsResponse({ error: 'File validation failed', details: fileErrors }, 422, request);
  }

  // 5. Create claim + upload docs + queue processing
  const { claimId, claimRef } = await createClaimFromPortal(data, submissionPayload, files, env);

  ctx.waitUntil(
    env.SURI_QUEUE.send({ type: 'process_claim', claim_id: claimId, source: 'web_portal' })
  );

  return corsResponse({
    status: 'received',
    claim_ref: claimRef,
    message: 'Your claim has been received. You will receive a confirmation email shortly.',
  }, 202, request);
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

async function createClaimFromPortal(data, submissionPayload, files, env) {
  const claimRef = await generateClaimRef(env, data.insurer);

  const submittedRole = data.submitter_role === 'client' ? 'client' : 'broker';

  const claimRecord = await supabaseInsert(env, 'claims', {
    claim_ref:            claimRef,
    status:               'received',
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
    after_state: {
      source: 'web_portal',
      submitter_role: submittedRole,
      broker_email: data.broker_email,
      insurer: data.insurer,
      claim_type: data.claim_type,
    },
  });

  return { claimId, claimRef };
}

// =============================================================
// EMAIL WEBHOOK (unchanged from v1)
// =============================================================

async function handleEmailWebhook(request, env, ctx) {
  const clientState = request.headers.get('clientstate') || '';
  if (clientState !== env.M365_WEBHOOK_SECRET) {
    return jsonResponse({ error: 'Unauthorised' }, 401);
  }
  const body = await request.json();
  const notifications = body?.value ?? [];
  if (!notifications.length) return jsonResponse({ status: 'no_notifications' });
  ctx.waitUntil(Promise.allSettled(notifications.map(n => processEmailNotification(n, env))));
  return jsonResponse({ status: 'accepted' }, 202);
}

async function processEmailNotification(notification, env) {
  const messageId = notification?.resourceData?.id;
  if (!messageId) return;
  const existing = await supabaseQuery(env, 'inbound_emails', 'select', { message_id: `eq.${messageId}` });
  if (existing?.length > 0) return;
  const email = await fetchGraphEmail(messageId, env);
  if (!email || !isLikelyClaimEmail(email)) return;
  const attachments = await fetchGraphAttachments(messageId, env);
  const { claimId } = await createClaimFromEmail(email, attachments, env);
  await env.SURI_QUEUE.send({ type: 'process_claim', claim_id: claimId, source: 'email' });
}

async function createClaimFromEmail(email, attachments, env) {
  const inboundEmailRecord = await supabaseInsert(env, 'inbound_emails', {
    from_address: email.from?.emailAddress?.address || '',
    to_address:   email.toRecipients?.[0]?.emailAddress?.address || '',
    subject:      email.subject || '',
    body_text:    email.body?.contentType === 'text' ? email.body.content : null,
    body_html:    email.body?.contentType === 'html'  ? email.body.content : null,
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
  });
  const claimId = claimRecord.id;
  await supabaseUpdate(env, 'inbound_emails', inboundEmailId, { claim_id: claimId });
  await uploadAttachments(attachments, claimId, inboundEmailId, env);
  await auditLog(env, {
    claim_id: claimId, actor_type: 'system', action: 'claim_received',
    after_state: { source: 'email', from: email.from?.emailAddress?.address, subject: email.subject },
  });
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

async function auditLog(env, { claim_id, actor_id = null, actor_type, action, before_state = null, after_state = null, notes = null }) {
  await supabaseInsert(env, 'audit_log', {
    claim_id, actor_id, actor_type, action, before_state, after_state, notes,
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

function corsResponse(data, status = 200, request) {
  const origin = request?.headers.get('Origin');
  const allowed = PORTAL_ORIGINS.includes('*') ? '*'
    : (origin && PORTAL_ORIGINS.includes(origin)) ? origin : PORTAL_ORIGINS[0];
  const body = data !== null ? JSON.stringify(data) : null;
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin':  allowed,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
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
