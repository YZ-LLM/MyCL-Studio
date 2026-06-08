// AgentThinkingModal — v15.6: Orkestrator ajan düşünceleri modal.
//
// Composer altındaki "🧠 Orkestrator" butonu açar. Agent'ın son N tool call
// + final decision'larını reverse-chronological listeler. Agent silent çalıştığı
// için kullanıcı şeffaflık ister — bu modal hangi tool'a baktığını, ne karar
// verdiğini gösterir.

import type { AgentThinkingEvent } from "../App";

interface Props {
  open: boolean;
  events: AgentThinkingEvent[];
  onClose: () => void;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });
}

function EventRow({ ev }: { ev: AgentThinkingEvent }) {
  const subColor = {
    started: "var(--fg-dim)",
    completed: "var(--fg-dim)",
    tool_use: "var(--fg-dim)",
    decision: "var(--accent, #5a9be5)",
    error: "var(--error, #d85d5d)",
  }[ev.sub];

  const subLabel = {
    started: "▶ Başladı",
    completed: "⏹ Bitti",
    tool_use: "🔧 Tool",
    decision: "✅ Karar",
    error: "⚠ Hata",
  }[ev.sub];

  return (
    <div
      style={{
        borderLeft: `3px solid ${subColor}`,
        paddingLeft: 12,
        marginBottom: 14,
      }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 4 }}>
        {ev.agent_label && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--accent, #5b9dff)",
              background: "rgba(91,157,255,.12)",
              borderRadius: 6,
              padding: "1px 7px",
            }}
          >
            🤖 {ev.agent_label}
          </span>
        )}
        <span style={{ color: subColor, fontWeight: 600, fontSize: 12 }}>
          {subLabel}
        </span>
        {ev.turn !== undefined && (
          <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>
            turn {ev.turn}
          </span>
        )}
        <span style={{ fontSize: 10, color: "var(--fg-dim)", marginLeft: "auto" }}>
          {formatTs(ev.ts)}
        </span>
      </div>
      {ev.sub === "tool_use" && (
        <div style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>
          <strong>{ev.tool_name}</strong>
          {ev.tool_input && (
            <pre
              style={{
                marginTop: 4,
                padding: 8,
                background: "rgba(255,255,255,0.04)",
                borderRadius: 4,
                fontSize: 11,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 120,
                overflow: "auto",
              }}
            >
              {JSON.stringify(ev.tool_input, null, 2)}
            </pre>
          )}
        </div>
      )}
      {ev.sub === "decision" && ev.decision && (
        <div style={{ fontSize: 12 }}>
          <div>
            <strong>action:</strong>{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>
              {String(ev.decision.action)}
            </code>
            {ev.decision.target_phase !== undefined && (
              <span> → Faz {String(ev.decision.target_phase)}</span>
            )}
          </div>
          <div style={{ marginTop: 4 }}>
            <strong>reason:</strong>{" "}
            <span style={{ color: "var(--fg-bright)" }}>
              {String(ev.decision.reason)}
            </span>
          </div>
          {Boolean(ev.decision.topic_slug) && (
            <div style={{ marginTop: 4, fontSize: 11 }}>
              <strong>topic:</strong>{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>
                {String(ev.decision.topic_slug)}
              </code>
            </div>
          )}
          {Boolean(ev.decision.message_to_user) && (
            <div
              style={{
                marginTop: 4,
                padding: 6,
                background: "rgba(80, 140, 220, 0.08)",
                borderRadius: 4,
                fontSize: 11,
              }}
            >
              💬 {String(ev.decision.message_to_user)}
            </div>
          )}
        </div>
      )}
      {ev.sub === "error" && (
        <div style={{ fontSize: 12, color: "var(--error)" }}>{ev.error}</div>
      )}
    </div>
  );
}

export function AgentThinkingModal({ open, events, onClose }: Props) {
  if (!open) return null;

  // Reverse-chronological (en yeni üstte)
  const reversed = [...events].reverse();

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
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
            🧠 Orkestrator Ajan Düşünceleri
            <span
              style={{
                marginLeft: 10,
                fontSize: 11,
                color: "var(--fg-dim)",
                fontWeight: 400,
              }}
            >
              ({events.length} event, en yeni üstte)
            </span>
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
              cursor: "pointer",
            }}
          >
            Kapat
          </button>
        </header>
        <div style={{ padding: 18, overflowY: "auto", flex: 1 }}>
          {reversed.length === 0 ? (
            <p style={{ color: "var(--fg-dim)", fontSize: 12 }}>
              Henüz orkestrator ajan kararı yok. Settings → API Keys → "Orkestrator
              Ajan API Key" alanına bir anahtar gir, sonra mesaj yaz — agent karar
              verdikçe burada listelenir.
            </p>
          ) : (
            reversed.map((ev) => <EventRow key={ev.ts} ev={ev} />)
          )}
        </div>
      </div>
    </div>
  );
}
