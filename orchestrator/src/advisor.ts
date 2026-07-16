// advisor — Claude Code "Advisor" (danışman) entegrasyonu (YZLLM 2026-07-11 "Advisor'ı ekle").
//
// Advisor = ucuz bir "yürütücü" (executor) model görevi koştururken, kritik karar anlarında GÜÇLÜ bir "danışman"
// modele tüm konuşma geçmişiyle danışır (Claude Code `--advisor <model>` bayrağı; danışman yalnız yönlendirme üretir).
// MyCL modu = GÜVENLİ KALİTE-TAKVİYE (YZLLM kararı): executor tier'i DEĞİŞMEZ; yalnız strong-ALTI CLI reasoning
// ajanlarına strong (Opus) bir danışman EKLENİR → kaliteyi düşürmeden karar-anı kalitesini artırır (ek maliyet).
//
// Katı gate'ler (hepsi sağlanmazsa danışman EKLENMEZ; agent normal koşar — best-effort takviye):
//   - features.advisor_enabled (opt-in; ek maliyet → kullanıcı kral)
//   - backend = "cli" (`--advisor` yalnız `claude` CLI bayrağı; API/SDK yolu desteklemez — AÇIK istisna)
//   - `claude` ≥ v2.1.98 (bayrağın gerektirdiği asgari sürüm — eski sürümde bilinmeyen-bayrak hatası olurdu)
//   - executor tier < strong (strong executor'a strong danışman anlamsız; aynı model → no-op)
//
// Cycle yok: advisor.ts → { model-catalog, config, codegen/cli-backend(resolveClaudePath) }; hiçbiri advisor'ı import etmez.

import { execFileSync } from "node:child_process";
import { resolveClaudePath } from "./codegen/cli-backend.js";
import {
  backendForRole,
  type AgentRole,
  type MyclConfig,
} from "./config.js";
import { findModel, modelForTier, MODEL_CATALOG, type ModelTier } from "./model-catalog.js";
import { log } from "./logger.js";

/** `--advisor` bayrağının gerektirdiği asgari `claude` sürümü. */
export const ADVISOR_MIN_VERSION = "2.1.98";

// ── SAF çekirdek (test edilebilir; yan etki yok) ──────────────────────────────────────────────

/** SAF: `claude --version` çıktısından ilk semver'i çek. örn "2.1.206 (Claude Code)" → "2.1.206"; yoksa null. */
export function parseClaudeVersion(out: string): string | null {
  const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** SAF: semver `a >= b` mı (major.minor.patch sayısal karşılaştırma). Geçersiz → false (fail-safe). */
export function semverGte(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  if (pa.length < 3 || pb.length < 3 || pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! > pb[i]!) return true;
    if (pa[i]! < pb[i]!) return false;
  }
  return true; // eşit
}

/**
 * SAF: `claude --advisor` için DANIŞMAN model id'si — CLI executor Claude olduğundan danışman da CLAUDE olmalı.
 * Konfigüre strong Claude katalogunda ise onu, DEĞİLSE (bilinmeyen id) Claude katalog varsayılan strong'unu döndür.
 * Mahkeme (2026-07-11): kullanıcı strong-tier'a GLM seçip main'i Claude/CLI bırakırsa, ham model_tiers.strong=`glm-...`
 * gerçek `claude` CLI'ına `--advisor glm-...` olarak geçip fan-out turlarını KIRIYORDU. Bu helper GLM'i asla geçirmez.
 */
export function claudeStrongModelId(configuredStrong: string | undefined): string {
  if (configuredStrong && MODEL_CATALOG.some((m) => m.id === configuredStrong)) return configuredStrong;
  return modelForTier("strong", undefined).id; // config override YOK → Claude katalog varsayılan strong (GLM riski yok)
}

export interface AdvisorDecisionInput {
  enabled: boolean; // features.advisor_enabled
  backend: "api" | "cli"; // backendForRole(config, role)
  claudeVersionOk: boolean; // claude ≥ ADVISOR_MIN_VERSION
  executorTier: ModelTier; // executor modelinin tier'i
  strongModelId: string; // modelForTier("strong")
  executorModelId: string; // danışman == executor olmasın
}

/**
 * SAF: bu spawn için danışman modeli (veya null = danışman ekleme). Tüm gate'ler burada — test edilebilir tek karar.
 * null dönmesi HATA DEĞİL: advisor best-effort takviye; koşullar yoksa agent danışmansız normal koşar.
 */
export function decideAdvisorModel(i: AdvisorDecisionInput): string | null {
  if (!i.enabled) return null; // opt-in kapalı
  if (i.backend !== "cli") return null; // --advisor yalnız CLI
  if (!i.claudeVersionOk) return null; // claude < 2.1.98
  if (i.executorTier === "strong") return null; // strong executor'a strong danışman anlamsız
  if (i.strongModelId === i.executorModelId) return null; // aynı model → no-op
  return i.strongModelId;
}

// ── Impure (sürüm probe + config'e bağlı çözüm) ───────────────────────────────────────────────

// undefined=probe edilmedi; null=belirlenemedi (fail-safe → advisor kapalı); string="X.Y.Z".
let claudeVersionCache: string | null | undefined;

/** `claude` sürümünü çöz (bir kez, execFileSync 3s). Bulunamaz/hata → null (fail-safe; danışman atlanır). */
export function claudeVersion(): string | null {
  if (claudeVersionCache !== undefined) return claudeVersionCache;
  const bin = resolveClaudePath();
  if (!bin) {
    claudeVersionCache = null;
    return null;
  }
  try {
    const out = execFileSync(bin, ["--version"], { timeout: 3000, encoding: "utf-8" });
    claudeVersionCache = parseClaudeVersion(out);
  } catch (e) {
    log.warn("advisor", "claude --version probe başarısız — danışman atlanır (fail-safe)", { error: String(e).slice(0, 120) });
    claudeVersionCache = null;
  }
  return claudeVersionCache;
}

/** Test/probe sıfırlama (yalnız birim testleri için). */
export function _resetClaudeVersionCache(): void {
  claudeVersionCache = undefined;
}

/** `claude` sürümü `--advisor`'ı destekliyor mu (≥ ADVISOR_MIN_VERSION). */
export function claudeSupportsAdvisor(): boolean {
  const v = claudeVersion();
  return v !== null && semverGte(v, ADVISOR_MIN_VERSION);
}

/**
 * Bu executor için danışman model id'si (veya null = danışman ekleme). config'ten tüm gate'leri çözer.
 * `role`: provider/backend çözümü için kullanılır (advisor'ın kendi rolü yok — inspector "main", vb. geçer).
 */
export function resolveAdvisorModel(
  config: MyclConfig,
  executorModelId: string,
  role: AgentRole,
): string | null {
  const strongModelId = claudeStrongModelId(config.selected_models.model_tiers?.strong); // daima Claude (GLM'i --advisor'a geçirme)
  const executorTier: ModelTier = findModel(executorModelId)?.tier ?? "balanced";
  return decideAdvisorModel({
    enabled: !!config.features.advisor_enabled,
    backend: backendForRole(config, role),
    claudeVersionOk: claudeSupportsAdvisor(),
    executorTier,
    strongModelId,
    executorModelId,
  });
}

/**
 * Advisor açıkken kullanıcıya GÖRÜNÜR tek-satır durum (KATI #4: sessiz atlama yok — kullanıcı açtığı danışmanın
 * gerçekten aktif olup olmadığını görsün). `null` = advisor kapalı (mesaj yok). "main" rolü üzerinden değerlendirir.
 */
export function advisorStatusMessage(config: MyclConfig): string | null {
  if (!config.features.advisor_enabled) return null;
  const strong = claudeStrongModelId(config.selected_models.model_tiers?.strong);
  if (backendForRole(config, "main") === "api")
    return `🧭 Advisor açık ama uygulanmıyor: seçili arka uç API/SDK — danışman yalnız \`claude\` (CLI) aboneliğinde çalışır. Ayarlar → Modeller'den main'i CLI yap.`;
  if (!claudeSupportsAdvisor()) {
    const v = claudeVersion();
    return `🧭 Advisor açık ama uygulanmıyor: \`claude\` sürümü ${v ?? "bilinmiyor"} < ${ADVISOR_MIN_VERSION}. \`claude update\` sonrası aktif olur.`;
  }
  return `🧭 Advisor açık: strong-altı CLI akıl-yürütme ajanları (tasarım fan-out) kritik karar anlarında **${strong}** danışmanına danışır (executor tier'i değişmez). Mahkeme/müfettiş çapraz-aile bağımsızlığı için dışarıda tutulur.`;
}
