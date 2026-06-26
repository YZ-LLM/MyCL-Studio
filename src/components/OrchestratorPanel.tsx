// OrchestratorPanel — orkestratör ajanının ÖNEMLİ KARARLARINI sağ panelde kalıcı gösterir.
// AgentThinkingModal ile AYNI veriyi (App.mainState.agentEvents) kullanır; fark: modal değil panel,
// ve yalnız KARARLAR (sub="decision") + HATALAR (sub="error") gösterilir — tool/started/completed gürültüsü elenir.
// Karar render'ı EventRow ile paylaşılır (DRY). YZLLM: "Orkestratorun bütün önemli kararları gözüksün."

import { useEffect, useRef } from "react";
import type { AgentThinkingEvent } from "../App";
import { EventRow } from "./AgentThinkingModal";

interface Props {
  /** Önceden filtrelenmiş orkestratör kararları (App reducer: decision + error; cap 300). */
  events: AgentThinkingEvent[];
}

export function OrchestratorPanel({ events }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Yeni karar gelince en alta kaydır (kronolojik — en yeni altta, modal/chat ile tutarlı).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <section className="panel-vsection">
      <div className="panel-label">Orkestra Ajanı — Önemli Kararlar ({events.length})</div>
      <div className="orchestrator-log" ref={scrollRef}>
        {events.length === 0 ? (
          <p style={{ color: "var(--fg-dim)", fontSize: 12, padding: 12, lineHeight: 1.5 }}>
            Henüz orkestratör kararı yok. Mesaj yazdıkça orkestratör verdiği her önemli kararı —
            ne yaptığını ve nedenini — burada gösterir.
          </p>
        ) : (
          events.map((ev) => <EventRow key={ev.ts} ev={ev} />)
        )}
      </div>
    </section>
  );
}
