// phase-preconditions — "bu faz koşabilir mi?" sorusunun TEK yeri.
//
// NEDEN (2026-09-17): bugün genel bir önkoşul yapısı yok. `PhaseSpec` yalnız `required_audits`
// içeriyor ve onun tüketicileri gate değil (yalnız olay adı üretiyor). Diskteki artefakta bakan
// üç ayrı ad-hoc kontrol var (Faz 5, Faz 8, elle faz çalıştırma) ve Faz 7'de hiç kontrol YOK —
// yani spec olmadan da veritabanı tasarımına girilebiliyor. Her fazın kendi kontrolünü yazması
// tam olarak bugünkü durumdur ve kaçınılmaz biçimde ayrışır (mesajın yanlış yol söylemesi de
// bu ayrışmanın ürünüydü).
//
// Bildirimsel yaklaşım: bir faz neye ihtiyaç duyduğunu `PhaseSpec.requires` ile SÖYLER; kontrol
// tek yerden yapılır ve mesaj çözülmüş yoldan üretilir.

import { declaredArtifact, artifactExists } from "./phase-artifacts.js";
import { PHASE_SPECS } from "./phase-registry.js";
import type { PhaseSpec, State } from "./types.js";

export type PreconditionResult =
  | { ok: true }
  /** Önkoşul karşılanmadı. `severity` çağıranın ne yapacağını söyler. */
  | { ok: false; message: string; severity: "block" | "warn" };

type PrecondState = Pick<State, "project_root" | "iteration_started_at">;

/**
 * Fazın bildirdiği önkoşullar karşılanıyor mu?
 *
 * `severity`:
 *  - "block" → faz koşamaz (Faz 5/8'in bugünkü davranışı: spec yoksa fail).
 *  - "warn"  → görünür uyarı ama AKIŞ SÜRER. Bugün kontrolü hiç olmayan bir faza kontrol eklerken
 *    kullanılır: davranışı bir anda sertleştirmek, bugüne kadar geçen koşuları kırardı (KATI #14).
 *
 * Ölçülemeyen durum ("unknown") önkoşulu DÜŞÜRMEZ: bakamadığımız bir dosya için "yok" denmez.
 */
export async function checkPreconditions(
  spec: Pick<PhaseSpec, "requires">,
  state: PrecondState,
): Promise<PreconditionResult> {
  for (const req of spec.requires ?? []) {
    const kaynak = PHASE_SPECS[req.phase];
    if (!kaynak) continue; // tanımsız faz → sessizce atla (uydurma iddia yok)
    const durum = await artifactExists(kaynak, state);
    if (durum === "no") {
      const yol = declaredArtifact(kaynak, state)?.rel ?? "(yol çözülemedi)";
      return {
        ok: false,
        severity: req.severity ?? "block",
        message:
          `⚠ Bu faz için \`${yol}\` (Faz ${req.phase} çıktısı) gerekli ama dosya yok. ` +
          `Önce Faz ${req.phase}'i tamamla.`,
      };
    }
    // "yes" → sıradaki önkoşul. "unknown" → ölçemedik, iddia üretmeyiz.
  }
  return { ok: true };
}
