-- =============================================================
-- Suri Phase A Migration
-- Smartsure Twenty20 — Suri Pre-Mandate Claims Portal
--
-- ADDITIVE ONLY. Does not modify or drop existing columns/tables.
-- Wrapped in a single transaction. Safe to apply on production.
--
-- Apply after suri_schema.sql.
-- =============================================================

begin;

-- =============================================================
-- 1. NEW ENUM TYPES
-- =============================================================

create type mandate_band      as enum ('band_1', 'band_2', 'band_3');
create type rule_result       as enum ('pass', 'fail', 'unknown', 'not_applicable');
create type rule_fail_action  as enum ('block', 'warn', 'escalate');
create type rule_type         as enum ('threshold','checklist','flag','referral','extraction','derived');
create type handler_decision_type as enum (
  'approve','approve_with_amendment','request_info','escalate','decline'
);

-- =============================================================
-- 2. ADDITIONS TO claims
-- =============================================================

alter table claims
  add column if not exists submission_source           text,
  add column if not exists submitted_by                uuid,
  add column if not exists submitted_role              text,
  add column if not exists submitted_at                timestamptz,
  add column if not exists submission_payload          jsonb,
  add column if not exists mandate_band                mandate_band,
  add column if not exists decision_band_reason        text,
  add column if not exists supplier_name               text,
  add column if not exists supplier_contact            text,
  add column if not exists supplier_address            text,
  add column if not exists invoice_or_quote            text,
  add column if not exists invoice_quote_amount        decimal(12,2),
  add column if not exists vat_amount                  decimal(12,2),
  add column if not exists authorised_amount           decimal(12,2),
  add column if not exists net_authorisation_amount    decimal(12,2),
  add column if not exists banking_details_detected    boolean default false,
  add column if not exists banking_details_detected_notes text,
  add column if not exists handler_decision            handler_decision_type,
  add column if not exists handler_decision_by         uuid references handlers(id),
  add column if not exists handler_decision_at         timestamptz,
  add column if not exists handler_decision_notes      text,
  add column if not exists cardinal_loaded_at          timestamptz,
  add column if not exists cardinal_loaded_by          uuid references handlers(id),
  add column if not exists cardinal_docs_attached_at   timestamptz,
  add column if not exists cardinal_docs_attached_by   uuid references handlers(id),
  add column if not exists cardinal_claim_number       text;

create index if not exists idx_claims_mandate_band       on claims(mandate_band);
create index if not exists idx_claims_submission_source  on claims(submission_source);
create index if not exists idx_claims_handler_decision   on claims(handler_decision);
create index if not exists idx_claims_cardinal_loaded    on claims(cardinal_loaded_at) where cardinal_loaded_at is not null;

comment on column claims.banking_details_detected is
  'Set to true if banking/payment/account details appeared in source documents. Suri does not extract, transcribe, or store the actual banking content.';
comment on column claims.submission_payload is
  'Raw portal form submission preserved for audit. May be null for email-sourced claims.';

-- =============================================================
-- 3. ADDITIONS TO claim_ai_outputs
-- =============================================================

alter table claim_ai_outputs
  add column if not exists mandate_eligibility_result jsonb,
  add column if not exists mandate_band               mandate_band,
  add column if not exists mandate_band_reason        text,
  add column if not exists critical_unknowns          text[],
  add column if not exists rules_engine_version       text,
  add column if not exists banking_details_redacted   boolean default false,
  add column if not exists redaction_locations        text[];

create index if not exists idx_ai_outputs_mandate_band on claim_ai_outputs(mandate_band) where is_current = true;

comment on column claim_ai_outputs.mandate_eligibility_result is
  'Structured rules engine output. One entry per rule: {result, reason, is_critical, fail_action, details}.';
comment on column claim_ai_outputs.banking_details_redacted is
  'True if the banking-details safety guard had to strip content from Claude output. Investigate prompt/model behaviour if persistently true.';

-- =============================================================
-- 4. system_constants
-- =============================================================

create table system_constants (
  id                  uuid primary key default uuid_generate_v4(),
  key                 text not null unique,
  value               jsonb not null,
  data_type           text not null,            -- 'number'|'string'|'boolean'|'json'
  description         text,
  category            text,                     -- 'mandate'|'system'|'feature_flag'|'ai'|'claims'
  is_sensitive        boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  updated_by          uuid references handlers(id),
  last_change_reason  text
);

create index idx_system_constants_key      on system_constants(key);
create index idx_system_constants_category on system_constants(category);

comment on table system_constants is
  'Single source of truth for system-wide tunables (e.g. CLAIMS_PRE_MANDATE_LIMIT). Admin-write, audited.';

-- RLS
alter table system_constants enable row level security;

create policy "constants_read_authenticated" on system_constants
  for select using (
    auth.role() = 'authenticated'
    and (
      is_sensitive = false
      or coalesce(auth.jwt() ->> 'role', '') in ('admin', 'supervisor')
    )
  );

create policy "constants_update_admin" on system_constants
  for update
  using      (coalesce(auth.jwt() ->> 'role', '') = 'admin')
  with check (coalesce(auth.jwt() ->> 'role', '') = 'admin');

create policy "constants_insert_admin" on system_constants
  for insert
  with check (coalesce(auth.jwt() ->> 'role', '') = 'admin');

-- No DELETE policy. Constants cannot be deleted from any client role.

-- updated_at trigger
create trigger trg_system_constants_updated_at
  before update on system_constants
  for each row execute function set_updated_at();

-- Audit trigger — every change writes to audit_log
create or replace function audit_system_constant_change()
returns trigger as $$
begin
  insert into audit_log (
    actor_id, actor_type, action, before_state, after_state, notes
  ) values (
    new.updated_by,
    case when new.updated_by is null then 'system' else 'handler' end,
    'system_constant_updated',
    jsonb_build_object(
      'key', old.key,
      'value', old.value,
      'updated_at', old.updated_at,
      'updated_by', old.updated_by
    ),
    jsonb_build_object(
      'key', new.key,
      'value', new.value,
      'updated_at', new.updated_at,
      'updated_by', new.updated_by
    ),
    coalesce(new.last_change_reason, '(no reason provided)')
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger trg_audit_system_constants
  after update on system_constants
  for each row execute function audit_system_constant_change();

-- =============================================================
-- 5. mandate_rules
-- =============================================================

create table mandate_rules (
  id                      uuid primary key default uuid_generate_v4(),
  rule_code               text not null unique,
  description             text not null,
  rule_type               rule_type not null,
  is_critical             boolean not null default false,
  fail_action             rule_fail_action not null,
  applies_to_insurers     insurer[]    default '{}',  -- empty = all
  applies_to_claim_types  claim_type[] default '{}',  -- empty = all
  applies_to_perils       text[]       default '{}',  -- empty = all
  evaluator_key           text not null,
  config                  jsonb default '{}',
  display_order           int not null default 100,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index idx_mandate_rules_active   on mandate_rules(is_active);
create index idx_mandate_rules_critical on mandate_rules(is_critical);
create index idx_mandate_rules_display  on mandate_rules(display_order);

comment on table mandate_rules is
  'Deterministic checklist evaluated by rules-engine.js after Claude extraction.';

alter table mandate_rules enable row level security;
create policy "rules_read_authenticated" on mandate_rules
  for select using (auth.role() = 'authenticated');
-- Updates via service role only.

create trigger trg_mandate_rules_updated_at
  before update on mandate_rules
  for each row execute function set_updated_at();

-- =============================================================
-- 6. aol_packs
-- =============================================================

create table aol_packs (
  id                    uuid primary key default uuid_generate_v4(),
  claim_id              uuid not null references claims(id) on delete restrict,
  pack_version          int not null default 1,
  generated_at          timestamptz not null default now(),
  generated_by          uuid references handlers(id),
  pack_payload          jsonb not null,
  storage_path          text,                -- rendered HTML/PDF in Supabase Storage
  storage_mime_type     text,
  handler_decision      handler_decision_type,
  handler_decision_at   timestamptz,
  audit_ref             text not null,
  is_immutable          boolean not null default true,
  created_at            timestamptz not null default now(),
  unique (claim_id, pack_version)
);

create index idx_aol_packs_claim_id  on aol_packs(claim_id);
create index idx_aol_packs_audit_ref on aol_packs(audit_ref);

comment on table aol_packs is
  'Generated Agreement of Loss / authorisation packs. Immutable once created. New versions via pack_version increment.';

alter table aol_packs enable row level security;
create policy "aol_read_authenticated" on aol_packs
  for select using (auth.role() = 'authenticated');
-- Writes via service role only.

-- Immutability trigger — reject any UPDATE when is_immutable = true
create or replace function prevent_aol_pack_modification()
returns trigger as $$
begin
  if old.is_immutable = true then
    raise exception 'AOL pack % (claim %) is immutable. Generate a new pack version instead.',
      old.id, old.claim_id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_aol_packs_immutable
  before update on aol_packs
  for each row execute function prevent_aol_pack_modification();

-- Deletion guard — AOL packs cannot be deleted (audit retention)
create or replace function prevent_aol_pack_deletion()
returns trigger as $$
begin
  raise exception 'AOL packs cannot be deleted. Audit retention required.'
    using errcode = 'P0001';
end;
$$ language plpgsql;

create trigger trg_aol_packs_no_delete
  before delete on aol_packs
  for each row execute function prevent_aol_pack_deletion();

-- =============================================================
-- 7. handler_notifications
-- =============================================================

create table handler_notifications (
  id                uuid primary key default uuid_generate_v4(),
  claim_id          uuid not null references claims(id) on delete cascade,
  handler_id        uuid references handlers(id),
  notification_type text not null,           -- 'new_claim'|'missing_docs'|'escalation'|'aol_ready'|'rfi'
  routing_queue     text,                    -- 'admin_review'|'motor_handlers'|'non_motor_handlers'|'specialist_handlers'
  to_address        text not null,
  cc_addresses      text[] default '{}',
  subject           text not null,
  body_html         text not null,
  body_text         text,
  status            email_status not null default 'pending_approval',
  azure_message_id  text,
  sent_at           timestamptz,
  failure_reason    text,
  created_at        timestamptz not null default now()
);

create index idx_handler_notifications_claim_id on handler_notifications(claim_id);
create index idx_handler_notifications_status   on handler_notifications(status);
create index idx_handler_notifications_routing  on handler_notifications(routing_queue);

comment on table handler_notifications is
  'Handler-facing notifications drafted by Suri. Distinct from broker_emails. Send is gated by handler approval in Phase D.';

alter table handler_notifications enable row level security;
create policy "notif_read_authenticated" on handler_notifications
  for select using (auth.role() = 'authenticated');
create policy "notif_update_authenticated" on handler_notifications
  for update using (auth.role() = 'authenticated');

-- =============================================================
-- 8. SEED system_constants
-- =============================================================

insert into system_constants (key, value, data_type, description, category, is_sensitive) values
  ('CLAIMS_PRE_MANDATE_LIMIT', '30000', 'number',
   'Maximum claimed value (ZAR) eligible for pre-mandate authorisation recommendation. Hard mandate limit approved by management. Changes require an audit_log entry with last_change_reason.',
   'mandate', false),

  ('CLAIM_VALUE_STALENESS_DAYS', '120', 'number',
   'Maximum days between date of loss and current date for a claim to remain in normal intake. Beyond this, DATE_OF_LOSS_VALID fails.',
   'claims', false),

  ('AI_OVERALL_CONFIDENCE_THRESHOLD', '0.7', 'number',
   'Minimum overall Claude confidence required for Band 2/3 assignment. Below threshold = Band 1.',
   'ai', false),

  ('AI_CRITICAL_FIELD_CONFIDENCE_THRESHOLD', '0.85', 'number',
   'Minimum confidence required for critical extracted fields (policy_status, cause_of_loss).',
   'ai', false),

  ('RULES_ENGINE_VERSION', '"v1.0"', 'string',
   'Active version of the deterministic rules engine. Stored on each claim_ai_outputs row for reproducibility.',
   'system', false);

-- =============================================================
-- 9. SEED mandate_rules (12 core rules)
-- =============================================================

insert into mandate_rules
  (rule_code, description, rule_type, is_critical, fail_action,
   evaluator_key, applies_to_claim_types, display_order, config)
values
  ('AMOUNT_WITHIN_MANDATE',
   'Claimed amount must be within the pre-mandate limit (R30,000) as set in system_constants.',
   'threshold', true, 'block',
   'amount_within_mandate', '{}', 10, '{}'),

  ('CLAIM_TYPE_ELIGIBLE',
   'Claim type must be eligible for pre-mandate consideration. Specialist claims are not eligible.',
   'checklist', true, 'block',
   'claim_type_eligible', '{}', 20,
   '{"eligible_types": ["motor", "non_motor"]}'),

  ('POLICY_APPEARS_ACTIVE',
   'Policy status must appear active in supplied documents with sufficient confidence.',
   'extraction', true, 'block',
   'policy_appears_active', '{}', 30, '{}'),

  ('DATE_OF_LOSS_VALID',
   'Date of loss must be in the past, within staleness window, and within policy period if visible.',
   'derived', true, 'block',
   'date_of_loss_valid', '{}', 40, '{}'),

  ('REQUIRED_DOCUMENTS_PRESENT',
   'All required documents per the matched insurer rule pack must be present.',
   'checklist', true, 'block',
   'required_documents_present', '{}', 50, '{}'),

  ('INVOICE_OR_QUOTE_UPLOADED',
   'At least one invoice or quote document must be uploaded.',
   'checklist', true, 'block',
   'invoice_or_quote_uploaded', '{}', 60, '{}'),

  ('SUPPLIER_APPEARS_VALID',
   'Supplier name and contact must be extractable. Non-critical: warns only.',
   'extraction', false, 'warn',
   'supplier_appears_valid', '{}', 70, '{}'),

  ('CAUSE_SUDDEN_UNFORESEEN',
   'For non-motor claims, the cause of loss must appear sudden and unforeseen. Not applicable to motor claims.',
   'extraction', true, 'block',
   'cause_sudden_unforeseen', ARRAY['non_motor']::claim_type[], 80, '{}'),

  ('EXCESS_IDENTIFIABLE',
   'Excess amount must be identifiable from policy schedule or insurer rule. Non-critical: warns only.',
   'extraction', false, 'warn',
   'excess_identifiable', '{}', 90, '{}'),

  ('NO_EXCLUSION_TRIGGERED',
   'No language suggesting a policy exclusion may be detected in supporting documents.',
   'flag', true, 'block',
   'no_exclusion_triggered', '{}', 100, '{}'),

  ('NO_FRAUD_FLAG',
   'No open fraud flags exist for this claim in the fraud_flags table.',
   'flag', true, 'block',
   'no_fraud_flag', '{}', 110, '{}'),

  ('NO_MANAGEMENT_REFERRAL',
   'No insurer-specific referral rule has triggered (e.g. Hollard outsourced BDO authorisation).',
   'referral', true, 'block',
   'no_management_referral', '{}', 120, '{}');

commit;

-- =============================================================
-- END OF PHASE A MIGRATION
-- =============================================================
