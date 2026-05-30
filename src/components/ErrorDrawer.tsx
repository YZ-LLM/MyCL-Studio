// ErrorDrawer — Alt slide-up çekmece (terminal-tarzı) hata detay paneli.
//
// v15.7 (2026-05-27): Header "HATA" badge'ine tıklayınca açılır. Mevcut chat
// mesajlarından role:"error" ve role:"system" + "❌" prefix filtrelenir.
// Her satır expand-collapse; detail varsa açılır.

import { useEffect, useState } from "react";
import type { ChatMessage } from "./ChatPanel";

interface Props {
  open: boolean;
  errors: ChatMessage[];
  onClose: () => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function ErrorDrawer({ open, errors, onClose }: Props) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // v15.7 (2026-05-27): Esc tuşu ile kapat (tooltip "Esc" yazıyordu ama
  // implement edilmemişti — kalite kontrol bulgusu).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const toggle = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="error-drawer" role="region" aria-label="Hata detayları">
      <div className="error-drawer-header">
        <span className="error-drawer-title">
          ⚠ Hata Kayıtları {errors.length > 0 && `(${errors.length})`}
        </span>
        <button
          type="button"
          className="error-drawer-close"
          onClick={onClose}
          aria-label="Hata panelini kapat"
          title="Kapat (Esc)"
        >
          ✕
        </button>
      </div>
      <div className="error-drawer-body">
        {errors.length === 0 && (
          <div className="error-drawer-empty">
            Bu oturumda hata kaydı yok.
          </div>
        )}
        {errors
          .slice()
          .reverse()
          .map((e) => {
            const isOpen = expanded.has(e.id);
            const hasDetail = !!e.detail && e.detail.trim().length > 0;
            return (
              <div
                key={e.id}
                className={`error-drawer-row ${isOpen ? "is-open" : ""}`}
              >
                <button
                  type="button"
                  className="error-drawer-row-summary"
                  onClick={() => hasDetail && toggle(e.id)}
                  disabled={!hasDetail}
                  aria-expanded={isOpen}
                  title={hasDetail ? "Detayı aç/kapat" : "Detay yok"}
                >
                  <span className="error-drawer-time">{formatTime(e.ts)}</span>
                  <span className="error-drawer-text">{e.text}</span>
                  {hasDetail && (
                    <span className="error-drawer-chevron">
                      {isOpen ? "▾" : "▸"}
                    </span>
                  )}
                </button>
                {isOpen && hasDetail && (
                  <pre className="error-drawer-detail">{e.detail}</pre>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
