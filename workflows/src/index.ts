import { buildWf00 } from './wf-00-errors.js';
import { buildWf01 } from './wf-01-intake.js';
import { buildWf02 } from './wf-02-hygiene.js';
import { buildWf03 } from './wf-03-research.js';
import { buildWf04 } from './wf-04-scoring.js';
import type { N8nWorkflow } from './lib/workflow.js';

/** Every workflow the project ships, in WF number order. Later tasks append their builders here. */
export function allWorkflows(): N8nWorkflow[] {
  return [buildWf00(), buildWf01(), buildWf02(), buildWf03(), buildWf04()];
}
