# Suri Privacy & Data Retention Position (POPIA)

**Status: draft position, Phase 2A (3 July 2026). Retention periods and the
cross-border transfer position require Smartsure compliance/legal sign-off
before production go-live.** Related: [BOUNDARY.md](BOUNDARY.md) — the
payment/banking boundary, which is a hard subset of this policy.

Smartsure Twenty20 (Pty) Ltd is the responsible party under POPIA for personal
information processed by Suri. Suri is a claims intake and decision-support
system; it does not process payments and never stores banking details
(see BOUNDARY.md).

## 1. Data categories

| Store | Personal information held | Notes |
|---|---|---|
| `claims` (Postgres) | Insured name, policy number, broker name/email/phone, incident details, addresses, vehicle registration, supplier contact details, claim amounts | Core claim record |
| `claim_documents` + Storage bucket `claim-documents` | Uploaded source documents: ID documents, driver's licences, policy schedules, police reports, photos, quotes/invoices | May contain **special personal information** (SA ID numbers) and incidental banking details (never extracted — flag only) |
| `inbound_emails` | Sender address, subject, email body (banking-scrubbed at ingestion) | Original email remains in the M365 mailbox |
| `claim_ai_outputs` | Claude-extracted fields incl. names, ID numbers, addresses; claim summaries | Banking-scrubbed before storage; versioned per run |
| `broker_emails`, `handler_notifications` | Broker/handler addresses, drafted correspondence | Drafts only in current phases; nothing is sent |
| `audit_log` | Actor IDs, action metadata, **client IP address for portal-originated actions** | States are banking-scrubbed before insert |
| `handlers` | Staff names, emails, roles | Internal staff data |
| `fraud_flags` | Flag descriptions referencing claim/claimant | Phase 3 feature, table pre-stubbed |

IP addresses (`audit_log.ip_address`) are recorded **only** for public-portal
submission events (`claim_received`, `banking_details_redacted`) to evidence
access origin, per the POPIA safeguard intent of the schema. They are not
recorded for email-webhook events (caller is Microsoft infrastructure) or
internal system events, and are not stored anywhere else.

## 2. Lawful basis

- **Consent:** the portal submission requires an explicit POPIA consent
  declaration ("…I consent to Smartsure Twenty20 processing this information
  in accordance with POPIA for the purpose of administering this claim.").
- **Necessity for claims administration:** processing is necessary for the
  performance of the insurance contract and Smartsure's obligations as an
  authorised FSP (FAIS/PPR/TCF context), covering email-sourced claims where
  the consent checkbox is not presented.
- **Special personal information (ID numbers):** processed as necessary for
  the establishment/exercise of insurance claim rights; collected only as it
  appears in claimant-supplied documents.

## 3. Retention position (DRAFT — requires compliance sign-off)

Default proposal, applying from **claim closure** (not submission):

| Data | Proposed retention | Rationale |
|---|---|---|
| Claims, claim documents, AI outputs, inbound emails, broker emails/notifications | **5 years after claim closure** | Aligns with common SA short-term insurance record-keeping expectations; single period keeps the claim file coherent |
| Audit log | **Retained for at least the life of the related claim file + 5 years; never selectively edited** | Decision-support audit trail; immutability position below |
| Fraud flags | Same as the related claim file | Part of the claim record |
| Claims never taken up / spam | 12 months, then eligible for deletion | No ongoing contractual basis |

**The exact periods are a Smartsure compliance/legal decision, not an
engineering one.** These defaults stand until amended by that sign-off.

## 4. Audit log immutability

Position: audit rows are write-once. No application code updates or deletes
audit rows; the schema documents "never delete rows". Phase 2B adds
database-level UPDATE/DELETE-blocking triggers so this holds even against
privileged access. Retention-driven deletion (per §3) must be performed as a
planned, itself-audited maintenance operation that temporarily and explicitly
lifts the guard — never ad hoc.

## 5. Cross-border and third-party processing

| Processor | What they receive | Position |
|---|---|---|
| **Anthropic (Claude API)** | Raw claim source documents and claim context, per the approved operating assumption in BOUNDARY.md | US processing; Anthropic commercial terms prohibit training on API data; zero-data-retention arrangement to be confirmed for production. POPIA s72: transfer justified by contractual necessity + binding processor terms — record in the s72 register |
| **Supabase** (Postgres + Storage) | All stored claim data | Confirm project region at go-live and record it here; operator agreement = Supabase DPA |
| **Cloudflare** (Workers, Queues) | Data in transit through ingestion/processing; logs contain metadata only (banking-scrubbed, no raw model output) | Operator; global edge — record in transfer register |
| **Microsoft 365 / Graph** | Claim emails (already Smartsure's mail estate) | Existing tenancy; no new transfer |
| **Vercel** (portal hosting) | No claim data at rest — the portal posts directly to the Worker | Static hosting only |

## 6. Data subject requests

Requests (access, correction, deletion/objection) route to Smartsure's
information officer. Engineering support: all personal information for a
claim is locatable by `claim_ref`/`claim_id` across the tables in §1 plus the
storage bucket prefix `claims/<claim_id>/`. Deletion requests must respect
insurance record-keeping obligations (§3) — typically restriction rather than
erasure while the retention period runs. Audit-log entries are retained (they
evidence processing itself); this position should be confirmed by compliance.

## 7. Retention/cleanup design (DESIGN ONLY — nothing is auto-deleted today)

Status: no automated deletion exists or is scheduled. This section records the
approved design for when compliance signs off the retention periods in §3.

**Proposed approach — controlled maintenance migration, not a background job:**

1. A cleanup run is a reviewed, versioned SQL migration executed manually
   (quarterly cadence proposed), never an unattended cron.
2. Selection: claims with `status = 'closed'` whose closure date is older than
   the signed-off retention period, excluding any claim with an open/escalated
   `fraud_flags` row or a recorded legal hold (hold mechanism to be added when
   cleanup is first implemented).
3. Deletion order per claim: Storage objects under `claims/<claim_id>/` →
   `claim_documents` → `claim_ai_outputs` → `inbound_emails` → `broker_emails`
   / `handler_notifications` → the `claims` row (FK cascades assist).
4. Every run inserts a summary `audit_log` row (`retention_cleanup_executed`:
   counts and claim_refs only) BEFORE deleting, so the audit trail records
   what was removed and under which policy version.

**Interaction with audit-log immutability (Phase 2B triggers):**
`audit_log` UPDATE/DELETE are blocked by triggers, including for privileged
roles. Any audit-log retention action therefore REQUIRES a controlled
maintenance migration that (a) records the intent in `audit_log` first,
(b) drops the `trg_audit_log_no_update`/`trg_audit_log_no_delete` triggers,
(c) performs the approved deletion, and (d) recreates the triggers — all in
one reviewed transaction. This is the only sanctioned path; ad-hoc trigger
removal is a policy violation.

**Must NEVER be deleted automatically without explicit written approval:**
- `audit_log` rows (any)
- `aol_packs` (delete-blocked at DB level; Phase D relevance)
- Any claim with an open fraud flag, dispute, complaint, or legal hold
- `system_constants` (no DELETE policy exists; operational state lives here)

**Also outstanding (unchanged):**
- Anthropic zero-data-retention confirmation (contractual action).
- Supabase region confirmation and s72 transfer register entries.
