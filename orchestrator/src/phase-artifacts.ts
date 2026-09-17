// phase-artifacts — bir fazın BİLDİRDİĞİ çıktının nerede olduğu ve gerçekten orada olup olmadığı.
//
// NEDEN (2026-09-17): bugün bir artefaktın yeri ÜÇ ayrı yerde biliniyordu — yazıcı (`withDevsPath` →
// production-schema controller), okuyucu (`currentSpecPath`) ve önkoşul mesajı. Üçü ayrışabildiği
// için mesaj `.mycl/spec.md` derken kontrol `devs/_pending/<ts>/iter-spec.md` yapıyordu; var olan
// bir dosya yanlış yerde arandı ve "spec kayboldu" diye yanlış teşhis üretildi. Tek çözücü, bu
// ayrışmayı yapısal olarak imkânsızlaştırır.
//
// `output_artifact_path` bugüne kadar YALNIZ yazma hedefi türetmek için okunuyordu; hiçbir yerde
// "bu dosya gerçekten oluştu mu?" diye bakılmıyordu. Buradaki `artifactExists` o boşluğu doldurur.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { withDevsPath } from "./devs-paths.js";
import type { PhaseSpec, State } from "./types.js";

type ArtifactState = Pick<State, "project_root" | "iteration_started_at">;

/**
 * SAF: fazın bildirdiği çıktının çözülmüş yolu — yazıcının kullandığı çözümlemenin AYNISI.
 * Faz bir çıktı bildirmiyorsa (codegen / qa / mekanik fazlar) null.
 */
export function declaredArtifact(
  spec: Pick<PhaseSpec, "production_config">,
  state: ArtifactState,
): { abs: string; rel: string } | null {
  const cfg = spec.production_config;
  if (!cfg?.output_artifact_path) return null;
  // Yazıcı ile BİREBİR aynı dönüşüm: iterasyon damgası varsa devs/_pending altına taşınır.
  const rel = withDevsPath(cfg, state).output_artifact_path;
  return { abs: join(state.project_root, rel), rel };
}

/**
 * Fazın bildirdiği çıktı diskte var mı?
 *  - "yes"     : dosya var
 *  - "no"      : faz bir çıktı bildiriyor ve o çıktı YOK
 *  - "unknown" : faz çıktı bildirmiyor ya da bakılamadı (izin/IO hatası)
 *
 * "unknown" bilinçli ayrı bir değer: ölçemediğimiz bir şey için olumsuz iddia üretmeyiz. Çağıran
 * "no" ile "unknown"ı aynı sepete koyarsa yanlış alarm üretir.
 */
export async function artifactExists(
  spec: Pick<PhaseSpec, "production_config">,
  state: ArtifactState,
): Promise<"yes" | "no" | "unknown"> {
  const declared = declaredArtifact(spec, state);
  if (!declared) return "unknown";
  try {
    const st = await fs.stat(declared.abs);
    return st.isFile() && st.size > 0 ? "yes" : "no";
  } catch (e) {
    // Dosya yok → "no" (gerçek bulgu). Başka bir IO hatası (izin, bozuk yol) → "unknown".
    const code = (e as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "no" : "unknown";
  }
}
