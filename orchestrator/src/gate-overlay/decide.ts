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

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
 * Dosya yoksa VAR OLAN en yakın atasının realpath'i + kalan parçalar. Sembolik bağlantı üzerinden
 * içeri yazma (`ln -s src kisayol` → kisayol/yeni.ts) böyle yakalanır: ata çözülünce yol src/ altına iner.
 */
function canonicalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p; // kök — daha yukarısı yok
    return join(canonicalizePath(parent), basename(p));
  }
}

/** macOS/Windows dosya sistemleri varsayılan büyük küçük harf DUYARSIZ; Linux duyarlı (katlama yanlış engel olurdu). */
const CASE_FOLD_DEFAULT = process.platform === "darwin" || process.platform === "win32";

/** NFC normalizasyonu + (duyarsız platformda) küçük harfe katlama — karşılaştırma anahtarı. */
function canonKey(s: string, caseFold: boolean): string {
  const n = s.normalize("NFC");
  return caseFold ? n.toLowerCase() : n;
}

/**
 * Bir yazma aracının hedef yoluna bu iterasyonda izin var mı. (Artık SAF DEĞİL — bilinçli:
 * mahkeme KRİTİK bulgusu 2026-08-11.)
 *
 * ESKİ HAL yalnız `resolve()` METNİNİ karşılaştırıyordu; sembolik bağlantı, macOS'un büyük
 * küçük harf duyarsız dosya sistemi ve Unicode NFD yazımı aynı FİZİKSEL dosyaya farklı metinle
 * ulaşıp kilidi PoC ile geçti. Karşılaştırma artık dosyanın KİMLİĞİNE iner: proje kökü ve hedef
 * realpath ile çözülür (dosya yoksa var olan en yakın ata), iki taraf NFC normalize edilir,
 * duyarsız platformda küçük harfe katlanır. Var olma kontrolü de kanonik yol üzerinden İÇERİDE
 * yapılır (çağıranın ham yola bakması sembolik bağlantıda yanılırdı).
 *
 * overlay-guard.mjs İKİZİYLE birebir — parite tablosu senkron kilididir.
 * HATA = ENGEL: kural kümesi ya da yol anlaşılmıyorsa "izin" en yanlış cevaptır.
 */
export function decideWrite(
  rules: GuardRules,
  targetPath: string,
  opts?: { caseFold?: boolean },
): WriteDecision {
  const caseFold = opts?.caseFold ?? CASE_FOLD_DEFAULT;
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

  let realRoot: string;
  try {
    realRoot = realpathSync(rules.project_root);
  } catch {
    return {
      allow: false,
      gate_id: "invalid_rules",
      message: "gate-overlay guard: project_root unresolvable — failing closed.",
    };
  }
  const resolved = canonicalizePath(resolve(realRoot, targetPath));
  const relRaw = relative(realRoot, resolved).split(sep).join("/");
  // Proje DIŞI yol: overlay'in yetki alanı projedir; dışarıyı kum havuzu yönetir.
  if (relRaw.startsWith("..") || relRaw === "") return ALLOW;
  const rel = canonKey(relRaw, caseFold);

  for (const frozen of rules.immutable) {
    if (rel === canonKey(frozen, caseFold)) {
      return {
        allow: false,
        gate_id: "file_immutable",
        message: `gate-overlay: "${relRaw}" is frozen for this iteration (file_immutable). Do not modify it; solve the task another way.`,
      };
    }
  }

  if (rules.dependency_file_names.some((n) => canonKey(n, caseFold) === canonKey(basename(relRaw), caseFold))) {
    return {
      allow: false,
      gate_id: "forbid_dependency_change",
      message: `gate-overlay: dependency files may not change this iteration (forbid_dependency_change). "${relRaw}" is a dependency file.`,
    };
  }

  const exists = existsSync(resolved);
  for (const dir of rules.no_new_files) {
    // "." = proje kökü = TÜM proje. overlay-guard.mjs İKİZİYLE birebir aynı kural (parite testi kilitler).
    const d = canonKey(dir, caseFold);
    const inDir = dir === "." || rel === d || rel.startsWith(`${d}/`);
    if (inDir && !exists) {
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
