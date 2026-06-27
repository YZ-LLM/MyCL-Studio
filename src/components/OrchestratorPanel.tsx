// OrchestratorPanel — orkestratörün TÜM önemli aktivitesini sağ panelde SADE KISA TÜRKÇE gösterir.
// (tool_use + decision + error; started/completed yaşam-döngüsü gürültüsü reducer'da elenir.) Önemli KARARLAR
// farklı/vurgulu renkte. YZLLM: "yaptığı herşeyi yazsın; o iterasyonda neler yapıldı hepsini anlayabileyim;
// sade Türkçe; kısa öz, her iş için en fazla 1-2 cümle." reason/message_to_user zaten Türkçe (orkestratör kuralı).
//
// YZLLM 2026-06-27: (1) KALICI YÖNERGE konuşması (kullanıcı yönergesi + orkestratör cevabı) artık ANA CHAT'TE
// DEĞİL bu panelde — aktivite log'una zaman sırasıyla karışır ("yönerge için konuşurken panel cevap versin").
// (2) "🧠 Orkestratör" loading göstergesi + "📄 Proje Dökümanı" butonu ChatPanel composer-altından buraya taşındı.

import { useEffect, useRef, useState } from "react";
import type { AgentThinkingEvent } from "../App";

/** Kalıcı yönerge konuşması satırı (kullanıcı yönergesi / orkestratör cevabı). */
interface DirectiveMsg {
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
}

interface Props {
  /** App reducer'ın biriktirdiği orkestratör aktivitesi (tool_use + decision + error; cap 500). */
  events: AgentThinkingEvent[];
  /** YZLLM 2026-06-27: kalıcı yönerge konuşması (kullanıcı + orkestratör) — aktivite log'una ts'e göre karışır. */
  directiveMessages?: DirectiveMsg[];
  /** YZLLM 2026-06-26 (req 4): alt composer'dan KALICI YÖNERGE — orkestratör değerlendirir (benimse/itiraz). */
  onDirective?: (text: string) => void;
  /** YZLLM 2026-06-27: orkestratör ajan çalışıyor mu — panel başlığında spinner (ChatPanel'den taşındı). */
  agentBusy?: boolean;
  /** YZLLM 2026-06-27: 📄 Proje Dökümanı butonu — tech-doc modalını açar (ChatPanel'den taşındı). */
  onDocClick?: () => void;
  /** Proje dökümanı içeriği mevcut mu (buton aktif/pasif görünümü). */
  docAvailable?: boolean;
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

/** Kalıcı yönerge konuşması satırı — kullanıcı yönergesi (sağa yaslı, vurgulu) / orkestratör cevabı (sola). */
function DirectiveRow({ msg }: { msg: DirectiveMsg }) {
  const isUser = msg.role === "user";
  return (
    <div
      className={`orch-row orch-row-directive ${isUser ? "orch-row-directive-user" : "orch-row-directive-reply"}`}
      style={{
        borderLeft: `3px solid ${isUser ? "var(--accent, #4a9eff)" : "var(--fg-dim, #888)"}`,
        paddingLeft: 8,
        margin: "4px 0",
        whiteSpace: "pre-wrap",
      }}
    >
      <span className="orch-row-label">{isUser ? "🧭 Yönergen" : "🧭 Orkestratör"}</span>
      <span className="orch-row-text">{msg.text}</span>
    </div>
  );
}

/** Aktivite olayları + yönerge mesajlarını zaman sırasıyla tek log'a birleştir (kronolojik tek görünüm). */
type LogItem =
  | { ts: number; key: string; kind: "activity"; ev: AgentThinkingEvent }
  | { ts: number; key: string; kind: "directive"; msg: DirectiveMsg };

export function OrchestratorPanel({
  events,
  directiveMessages = [],
  onDirective,
  agentBusy,
  onDocClick,
  docAvailable,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");

  const items: LogItem[] = [
    ...events.map((ev): LogItem => ({ ts: ev.ts, key: `a-${ev.seq ?? ev.ts}`, kind: "activity", ev })),
    ...directiveMessages.map(
      (msg, i): LogItem => ({ ts: msg.ts, key: `d-${msg.ts}-${i}`, kind: "directive", msg }),
    ),
  ].sort((a, b) => a.ts - b.ts);

  // Yeni aktivite/yönerge gelince en alta kaydır (kronolojik — en yeni altta, chat ile tutarlı).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  const submitDirective = (): void => {
    const t = draft.trim();
    if (!t || !onDirective) return;
    onDirective(t);
    setDraft("");
  };

  return (
    <section className="panel-vsection">
      <div
        className="panel-label"
        // justifyContent:flex-start → .panel-label CSS'indeki space-between'i ezer (mahkeme LOW): başlık+spinner
        // solda bitişik kalsın, Proje Dökümanı butonu marginLeft:auto ile sağa yapışsın.
        style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-start" }}
      >
        {/* Sayaç görünen TÜM satırları yansıtır (aktivite + yönerge konuşması) → items.length (mahkeme LOW). */}
        <span>Orkestra Ajanı — Yapılanlar ({items.length})</span>
        {agentBusy && (
          <span
            className="agent-busy-spinner"
            aria-label="orkestratör çalışıyor"
            title="Orkestratör ajan düşünüyor…"
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              border: "2px solid var(--fg-dim)",
              borderTopColor: "transparent",
              borderRadius: "50%",
              animation: "mycl-spin 0.8s linear infinite",
            }}
          />
        )}
        {onDocClick && (
          <button
            type="button"
            className="intent-pill"
            data-testid="orch-doc-btn"
            onClick={onDocClick}
            title={
              docAvailable
                ? "Proje teknik dökümanını gör"
                : "Proje dökümanı henüz üretilmedi (MyCL projeye dokundukça oluşturur)"
            }
            style={{ marginLeft: "auto", opacity: docAvailable ? 1 : 0.6 }}
          >
            <span className="intent-pill-emoji" aria-hidden>📄</span>
            <span className="intent-pill-label">Proje Dökümanı</span>
          </button>
        )}
      </div>
      <div className="orchestrator-log" ref={scrollRef}>
        {items.length === 0 ? (
          <p style={{ color: "var(--fg-dim)", fontSize: 12, padding: 12, lineHeight: 1.5 }}>
            Henüz orkestratör aktivitesi yok. Mesaj yazdıkça orkestratörün yaptığı her önemli iş — ne
            yaptığı ve nedeni — burada sade Türkçe görünür; önemli kararlar belirgin renktedir. Aşağıdaki
            kutudan verdiğin kalıcı yönergeler ve orkestratörün cevabı da burada görünür.
          </p>
        ) : (
          items.map((it) =>
            it.kind === "activity" ? (
              <ActivityRow key={it.key} ev={it.ev} />
            ) : (
              <DirectiveRow key={it.key} msg={it.msg} />
            ),
          )
        )}
      </div>
      {/* Alt composer (YZLLM req 4): görev değil, KALICI YÖNERGE (işin nasıl yapılacağı çapası). Orkestratör
          değerlendirir — itirazı varsa söyler, yoksa benimser (~/.mycl/directives.md → sonraki işlere enjekte).
          Cevap ana chat'e değil yukarıdaki log'a yazılır (YZLLM 2026-06-27). */}
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
