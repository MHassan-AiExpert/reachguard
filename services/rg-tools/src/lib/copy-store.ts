import type { Db } from '../db.js';

export interface CopyStore {
  evidenceIdsForLead(leadId: string): Promise<string[]>;
  /** Shingle hashes of the newest step 1 drafts in a campaign, excluding rejected ones and one lead's own revisions. */
  recentFirstEmailShingles(
    campaignId: string,
    excludeLeadId: string | null,
    limit: number,
  ): Promise<string[][]>;
}

export function createPgCopyStore(db: Db): CopyStore {
  return {
    async evidenceIdsForLead(leadId) {
      const r = await db.query<{ id: string }>('SELECT id FROM research_evidence WHERE lead_id = $1', [
        leadId,
      ]);
      return r.rows.map((x) => x.id);
    },
    async recentFirstEmailShingles(campaignId, excludeLeadId, limit) {
      const r = await db.query<{ shingle_hashes: (string | number)[] }>(
        `SELECT d.shingle_hashes
           FROM drafts d JOIN leads l ON l.id = d.lead_id
          WHERE l.campaign_id = $1
            AND d.step = 1
            AND d.status NOT IN ('rejected', 'qa_reject')
            AND ($2::uuid IS NULL OR d.lead_id <> $2::uuid)
          ORDER BY d.created_at DESC
          LIMIT $3`,
        [campaignId, excludeLeadId, limit],
      );
      return r.rows.map((x) => x.shingle_hashes.map(String));
    },
  };
}
