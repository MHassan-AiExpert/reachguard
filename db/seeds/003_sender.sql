INSERT INTO sending_domains (domain, spf_ok, dkim_ok, dmarc_ok, status)
VALUES ('mail.reachguard.example', true, true, true, 'active')
ON CONFLICT (domain) DO NOTHING;

INSERT INTO sender_inboxes (email, domain, provider, daily_limit, status) VALUES
  ('muhammad@mail.reachguard.example', 'mail.reachguard.example', 'mailpit', 30, 'active'),
  ('team@mail.reachguard.example', 'mail.reachguard.example', 'mailpit', 30, 'active')
ON CONFLICT (email) DO NOTHING;
