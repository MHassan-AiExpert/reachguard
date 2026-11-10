INSERT INTO region_rules (country, rule, note) VALUES
  ('US', 'allow', 'CAN-SPAM: address and working opt-out required'),
  ('GB', 'allow_with_note', 'PECR/UK GDPR: corporate addresses only, legitimate interest documented'),
  ('DE', 'blocked', 'Prior consent typically required for B2B email; counsel review needed'),
  ('AT', 'restricted', 'Prior consent typically required; counsel review needed'),
  ('CA', 'restricted', 'CASL: consent rules are strict; counsel review needed')
ON CONFLICT (country) DO NOTHING;

INSERT INTO region_rules (country, rule, note)
SELECT c, 'allow_with_note', 'EU GDPR/ePrivacy: corporate addresses only, legitimate interest documented'
FROM unnest(ARRAY['BE','BG','HR','CY','CZ','DK','EE','FI','FR','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE']) AS c
ON CONFLICT (country) DO NOTHING;
