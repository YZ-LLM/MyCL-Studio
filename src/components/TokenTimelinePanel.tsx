// TokenTimelinePanel — faz-bazında token harcaması zaman çizelgesi (sağ drawer).
//
// Veri: cost.jsonl (CostRecord[]) — backend cost_phase (canlı) + cost_history (açılış).
// Her faz bir satır: input/output/cache token + tur sayısı + toplam'a oranlı bar.
// Kendi-içinde inline-styled (App.css bağımlılığı yok); açılır-kapanır.

import type { ReactNode } from "react";
import type { CostRecord, PipelinePrediction } from "../types/events";

interface Props {
  open: boolean;
  costs: CostRecord[];
  /** Tam-pipeline öngörüsü (orkestratör hesaplar: per-faz medyan). null = yetersiz veri. */
  forecast: PipelinePrediction | null;
  onClose: () => void;
}

function recTotal(c: CostRecord): number {
  // Cache-read %90 indirimli ama görünür toplamda ham token sayısını gösteririz
  // (kullanıcı "ne kadar token harcandı" görmek ister; maliyet ≠ token sayısı).
  return c.input_tokens + c.output_tokens;
}

function fmt(n: number): string {
  return n.toLocaleString("tr-TR");
}

/** ms → okunabilir süre: "850ms" / "12sn" / "2dk 5sn" (YZLLM 2026-06-16). */
function fmtDur(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}sn`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}dk ${rem}sn` : `${m}dk`;
}

/** "claude-opus-4-8" → "opus-4-8" (kompakt gösterim). */
function shortModel(m: string): string {
  return m.replace(/^claude-/, "");
}

export function TokenTimelinePanel({ open, costs, forecast, onClose }: Props): ReactNode {
  if (!open) return null;

  // Kronolojik (fazların koştuğu sıra). Aynı faz birden çok iterasyonda olabilir.
  const sorted = [...costs].sort((a, b) => a.ts - b.ts);
  const maxTotal = sorted.reduce((m, c) => Math.max(m, recTotal(c)), 1);
  const grandIn = sorted.reduce((s, c) => s + c.input_tokens, 0);
  const grandOut = sorted.reduce((s, c) => s + c.output_tokens, 0);
  const grandCacheRead = sorted.reduce((s, c) => s + c.cache_read_input_tokens, 0);
  const grandTurns = sorted.reduce((s, c) => s + c.turns, 0);
  const grandDuration = sorted.reduce((s, c) => s + (c.duration_ms ?? 0), 0);
  // Ortalama/faz (bilgi): koşan fazların ham ortalaması. Tam-pipeline öngörüsü ARTIK `forecast` prop'undan
  // gelir (orkestratör per-faz medyan hesaplar) — eski naif `avg×17` tekdüze ekstrapolasyonu kaldırıldı
  // (YZLLM 2026-07-01: ağır fazlar ortalamayı şişirip %54 fazla veriyordu).
  const avgTotal = sorted.length ? Math.round((grandIn + grandOut) / sorted.length) : 0;
  const avgDuration = sorted.length ? Math.round(grandDuration / sorted.length) : 0;
  // YZLLM 2026-06-16: para ($) gösterimi KALDIRILDI — yalnız token + tur + süre.

  return (
    <aside
      aria-label="Token Zaman Çizelgesi"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        width: 360,
        maxWidth: "90vw",
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
        <span style={{ fontWeight: 600 }}>🧮 Token Zaman Çizelgesi</span>
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

      {sorted.length === 0 ? (
        <div style={{ padding: 16, color: "var(--fg-dim, #999)" }}>
          Henüz token harcaması kaydı yok. Bir pipeline koşunca fazlar burada görünür.
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
            <div>
              Toplam: <strong>{fmt(grandIn + grandOut)}</strong> token ({sorted.length} faz · {grandTurns} tur · {fmtDur(grandDuration)})
            </div>
            <div>
              ↧ giriş {fmt(grandIn)} · ↥ çıkış {fmt(grandOut)} · cache-read {fmt(grandCacheRead)}
            </div>
            <div style={{ marginTop: 5, paddingTop: 5, borderTop: "1px dashed var(--border, #333)" }}>
              Ortalama/faz: <strong>{fmt(avgTotal)}</strong> token · {fmtDur(avgDuration)}
            </div>
            <div style={{ marginTop: 3 }}>
              {forecast ? (
                <>
                  Tam pipeline öngörü: <strong>~{fmt(forecast.total_tokens)}</strong> token ·{" "}
                  {fmtDur(forecast.total_duration_ms)}{" "}
                  <span style={{ color: "var(--fg-dim, #888)" }}>
                    ({forecast.known_phases}/{forecast.pipeline_phases} faz gerçek veri
                    {forecast.reliable ? "" : " · kaba"})
                  </span>
                </>
              ) : (
                <span style={{ color: "var(--fg-dim, #888)" }}>
                  Tam pipeline öngörü: yeterli veri yok (fazlar koştukça hesaplanır)
                </span>
              )}
            </div>
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 8, overflowY: "auto", flex: 1 }}>
            {sorted.map((c, i) => {
              const total = recTotal(c);
              const pct = Math.round((total / maxTotal) * 100);
              return (
                <li
                  key={`${c.phase}-${c.iteration}-${c.ts}-${i}`}
                  style={{ padding: "6px 4px", borderBottom: "1px solid var(--border, #2a2a2a)" }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span>
                      Faz {c.phase}
                      {c.iteration > 1 ? ` (iter ${c.iteration})` : ""} · {c.turns} tur
                      {c.duration_ms ? ` · ${fmtDur(c.duration_ms)}` : ""}
                    </span>
                    <span style={{ color: "var(--fg-dim, #aaa)" }}>
                      {fmt(total)} t
                    </span>
                  </div>
                  <div
                    style={{
                      height: 8,
                      background: "var(--bg-soft, #2a2a2a)",
                      borderRadius: 4,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: "100%",
                        background: "var(--accent, #4a9eff)",
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 10, color: "var(--fg-dim, #888)", marginTop: 2 }}>
                    ↧ {fmt(c.input_tokens)} · ↥ {fmt(c.output_tokens)}
                    {c.cache_read_input_tokens > 0 ? ` · cache ${fmt(c.cache_read_input_tokens)}` : ""}
                    {c.model ? ` · ${shortModel(c.model)}` : ""}
                  </div>
                  {c.model_usage && Object.keys(c.model_usage).length > 1 && (
                    <div style={{ fontSize: 9, color: "var(--fg-dim, #777)", marginTop: 1 }}>
                      {Object.entries(c.model_usage)
                        .map(([m, u]) => `${shortModel(m)}: ${fmt(u.input_tokens + u.output_tokens)}`)
                        .join(" · ")}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </aside>
  );
}
