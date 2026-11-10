-- An unsubscribe, hard bounce or complaint must win over any other state (spec 12.1).
-- 0001 only allowed ... -> suppressed from received, approved, queued, in_sequence and replied.
INSERT INTO lead_status_transitions (from_status, to_status) VALUES
  ('verified','suppressed'),('researched','suppressed'),('scored','suppressed'),
  ('drafted','suppressed'),('qa_passed','suppressed'),('pending_approval','suppressed'),
  ('needs_review','suppressed'),('completed','suppressed')
ON CONFLICT DO NOTHING;
