INSERT INTO campaigns (name, status, icp, offer, sequence, approval_policy)
VALUES (
  'demo-ai-automation',
  'active',
  '{"industries":["ecommerce","digital marketing agencies","SaaS"],"employee_ranges":["11-50","51-200"],"buyer_roles":["founder","ceo","head of operations","head of growth","marketing director"]}'::jsonb,
  '{"sender_name":"Muhammad","sender_role":"AI Automation Engineer","summary":"We build n8n-based automation and AI agents that remove repetitive operations work such as lead handling, order ops and reporting.","proof_points":[],"variant_styles":["direct","curious","short"]}'::jsonb,
  '[{"step":1,"delay_business_days":0},{"step":2,"delay_business_days":3},{"step":3,"delay_business_days":7}]'::jsonb,
  '{"require_for_tiers":["A"]}'::jsonb
)
ON CONFLICT (name) DO NOTHING;
