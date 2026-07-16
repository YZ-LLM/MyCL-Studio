// phase-contribution — Faz-Katkı Mahkemesi (YZLLM 2026-06-22).
//
// Pipeline bitiminde her fazın koşuya KATKI YÜZDESİNİ (0-100, mutlak — o faz ne kadar değer kattı)
// bir mahkeme (LLM hükmü) belirler → Türkçe rapor chat'e basılır. Kullanıcı raporu görüp GEREKSİZ
// fazları kendisi budamaya karar verir (otomatik budama YOK — insan karar verir).
//
// TASARIM (YZLLM "her fazdan sonra mahkeme" + "yüzde"): "%" GÖRECE/bütünseldir (tüm fazları görmeden
// adil normalleştirilemez) + per-faz N pahalı LLM çağrısı yerine pipeline-end'de TEK holistik analiz —
// audit.jsonl'ın faz-başına sinyallerini (her faz koştukça birikti) okur. Tek runReasoning çağrısı.
// Flag-gated (phase_contribution_report) + fail-soft (asla throw etmez, pipeline'ı bozmaz).

import { readAuditLog } from "./audit.js";
import { eventsSince } from "./harness-verdict.js";
import { runReasoning } from "./llm-reasoning.js";
import { selectModelForTask } from "./model-catalog.js";
import { type MyclConfig } from "./config.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import type { State } from "./types.js";

const PHASE_NAMES: Record<number, string> = {
  0: "Hata Ayıklama", 1: "Niyet Toplama", 2: "Hassasiyet Denetimi", 3: "Mühendislik Brifingi",
  4: "Spec Yazımı", 5: "UI Yapımı", 6: "UI İnceleme", 7: "Veritabanı Tasarımı", 8: "TDD Uygulama",
  9: "Risk İncelemesi", 10: "Lint", 11: "Sadeleştirme", 12: "Performans", 13: "Güvenlik",
  14: "Birim Testler", 15: "Entegrasyon Testleri", 16: "E2E Testler", 17: "Pentest",
};

const CONTRIB_SYSTEM = `You are a pipeline auditor (a "mahkeme"/tribunal). You are given per-phase signals from ONE run of a 17-phase code-generation pipeline. Judge EACH phase's ABSOLUTE contribution to the run's outcome as a percentage 0-100 (NOT a share that sums to 100 — each phase rated independently: how much did THIS phase actually matter?). A phase that found/fixed/produced something real adds a lot; a phase that ran but found nothing and just passed adds little; a phase skipped/not-applicable adds ~0. For EACH phase present in the signals, output: phase number, pct (0-100 integer), and a ONE-SENTENCE rationale IN TURKISH. Emit ONLY this JSON block and nothing else:\n{"phases":[{"phase":0,"pct":0,"why":"..."}]}`;

interface PhaseContrib {
  phase: number;
  pct: number;
  why: string;
}

/** Mahkeme JSON'unu güvenli ayıkla (bozuk/eksik → null; alanları sınırla). SAF, test edilebilir. */
export function parsePhaseContribution(text: string): PhaseContrib[] | null {
  try {
    const m = text.match(/\{[\s\S]*?"phases"[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as { phases?: unknown };
    if (!Array.isArray(obj.phases)) return null;
    const out: PhaseContrib[] = [];
    for (const raw of obj.phases) {
      const p = raw as { phase?: unknown; pct?: unknown; why?: unknown };
      if (typeof p.phase !== "number" || typeof p.pct !== "number") continue;
      out.push({
        phase: p.phase,
        pct: Math.max(0, Math.min(100, Math.round(p.pct))),
        why: String(p.why ?? "").slice(0, 200),
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Türkçe rapor metni (düşük→yüksek sıralı + düşük-katkı budama-ipucu). SAF, test edilebilir. */
export function formatContributionReport(phases: PhaseContrib[]): string {
  const sorted = [...phases].sort((a, b) => a.pct - b.pct);
  const lines = sorted.map(
    (p) => `• Faz ${p.phase} (${PHASE_NAMES[p.phase] ?? "?"}): **%${p.pct}** — ${p.why}`,
  );
  const low = sorted.filter((p) => p.pct < 20);
  const lowNote = low.length
    ? `\n\n💡 Düşük katkı (gereksiz olabilir — kararı SEN ver, otomatik budama yok): ` +
      low.map((p) => `Faz ${p.phase} (${PHASE_NAMES[p.phase] ?? "?"})`).join(", ")
    : "";
  return `📊 **Faz-Katkı Raporu** — mahkeme her fazın bu koşuya katkısını değerlendirdi:\n${lines.join("\n")}${lowNote}`;
}

/**
 * IMPURE: pipeline-end'de çağrılır. Bu iterasyonun audit sinyallerini faz-başına özetler → mahkeme
 * (tek runReasoning) katkı-% + gerekçe verir → Türkçe rapor chat'e. Flag KAPALI / sinyal yok / LLM
 * fail → no-op. ASLA throw etmez (pipeline'ı bozmaz).
 */
export async function runPhaseContributionReport(state: State, config: MyclConfig): Promise<void> {
  try {
    if (!config.features.phase_contribution_report) return;
    const events = eventsSince(await readAuditLog(state.project_root), state.iteration_started_at ?? 0);
    if (events.length === 0) return;

    const byPhase = new Map<number, string[]>();
    for (const e of events) {
      const p = e.phase;
      if (typeof p !== "number") continue;
      const arr = byPhase.get(p) ?? [];
      arr.push(`${e.event}${e.detail ? `: ${String(e.detail).slice(0, 120)}` : ""}`);
      byPhase.set(p, arr);
    }
    if (byPhase.size === 0) return;

    const signalText = [...byPhase.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([p, evs]) => `Faz ${p} (${PHASE_NAMES[p] ?? "?"}): ${evs.slice(0, 8).join(" | ")}`)
      .join("\n");

    const res = await runReasoning(config, {
      systemPrompt: CONTRIB_SYSTEM,
      userMessage: `Bu pipeline koşusunun faz-başına audit sinyalleri:\n\n${signalText}\n\nHer fazın katkı yüzdesini yukarıdaki JSON bloğuyla emit et.`,
      // Katkı-yüzdesi skorlama = bilgilendirici rapor (hiçbir şeyi gate'lemez, kod yazmaz) → Opus gereksiz. balanced
      // tier yeter. (Mahkeme oybirliği safe-to-balanced.)
      modelId: selectModelForTask("classification", config.selected_models.model_tiers).modelId,
      projectRoot: state.project_root,
      maxTokens: 1500,
    });
    if (!res.ok || !res.text) return;
    const parsed = parsePhaseContribution(res.text);
    if (!parsed) {
      log.warn("phase-contribution", "mahkeme JSON ayıklanamadı (no-op)");
      return;
    }
    emitChatMessage("system", formatContributionReport(parsed));
  } catch (e) {
    log.warn("phase-contribution", "report failed (non-fatal)", e);
  }
}
