// context-trim-doctor — "bağlam sadeleştirme" (Claude Code 2.1.206 "Trim CLAUDE.md" /doctor uyarlaması, YZLLM 2026-07-11).
//
// MyCL her orkestratör turunda büyük bir bağlam enjekte eder (statik sistem-prompt ~62KB + iletişim rehberi + kullanıcı
// yönergeleri). Bu doktor o bağlamı ÖLÇER ve "koddan/canlı-bağlamdan türetilebilir ya da tekrar eden" bölümleri KESMEZ,
// ÖNERİR — kullanıcı/geliştirici karar verir (NON-DESTRUCTIVE; hiçbir dosyayı otomatik değiştirmez). save_memory_proposal
// deseninin aynısı: öner → insan onaylar → (elle) uygula.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadStaticSystemPrompt } from "./orchestrator-agent/context-builder.js";
import { loadCommunicationGuide } from "./communication-guide.js";
import { readUserDirectives } from "./user-directives.js";
import { runReasoning } from "./llm-reasoning.js";
import { orchestratorModelId, type MyclConfig } from "./config.js";
import { log } from "./logger.js";

/** Enjekte edilen tek bir bağlam parçasının ölçüsü. */
export interface ContextPieceSize {
  name: string;
  bytes: number;
  approxTokens: number;
  editable: boolean; // kullanıcı/geliştirici bu dosyayı düzeltebilir mi (statik prompt: app'e gömülü → yalnız geliştirici)
}

/** LLM'in önerdiği tek bir trim adayı (kesim ÖNERİSİ — otomatik uygulanmaz). */
export interface TrimCandidate {
  piece: string; // hangi parça (ör. "statik sistem-prompt §3 State Model")
  reason: string; // neden kesilebilir (koddan/canlı-bağlamdan türetilebilir / tekrar)
  estTokensSaved: number;
  confidence: "high" | "medium" | "low";
}

// ── SAF çekirdek (test edilebilir) ────────────────────────────────────────────────────────────

/** SAF: byte → yaklaşık token (kaba 4 karakter/token). Ölçü göstergesi; kesin faturalandırma değil. */
export function approxTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

/** SAF: ham içeriklerden enjekte-bağlam ölçüsü tablosu. */
export function measureContextPieces(pieces: {
  staticPrompt: string;
  commGuide: string;
  directives: string;
}): ContextPieceSize[] {
  const mk = (name: string, s: string, editable: boolean): ContextPieceSize => {
    const bytes = Buffer.byteLength(s, "utf-8");
    return { name, bytes, approxTokens: approxTokens(bytes), editable };
  };
  return [
    mk("Statik sistem-prompt (assets/agent-prompts/orchestrator-system.md)", pieces.staticPrompt, false),
    mk("İletişim rehberi (müfettiş.md)", pieces.commGuide, true),
    mk("Kullanıcı yönergeleri (~/.mycl/directives.md)", pieces.directives, true),
  ];
}

/** SAF: LLM metninden trim adaylarını çıkar. ```json [...] ``` bloğu ya da ilk JSON dizisi; parse edilemezse []. */
export function parseTrimCandidates(raw: string): TrimCandidate[] {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1]! : raw;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: TrimCandidate[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const piece = typeof o.piece === "string" ? o.piece.trim() : "";
    const reason = typeof o.reason === "string" ? o.reason.trim() : "";
    if (!piece || !reason) continue;
    const estRaw = Number(o.est_tokens_saved ?? o.estTokensSaved);
    const conf = o.confidence;
    out.push({
      piece,
      reason,
      estTokensSaved: Number.isFinite(estRaw) && estRaw >= 0 ? Math.round(estRaw) : 0,
      confidence: conf === "high" || conf === "medium" || conf === "low" ? conf : "low",
    });
  }
  return out;
}

/** SAF: rapor markdown'ı (dosyaya yazılır + chat özeti bundan türer). */
export function renderTrimReport(sizes: ContextPieceSize[], candidates: TrimCandidate[]): string {
  const totalTokens = sizes.reduce((a, s) => a + s.approxTokens, 0);
  const lines: string[] = [
    "# Bağlam Sadeleştirme Raporu (öneri — otomatik uygulanmaz)",
    "",
    `Her orkestratör turunda enjekte edilen bağlam ~**${totalTokens.toLocaleString("tr-TR")} token** (yaklaşık).`,
    "",
    "## Enjekte edilen parçalar",
    "",
    "| Parça | ~Token | Düzenlenebilir |",
    "| --- | ---: | :---: |",
    ...sizes.map((s) => `| ${s.name} | ${s.approxTokens.toLocaleString("tr-TR")} | ${s.editable ? "evet" : "gömülü"} |`),
    "",
    "## Kesim önerileri (sen karar ver — hiçbir şey otomatik silinmedi)",
    "",
  ];
  if (candidates.length === 0) {
    lines.push("_Güvenli bir kesim önerisi bulunamadı (bağlam zaten yalın ya da her bölüm gerekli)._");
  } else {
    const sorted = [...candidates].sort((a, b) => b.estTokensSaved - a.estTokensSaved);
    const potential = sorted.reduce((a, c) => a + c.estTokensSaved, 0);
    lines.push(`Toplam potansiyel tasarruf: ~**${potential.toLocaleString("tr-TR")} token/tur**.`, "");
    for (const c of sorted) {
      lines.push(`- **${c.piece}** (~${c.estTokensSaved.toLocaleString("tr-TR")} token, güven: ${c.confidence})`);
      lines.push(`  ${c.reason}`);
    }
  }
  lines.push("", "> Not: Kesim ÖNERİSİDİR. İlgili dosyayı elle düzenle; gömülü (statik) prompt yalnız MyCL geliştiricisi tarafından değiştirilebilir.");
  return lines.join("\n");
}

/** SAF: chat'e basılacak kısa Türkçe özet. reportPath null (rapor yazılamadı) → rapora yönlendirmez (KATI #4). */
export function renderTrimChatSummary(
  sizes: ContextPieceSize[],
  candidates: TrimCandidate[],
  reportPath: string | null,
): string {
  const totalTokens = sizes.reduce((a, s) => a + s.approxTokens, 0);
  const ref = reportPath ? ` Ayrıntı: ${reportPath}` : "";
  if (candidates.length === 0) {
    return `🩺 Bağlam sadeleştirme: enjekte edilen bağlam ~${totalTokens.toLocaleString("tr-TR")} token. Güvenli bir kesim önerisi çıkmadı (bağlam zaten yalın).${ref}`;
  }
  const potential = candidates.reduce((a, c) => a + c.estTokensSaved, 0);
  const top = [...candidates].sort((a, b) => b.estTokensSaved - a.estTokensSaved).slice(0, 3);
  const topLines = top.map((c) => `• ${c.piece} (~${c.estTokensSaved.toLocaleString("tr-TR")} tok)`).join("\n");
  const tail = reportPath ? `\nTam liste: ${reportPath}` : "";
  return (
    `🩺 Bağlam sadeleştirme: ~${totalTokens.toLocaleString("tr-TR")} token enjekte ediliyor; ~${potential.toLocaleString("tr-TR")} token/tur ` +
    `güvenli kesilebilir (öneri, otomatik silinmez):\n${topLines}${tail}`
  );
}

const TRIM_DOCTOR_SYSTEM =
  "You review a large system prompt injected into an AI agent on EVERY turn, plus optional accumulated user directives. " +
  "Your job: propose CONSERVATIVE, non-destructive trims — sections that are safely removable because the agent could " +
  "derive them from the live codebase/state, or that duplicate the live CURRENT CONTEXT snapshot, or that are redundant/stale. " +
  "Do NOT propose cutting hard rules, safety constraints, decision strategy, or anything not clearly derivable/redundant. " +
  "When unsure, DO NOT propose a cut (no false positives). Output ONLY a JSON array of " +
  '{ "piece": string, "reason": string, "est_tokens_saved": number, "confidence": "high"|"medium"|"low" }. Empty array if nothing is safe to cut.';

/** SAF: LLM review kullanıcı-mesajını kur (statik prompt + yönergeler + canlı-enjekte edilenlerin listesi → tekrar avı). */
export function buildTrimReviewPrompt(staticPrompt: string, directives: string): string {
  return [
    "AŞAĞIDAKİ 'STATİK SİSTEM-PROMPT' her turda enjekte edilir. Ayrıca her turda CANLI olarak şunlar da enjekte edilir",
    "(yani statik prompt'ta bunları TEKRARLAYAN bölümler GEREKSİZDİR): current_phase + state skalarleri, .mycl/features.md",
    "başlıkları, son 30 audit olayı, son ADR kararları, handoff/wtf, proje haritası (harita), ilgili bellek, proje gerçekleri",
    "(dil/framework), son kullanıcı mesajları. Kod tabanı da ajanın Read/Grep erişimindedir (pipeline/state/faz yapısı koddan türetilebilir).",
    "",
    "Yalnız GÜVENLE kesilebilir (türetilebilir/tekrar/bayat) bölümleri öner. Sabit kurallar, güvenlik, karar-stratejisi KESME.",
    "",
    "=== STATİK SİSTEM-PROMPT (incele) ===",
    staticPrompt,
    "",
    directives.trim() ? "=== KULLANICI YÖNERGELERİ (~/.mycl/directives.md — bayat/tekrar olanı öner) ===" : "",
    directives.trim(),
  ]
    .filter((s) => s !== "")
    .join("\n");
}

export const CONTEXT_TRIM_REPORT_FILE = ".mycl/context-trim-report.md";

/**
 * IMPURE: doktoru koştur — ölç + LLM incele + rapor yaz (projeRoot/.mycl/) + özet döndür. NON-DESTRUCTIVE.
 * Fail-soft: LLM üretemezse yine ölçüm raporu yazılır (adaylar boş). Rapor yolu döner (caller chat'e özet basar).
 */
export async function runContextTrimDoctor(
  config: MyclConfig,
  projectRoot: string,
): Promise<{ sizes: ContextPieceSize[]; candidates: TrimCandidate[]; reportPath: string; summary: string }> {
  const [staticPrompt, commGuide, directives] = await Promise.all([
    loadStaticSystemPrompt().catch(() => ""),
    loadCommunicationGuide().catch(() => ""),
    readUserDirectives().catch(() => ""),
  ]);
  const sizes = measureContextPieces({ staticPrompt, commGuide, directives });

  let candidates: TrimCandidate[] = [];
  if (staticPrompt.trim()) {
    try {
      const res = await runReasoning(config, {
        systemPrompt: TRIM_DOCTOR_SYSTEM,
        userMessage: buildTrimReviewPrompt(staticPrompt, directives),
        modelId: orchestratorModelId(config.selected_models),
        projectRoot,
        effort: "high",
      });
      if (res.ok && res.text.trim()) candidates = parseTrimCandidates(res.text);
      else log.warn("context-trim", "LLM inceleme üretmedi — yalnız ölçüm raporu", { error: res.error });
    } catch (e) {
      log.warn("context-trim", "LLM inceleme hata — yalnız ölçüm raporu (fail-soft)", { error: String(e).slice(0, 160) });
    }
  }

  const reportPath = join(projectRoot, CONTEXT_TRIM_REPORT_FILE);
  const report = renderTrimReport(sizes, candidates);
  // .mycl/ dizinini garanti et (diğer .mycl-yazan modüllerle tutarlı — örtük logger-rotasyonu ön-koşuluna dayanma).
  let wrote = false;
  try {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, report, "utf-8");
    wrote = true;
  } catch (e) {
    log.warn("context-trim", "rapor yazılamadı — chat özeti rapora yönlendirmez (KATI #4)", { error: String(e) });
  }
  // Rapor yazılamadıysa özet "tam liste: <dosya>" DEMEZ (sessiz yanlış-yönlendirme yok); yalnız chat'te öneri gösterilir.
  const summary = renderTrimChatSummary(sizes, candidates, wrote ? CONTEXT_TRIM_REPORT_FILE : null);
  return { sizes, candidates, reportPath, summary };
}
