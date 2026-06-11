// verify-up — işi bir ÜST basamağa KONTROL ettir (Ümit 2026-06-11): "kullandığımız modelin yetersiz olduğunu net
// anlamalıyız: işi yaptıktan sonra bir üst eforuna (efor tepedeyse bir üst modele) kontrol ettirelim. Yetersiz
// değilse o kalır; yetersizse kontrol edene yükseltiriz."
//
// Mekanik: faz tamamlanınca nextRung (önce efor+1, efor tepedeyse model+1) bir KONTROLCÜ olarak işi denetler.
// adequate → basamak kalır (rapora başarı). inadequate → domain basamağı kontrolcüye yükselir + faz o seviyede
// yeniden koşar. Tepe basamakta kontrolcü yok → atlanır. Kontrolcü hatası → fail-open (akışı bloklamaz).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readAuditLogTail } from "./audit.js";
import { runReasoning } from "./llm-reasoning.js";
import { nextRung, resolveRung, rungForDomain, rungLabel, type Rung } from "./escalation.js";
import { log } from "./logger.js";
import type { MyclConfig } from "./config.js";
import type { PhaseId, State } from "./types.js";

export interface VerifyUpResult {
  verdict: "adequate" | "inadequate" | "skipped";
  /** Kontrolcünün basamağı (yükseltme hedefi). */
  checker?: Rung;
  reasons: string[];
}

/** Kontrolcü çıktısından {"adequate":bool,"reasons":[...]} ayıkla. Bozuksa null (caller fail-open). SAF. */
export function parseVerifyVerdict(text: string): { adequate: boolean; reasons: string[] } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { adequate?: unknown; reasons?: unknown };
    if (typeof o.adequate !== "boolean") return null;
    return {
      adequate: o.adequate,
      reasons: Array.isArray(o.reasons)
        ? o.reasons.filter((x): x is string => typeof x === "string").slice(0, 5)
        : [],
    };
  } catch {
    return null;
  }
}

const VERIFY_SYSTEM = [
  "You are a STRICTER, MORE CAPABLE reviewer auditing work just produced by a lower-capability agent in MyCL's",
  "pipeline. Decide ONE thing: is the produced work ADEQUATE for its phase goal — correct, complete, honest",
  "(no fabricated success, no weakened/false-green checks)? Do NOT nitpick style or minor polish; 'adequate'",
  "means a competent engineer would accept it and move on. 'Inadequate' means: wrong, incomplete vs the phase",
  "goal, fabricated/false-green, or missing required parts.",
  "",
  'Output EXACTLY ONE JSON object as the LAST thing: {"adequate":true|false,"reasons":["<short concrete reason>"]}.',
  "Base reasons on the EVIDENCE only; cite concretely. If evidence is too thin to judge, lean adequate (the",
  "pipeline's later gates will still run).",
].join("\n");

/**
 * İşi bir üst basamağa kontrol ettir. Dönen verdict'e göre caller: adequate→kal, inadequate→checker'a yükselt+yeniden.
 */
export async function verifyWorkAtHigherRung(
  config: MyclConfig,
  state: State,
  phaseId: PhaseId,
  domain: string,
  phaseLabel: string,
): Promise<VerifyUpResult> {
  const cur = rungForDomain(state, domain);
  const up = nextRung(cur);
  if (!up) return { verdict: "skipped", reasons: ["en üst basamak — daha üst kontrolcü yok"] };

  // Kanıt: bu fazın bu-iterasyon audit olayları (+ Faz 4'te spec başı).
  let evidence = "";
  try {
    const audit = await readAuditLogTail(state.project_root, 250);
    const since = state.iteration_started_at ?? 0;
    evidence = audit
      .filter((e) => (e.ts ?? 0) >= since && e.phase === phaseId)
      .slice(-60)
      .map((e) => `${e.event}: ${String(e.detail ?? "").slice(0, 150)}`)
      .join("\n")
      .slice(0, 8000);
  } catch {
    // kanıt yoksa yine de dener (kontrolcü "thin evidence → adequate" kuralına düşer)
  }
  if (phaseId === 4) {
    try {
      evidence +=
        "\n\nSPEC (head):\n" +
        (await readFile(join(state.project_root, ".mycl", "spec.md"), "utf-8")).slice(0, 4000);
    } catch {
      // spec okunamadı — audit kanıtıyla devam
    }
  }

  const checker = resolveRung(up, config.selected_models.model_tiers);
  try {
    const r = await runReasoning(config, {
      systemPrompt: VERIFY_SYSTEM,
      userMessage:
        `PHASE: ${phaseLabel} (domain: ${domain}). Producer rung: ${rungLabel(cur)}. ` +
        `You are the checker at ${rungLabel(up)}.\n\nEVIDENCE (audit of this phase, this iteration):\n` +
        (evidence || "(no audit evidence captured)"),
      modelId: checker.modelId,
      projectRoot: state.project_root,
      effort: checker.effort,
      maxTokens: 1200,
    });
    if (!r.ok) {
      log.warn("verify-up", "checker call failed (fail-open)", r.error);
      return { verdict: "adequate", checker: up, reasons: ["kontrolcü çalışamadı — fail-open"] };
    }
    const v = parseVerifyVerdict(r.text);
    if (!v) return { verdict: "adequate", checker: up, reasons: ["kontrol çıktısı çözülemedi — fail-open"] };
    return { verdict: v.adequate ? "adequate" : "inadequate", checker: up, reasons: v.reasons };
  } catch (e) {
    log.warn("verify-up", "checker threw (fail-open)", e);
    return { verdict: "adequate", checker: up, reasons: ["kontrolcü hatası — fail-open"] };
  }
}
