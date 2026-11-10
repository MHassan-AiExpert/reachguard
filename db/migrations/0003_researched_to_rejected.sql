-- WF-04 rejects a tier C lead as low_fit straight from researched (spec 10). 0001 only allowed scored -> rejected.
INSERT INTO lead_status_transitions (from_status, to_status) VALUES ('researched','rejected')
ON CONFLICT DO NOTHING;
