// gate-overlay/decide — tool_deny gate'lerinin ARAÇ ANI kararı (SAF) + muhafız kuralı üretimi.
//
// NEDEN İKİZ KOD (bilinçli, tek istisna): aynı karar iki ayrı yerde uygulanır —
//   (1) abonelik/CLI yolunda AYRI BİR SÜREÇ olan `orchestrator/overlay-guard.mjs` (PreToolUse kancası),
//   (2) API/SDK yolunda MyCL'in kendi araç yürütücüsü (tool-handlers.executeTool).
// Muhafız `dist/`ten import ETMEZ ve etmemeli: fail-closed bütünlüğü derlenmiş çıktının varlığına
// bağlı olamaz (dist eksik/bozuksa kanca sessizce çalışmaz olurdu — tam da engellemek istediğimiz
// sessiz koruma kaybı). Bedeli: iki kopya. Kopyanın serbest kalmaması PARİTE testiyle kilitlenir —
// aynı durum tablosu hem `decideWrite`'a hem GERÇEK muhafız sürecine uygulanır, kararlar eşleşmeli.
//
// SIRA ÖNEMLİ (muhafızla birebir): immutable → bağımlılık → yeni dosya yasağı. Bir yol birden
// fazla kurala takılıyorsa modele DÖNEN mesaj hep aynı olsun; aksi halde "hangi kural beni durdurdu"
// sorusunun cevabı yola/koşuma göre değişirdi.

import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { DEPENDENCY_MANIFEST_FILES, type CompiledOverlay } from "./compile.js";

/**
 * Muhafıza (ve API yolundaki ikizine) verilen DONUK kural kümesi. Alan bilgisi taşımaz:
 * hangi dosya donduruldu, bağımlılık dosyası hangi adlar — hepsi MyCL'in derleme anında
 * hesapladığı veridir. Şema `overlay-guard.mjs` başlığındaki sözleşmenin aynısıdır.
 */
export interface GuardRules {
  /** Mutlak proje kökü. Yollar buna göre çözülür. */
  project_root: string;
  /** Bu iterasyonda değiştirilemeyecek dosyalar (proje-göreli, "/" ayraçlı). */
  immutable: string[];
  /** Altına YENİ dosya eklenemeyecek dizinler (proje-göreli). */
  no_new_files: string[];
  /** Dokunulamayacak bağımlılık bildirim dosyalarının ADLARI (yol değil, taban ad). */
  dependency_file_names: string[];
}

export type WriteDecision =
  | { allow: true }
  | { allow: false; gate_id: string; message: string };

const ALLOW: WriteDecision = { allow: true };

/**
 * SAF: bir yazma aracının hedef yoluna bu iterasyonda izin var mı.
 *
 * `targetPath` aracın verdiği HAM yoldur (göreli ya da mutlak) — normalize etmek bu
 * fonksiyonun işidir; `sub/../x` gibi dolambaçlar `resolve` ile düzleşir, yani dondurulmuş
 * dosyaya dolaylı yoldan yazmak engeli aşamaz.
 * `fileExists` yalnız forbid_new_files için gerekir (var olanı düzenlemek serbest, yenisini
 * yaratmak yasak); çağıran diskten okur (muhafız `existsSync`, API yolu `fs.stat`).
 *
 * HATA = ENGEL: kural kümesi ya da yol anlaşılmıyorsa "izin" en yanlış cevaptır (muhafızın
 * fail-closed duruşuyla birebir; mesajlar da birebir — model iki yolda AYNI geri bildirimi alır).
 */
export function decideWrite(
  rules: GuardRules,
  targetPath: string,
  fileExists: boolean,
): WriteDecision {
  if (!rules.project_root || !isAbsolute(rules.project_root)) {
    return {
      allow: false,
      gate_id: "invalid_rules",
      message: "gate-overlay guard: project_root invalid — failing closed.",
    };
  }
  if (typeof targetPath !== "string" || targetPath.trim() === "") {
    return {
      allow: false,
      gate_id: "invalid_rules",
      message: "gate-overlay guard: write tool without a file path — failing closed.",
    };
  }

  const resolved = resolve(rules.project_root, targetPath);
  const rel = relative(rules.project_root, resolved).split(sep).join("/");
  // Proje DIŞI yol: overlay'in yetki alanı projedir; dışarıyı kum havuzu yönetir.
  if (rel.startsWith("..") || rel === "") return ALLOW;

  for (const frozen of rules.immutable) {
    if (rel === frozen) {
      return {
        allow: false,
        gate_id: "file_immutable",
        message: `gate-overlay: "${rel}" is frozen for this iteration (file_immutable). Do not modify it; solve the task another way.`,
      };
    }
  }

  if (rules.dependency_file_names.includes(basename(rel))) {
    return {
      allow: false,
      gate_id: "forbid_dependency_change",
      message: `gate-overlay: dependency files may not change this iteration (forbid_dependency_change). "${rel}" is a dependency file.`,
    };
  }

  for (const dir of rules.no_new_files) {
    // "." = proje kökü = TÜM proje. overlay-guard.mjs İKİZİYLE birebir aynı kural (parite testi kilitler).
    const inDir = dir === "." || rel === dir || rel.startsWith(`${dir}/`);
    if (inDir && !fileExists) {
      return {
        allow: false,
        gate_id: "forbid_new_files",
        message: `gate-overlay: creating new files under "${dir}" is forbidden this iteration (forbid_new_files). Edit existing files instead.`,
      };
    }
  }

  return ALLOW;
}

/**
 * SAF: derlenmiş overlay'den muhafız kuralı üretir. tool_deny ailesinden HİÇ seçim yoksa
 * `null` döner — bu durumda ne kanca ne kanarya eklenir (kanca gereksizken kanarya kurmak,
 * hiçbir şey korumayan bir koşuyu başarısız sayma riski demek olurdu).
 *
 * Yollar overlay'de zaten proje-göreli + doğrulanmış gelir (select.ts bağlam kapısı).
 */
export function buildGuardRules(
  overlay: CompiledOverlay | null,
  projectRoot: string,
): GuardRules | null {
  if (!overlay) return null;
  const immutable: string[] = [];
  const noNewFiles: string[] = [];
  let dependencyLock = false;
  for (const sel of overlay.selections) {
    if (sel.gate_id === "file_immutable" && sel.params.path) immutable.push(sel.params.path);
    else if (sel.gate_id === "forbid_new_files" && sel.params.dir) noNewFiles.push(sel.params.dir);
    else if (sel.gate_id === "forbid_dependency_change") dependencyLock = true;
  }
  if (immutable.length === 0 && noNewFiles.length === 0 && !dependencyLock) return null;
  return {
    project_root: projectRoot,
    // Sıralı + tekil: aynı seçim kümesi her zaman AYNI base64'ü versin (determinizm, AD-5).
    immutable: [...new Set(immutable)].sort(),
    no_new_files: [...new Set(noNewFiles)].sort(),
    dependency_file_names: dependencyLock ? [...DEPENDENCY_MANIFEST_FILES] : [],
  };
}

/** Kuralları muhafızın beklediği argv biçimine (base64 JSON) çevirir. */
export function encodeGuardRules(rules: GuardRules): string {
  return Buffer.from(JSON.stringify(rules), "utf-8").toString("base64");
}

/** Yazma araçlarının dosya alanı (muhafızdaki sıra ile birebir). */
export function writeToolTargetPath(input: Record<string, unknown>): string {
  const raw = input.file_path ?? input.notebook_path ?? input.path;
  return typeof raw === "string" ? raw : "";
}

/** Kancanın (ve API ikizinin) denetlediği yazma araçları — tek doğruluk kaynağı. */
export const WRITE_TOOL_NAMES: readonly string[] = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
];

/** SAF: bu araç adı yazma aracı mı (overlay denetimi ona uygulanır mı). */
export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_NAMES.includes(name);
}
