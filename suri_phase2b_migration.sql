-- =============================================================
-- Suri Phase 2B Migration — security & access-control hardening
-- Smartsure Twenty20
--
-- Apply MANUALLY in the Supabase SQL editor after:
--   suri_schema.sql → suri_phase_a_migration.sql → suri_phase0_migration.sql
--
-- Run the PREFLIGHT checks (provided with this migration) first.
-- Idempotent: safe to re-run.
--
-- What this does:
--   1. Forces the claim-documents bucket private. Only restricts access —
--      the Workers use the service role and are unaffected.
--   2. Drops the four dormant permissive UPDATE RLS policies. No client
--      uses the authenticated role yet (Phase C will reintroduce writes
--      via column-limited security-definer RPCs).
--   3. Makes audit_log write-once: triggers block UPDATE and DELETE even
--      for privileged roles. Retention-driven deletion (PRIVACY.md §3/§4)
--      must be a planned, audited maintenance migration that explicitly
--      drops and recreates these triggers.
--   4. Adds portal upload idempotency: claims.submission_idempotency_key
--      with a partial unique index.
--   5. Records an audit_log entry that this migration ran.
-- =============================================================

begin;

-- -------------------------------------------------------------
-- 1. Bucket privacy (no-op if already private)
-- -------------------------------------------------------------
update storage.buckets
set public = false
where id = 'claim-documents' and public = true;

-- -------------------------------------------------------------
-- 2. Drop dormant broad UPDATE policies
-- -------------------------------------------------------------
drop policy if exists "handlers_update_claims"        on claims;
drop policy if exists "handlers_update_broker_emails" on broker_emails;
drop policy if exists "handlers_update_fraud_flags"   on fraud_flags;
drop policy if exists "notif_update_authenticated"    on handler_notifications;

-- -------------------------------------------------------------
-- 3. audit_log immutability (write-once)
-- -------------------------------------------------------------
create or replace function prevent_audit_log_modification()
returns trigger as $$
begin
  raise exception 'audit_log rows are write-once and cannot be % — see PRIVACY.md §4 for the retention exception process.',
    lower(tg_op)
    using errcode = 'P0001';
end;
$$ language plpgsql;

drop trigger if exists trg_audit_log_no_update on audit_log;
create trigger trg_audit_log_no_update
  before update on audit_log
  for each row execute function prevent_audit_log_modification();

drop trigger if exists trg_audit_log_no_delete on audit_log;
create trigger trg_audit_log_no_delete
  before delete on audit_log
  for each row execute function prevent_audit_log_modification();

-- -------------------------------------------------------------
-- 4. Portal upload idempotency
-- -------------------------------------------------------------
alter table claims
  add column if not exists submission_idempotency_key text;

create unique index if not exists idx_claims_idempotency_key
  on claims(submission_idempotency_key)
  where submission_idempotency_key is not null;

comment on column claims.submission_idempotency_key is
  'Client-generated key (UUID per portal form session). Duplicate submissions with the same key return the existing claim instead of creating a new one. Null for email-sourced claims.';

-- -------------------------------------------------------------
-- 5. Audit trail (INSERT is still allowed — only UPDATE/DELETE are blocked)
-- -------------------------------------------------------------
insert into audit_log (actor_type, action, notes)
values (
  'system',
  'phase2b_security_migration_applied',
  'Bucket forced private; dormant UPDATE RLS policies dropped (claims, broker_emails, fraud_flags, handler_notifications); audit_log made write-once via triggers; claims.submission_idempotency_key added with partial unique index.'
);

commit;

-- =============================================================
-- END OF PHASE 2B MIGRATION
-- =============================================================
