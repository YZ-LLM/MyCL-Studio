// OrchestratorPanel — orkestratörün TÜM önemli aktivitesini sağ panelde SADE KISA TÜRKÇE gösterir.
// (tool_use + decision + error; started/completed yaşam-döngüsü gürültüsü reducer'da elenir.) Önemli KARARLAR
// farklı/vurgulu renkte. YZLLM: "yaptığı herşeyi yazsın; o iterasyonda neler yapıldı hepsini anlayabileyim;
// sade Türkçe; kısa öz, her iş için en fazla 1-2 cümle." reason/message_to_user zaten Türkçe (orkestratör kuralı).

import { useEffect, useRef, useState } from "react";
import type { AgentThinkingEvent } from "../App";

interface Props {
  /** App reducer'ın biriktirdiği orkestratör aktivitesi (tool_use + decision + error; cap 500). */
  events: AgentThinkingEvent[];
  /** YZLLM 2026-06-26 (req 4): alt composer'dan KALICI YÖNERGE — orkestratör değerlendirir (benimse/itiraz). */
  onDirective?: (text: string) => void;
}

/** Karar action enum'u → sade Türkçe etiket (orkestratörün NE yaptığı). */
const ACTION_TR: Record<string, string> = {
  chat: "Yanıtladı",
  ask_clarify: "Açıklama sordu",
  run_phase: "Faz çalıştırdı",
  approve_ui: "Arayüzü onayladı",
  revise_ui: "Arayüz düzeltmesi istedi",
  cancel_pipeline: "Akışı durdurdu",
  resume_pipeline: "Akışa devam etti",
  debug_triage: "Hata teşhisi başlattı",
  develop_new_or_iter: "Yeni iş başlattı",
  save_memory_proposal: "Hafıza kaydı önerdi",
  set_optional_phases: "Faz kapsamını belirledi",
  answer_askq: "Soruyu yanıtladı",
  verify_feature: "Özelliği test etti",
  fallback_to_classifier: "Klasik sınıflandırıcıya devretti",
};

/** tool_use → kısa sade Türkçe özet ("X dosyasını okudu" gibi). */
function toolSummaryTr(name: string | undefined, input: Record<string, unknown> | undefined): string {
  const v = (k: string): string => {
    const x = input?.[k];
    return typeof x === "string" ? x : "";
  };
  const raw = (v("file_path") || v("path") || v("pattern") || v("query") || v("command") || "").trim();
  const t = raw.length > 70 ? raw.slice(0, 70) + "…" : raw;
  switch (name) {
    case "Read":
      return t ? `${t} dosyasını okudu` : "bir dosya okudu";
    case "Grep":
      return t ? `kodda "${t}" aradı` : "kod içinde aradı";
    case "Glob":
      return t ? `"${t}" dosya taraması yaptı` : "dosya taradı";
    case "Bash":
      return t ? `komut çalıştırdı: ${t}` : "bir komut çalıştırdı";
    case "Edit":
    case "Write":
      return t ? `${t} düzenledi` : "bir dosya düzenledi";
    default:
      return t ? `${name ?? "araç"}: ${t}` : name ?? "araç kullandı";
  }
}

function ActivityRow({ ev }: { ev: AgentThinkingEvent }) {
  if (ev.sub === "decision" && ev.decision) {
    const action = String(ev.decision.action ?? "");
    const label = ACTION_TR[action] ?? action;
    const reason = String(ev.decision.reason ?? "").trim();
    const phase = ev.decision.target_phase;
    return (
      <div className="orch-row orch-row-decision">
        <span className="orch-row-label">
          🎯 {label}
          {phase !== undefined && phase !== null ? ` (Faz ${String(phase)})` : ""}
        </span>
        {reason && <span className="orch-row-text">{reason}</span>}
      </div>
    );
  }
  if (ev.sub === "tool_use") {
    return (
      <div className="orch-row orch-row-tool">
        <span className="orch-row-text">🔍 {toolSummaryTr(ev.tool_name, ev.tool_input)}</span>
      </div>
    );
  }
  if (ev.sub === "error") {
    return (
      <div className="orch-row orch-row-error">
        <span className="orch-row-text">⚠ {ev.error ?? "hata"}</span>
      </div>
    );
  }
  return null;
}

export function OrchestratorPanel({ events, onDirective }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");

  // Yeni aktivite gelince en alta kaydır (kronolojik — en yeni altta, chat ile tutarlı).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const submitDirective = (): void => {
    const t = draft.trim();
    if (!t || !onDirective) return;
    onDirective(t);
    setDraft("");
  };

  return (
    <section className="panel-vsection">
      <div className="panel-label">Orkestra Ajanı — Yapılanlar ({events.length})</div>
      <div className="orchestrator-log" ref={scrollRef}>
        {events.length === 0 ? (
          <p style={{ color: "var(--fg-dim)", fontSize: 12, padding: 12, lineHeight: 1.5 }}>
            Henüz orkestratör aktivitesi yok. Mesaj yazdıkça orkestratörün yaptığı her önemli iş — ne
            yaptığı ve nedeni — burada sade Türkçe görünür; önemli kararlar belirgin renktedir.
          </p>
        ) : (
          events.map((ev) => <ActivityRow key={ev.ts} ev={ev} />)
        )}
      </div>
      {/* Alt composer (YZLLM req 4): görev değil, KALICI YÖNERGE (işin nasıl yapılacağı çapası). Orkestratör
          değerlendirir — itirazı varsa söyler, yoksa benimser (~/.mycl/directives.md → sonraki işlere enjekte). */}
      {onDirective && (
        <div className="orch-directive-composer">
          <textarea
            className="orch-directive-input"
            data-testid="orch-directive-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitDirective();
              }
            }}
            placeholder="Kalıcı yönerge ver (görev değil) — örn. 'projelerde her zaman versiyonlama yapalım'. Orkestratör itirazı varsa söyler, yoksa benimser ve bundan sonra uyar."
            rows={2}
          />
          <button
            type="button"
            className="orch-directive-send"
            data-testid="orch-directive-send"
            onClick={submitDirective}
            disabled={!draft.trim()}
            title="Bu kalıcı yönergeyi orkestra ajanına ilet (Enter)"
          >
            Yönerge ver
          </button>
        </div>
      )}
    </section>
  );
}
