import { executeTrigger, ifNode, postgres, schedule, splitInBatches } from './nodes.js';
import { createFlow, type Flow, type N8nWorkflow, type NodeSpec } from './workflow.js';

/** Expression for the lead the loop is currently processing. */
export const CURRENT_LEAD = `$('Lead loop').first().json`;

export interface PerLeadBuild {
  /** First node of the per-lead logic. */
  entry: string;
  /** Nodes whose main output 0 means "this lead is finished"; the skeleton returns them to the loop. */
  exits: string[];
}

export interface SkeletonOptions {
  name: string;
  /** lead_status the stage claims. */
  inputStatus: string;
  /** Leads claimed per run (and per loop pass: one lead at a time keeps failures isolated). */
  batch: number;
  /** Linear stage logic, or a builder for stages that branch. */
  perLead: NodeSpec[] | ((flow: Flow) => PerLeadBuild);
  /** Also stop when settings.llm_paused is true (stages that call the LLM gateway). */
  llmGated?: boolean;
  /** Minutes between scheduled runs (default 1). */
  everyMinutes?: number;
  /** Replaces claim_leads for stages that claim something other than a lead status. It must return the lead's id as `id`. */
  claim?: { query: string; params?: string };
  /** Statements run once per execution after Start run and before the claim. Each must always return one row. */
  prelude?: NodeSpec[];
}

/** Node types that expose an error output when onError is continueErrorOutput. */
const FAILABLE = new Set([
  'n8n-nodes-base.postgres',
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.code',
  'n8n-nodes-base.executeWorkflow',
]);

/** Spec 10.0: schedule or on-demand, gate, start run, claim, loop per lead with an error branch, end run. */
export function stageSkeleton(opts: SkeletonOptions): N8nWorkflow {
  const f = createFlow();
  const wf = JSON.stringify(opts.name);
  const enabled = opts.llmGated ? '!$json.kill_switch && !$json.llm_paused' : '!$json.kill_switch';

  f.add(schedule('Schedule', opts.everyMinutes ?? 1));
  f.add(executeTrigger());
  f.add(
    postgres(
      'Gate',
      `SELECT
         COALESCE((SELECT value FROM settings WHERE key = 'kill_switch'), 'false'::jsonb) = 'true'::jsonb AS kill_switch,
         COALESCE((SELECT value FROM settings WHERE key = 'llm_paused'), 'false'::jsonb) = 'true'::jsonb AS llm_paused`,
    ),
  );
  f.add(ifNode('Stage enabled', enabled));
  f.add(
    postgres('Start run', 'INSERT INTO runs (workflow, execution_id) VALUES ($1, $2) RETURNING id AS run_id', `[${wf}, String($execution.id)]`),
  );
  const claim = f.add(
    opts.claim
      ? postgres('Claim leads', opts.claim.query, opts.claim.params ?? `[${wf} + ":" + $execution.id]`)
      : postgres(
          'Claim leads',
          `SELECT * FROM claim_leads('${opts.inputStatus}'::lead_status, ${opts.batch}, $1)`,
          `[${wf} + ":" + $execution.id]`,
        ),
  );
  claim.alwaysOutputData = true;
  f.add(ifNode('Leads claimed', '!!$json.id'));
  f.add(splitInBatches('Lead loop', 1));
  f.add(
    postgres(
      'Release lead',
      'SELECT release_lead($1::uuid, $2) AS released',
      `[${CURRENT_LEAD}.id, (typeof $json.error === "string" ? $json.error : JSON.stringify($json.error ?? "stage failed")).slice(0, 500)]`,
    ),
  );
  f.add(
    postgres(
      'End run',
      `UPDATE runs
          SET status = 'succeeded', ended_at = now(),
              latency_ms = (extract(epoch FROM now() - started_at) * 1000)::int
        WHERE id = $1`,
      `[$('Start run').first().json.run_id]`,
    ),
  );

  // Per-lead logic. Every failable node gets an error output that goes to Release lead.
  const decorated: Flow = {
    ...f,
    add(node) {
      if (FAILABLE.has(node.type) && !node.onError) node.onError = 'continueErrorOutput';
      return f.add(node);
    },
  };
  let built: PerLeadBuild;
  if (Array.isArray(opts.perLead)) {
    for (const n of opts.perLead) decorated.add(n);
    const names = opts.perLead.map((n) => n.name);
    f.chain(...names);
    built = { entry: names[0]!, exits: [names[names.length - 1]!] };
  } else {
    built = opts.perLead(decorated);
  }
  const failable = (f.build(opts.name).nodes as { name: string; type: string; onError?: string }[])
    .filter((n) => n.onError === 'continueErrorOutput' && FAILABLE.has(n.type))
    .map((n) => n.name);

  f.connect('Schedule', 'Gate');
  f.connect('Run on demand', 'Gate');
  f.connect('Gate', 'Stage enabled');
  f.connect('Stage enabled', 'Start run');
  const prelude = opts.prelude ?? [];
  for (const n of prelude) {
    n.alwaysOutputData = true;
    f.add(n);
  }
  f.chain('Start run', ...prelude.map((n) => n.name), 'Claim leads', 'Leads claimed');
  f.connect('Leads claimed', 'Lead loop');
  f.connect('Leads claimed', 'End run', 1);
  f.connect('Lead loop', 'End run', 0);
  f.connect('Lead loop', built.entry, 1);
  for (const x of built.exits) f.connect(x, 'Lead loop');
  for (const n of failable) {
    if (n === 'Claim leads' || n === 'Release lead' || n === 'Start run' || n === 'End run' || n === 'Gate') continue;
    f.connect(n, 'Release lead', 1);
  }
  f.connect('Release lead', 'Lead loop');
  return f.build(opts.name);
}
