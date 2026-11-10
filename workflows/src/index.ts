import { buildWf00 } from './wf-00-errors.js';
import { buildWf01 } from './wf-01-intake.js';
import { buildWf02 } from './wf-02-hygiene.js';
import { buildWf03 } from './wf-03-research.js';
import { buildWf04 } from './wf-04-scoring.js';
import { buildWf05 } from './wf-05-copywriter.js';
import { buildWf06 } from './wf-06-qa-judge.js';
import { buildWf07a, buildWf07b } from './wf-07-approval.js';
import { buildWf08a, buildWf08b } from './wf-08-sender.js';
import { buildWf09 } from './wf-09-events.js';
import { buildWf11 } from './wf-11-guardian.js';
import { buildWf14 } from './wf-14-demo.js';
import type { N8nWorkflow } from './lib/workflow.js';

/** Every workflow the project ships, in WF number order. Later tasks append their builders here. */
export function allWorkflows(): N8nWorkflow[] {
  return [buildWf00(), buildWf01(), buildWf02(), buildWf03(), buildWf04(), buildWf05(), buildWf06(), buildWf07a(), buildWf07b(), buildWf08a(), buildWf08b(), buildWf09(), buildWf11(), buildWf14()];
}
