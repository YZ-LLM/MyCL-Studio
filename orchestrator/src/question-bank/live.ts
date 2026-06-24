// İkili Soru Bankası — canlı adaptör (Dilim 3b, flag-arkası).
//
// Mekanik faz GEÇİNCE (question_bank_enabled açıksa) çağrılır. State'ten
// DETERMİNİSTİK girdileri çözer: stack=state.stack (detectStack çıktısı),
// profil=loadProfile, changedFiles=state.changed_scope?.files, banksRoot=
// assets/question-banks. project_type KULLANILMAZ — KEY'e girmez (laundering).
//
// Bu adaptör pipeline kontrol-akışını DEĞİŞTİRMEZ; yalnız outcome döner. Caller
// (index.ts) raporu emit eder + halt'ta LOUD escalate eder.

import { loadProfile } from "../profile-loader.js";
import { questionBanksRoot } from "../phase-registry.js";
import { runBankGate, type BankGateOutcome } from "./gate.js";
import { createCmdRunner } from "./runner.js";
import { phaseCheckpointId } from "./key.js";
import type { PhaseId, State } from "../types.js";

/**
 * Bir mekanik faz için bank-gate'i canlı koş. stack belirsizse null (caller atlar).
 * Banka yoksa outcome.decision = "skip_no_bank" (görünür; sahte-yeşil değil).
 */
export async function runBankGateLive(
  state: State,
  phaseId: PhaseId,
): Promise<BankGateOutcome | null> {
  if (!state.stack || state.stack === "unknown") return null;
  const profile = await loadProfile(state.stack);
  return runBankGate({
    banksRoot: questionBanksRoot(),
    checkpoint: phaseCheckpointId(phaseId),
    stack: state.stack,
    changedFiles: state.changed_scope?.files ?? [],
    profile,
    projectRoot: state.project_root,
    runner: createCmdRunner(),
  });
}
