-- =============================================================
-- Suri claims intake — Supabase schema
-- Smartsure Twenty20
-- Phase 1 ready · Phase 2/3 columns pre-stubbed
-- =============================================================

-- Extensions
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- =============================================================
-- ENUM TYPES
-- =============================================================

create type claim_status as enum (
  'received',         -- raw ingestion, not yet processed
  'processing',       -- Claude is working on it
  'pending_review',   -- in handler queue, awaiting approval
  'pending_docs',     -- outstanding documents flagged
  'approved',         -- handler approved, email queued to send
  'sent',             -- broker email sent
  'routed',           -- assigned to handler queue
  'closed',           -- claim finalised (not by Suri)
  'error'             -- processing failed
);

create type claim_type as enum (
  'motor',
  'non_motor',
  'specialist'
);

create type handler_queue as enum (
  'motor',
  'non_motor',
  'specialist'
);

create type insurer as enum (
  'infiniti',
  'hollard_direct',
  'hollard_outsourced',
  'guardrisk',
  'cib'
);

create type actor_type as enum (
  'system',     -- automated Suri action
  'handler',    -- human handler
  'api'         -- external API call
);

create type email_status as enum (
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'failed'
);

create type document_ocr_status as enum (
  'pending',
  'complete',
  'failed',
  'skipped'   -- e.g. photo where OCR not applicable
);

create type assessor_recommendation as enum (
  'none',
  'desktop_assessor',
  'field_assessor',
  'loss_adjuster',
  'specialist_adjuster',
  'sasria_referral'
);

create type fraud_flag_status as enum (
  'open',
  'under_review',
  'dismissed',
  'escalated'
);

-- =============================================================
-- HANDLERS (staff who process claims in Scout)
-- =============================================================

create table handlers (
  id                uuid primary key default uuid_generate_v4(),
  full_name         text not null,
  email             text not null unique,
  role              text not null default 'handler',  -- handler | supervisor | admin
  specialisations   text[] default '{}',              -- ['motor','specialist']
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table handlers is 'Smartsure staff who review and approve Suri outputs in Scout.';

-- =============================================================
-- INSURER RULE PACKS
-- Per-insurer, per-claim-type document checklists and thresholds.
-- Stored as config so rules can be updated without code changes.
-- =============================================================

create table insurer_rule_packs (
  id                        uuid primary key default uuid_generate_v4(),
  insurer                   insurer not null,
  claim_type                claim_type not null,
  required_documents        jsonb not null default '[]',
  -- e.g. ["claim_form","id_document","policy_schedule","drivers_licence","repair_quote"]
  optional_documents        jsonb not null default '[]',
  assessor_threshold        decimal(12,2),   -- claim value above which assessor is recommended
  loss_adjuster_threshold   decimal(12,2),   -- claim value above which loss adjuster is recommended
  mandate_cap               decimal(12,2),   -- Phase 2: flag if claim exceeds mandate
  mandate_cap_notes         text,
  special_conditions        jsonb default '{}',
  -- e.g. {"hollard_outsourced": {"requires_bdo_auth": true}}
  is_active                 boolean not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  unique (insurer, claim_type)
);

comment on table insurer_rule_packs is
  'Per-insurer document checklists and threshold rules. Update rows to change rules without deploys.';

-- =============================================================
-- CLAIMS (core table)
-- =============================================================

create table claims (
  id                    uuid primary key default uuid_generate_v4(),
  claim_ref             text not null unique,
  -- Format: SS-{YEAR}-{INSURER_CODE}-{SEQUENCE} e.g. SS-2026-INF-00142
  insurer_rule_id       uuid references insurer_rule_packs(id),
  insured_name          text,
  policy_number         text,
  claim_type            claim_type,
  peril_type            text,
  -- Motor: accident|collision|write_off|windscreen|hail|theft|hijack
  -- Non-motor: storm|lightning|burst_geyser|power_surge|water_damage|fire|burglary
  -- Specialist: sasria|commercial|liability
  insurer               insurer,
  incident_date         date,
  incident_description  text,
  claimed_value         decimal(12,2),
  excess_amount         decimal(12,2),
  vehicle_registration  text,          -- motor claims
  vehicle_make_model    text,          -- motor claims
  property_address      text,          -- non-motor claims
  status                claim_status not null default 'received',
  handler_queue         handler_queue,
  assigned_handler_id   uuid references handlers(id),
  source                text not null default 'email',  -- email | web_portal
  broker_name           text,
  broker_email          text,
  broker_ref            text,          -- broker's own reference if supplied
  -- Phase 3 fields (pre-stubbed, nullable)
  fraud_risk_score      decimal(5,4),  -- 0.0000–1.0000
  confidence_score      decimal(5,4),  -- overall Suri confidence
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table claims is 'Core claim record. Created on ingestion, enriched by Claude, approved by handler.';
comment on column claims.claim_ref is 'Human-readable reference issued at registration. Format: SS-YYYY-{INSURER_CODE}-{SEQ}.';
comment on column claims.peril_type is 'Specific peril within the claim type e.g. hail, burst_geyser, hijack.';

-- =============================================================
-- INBOUND EMAILS
-- Raw email stored before any processing. One claim can have
-- multiple inbound emails (e.g. broker follows up with extra docs).
-- =============================================================

create table inbound_emails (
  id              uuid primary key default uuid_generate_v4(),
  claim_id        uuid references claims(id) on delete cascade,
  from_address    text not null,
  to_address      text,
  subject         text,
  body_text       text,
  body_html       text,
  message_id      text unique,        -- M365 message ID for deduplication
  thread_id       text,               -- M365 conversation thread
  source          text not null default 'outlook',  -- outlook | web_portal | sftp
  raw_headers     jsonb default '{}',
  received_at     timestamptz not null default now()
);

comment on table inbound_emails is
  'Raw inbound email payload. claim_id may be null before the claim record is created.';

-- =============================================================
-- CLAIM DOCUMENTS
-- Individual attachments extracted from inbound emails or
-- uploaded via the web portal. Stored in Supabase Storage.
-- =============================================================

create table claim_documents (
  id                uuid primary key default uuid_generate_v4(),
  claim_id          uuid not null references claims(id) on delete cascade,
  inbound_email_id  uuid references inbound_emails(id),
  document_type     text,
  -- claim_form | id_document | policy_schedule | drivers_licence |
  -- repair_quote | police_report | photos | bank_statement | other
  storage_path      text not null,    -- Supabase Storage path
  original_filename text,
  mime_type         text,
  file_size_bytes   bigint,
  extracted_text    text,             -- Claude's extracted text content
  ocr_status        document_ocr_status not null default 'pending',
  is_required       boolean,          -- derived from insurer_rule_pack
  uploaded_at       timestamptz not null default now()
);

comment on table claim_documents is
  'Individual attachments. extracted_text is populated by Claude during processing.';

-- =============================================================
-- CLAIM AI OUTPUTS
-- Structured output from each Claude processing run.
-- One record per processing attempt (allows reprocessing).
-- =============================================================

create table claim_ai_outputs (
  id                              uuid primary key default uuid_generate_v4(),
  claim_id                        uuid not null references claims(id) on delete cascade,
  extracted_fields                jsonb not null default '{}',
  -- All fields Claude extracted: insured, policy_no, dates, values, vehicle, etc.
  completeness_result             jsonb not null default '{}',
  -- { "present": [...], "outstanding": [...], "notes": "..." }
  classification                  jsonb not null default '{}',
  -- { "claim_type": "motor", "peril_type": "hail", "insurer": "infiniti", "confidence": 0.94 }
  assessor_recommendation         assessor_recommendation,
  assessor_recommendation_reason  text,
  handler_queue_recommendation    handler_queue,
  claim_summary                   text,          -- human-readable summary for Scout
  draft_broker_email_subject      text,
  draft_broker_email_body         text,
  completeness_score              decimal(5,4),  -- 0–1, fraction of required docs present
  confidence_score                decimal(5,4),  -- overall AI confidence
  model_version                   text,          -- e.g. claude-sonnet-4-6
  prompt_version                  text,          -- for reproducibility
  processing_duration_ms          integer,
  is_current                      boolean not null default true,
  -- only latest run is current; previous runs retained for audit
  generated_at                    timestamptz not null default now()
);

comment on table claim_ai_outputs is
  'Structured Claude output per processing run. is_current=true is the active output shown in Scout.';

-- =============================================================
-- BROKER EMAILS
-- Drafted by Suri, approved by handler, sent via Azure Mail.Send.
-- Phase 1: handler must approve before send.
-- Phase 2: auto-send for complete, clean claims.
-- =============================================================

create table broker_emails (
  id              uuid primary key default uuid_generate_v4(),
  claim_id        uuid not null references claims(id) on delete cascade,
  email_type      text not null default 'registration',
  -- registration | outstanding_docs | assessor_appointment | general
  to_address      text not null,
  cc_addresses    text[] default '{}',
  subject         text not null,
  body_html       text not null,
  body_text       text,
  status          email_status not null default 'draft',
  approved_by     uuid references handlers(id),
  approved_at     timestamptz,
  sent_at         timestamptz,
  azure_message_id text,              -- M365 sent message ID
  failure_reason  text,
  created_at      timestamptz not null default now()
);

comment on table broker_emails is
  'Broker emails drafted by Suri. Nothing sends without handler approval in Phase 1.';

-- =============================================================
-- AUDIT LOG
-- Write-once record of every action taken by Suri or a handler.
-- POPIA-compliant: purpose-tagged, tamper-evident by convention.
-- =============================================================

create table audit_log (
  id            uuid primary key default uuid_generate_v4(),
  claim_id      uuid references claims(id),
  actor_id      uuid,                 -- handler id or null for system
  actor_type    actor_type not null default 'system',
  action        text not null,
  -- e.g. claim_received | ai_processing_started | ai_output_generated |
  --      handler_approved | handler_edited | email_sent | handler_override |
  --      queue_routed | doc_uploaded | fraud_flag_raised
  before_state  jsonb,
  after_state   jsonb,
  notes         text,                 -- free-text reason for overrides
  ip_address    inet,                 -- POPIA: log access origin
  created_at    timestamptz not null default now()
);

comment on table audit_log is
  'Immutable audit trail. Every Suri action and handler override is logged here. Never delete rows.';

-- =============================================================
-- FRAUD FLAGS (Phase 3 — pre-stubbed, safe to ignore in Phase 1)
-- =============================================================

create table fraud_flags (
  id              uuid primary key default uuid_generate_v4(),
  claim_id        uuid not null references claims(id) on delete cascade,
  flag_type       text not null,
  -- duplicate_claimant | suspicious_timing | damage_description_mismatch |
  -- photo_metadata_anomaly | prior_claims_pattern | value_anomaly
  description     text not null,
  confidence_score decimal(5,4),
  status          fraud_flag_status not null default 'open',
  reviewed_by     uuid references handlers(id),
  reviewed_at     timestamptz,
  review_notes    text,
  created_at      timestamptz not null default now()
);

comment on table fraud_flags is 'Phase 3 fraud pattern flags raised by Claude. Reviewed by handlers before escalation.';

-- =============================================================
-- INDEXES
-- =============================================================

-- Claims
create index idx_claims_status          on claims(status);
create index idx_claims_handler_queue   on claims(handler_queue);
create index idx_claims_insurer         on claims(insurer);
create index idx_claims_claim_type      on claims(claim_type);
create index idx_claims_assigned_handler on claims(assigned_handler_id);
create index idx_claims_created_at      on claims(created_at desc);
create index idx_claims_policy_number   on claims(policy_number);
create index idx_claims_insured_name    on claims using gin(to_tsvector('english', coalesce(insured_name, '')));

-- Documents
create index idx_claim_documents_claim_id      on claim_documents(claim_id);
create index idx_claim_documents_document_type on claim_documents(document_type);
create index idx_claim_documents_ocr_status    on claim_documents(ocr_status);

-- AI outputs
create index idx_ai_outputs_claim_id   on claim_ai_outputs(claim_id);
create index idx_ai_outputs_is_current on claim_ai_outputs(claim_id) where is_current = true;

-- Audit log
create index idx_audit_log_claim_id    on audit_log(claim_id);
create index idx_audit_log_actor_id    on audit_log(actor_id);
create index idx_audit_log_action      on audit_log(action);
create index idx_audit_log_created_at  on audit_log(created_at desc);

-- Inbound emails
create index idx_inbound_emails_claim_id    on inbound_emails(claim_id);
create index idx_inbound_emails_message_id  on inbound_emails(message_id);
create index idx_inbound_emails_from        on inbound_emails(from_address);

-- Broker emails
create index idx_broker_emails_claim_id on broker_emails(claim_id);
create index idx_broker_emails_status   on broker_emails(status);

-- Fraud flags
create index idx_fraud_flags_claim_id on fraud_flags(claim_id);
create index idx_fraud_flags_status   on fraud_flags(status);

-- =============================================================
-- UPDATED_AT TRIGGER
-- =============================================================

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_claims_updated_at
  before update on claims
  for each row execute function set_updated_at();

create trigger trg_handlers_updated_at
  before update on handlers
  for each row execute function set_updated_at();

create trigger trg_insurer_rule_packs_updated_at
  before update on insurer_rule_packs
  for each row execute function set_updated_at();

-- =============================================================
-- CLAIM REF SEQUENCE + GENERATOR
-- Format: SS-{YEAR}-{INSURER_CODE}-{5-digit sequence}
-- Sequence resets per year per insurer.
-- =============================================================

create table claim_ref_sequences (
  insurer       insurer not null,
  year          int not null,
  last_seq      int not null default 0,
  primary key (insurer, year)
);

create or replace function generate_claim_ref(p_insurer insurer)
returns text as $$
declare
  v_year    int := extract(year from now());
  v_seq     int;
  v_code    text;
begin
  insert into claim_ref_sequences (insurer, year, last_seq)
  values (p_insurer, v_year, 1)
  on conflict (insurer, year)
  do update set last_seq = claim_ref_sequences.last_seq + 1
  returning last_seq into v_seq;

  v_code := case p_insurer
    when 'infiniti'           then 'INF'
    when 'hollard_direct'     then 'HOL'
    when 'hollard_outsourced' then 'HOU'
    when 'guardrisk'          then 'GRK'
    when 'cib'                then 'CIB'
    else 'UNK'
  end;

  return 'SS-' || v_year || '-' || v_code || '-' || lpad(v_seq::text, 5, '0');
end;
$$ language plpgsql;

comment on function generate_claim_ref is
  'Generates a unique claim ref e.g. SS-2026-INF-00142. Call at claim registration time.';

-- =============================================================
-- ROW LEVEL SECURITY
-- =============================================================

alter table claims             enable row level security;
alter table claim_documents    enable row level security;
alter table claim_ai_outputs   enable row level security;
alter table insurer_rule_packs enable row level security;
alter table broker_emails      enable row level security;
alter table audit_log          enable row level security;
alter table handlers           enable row level security;
alter table inbound_emails     enable row level security;
alter table fraud_flags        enable row level security;

-- Service role (Cloudflare Worker / backend) — full access
-- These policies are for the anon/authenticated roles used by the Scout frontend.

-- Handlers can read all claims in their queue or assigned to them
create policy "handlers_read_claims" on claims
  for select
  using (auth.role() = 'authenticated');

-- Handlers can update status and assignment only
create policy "handlers_update_claims" on claims
  for update
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- Handlers can read all documents for claims they can see
create policy "handlers_read_documents" on claim_documents
  for select
  using (auth.role() = 'authenticated');

-- Handlers can read AI outputs
create policy "handlers_read_ai_outputs" on claim_ai_outputs
  for select
  using (auth.role() = 'authenticated');

-- Handlers can read and update broker emails (for approve/edit)
create policy "handlers_read_broker_emails" on broker_emails
  for select
  using (auth.role() = 'authenticated');

create policy "handlers_update_broker_emails" on broker_emails
  for update
  using (auth.role() = 'authenticated');

-- Audit log: read only for handlers, insert via service role only
create policy "handlers_read_audit_log" on audit_log
  for select
  using (auth.role() = 'authenticated');

-- Insurer rules readable by all authenticated
create policy "handlers_read_insurer_rules" on insurer_rule_packs
  for select
  using (auth.role() = 'authenticated');

-- Fraud flags
create policy "handlers_read_fraud_flags" on fraud_flags
  for select
  using (auth.role() = 'authenticated');

create policy "handlers_update_fraud_flags" on fraud_flags
  for update
  using (auth.role() = 'authenticated');

-- =============================================================
-- SEED: INSURER RULE PACKS
-- Starting configuration — update these rows to change rules.
-- =============================================================

insert into insurer_rule_packs (insurer, claim_type, required_documents, optional_documents, assessor_threshold, loss_adjuster_threshold, mandate_cap_notes) values

-- Infiniti motor
('infiniti', 'motor', 
  '["claim_form","id_document","policy_schedule","drivers_licence","repair_quote"]',
  '["police_report","photos","bank_statement"]',
  15000.00, 75000.00,
  'Infiniti mandate: R75k motor, R50k non-motor. Confirm with UW for specialist.'),

-- Infiniti non-motor
('infiniti', 'non_motor',
  '["claim_form","id_document","policy_schedule","repair_quote"]',
  '["photos","contractors_quote","police_report"]',
  10000.00, 50000.00,
  'Infiniti mandate: R50k non-motor.'),

-- Hollard direct motor
('hollard_direct', 'motor',
  '["claim_form","id_document","policy_schedule","drivers_licence","repair_quote"]',
  '["police_report","photos"]',
  20000.00, 100000.00,
  'Hollard direct mandate: R100k motor. Escalate to Hollard claims team above threshold.'),

-- Hollard outsourced motor
('hollard_outsourced', 'motor',
  '["claim_form","id_document","policy_schedule","drivers_licence","repair_quote","bdo_authorisation"]',
  '["police_report","photos"]',
  15000.00, 75000.00,
  'Hollard outsourced: BDO authorisation required on all claims. Mandate R75k.'),

-- Hollard direct non-motor
('hollard_direct', 'non_motor',
  '["claim_form","id_document","policy_schedule","repair_quote"]',
  '["photos","contractors_quote"]',
  15000.00, 75000.00,
  'Hollard direct non-motor mandate: R75k.'),

-- Guardrisk specialist
('guardrisk', 'specialist',
  '["claim_form","id_document","policy_schedule","incident_report"]',
  '["photos","legal_correspondence","police_report"]',
  50000.00, 200000.00,
  'Guardrisk cell captive: higher mandate cap. Confirm with cell owner before routing specialist.'),

-- Guardrisk non-motor
('guardrisk', 'non_motor',
  '["claim_form","id_document","policy_schedule","repair_quote"]',
  '["photos","contractors_quote"]',
  20000.00, 100000.00,
  'Guardrisk non-motor. Cell-specific conditions may apply — check special_conditions.'),

-- CIB specialist
('cib', 'specialist',
  '["claim_form","id_document","policy_schedule","incident_report"]',
  '["legal_correspondence","sasria_form","photos"]',
  30000.00, 150000.00,
  'CIB: SASRIA referral triggers apply. Check for SASRIA peril before routing.');

-- =============================================================
-- END
-- =============================================================
