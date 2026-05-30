// ClaudeSimulator — Sağ alt panel: MyCL-rendered Claude Code UI. Spec §4.4.
//
// **KRİTİK**: Bu Claude Code'un native TUI'sı DEĞİL. Stream-json event'leri
// MyCL tarafından parse edilir ve burası onlardan UI inşa eder. EN-only
// (ADR-009 — Claude'un perspektifinde Türkçe yok).

import { useEffect, useRef, useState } from "react";
import { fmtTs } from "../utils/format";

export type CCEventKind =
  | "init"
  | "request"
  | "text"
  | "tool_use"
  | "tool_result"
  | "retry"
  | "error"
  | "stop";

export interface CCEvent {
  id: number;
  sub: CCEventKind;
  text?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  is_error?: boolean;
  model?: string;
  cwd?: string;
  /** sub="request" ile birlikte: Claude'a giden EN system + initial user mesajı. */
  system?: string;
  user_message?: string;
  /** Cross-panel focus için backend ts. */
  ts: number;
}

interface Props {
  events: CCEvent[];
  banner: {
    version: string;
    model: string;
    cwd: string;
    turn?: number;
    max_turns?: number;
    /** Cumulative token sayaçları — App.tsx token_usage event'lerinden toplar. */
    tokens_input: number;
    tokens_output: number;
    cache_read: number;
    cache_write: number;
    turns_counted: number;
  } | null;
  modelLabel: string;
  /** Cross-panel focus penceresi: [from, to). null → highlight yok. */
  highlightWindow: { from: number; to: number } | null;
}

/**
 * Anthropic per-MTok USD fiyatı (yaklaşık). Opus 4.x ve Haiku 4.x için aralık.
 * Cache read %10, cache write %125 base input. Output prices ayrı.
 * Net fiyat istemiyoruz — sadece kullanıcıya **mertebe** vermek için.
 */
function estimateCostUsd(opts: {
  model: string;
  tokens_input: number;
  tokens_output: number;
  cache_read: number;
  cache_write: number;
}): number {
  const m = opts.model.toLowerCase();
  let inUsdPerMTok = 3.0;
  let outUsdPerMTok = 15.0;
  if (m.includes("opus")) {
    inUsdPerMTok = 15.0;
    outUsdPerMTok = 75.0;
  } else if (m.includes("haiku")) {
    inUsdPerMTok = 1.0;
    outUsdPerMTok = 5.0;
  }
  // Cache read 0.1×, cache write 1.25× input fiyatı.
  // input_tokens API'de cache_read + cache_write hariç **uncached** miktar gibi
  // çıkar; toplam estimate için uncached + read*0.1 + write*1.25 olarak hesapla.
  const inputUsd =
    (opts.tokens_input / 1_000_000) * inUsdPerMTok +
    (opts.cache_read / 1_000_000) * inUsdPerMTok * 0.1 +
    (opts.cache_write / 1_000_000) * inUsdPerMTok * 1.25;
  const outputUsd = (opts.tokens_output / 1_000_000) * outUsdPerMTok;
  return inputUsd + outputUsd;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function RequestEventBlock({
  ev,
  associated,
  refCb,
  tsLabel,
}: {
  ev: CCEvent;
  associated: boolean;
  refCb?: (el: HTMLDivElement | null) => void;
  tsLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      ref={refCb}
      className={`cc-event request${associated ? " associated" : ""}`}
      style={{ borderLeft: "3px solid var(--accent)", paddingLeft: 8, marginTop: 4 }}
    >
      {tsLabel && <span className="msg-ts">{tsLabel}</span>}
      <div
        onClick={() => setOpen((p) => !p)}
        style={{ cursor: "pointer", color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 11 }}
      >
        → Request to Claude (EN) {open ? "▾" : "▸"}
      </div>
      {open && (
        <div style={{ marginTop: 4, fontFamily: "var(--font-mono)", fontSize: 11 }}>
          {ev.system && (
            <details open style={{ marginBottom: 4 }}>
              <summary style={{ cursor: "pointer", color: "var(--fg-dim)" }}>
                system ({ev.system.length} chars)
              </summary>
              <pre style={{ whiteSpace: "pre-wrap", margin: "4px 0 0 0", color: "var(--fg)" }}>
                {ev.system}
              </pre>
            </details>
          )}
          {ev.user_message && (
            <details open>
              <summary style={{ cursor: "pointer", color: "var(--fg-dim)" }}>
                user ({ev.user_message.length} chars)
              </summary>
              <pre style={{ whiteSpace: "pre-wrap", margin: "4px 0 0 0", color: "var(--fg)" }}>
                {ev.user_message}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function describeTool(name: string, input: Record<string, unknown>): string {
  if (name === "Bash") {
    const cmd = String(input.command ?? "");
    return `Running: ${cmd.slice(0, 90)}`;
  }
  if (name === "Write" || name === "Edit") {
    const p = String(input.file_path ?? input.path ?? "");
    return `${name}: ${p}`;
  }
  if (name === "Read") {
    const p = String(input.file_path ?? input.path ?? "");
    return `Read: ${p}`;
  }
  if (name === "AskUserQuestion") {
    return `Ask: ${String(input.question ?? "(question)").slice(0, 80)}`;
  }
  return name;
}

export function ClaudeSimulator({ events, banner, modelLabel, highlightWindow }: Props) {
  // v15.8 (2026-05-30): Başlık STATİK main yerine o an ÇALIŞAN faza göre.
  // Son init olayının `text` öneki backend'i verir (sdk-… / cli-…); model
  // banner.model (gerçek). Faz çalışmıyorken modelLabel fallback.
  const headerLabel = (() => {
    let backend: "SDK" | "CLI" | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const t = events[i]?.text ?? "";
      if (t.startsWith("cli-")) { backend = "CLI"; break; }
      if (t.startsWith("sdk-")) { backend = "SDK"; break; }
    }
    const activeModel = banner?.model || modelLabel;
    return backend ? `${backend} · ${activeModel}` : modelLabel;
  })();

  const scrollRef = useRef<HTMLDivElement>(null);
  /** Pencere içine düşen ilk event'in DOM ref'i — scrollIntoView için. */
  const firstAssocRef = useRef<HTMLDivElement | null>(null);
  /** Focus aktif edildikten sonra 2sn auto-scroll bottom pasif. */
  const lastFocusTs = useRef<number>(0);

  useEffect(() => {
    if (highlightWindow === null) return;
    lastFocusTs.current = Date.now();
    firstAssocRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [highlightWindow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (Date.now() - lastFocusTs.current < 2000) return;
    el.scrollTop = el.scrollHeight;
  }, [events]);

  // İlk mount: events async dolduktan sonra scroll en altta olsun.
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

  return (
    <section className="panel-vsection">
      <div className="panel-label">Claude Code ({headerLabel})</div>
      <div className="cc-simulator">
        {banner && (
          <div className="cc-banner">
            <div>
              <span className="cc-banner-title">Claude Code</span>{" "}
              <span>{banner.version}</span>
              {banner.turn !== undefined && (
                <span style={{ marginLeft: 12, color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>
                  · Turn {banner.turn}
                  {banner.max_turns !== undefined ? `/${banner.max_turns}` : ""}
                </span>
              )}
            </div>
            <div>
              {banner.model} · {banner.cwd}
            </div>
            {banner.turns_counted > 0 && (
              <div style={{ marginTop: 4, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)" }}>
                in: {fmtTokens(banner.tokens_input + banner.cache_read + banner.cache_write)}
                {(banner.cache_read > 0 || banner.cache_write > 0) && (
                  <span>
                    {" "}(cache: {fmtTokens(banner.cache_read)} hit, {fmtTokens(banner.cache_write)} write)
                  </span>
                )}
                {" · "}out: {fmtTokens(banner.tokens_output)}
                {" · "}~${estimateCostUsd({
                  model: banner.model,
                  tokens_input: banner.tokens_input,
                  tokens_output: banner.tokens_output,
                  cache_read: banner.cache_read,
                  cache_write: banner.cache_write,
                }).toFixed(4)}
              </div>
            )}
          </div>
        )}
        <div className="cc-stream" ref={scrollRef}>
          {events.length === 0 && !banner && (
            <div className="cc-placeholder">Claude session not started yet</div>
          )}
          {(() => {
            let firstAssocSeen = false;
            return events.map((e) => {
              const inWindow =
                highlightWindow !== null &&
                e.ts >= highlightWindow.from &&
                e.ts < highlightWindow.to;
              const refCb =
                inWindow && !firstAssocSeen
                  ? (el: HTMLDivElement | null) => {
                      firstAssocRef.current = el;
                    }
                  : undefined;
              if (inWindow) firstAssocSeen = true;
              const assoc = inWindow ? " associated" : "";
              const tsLabel = fmtTs(e.ts);
              const tsSpan = tsLabel ? (
                <span className="msg-ts">{tsLabel}</span>
              ) : null;

              if (e.sub === "request") {
                return (
                  <RequestEventBlock
                    key={e.id}
                    ev={e}
                    associated={inWindow}
                    refCb={refCb}
                    tsLabel={tsLabel}
                  />
                );
              }
              if (e.sub === "text") {
                return (
                  <div key={e.id} ref={refCb} className={`cc-event text${assoc}`}>
                    {tsSpan}
                    {e.text}
                  </div>
                );
              }
              if (e.sub === "tool_use") {
                return (
                  <div key={e.id} ref={refCb} className={`cc-event tool_use${assoc}`}>
                    {tsSpan}
                    ⚡ {describeTool(e.tool_name ?? "?", e.tool_input ?? {})}
                  </div>
                );
              }
              if (e.sub === "tool_result") {
                return (
                  <div
                    key={e.id}
                    ref={refCb}
                    className={`cc-event tool_result ${e.is_error ? "error" : ""}${assoc}`}
                  >
                    {tsSpan}
                    {e.is_error ? "✗" : "↳"} {e.text?.slice(0, 200) ?? ""}
                  </div>
                );
              }
              if (e.sub === "retry") {
                return (
                  <div key={e.id} ref={refCb} className={`cc-event retry${assoc}`}>
                    {tsSpan}
                    ↻ Retry{e.text ? `: ${e.text}` : ""}
                  </div>
                );
              }
              if (e.sub === "error") {
                return (
                  <div key={e.id} ref={refCb} className={`cc-event error${assoc}`}>
                    {tsSpan}
                    ✗ {e.text}
                  </div>
                );
              }
              if (e.sub === "stop") {
                return (
                  <div key={e.id} ref={refCb} className={`cc-event system${assoc}`}>
                    {tsSpan}
                    — turn end —
                  </div>
                );
              }
              return null;
            });
          })()}
        </div>
      </div>
    </section>
  );
}
