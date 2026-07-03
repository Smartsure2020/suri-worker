# Suri Payment/Banking Boundary

**Status: hard, non-negotiable system boundary. Approved by product owner, 3 July 2026 (Phase 0).**

## The boundary

Suri is a claims intake and decision-support system. Suri must **not**:

- Process payments or prepare payment packs
- Store, extract, transcribe, display, log, email, or audit banking details
- Send banking details to any downstream system
- Integrate with any payment system

If banking details appear in a source document or message, Suri may record **only** a
detection flag (`claims.banking_details_detected`) and a location note that never
contains the details themselves. Payments are handled entirely outside Suri by a
separate workflow.

## Approved operating assumption (recorded, not incidental)

Raw source documents (PDFs, images) uploaded by claimants or attached to broker
emails **may contain banking details and are sent as-is to the Anthropic Claude API**
for reading. Pre-redacting PDFs/images is not technically feasible in this pipeline.

This is accepted on the basis that:

1. Anthropic's commercial API terms do not permit training on API data; a
   zero-data-retention arrangement should be confirmed/pursued for production.
2. The system prompt hard-instructs the model never to extract, transcribe,
   paraphrase, or summarise banking details (flag-only output).
3. All model output passes `banking-scrubber.js` **before** validation, storage,
   claim updates, audit records, or logs.
4. Nothing extracted from documents is stored as raw text anywhere in the database
   (the unused `claim_documents.extracted_text` column was dropped in Phase 0).

Banking details must never come **out** of the model call into any Suri store,
log, UI, email, or audit record.

## Enforcement layers (defence in depth)

| Layer | Where | What it does |
|---|---|---|
| Prompt | `suri-processor.js` (system prompt) | Forbids extraction; flag-only output |
| Output scrub | `suri-processor.js` step 5 | `sanitiseAiOutput()` on all Claude output before anything touches it |
| Ingestion scrub (portal) | `suri-worker.js` `/upload` | Submission payload + form data scrubbed before storage; injected banking keys dropped |
| Ingestion scrub (email) | `suri-worker.js` `createClaimFromEmail` | Subject/body_text/body_html scrubbed before storage |
| Audit scrub | `auditLog()` in processor | before/after states scrubbed before insert |
| Error hygiene | `parseClaudeJson()` | Raw model text never placed in thrown errors or logs (JSON.parse messages quote input — withheld) |
| Schema | `claims.banking_details_detected` (+ notes) | Boolean flag + content-free note only; no banking columns exist anywhere |

## Rules for future development

1. **Never log or throw raw model output.** Log lengths, hashes, stop reasons — not content.
2. **Any new column or field that stores free text originating from documents,
   emails, model output, or public form input must pass `sanitiseAiOutput()` first.**
3. **Never add columns/fields named or holding bank/account/branch/IBAN/SWIFT/
   beneficiary/EFT data.** Detection flags only.
4. Handler UI (Phase C), notifications and RFI emails (Phase D) must render only
   scrubbed fields, and must never fetch or display inbound email bodies or model
   output that has not passed the scrubber.
5. Redaction events are audited as `banking_details_redacted` with location paths
   only — never content. Persistent redactions indicate prompt/model drift and
   should be investigated.
6. Changes to `banking-scrubber.js` require the tests in `test/` to pass and new
   patterns to be covered by tests before deploy.

## Known limitations (accepted, monitored)

- The scrubber is keyword/pattern based: a bare ZA account number with no nearby
  banking keyword or bank name is not detected. The prompt is the primary control
  for model output; the scrubber is the backstop.
- Banking details interleaved with HTML tags (e.g. `Account: <b>123…</b>`) may
  evade the in-text patterns in `body_html`. Body text and model output paths are
  unaffected.
- The IBAN pattern can over-redact strings shaped like two letters + digits
  (e.g. some vehicle registrations). Over-redaction is the safe direction.

## Tests

`npm test` (Node built-in runner, no dependencies) runs all suites in `test/`,
including the boundary-critical ones:

- `test/banking-scrubber.test.mjs` — scrubber unit tests
- `test/boundary.test.mjs` — boundary guarantees (error hygiene, payload/email scrubbing, audit states)
- `test/claim-merge.test.mjs` — includes the "ingestion banking flag never cleared" regression
