// GuideModal — v15.11: UI kullanma kılavuzu (.mycl/user-guide.md) görüntüleyici.
//
// Composer altındaki "📖 Kılavuz" butonu açar. İçerik backend'den `user_guide`
// event'i ile gelir (açılışta varsa + MyCL projeye dokundukça güncellenir).
// Son-kullanıcı uygulamayı bu kılavuzdan öğrenir. Markdown render minimal
// (harici lib yok): başlık / liste / paragraf.

import type { ReactNode } from "react";

interface Props {
  open: boolean;
  content: string;
  onClose: () => void;
  /** 2026-06-11 (Ümit: "Model raporunda başlık yanlış"): popup başlığı — verilmezse Kullanma Kılavuzu. */
  title?: string;
}

function renderMarkdown(md: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = md.split("\n");
  lines.forEach((line, i) => {
    const t = line.replace(/\s+$/, "");
    const trimmed = t.trim();
    if (trimmed.startsWith("## ")) {
      out.push(
        <h3 key={i} style={{ margin: "14px 0 4px", fontSize: 14, fontWeight: 600 }}>
          {trimmed.slice(3)}
        </h3>,
      );
    } else if (trimmed.startsWith("# ")) {
      out.push(
        <h2 key={i} style={{ margin: "8px 0 6px", fontSize: 16, fontWeight: 700 }}>
          {trimmed.slice(2)}
        </h2>,
      );
    } else if (trimmed === "") {
      out.push(<div key={i} style={{ height: 6 }} />);
    } else if (/^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      out.push(
        <div key={i} style={{ margin: "1px 0 1px 14px", fontSize: 13, whiteSpace: "pre-wrap" }}>
          {trimmed}
        </div>,
      );
    } else {
      out.push(
        <p key={i} style={{ margin: "2px 0", fontSize: 13, whiteSpace: "pre-wrap" }}>
          {trimmed}
        </p>,
      );
    }
  });
  return out;
}

export function GuideModal({ open, content, onClose, title }: Props) {
  if (!open) return null;
  const hasContent = content.trim().length > 0;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          width: "min(720px, 90vw)",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title ?? "📖 Kullanma Kılavuzu"}</h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "4px 10px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Kapat
          </button>
        </header>
        <div style={{ padding: 18, overflowY: "auto", flex: 1 }}>
          {hasContent ? (
            renderMarkdown(content)
          ) : (
            <p style={{ color: "var(--fg-dim)", fontSize: 13 }}>
              Henüz kullanma kılavuzu üretilmedi. MyCL projeye dokundukça (yeni özellik /
              düzeltme) kılavuzu otomatik oluşturup günceller.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
