// =============================================================
// Suri — rfi-drafts.js
// Missing-document (RFI) draft management. DRAFT-ONLY:
//  - drafts are mirrored to broker_emails (status pending_approval)
//  - where the claim came from an Outlook thread, a Graph REPLY DRAFT
//    is created in that thread for a human to review and send
//  - Suri NEVER calls /send or /sendMail. Ever.
//
// Anti-nag: stale drafts are superseded when documents arrive; a
// cooldown blocks repeat requests for the same documents; a max-
// reminder cap opens a review item instead of drafting again.
//
// BANKING BOUNDARY: every draft subject/body passes the banking
// scrubber before storage, Graph draft creation, and audit.
// =============================================================

import { sanitiseAiOutput } from './banking-scrubber.js';

export const RFI_EMAIL_TYPE = 'outstanding_docs';
export const DOCS_RECEIVED_EMAIL_TYPE = 'documents_received';

// =============================================================
// MAIN ENTRY — called from the processor after completeness is known.
// Never throws (failures are audited/logged; the claim pipeline
// must not be blocked by draft management).
// =============================================================

export async function manageRfiDrafts(env, claim, completenessResult) {
  try {
    return await manageRfiDraftsInner(env, claim, completenessResult);
  } catch (err) {
    console.error(`RFI draft management failed for claim ${claim?.id} (non-fatal):`, err.message);
    return { action: 'error' };
  }
}

async function manageRfiDraftsInner(env, claim, completenessResult) {
  const outstanding = [...(completenessResult?.outstanding || [])].sort();
  const liveDrafts = await sbGet(env,
    `broker_emails?claim_id=eq.${claim.id}&email_type=eq.${RFI_EMAIL_TYPE}&status=eq.pending_approval&order=created_at.desc&select=id,requested_documents,created_at`);

  // ---- All documents supplied ----
  if (outstanding.length === 0) {
    if (!liveDrafts.length) return { action: 'nothing_outstanding' };
    for (const d of liveDrafts) await supersedeDraft(env, claim, d, 'all documents now supplied');
    const existingReceived = await sbGet(env,
      `broker_emails?claim_id=eq.${claim.id}&email_type=eq.${DOCS_RECEIVED_EMAIL_TYPE}&status=eq.pending_approval&select=id&limit=1`);
    if (!existingReceived.length) {
      const email = buildDocsReceivedEmail(claim);
      const draft = await createDraft(env, claim, email, DOCS_RECEIVED_EMAIL_TYPE, null);
      await audit(env, claim.id, 'all_documents_received_draft_created', {
        broker_email_id: draft.id, graph_draft_id: draft.graphDraftId || null,
      });
    }
    return { action: 'superseded_all_received' };
  }

  // ---- Documents still outstanding ----
  const newestLive = liveDrafts[0];
  if (newestLive && sameDocs(newestLive.requested_documents, outstanding)) {
    // The pending draft already asks for exactly these documents — no churn.
    return { action: 'unchanged' };
  }
  // Any remaining live drafts are stale (they ask for the wrong set).
  for (const d of liveDrafts) await supersedeDraft(env, claim, d, 'outstanding document list changed');

  const rfiCount = Number(claim.rfi_count) || 0;
  const maxReminders = await loadConstant(env, 'RFI_MAX_REMINDERS', 2);
  if (rfiCount >= maxReminders) {
    await openRfiLimitReviewItem(env, claim, outstanding, rfiCount);
    await audit(env, claim.id, 'rfi_draft_skipped_max_reminders', {
      rfi_count: rfiCount, max: maxReminders, outstanding,
    }, 'RFI draft limit reached — human follow-up needed instead of another request.');
    return { action: 'skipped_max_reminders' };
  }

  // Cooldown applies only to REPEAT requests for the same document set.
  const lastAny = (await sbGet(env,
    `broker_emails?claim_id=eq.${claim.id}&email_type=eq.${RFI_EMAIL_TYPE}&order=created_at.desc&select=requested_documents,created_at&limit=1`))[0];
  if (lastAny && sameDocs(lastAny.requested_documents, outstanding)) {
    const cooldownDays = await loadConstant(env, 'RFI_COOLDOWN_DAYS', 5);
    const ageDays = (Date.now() - new Date(lastAny.created_at).getTime()) / 86400e3;
    if (ageDays < cooldownDays) {
      await audit(env, claim.id, 'rfi_draft_skipped_cooldown', {
        last_draft_age_days: Math.round(ageDays * 10) / 10, cooldown_days: cooldownDays, outstanding,
      });
      return { action: 'skipped_cooldown' };
    }
  }

  const email = buildRfiEmail(claim, outstanding, rfiCount + 1);
  const draft = await createDraft(env, claim, email, RFI_EMAIL_TYPE, outstanding);
  await sbPatch(env, `claims?id=eq.${claim.id}`, { rfi_count: rfiCount + 1 });
  await audit(env, claim.id, 'rfi_draft_created', {
    broker_email_id: draft.id,
    graph_draft_id: draft.graphDraftId || null,
    outstanding_documents: outstanding,
    rfi_count: rfiCount + 1,
  });
  return { action: 'created', outstanding };
}

// =============================================================
// DRAFT CREATION (broker_emails mirror + Graph reply draft)
// =============================================================

async function createDraft(env, claim, email, emailType, requestedDocuments) {
  // BANKING BOUNDARY: scrub before storage, Graph, and audit.
  const { sanitised } = sanitiseAiOutput({ subject: email.subject, body: email.body });

  // Thread anchor: the newest Outlook email on this claim (null for portal claims).
  const anchor = (await sbGet(env,
    `inbound_emails?claim_id=eq.${claim.id}&source=eq.outlook&message_id=not.is.null&order=received_at.desc&select=id,message_id&limit=1`))[0] || null;

  const record = await sbInsert(env, 'broker_emails', {
    claim_id: claim.id,
    email_type: emailType,
    to_address: claim.broker_email || '',
    subject: sanitised.subject,
    body_html: sanitised.body,
    status: 'pending_approval',
    requested_documents: requestedDocuments,
    inbound_email_id: anchor?.id || null,
  });

  let graphDraftId = null;
  if (anchor?.message_id) {
    graphDraftId = await createGraphReplyDraft(env, claim, anchor.message_id, sanitised.body, record.id);
    if (graphDraftId) {
      await sbPatch(env, `broker_emails?id=eq.${record.id}`, { graph_draft_id: graphDraftId });
    }
  }
  return { id: record.id, graphDraftId };
}

// Creates a REPLY DRAFT in the Outlook thread. Never sends. Best-effort:
// failures are audited and the pipeline continues (the broker_emails
// mirror already exists).
async function createGraphReplyDraft(env, claim, anchorMessageId, bodyHtml, brokerEmailId) {
  const required = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'SURI_MAILBOX'];
  const missing = required.filter(k => !env?.[k]);
  if (missing.length) {
    await audit(env, claim.id, 'reply_draft_creation_failed', {
      broker_email_id: brokerEmailId, reason: 'missing_config', missing_config: missing,
    });
    return null;
  }
  try {
    const token = await getGraphToken(env);
    // createReply produces an unsent draft in the mailbox, threaded to the
    // original message. We then set its body. There is NO send call.
    const createRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${env.SURI_MAILBOX}/messages/${anchorMessageId}/createReply`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }
    );
    if (!createRes.ok) throw new Error(`createReply HTTP ${createRes.status}`);
    const draft = await createRes.json();

    const patchRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${env.SURI_MAILBOX}/messages/${draft.id}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: { contentType: 'HTML', content: bodyHtml } }),
      }
    );
    if (!patchRes.ok) throw new Error(`draft body PATCH HTTP ${patchRes.status}`);

    await audit(env, claim.id, 'reply_draft_created_in_mailbox', {
      broker_email_id: brokerEmailId, graph_draft_id: draft.id,
    }, 'Unsent draft placed in the Outlook thread for human review and manual send.');
    return draft.id;
  } catch (err) {
    console.error('Graph reply draft failed (non-fatal):', err.message);
    await audit(env, claim.id, 'reply_draft_creation_failed', {
      broker_email_id: brokerEmailId, error: String(err.message || 'unknown').slice(0, 200),
    });
    return null;
  }
}

async function supersedeDraft(env, claim, draft, why) {
  await sbPatch(env, `broker_emails?id=eq.${draft.id}`, { status: 'superseded' });
  await audit(env, claim.id, 'rfi_draft_superseded', {
    broker_email_id: draft.id, previously_requested: draft.requested_documents || [],
  }, why);
}

async function openRfiLimitReviewItem(env, claim, outstanding, rfiCount) {
  // One open limit item per claim — no noise on every reprocess.
  const existing = await sbGet(env,
    `review_items?claim_id=eq.${claim.id}&status=eq.open&reasons=cs.{rfi_limit_reached}&select=id&limit=1`);
  if (existing.length) return;
  await sbInsert(env, 'review_items', {
    claim_id: claim.id,
    reasons: ['rfi_limit_reached'],
    notes: `RFI limit reached after ${rfiCount} draft(s). Still outstanding: ${outstanding.join(', ')}. Human follow-up needed.`,
  });
  await audit(env, claim.id, 'review_item_opened', {
    reasons: ['rfi_limit_reached'], outstanding,
  });
}

// =============================================================
// EMAIL BUILDERS (pure; all interpolated values HTML-escaped)
// =============================================================

export function buildRfiEmail(claim, outstanding, reminderNumber) {
  const claimRef = escapeHtml(claim.claim_ref);
  const brokerName = escapeHtml(claim.broker_name || 'Broker');
  const insuredName = escapeHtml(claim.insured_name || 'the insured');
  const subject = `Documents required — ${claim.claim_ref} — ${claim.insured_name || 'claim'}`;
  const reminderNote = reminderNumber > 1
    ? `<p style="color:#8a6d3b;">This is a follow-up to our earlier request.</p>` : '';

  const body = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; font-size: 14px; color: #333; max-width: 600px;">
<p>Dear ${brokerName},</p>
<p>Thank you for the claim submitted on behalf of <strong>${insuredName}</strong> (reference <strong>${claimRef}</strong>).</p>
${reminderNote}
<p>To progress the claim, we still require the following document(s):</p>
<ul>${outstanding.map(d => `<li>${escapeHtml(formatDocumentName(d))}</li>`).join('')}</ul>
<p>Please reply to this email with the document(s) attached, quoting <strong>${claimRef}</strong>. Documents already supplied do not need to be resent.</p>
<p>Kind regards,<br><strong>Smartsure Twenty20 Claims Team</strong></p>
<hr style="border:none;border-top:1px solid #eee;margin-top:24px;">
<p style="font-size:11px;color:#999;"><em>Drafted by Suri — review before sending.</em> Suri does not process payments; payment processing is handled separately. This request does not constitute an admission of liability or confirmation of cover. Smartsure Twenty20 (Pty) Ltd is an authorised Financial Services Provider.</p>
</body></html>`.trim();

  return { subject, body };
}

export function buildDocsReceivedEmail(claim) {
  const claimRef = escapeHtml(claim.claim_ref);
  const brokerName = escapeHtml(claim.broker_name || 'Broker');
  const insuredName = escapeHtml(claim.insured_name || 'the insured');
  const subject = `All documents received — ${claim.claim_ref}`;
  const body = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; font-size: 14px; color: #333; max-width: 600px;">
<p>Dear ${brokerName},</p>
<p>We confirm that all required documents for the claim of <strong>${insuredName}</strong> (reference <strong>${claimRef}</strong>) have now been received.</p>
<p>The claim is with our claims team for review. We will be in contact regarding the outcome. Please quote <strong>${claimRef}</strong> in any correspondence.</p>
<p>Kind regards,<br><strong>Smartsure Twenty20 Claims Team</strong></p>
<hr style="border:none;border-top:1px solid #eee;margin-top:24px;">
<p style="font-size:11px;color:#999;"><em>Drafted by Suri — review before sending.</em> Suri does not process payments; payment processing is handled separately. This confirmation does not constitute an admission of liability or confirmation of cover. Smartsure Twenty20 (Pty) Ltd is an authorised Financial Services Provider.</p>
</body></html>`.trim();
  return { subject, body };
}

// =============================================================
// LOCAL HELPERS (module is self-contained, matching repo style)
// =============================================================

function sameDocs(a, b) {
  const x = [...(a || [])].sort();
  const y = [...(b || [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDocumentName(docType) {
  const names = {
    claim_form:         'Completed claim form',
    id_document:        'Copy of ID document (insured)',
    policy_schedule:    'Policy schedule',
    drivers_licence:    "Driver's licence (front and back)",
    repair_quote:       'Repair / replacement quote',
    contractors_quote:  "Contractor's quote",
    invoice:            'Invoice',
    police_report:      'Police report / case number',
    photos:             'Photographs of damage',
    bdo_authorisation:  'BDO authorisation letter',
    incident_report:    'Incident / accident report',
    sasria_form:        'SASRIA claim form',
    legal_correspondence: 'Legal correspondence',
    other:              'Supporting documentation',
  };
  return names[docType] || String(docType).replace(/_/g, ' ');
}

async function getGraphToken(env) {
  const res = await fetch(
    `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.AZURE_CLIENT_ID,
        client_secret: env.AZURE_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
      }),
    }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error(`Graph token request failed (HTTP ${res.status})`);
  return data.access_token;
}

function sbHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function sbGet(env, pathAndQuery) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: sbHeaders(env) });
  if (!res.ok) throw new Error(`Supabase GET failed: ${res.status}`);
  return res.json();
}

async function sbInsert(env, table, data) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders(env), Prefer: 'return=representation' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase insert failed on ${table}: ${res.status}`);
  const rows = await res.json();
  return rows[0];
}

async function sbPatch(env, pathAndQuery, data) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(env), Prefer: 'return=representation' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase PATCH failed: ${res.status}`);
}

async function loadConstant(env, key, fallback) {
  try {
    const rows = await sbGet(env, `system_constants?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
    return rows.length ? rows[0].value : fallback;
  } catch {
    return fallback;
  }
}

async function audit(env, claimId, action, afterState = null, notes = null) {
  const safeAfter = afterState ? sanitiseAiOutput(afterState).sanitised : null;
  await sbInsert(env, 'audit_log', {
    claim_id: claimId, actor_type: 'system', action, after_state: safeAfter, notes,
  }).catch(err => console.error('RFI audit insert failed:', err.message));
}
