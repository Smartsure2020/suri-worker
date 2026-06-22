// =============================================================
// Suri claims processor — Cloudflare Queue consumer (Phase A)
// Smartsure Twenty20
//
// Triggered by: SURI_QUEUE messages from suri-worker.js
// Does:
//   1. Fetches claim + documents from Supabase
//   2. Downloads documents from Supabase Storage
//   3. Calls Claude with AOL-focused extraction prompt
//   4. SANITISES Claude output via banking-scrubber (defensive guard)
//   5. Sets banking_details_detected if scrubber found content
//   6. Validates output structure
//   7. Matches insurer rule pack
//   8. Runs deterministic rules engine → mandate band
//   9. Determines assessor recommendation
//  10. Determines handler routing queue
//  11. Drafts broker confirmation email
//  12. Stores AI output (with mandate fields)
//  13. Updates claim (with band + supplier + amount fields)
//  14. Updates document classifications
//  15. Audits everything
// =============================================================

import { runRulesEngine, RULES_ENGINE_VERSION } from './rules-engine.js';
import { sanitiseAiOutput, safeLog } from './banking-scrubber.js';

const CLAUDE_MODEL    = 'claude-opus-4-8';
const PROMPT_VERSION  = 'v2.0-aol-focused';

// =============================================================
// QUEUE CONSUMER ENTRY POINT
// =============================================================

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processMessage(message.body, env);
        message.ack();
      } catch (err) {
        console.error(`Processing failed for message:`, JSON.stringify(message.body), err);
        message.retry();
      }
    }
  },
};

async function processMessage(body, env) {
  if (body.type === 'process_claim') {
    await processClaim(body.claim_id, body.source, env);
  } else {
    console.warn('Unknown message type:', body.type);
  }
}

// =============================================================
// MAIN CLAIM PROCESSOR
// =============================================================

async function processClaim(claimId, source, env) {
  console.log(`Processing claim ${claimId}`);

  // 1. Mark as processing
  await updateClaim(env, claimId, { status: 'processing' });
  await auditLog(env, {
    claim_id: claimId, actor_type: 'system', action: 'ai_processing_started',
  });

  // 2. Fetch state
  const claim     = await fetchClaim(env, claimId);
  const documents = await fetchDocuments(env, claimId);
  const fraudFlags = await fetchFraudFlags(env, claimId);

  if (!documents.length) {
    console.warn(`Claim ${claimId} has no documents — flagging for manual review`);
    await updateClaim(env, claimId, {
      status: 'pending_review',
      mandate_band: 'band_1',
      decision_band_reason: 'No documents uploaded — admin review required.',
    });
    await auditLog(env, { claim_id: claimId, actor_type: 'system', action: 'no_documents_found' });
    return;
  }

  // 3. Build Claude payload
  const documentPayloads = await buildDocumentPayloads(documents, env);
  const rulePacks        = await fetchAllRulePacks(env);

  // 4. Call Claude
  const rawAiOutput = await callClaude(claim, documentPayloads, rulePacks, env);

  // 5. DEFENSIVE GUARD — sanitise Claude output BEFORE anything else touches it
  const { sanitised, bankingDetected, redactionCount, locations } = sanitiseAiOutput(rawAiOutput);

  // 6. Validate sanitised output
  const validated = validateAiOutput(sanitised);

  // 7. Match rule pack
  const matchedRulePack = matchRulePack(rulePacks, validated.classification);

  // 8. Run deterministic rules engine
  const rulesResult = await runRulesEngine(
    {
      claim,
      extractedFields:  validated.extracted_fields,
      classification:   validated.classification,
      documents,
      fraudFlags,
      rulePack:         matchedRulePack,
      aiOutput:         { confidence_score: validated.confidence_score },
    },
    env
  );

  // 9. Document completeness (informational — already part of REQUIRED_DOCUMENTS_PRESENT rule)
  const completenessResult = runCompletenessCheck(documents, matchedRulePack);

  // 10. Assessor recommendation
  const assessorRec = determineAssessorRecommendation(
    validated.classification, validated.extracted_fields, matchedRulePack
  );

  // 11. Handler routing queue (band-aware)
  const routing = determineHandlerRouting(rulesResult.mandate_band, validated.classification);

  // 12. Broker confirmation email
  const brokerEmail = buildBrokerEmail(claim, validated, completenessResult, rulesResult);

  // 13. Store AI output
  const aiOutputId = await storeAiOutput(env, claimId, {
    extracted_fields:               validated.extracted_fields,
    completeness_result:            completenessResult,
    classification:                 validated.classification,
    assessor_recommendation:        assessorRec.recommendation,
    assessor_recommendation_reason: assessorRec.reason,
    handler_queue_recommendation:   routing.queue,
    claim_summary:                  validated.claim_summary,
    draft_broker_email_subject:     brokerEmail.subject,
    draft_broker_email_body:        brokerEmail.body,
    completeness_score:             completenessResult.score,
    confidence_score:               validated.confidence_score,
    model_version:                  CLAUDE_MODEL,
    prompt_version:                 PROMPT_VERSION,
    mandate_eligibility_result:     rulesResult.rule_results,
    mandate_band:                   rulesResult.mandate_band,
    mandate_band_reason:            rulesResult.mandate_band_reason,
    critical_unknowns:              rulesResult.critical_unknowns,
    rules_engine_version:           rulesResult.rules_engine_version,
    banking_details_redacted:       bankingDetected,
    redaction_locations:            bankingDetected ? locations : null,
  });

  // 14. Update claim
  const claimUpdates = buildClaimUpdates(
    validated, routing, matchedRulePack, rulesResult, bankingDetected
  );
  await updateClaim(env, claimId, { ...claimUpdates, status: 'pending_review' });

  // 15. Update document types from Claude classifications
  await updateDocumentTypes(env, documents, validated.document_classifications || []);

  // 16. Store draft broker email (still gated by handler approval in Phase D)
  await storeBrokerEmail(env, claimId, claim, brokerEmail);

  // 17. Audit
  await auditLog(env, {
    claim_id: claimId,
    actor_type: 'system',
    action: 'ai_output_generated',
    after_state: {
      ai_output_id:           aiOutputId,
      claim_type:             validated.classification.claim_type,
      peril_type:             validated.classification.peril_type,
      insurer:                validated.classification.insurer,
      mandate_band:           rulesResult.mandate_band,
      mandate_band_reason:    rulesResult.mandate_band_reason,
      critical_unknowns:      rulesResult.critical_unknowns,
      routing_queue:          routing.queue,
      handler_queue:          routing.handler_queue,
      completeness_score:     completenessResult.score,
      confidence_score:       validated.confidence_score,
      banking_details_redacted: bankingDetected,
      redaction_count:        redactionCount,
    },
  });

  // 18. Separate audit entry if banking content had to be stripped
  if (bankingDetected) {
    await auditLog(env, {
      claim_id: claimId,
      actor_type: 'system',
      action: 'banking_details_redacted',
      // NOTE: we log location strings (e.g. 'extracted_fields.notes') but never the content
      after_state: { redaction_count: redactionCount, locations },
      notes: 'Banking details detected in AI output and stripped before storage. Source documents may still contain banking content — handle via separate payment workflow.',
    });
  }

  console.log(
    `Claim ${claimId} processed. Band: ${rulesResult.mandate_band}. Queue: ${routing.queue}. ` +
    `Completeness: ${completenessResult.score}. Banking redacted: ${bankingDetected}.`
  );
}

// =============================================================
// CLAUDE API CALL
// =============================================================

async function callClaude(claim, documentPayloads, rulePacks, env) {
  const systemPrompt = buildSystemPrompt(rulePacks);
  const userPrompt   = buildUserPrompt(claim, documentPayloads);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 4096,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const response = await res.json();
  const text = response.content?.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('Claude returned no text content');

  const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    throw new Error(`Claude output not valid JSON: ${clean.slice(0, 300)}`);
  }
}

// =============================================================
// SYSTEM PROMPT — AOL-FOCUSED, NO BANKING
// =============================================================

function buildSystemPrompt(rulePacks) {
  const rulePackSummary = rulePacks.map(rp =>
    `${rp.insurer} / ${rp.claim_type}: required = ${JSON.stringify(rp.required_documents)}`
  ).join('\n');

  return `You are Suri, an AOL preparation and claims intake assistant for Smartsure Twenty20, a South African short-term insurance administrator.

ROLE
Your role is to read claim documents and extract structured information needed to prepare an Agreement of Loss (AOL) decision pack for a human claims handler.

SURI DOES NOT PROCESS PAYMENTS
You must not extract, transcribe, paraphrase, summarise, store, or include banking, account, payment, branch code, IBAN, SWIFT, beneficiary, EFT, or any payment-routing details in any field of your output. Payment processing is handled by a separate workflow outside Suri.

If banking or payment details appear in any source document, set:
  - "banking_details_detected": true
  - "banking_details_location_notes": short note such as "Banking details visible on page 2 of supplier invoice (not extracted)."
Do not include the banking content itself anywhere in your output. Not in fields. Not in notes. Not in summaries.

INSURERS
You work with: Infiniti Insurance, Hollard (direct and outsourced), Guardrisk, CIB.

CLAIM TYPES
- Motor: accident, collision, write_off, windscreen, hail, theft, hijack
- Non-motor: storm, lightning, burst_geyser, power_surge, water_damage, fire, burglary
- Specialist: sasria, commercial, liability

INSURER RULE PACKS (current document checklists)
${rulePackSummary}

HARD RULES — never violate
1. Do NOT make coverage decisions
2. Do NOT recommend repudiation
3. Do NOT approve or reject claims
4. Do NOT determine liability
5. Do NOT reference policy wording as binding
6. Do NOT extract or store banking, payment, or account details
You extract, classify, and summarise. Decisions belong to human handlers.

REGULATORY CONTEXT
- South African short-term insurance (POPIA, PPR, TCF)
- Treat all personal information as confidential
- Flag SASRIA perils for specialist routing

OUTPUT FORMAT
Respond with ONLY a valid JSON object — no preamble, no explanation, no markdown fences. Match this structure exactly:

{
  "extracted_fields": {
    "insured_name": string | null,
    "id_number": string | null,
    "policy_number": string | null,
    "insurer": "infiniti" | "hollard_direct" | "hollard_outsourced" | "guardrisk" | "cib" | null,
    "broker_name": string | null,
    "broker_email": string | null,
    "incident_date": "YYYY-MM-DD" | null,
    "date_of_loss": "YYYY-MM-DD" | null,
    "incident_description": string | null,
    "damage_description": string | null,
    "cause_of_loss_description": string | null,
    "cause_appears_sudden_unforeseen": "yes" | "no" | "unclear" | null,
    "cause_sudden_unforeseen_confidence": number,
    "claimed_value": number | null,
    "excess_identified": "yes" | "no" | null,
    "excess_amount": number | null,
    "vehicle_registration": string | null,
    "vehicle_make_model": string | null,
    "property_address": string | null,
    "police_case_number": string | null,
    "third_party_involved": boolean | null,
    "injuries_reported": boolean | null,
    "supplier_name": string | null,
    "supplier_contact": string | null,
    "supplier_address": string | null,
    "invoice_or_quote": "invoice" | "quote" | "both" | "neither" | null,
    "invoice_quote_amount": number | null,
    "vat_amount": number | null,
    "policy_status_assessment": "active" | "lapsed" | "cancelled" | "unknown" | null,
    "policy_status_confidence": number,
    "policy_period_start": "YYYY-MM-DD" | null,
    "policy_period_end": "YYYY-MM-DD" | null,
    "exclusion_language_detected": boolean | null,
    "exclusion_phrases": string[],
    "banking_details_detected": boolean,
    "banking_details_location_notes": string | null
  },
  "classification": {
    "claim_type": "motor" | "non_motor" | "specialist" | null,
    "peril_type": string | null,
    "insurer": "infiniti" | "hollard_direct" | "hollard_outsourced" | "guardrisk" | "cib" | null,
    "confidence": number
  },
  "document_classifications": [
    {
      "original_filename": string,
      "document_type": "claim_form" | "id_document" | "policy_schedule" | "drivers_licence" | "repair_quote" | "contractors_quote" | "invoice" | "police_report" | "photos" | "bdo_authorisation" | "incident_report" | "legal_correspondence" | "sasria_form" | "other"
    }
  ],
  "claim_summary": string,
  "confidence_score": number,
  "extraction_notes": string | null
}

GUIDANCE
- claim_summary: 3–5 sentences in plain English. Who, what, when, what they are claiming for, any notable flags. No coverage opinions.
- All monetary amounts in ZAR as numbers, no currency symbols.
- Use "unknown"/"unclear" rather than guessing. Confidence below 0.7 should be noted in extraction_notes.
- If you cannot confidently assess policy status, set "policy_status_assessment": "unknown".
- For motor claims, set "cause_appears_sudden_unforeseen": null (not applicable).
- exclusion_phrases: short strings only, never reproduce policy wording verbatim beyond what is needed to identify the concern.`;
}

// =============================================================
// USER PROMPT + DOCUMENT PAYLOADS
// =============================================================

function buildUserPrompt(claim, documentPayloads) {
  const submissionContext = claim.incident_description
    ? `Submission form note: ${claim.incident_description}`
    : '';
  return [
    {
      type: 'text',
      text: `Process this insurance claim submission for Smartsure Twenty20.

${submissionContext}
Source: ${claim.source}
Broker email: ${claim.broker_email || 'not provided'}

${documentPayloads.length} document(s) attached. Read all of them carefully.`,
    },
    ...documentPayloads,
    {
      type: 'text',
      text: 'Return the JSON output as specified. Remember: no coverage decisions, no liability findings, no banking details in any field.',
    },
  ];
}

async function buildDocumentPayloads(documents, env) {
  const payloads = [];
  for (const doc of documents) {
    try {
      const buffer = await downloadFromStorage(env, doc.storage_path);
      const base64 = uint8ArrayToBase64(buffer);
      const mime   = doc.mime_type || 'application/pdf';

      if (mime === 'application/pdf') {
        payloads.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          title: doc.original_filename || 'document.pdf',
        });
      } else if (mime.startsWith('image/')) {
        const claudeMime = mime === 'image/heic' ? 'image/jpeg' : mime;
        payloads.push({
          type: 'image',
          source: { type: 'base64', media_type: claudeMime, data: base64 },
        });
      } else if (mime.includes('word') || mime.includes('officedocument')) {
        payloads.push({
          type: 'text',
          text: `[Word document: ${doc.original_filename} — handler should review manually.]`,
        });
      }
    } catch (err) {
      console.error(`Failed to load document ${doc.id}:`, err.message);
      payloads.push({
        type: 'text',
        text: `[Document ${doc.original_filename} could not be loaded.]`,
      });
    }
  }
  return payloads;
}

// =============================================================
// RULE PACK MATCHING + COMPLETENESS (informational)
// =============================================================

function matchRulePack(rulePacks, classification) {
  if (!classification?.claim_type || !classification?.insurer) return null;
  return rulePacks.find(rp =>
    rp.insurer === classification.insurer &&
    rp.claim_type === classification.claim_type
  ) || null;
}

function runCompletenessCheck(documents, rulePack) {
  const present = new Set(documents.filter(d => d.document_type).map(d => d.document_type));
  if (!rulePack) {
    return { present: [...present], outstanding: [], notes: 'Rule pack not matched.', score: null };
  }
  const required    = rulePack.required_documents || [];
  const outstanding = required.filter(d => !present.has(d));
  const score       = required.length ? (required.length - outstanding.length) / required.length : 1;
  const notes       = outstanding.length === 0
    ? 'All required documents present.'
    : `Missing: ${outstanding.join(', ')}.`;
  return {
    present: required.filter(d => present.has(d)),
    outstanding, required, optional: rulePack.optional_documents || [], score, notes,
  };
}

// =============================================================
// ASSESSOR RECOMMENDATION (unchanged from v1)
// =============================================================

function determineAssessorRecommendation(classification, extractedFields, rulePack) {
  const value     = extractedFields?.claimed_value || 0;
  const claimType = classification?.claim_type;
  const perilType = classification?.peril_type;

  if (perilType === 'sasria') {
    return { recommendation: 'sasria_referral', reason: 'SASRIA peril identified — specialist referral required.' };
  }
  if (claimType === 'specialist') {
    return { recommendation: 'loss_adjuster', reason: 'Specialist claim type requires loss adjuster appointment.' };
  }
  if (!rulePack) {
    return { recommendation: 'none', reason: 'Rule pack not matched — assessor decision deferred to handler.' };
  }
  if (rulePack.loss_adjuster_threshold && value >= rulePack.loss_adjuster_threshold) {
    return {
      recommendation: 'loss_adjuster',
      reason: `Claimed value R${value.toLocaleString()} exceeds loss adjuster threshold R${rulePack.loss_adjuster_threshold.toLocaleString()}.`,
    };
  }
  if (rulePack.assessor_threshold && value >= rulePack.assessor_threshold) {
    return {
      recommendation: 'field_assessor',
      reason: `Claimed value R${value.toLocaleString()} exceeds assessor threshold R${rulePack.assessor_threshold.toLocaleString()}.`,
    };
  }
  if (perilType === 'write_off') {
    return { recommendation: 'desktop_assessor', reason: 'Write-off claim — desktop assessor required.' };
  }
  return { recommendation: 'none', reason: 'Claim value within desktop processing threshold.' };
}

// =============================================================
// HANDLER ROUTING (band-aware)
// =============================================================

function determineHandlerRouting(band, classification) {
  const claimType = classification?.claim_type;
  // Specialist always to specialist queue regardless of band
  if (claimType === 'specialist') {
    return { queue: 'specialist_handlers', handler_queue: 'specialist' };
  }
  // Band 1 → admin/review queue regardless of claim type
  if (band === 'band_1') {
    return { queue: 'admin_review', handler_queue: claimType === 'non_motor' ? 'non_motor' : 'motor' };
  }
  // Band 2 and 3 → claim-type queue
  if (claimType === 'non_motor') {
    return { queue: 'non_motor_handlers', handler_queue: 'non_motor' };
  }
  return { queue: 'motor_handlers', handler_queue: 'motor' };
}

// =============================================================
// BROKER EMAIL BUILDER (unchanged from v1)
// =============================================================

function buildBrokerEmail(claim, aiOutput, completenessResult, rulesResult) {
  const insuredName = aiOutput.extracted_fields?.insured_name || 'the insured';
  const policyNo    = aiOutput.extracted_fields?.policy_number || 'not yet confirmed';
  const claimRef    = claim.claim_ref;
  const peril       = aiOutput.classification?.peril_type || 'not yet classified';
  const outstanding = completenessResult.outstanding || [];

  const subject = `Claim received — ${claimRef} — ${insuredName}`;

  const outstandingSection = outstanding.length > 0
    ? `<h3 style="color:#c0392b;">Outstanding documents required</h3>
       <p>To complete registration, please supply the following:</p>
       <ul>${outstanding.map(doc => `<li>${formatDocumentName(doc)}</li>`).join('')}</ul>
       <p>Please reply to this email with the documents attached, quoting <strong>${claimRef}</strong>.</p>`
    : `<p>All required documents have been received.</p>`;

  const body = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; font-size: 14px; color: #333; max-width: 600px;">
<p>Dear ${claim.broker_name || 'Broker'},</p>
<p>Thank you for submitting a claim on behalf of <strong>${insuredName}</strong>. We confirm receipt and have registered the claim:</p>
<table style="border-collapse: collapse; width: 100%; margin-bottom: 16px;">
  <tr><td style="padding:6px 12px;background:#f5f5f5;font-weight:bold;width:40%;">Claim reference</td><td style="padding:6px 12px;">${claimRef}</td></tr>
  <tr><td style="padding:6px 12px;background:#f5f5f5;font-weight:bold;">Insured</td><td style="padding:6px 12px;">${insuredName}</td></tr>
  <tr><td style="padding:6px 12px;background:#f5f5f5;font-weight:bold;">Policy number</td><td style="padding:6px 12px;">${policyNo}</td></tr>
  <tr><td style="padding:6px 12px;background:#f5f5f5;font-weight:bold;">Peril</td><td style="padding:6px 12px;">${capitalise(peril)}</td></tr>
  <tr><td style="padding:6px 12px;background:#f5f5f5;font-weight:bold;">Date received</td><td style="padding:6px 12px;">${new Date().toLocaleDateString('en-ZA', { day:'numeric', month:'long', year:'numeric' })}</td></tr>
</table>
${outstandingSection}
<p>A claims handler will contact you within 2 business days. Please quote <strong>${claimRef}</strong> in all correspondence.</p>
<p>Kind regards,<br><strong>Smartsure Twenty20 Claims Team</strong><br>claims@smartsure.co.za</p>
<hr style="border:none;border-top:1px solid #eee;margin-top:24px;">
<p style="font-size:11px;color:#999;">This email is generated by the Suri claims intake system. Suri does not process payments. Payment processing is handled separately. This acknowledgement does not constitute an admission of liability or confirmation of cover. Cover is subject to the terms and conditions of the policy. Smartsure Twenty20 (Pty) Ltd is an authorised Financial Services Provider.</p>
</body></html>`.trim();

  return { subject, body };
}

// =============================================================
// PERSISTENCE
// =============================================================

async function storeAiOutput(env, claimId, outputData) {
  await supabasePatch(env,
    `claim_ai_outputs?claim_id=eq.${claimId}&is_current=eq.true`,
    { is_current: false }
  );
  const record = await supabaseInsert(env, 'claim_ai_outputs', {
    claim_id: claimId, is_current: true, ...outputData,
  });
  return record.id;
}

async function storeBrokerEmail(env, claimId, claim, brokerEmail) {
  await supabaseInsert(env, 'broker_emails', {
    claim_id: claimId,
    email_type: 'registration',
    to_address: claim.broker_email || '',
    subject:    brokerEmail.subject,
    body_html:  brokerEmail.body,
    status:     'pending_approval',
  });
}

async function updateDocumentTypes(env, documents, classifications) {
  for (const cls of classifications) {
    const doc = documents.find(d => d.original_filename === cls.original_filename);
    if (doc && cls.document_type) {
      await supabasePatch(env,
        `claim_documents?id=eq.${doc.id}`,
        { document_type: cls.document_type, ocr_status: 'complete' }
      );
    }
  }
}

function buildClaimUpdates(validated, routing, rulePack, rulesResult, bankingDetected) {
  const f = validated.extracted_fields || {};
  const c = validated.classification  || {};
  return {
    insured_name:           f.insured_name           || null,
    policy_number:          f.policy_number          || null,
    claim_type:             c.claim_type             || null,
    peril_type:             c.peril_type             || null,
    insurer:                c.insurer                || null,
    incident_date:          f.incident_date          || f.date_of_loss || null,
    incident_description:   f.incident_description   || null,
    claimed_value:          f.claimed_value          || null,
    excess_amount:          f.excess_amount          || null,
    vehicle_registration:   f.vehicle_registration   || null,
    vehicle_make_model:     f.vehicle_make_model     || null,
    property_address:       f.property_address       || null,
    supplier_name:          f.supplier_name          || null,
    supplier_contact:       f.supplier_contact       || null,
    supplier_address:       f.supplier_address       || null,
    invoice_or_quote:       f.invoice_or_quote       || null,
    invoice_quote_amount:   f.invoice_quote_amount   || null,
    vat_amount:             f.vat_amount             || null,
    handler_queue:          routing.handler_queue,
    insurer_rule_id:        rulePack?.id             || null,
    confidence_score:       validated.confidence_score || null,
    mandate_band:           rulesResult.mandate_band,
    decision_band_reason:   rulesResult.mandate_band_reason,
    banking_details_detected: bankingDetected || !!f.banking_details_detected,
    banking_details_detected_notes: (bankingDetected || f.banking_details_detected)
      ? (f.banking_details_location_notes
          || 'Banking details detected in source documents and stripped by Suri. Not extracted or stored.')
      : null,
  };
}

// =============================================================
// VALIDATION
// =============================================================

function validateAiOutput(raw) {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Claude returned non-object output');
  }
  return {
    extracted_fields:         raw.extracted_fields         || {},
    classification:           raw.classification           || {},
    document_classifications: raw.document_classifications || [],
    claim_summary:            raw.claim_summary            || 'Summary not generated.',
    confidence_score:         typeof raw.confidence_score === 'number'
                                ? Math.min(1, Math.max(0, raw.confidence_score)) : 0.5,
    extraction_notes:         raw.extraction_notes         || null,
  };
}

// =============================================================
// SUPABASE HELPERS
// =============================================================

async function fetchClaim(env, claimId) {
  const rows = await supabaseGet(env, `claims?id=eq.${claimId}&limit=1`);
  if (!rows.length) throw new Error(`Claim ${claimId} not found`);
  return rows[0];
}

async function fetchDocuments(env, claimId) {
  return supabaseGet(env, `claim_documents?claim_id=eq.${claimId}&order=uploaded_at.asc`);
}

async function fetchAllRulePacks(env) {
  return supabaseGet(env, `insurer_rule_packs?is_active=eq.true`);
}

async function fetchFraudFlags(env, claimId) {
  return supabaseGet(env, `fraud_flags?claim_id=eq.${claimId}`);
}

async function updateClaim(env, claimId, updates) {
  await supabasePatch(env, `claims?id=eq.${claimId}`, updates);
}

async function supabaseGet(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase GET failed: ${path} — ${res.status}`);
  return res.json();
}

async function supabaseInsert(env, table, data) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...supabaseHeaders(env), Prefer: 'return=representation' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase insert failed on ${table}: ${err}`);
  }
  const rows = await res.json();
  return rows[0];
}

async function supabasePatch(env, path, data) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(env), Prefer: 'return=representation' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase PATCH failed: ${path} — ${err}`);
  }
}

async function downloadFromStorage(env, storagePath) {
  const res = await fetch(
    `${env.SUPABASE_URL}/storage/v1/object/claim-documents/${storagePath}`,
    { headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
  );
  if (!res.ok) throw new Error(`Storage download failed: ${storagePath} — ${res.status}`);
  const buffer = await res.arrayBuffer();
  return new Uint8Array(buffer);
}

function supabaseHeaders(env) {
  return {
    apikey:        env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function auditLog(env, { claim_id, actor_id = null, actor_type, action, before_state = null, after_state = null, notes = null }) {
  // Defensive: sanitise any objects in audit payload before insert
  const safeBefore = before_state ? sanitiseAiOutput(before_state).sanitised : null;
  const safeAfter  = after_state  ? sanitiseAiOutput(after_state).sanitised  : null;
  await supabaseInsert(env, 'audit_log', {
    claim_id, actor_id, actor_type, action,
    before_state: safeBefore, after_state: safeAfter, notes,
  }).catch(err => console.error('Audit insert failed (non-fatal):', err.message));
}

// =============================================================
// UTILITIES
// =============================================================

function uint8ArrayToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function capitalise(s) {
  if (!s) return '';
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
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
  return names[docType] || capitalise(docType);
}
