// pre-commit-lens — Pre-hoc BAĞIMSIZ zıt-odaklı kör-nokta merceği.
//
// Felsefe (kod-analiz 2026-06-07): odak = çevreyi bilinçsizce paranteze almak. Bir ajan bir
// artefaktı (spec) / kararı üretirken kör noktalar bırakır. Bu mercek, o işi YAPMAYAN bağımsız
// bir göz olarak — komit'ten ÖNCE — "neyi paranteze aldı?"yı yakalar. BAĞIMSIZLIK şart: self-review
// aynı kör noktaları taşır → ayrı agent turu + ZIT-odak prompt.
//
// Yeniden-kullanılan altyapı: runReasoningTurn (design-fanout.ts — tek READ-ONLY ucuz tur, SDK/CLI
// uniform, backendForRole→abonelik paritesi), extractKindBlock (cli-json.ts — forced-tool gerekmez),
// `verifier` rolü (config.ts — strong-tier, hardcode model yok).
//
// FAIL-SAFE: mercek hata verirse GÖRÜNÜR kısa not + normal akış SÜRER — komit'i BLOKLAMAZ (mercek
// non-kritik). Sessiz-fallback yok (hata görünür), ama pipeline'ı durdurmaz.

import { runReasoningTurn } from "./design-fanout.js";
import { extractKindBlock } from "./cli-json.js";
import type { MyclConfig } from "./config.js";
import { log } from "./logger.js";

export type LensSeverity = "low" | "medium" | "high";

export interface Blindspot {
  severity: LensSeverity;
  /** Yazarının paranteze aldığı şey (doğrulanmamış varsayım / test-edilemez iddia / atlanan alternatif / en güçlü itiraz). */
  note: string;
  recommendation: string;
}

export interface LensResult {
  ran: boolean; // gate "run" dedi + tur denendi mi
  clean: boolean; // mercek "kör nokta yok" dedi
  blindspots: Blindspot[];
  error?: string; // turn/parse hatası → GÖRÜNÜR not; komit BLOKLANMAZ
}

export type LensArtifactKind = "spec" | "decision";

const LENS_MAX_TOKENS = 1100; // ucuz; tek tur, kısa yapısal çıktı
const SEVERITIES: readonly LensSeverity[] = ["low", "medium", "high"];

function blindspotSystemPrompt(kind: LensArtifactKind): string {
  const noun = kind === "spec" ? "engineering spec" : "decision";
  return `You are an INDEPENDENT blind-spot reviewer. You did NOT write this ${noun}, and you are NOT here to improve or rewrite it. Your single job: find what its author UNCONSCIOUSLY BRACKETED OUT while focused on the task — the blind spot.

Look ONLY for things that materially matter:
  - an unstated / unverified ASSUMPTION the ${noun} silently depends on
  - a claim that is NOT TESTABLE as written
  - the STRONGEST objection a competent skeptic would raise
  - a viable ALTERNATIVE that was skipped without reason

Rules:
  - Ground every finding in the artifact's own words. Do NOT invent problems.
  - If it is genuinely clean, set clean=true and return an EMPTY blindspots list. A false alarm is worse than silence — never manufacture issues.
  - Be terse. At most 3 findings, highest-impact first. Use severity "high" ONLY for a real, material risk.

OUTPUT — your ENTIRE final reply is exactly one JSON block and nothing else:
{"kind":"blindspot_review","clean":true|false,"blindspots":[{"severity":"low|medium|high","note":"...","recommendation":"..."}]}`;
}

/**
 * SAF: ham `blindspot_review` bloğunu tip-güvenli Blindspot[]'a indir. Savunmacı (parseConflicts deseni):
 * dizi değilse [], bozuk/boş item atlanır, severity whitelist dışı → "medium". Test edilebilir.
 */
export function parseBlindspots(raw: Record<string, unknown> | null): Blindspot[] {
  if (!raw || !Array.isArray(raw.blindspots)) return [];
  const out: Blindspot[] = [];
  for (const item of raw.blindspots as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const note = typeof o.note === "string" ? o.note.trim() : "";
    if (!note) continue; // notesuz bulgu = gürültü
    const rec = typeof o.recommendation === "string" ? o.recommendation.trim() : "";
    const sev = SEVERITIES.includes(o.severity as LensSeverity)
      ? (o.severity as LensSeverity)
      : "medium";
    out.push({ severity: sev, note, recommendation: rec });
  }
  return out;
}

/** SAF: ham bloktan `clean` bayrağı (yalnız açıkça true ise temiz). */
export function isLensClean(raw: Record<string, unknown> | null, blindspots: Blindspot[]): boolean {
  if (blindspots.length > 0) return false;
  return raw?.clean === true;
}

/**
 * Bağımsız kör-nokta merceğini koştur (gate "run" dediyse çağrılır). Tek ucuz READ-ONLY tur.
 * Hata → fail-safe LensResult (error dolu; komit bloklanmaz).
 */
export async function runBlindspotLens(
  config: MyclConfig,
  projectRoot: string,
  kind: LensArtifactKind,
  artifactText: string,
  contextNote?: string,
): Promise<LensResult> {
  const userMessage =
    `Artifact type: ${kind}\n\n${artifactText}` +
    (contextNote ? `\n\n--- extra context ---\n${contextNote}` : "");
  try {
    const text = await runReasoningTurn(
      config,
      blindspotSystemPrompt(kind),
      userMessage,
      "verifier",
      LENS_MAX_TOKENS,
      projectRoot,
    );
    const raw = extractKindBlock(text, ["blindspot_review"]);
    if (!raw) {
      log.warn("pre-commit-lens", "no blindspot_review block in lens output", {
        head: text.slice(0, 160),
      });
      return { ran: true, clean: false, blindspots: [], error: "mercek çıktısı çözümlenemedi" };
    }
    const blindspots = parseBlindspots(raw);
    return { ran: true, clean: isLensClean(raw, blindspots), blindspots };
  } catch (err) {
    log.warn("pre-commit-lens", "lens turn failed (fail-safe; commit proceeds)", err);
    return { ran: true, clean: false, blindspots: [], error: String(err).slice(0, 160) };
  }
}

/** SAF: mercekte HIGH-önem bulgu var mı (caller "sor" tetiği için). */
export function lensHasHighSeverity(lens: LensResult): boolean {
  return lens.blindspots.some((b) => b.severity === "high");
}

/**
 * SAF: mercek sonucundan GÖRÜNÜR kullanıcı mesajı (null = mesaj basma). clean→güven-veren tek satır;
 * error→görünür not (sessiz değil); bulgu→madde liste. Caller emitChatMessage'a verir / pitch'e ekler.
 */
export function formatLensFindings(lens: LensResult): string | null {
  if (!lens.ran) return null;
  if (lens.error) {
    return `🔍 Bağımsız mercek çalışmadı (${lens.error}) — normal akışla devam edildi.`;
  }
  if (lens.clean || lens.blindspots.length === 0) {
    return "🔍 Bağımsız kör-nokta merceği: belirgin kör nokta bulunmadı.";
  }
  const lines = lens.blindspots.map((b) => {
    const sevTr = b.severity === "high" ? "yüksek" : b.severity === "medium" ? "orta" : "düşük";
    return `  • [${sevTr}] ${b.note}${b.recommendation ? ` → ${b.recommendation}` : ""}`;
  });
  return (
    "🔍 Bağımsız kör-nokta merceği (bunu yazan ajan değil), olası kör noktalar:\n" +
    lines.join("\n")
  );
}
