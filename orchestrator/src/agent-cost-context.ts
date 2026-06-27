// agent-cost-context — çalışan ALT-AJAN bağlamı (AsyncLocalStorage). YZLLM 2026-06-27 ("Ajan Takımı" popup):
// paralel çoklu-ajan (tasarım paneli / kök-neden mercekleri / modül codegen) çalışırken HER ajanın token'ını
// AYRI atfetmek için. Token muhasebesinin tek chokepoint'i recordTokenUsage'dır; orada currentAgentRun() set ise
// usage o ajana atfedilir (agent_event sub="token_usage"). AsyncLocalStorage paralel async-zincirlerini izole tutar
// (her perspektif/worker kendi bağlamında) → before/after snapshot'ın paralelde çökmesinden kaçınır.

import { AsyncLocalStorage } from "node:async_hooks";

/** Bir alt-ajan koşusunun bağlamı (popup'ta gösterilen takım/faz/etiket). */
export interface AgentRunContext {
  /** Ajan etiketi (örn. "Mimari", "UX", modül id). agent_event.agent_label ile eşleşir. */
  label: string;
  /** Takım/grup adı (popup'ta gruplama): "Tasarım Paneli" / "Kök-neden Mercekleri" / "Modül Codegen" ... */
  group: string;
  /** O ajanın çalıştığı pipeline fazı (popup "hangi fazda" sütunu). */
  phase: number;
}

const als = new AsyncLocalStorage<AgentRunContext>();

/** Şu an çalışan alt-ajanın bağlamı (yoksa undefined → atıf yapılmaz, normal global muhasebe sürer). */
export function currentAgentRun(): AgentRunContext | undefined {
  return als.getStore();
}

/** `fn`'i verilen ajan bağlamında koş. İçindeki TÜM Claude çağrılarının token'ı bu ajana atfedilir (recordTokenUsage).
 *  Paralel çağrılarda her birini ayrı withAgentRun ile sar → bağlamlar karışmaz. fn'in dönüşü aynen iletilir. */
export function withAgentRun<T>(ctx: AgentRunContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}
