-- =============================================================
-- Suri Phase C2 Migration — missing-document drafts (draft-only)
-- Smartsure Twenty20
--
-- Apply MANUALLY after suri_phase_c1_migration.sql. Idempotent.
-- (Postgres 12+ allows ALTER TYPE ... ADD VALUE inside a transaction
--  as long as the new value is not used in the same transaction —
--  it is not used here.)
--
-- What this does:
--   1. Adds 'superseded' to email_status (stale unsent drafts are
--      superseded when follow-up documents arrive).
--   2. broker_emails: requested_documents (what an RFI draft asked
--      for — needed to detect stale/unchanged requests), Graph draft
--      id, and a link to the thread-anchor inbound email.
--   3. claims.rfi_count — how many RFI drafts have been created.
--   4. Seeds RFI anti-nag constants.
--   5. Records an audit_log entry.
--
-- No sending fields beyond draft metadata. No C3/AOL/Scout schema.
-- =============================================================

begin;

-- 1. New draft status
alter type email_status add value if not exists 'superseded';

-- 2. broker_emails draft metadata
alter table broker_emails
  add column if not exists requested_documents jsonb,
  add column if not exists graph_draft_id      text,
  add column if not exists inbound_email_id    uuid references inbound_emails(id);

comment on column broker_emails.requested_documents is
  'Document types this RFI draft asked for. Used to supersede stale drafts and avoid repeat requests. Never contains banking data.';
comment on column broker_emails.graph_draft_id is
  'Microsoft Graph draft message id when the draft was mirrored into the Outlook thread. Drafts are sent by humans in Outlook, never by Suri.';

create index if not exists idx_broker_emails_type_status
  on broker_emails(claim_id, email_type, status);

-- 3. RFI counter
alter table claims
  add column if not exists rfi_count int not null default 0;

-- 4. Anti-nag constants
insert into system_constants (key, value, data_type, description, category, is_sensitive) values
  ('RFI_COOLDOWN_DAYS', '5', 'number',
   'Minimum days between RFI drafts that ask for the SAME outstanding documents. Updated document lists (after follow-ups arrive) are not subject to the cooldown.',
   'claims', false),
  ('RFI_MAX_REMINDERS', '2', 'number',
   'Maximum number of RFI drafts per claim. Once reached, Suri opens a review item instead of drafting again.',
   'claims', false)
on conflict (key) do nothing;

-- 5. Audit trail
insert into audit_log (actor_type, action, notes)
values (
  'system',
  'phase_c2_rfi_migration_applied',
  'Added superseded email status, broker_emails RFI/draft metadata, claims.rfi_count, and RFI anti-nag constants (email-first Phase C2, draft-only).'
);

commit;

-- =============================================================
-- END OF PHASE C2 MIGRATION
-- =============================================================
