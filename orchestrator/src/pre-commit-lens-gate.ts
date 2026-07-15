// pre-commit-lens-gate — Pre-hoc bağımsız kör-nokta merceğinin NE ZAMAN koşacağına dair SAF karar.
//
// designPanelDecision (design-panel-gate.ts) deseninin kardeşi: saf, izole-test edilebilir, yan-etkisiz.
// Anti-friction çekirdeği: trivial/reversible karar DAİMA atlanır; mercek yalnız gerçekten consequential
// (kod/şema üreten, geri-dönülemez, iş-kaybı riskli) noktada koşar.
//
// Felsefe (kod-analiz 2026-06-07): ajan bir işe odaklanırken çevreyi bilinçsizce paranteze alır (kör nokta).
// Mercek, o kararı/artefaktı YAPMAYAN bağımsız bir göz olarak komit'ten ÖNCE bu kör noktayı yakalar. Ama her
// kararda koşmak friction yaratır → bu gate "neye değer" sorusunu deterministik yanıtlar.

import type { AgentDecision } from "./orchestrator-agent/decision.js";
import type { PhaseId } from "./types.js";

/** config.claude_code_flags.blindspot_lens — "off": kapalı; "consequential" (default): yalnız
 *  consequential + geri-dönülemez; "always": her consequential noktada (reversibility'ye bakmaz). */
export type LensFlag = "off" | "consequential" | "always";
export type LensDecision = "run" | "skip-trivial" | "off";

export function blindspotLensDecision(params: {
  lensFlag: LensFlag;
  isConsequential: boolean;
  isReversible: boolean;
}): LensDecision {
  if (params.lensFlag === "off") return "off";
  if (params.lensFlag === "always") {
    return params.isConsequential ? "run" : "skip-trivial";
  }
  // "consequential": yalnız consequential VE geri-dönülemez kararda koş.
  if (!params.isConsequential || params.isReversible) return "skip-trivial";
  return "run";
}

/** specIsConsequential girdisi — SpecData'nın okunan alanlarının yapısal alt-kümesi (phase-4'e
 *  bağımlılık yaratmadan; SpecData bu şekle yapısal olarak uyumlu). */
export interface SpecConsequenceInput {
  title: string;
  scope: string;
  acceptance_criteria?: Array<{ statement: string; given?: string; when?: string; then?: string }>;
  risks?: Array<{ title: string; detail: string }>;
}

/**
 * Bir spec, ~80-110s'lik blindspot merceğini (eksik-AC / gizli-varsayım / en-güçlü-itiraz
 * yakalayan bağımsız düşman-göz) hak edecek kadar önemli mi? (YZLLM 2026-06-16, perf —
 * kalite-kapısı onaylı KONSERVATİF tasarım.)
 *
 * Mercek YÜKSEK-DEĞERLİ bir kalite kapısıdır → DEFAULT `true` (mercek koşar). Yalnız AÇIKÇA
 * önemsiz spec'te `false` döner: az AC (≤3) VE güvenlik/veri/yetki/şema/eşzamanlılık/yıkıcı imzası
 * YOK. O zaman mercek atlanır → basit fix'lerde ~80-110s kazanç; kaliteyi riske atan spec'lerde
 * (auth/şema/yarış/ödeme/silme…) mercek HER ZAMAN koşar. Kuşkuda → true (mercek koşar).
 */
export function specIsConsequential(spec: SpecConsequenceInput): boolean {
  const acCount = spec.acceptance_criteria?.length ?? 0;
  if (acCount >= 4) return true; // 4+ AC = kayda değer iş → mercek koşsun
  const hay = [
    spec.title,
    spec.scope,
    ...(spec.acceptance_criteria ?? []).map(
      (a) => `${a.statement} ${a.given ?? ""} ${a.when ?? ""} ${a.then ?? ""}`,
    ),
    ...(spec.risks ?? []).map((r) => `${r.title} ${r.detail}`),
  ]
    .join(" ")
    .toLowerCase();
  // Riskli imza → mercek koşar (kuşkuda DAHİL et). EN/TR varyantlar.
  const RISKY =
    /\b(auth|login|logout|session|oturum|password|parola|şifre|sifre|token|credential|kimlik|permission|izin|role|rol|admin|yetki|security|güvenlik|guvenlik|encrypt|şifrele|sifrele|hash|payment|ödeme|odeme|money|para|invoice|fatura|delete|sil|drop|truncate|migration|migrasyon|schema|şema|sema|unique|constraint|kısıt|kisit|concurren|race|eşzaman|eszaman|transaction|rollback|backup|yedek|gdpr|kvkk|pii|sensitive|hassas|webhook)\b/;
  if (RISKY.test(hay)) return true;
  return false; // ≤3 AC + riskli imza yok → önemsiz, mercek atlanabilir
}

/** run_phase için: yalnız kod/şema ÜRETEN fazlar consequential (Faz 5 UI build, 7 DB, 8 TDD).
 *  Probe/spec/review/risk/mechanical fazları zaten kendi gate'leriyle korunur → friction yaratma. */
const CONSEQUENTIAL_PHASES: ReadonlySet<number> = new Set([5, 7, 8]);

export function phaseIsConsequential(phaseId: PhaseId | undefined): boolean {
  return phaseId !== undefined && CONSEQUENTIAL_PHASES.has(phaseId);
}

/** Orkestratör kararı, pre-commit merceğine değecek kadar consequential mi? */
export function decisionIsConsequential(decision: AgentDecision): boolean {
  switch (decision.action) {
    case "develop_new_or_iter": // yeni iterasyon: state reset, yön belirler
    case "cancel_pipeline": // iş kaybı, geri-dönülemez
    case "debug_triage": // Faz 0 başlatır (LLM maliyet)
      return true;
    case "run_phase":
      return phaseIsConsequential(decision.target_phase);
    case "run_project":
      // VAR OLAN uygulamayı çalıştır (dev-server) — kod/şema ÜRETMEZ, geri-alınabilir (server kapatılır) → consequential
      // DEĞİL. Operasyonel istek → kör-nokta merceği KOŞMAZ (default zaten false; okunabilirlik + test için açık).
      return false;
    default:
      // chat / ask_clarify / approve_ui / revise_ui / resume_pipeline / verify_feature /
      // save_memory_proposal / set_optional_phases / answer_askq / fallback → trivial.
      return false;
  }
}
