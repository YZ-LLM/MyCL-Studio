// SummaryPanel — 🧾 sağ Özet paneli (YZLLM 2026-07-19: "özeti chat ekranında değil sağ panelde
// göstersin. ayrı bi süreç olarak çalıştır. çalışan iterasyonu etkilemesin.")
//
// Sağ drawer (TokenTimelinePanel deseni: inline-styled, ESC + dış-tık kapatma). Özet backend'de
// AYRI bir süreçte (ayrı claude CLI turu) üretilir ve `chat_summary` event'iyle buraya düşer —
// sohbete/history'ye hiç yazılmaz, pipeline'ı bloklamaz. Panel açılınca sonuç yoksa otomatik
// üretim tetiklenir; "Yenile" ile elle yenilenir.

import { useEffect, useRef } from "react";
import type { ChatSummaryState } from "../types/events";
import { renderMarkdown } from "./GuideModal";
import { useEscapeToClose, useOutsideClickClose } from "../hooks/useDismissable";

interface Props {
  open: boolean;
  summary: ChatSummaryState | null;
  onClose: () => void;
  /** Yeni özet üretimini tetikler (buton yolu). */
  onGenerate: () => void;
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function SummaryPanel({ open, summary, onClose, onGenerate }: Props) {
  const panelRef = useRef<HTMLElement | null>(null);
  useEscapeToClose(open, onClose);
  useOutsideClickClose(open, onClose, panelRef);
  // Panel açıldığında henüz hiç özet yoksa BİR KEZ otomatik üret. autoGenDone: onGenerate her render'da
  // yeni referans → guard olmadan "running" gelene dek çift tetiklenebilirdi. Kapanışta sıfırlanır.
  const autoGenDone = useRef(false);
  useEffect(() => {
    if (!open) {
      autoGenDone.current = false;
      return;
    }
    if (summary === null && !autoGenDone.current) {
      autoGenDone.current = true;
      onGenerate();
    }
  }, [open, summary, onGenerate]);
  if (!open) return null;

  const running = summary?.state === "running";
  return (
    <aside
      ref={panelRef}
      aria-label="Sohbet Özeti"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        width: 420,
        maxWidth: "92vw",
        height: "100vh",
        background: "var(--bg, #1e1e1e)",
        borderLeft: "1px solid var(--border, #333)",
        boxShadow: "-4px 0 16px rgba(0,0,0,0.3)",
        display: "flex",
        flexDirection: "column",
        zIndex: 50,
        color: "var(--fg, #ddd)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px",
          borderBottom: "1px solid var(--border, #333)",
          fontFamily: "var(--font-mono, monospace)",
          fontSize: 13,
        }}
      >
        <span>🧾 Sohbet Özeti</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            type="button"
            onClick={onGenerate}
            disabled={running}
            title="Özeti yeniden üret (güncel sohbete göre)"
            style={{
              background: "none",
              border: "1px solid var(--border, #333)",
              borderRadius: 6,
              color: running ? "var(--fg-dim, #888)" : "var(--fg, #ddd)",
              cursor: running ? "default" : "pointer",
              font: "inherit",
              fontSize: 11,
              padding: "2px 8px",
            }}
          >
            🔄 Yenile
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Kapat (Esc)"
            style={{
              background: "none",
              border: "none",
              color: "var(--fg-dim, #999)",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      </header>
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 14px", fontSize: 13, lineHeight: 1.5 }}>
        {summary === null || running ? (
          <div style={{ color: "var(--fg-dim, #999)", fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}>
            {running && summary?.state === "running"
              ? `Özet hazırlanıyor (${summary.count} mesaj)… bu ayrı bir süreçtir, çalışan işi etkilemez.`
              : "Özet hazırlanıyor…"}
          </div>
        ) : summary.state === "error" ? (
          <div style={{ color: "#d0666f", fontSize: 12 }}>{summary.message}</div>
        ) : (
          <>
            <div
              style={{
                color: "var(--fg-dim, #888)",
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 10,
                marginBottom: 8,
              }}
            >
              {fmtClock(summary.ts)} · orkestratör tarafından üretildi
            </div>
            {renderMarkdown(summary.text)}
          </>
        )}
      </div>
    </aside>
  );
}
