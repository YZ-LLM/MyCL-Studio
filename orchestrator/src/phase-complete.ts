// phase-complete — `phase-N-complete` damgasının TEK kapısı.
//
// NEDEN (2026-09-17): bu damga bugün 34 ayrı noktada yazılıyor (9 controller + 25 index.ts yeri) ve
// hiçbirinde "faz gerçekten bir çıktı üretti mi?" diye bakılmıyor. Dağınıklığın iki somut bedeli:
//
//  1. SAHTE YEŞİL YÜZEYİ. Damga koşulsuz atıldığı için "tamamlandı" demek, işin yapıldığı anlamına
//     gelmiyor. Canlı kanıt: kullanıcı ekranda "tüm gate'ler yeşil" okudu, oysa Faz 2-17 hiç
//     koşmamıştı.
//  2. AYRIŞMA. Atlama yollarında `phase-N-skipped` ve `phase-N-complete` iki ayrı çağrı; birini
//     yazıp ötekini unutmak ya da detayları farklı yazmak serbest. Faz 16'nın atlanması hükme tam
//     bu yüzden hiç yansımıyordu.
//
// Bu modül damgayı tek yerden geçirir ve kanıt kuralını BİLDİRİMSEL kılar: faz bir çıktı bildiriyorsa
// (`production_config.output_artifact_path`) o çıktı gerçekten diskte mi diye bakılır. Bildirmiyorsa
// hiçbir iddia üretilmez — ölçemediğin şeyi cezalandırmak yanlış alarmdır.

import { appendAudit } from "./audit.js";
import { emitChatMessage } from "./ipc.js";
import { artifactExists, declaredArtifact } from "./phase-artifacts.js";
import { PHASE_SPECS } from "./phase-registry.js";
import type { PhaseId, State } from "./types.js";

/**
 * Faz neden "tamamlandı" sayılıyor? Damganın detayı bu ayrımdan üretilir; hüküm de bu detayı okur.
 *
 * `soft_fail` detayı BİREBİR `"soft_complete_after_fail"` olmak zorunda — `computeVerdict` ve
 * iş-tamamlanma kararı bu eşitliğe bağlı. Değiştirmek prototip kaydını ve modül stoklamasını
 * sessizce bozar (bu regresyon daha önce yaşandı).
 */
export type CompletionVia =
  | { kind: "ran" }
  | { kind: "soft_fail" }
  | { kind: "skipped"; reason: string }
  | { kind: "user"; detail?: string };

export const SOFT_COMPLETE_DETAIL = "soft_complete_after_fail";

/** SAF: damgaya yazılacak detay metni. */
export function completionDetail(via: CompletionVia, extra?: string): string {
  switch (via.kind) {
    case "soft_fail":
      return SOFT_COMPLETE_DETAIL; // kilitli string — hüküm bu eşitliğe bakar
    case "skipped":
      return `via=skipped reason=${via.reason}`;
    case "user":
      return via.detail ?? extra ?? "user_accepted";
    case "ran":
      return extra ?? "";
  }
}

type CompletionState = Pick<State, "project_root" | "iteration_started_at">;

/**
 * `phase-N-complete` damgasını (gerekiyorsa `phase-N-skipped` ile birlikte) yaz.
 *
 * Kanıt kuralı YALNIZ `ran` için işler: faz gerçekten koştuğunu iddia ediyorsa ve bildirdiği çıktı
 * diskte yoksa, damga `soft_complete_after_fail` olur (hüküm KISMİ) + görünür mesaj + ayrı bir
 * `phase-N-output-missing` olayı. Atlanan faz zaten çıktı üretmez → kanıt aranmaz (yanlış alarm yok).
 */
export async function stampPhaseCompletion(
  state: CompletionState,
  phase: PhaseId,
  via: CompletionVia,
  extraDetail?: string,
): Promise<void> {
  const root = state.project_root;
  let etkinVia = via;

  if (via.kind === "ran") {
    const spec = PHASE_SPECS[phase];
    // "unknown" = faz çıktı bildirmiyor ya da bakılamadı → iddia üretme, bugünkü davranış sürsün.
    if (spec && (await artifactExists(spec, state)) === "no") {
      const yol = declaredArtifact(spec, state)?.rel ?? "(yol çözülemedi)";
      emitChatMessage(
        "system",
        `⚠ Faz ${phase} tamamlandı dedi ama bildirdiği çıktı (\`${yol}\`) diskte yok — ` +
          `bu faz "doğrulandı" sayılmıyor.`,
      );
      await appendAudit(root, {
        ts: Date.now(),
        phase,
        event: `phase-${phase}-output-missing`,
        caller: "mycl-orchestrator",
        detail: yol,
      }).catch(() => {});
      etkinVia = { kind: "soft_fail" };
    }
  }

  if (etkinVia.kind === "skipped") {
    // Atlama ve tamamlanma damgaları AYNI yerden yazılır → ayrışmaları imkânsız.
    await appendAudit(root, {
      ts: Date.now(),
      phase,
      event: `phase-${phase}-skipped`,
      caller: "mycl-orchestrator",
      detail: etkinVia.reason,
    });
  }

  await appendAudit(root, {
    ts: Date.now(),
    phase,
    event: `phase-${phase}-complete`,
    caller: "mycl-orchestrator",
    detail: completionDetail(etkinVia, extraDetail),
  });
}
