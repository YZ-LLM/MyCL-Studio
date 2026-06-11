// QualityAuditModal — "MyCL Kalite Kontrol Testi" (Ümit 2026-06-11). Composer'daki buton açar. Sorular düzenlenebilir
// bir metin alanında; kullanıcı isterse düzenler. "Kalite Kontrol Başlat" → denetim ajanı (orkestratörü denetler).

import { useState, useEffect } from "react";

/** Varsayılan kalite kontrol soruları — backend DEFAULT_QUALITY_QUESTIONS ile aynı (kullanıcı düzenleyebilir). */
export const DEFAULT_QUALITY_QUESTIONS = `MyCL Kalite Kontrol Testi — orkestratör ajanın son koşudaki davranışını denetle:

1. Sorunu tespit etti mi?
2. Sorunu tespit etmek için gereksiz işler yaptı mı?
3. Çözüm için gereksiz işler yaptı mı?
4. En iyi çözümü buldu mu?
5. En iyi çözümü (Oto-cevap açıksa) uyguladı mı?
6. Karşısına çıkan sorunları doğru algıladı mı?
7. Her aşamada ne yaptığının ve neyi, neden yaptığının farkında mı?
8. Bütün bunları MyCL kurallarının dışına çıkmadan mı yaptı?`;

interface Props {
  open: boolean;
  onClose: () => void;
  onStart: (questions: string) => void;
}

export function QualityAuditModal({ open, onClose, onStart }: Props) {
  const [text, setText] = useState(DEFAULT_QUALITY_QUESTIONS);
  // Açılışta varsayılana sıfırlamayalım — kullanıcının düzenlemesi oturum boyunca kalsın; ama ilk açılışta dolu gelsin.
  useEffect(() => {
    if (open && !text.trim()) setText(DEFAULT_QUALITY_QUESTIONS);
  }, [open, text]);
  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--bg, #1e1e1e)", border: "1px solid var(--fg-dim)", borderRadius: 8,
          width: "min(720px, 92vw)", maxHeight: "85vh", display: "flex", flexDirection: "column", padding: 16, gap: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong style={{ fontSize: 15 }}>🕵️ MyCL Kalite Kontrol Testi</strong>
          <button type="button" onClick={onClose} style={{ fontSize: 13 }}>✕</button>
        </div>
        <p style={{ fontSize: 12, color: "var(--fg-dim)", margin: 0 }}>
          Denetim ajanı, orkestratör ajanın son koşusunu aşağıdaki sorulara göre denetler. Soruları düzenleyebilirsin.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1, minHeight: 280, fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.5,
            padding: 10, resize: "vertical", borderRadius: 4,
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} style={{ fontSize: 13 }}>Vazgeç</button>
          <button
            type="button"
            onClick={() => {
              onStart(text.trim() || DEFAULT_QUALITY_QUESTIONS);
              onClose();
            }}
            style={{ fontSize: 13, fontWeight: 600 }}
          >
            Kalite Kontrol Başlat
          </button>
        </div>
      </div>
    </div>
  );
}
