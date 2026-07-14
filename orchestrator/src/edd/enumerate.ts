// edd/enumerate — EDD birim (kaynak dosya) enumeration. YZLLM 2026-07-07 (EDD Faz 1).
//
// DİL-AGNOSTİK (KATI#1): uzantı listesi HARDCODE etmez. TÜM METİN dosyalarını (binary değil, boyut sınırı altında,
// skip-dizin dışında) "birim" sayar. Böylece hangi stack olursa olsun kapsam tam ("hiçbir şey kaçmasın"). Binary /
// aşırı-büyük dosya ATLANMAZ → analyzable:false + sebep (çağıran bunu unanalyzable olarak loglar; sessiz atlama YOK).
//
// Sıra: blast-radius (merkezi modül önce = erken değer) dep-graph'tan (JS/TS/Python importedBy) türetilir; grafik
// yoksa/dil-dışı birimlerde stabil yol-bazlı sıra. dep-graph YALNIZ sıralama için (KATI#1: enumeration ondan bağımsız).

import { promises as fs } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { buildReverseImportGraph } from "../fix/dep-graph/index.js";
import { listIgnoredUntrackedFiles } from "../git.js";
import { log } from "../logger.js";

// dep-graph SKIP_DIRS + build/çıktı dizinleri (dil-agnostik gürültü). Nokta-dizinler ayrıca elenir.
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", ".git", ".mycl",
  "error_folder", "__pycache__", "venv", ".venv", "vendor", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".turbo", "bin", "obj", "Pods", "DerivedData",
]);

// SIR-DOSYALARI — EDD analiz ETMEZ (YZLLM 2026-07-13, çapraz-aile mahkemesi + skeptik hakem). Neden: EDD yabancı
// projeyi birim-birim okuyup davranışını .mycl/edd-analysis.md + edd-progress.jsonl'e YAZAR. Bir `.env`/anahtar
// dosyasını okuyup içeriğini nota alıntılarsa: (a) sır committable `.mycl`'e sızar (git projesinde `.env` gitignore'lu
// → kaynak taramasında da görünmez), (b) `.mycl` semgrep'ten elendiği için (semgrep-excludes.ts) bu sızıntı MyCL
// taramasınca da görülmez = KATI#4 sessiz-fallback. Correct-by-construction (KATI#6): sır dosyasını hiç INGEST etme —
// kaynağında çöz, sonradan redakte etmeye çalışma (LLM-redaksiyon yumuşak + entropi-scrub saf-hex secret'ta çözümsüz:
// hex entropi tavanı 4.0, git-SHA'dan ayrılamaz). Sır dosyaları zaten "davranış" değil (config/kimlik-bilgisi).
// MEKANİZMA: sabit DOSYA-ADI deseni (aşağıda), gitignore-parse DEĞİL. DÜRÜST KALAN-RİSK: standart-olmayan adlı
// gitignore'lu bir sır dosyası (ör. `terraform.tfvars`, `local.settings.json`) bu listede yoksa EDD yine analiz eder →
// o sınıf için tek savunma increment-2'nin yumuşak LLM-redaksiyonu (tam güvenlik ağı DEĞİL). Tam kapanış için gelecek
// iş: gerçek gitignore-farkındalığı (`git check-ignore`) → EDD kapsamı = tarama kapsamı. GÖRÜNÜR: analyzable:false + sebep.
const SECRET_FILE_RE = new RegExp(
  "^(" +
    // .env, .env.local, .env.production, .env.example — AMA .env.d.ts/.env.ts/.env.schema.json (kaynak) DEĞİL:
    // sonek bir kod/veri uzantısıysa (ts/js/json/...) muaf (negatif lookahead); env-adı soneki (local/prod) yakalanır.
    "\\.env(\\.(?!(ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|py|go|rb|java|kt|rs|php|md|html|s?css)$)[a-z0-9_-]+)?" +
    "|.*\\.(pem|key|p12|pfx|keystore|jks|ppk)" + // özel anahtar / sertifika / keystore
    "|id_(rsa|dsa|ecdsa|ed25519)(\\.pub)?" + // ssh anahtarları (pub dahil — davranış değil)
    "|\\.(npmrc|netrc|pgpass|htpasswd)" + // kimlik-bilgisi taşıyan config'ler
    "|secrets?\\.(json|ya?ml|toml|ini|txt|env)" + // secrets.json / secret.yaml ...
    "|credentials?\\.(json|ya?ml|ini|txt)" + // credentials.json ... ('credentialService.js' EŞLEŞMEZ — anchored)
    ")$",
  "i",
);
/** Dosya adı bir sır dosyası mı (EDD ingest etmemeli). Test için export. */
export function isSecretFile(name: string): boolean {
  return SECRET_FILE_RE.test(name);
}

/** 256KB üstü → too-large (üretilmiş/minified/veri; davranış-analizi anlamsız + bütçe koruması). Faz 4 reconcile +
 *  codegen-note hash'lemesi de bu eşiği kullanır (edd/source-hash) → tek doğruluk kaynağı burada. */
export const MAX_UNIT_BYTES = 256 * 1024;
const BINARY_SNIFF_BYTES = 4096;

export interface SourceUnit {
  /** projectRoot'a göre relative yol (birim kimliği; POSIX ayraç). */
  unit: string;
  /** mutlak yol (analyzer okuması için). */
  abs: string;
  bytes: number;
  /** analiz edilebilir mi (binary/too-large değil). false ise reason dolu. */
  analyzable: boolean;
  reason?: string;
}

/** İlk ~4KB'da null-byte varsa binary say (dil-agnostik ikili tespit). */
async function isBinaryFile(abs: string): Promise<boolean> {
  let fh;
  try {
    fh = await openFile(abs, "r");
  } catch {
    return false; // okunamadıysa binary sayma; çağıran read-error'ı ayrı ele alır
  }
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) if (buf[i] === 0) return true;
    return false;
  } finally {
    await fh.close();
  }
}

/**
 * Projedeki TÜM kaynak birimlerini enumerate et (dil-agnostik metin dosyaları). Skip-dizin dışında; boyut/binary
 * ile analyzable ayrımı. Blast-radius (merkezi önce) sıralı. "Miss nothing": her birim döner, analiz-dışı olanlar
 * analyzable:false + sebeple (çağıran unanalyzable loglar).
 */
export async function enumerateSourceUnits(projectRoot: string): Promise<SourceUnit[]> {
  const files: SourceUnit[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      let st: import("node:fs").Stats;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      const unit = relative(projectRoot, full).split(sep).join("/");
      if (isSecretFile(e.name)) {
        // Sır dosyası → EDD ingest ETMEZ (içeriğini nota alıntılayıp committable .mycl'e sızdırmasın). Görünür sebep.
        files.push({ unit, abs: full, bytes: st.size, analyzable: false, reason: "secret-file (sır sızıntısı önleme — EDD analiz etmez)" });
        continue;
      }
      if (st.size > MAX_UNIT_BYTES) {
        files.push({ unit, abs: full, bytes: st.size, analyzable: false, reason: `too-large (${Math.round(st.size / 1024)}KB)` });
        continue;
      }
      if (st.size > 0 && (await isBinaryFile(full))) {
        files.push({ unit, abs: full, bytes: st.size, analyzable: false, reason: "binary" });
        continue;
      }
      files.push({ unit, abs: full, bytes: st.size, analyzable: true });
    }
  }
  await walk(projectRoot);

  // Gitignore-farkındalık: EDD kapsamı ≈ güvenlik tarama kapsamı. GERÇEKTEN dışlanan (untracked+ignored) dosya
  // (committable değil + davranış değil) EDD ingest ETMEZ → standart-olmayan adlı gitignore'lu sır dosyasının .mycl'e
  // sızması kapanır. Fail-soft: git yok / non-git → null → filtre atlanır (SECRET_FILE_RE denylist + kaynak-tarama yine
  // geçerli). YAKLAŞIK (dürüst kalan-risk): alt-modül içi gitignore'lu dosya git standart ls-files'ında görünmez → EDD
  // analiz edebilir; ayrıca `.semgrepignore` bundle/vendor globları EDD SKIP_DIRS'inde yok → EDD semgrep'ten hafif GENİŞ
  // (over-scan, sızıntı değil). GÖRÜNÜR: analyzable:false + sebep.
  const ignored = (await listIgnoredUntrackedFiles(projectRoot)) ?? new Set<string>();
  if (ignored.size > 0) {
    for (const f of files) {
      if (f.analyzable && ignored.has(f.unit)) {
        f.analyzable = false;
        f.reason = "gitignored (EDD kapsamı = güvenlik tarama kapsamı; committable değil)";
      }
    }
  }

  // Blast-radius sırası: dep-graph importedBy (merkezi = önce). Grafik yoksa yol-bazlı stabil sıra.
  let rank: Map<string, number> | null = null;
  try {
    const graph = await buildReverseImportGraph(projectRoot);
    if (graph.available) {
      rank = new Map<string, number>();
      for (const [file, importers] of graph.reverse) {
        rank.set(relative(projectRoot, file).split(sep).join("/"), importers.size);
      }
    }
  } catch (e) {
    log.warn("edd/enumerate", "dep-graph blast-radius alınamadı — yol-bazlı sıra", { error: String(e) });
  }
  files.sort((a, b) => {
    if (a.analyzable !== b.analyzable) return a.analyzable ? -1 : 1; // analyzable önce; unanalyzable ucuz-kayıt sona
    const ra = rank?.get(a.unit) ?? -1;
    const rb = rank?.get(b.unit) ?? -1;
    if (ra !== rb) return rb - ra; // yüksek importedBy (merkezi modül) önce
    return a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0; // stabil, deterministik
  });
  return files;
}
