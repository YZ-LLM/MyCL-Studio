// İkili Soru Bankası — gate orkestrasyonu (Dilim 3a).
//
// Akış (saf orkestrasyon; runner enjekte edilir → test'li):
//   1. classifyArtifacts → bankKeysFor (KEY'ler, project_type YOK)
//   2. her KEY için readBank → soruları union'la (dedup by id)
//   3. soru yoksa → skip_no_bank (GÖRÜNÜR uyarı; sahte-yeşil değil)
//   4. verifyBankQuestions (LOAD-anı meta-test) → yalnız trusted koşar, stale → insana
//   5. trusted check'leri PROJE üzerinde koş → classifyExit → QuestionVerdict
//   6. aggregateGate → karar + coverage-honesty raporu ("hepsi yeşil ≠ doğru")

import { aggregateGate, classifyExit } from "./engine.js";
import {
  WIDEST_ARTIFACT,
  bankKeyToPath,
  bankKeysFor,
  classifyArtifacts,
  type ArtifactGlobSource,
} from "./key.js";
import { verifyBankQuestions, type CmdRunner } from "./lock.js";
import { readBank } from "./storage.js";
import type { StackId } from "../types.js";
import type { BankQuestion, CheckOutcome, GateResult, QuestionVerdict } from "./types.js";

export interface BankGateInput {
  banksRoot: string;
  /** Gate/checkpoint kimliği — örn. "phase-10". */
  checkpoint: string;
  stack: StackId;
  /** Değişen dosyalar (artefakt sınıflandırması için). */
  changedFiles: string[];
  /** Profil (artifact_globs taşır); null → tüm dosyalar WIDEST. */
  profile: ArtifactGlobSource | null;
  /** Check'lerin koşacağı cwd. */
  projectRoot: string;
  runner: CmdRunner;
  stabilityRuns?: number;
}

export type BankGateDecision = GateResult["decision"] | "skip_no_bank";

export interface BankGateOutcome {
  decision: BankGateDecision;
  /** null = banka/soru yok (skip_no_bank). */
  result: GateResult | null;
  /** LOAD-anı meta-testini geçemeyen sorular (kanıtlanamadı/rotted → insana). */
  stale: { question: BankQuestion; reason: string }[];
  /** İnsan-yüzlü TR kapsama raporu. */
  report: string;
  /** Bakılan artefakt-tipleri (gözlemlenebilirlik). */
  keysConsidered: string[];
}

/** Tek bir trusted sorunun check'ini PROJE üzerinde koş → hüküm. */
async function runQuestion(
  q: BankQuestion,
  runner: CmdRunner,
  projectRoot: string,
): Promise<QuestionVerdict> {
  const cmd = q.check.cmd.trim();
  if (!cmd) {
    // Komut yok (profil kapasitesi null) → NA (kapsam dışı; sessiz-pass değil).
    return { question_id: q.id, outcome: "NA", blocking_class: q.blocking_class };
  }
  let outcome: CheckOutcome;
  try {
    const res = await runner(cmd, projectRoot);
    outcome = classifyExit(res.code, q.check.inconclusive_codes ?? []);
  } catch {
    outcome = "INCONCLUSIVE"; // runner patladı → değerlendirilemedi
  }
  return { question_id: q.id, outcome, blocking_class: q.blocking_class };
}

function decisionLabel(d: GateResult["decision"]): string {
  return d === "green"
    ? "GEÇTİ (yeşil)"
    : d === "halt_defect"
      ? "DUR — defect (insana yükselt)"
      : "DUR — infra-fault (değerlendirilemedi, insana)";
}

function buildReport(
  checkpoint: string,
  finalDecision: GateResult["decision"],
  result: GateResult,
  staleCount: number,
  staleBlockingCount: number,
  keys: string[],
): string {
  const c = result.coverage;
  const lines = [
    `🔎 ${checkpoint} ikili-soru tripwire (artefakt: ${keys.join(", ")})`,
    `• Karar: ${decisionLabel(finalDecision)}`,
    `• Kapsam: ${c.pass}/${c.total} PASS · ${c.fail} FAIL · ${c.inconclusive} değerlendirilemedi · ${c.na} kapsam-dışı`,
    `• Oran: %${Math.round(c.fraction * 100)} (mekanik değişmezler; "hepsi yeşil ≠ iş doğru")`,
  ];
  if (staleCount > 0) {
    lines.push(
      `• ⚠ ${staleCount} check meta-testi geçemedi (kanıtlanamadı/rotted; ${staleBlockingCount} blocking) → insana`,
    );
  }
  if (result.advisory_findings.length > 0) {
    lines.push(`• ${result.advisory_findings.length} advisory bulgu (durdurmaz, rapora girer)`);
  }
  return lines.join("\n");
}

/** Bir checkpoint için ikili-soru tripwire'ını koş. */
export async function runBankGate(input: BankGateInput): Promise<BankGateOutcome> {
  const artifacts = classifyArtifacts(input.profile, input.changedFiles);
  // Boş kapsam (full-mod / değişen-dosya yok) → en azından en geniş bankayı kontrol et
  // (under-check'ten kaçın; gate hiç koşmadan atlamasın).
  if (artifacts.size === 0) artifacts.add(WIDEST_ARTIFACT);
  const keys = bankKeysFor(input.checkpoint, input.stack, artifacts);
  const keysConsidered = keys.map((k) => k.artifact);

  const questionsById = new Map<string, BankQuestion>();
  for (const key of keys) {
    const bank = await readBank(bankKeyToPath(input.banksRoot, key));
    if (!bank) continue;
    for (const q of bank.questions) questionsById.set(q.id, q);
  }
  const questions = [...questionsById.values()];

  if (questions.length === 0) {
    return {
      decision: "skip_no_bank",
      result: null,
      stale: [],
      report:
        `ℹ️ ${input.checkpoint}: bu KEY için soru bankası yok (artefakt: ${keysConsidered.join(", ")}) — ` +
        `tripwire atlandı, GÖRÜNÜR (sahte-yeşil değil; banka üretimi ayrı adım).`,
      keysConsidered,
    };
  }

  // LOAD-anı önkoşulu: yalnız meta-testi geçen (trusted) check'ler koşar.
  const trust = await verifyBankQuestions(questions, input.runner, {
    stabilityRuns: input.stabilityRuns,
  });

  const verdicts: QuestionVerdict[] = [];
  for (const q of trust.trusted) {
    verdicts.push(await runQuestion(q, input.runner, input.projectRoot));
  }
  const result = aggregateGate(verdicts);

  // Blocking stale = değerlendirilemeyen blocking invariant → halt_infra (sahte-yeşil
  // değil). Defect önceliklidir; advisory stale durdurmaz.
  const staleBlocking = trust.stale.filter((s) => s.question.blocking_class === "blocking");
  const finalDecision: GateResult["decision"] =
    result.decision === "halt_defect"
      ? "halt_defect"
      : result.decision === "halt_infra" || staleBlocking.length > 0
        ? "halt_infra"
        : "green";

  return {
    decision: finalDecision,
    result,
    stale: trust.stale,
    report: buildReport(
      input.checkpoint,
      finalDecision,
      result,
      trust.stale.length,
      staleBlocking.length,
      keysConsidered,
    ),
    keysConsidered,
  };
}
