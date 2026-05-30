// agent-quality — Orchestrator agent decision quality metric (v15.7, 2026-05-26).
//
// Production readiness madde 19: "Evaluation karar izini ölçüyor mu?"
// agent-decisions.jsonl her orkestratör kararını action + reason + confirmed
// (kullanıcı Evet/Hayır) ile yazıyor. Bu modül o log'tan kalite skorları çıkarır:
//
//   - confirm_rate: confirmed=true oranı (kullanıcı kabul etti)
//   - action_distribution: her action'ın sıklığı
//   - reject_topics: en çok reject edilen topic_slug'lar (prompt iyileştirme sinyali)
//
// UI Settings panelinde göstermek için consumer; agent-decisions.jsonl process
// dışı dosya olduğu için on-demand read (cache yok).

import { readAgentDecisionLog } from "./agent-memory/store.js";
import type { AgentDecisionLogEntry } from "./agent-memory/types.js";

export interface AgentQualityMetrics {
  /** Toplam kayıt sayısı. */
  total: number;
  /** confirmed=true sayısı. */
  confirmed: number;
  /** confirmed / total (0-1). NaN guard: total=0 ise 0 döner. */
  confirm_rate: number;
  /** Action sıklığı (action_name → count). */
  action_distribution: Record<string, number>;
  /** En çok reject edilen topic'ler (descending). max 10. */
  top_rejected_topics: Array<{ topic_slug: string; reject_count: number }>;
  /** Son 7 günün confirm_rate'i (recency trend). */
  recent_confirm_rate: number;
}

export async function computeAgentQuality(
  projectRoot: string,
): Promise<AgentQualityMetrics> {
  const all = await readAgentDecisionLog(projectRoot).catch(() => [] as AgentDecisionLogEntry[]);
  const total = all.length;
  const confirmed = all.filter((e) => e.confirmed).length;
  const confirm_rate = total > 0 ? confirmed / total : 0;
  // Action distribution
  const action_distribution: Record<string, number> = {};
  for (const e of all) {
    action_distribution[e.action] = (action_distribution[e.action] ?? 0) + 1;
  }
  // Top rejected topics
  const rejectByTopic = new Map<string, number>();
  for (const e of all) {
    if (!e.confirmed) {
      rejectByTopic.set(e.topic_slug, (rejectByTopic.get(e.topic_slug) ?? 0) + 1);
    }
  }
  const top_rejected_topics = Array.from(rejectByTopic.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic_slug, reject_count]) => ({ topic_slug, reject_count }));
  // Recent (last 7 days)
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = all.filter((e) => e.ts >= sevenDaysAgo);
  const recentConfirmed = recent.filter((e) => e.confirmed).length;
  const recent_confirm_rate = recent.length > 0 ? recentConfirmed / recent.length : 0;
  return {
    total,
    confirmed,
    confirm_rate,
    action_distribution,
    top_rejected_topics,
    recent_confirm_rate,
  };
}
