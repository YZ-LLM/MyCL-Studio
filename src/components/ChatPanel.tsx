// ChatPanel — Sol panel: TR sohbet + composer + askq render. Spec §4.2.

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AskqCard, type AskqOption } from "./AskqCard";
import { fmtTs } from "../utils/format";

/**
 * Plain-text mesajda URL'leri tespit edip <a> ile sarmalar. Markdown render
 * değil — sadece http(s) link auto-linkify. Trailing noktalama (.,!?;:) URL
 * dışında bırakılır. Tauri webview'da target="_blank" external browser açar.
 */
import { openUrl } from "@tauri-apps/plugin-opener";

// URL matcher: hem tam URL (https://example.com) hem bare host:port
// (localhost:5173, 127.0.0.1:8080) hem de path uzantısı. Trailing
// punctuation (".", ",", ")") aşağıda kodda trim ediliyor — regex
// içine koyarsak ".org" gibi geçerli karakterleri yutar.
// Port ZORUNLU localhost/127.0.0.1 için — port'suz "localhost" tıklanınca
// port 80'e gider, dev server yoktur, kullanıcı boş sayfa görür. Sadece
// port'lu form clickable.
const URL_REGEX =
  /\b(?:https?:\/\/[^\s<>"']+|(?:localhost|127\.0\.0\.1):\d+(?:\/[^\s<>"']*)?)/g;
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

function linkifyText(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const raw = match[0];
    const trimmed = raw.replace(TRAILING_PUNCT, "");
    const href = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
    parts.push(
      <a
        key={`url-${match.index}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "var(--accent)", textDecoration: "underline" }}
        onClick={(e) => {
          // Tauri webview <a target="_blank"> default'ta hiçbir şey yapmaz —
          // tauri-plugin-opener ile OS browser'da aç.
          e.preventDefault();
          e.stopPropagation();
          void openUrl(href).catch((err) => {
            console.error("openUrl failed", err);
          });
        }}
      >
        {trimmed}
      </a>,
    );
    lastIndex = match.index + trimmed.length;
    // Trimlenen punctuation'lar text içinde kalır (sonraki segment toplar)
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : [text];
}

function ErrorMessage({ msg }: { msg: ChatMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="msg error">
      <div>{linkifyText(msg.text)}</div>
      {msg.detail && (
        <>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            style={{
              fontSize: 10,
              padding: "2px 6px",
              marginTop: 4,
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--fg-dim)",
            }}
          >
            {open ? "Detayı gizle" : "Detay"}
          </button>
          {open && (
            <pre
              style={{
                marginTop: 6,
                padding: 8,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--fg-dim)",
                maxHeight: 200,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {msg.detail}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

// v15.7 (2026-05-24): IntentKind UI button'ları kaldırıldı. Backend
// intent-router/classifier hala "question/debug/chat" tespit ediyor ama
// kullanıcı niyetini composer'a yazıyor — orchestrator ajan otomatik route ediyor.
// Sidebar UI sadeleştirildi: "Soru Sor" / "Hata Ayıkla" butonları yok.

export type ChatRole = "user" | "assistant" | "system" | "error";

export interface ChatMessage {
  id: number;
  role: ChatRole;
  text: string;
  /** Hata mesajları için ekstra stack trace / detay (collapsed). */
  detail?: string;
  /** Cross-panel focus için. Backend emit ts'i, frontend mesajlar Date.now(). */
  ts: number;
}

export interface PendingAskq {
  id: string;
  question: string;
  options: AskqOption[];
  allow_other?: boolean;
  multi_select?: boolean;
  /** v15.7 (2026-05-26): Ana ajan önerisi — AskqCard bu seçeneği vurgular. */
  suggested_option?: string;
}

interface Props {
  messages: ChatMessage[];
  pendingAskq: PendingAskq | null;
  runningBanner: { label: string; detail?: string; ts: number } | null;
  disabled: boolean;
  /** Sidebar niyet seçili — composer placeholder'ı niyet açıklamasıyla değişir. */
  composerPlaceholder?: string;
  onSend: (text: string) => void;
  onAskqAnswer: (id: string, selected: string | string[]) => void;
  /** Cross-panel focus: tıklanan mesajın ts'i. null → highlight yok. */
  selectedTs: number | null;
  onMessageSelected: (ts: number) => void;
  /** Lazy-load: scroll-to-top'ta tetiklenir. */
  olderAvailable: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  /** v15.6: 🧠 Orkestrator butonu — modal trigger (intent DEĞİL).
   *  Tıklanınca agent'ın son tool call + decision listesi açılır.
   *  agentEventsCount badge için sayı gösterilebilir. */
  onOrchestratorClick?: () => void;
  agentEventsCount?: number;
  /** v15.6: Agent çalışıyor mu — Orkestrator butonu yanında spinner gösterir. */
  agentBusy?: boolean;
  /** v15.7 (2026-05-24): Composer'daki metni iş kuyruğuna ekle. */
  onAddTaskToQueue?: (text: string) => void;
  /** v15.11: 📖 Kılavuz butonu — UI kullanma kılavuzu modalını açar. */
  onGuideClick?: () => void;
  /** v15.11: Kılavuz içeriği mevcut mu (buton aktif/pasif görünümü). */
  guideAvailable?: boolean;
}

export function ChatPanel({
  messages,
  pendingAskq,
  runningBanner,
  disabled,
  composerPlaceholder,
  onSend,
  onAskqAnswer,
  selectedTs,
  onMessageSelected,
  olderAvailable,
  loadingOlder,
  onLoadOlder,
  onOrchestratorClick,
  agentEventsCount,
  agentBusy,
  onAddTaskToQueue,
  onGuideClick,
  guideAvailable,
}: Props) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Cross-panel focus aktif edildikten sonra 2sn auto-scroll bottom pasif. */
  const lastFocusTs = useRef<number>(0);
  /** Lazy-load throttle (500ms) — scroll event spam'ini önle. */
  const lastLoadCallTs = useRef<number>(0);
  /** Prepend detect: messages[0].id sabit kalır ama bizde ID re-numbered olur,
   *  o yüzden head element'in ts'ini izle. Değişirse prepend olmuş demek. */
  const headTsRef = useRef<number | null>(null);

  // selectedTs değiştiğinde auto-scroll'u 2sn pasifle.
  useEffect(() => {
    if (selectedTs !== null) lastFocusTs.current = Date.now();
  }, [selectedTs]);

  // İlk mount: history.log async yüklendikten sonra scroll en altta olsun.
  // 3xRAF + 250ms safety: layout + image reflow için.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollBottom = (): void => {
      el.scrollTop = el.scrollHeight;
    };
    requestAnimationFrame(() =>
      requestAnimationFrame(() => requestAnimationFrame(scrollBottom)),
    );
    const t = setTimeout(scrollBottom, 250);
    return () => clearTimeout(t);
  }, []);

  // Auto-scroll bottom on new content. Prepend (head ts daha eskiye doğru
  // değişti) → tetiklenmesin; focus sırasında 2sn pas. Initial history load
  // sırasında scrollHeight effect tetiklendiğinde stale olabiliyordu →
  // requestAnimationFrame ile DOM update sonrasına ertele. runningBanner
  // dep'i de eklendi (2026-05-23): banner görününce/kaybolunca chat-messages
  // yüksekliği değişir; scroll pozisyonu güncellenmezse son mesaj banner
  // sınırında yarıdan kesilir.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const newHeadTs = messages.length > 0 ? messages[0].ts : null;
    const isPrepend =
      headTsRef.current !== null &&
      newHeadTs !== null &&
      newHeadTs < headTsRef.current;
    headTsRef.current = newHeadTs;
    if (isPrepend) return; // lazy-load sonrası scroll position'u koru
    if (Date.now() - lastFocusTs.current < 2000) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages, pendingAskq, runningBanner]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop < 200 && olderAvailable && !loadingOlder) {
      const now = Date.now();
      if (now - lastLoadCallTs.current < 500) return;
      lastLoadCallTs.current = now;
      onLoadOlder();
    }
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft("");
  };

  // İlk Faz 1 prompt'u — sabit kutu (Ümit 2026-05-23). Kullanıcının ilk
  // yazdığı user mesajı; pipeline ilerledikçe ne istediğini hatırlatır.
  const firstUserPrompt = messages.find((m) => m.role === "user")?.text;

  return (
    <section className="panel">
      <div className="panel-label">MyCL</div>
      {firstUserPrompt && (
        <div className="first-prompt-box" title={firstUserPrompt}>
          <span className="first-prompt-label">Niyet</span>
          <span className="first-prompt-text">{firstUserPrompt}</span>
        </div>
      )}
      <div className="chat-messages" ref={scrollRef} onScroll={handleScroll}>
        {loadingOlder && (
          <div className="lazy-loading">Daha eski mesajlar yükleniyor…</div>
        )}
        {messages.map((m) => {
          const highlighted = selectedTs === m.ts ? " highlighted" : "";
          const tsLabel = fmtTs(m.ts);
          if (m.role === "error") {
            return (
              <div
                key={m.id}
                onClick={() => onMessageSelected(m.ts)}
                className={highlighted ? "msg-wrap highlighted" : "msg-wrap"}
              >
                {tsLabel && <span className="msg-ts">{tsLabel}</span>}
                <ErrorMessage msg={m} />
              </div>
            );
          }
          return (
            <div
              key={m.id}
              className={`msg ${m.role}${highlighted}`}
              onClick={() => onMessageSelected(m.ts)}
            >
              {tsLabel && <span className="msg-ts">{tsLabel}</span>}
              {linkifyText(m.text)}
            </div>
          );
        })}
        {pendingAskq && (
          <AskqCard
            question={pendingAskq.question}
            options={pendingAskq.options}
            allowOther={pendingAskq.allow_other}
            multiSelect={pendingAskq.multi_select}
            suggestedOption={pendingAskq.suggested_option}
            onAnswer={(sel) => onAskqAnswer(pendingAskq.id, sel)}
          />
        )}
      </div>
      {runningBanner && (
        <div className="running-banner" title={runningBanner.detail ?? ""}>
          <span className="running-spinner" aria-hidden>⏳</span>
          <span className="running-label">{runningBanner.label}</span>
          {runningBanner.detail && (
            <span className="running-detail">{runningBanner.detail}</span>
          )}
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          className="composer-input"
          placeholder={
            composerPlaceholder ??
            "MyCL'e yaz... (Enter gönderir, Shift+Enter alt satır)"
          }
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={5}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </form>
      <div className="intent-row" role="toolbar" aria-label="Araç Çubuğu">
        {/* v15.7 (2026-05-24): "Soru Sor" / "Hata Ayıkla" intent button'ları
            kaldırıldı — orchestrator ajan composer'daki metni otomatik
            classify ediyor. Sadece Orkestrator (ve ileride iş kuyruğu)
            butonları kaldı. */}
        {/* v15.6: 🧠 Orkestrator — modal trigger (intent button DEĞİL).
            Agent thinking event'leri açılır. agentEventsCount badge gösterir. */}
        {onOrchestratorClick && (
          <button
            type="button"
            className="intent-pill"
            onClick={onOrchestratorClick}
            title={
              agentBusy
                ? "Orkestrator ajan düşünüyor..."
                : "Orkestrator ajanın son düşüncelerini gör"
            }
            style={{ marginLeft: "auto" }}
          >
            <span className="intent-pill-emoji" aria-hidden>🧠</span>
            <span className="intent-pill-label">
              Orkestrator
              {agentBusy && (
                <span
                  className="agent-busy-spinner"
                  aria-label="ajan çalışıyor"
                  style={{
                    display: "inline-block",
                    marginLeft: 6,
                    width: 10,
                    height: 10,
                    border: "2px solid var(--fg-dim)",
                    borderTopColor: "transparent",
                    borderRadius: "50%",
                    verticalAlign: "middle",
                    animation: "mycl-spin 0.8s linear infinite",
                  }}
                />
              )}
              {!agentBusy &&
                agentEventsCount !== undefined &&
                agentEventsCount > 0 && (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      padding: "1px 5px",
                      background: "var(--accent)",
                      color: "white",
                      borderRadius: 8,
                    }}
                  >
                    {agentEventsCount}
                  </span>
                )}
            </span>
          </button>
        )}
        {/* v15.11: 📖 Kılavuz — UI kullanma kılavuzu modalını açar. */}
        {onGuideClick && (
          <button
            type="button"
            className="intent-pill"
            onClick={onGuideClick}
            title={
              guideAvailable
                ? "UI kullanma kılavuzunu gör"
                : "Kılavuz henüz üretilmedi (MyCL projeye dokundukça oluşturur)"
            }
            style={{ opacity: guideAvailable ? 1 : 0.6 }}
          >
            <span className="intent-pill-emoji" aria-hidden>📖</span>
            <span className="intent-pill-label">Kılavuz</span>
          </button>
        )}
        {/* v15.7 (2026-05-24): "İş Ekle" buton — composer'daki metni proje
            iş kuyruğuna ekler, composer temizlenir. Boş draft'ta disabled. */}
        {onAddTaskToQueue && (
          <button
            type="button"
            className="intent-pill"
            onClick={() => {
              const txt = draft.trim();
              if (!txt) return;
              onAddTaskToQueue(txt);
              setDraft("");
            }}
            disabled={draft.trim().length === 0}
            title="Composer'daki metni iş kuyruğuna ekle"
          >
            <span className="intent-pill-emoji" aria-hidden>➕</span>
            <span className="intent-pill-label">İş Ekle</span>
          </button>
        )}
      </div>
    </section>
  );
}
