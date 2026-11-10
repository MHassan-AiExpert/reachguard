import type { CopyStore } from '../src/lib/copy-store.js';

export interface MemoryCopyStore extends CopyStore {
  calls: { campaign_id: string; exclude_lead_id: string | null; limit: number }[];
}

export function memoryCopyStore(
  init: { evidence?: Record<string, string[]>; shingles?: { lead_id: string; hashes: string[] }[] } = {},
): MemoryCopyStore {
  const calls: MemoryCopyStore['calls'] = [];
  return {
    calls,
    async evidenceIdsForLead(leadId) {
      return init.evidence?.[leadId] ?? [];
    },
    async recentFirstEmailShingles(campaignId, excludeLeadId, limit) {
      calls.push({ campaign_id: campaignId, exclude_lead_id: excludeLeadId, limit });
      return (init.shingles ?? []).filter((s) => s.lead_id !== excludeLeadId).map((s) => s.hashes);
    },
  };
}
