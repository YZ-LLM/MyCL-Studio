// ChatPanel — Sol panel: TR sohbet + composer + askq render. Spec §4.2.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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

/** YZLLM: "chat'teki yazılarda cümleler alt alta yazılsın." Cümle-sonu noktalama + boşluk + (büyük harf /
 *  tırnak / parantez) görülünce satır başı eklenir → `white-space:pre-wrap` her cümleyi kendi satırına koyar.
 *  Dosya yolu / sayı / kısaltma (noktadan SONRA boşluk yoksa ya da küçük harf gelirse) BÖLÜNMEZ. */
function splitSentences(text: string): string {
  return text.replace(/([.!?…])[ \t]+(?=[A-ZÇĞİÖŞÜ"'([])/g, "$1\n");
}

/** Faz geçiş çizgisi — chat'te bir faz başladığında araya girer (YZLLM: "fazlar arasındaki geçişlerde çizgi"). */
function PhaseDivider({ faz }: { faz: number }) {
  return (
    <div className="phase-divider" aria-hidden="true">
      <span className="phase-divider-label">Faz {faz}</span>
    </div>
  );
}

/** Açılır "Detay göster" — mesajın SADE metnini bozmadan ham teknik açıklamayı (dosya/satır/kod) talep üzerine
 *  gösterir. YZLLM 2026-06-30: hata-analizi özeti sade gelir; teknik detaya buradan erişilir. Hata mesajı stack
 *  trace'i için de kullanılır. stopPropagation: toggle tıklaması mesaj-seçimini (onMessageSelected) tetiklemesin.
 *  YZLLM 2026-07-05 (Feature B): detail'in yanında opsiyonel "Kodu göster" butonu — code_ref VARSA salt-okunur
 *  kod popup'ını açar (onShowCode). detail YOK ama code_ref VAR olabilir → yalnız "Kodu göster" render edilir;
 *  ikisi de yoksa null döner. */
function DetailDisclosure({
  detail,
  code_ref,
  onShowCode,
}: {
  detail?: string;
  code_ref?: { file: string; startLine: number; endLine: number; snippet: string };
  onShowCode?: (ref: { file: string; startLine: number; endLine: number; snippet: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!detail && !code_ref) return null;
  const showCodeBtn = code_ref && onShowCode;
  return (
    <>
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        {detail && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!open);
            }}
            style={{
              fontSize: 10,
              padding: "2px 6px",
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--fg-dim)",
              cursor: "pointer",
              borderRadius: 4,
            }}
          >
            {open ? "Detayı gizle" : "Detay göster"}
          </button>
        )}
        {showCodeBtn && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onShowCode(code_ref);
            }}
            style={{
              fontSize: 10,
              padding: "2px 6px",
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--fg-dim)",
              cursor: "pointer",
              borderRadius: 4,
            }}
          >
            Kodu göster
          </button>
        )}
      </div>
      {detail && open && (
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
          {detail}
        </pre>
      )}
    </>
  );
}

function ErrorMessage({
  msg,
  onShowCode,
}: {
  msg: ChatMessage;
  onShowCode?: (ref: { file: string; startLine: number; endLine: number; snippet: string }) => void;
}) {
  return (
    <div className="msg error">
      <div>{linkifyText(msg.text)}</div>
      <DetailDisclosure detail={msg.detail} code_ref={msg.code_ref} onShowCode={onShowCode} />
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
  /** YZLLM 2026-07-05 (Feature B): MyCL kodla ilgili cevapta ilgili kod konumu — "Kodu göster" popup'ı besler. */
  code_ref?: { file: string; startLine: number; endLine: number; snippet: string };
  /** Cross-panel focus için. Backend emit ts'i, frontend mesajlar Date.now(). */
  ts: number;
}

export interface PendingAskq {
  id: string;
  /** Sorulma zamanı — kart kronolojik konumda render edilsin (sonra yazılan mesaj altta). */
  ts: number;
  question: string;
  options: AskqOption[];
  allow_other?: boolean;
  multi_select?: boolean;
  /** v15.7 (2026-05-26): Ana ajan önerisi — AskqCard bu seçeneği vurgular. */
  suggested_option?: string;
}

interface Props {
  messages: ChatMessage[];
  /** YZLLM 2026-06-12: İterasyonun Faz 1 hedefi (NİYET kutusu). Varsa heuristiğe tercih edilir. */
  pendingAskq: PendingAskq | null;
  runningBanner: { label: string; detail?: string; ts: number } | null;
  disabled: boolean;
  /** Sidebar niyet seçili — composer placeholder'ı niyet açıklamasıyla değişir. */
  composerPlaceholder?: string;
  onSend: (text: string) => void;
  onAskqAnswer: (id: string, selected: string | string[]) => void;
  /** Cross-panel focus: tıklanan mesajın ts'i. null → highlight yok. Faz tıklamasında o fazın
   *  başlangıç ts'ine set edilir → ChatPanel o fazın ilk mesajına kayar. */
  selectedTs: number | null;
  onMessageSelected: (ts: number) => void;
  /** Faz geçiş işaretçileri (ts + faz no) — chat'te faz başlangıcında çizgi göster. */
  phaseMarkers?: { ts: number; to: number }[];
  /** Lazy-load: scroll-to-top'ta tetiklenir. */
  olderAvailable: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  /** v15.7 (2026-05-24): Composer'daki metni iş kuyruğuna ekle. */
  onAddTaskToQueue?: (text: string) => void;
  /** v15.13 (saha 3/5): Oto-cevap — önerili netleştirme soruları otomatik yanıtlansın mı. */
  autoAnswer?: boolean;
  onAutoAnswerToggle?: (enabled: boolean) => void;
  /** YZLLM 2026-07-08: entegre (foreign) projede oto-cevap KAPSAMLI çalışır (yalnız güvenli akış kararları). Checkbox
   *  etkileşimli kalır; yalnız etiket/tooltip "güvenli kararlarda oto"ya döner. (Eski: tamamen devre-dışı.) */
  autoAnswerForeignScoped?: boolean;
  /** YZLLM 2026-07-09: HİÇBİR ŞEY SORMA (tam otonom) — oto-cevabın üst-seviyesi; açıkken MyCL kullanıcıya hiç
   *  sormaz, zor/riskli kararlar mahkemeye gider. Oto-cevap görsel açık+kilitli (superset). */
  neverAsk?: boolean;
  onNeverAskToggle?: (enabled: boolean) => void;
  /** WP4 DAST: 🛡️ Güvenlik Taraması butonu — backend açıklama+onay askq'ı açar
   *  (buton DOĞRUDAN taramaz). Yalnız çalışan localhost app'ine. */
  onDastClick?: () => void;
  onFullTestClick?: () => void;
  fullTestRunning?: boolean;
  /** WP4 DAST: tarama sürüyor mu — buton spinner + disabled (çift-tetik koruması). */
  dastRunning?: boolean;
  /** YZLLM 2026-06-17: o anki iş — ChatPanel başlığında "Tümünü kopyala" yanında gösterilir. */
  currentJob?: string | null;
  /** YZLLM 2026-07-05 (Feature B): "Kodu göster" → App salt-okunur kod popup'ını açar. code_ref'i olan mesajlarda
   *  DetailDisclosure bu callback'i çağırır. Verilmezse "Kodu göster" butonu render edilmez. */
  onShowCode?: (ref: { file: string; startLine: number; endLine: number; snippet: string }) => void;
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
  phaseMarkers,
  olderAvailable,
  loadingOlder,
  onLoadOlder,
  onAddTaskToQueue,
  autoAnswer,
  onAutoAnswerToggle,
  autoAnswerForeignScoped,
  neverAsk,
  onNeverAskToggle,
  onDastClick,
  dastRunning,
  onFullTestClick,
  fullTestRunning,
  currentJob,
  onShowCode,
}: Props) {
  const [draft, setDraft] = useState("");
  // YZLLM 2026-06-19: balona "Yanıtla" → o mesajı alıntıla, composer'da kısa göster; gönderince alıntı eklenir.
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
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

  // Faz çizgisi: her faz işaretçisinin ts'ine göre o fazın İLK mesajının id'si → o mesajdan ÖNCE çizgi koyulur.
  const dividerBeforeMsgId = useMemo(() => {
    const map = new Map<number, number>();
    for (const marker of phaseMarkers ?? []) {
      const first = messages.find((m) => m.ts >= marker.ts);
      if (first) map.set(first.id, marker.to);
    }
    return map;
  }, [phaseMarkers, messages]);

  // Faz tıklamasında (selectedTs = faz başlangıç ts) o ts'ten itibaren ilk mesaja kay.
  const scrollTargetMsgId = useMemo(
    () => (selectedTs === null ? null : (messages.find((m) => m.ts >= selectedTs)?.id ?? null)),
    [selectedTs, messages],
  );
  const scrollTargetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedTs === null) return;
    scrollTargetRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
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
    headTsRef.current = newHeadTs; // prepend takibi her zaman güncel kalsın (autoAnswer toggle'ında tutarlı)
    if (isPrepend) return; // lazy-load sonrası scroll position'u koru
    // YZLLM 2026-06-27: yeni içerikte (mesaj/askq/banner-heartbeat) otomatik aşağı kaydırma YALNIZ oto-cevap
    // AÇIKKEN. Oto-cevap KAPALIYKEN kullanıcı içeriği okur/karar verir → yeni mesaj ya da 60s'lik banner-heartbeat
    // onu aşağı YANKILAMASIN. (İlk-açılış scroll'u + faza-tıkla-git ayrı efektler; onlar etkilenmez.)
    if (!autoAnswer) return;
    if (Date.now() - lastFocusTs.current < 2000) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages, pendingAskq, runningBanner, autoAnswer]);

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
    // Yanıt modunda alıntıyı (markdown blockquote, kırpılmış) mesajın başına ekle → orkestratör/main bağlamı görsün.
    const finalText = replyingTo
      ? `> ${replyingTo.slice(0, 280).replace(/\n/g, "\n> ")}${replyingTo.length > 280 ? " …" : ""}\n\n${text}`
      : text;
    onSend(finalText);
    setDraft("");
    setReplyingTo(null);
  };

  // YZLLM 2026-06-12: chat balonlarına + tüm sohbete kopyalama. clipboard yazımı + kısa "✓" geri bildirimi
  // (1.2sn). copiedId="__all__" → tüm-sohbet butonu; aksi mesaj id'si.
  const [copiedId, setCopiedId] = useState<string | number | null>(null);
  const copyText = (text: string, id: string | number): void => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopiedId(id);
        setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1200);
      })
      .catch(() => undefined);
  };
  const copyAll = (): void => {
    copyText(messages.map((m) => `[${m.role}] ${m.text}`).join("\n\n"), "__all__");
  };

  return (
    <section className="panel" data-testid="chat-panel">
      <div className="panel-label">
        {/* YZLLM 2026-06-27: kopya-butonu + KONU sol grupta (panel-label space-between'i konuyu sağa itiyordu;
            kullanıcı "konuyu sola al" dedi). Konu artık solda; üstteki (AppHeader) kopyası kaldırıldı (tek yer). */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          {messages.length > 0 && (
            <button
              type="button"
              className="chat-copy-all"
              title="Tüm sohbeti kopyala"
              onClick={copyAll}
            >
              {copiedId === "__all__" ? "✓ Kopyalandı" : "⧉ Tümünü kopyala"}
            </button>
          )}
          {currentJob && currentJob.trim() && (
            <span
              className="chat-current-job"
              data-testid="chat-current-job"
              title={currentJob}
              style={{
                maxWidth: 520,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                opacity: 0.8,
                fontSize: 12,
              }}
            >
              🔧 {currentJob.trim()}
            </span>
          )}
        </div>
      </div>
      <div className="chat-messages" ref={scrollRef} onScroll={handleScroll}>
        {loadingOlder && (
          <div className="lazy-loading">Daha eski mesajlar yükleniyor…</div>
        )}
        {(() => {
          const renderMsg = (m: ChatMessage) => {
            const highlighted = selectedTs === m.ts ? " highlighted" : "";
            const tsLabel = fmtTs(m.ts);
            // Bu mesajdan ÖNCE faz çizgisi koyulacak mı + faz-jump scroll hedefi mi.
            const divPhase = dividerBeforeMsgId.get(m.id);
            const tRef = m.id === scrollTargetMsgId ? scrollTargetRef : undefined;
            const copyBtn = (
              <button
                type="button"
                className="msg-copy"
                title="Bu mesajı kopyala"
                onClick={(e) => {
                  e.stopPropagation();
                  copyText(m.text, m.id);
                }}
              >
                {copiedId === m.id ? "✓" : "⧉"}
              </button>
            );
            // YZLLM 2026-06-19: balona "Yanıtla" — o mesajı alıntılayıp composer'da göster.
            const replyBtn = (
              <button
                type="button"
                className="msg-reply"
                title="Bu mesaja yanıt ver (composer'da alıntıla)"
                aria-label="Yanıtla"
                onClick={(e) => {
                  e.stopPropagation();
                  setReplyingTo(m.text);
                }}
              >
                ↩
              </button>
            );
            if (m.role === "error") {
              return (
                <Fragment key={m.id}>
                  {divPhase !== undefined && <PhaseDivider faz={divPhase} />}
                  <div
                    ref={tRef}
                    onClick={() => onMessageSelected(m.ts)}
                    className={highlighted ? "msg-wrap highlighted" : "msg-wrap"}
                  >
                    {tsLabel && <span className="msg-ts">{tsLabel}</span>}
                    <ErrorMessage msg={m} onShowCode={onShowCode} />
                    {replyBtn}
                    {copyBtn}
                  </div>
                </Fragment>
              );
            }
            return (
              <Fragment key={m.id}>
                {divPhase !== undefined && <PhaseDivider faz={divPhase} />}
                <div
                  ref={tRef}
                  className={`msg ${m.role}${highlighted}`}
                  onClick={() => onMessageSelected(m.ts)}
                >
                  {tsLabel && <span className="msg-ts">{tsLabel}</span>}
                  {linkifyText(splitSentences(m.text))}
                  {/* YZLLM 2026-06-30: sade mesaj + istenirse "Detay göster" (hata-analizi teknik açıklaması).
                      YZLLM 2026-07-05 (Feature B): code_ref varsa yanında "Kodu göster" (salt-okunur kod popup'ı). */}
                  <DetailDisclosure detail={m.detail} code_ref={m.code_ref} onShowCode={onShowCode} />
                  {replyBtn}
                  {copyBtn}
                </div>
              </Fragment>
            );
          };
          if (!pendingAskq) return messages.map(renderMsg);
          const card = (
            <AskqCard
              key="pending-askq"
              question={pendingAskq.question}
              options={pendingAskq.options}
              allowOther={pendingAskq.allow_other}
              multiSelect={pendingAskq.multi_select}
              suggestedOption={pendingAskq.suggested_option}
              onAnswer={(sel) => onAskqAnswer(pendingAskq.id, sel)}
            />
          );
          // Askq kartını KRONOLOJİK konumda göster: sorulmasından SONRA composer'dan yazılan mesaj kartın
          // ALTINDA görünsün (YZLLM: "yazım yukarı geliyordu, aşağıya gelmeli"). Kart en altta sabit DEĞİL.
          const before = messages.filter((m) => m.ts <= pendingAskq.ts);
          const after = messages.filter((m) => m.ts > pendingAskq.ts);
          return (
            <>
              {before.map(renderMsg)}
              {card}
              {after.map(renderMsg)}
            </>
          );
        })()}
      </div>
      {runningBanner && (
        <div
          className="running-banner"
          data-testid="running-banner"
          title={runningBanner.detail ?? ""}
        >
          <span className="running-spinner" aria-hidden>⏳</span>
          <div className="running-text">
            <span className="running-label">{runningBanner.label}</span>
            {runningBanner.detail && (
              <span className="running-detail">{runningBanner.detail}</span>
            )}
          </div>
        </div>
      )}
      {replyingTo && (
        <div className="reply-preview" data-testid="reply-preview">
          <span className="reply-preview-label" aria-hidden>↩</span>
          <span className="reply-preview-text">
            {replyingTo.slice(0, 120)}
            {replyingTo.length > 120 ? "…" : ""}
          </span>
          <button
            type="button"
            className="reply-preview-cancel"
            title="Yanıtı iptal et"
            aria-label="Yanıtı iptal et"
            onClick={() => setReplyingTo(null)}
          >
            ✕
          </button>
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
          data-testid="composer-input"
          placeholder={
            composerPlaceholder ?? "MyCL'e yaz... (Enter gönderir, Shift+Enter alt satır)"
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
        {/* v15.7 (2026-05-24): "Soru Sor" / "Hata Ayıkla" intent button'ları kaldırıldı — orchestrator ajan
            composer'daki metni otomatik classify ediyor.
            YZLLM 2026-06-27: "🧠 Orkestratör" loading göstergesi + "📄 Proje Dökümanı" butonu BURADAN ALINIP
            sağdaki Orkestra Ajanı paneline taşındı (ait olduğu yer orası). marginLeft:auto artık ilk kalan
            öğede (Oto-cevap) → araç çubuğu sağa hizalı kalır. */}
        {/* v15.13 (saha 3/5): Oto-cevap checkbox. Açıkken önerili netleştirme soruları otomatik yanıtlanır. */}
        {onAutoAnswerToggle && (
          <label
            className="intent-pill"
            title={
              neverAsk
                ? "Hiçbir şey sorma modu açıkken oto-cevap zorunlu açıktır (üst-seviye kapsar)."
                : autoAnswerForeignScoped
                  ? "Entegre modda oto-cevap yalnız GÜVENLİ akış kararlarında çalışır (onaylar, faz-kapsamı, kavrama). Var olan kodu/DB/güvenliği değiştiren kararlar ve önemli tercih (mock mu gerçek-DB mi) soruları HEP sana gelir."
                  : "Açıkken: bir önerisi olan netleştirme soruları otomatik o öneriyle yanıtlanır (daha hızlı iterasyon). Onaylar + önerisi olmayan sorular yine size sorulur."
            }
            style={{
              marginLeft: "auto",
              cursor: neverAsk ? "default" : "pointer",
              opacity: neverAsk ? 0.6 : 1,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <input
              type="checkbox"
              data-testid="auto-answer-toggle"
              checked={!!autoAnswer || !!neverAsk}
              disabled={!!neverAsk}
              onChange={(e) => onAutoAnswerToggle(e.target.checked)}
              style={{ margin: 0 }}
            />
            <span className="intent-pill-label">
              Oto-cevap{autoAnswerForeignScoped && !neverAsk ? " (güvenli kararlarda oto)" : ""}
            </span>
          </label>
        )}
        {/* YZLLM 2026-07-09: HİÇBİR ŞEY SORMA (tam otonom) checkbox — oto-cevabın üst-seviyesi (superset). */}
        {onNeverAskToggle && (
          <label
            className="intent-pill"
            title="Açıkken: MyCL kararları kendi verir, zor/riskli olanları mahkemeye götürür — onay, netleştirme ve UI-inceleme soruları otomatik geçilir; entegre (yabancı) projede var olan kodu değiştiren düzeltmeler dokunulan davranışı GÖSTEREREK otomatik uygulanır (her karar sohbette görünür). Koruma devrede kalan İSTİSNALAR (yine onayın/durur): yıkıcı işlemler (iş/pipeline iptali), düşük-güvenli/belirsiz onaylar, kalıcı model ayarı ve yıkıcı kabuk komutları."
            style={{
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <input
              type="checkbox"
              data-testid="never-ask-toggle"
              checked={!!neverAsk}
              onChange={(e) => onNeverAskToggle(e.target.checked)}
              style={{ margin: 0 }}
            />
            <span className="intent-pill-label">Hiçbir şey sorma</span>
          </label>
        )}
        {/* YZLLM 2026-06-27: 📄 Proje Dökümanı butonu sağdaki Orkestra Ajanı paneline taşındı. */}
        {/* YZLLM 2026-07-03: 🕵️ Kalite Kontrol butonu buradan KALDIRILDI (denetim ajanı akışı
            orkestratörde korunuyor, yalnız UI girişi çıkarıldı). */}
        {/* v15.7 (2026-05-24): "İş Ekle" buton — composer'daki metni proje
            iş kuyruğuna ekler, composer temizlenir. Boş draft'ta disabled. */}
        {onAddTaskToQueue && (
          <button
            type="button"
            className="intent-pill"
            data-testid="intent-add-task"
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
        {/* WP4 DAST: 🛡️ Güvenlik Taraması — buton backend onay askq'ı açar (doğrudan
            taramaz). Spinner sticky banner'dan (dastRunning) türetilir. */}
        {onDastClick && (
          <button
            type="button"
            className="intent-pill"
            data-testid="intent-dast"
            onClick={onDastClick}
            disabled={dastRunning}
            title={
              dastRunning
                ? "Güvenlik taraması sürüyor…"
                : "Çalışan localhost uygulamana aktif güvenlik taraması (DAST) — önce açıklar + onay sorar"
            }
          >
            <span className="intent-pill-emoji" aria-hidden>🛡️</span>
            <span className="intent-pill-label">
              Güvenlik Taraması
              {dastRunning && (
                <span
                  className="agent-busy-spinner"
                  aria-label="tarama çalışıyor"
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
            </span>
          </button>
        )}
        {/* 🧪 Full Test (2026-07-16): tüm proje testi — buton backend onay askq'ı açar
            (doğrudan koşmaz). Spinner sticky banner'dan (fullTestRunning) türetilir. */}
        {onFullTestClick && (
          <button
            type="button"
            className="intent-pill"
            data-testid="intent-full-test"
            onClick={onFullTestClick}
            disabled={fullTestRunning}
            title={
              fullTestRunning
                ? "Full Test sürüyor…"
                : "Tüm projeyi test et: birim + entegrasyon + E2E (Playwright) + rota taraması + erişilebilirlik + görsel — önce açıklar + onay sorar"
            }
          >
            <span className="intent-pill-emoji" aria-hidden>🧪</span>
            <span className="intent-pill-label">
              Full Test
              {fullTestRunning && (
                <span
                  className="agent-busy-spinner"
                  aria-label="test çalışıyor"
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
            </span>
          </button>
        )}
      </div>
    </section>
  );
}
