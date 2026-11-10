import type { LlmStore } from './llm-store.js';

export type BudgetDecision = { ok: true } | { ok: false; reason: 'paused' | 'budget' };

export async function checkBudget(store: LlmStore, fallbackBudgetUsd: number): Promise<BudgetDecision> {
  if ((await store.getSetting('llm_paused')) === true) return { ok: false, reason: 'paused' };
  const configured = Number(await store.getSetting('llm_daily_budget_usd'));
  const budget = Number.isFinite(configured) && configured > 0 ? configured : fallbackBudgetUsd;
  if ((await store.spendToday()) >= budget) return { ok: false, reason: 'budget' };
  return { ok: true };
}
