-- =============================================================
-- Suri Phase C1 Migration — email triage & follow-up matching
-- Smartsure Twenty20
--
-- Apply MANUALLY after suri_phase2b_migration.sql. Idempotent.
--
-- What this does:
--   1. Adds triage/matching fields to inbound_emails (incl. the RFC
--      internet message id needed for In-Reply-To/References matching).
--   2. Creates review_items — a small stateful queue of emails/claims
--      needing human attention. C1 only CREATES items; resolution
--      tooling is Phase C3.
--   3. Seeds triage/duplicate-guard system constants.
--   4. Records an audit_log entry.
--
-- No banking/payment fields. No dashboard schema. No C2/C3 schema.
-- =============================================================

begin;

-- -------------------------------------------------------------
-- 1. inbound_emails triage fields
-- -------------------------------------------------------------
alter table inbound_emails
  add column if not exists internet_message_id text,
  add column if not exists triage_class        text,
  -- new_claim | follow_up | status_query | not_claim | uncertain
  add column if not exists triage_confidence   decimal(4,3),
  add column if not exists triage_model        text,
  add column if not exists triage_reason       text,
  -- short, non-sensitive, scrubbed model reason — never raw output
  add column if not exists matched_claim_id    uuid references claims(id),
  add column if not exists match_method        text;
  -- claim_ref | thread | reply_headers | policy_sender | (null = unmatched)

create index if not exists idx_inbound_emails_internet_message_id
  on inbound_emails(internet_message_id) where internet_message_id is not null;
create index if not exists idx_inbound_emails_thread_id
  on inbound_emails(thread_id) where thread_id is not null;

comment on column inbound_emails.triage_reason is
  'Short non-sensitive triage explanation. Scrubbed by banking-scrubber before storage. Raw model output is never stored.';

-- -------------------------------------------------------------
-- 2. review_items
-- -------------------------------------------------------------
create table if not exists review_items (
  id                 uuid primary key default uuid_generate_v4(),
  inbound_email_id   uuid references inbound_emails(id),
  claim_id           uuid references claims(id),
  suggested_claim_id uuid references claims(id),
  reasons            text[] not null,
  -- unmatched_followup | ambiguous_followup_match | possible_duplicate |
  -- low_triage_confidence | uncertain_classification |
  -- complaint_or_escalation_language | repudiation_coverage_liability_wording |
  -- sensitive_or_unusual_documents | banking_details_detected (informational) |
  -- claim_ref_not_found
  status             text not null default 'open',   -- open | resolved
  notes              text,
  created_at         timestamptz not null default now(),
  resolved_by        uuid references handlers(id),
  resolved_at        timestamptz,
  resolution_notes   text
);

create index if not exists idx_review_items_status   on review_items(status);
create index if not exists idx_review_items_email    on review_items(inbound_email_id);
create index if not exists idx_review_items_claim    on review_items(claim_id);

comment on table review_items is
  'Emails/claims escalated by Suri for human review. Created by the triage pipeline; resolution tooling arrives in Phase C3. Never contains banking content.';

alter table review_items enable row level security;

drop policy if exists "review_items_read_authenticated" on review_items;
create policy "review_items_read_authenticated" on review_items
  for select using (auth.role() = 'authenticated');
-- Writes via service role only in C1.

-- -------------------------------------------------------------
-- 3. System constants (idempotent seed)
-- -------------------------------------------------------------
insert into system_constants (key, value, data_type, description, category, is_sensitive) values
  ('TRIAGE_CONFIDENCE_THRESHOLD', '0.7', 'number',
   'Minimum AI triage confidence to act on a classification (create claim / treat as not-claim). Below this, the email is escalated to review_items.',
   'ai', false),
  ('DUPLICATE_CLAIM_WINDOW_DAYS', '30', 'number',
   'Window (days around incident date) for the insured-name duplicate-claim guard on new claim emails.',
   'claims', false),
  ('SURI_SENDER_DENYLIST', '[]', 'json',
   'JSON array of lowercased sender addresses whose emails are never processed as claims (spam/noise). Empty by default.',
   'system', false)
on conflict (key) do nothing;

-- -------------------------------------------------------------
-- 4. Audit trail
-- -------------------------------------------------------------
insert into audit_log (actor_type, action, notes)
values (
  'system',
  'phase_c1_triage_migration_applied',
  'Added inbound_emails triage/matching fields, review_items table, and triage system constants (email-first Phase C1).'
);

commit;

-- =============================================================
-- END OF PHASE C1 MIGRATION
-- =============================================================
