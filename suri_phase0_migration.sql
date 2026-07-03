-- =============================================================
-- Suri Phase 0 Migration — banking boundary hardening
-- Smartsure Twenty20
--
-- Apply after suri_schema.sql and suri_phase_a_migration.sql on any
-- database created before this migration. Fresh installs from the
-- updated suri_schema.sql do not need steps 1–3 (they are no-ops).
--
-- What this does:
--   1. Removes 'bank_statement' from all insurer_rule_packs optional
--      document lists. Suri must not invite banking documents.
--   2. Drops claim_documents.extracted_text (never populated by any
--      code path). Raw document text may contain banking details and
--      must never be stored; any future text-storage column must pass
--      banking-scrubber.js before insert.
--   3. Updates the claim_documents table comment to record the rule.
--   4. Writes an audit_log entry recording that this migration ran.
--
-- Safe to re-run (idempotent).
-- =============================================================

begin;

-- 1. Remove 'bank_statement' from optional document lists
update insurer_rule_packs
set optional_documents = (
  select coalesce(jsonb_agg(d), '[]'::jsonb)
  from jsonb_array_elements(optional_documents) as d
  where d <> '"bank_statement"'::jsonb
)
where optional_documents @> '["bank_statement"]'::jsonb;

-- Also remove from required lists defensively (none seeded, but cheap)
update insurer_rule_packs
set required_documents = (
  select coalesce(jsonb_agg(d), '[]'::jsonb)
  from jsonb_array_elements(required_documents) as d
  where d <> '"bank_statement"'::jsonb
)
where required_documents @> '["bank_statement"]'::jsonb;

-- 2. Drop the never-populated raw-text column
alter table claim_documents drop column if exists extracted_text;

-- 3. Record the rule where future developers will see it
comment on table claim_documents is
  'Individual attachments stored in Supabase Storage. Raw document text is never stored (banking boundary). Any future text-storage column must pass banking-scrubber.js before insert.';

-- 4. Audit trail
insert into audit_log (actor_type, action, notes)
values (
  'system',
  'phase0_boundary_migration_applied',
  'Removed bank_statement from rule pack document lists; dropped unused claim_documents.extracted_text column. Banking boundary hardening — see BOUNDARY.md.'
);

commit;

-- =============================================================
-- END OF PHASE 0 MIGRATION
-- =============================================================
