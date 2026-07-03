# Suri Deployment Runbook & Go-Live Checklist

For: `suri-worker` (Cloudflare) + `suri-portal` (Vercel) + Supabase.
Related docs: [BOUNDARY.md](BOUNDARY.md) (banking boundary), [PRIVACY.md](PRIVACY.md) (POPIA/retention).

## 1. Prerequisites

- Cloudflare account with Workers, Queues, and Workers Rate Limiting available
- Supabase project (note the region for PRIVACY.md §5)
- Azure AD app registration with Graph application permissions: `Mail.ReadWrite` for the `newclaims` mailbox (admin-consented; ReadWrite is needed for Outlook categories — Suri never sends email)
- Anthropic API key
- Cloudflare Turnstile widget (site key + secret) for the portal domain
- Vercel project connected to the `Suri` (portal) repo

## 2. Supabase — migrations (SQL editor, in this exact order)

1. `suri_schema.sql` (fresh installs only)
2. `suri_phase_a_migration.sql`
3. `suri_phase0_migration.sql`
4. `suri_phase2b_migration.sql` — run its preflight checks first (see the file header and the Phase 2B report)

Then verify bucket privacy:

```sql
select id, public from storage.buckets where id = 'claim-documents';  -- must be false
select policyname, roles, cmd from pg_policies
 where schemaname = 'storage' and tablename = 'objects';              -- nothing permissive for anon/authenticated
```

Storage: create bucket `claim-documents` (PRIVATE) if it does not exist.

## 3. Cloudflare — queues (once)

```bash
wrangler queues create suri-processing-queue
wrangler queues create suri-dead-letter-queue
```

## 4. Cloudflare — vars to edit BEFORE deploy (wrangler.toml)

| Var | File | Set to |
|---|---|---|
| `PORTAL_ORIGINS` | wrangler.toml | Real portal origin(s), comma-separated. No localhost. **Ships as a placeholder — deploy fails safe (portal blocked) if forgotten** |
| `WORKER_PUBLIC_URL` | wrangler.toml | Deployed ingestion worker URL, no trailing slash. Needed by the M365 renewal cron to recreate a lapsed subscription |

## 5. Cloudflare — secrets

Ingestion worker (`wrangler secret put NAME`):
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TURNSTILE_SECRET`, `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `SURI_MAILBOX` (the `newclaims`
mailbox), `M365_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY` (Phase C1 Haiku triage),
`ADMIN_DIAGNOSTICS_SECRET` (optional — `/admin/diagnostics` stays 404 until set).

Phase C1 Azure requirement: the app registration needs **Mail.ReadWrite**
(admin-consented) so Suri can apply Outlook categories. Suri never sends email.

Processor (`wrangler secret put NAME --config wrangler.processor.toml`):
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`.

## 6. Deploy

```bash
npm test                                        # 74/74 must pass
wrangler deploy                                 # ingestion worker (+ cron trigger)
wrangler deploy --config wrangler.processor.toml  # queue consumer
```

Portal (Vercel): push → import → env vars `NEXT_PUBLIC_SURI_WORKER_URL`,
`NEXT_PUBLIC_TURNSTILE_SITE_KEY` → deploy. Then confirm `PORTAL_ORIGINS` on the
worker matches the deployed Vercel domain exactly (scheme + host).

## 7. M365 webhook

The cron (`0 */12 * * *`) renews the Graph subscription automatically and
recreates it if lapsed (requires `WORKER_PUBLIC_URL`). For the first run you can
either wait for the cron, trigger it manually (Cloudflare dashboard → Workers →
suri-worker → Triggers → cron → Run), or run the legacy one-off script
`node m365-webhook-setup.js`. Verify state afterwards:

```sql
select value from system_constants where key = 'M365_SUBSCRIPTION_STATE';
select action, created_at, notes from audit_log
 where action like 'm365_%' order by created_at desc limit 5;
```

## 8. Smoke tests after deploy

1. `curl https://<worker>/health` → `"status":"ok"`, all checks green (503/degraded tells you what's missing by name).
2. `curl -X POST "https://<worker>/webhooks/email?validationToken=ping"` → `ping`.
3. Submit a test claim from the deployed portal → 202 + claim ref; claim reaches `pending_review` with a mandate band; broker draft email exists (`pending_approval`).
4. Replay the same submission → 200 `duplicate: true`, same ref, one claim row.
5. Send a test email with "claim" in the subject + PDF to the mailbox → claim created (proves subscription live).
6. `curl -H "x-suri-admin-key: <secret>" https://<worker>/admin/diagnostics` → counts JSON; without the header → 401; with no secret configured → 404.
7. Attempt an unauthenticated fetch of a stored document URL → 400/403.
8. `wrangler tail` / `wrangler tail --config wrangler.processor.toml` while running steps 3–5: no unexpected errors.

## 9. Monitoring cadence (until proper alerting exists)

- **Daily:** hit `/admin/diagnostics` — investigate any `stuck_processing`, `error_claims`, or `ai_processing_failures_7d` > 0; watch `banking_redactions` (persistently high ⇒ prompt/model drift, see BOUNDARY.md).
- **Daily:** `/health` — `m365_subscription.status` must be `ok` (a monitor on HTTP 200 vs 503 works out of the box).
- **Weekly:** check the DLQ (Cloudflare dashboard → Queues → suri-dead-letter-queue) for poisoned messages; each corresponds to a claim in `error`.
- Optional: point an uptime monitor (e.g. simple HTTP check) at `/health` — it returns 503 when degraded.

## 10. Rollback notes

- Workers: `wrangler rollback` (or `wrangler deployments list` + rollback to a prior version) per worker; ingestion and processor roll back independently.
- Portal: Vercel → Deployments → promote previous deployment.
- Migrations are additive/idempotent; no rollback is expected. If Phase 2B must be reversed, only the RLS policy drops are meaningfully reversible (recreate from `suri_schema.sql`); do NOT remove the audit-log triggers or re-publicise the bucket without a decision recorded in `audit_log`.
- Worker/schema coupling: the Phase 2B worker requires the Phase 2B migration (idempotency column). Never deploy a worker ahead of its migration.

## 11. Known failure modes

| Symptom | Likely cause | Action |
|---|---|---|
| Portal submissions all fail with CORS errors | `PORTAL_ORIGINS` placeholder/wrong domain | Fix var, redeploy worker |
| Portal 429s for legitimate brokers | Shared office IP hitting 5/min limit | Raise limit in `[[ratelimits]]` |
| No email claims arriving | Graph subscription lapsed | Check `/health` `m365_subscription`; check `m365_renewal_failed` audit rows; verify `WORKER_PUBLIC_URL`; trigger cron manually |
| Claims stuck in `processing` | Processor not deployed / secrets missing / Claude outage | `/admin/diagnostics`; `wrangler tail --config wrangler.processor.toml`; failed claims eventually land in `error` + DLQ |
| Claims in `error` | Poison message after 3 attempts | Read `ai_processing_failed` audit note; fix cause; re-queue by sending a new `process_claim` message or reprocess manually |
| `/health` 503 with `supabase: fail` | Supabase down/creds wrong | Verify `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` secrets |
| `banking_details_redacted` spiking | Model drift against the no-banking prompt | Review prompt/model version; boundary held (content was stripped), but investigate per BOUNDARY.md |
| Duplicate email claims | `inbound_emails.message_id` dedupe bypassed (e.g. mailbox migration changed ids) | Investigate before deleting anything |

## 12. CI

GitHub Actions in both repos (`.github/workflows/ci.yml`): worker — syntax
checks + 74 zero-dependency tests; portal — `npm ci`, `tsc --noEmit`,
`next build`. Keep both green before any deploy.
