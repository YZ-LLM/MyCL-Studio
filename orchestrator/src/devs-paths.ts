// devs-paths — devs/ per-iterasyon artefakt klasör yapısı için yol türetme + format.
// YZLLM 2026-06-16: her iterasyonun çıktısı birim klasörü altında yaşar — fallback zinciri:
//   sayfa  → `devs/pages/<sayfa>/<ts>/`
//   endpoint → `devs/endpoints/<endpoint>/<ts>/`
//   tablo  → `devs/tables/<tablo>/<ts>/`
//   hiçbiri yoksa → `devs/<ts>/` (doğrudan). Çözümü Faz 1 resolver + Faz 4 split.
//
// Bu modül FAZ 0 kapsamı: SADECE yol türetme + zaman damgası biçimi + `_pending/<ts>/`
// iskeleti. Henüz hiçbir okuma/yazma yolu değişmez — yalnız klasör ve TEK-TS invaryantı.
//
// TEK-TS İNVARYANTI: klasör zaman-etiketi == format(state.iteration_started_at). resume-detection
// ve Faz 8 scope bu değere dayanır; ikinci bir Date.now() ile AYRI etiket üretmek resume'da
// klasör-eşleşmesini koparır → her zaman iteration_started_at'ten türet.

import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import type { ProductionConfig, State } from "./types.js";

const DEVS_DIR = "devs";
const PENDING = "_pending";

/**
 * iteration_started_at (unix ms) → "YYYY-MM-DD-HH-MM-SS" (yerel saat — insan-okur klasör adı).
 * Aynı ms her zaman aynı etiketi verir (deterministik); resume'da eşleşme korunur.
 */
export function formatIterationTs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-` +
    `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

export interface DevsPaths {
  /** `<projectRoot>/devs` */
  devsRoot: string;
  /** "2026-06-16-14-32-07" */
  tsLabel: string;
  /** `<projectRoot>/devs/_pending/<tsLabel>` — birim (sayfa/endpoint/tablo) çözülene dek geçici ev. */
  pendingDir: string;
}

/** ts (iteration_started_at ms) için devs/ yollarını türet. */
export function deriveDevsPaths(projectRoot: string, ts: number): DevsPaths {
  const devsRoot = join(projectRoot, DEVS_DIR);
  const tsLabel = formatIterationTs(ts);
  return {
    devsRoot,
    tsLabel,
    pendingDir: join(devsRoot, PENDING, tsLabel),
  };
}

/**
 * İterasyon başında `devs/_pending/<ts>/` iskeletini oluşturur (idempotent — recursive mkdir).
 * Oluşan dizin yolunu döner. Caller fail-soft sarmalı: bu yazım pipeline'ı KIRMAMALI.
 */
export async function ensurePendingIterationDir(projectRoot: string, ts: number): Promise<string> {
  const { pendingDir } = deriveDevsPaths(projectRoot, ts);
  await fs.mkdir(pendingDir, { recursive: true });
  return pendingDir;
}

// ---- Faz 2/3: per-iterasyon spec yazım/okuma (YZLLM 2026-06-16) ----
// Codegen'in spec'i YAZDIĞI (Faz 4) ve OKUDUĞU (Faz 5/8/9) yer artık kök `.mycl/spec.md` DEĞİL,
// `devs/_pending/<ts>/iter-spec.md` — her iterasyon yalnız KENDİ spec'ini görür (karışma yapısal imkansız).
// Kök `.mycl/spec.md` ÇAPRAZ-iterasyon hafıza (Faz 2 compliance / recall) için AYRI kalır (Faz 4'te tazelenir).

const SPEC_ARTIFACT_NAME = "iter-spec.md";

/** Artefaktın _pending klasöründeki adı: `spec.md` → `iter-spec.md`; brief.md/db-schema.md korunur. */
function devsArtifactName(originalPath: string): string {
  const b = basename(originalPath);
  return b === "spec.md" ? SPEC_ARTIFACT_NAME : b;
}

/** Per-iterasyon spec'in MUTLAK yolu: `devs/_pending/<ts>/iter-spec.md`. */
export function pendingSpecPath(projectRoot: string, ts: number): string {
  return join(deriveDevsPaths(projectRoot, ts).pendingDir, SPEC_ARTIFACT_NAME);
}

/**
 * Codegen-okur spec yolu (state'ten). `iteration_started_at` varsa per-iter `iter-spec.md`;
 * yoksa (Faz 0 garantiler — gelmemeli) DEFANSİF olarak eski `.mycl/spec.md`. Read-site'lar bunu kullanır.
 */
export function currentSpecPath(
  state: Pick<State, "project_root" | "iteration_started_at">,
): string {
  return state.iteration_started_at
    ? pendingSpecPath(state.project_root, state.iteration_started_at)
    : join(state.project_root, ".mycl", "spec.md");
}

/** Codegen-okur spec'in projectRoot-RELATIVE yolu — agent prompt'unda "Read ..." için. */
export function currentSpecRelPath(
  state: Pick<State, "iteration_started_at">,
): string {
  return state.iteration_started_at
    ? join("devs", "_pending", formatIterationTs(state.iteration_started_at), SPEC_ARTIFACT_NAME)
    : join(".mycl", "spec.md");
}

/**
 * ProductionConfig'in `output_artifact_path`'ini `devs/_pending/<ts>/<artefakt>`'a çevirir (Faz 2 WRITE).
 * TEK choke-point: ikiz yazıcılar (SDK + CLI) ikisi de `opts.production.output_artifact_path` okur →
 * parite YAPISAL garanti (birini değiştirip ötekini unutmak imkansız). `iteration_started_at` yoksa
 * config DEĞİŞMEDEN döner (güvenli fallback). Yol projectRoot-relative (ikizler join(root, path) yapar).
 */
export function withDevsPath(
  config: ProductionConfig,
  state: Pick<State, "project_root" | "iteration_started_at">,
): ProductionConfig {
  const ts = state.iteration_started_at;
  if (!ts) return config;
  const rel = join("devs", "_pending", formatIterationTs(ts), devsArtifactName(config.output_artifact_path));
  return { ...config, output_artifact_path: rel };
}

/**
 * SAF: "bu faz için spec gerekli" mesajı — GERÇEKTEN aranan yolu söyler.
 *
 * CANLI ZARAR (2026-09-17): mesaj sabit `.mycl/spec.md` yazıyordu ama kontrol `currentSpecPath` ile
 * `devs/_pending/<ts>/iter-spec.md` yapılıyordu. Kullanıcı (ve MyCL'i inceleyen asistan) var olan
 * bir dosyayı yanlış yerde arayıp "spec kayboldu, sahte yeşil" diye YANLIŞ teşhis koydu — spec
 * aslında devs yolunda sapasağlam duruyordu (sha256'sı onay kaydıyla byte-aynı). Yanlış yol söyleyen
 * bir mesaj, sessiz kalmaktan daha zararlı: insanı yanlış tarafa koşturuyor.
 */
export function specRequiredMessage(
  phaseId: number,
  state: Pick<State, "iteration_started_at">,
): string {
  return (
    `⚠ **Faz ${phaseId}** için \`${currentSpecRelPath(state)}\` (Faz 4 çıktısı) gerekli. ` +
    `Önce Faz 4'ü tamamla.`
  );
}
