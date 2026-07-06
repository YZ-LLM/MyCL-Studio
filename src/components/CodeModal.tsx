// CodeModal — YZLLM 2026-07-05 (Feature B): MyCL kodla ilgili bir cevap verdiğinde chat'teki "Kodu göster"
// butonu bu salt-okunur popup'ı açar; kodun ilgili kısmını (dosya:satır) mono blokta gösterir.
//
// GuideModal'i model alır (aynı overlay + dış-tık kapatır + iç panel stopPropagation + "Kapat" header) AMA
// gövde markdown DEĞİL — düzenlenemeyen mono <pre>. Yalnız CSS değişkenleri kullanılır (dark/light + responsive).

interface CodeRef {
  file: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

interface Props {
  open: boolean;
  codeRef: CodeRef | null;
  onClose: () => void;
}

export function CodeModal({ open, codeRef, onClose }: Props) {
  // Kapanınca (veya code_ref yokken) içerik gösterme.
  if (!open || !codeRef) return null;
  const title =
    codeRef.file +
    ":" +
    codeRef.startLine +
    (codeRef.endLine > codeRef.startLine ? `-${codeRef.endLine}` : "");
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
          width: "min(820px, 92vw)",
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
          <h2
            style={{
              margin: 0,
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
              color: "var(--fg)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "4px 10px",
              fontSize: 12,
              color: "var(--fg-dim)",
              cursor: "pointer",
            }}
          >
            Kapat
          </button>
        </header>
        <div style={{ overflow: "auto", flex: 1, background: "var(--bg-panel)" }}>
          <pre
            style={{
              fontFamily: "var(--font-mono)",
              whiteSpace: "pre",
              overflow: "auto",
              fontSize: 12,
              margin: 0,
              padding: 12,
              color: "var(--fg)",
            }}
          >
            {codeRef.snippet}
          </pre>
        </div>
      </div>
    </div>
  );
}
