// quality-audit — "Denetim Ajanı" (Ümit 2026-06-11): orkestratör ajanın son koşudaki davranışını KALİTE KONTROL
// sorularına göre denetler. Kullanıcının (düzenlenebilir) soruları + son audit kanıtı → main ajan (İngilizce)
// değerlendirir → rapor. Bizim DİL HATTI: denetim(TR) → translator(EN) → main(EN) → translator(TR) → denetim(TR).
//
// Rapor İKİYE ayrılır: (a) MyCL Studio İÇİNDE çözülebilir (orkestratör runtime'da ele alır), (b) KAYNAK KODU
// değişikliği gerektirir (kullanıcı geliştiriciye iletir). Denetim ajanı main'e DOĞRUDAN gitmez — translator köprü.

import { readAuditLogTail } from "./audit.js";
import { runReasoning } from "./llm-reasoning.js";
import { translate } from "./translator.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import type { MyclConfig } from "./config.js";
import type { State } from "./types.js";

/** Varsayılan kalite kontrol soruları (Ümit). Kullanıcı popup'ta düzenleyebilir; düzenlenmiş hali buraya gelir. */
export const DEFAULT_QUALITY_QUESTIONS = `MyCL Kalite Kontrol Testi — orkestratör ajanın son koşudaki davranışını denetle:

1. Sorunu tespit etti mi?
2. Sorunu tespit etmek için gereksiz işler yaptı mı?
3. Çözüm için gereksiz işler yaptı mı?
4. En iyi çözümü buldu mu?
5. En iyi çözümü (Oto-cevap açıksa) uyguladı mı?
6. Karşısına çıkan sorunları doğru algıladı mı?
7. Her aşamada ne yaptığının ve neyi, neden yaptığının farkında mı?
8. Bütün bunları MyCL kurallarının dışına çıkmadan mı yaptı?`;

const AUDIT_SYSTEM = `You are MyCL Studio's INTERNAL AUDIT AGENT ("Denetim Ajanı"). Your job is to AUDIT the orchestrator
agent's behavior in the most recent run, using the audit-log evidence provided. Be a hostile, skeptical reviewer —
your reputation depends on catching mistakes, loops, wasted work, misperceptions, and rule violations that others
missed. Do NOT flatter the system. Ground every judgment in concrete evidence from the log (cite events/timestamps).

For EACH quality-control question, answer concretely: pass/fail/partial + the evidence.

Then produce a structured verdict. Output EXACTLY ONE JSON object as the LAST thing, no other JSON:
{"summary":"<2-4 sentence overall verdict>",
 "findings":[{"q":<question number>,"verdict":"pass|partial|fail","evidence":"<concrete, cite log>"}],
 "fixable_in_mycl":["<issue that the orchestrator could address at runtime within MyCL Studio, e.g. config/setting/re-run>"],
 "needs_source_change":["<issue that requires changing MyCL's own source code — describe it precisely enough that a developer can act on it>"]}

Rules: be specific and evidence-based, never vague. If the run was clean, say so honestly (don't invent issues).
Classify each real issue as fixable_in_mycl OR needs_source_change — most behavioral/logic flaws are needs_source_change.`;

export interface AuditReport {
  summary: string;
  findings: { q: number; verdict: string; evidence: string }[];
  fixable_in_mycl: string[];
  needs_source_change: string[];
}

/** Audit JSON bloğunu güvenle ayıkla (model ```json sarabilir). Bozuksa null. SAF. */
export function parseAuditReport(text: string): AuditReport | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Partial<AuditReport>;
    return {
      summary: typeof o.summary === "string" ? o.summary : "",
      findings: Array.isArray(o.findings) ? (o.findings as AuditReport["findings"]) : [],
      fixable_in_mycl: Array.isArray(o.fixable_in_mycl) ? o.fixable_in_mycl.filter((x) => typeof x === "string") : [],
      needs_source_change: Array.isArray(o.needs_source_change)
        ? o.needs_source_change.filter((x) => typeof x === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/** Son koşu kanıtı: audit tail'i kompakt satırlara indir (denetim ajanına verilir). */
async function gatherEvidence(state: State): Promise<string> {
  let audit: Awaited<ReturnType<typeof readAuditLogTail>>;
  try {
    audit = await readAuditLogTail(state.project_root, 200);
  } catch {
    return "(audit log okunamadı)";
  }
  const since = state.iteration_started_at ?? 0;
  const rows = audit
    .filter((e) => (e.ts ?? 0) >= since || true) // son iterasyon + biraz öncesi (bağlam)
    .slice(-160)
    .map((e) => `[p${e.phase ?? "?"}] ${e.event}: ${String(e.detail ?? "").slice(0, 160)}`);
  return rows.join("\n").slice(0, 12000);
}

/**
 * Denetim ajanını çalıştırır: sorular(TR) → translator(EN) → main değerlendirir(EN) → translator(TR) → rapor.
 * Sonucu döndürür (orkestratör triage eder). Hata-güvenli: başarısızsa null + görünür mesaj.
 */
export async function runQualityAudit(
  config: MyclConfig,
  state: State,
  questionsTr: string,
): Promise<{ reportTr: string; report: AuditReport | null } | null> {
  emitChatMessage("system", "🕵️ Denetim ajanı çalışıyor — orkestratörün son koşusunu kalite sorularına göre inceliyor…");
  // 1. Denetim ajanı TR konuşur → translator → main (EN). (Dil hattı: denetim asla doğrudan main'e gitmez.)
  const questionsEn = await translate(config, questionsTr, "tr-to-en").then((r) => r.text).catch(() => questionsTr);
  const evidence = await gatherEvidence(state);
  // 2. main (EN) denetimi yapar.
  let en: string;
  try {
    const r = await runReasoning(config, {
      systemPrompt: AUDIT_SYSTEM,
      userMessage: `QUALITY-CONTROL QUESTIONS:\n${questionsEn}\n\nAUDIT-LOG EVIDENCE (most recent run):\n${evidence}`,
      modelId: config.selected_models.orchestrator ?? config.selected_models.main,
      projectRoot: state.project_root,
      maxTokens: 4000,
    });
    en = r.text;
  } catch (e) {
    log.warn("quality-audit", "audit reasoning failed", e);
    emitChatMessage("system", "⚠️ Denetim ajanı çalışamadı (API/CLI hatası). Tekrar deneyin.");
    return null;
  }
  // 3. Rapor (EN) → translator → TR (denetim ajanına/kullanıcıya).
  const report = parseAuditReport(en);
  const reportTr = await translate(config, en, "en-to-tr").then((r) => r.text).catch(() => en);
  return { reportTr, report };
}
