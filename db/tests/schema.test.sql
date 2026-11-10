-- Schema behaviour tests. Every block raises on failure; run with ON_ERROR_STOP=on.
-- Applied after db/migrations/0001_init.sql and the seeds.

INSERT INTO campaigns (name, status) VALUES ('schema-test', 'active');

CREATE TEMP TABLE ctx AS SELECT id AS cid FROM campaigns WHERE name = 'schema-test';

INSERT INTO leads (campaign_id, idempotency_key, email, company_raw)
SELECT cid, 'st-1', 'Alice@Example.com', 'Acme' FROM ctx;
INSERT INTO leads (campaign_id, idempotency_key, email, company_raw)
SELECT cid, 'st-2', 'bob@example.com', 'Acme' FROM ctx;

-- 1. claim_leads hands out distinct leads and then nothing
DO $$
DECLARE a uuid; b uuid; c uuid;
BEGIN
  SELECT id INTO a FROM claim_leads('received', 1, 'w1') WHERE email IN ('alice@example.com', 'bob@example.com');
  SELECT id INTO b FROM claim_leads('received', 1, 'w2') WHERE email IN ('alice@example.com', 'bob@example.com');
  SELECT id INTO c FROM claim_leads('received', 1, 'w3') WHERE email IN ('alice@example.com', 'bob@example.com');
  ASSERT a IS NOT NULL AND b IS NOT NULL, 'first two claims must each return a lead';
  ASSERT a <> b, 'two claims must not return the same lead';
  ASSERT c IS NULL, 'third claim must return nothing';
END $$;

-- 2. legal transition succeeds and is audited
DO $$
DECLARE a uuid;
BEGIN
  SELECT id INTO a FROM leads WHERE idempotency_key = 'st-1';
  PERFORM transition_lead(a, 'received', 'verified', 'ok', 'test');
  ASSERT (SELECT status FROM leads WHERE id = a) = 'verified', 'status should be verified';
  ASSERT (SELECT count(*) FROM lead_transitions WHERE lead_id = a) = 1, 'transition must be audited';
  ASSERT (SELECT locked_by FROM leads WHERE id = a) IS NULL, 'lock must be cleared';
END $$;

-- 3. illegal transition is rejected
DO $$
DECLARE b uuid; raised boolean := false;
BEGIN
  SELECT id INTO b FROM leads WHERE idempotency_key = 'st-2';
  BEGIN
    PERFORM transition_lead(b, 'received', 'approved', 'x', 'test');
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  ASSERT raised, 'received -> approved must raise check_violation';
END $$;

-- 4. stale transition is rejected
DO $$
DECLARE a uuid; raised boolean := false;
BEGIN
  SELECT id INTO a FROM leads WHERE idempotency_key = 'st-1';
  BEGIN
    PERFORM transition_lead(a, 'received', 'verified', 'x', 'test');
  EXCEPTION WHEN serialization_failure THEN raised := true;
  END;
  ASSERT raised, 'transition from the wrong current status must raise serialization_failure';
END $$;

-- 5. email uniqueness is case-insensitive; idempotency key is unique
DO $$
DECLARE r1 boolean := false; r2 boolean := false; cid uuid;
BEGIN
  SELECT ctx.cid INTO cid FROM ctx;
  BEGIN
    INSERT INTO leads (campaign_id, idempotency_key, email, company_raw) VALUES (cid, 'st-3', 'ALICE@example.com', 'Acme');
  EXCEPTION WHEN unique_violation THEN r1 := true;
  END;
  BEGIN
    INSERT INTO leads (campaign_id, idempotency_key, email, company_raw) VALUES (cid, 'st-1', 'carol@example.com', 'Acme');
  EXCEPTION WHEN unique_violation THEN r2 := true;
  END;
  ASSERT r1, 'duplicate email in a different case must be rejected';
  ASSERT r2, 'duplicate idempotency key must be rejected';
END $$;

-- 6. release_lead backs off, then dead-letters at max attempts
DO $$
DECLARE b uuid; ok boolean;
BEGIN
  SELECT id INTO b FROM leads WHERE idempotency_key = 'st-2';
  UPDATE leads SET attempts = 1 WHERE id = b;
  ok := release_lead(b, 'boom', 5);
  ASSERT ok, 'release at attempt 1 should allow retry';
  ASSERT (SELECT next_attempt_at FROM leads WHERE id = b) > now(), 'next_attempt_at must be in the future';
  UPDATE leads SET attempts = 5, next_attempt_at = NULL WHERE id = b;
  ok := release_lead(b, 'boom', 5);
  ASSERT NOT ok, 'release at max attempts should not allow retry';
  ASSERT (SELECT status FROM leads WHERE id = b) = 'failed', 'lead must be failed';
  ASSERT (SELECT count(*) FROM dead_letters WHERE lead_id = b) = 1, 'one dead letter expected';
END $$;

-- 7. is_suppressed matches email, domain and hashed email
DO $$
BEGIN
  INSERT INTO suppression (kind, value, reason) VALUES
    ('email', 'x@foo.com', 'manual'),
    ('domain', 'bar.com', 'manual'),
    ('email_hash', encode(digest('hash@baz.com', 'sha256'), 'hex'), 'erasure');
  ASSERT is_suppressed('X@foo.com'), 'email match';
  ASSERT is_suppressed('anyone@bar.com'), 'domain match';
  ASSERT is_suppressed('hash@baz.com'), 'hash match';
  ASSERT NOT is_suppressed('ok@fine.com'), 'unlisted address must not match';
END $$;

-- 8. a step cannot be scheduled twice for a lead
DO $$
DECLARE a uuid; d uuid; raised boolean := false;
BEGIN
  SELECT id INTO a FROM leads WHERE idempotency_key = 'st-1';
  INSERT INTO drafts (lead_id, step, variant, body) VALUES (a, 1, 'direct', 'hello') RETURNING id INTO d;
  INSERT INTO sends (lead_id, draft_id, step, mode, scheduled_at) VALUES (a, d, 1, 'sandbox', now());
  BEGIN
    INSERT INTO sends (lead_id, draft_id, step, mode, scheduled_at) VALUES (a, d, 1, 'sandbox', now());
  EXCEPTION WHEN unique_violation THEN raised := true;
  END;
  ASSERT raised, 'second send for the same (lead, step) must be rejected';
END $$;

-- 9. replayed provider events are ignored by the unique index
DO $$
DECLARE raised boolean := false;
BEGIN
  INSERT INTO events (provider_event_id, type) VALUES ('evt-1', 'delivered');
  BEGIN
    INSERT INTO events (provider_event_id, type) VALUES ('evt-1', 'delivered');
  EXCEPTION WHEN unique_violation THEN raised := true;
  END;
  ASSERT raised, 'duplicate provider_event_id must be rejected';
  INSERT INTO events (type) VALUES ('delivered');
  INSERT INTO events (type) VALUES ('delivered');
END $$;

-- 10. seeds are present
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM campaigns WHERE name = 'demo-ai-automation' AND status = 'active') = 1, 'demo campaign seeded';
  ASSERT (SELECT count(*) FROM region_rules WHERE country = 'DE' AND rule = 'blocked') = 1, 'DE blocked';
  ASSERT (SELECT count(*) FROM sender_inboxes) >= 2, 'two sandbox inboxes seeded';
  ASSERT (SELECT value FROM settings WHERE key = 'kill_switch') = 'false'::jsonb, 'kill switch seeded off';
END $$;

-- 11. stage outcomes the workflows rely on (spec 10, WF-04: a tier C lead is rejected straight from researched)
DO $$
DECLARE a uuid;
BEGIN
  INSERT INTO leads (campaign_id, idempotency_key, email, company_raw, status)
  SELECT id, 'st-rej', 'rej@acme.com', 'Acme', 'researched' FROM campaigns LIMIT 1 RETURNING id INTO a;
  PERFORM transition_lead(a, 'researched', 'rejected', 'low_fit', 'test');
  ASSERT (SELECT status FROM leads WHERE id = a) = 'rejected', 'researched -> rejected must be allowed';
END $$;

SELECT 'schema tests passed' AS result;
