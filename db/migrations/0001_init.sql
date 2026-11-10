CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE lead_status AS ENUM (
  'received','verified','researched','scored','drafted','qa_passed',
  'pending_approval','approved','queued','in_sequence','replied','completed',
  'suppressed','rejected','needs_review','failed'
);

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  icp             jsonb NOT NULL DEFAULT '{}'::jsonb,
  offer           jsonb NOT NULL DEFAULT '{}'::jsonb,
  sequence        jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  cooldown_days   int NOT NULL DEFAULT 90,
  daily_send_cap  int NOT NULL DEFAULT 150,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain          citext UNIQUE,
  name_clean      text NOT NULL,
  name_norm       text NOT NULL,
  industry        text,
  employee_range  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX companies_name_trgm ON companies USING gin (name_norm gin_trgm_ops);

CREATE TABLE region_rules (
  country  char(2) PRIMARY KEY,
  rule     text NOT NULL CHECK (rule IN ('allow','allow_with_note','restricted','blocked')),
  note     text
);

CREATE TABLE leads (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id            uuid NOT NULL REFERENCES campaigns(id),
  idempotency_key        text NOT NULL,
  email                  citext NOT NULL,
  email_domain           text GENERATED ALWAYS AS (lower(split_part(email::text, '@', 2))) STORED,
  first_name             text,
  last_name              text,
  full_name              text,
  title                  text,
  company_raw            text NOT NULL,
  company_clean          text,
  company_id             uuid REFERENCES companies(id),
  website                text,
  country                char(2),
  timezone               text,
  source                 text,
  source_ref             text,
  tags                   text[] NOT NULL DEFAULT '{}',
  raw_payload            jsonb,
  status                 lead_status NOT NULL DEFAULT 'received',
  status_reason          text,
  tier                   char(1) CHECK (tier IN ('A','B','C')),
  score                  numeric(5,2),
  score_breakdown        jsonb,
  consent_basis          text,
  flags                  text[] NOT NULL DEFAULT '{}',
  priority               int NOT NULL DEFAULT 0,
  attempts               int NOT NULL DEFAULT 0,
  locked_by              text,
  locked_at              timestamptz,
  next_attempt_at        timestamptz,
  last_error             text,
  sequence_stopped_reason text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX leads_idempotency_uq ON leads (idempotency_key);
CREATE UNIQUE INDEX leads_email_uq ON leads (email);
CREATE INDEX leads_status_idx ON leads (status, next_attempt_at);
CREATE INDEX leads_company_idx ON leads (company_id);

CREATE TABLE lead_status_transitions (
  from_status lead_status NOT NULL,
  to_status   lead_status NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

CREATE TABLE lead_transitions (
  id          bigserial PRIMARY KEY,
  lead_id     uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_status lead_status NOT NULL,
  to_status   lead_status NOT NULL,
  reason      text,
  actor       text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_transitions_lead_idx ON lead_transitions (lead_id, at);

CREATE TABLE verification_results (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  check_name  text NOT NULL,
  outcome     text NOT NULL CHECK (outcome IN ('pass','warn','fail','skipped')),
  provider    text,
  detail      jsonb,
  cost_usd    numeric(10,5) NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_results_lead_idx ON verification_results (lead_id);

CREATE TABLE suppression (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('email','domain','email_hash')),
  value       citext NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('unsubscribe','bounce_hard','bounce_soft_repeated','complaint','manual','erasure','wrong_person','competitor')),
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);

CREATE TABLE research_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  company_id    uuid REFERENCES companies(id),
  fact_type     text NOT NULL CHECK (fact_type IN ('company_summary','trigger_event','tech_stack','hiring','pain_point','product','other')),
  claim         text NOT NULL,
  source_url    text NOT NULL,
  snippet       text NOT NULL,
  confidence    numeric(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  content_hash  text,
  fetched_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_evidence_lead_idx ON research_evidence (lead_id);

CREATE TABLE drafts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  step           int NOT NULL CHECK (step BETWEEN 1 AND 5),
  variant        text NOT NULL,
  revision       int NOT NULL DEFAULT 0,
  subject        text,
  body           text NOT NULL,
  claims         jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_ids   uuid[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'generated' CHECK (status IN ('generated','qa_pass','qa_revise','qa_reject','approved','rejected','sent')),
  qa_report      jsonb,
  spam_risk      numeric(4,3),
  word_count     int,
  shingle_hashes bigint[] NOT NULL DEFAULT '{}',
  prompt_version text,
  model          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, step, variant, revision)
);
CREATE INDEX drafts_lead_idx ON drafts (lead_id);

CREATE TABLE approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel      text NOT NULL DEFAULT 'telegram',
  external_ref text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  reminded_at  timestamptz,
  decided_at   timestamptz,
  decision     text CHECK (decision IN ('approved','rejected','edited_approved','expired')),
  decided_by   text,
  reason       text
);

CREATE TABLE sending_domains (
  domain        citext PRIMARY KEY,
  spf_ok        boolean,
  dkim_ok       boolean,
  dmarc_ok      boolean,
  status        text NOT NULL DEFAULT 'warming' CHECK (status IN ('active','paused','warming')),
  paused_reason text,
  paused_at     timestamptz,
  checked_at    timestamptz
);

CREATE TABLE sender_inboxes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  domain        citext NOT NULL REFERENCES sending_domains(domain),
  provider      text NOT NULL DEFAULT 'mailpit',
  provider_ref  text,
  daily_limit   int NOT NULL DEFAULT 30,
  status        text NOT NULL DEFAULT 'warming' CHECK (status IN ('active','paused','warming')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sends (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  draft_id            uuid NOT NULL REFERENCES drafts(id),
  step                int NOT NULL,
  inbox_id            uuid REFERENCES sender_inboxes(id),
  mode                text NOT NULL CHECK (mode IN ('sandbox','live')),
  provider_ref        text,
  provider_message_id text,
  scheduled_at        timestamptz NOT NULL,
  sent_at             timestamptz,
  status              text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sent','failed','cancelled')),
  failure             text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, step)
);
CREATE INDEX sends_due_idx ON sends (status, scheduled_at);
CREATE INDEX sends_inbox_idx ON sends (inbox_id, sent_at);

CREATE TABLE events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id text,
  lead_id           uuid REFERENCES leads(id) ON DELETE CASCADE,
  send_id           uuid REFERENCES sends(id) ON DELETE SET NULL,
  type              text NOT NULL CHECK (type IN ('delivered','bounce_hard','bounce_soft','complaint','reply','unsubscribe','meeting_booked')),
  payload           jsonb,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX events_provider_uq ON events (provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX events_lead_idx ON events (lead_id);
CREATE INDEX events_send_idx ON events (send_id);

CREATE TABLE replies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  send_id            uuid REFERENCES sends(id) ON DELETE SET NULL,
  event_id           uuid REFERENCES events(id) ON DELETE SET NULL,
  body               text NOT NULL,
  classification     text CHECK (classification IN ('interested','objection','not_now','unsubscribe','out_of_office','bounce','wrong_person','other')),
  confidence         numeric(3,2),
  summary            text,
  suggested_response text,
  next_action        text CHECK (next_action IN ('notify_hot','draft_reply','wait','suppress','ignore','human_review')),
  handled_status     text NOT NULL DEFAULT 'open' CHECK (handled_status IN ('open','replied','dismissed')),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX replies_lead_idx ON replies (lead_id);

CREATE TABLE runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow     text NOT NULL,
  execution_id text,
  lead_id      uuid REFERENCES leads(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'started' CHECK (status IN ('started','succeeded','failed')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  latency_ms   int,
  error        jsonb
);
CREATE INDEX runs_workflow_idx ON runs (workflow, started_at);

CREATE TABLE llm_calls (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid REFERENCES runs(id) ON DELETE SET NULL,
  lead_id        uuid REFERENCES leads(id) ON DELETE SET NULL,
  agent          text NOT NULL,
  provider       text NOT NULL,
  model          text NOT NULL,
  prompt_version text NOT NULL,
  input_tokens   int,
  output_tokens  int,
  cost_usd       numeric(10,6) NOT NULL DEFAULT 0,
  latency_ms     int,
  status         text NOT NULL CHECK (status IN ('ok','schema_invalid','error','cached')),
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_calls_day_idx ON llm_calls (created_at);
CREATE INDEX llm_calls_lead_idx ON llm_calls (lead_id);

CREATE TABLE dead_letters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid REFERENCES leads(id) ON DELETE SET NULL,
  stage       text NOT NULL,
  workflow    text,
  payload     jsonb,
  error       text NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','requeued','dismissed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE prompt_versions (
  agent        text NOT NULL,
  version      text NOT NULL,
  content_hash text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent, version)
);

CREATE TABLE eval_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at  timestamptz NOT NULL DEFAULT now(),
  git_sha     text,
  mode        text NOT NULL,
  summary     jsonb
);

CREATE TABLE eval_results (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id    uuid NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  suite     text NOT NULL,
  case_id   text NOT NULL,
  passed    boolean NOT NULL,
  expected  jsonb,
  actual    jsonb
);

-- Allowed lead state transitions
INSERT INTO lead_status_transitions (from_status, to_status) VALUES
  ('received','verified'),('received','rejected'),('received','suppressed'),('received','needs_review'),
  ('verified','researched'),('verified','needs_review'),
  ('researched','scored'),('researched','needs_review'),
  ('scored','drafted'),('scored','rejected'),('scored','needs_review'),
  ('drafted','qa_passed'),('drafted','scored'),('drafted','needs_review'),
  ('qa_passed','pending_approval'),('qa_passed','approved'),
  ('pending_approval','approved'),('pending_approval','rejected'),('pending_approval','needs_review'),
  ('approved','queued'),('approved','suppressed'),('approved','needs_review'),
  ('queued','in_sequence'),('queued','suppressed'),
  ('in_sequence','replied'),('in_sequence','completed'),('in_sequence','suppressed'),
  ('replied','completed'),('replied','suppressed'),
  ('needs_review','verified'),('needs_review','researched'),('needs_review','scored'),
  ('needs_review','approved'),('needs_review','rejected'),
  ('failed','received'),('failed','verified'),('failed','researched'),('failed','scored'),
  ('failed','drafted'),('failed','qa_passed'),('failed','approved');

INSERT INTO settings (key, value) VALUES
  ('kill_switch', 'false'::jsonb),
  ('llm_paused', 'false'::jsonb),
  ('llm_daily_budget_usd', '5'::jsonb);

-- Helpers
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

CREATE TRIGGER leads_set_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION is_suppressed(p_email citext) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM suppression s
    WHERE (s.kind = 'email' AND s.value = p_email)
       OR (s.kind = 'domain' AND s.value = lower(split_part(p_email::text, '@', 2))::citext)
       OR (s.kind = 'email_hash' AND s.value = encode(digest(lower(p_email::text), 'sha256'), 'hex')::citext)
  );
$$;

CREATE OR REPLACE FUNCTION transition_lead(
  p_lead uuid, p_from lead_status, p_to lead_status, p_reason text, p_actor text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_updated int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM lead_status_transitions WHERE from_status = p_from AND to_status = p_to
  ) THEN
    RAISE EXCEPTION 'illegal transition % -> %', p_from, p_to USING ERRCODE = 'check_violation';
  END IF;

  UPDATE leads
     SET status = p_to, status_reason = p_reason,
         locked_by = NULL, locked_at = NULL, attempts = 0,
         next_attempt_at = NULL, last_error = NULL
   WHERE id = p_lead AND status = p_from;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RAISE EXCEPTION 'lead % is not in status % (stale transition)', p_lead, p_from
      USING ERRCODE = 'serialization_failure';
  END IF;

  INSERT INTO lead_transitions (lead_id, from_status, to_status, reason, actor)
  VALUES (p_lead, p_from, p_to, p_reason, p_actor);
END $$;

CREATE OR REPLACE FUNCTION claim_leads(
  p_status lead_status, p_limit int, p_worker text, p_lease interval DEFAULT interval '10 minutes'
) RETURNS SETOF leads LANGUAGE sql AS $$
  WITH picked AS (
    SELECT id FROM leads
     WHERE status = p_status
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       AND (locked_at IS NULL OR locked_at < now() - p_lease)
     ORDER BY priority DESC, created_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE leads l
     SET locked_by = p_worker, locked_at = now(), attempts = l.attempts + 1
    FROM picked
   WHERE l.id = picked.id
  RETURNING l.*;
$$;

CREATE OR REPLACE FUNCTION release_lead(
  p_lead uuid, p_error text, p_max_attempts int DEFAULT 5
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_attempts int; v_status lead_status;
BEGIN
  SELECT attempts, status INTO v_attempts, v_status FROM leads WHERE id = p_lead FOR UPDATE;

  IF v_attempts >= p_max_attempts THEN
    INSERT INTO dead_letters (lead_id, stage, error, attempts)
    VALUES (p_lead, v_status::text, p_error, v_attempts);
    UPDATE leads
       SET status = 'failed', status_reason = left(p_error, 500), last_error = left(p_error, 1000),
           locked_by = NULL, locked_at = NULL
     WHERE id = p_lead;
    INSERT INTO lead_transitions (lead_id, from_status, to_status, reason, actor)
    VALUES (p_lead, v_status, 'failed', left(p_error, 500), 'release_lead');
    RETURN false;
  END IF;

  UPDATE leads
     SET locked_by = NULL, locked_at = NULL, last_error = left(p_error, 1000),
         next_attempt_at = now() + (interval '30 seconds' * power(2, v_attempts))
   WHERE id = p_lead;
  RETURN true;
END $$;

-- Dashboard and guardian views
CREATE OR REPLACE VIEW v_funnel AS
SELECT status, count(*) AS leads FROM leads GROUP BY status;

CREATE OR REPLACE VIEW v_domain_health AS
SELECT i.domain,
       count(DISTINCT s.id) FILTER (WHERE s.status = 'sent' AND s.sent_at > now() - interval '7 days') AS sends_7d,
       count(DISTINCT e.id) FILTER (WHERE e.type = 'bounce_hard' AND e.occurred_at > now() - interval '7 days') AS hard_bounces_7d,
       count(DISTINCT e.id) FILTER (WHERE e.type = 'complaint' AND e.occurred_at > now() - interval '7 days') AS complaints_7d
FROM sender_inboxes i
LEFT JOIN sends s ON s.inbox_id = i.id
LEFT JOIN events e ON e.send_id = s.id
GROUP BY i.domain;

CREATE OR REPLACE VIEW v_domain_health_rates AS
SELECT domain, sends_7d, hard_bounces_7d, complaints_7d,
       hard_bounces_7d::numeric / NULLIF(sends_7d, 0) AS hard_bounce_rate,
       complaints_7d::numeric / NULLIF(sends_7d, 0) AS complaint_rate
FROM v_domain_health;

CREATE OR REPLACE VIEW v_cost_per_lead AS
SELECT l.id AS lead_id, l.status,
       COALESCE((SELECT sum(c.cost_usd) FROM llm_calls c WHERE c.lead_id = l.id), 0) AS llm_cost_usd,
       COALESCE((SELECT sum(v.cost_usd) FROM verification_results v WHERE v.lead_id = l.id), 0) AS verification_cost_usd
FROM leads l;

CREATE OR REPLACE VIEW v_variant_performance AS
SELECT d.variant, d.step,
       count(DISTINCT s.id) FILTER (WHERE s.status = 'sent') AS sends,
       count(DISTINCT r.id) AS replies,
       count(DISTINCT r.id) FILTER (WHERE r.classification = 'interested') AS positive_replies
FROM drafts d
JOIN sends s ON s.draft_id = d.id
LEFT JOIN replies r ON r.send_id = s.id
GROUP BY d.variant, d.step;

CREATE OR REPLACE VIEW v_llm_spend_today AS
SELECT COALESCE(sum(cost_usd), 0) AS usd
FROM llm_calls
WHERE created_at >= date_trunc('day', now());
