// AgentTeamPanel — "Ajan Takımı" popup'ı (sağ drawer). YZLLM 2026-06-27.
//
// O iterasyonda koşan TÜM alt-ajan takımlarını gösterir: hangi takım/grup, hangi fazda, ne zaman başladı,
// ne kadar sürdü, kaç token harcadı, durumu (çalışıyor/bitti/hata). Veri: App reducer'ın agentRuns'ı
// (agent_event started/token_usage/completed'dan türer; freshRun'da sıfırlanır). Ana ajan onların yöneticisi;
// takım üyeleri İngilizce çalışır (çevirmen yalnız kullanıcı↔orkestratör arası). Self-contained inline-styled.

import { useEffect, useReducer } from "react";
import type { ReactNode } from "react";
import type { AgentRun } from "../App";

interface Props {
  open: boolean;
  runs: AgentRun[];
  onClose: () => void;
}

function fmt(n: number): string {
  return n.toLocaleString("tr-TR");
}

/** ms → okunabilir süre: "850ms" / "12sn" / "2dk 5sn". */
function fmtDur(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}sn`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}dk ${rem}sn` : `${m}dk`;
}

/** epoch ms → "HH:MM:SS" (yerel). Başlangıç saatini gösterir. */
function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function runTokens(r: AgentRun): number {
  return r.usage.input_tokens + r.usage.output_tokens;
}

const STATUS_ICON: Record<AgentRun["status"], string> = {
  running: "⏳",
  done: "✅",
  error: "⚠️",
};

export function AgentTeamPanel({ open, runs, onClose }: Props): ReactNode {
  // Canlı süre tik (mahkeme #3): ajan koşarken "süre" alanı render anında donuyordu. Açık VE en az bir ajan
  // "running" iken saniyede bir zorla yeniden-çiz → fmtDur canlı ilerler. Koşan ajan yoksa interval kurulmaz.
  const [, forceTick] = useReducer((x: number) => x + 1, 0);
  const hasRunning = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!open || !hasRunning) return;
    const id = setInterval(forceTick, 1000);
    return () => clearInterval(id);
  }, [open, hasRunning]);

  if (!open) return null;

  // Takıma (group) göre grupla; grup içinde başlangıç sırasına göre.
  const groups = new Map<string, AgentRun[]>();
  for (const r of runs) {
    const arr = groups.get(r.group) ?? [];
    arr.push(r);
    groups.set(r.group, arr);
  }
  const now = Date.now();
  const dur = (r: AgentRun): number => (r.completed_ts ?? now) - r.started_ts;
  const totalTokens = runs.reduce((s, r) => s + runTokens(r), 0);
  const runningCount = runs.filter((r) => r.status === "running").length;

  return (
    <aside
      aria-label="Ajan Takımı"
      data-testid="agent-team-panel"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        width: 440,
        maxWidth: "95vw",
        height: "100vh",
        background: "var(--bg, #1e1e1e)",
        borderLeft: "1px solid var(--border, #333)",
        boxShadow: "-4px 0 16px rgba(0,0,0,0.3)",
        display: "flex",
        flexDirection: "column",
        zIndex: 50,
        fontFamily: "var(--font-mono, monospace)",
        fontSize: 12,
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
        }}
      >
        <span style={{ fontWeight: 600 }}>👥 Ajan Takımı</span>
        <button
          type="button"
          onClick={onClose}
          title="Kapat"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--fg-dim, #999)",
            fontSize: 18,
            cursor: "pointer",
          }}
        >
          ×
        </button>
      </header>

      {runs.length === 0 ? (
        <div style={{ padding: 16, color: "var(--fg-dim, #999)", lineHeight: 1.6 }}>
          Bu iterasyonda henüz çoklu-ajan takımı çalışmadı. Tasarım paneli (Faz 5), kök-neden mercekleri
          (Faz 0) ya da modül codegen (Faz 8) çalışınca ajanlar — ne yaptıkları, hangi fazda, süre ve
          token — burada görünür. (Ajan takımları İngilizce çalışır; ana ajan onların yöneticisidir.)
        </div>
      ) : (
        <>
          <div
            style={{
              padding: "8px 12px",
              borderBottom: "1px solid var(--border, #333)",
              color: "var(--fg-dim, #aaa)",
              lineHeight: 1.6,
            }}
          >
            <strong>{runs.length}</strong> ajan ({groups.size} takım
            {runningCount > 0 ? ` · ${runningCount} çalışıyor` : ""}) · toplam{" "}
            <strong>{fmt(totalTokens)}</strong> token
          </div>
          <div style={{ overflowY: "auto", flex: 1, padding: 8 }}>
            {[...groups.entries()].map(([group, list]) => (
              <section key={group} style={{ marginBottom: 12 }}>
                <div
                  style={{
                    fontWeight: 600,
                    color: "var(--accent, #4a9eff)",
                    padding: "4px 4px 6px",
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  {group} ({list.length})
                </div>
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {[...list]
                    .sort((a, b) => a.started_ts - b.started_ts)
                    .map((r, i) => (
                      <li
                        key={`${r.label}-${r.started_ts}-${i}`}
                        style={{
                          padding: "6px 4px",
                          borderBottom: "1px solid var(--border, #2a2a2a)",
                          opacity: r.status === "running" ? 1 : 0.92,
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                          <span style={{ fontWeight: 500, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {STATUS_ICON[r.status]} {r.label}
                          </span>
                          <span style={{ color: "var(--fg-dim, #aaa)", flexShrink: 0 }}>Faz {r.phase}</span>
                        </div>
                        <div style={{ fontSize: 10, color: "var(--fg-dim, #888)", marginTop: 2 }}>
                          başla {fmtClock(r.started_ts)} · süre {fmtDur(dur(r))}
                          {r.status === "running" ? " (sürüyor…)" : ""} ·{" "}
                          {fmt(runTokens(r))} token
                        </div>
                        {runTokens(r) > 0 && (
                          <div style={{ fontSize: 9, color: "var(--fg-dim, #777)", marginTop: 1 }}>
                            ↧ {fmt(r.usage.input_tokens)} · ↥ {fmt(r.usage.output_tokens)}
                            {r.usage.cache_read_input_tokens > 0
                              ? ` · cache ${fmt(r.usage.cache_read_input_tokens)}`
                              : ""}
                          </div>
                        )}
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
