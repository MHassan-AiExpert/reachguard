import { code, http, ifNode, postgres, respond, switchNumber, webhook } from './lib/nodes.js';
import { createFlow, type N8nWorkflow } from './lib/workflow.js';

export const NAME = 'WF-01 Intake Gateway';

const EXTRACT = `
const item = $input.first();
const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
const h = item.json.headers || {};
return [{ json: {
  raw_body: buf.toString('utf8'),
  signature: h['x-rg-signature'] || '',
  timestamp: h['x-rg-timestamp'] || '',
} }];
`;

const PARSE = `
const raw = $('Extract request').first().json.raw_body;
let body;
try { body = JSON.parse(raw); } catch { return [{ json: { ok: false, error: 'invalid_json' } }]; }
const bulk = Array.isArray(body);
const leads = bulk ? body : [body];
if (leads.length === 0) return [{ json: { ok: false, error: 'empty_batch' } }];
if (leads.length > 500) return [{ json: { ok: false, error: 'batch_too_large', max: 500 } }];
return [{ json: { ok: true, bulk, leads } }];
`;

const SPLIT = `
const { leads, bulk } = $input.first().json;
return leads.map((lead, idx) => ({
  json: { idx, bulk, lead: lead && typeof lead === 'object' && !Array.isArray(lead) ? lead : {} },
}));
`;

const MARK = `
const src = $('Split leads').all();
return $input.all().map((r, i) => {
  const s = src[i].json;
  const valid = r.json.valid === true;
  const l = s.lead;
  return { json: {
    idx: s.idx, bulk: s.bulk, valid, errors: r.json.errors || [], lead: l,
    email: valid ? String(l.email).trim().toLowerCase() : '',
  } };
});
`;

const ASSEMBLE = `
const marks = $('Mark validity').all().map((i) => i.json);
const rows = new Map($input.all().map((i) => [Number(i.json.idx), i.json]));
const results = marks.map((m) => {
  if (!m.valid) return { index: m.idx, status: 'invalid', errors: m.errors, http: 400 };
  const r = rows.get(m.idx);
  if (!r || !r.campaign_found) return { index: m.idx, status: 'unknown_campaign', http: 404 };
  if (r.inserted_id) return { index: m.idx, status: 'accepted', lead_id: r.inserted_id, http: 202 };
  return { index: m.idx, status: 'duplicate', lead_id: r.existing_id, http: 200 };
});
if (marks[0] && marks[0].bulk) {
  return [{ json: { http: 200, body: { results: results.map(({ http, ...rest }) => rest) } } }];
}
const r = results[0];
const body =
  r.status === 'accepted' ? { lead_id: r.lead_id }
  : r.status === 'duplicate' ? { status: 'duplicate', lead_id: r.lead_id }
  : r.status === 'invalid' ? { error: 'invalid', errors: r.errors }
  : { error: 'unknown_campaign' };
return [{ json: { http: r.http, body } }];
`;

// $1 campaign, $2 idempotency key, $3 email, $4 first, $5 last, $6 title, $7 company, $8 website,
// $9 country, $10 source, $11 source_ref, $12 tags (json), $13 raw payload (json), $14 valid, $15 idx.
// An invalid lead matches no campaign row, so nothing is inserted. A repeat email is a duplicate too.
const INSERT = `WITH c AS (
  SELECT id FROM campaigns WHERE name = $1 AND status = 'active' AND $14::boolean
),
ins AS (
  INSERT INTO leads (campaign_id, idempotency_key, email, first_name, last_name, title, company_raw,
                     website, country, source, source_ref, tags, raw_payload, status)
  SELECT c.id,
         COALESCE(NULLIF($2, ''), encode(digest(lower($1) || '|' || $3::text, 'sha256'), 'hex')),
         $3::citext, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7, NULLIF($8, ''),
         NULLIF(upper($9), ''), NULLIF($10, ''), NULLIF($11, ''),
         ARRAY(SELECT jsonb_array_elements_text($12::jsonb)), $13::jsonb, 'received'
    FROM c
   WHERE NOT EXISTS (SELECT 1 FROM leads WHERE email = $3::citext)
  ON CONFLICT DO NOTHING
  RETURNING id
)
SELECT $15::int AS idx,
       (SELECT id FROM ins) AS inserted_id,
       (SELECT id FROM leads WHERE email = $3::citext OR idempotency_key = NULLIF($2, '') LIMIT 1) AS existing_id,
       EXISTS (SELECT 1 FROM c) AS campaign_found`;

const INSERT_PARAMS = `[
  String($json.lead.campaign ?? ''), String($json.lead.idempotency_key ?? ''), $json.email,
  String($json.lead.first_name ?? ''), String($json.lead.last_name ?? ''), String($json.lead.title ?? ''),
  String($json.lead.company ?? ''), String($json.lead.website ?? ''), String($json.lead.country ?? ''),
  String($json.lead.source ?? ''), String($json.lead.source_ref ?? ''),
  JSON.stringify(Array.isArray($json.lead.tags) ? $json.lead.tags : []),
  JSON.stringify($json.lead), $json.valid, $json.idx
]`;

export function buildWf01(): N8nWorkflow {
  const f = createFlow();
  f.add(webhook('Intake webhook', 'rg/intake'));
  f.add(code('Extract request', EXTRACT));
  f.add(http('Verify signature', '/v1/auth/verify-webhook', '{ raw_body: $json.raw_body, signature: $json.signature, timestamp: $json.timestamp }'));
  f.add(ifNode('Signature valid', '$json.valid === true'));
  f.add(respond('Respond 401', 401, '{ error: "invalid_signature" }'));
  f.add(code('Parse body', PARSE));
  f.add(ifNode('Body parsed', '$json.ok === true'));
  f.add(respond('Respond 400 batch', 400, '{ error: $json.error }'));
  f.add(code('Split leads', SPLIT));
  f.add(http('Validate lead', '/v1/contracts/validate', "{ schema: 'lead-intake', data: $json.lead }"));
  f.add(code('Mark validity', MARK));
  f.add(postgres('Insert lead', INSERT, INSERT_PARAMS));
  f.add(code('Assemble response', ASSEMBLE));
  f.add(switchNumber('Route by status', '$json.http', [202, 200, 400, 404]));
  f.add(respond('Respond 202', 202, '$json.body'));
  f.add(respond('Respond 200', 200, '$json.body'));
  f.add(respond('Respond 400 invalid', 400, '$json.body'));
  f.add(respond('Respond 404', 404, '$json.body'));

  f.chain('Intake webhook', 'Extract request', 'Verify signature', 'Signature valid');
  f.connect('Signature valid', 'Parse body', 0);
  f.connect('Signature valid', 'Respond 401', 1);
  f.connect('Parse body', 'Body parsed');
  f.connect('Body parsed', 'Split leads', 0);
  f.connect('Body parsed', 'Respond 400 batch', 1);
  f.chain('Split leads', 'Validate lead', 'Mark validity', 'Insert lead', 'Assemble response', 'Route by status');
  f.connect('Route by status', 'Respond 202', 0);
  f.connect('Route by status', 'Respond 200', 1);
  f.connect('Route by status', 'Respond 400 invalid', 2);
  f.connect('Route by status', 'Respond 404', 3);
  return f.build(NAME);
}

