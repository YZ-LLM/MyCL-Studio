// prototype-cache — stack başına golden scaffold cache (repo-içi `prototypes/<tam-stack>/`,
// YZLLM 2026-06-20: git'te + public → taze clone'da hazır gelsin; test/app için MYCL_PROTOTYPES_DIR override).
//
// Vizyon (YZLLM): "sağlam + hızlı başlangıç". Bir stack'in projesi pipeline'ı baseline+
// güvenlik YEŞİL geçince (gate-fail yok), MyCL o projenin BASELINE dosyalarını (feature
// kodu HARİÇ — conservative allowlist) golden prototip olarak kaydeder (oto-anlık-görüntü,
// YZLLM kararı 2026-06-04). Aynı stack'te yeni greenfield proje Faz 5 başında bu prototipten
// kopyalanır → ana ajan üstüne genişletir (sıfırdan değil).
//
// Bayatlama (YZLLM'in işaret ettiği risk): her prototiple `<stack>.meta.json` (createdAt +
// araç sürümü); apply'da MAX_AGE_DAYS'ten eskiyse GÖRÜNÜR uyarı (yine kopyalanır ama
// "taze değil" notu — sessiz değil). Her yeşil koşu prototipi tazeler (overwrite).
//
// Güvenli: snapshot pipeline-end yan-etkisi (ASLA throw etmez); apply yalnız greenfield
// (isExistingProject=false) + stack biliniyor + cache var. Conservative allowlist →
// feature kodu prototipe SIZMAZ (yeni projeleri kirletmez). Çapraz-platform (mac+linux).

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAudit, readAuditLog } from "./audit.js";
import { computeVerdict, eventsSince } from "./harness-verdict.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import { isExistingProject } from "./phase-1-codebase-probe.js";
import type { State } from "./types.js";

/** Prototip taze sayılma süresi (gün). Aşılırsa apply'da görünür "bayat" uyarısı. */
const MAX_AGE_DAYS = 30;

/** Yürüyüş sırasında HİÇ girilmeyen dizinler (build çıktısı / vcs / bağımlılık).
 *  EXPORT: module-stock.ts da aynı deny-listesini kullanır (DRY). */
export const DENY_SEGMENTS = new Set([
  "node_modules", "dist", "build", ".git", ".mycl", "coverage", ".next",
  "target", "__pycache__", ".venv", "venv", ".cache", "out", "tmp", ".turbo",
]);

/** Baseline kök-config dosyaları (TAM ad; feature değil iskelet/araç yapılandırması). */
const ROOT_CONFIG_BASENAMES = new Set([
  "package.json", "tsconfig.json", "tsconfig.node.json", "tsconfig.app.json",
  "vite.config.ts", "vite.config.js", "next.config.js", "next.config.mjs",
  ".gitignore", ".prettierrc", ".prettierrc.json", ".eslintrc.json", ".eslintrc.cjs",
  "eslint.config.js", "eslint.config.mjs", "postcss.config.js",
  "tailwind.config.js", "tailwind.config.ts", ".env.example", "index.html",
  "pyproject.toml", "Cargo.toml", "go.mod", "requirements.txt", "Dockerfile",
]);

/** Baseline giriş-iskeleti yolları (feature kodu DEĞİL — uygulama girişi). */
const ENTRY_PREFIXES = [
  "src/main.", "src/index.", "src/App.", "src/app.", "src/vite-env.d.ts",
  "src/main.rs", "main.py", "app/main.",
];

/**
 * SAF: proje-köküne göreli bir yol BASELINE mi (prototipe alınmalı mı)? Conservative
 * allowlist — eşleşMEyen her şey (feature kodu, testler, business logic) HARİÇ tutulur,
 * böylece feature kodu prototipe sızıp yeni projeleri kirletmez. Test edilebilir.
 */
export function matchesBaseline(relPath: string): boolean {
  const norm = relPath.split(sep).join("/");
  if (norm === "" || norm.startsWith("/")) return false;
  const segments = norm.split("/");
  if (segments.some((s) => DENY_SEGMENTS.has(s))) return false;

  // public/** (statik varlıklar — baseline).
  if (norm.startsWith("public/")) return true;

  // Giriş-iskeleti dosyaları.
  if (ENTRY_PREFIXES.some((p) => norm.startsWith(p))) return true;

  // Kök-config dosyaları (yalnız kökte; alt-dizindeki aynı-adlı dosya feature olabilir).
  if (!norm.includes("/")) {
    if (ROOT_CONFIG_BASENAMES.has(norm)) return true;
    // *.config.{js,ts,mjs,cjs} (eslint/prettier/jest/postcss... jenerik araç config).
    if (
      norm.endsWith(".config.js") ||
      norm.endsWith(".config.ts") ||
      norm.endsWith(".config.mjs") ||
      norm.endsWith(".config.cjs")
    ) {
      return true;
    }
  }
  return false;
}

/** Prototip meta (bayatlama tespiti için). */
export interface PrototypeMeta {
  stack: string;
  createdAt: number;
  nodeVersion: string;
  fileCount: number;
  /** YEŞİL koşuda kaydedilen TAM çalışan proje mi (true) yoksa config-iskelet baseline mi (false/undefined). */
  full?: boolean;
}

/** SAF: meta MAX_AGE_DAYS'ten eski mi (bayat). now ms epoch. */
export function isStale(meta: PrototypeMeta, now: number, maxAgeDays = MAX_AGE_DAYS): boolean {
  return now - meta.createdAt > maxAgeDays * 24 * 60 * 60 * 1000;
}

// YZLLM 2026-06-20: prototipler artık repo İÇİNDE + git'te (public — hızlı onboarding: clone'da
// hazır gelsin). dist/prototype-cache.js → ../.. = mycl-v14 repo kökü → /prototypes. Test izolasyonu
// + paketlenmiş .app (orchestrator salt-okunur) için MYCL_PROTOTYPES_DIR override (gerçek repo
// prototypes/'ını kirletmez). NOT: paketlenmiş app'in OKUyabilmesi için prototypes/ tauri bundle
// resources'a eklenmeli (yazma dev'de; app'te apply-only).
function prototypesBaseDir(): string {
  const override = process.env.MYCL_PROTOTYPES_DIR;
  if (override && override.trim().length > 0) return override;
  // Test izolasyonu: MYCL_HOME set ise (entegrasyon testleri tam-yeşil pipeline koşunca
  // snapshotPrototype'ı tetikler) prototipleri de oraya yaz → gerçek repo prototypes/'ını
  // KİRLETME. Production'da MYCL_HOME normalde set DEĞİL → repo-kökü kullanılır.
  const home = process.env.MYCL_HOME;
  if (home && home.trim().length > 0) return join(home, "prototypes");
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "prototypes");
}
function prototypeDir(stack: string): string {
  return join(prototypesBaseDir(), stack);
}
function prototypeMetaPath(stack: string): string {
  return join(prototypesBaseDir(), `${stack}.meta.json`);
}

/**
 * SAF: temel stack + spec metninden tespit edilen dil/framework token'larıyla ZENGİN,
 * deterministik stack parmak izi üretir (ör. "node-npm_typescript_react"). YZLLM 2026-06-20:
 * klasör adı "node-npm" gibi kaba değil, tam stack olsun ki yeni proje TAM eşleşeni bulsun
 * (React prototipi Angular projesine sızmasın). Hem snapshot (build edilen) hem apply
 * (greenfield = istenen stack) AYNI kaynaktan (spec) türetir → eşleşir. STACK-BAĞIMSIZ:
 * hiçbir framework'e kilitlemez, yalnız etiketler; token yoksa → yalnız base (geriye-uyumlu).
 */
export function composeStackFingerprint(baseStack: string, specText: string): string {
  const t = specText.toLowerCase();
  const tokens: string[] = [];
  const add = (label: string, re: RegExp) => {
    if (re.test(t) && !tokens.includes(label)) tokens.push(label);
  };
  add("typescript", /\btypescript\b|\.tsx?\b/);
  // Ön-yüz
  add("react", /\breact\b|\bnext(?:\.?js)?\b/);
  add("next", /\bnext(?:\.?js)?\b/);
  add("vue", /\bvue(?:\.?js)?\b|\bnuxt\b/);
  add("angular", /\bangular\b/);
  add("svelte", /\bsvelte(?:kit)?\b/);
  add("solid", /\bsolid(?:js)?\b/);
  add("astro", /\bastro\b/);
  // Arka-uç
  add("django", /\bdjango\b/);
  add("flask", /\bflask\b/);
  add("fastapi", /\bfastapi\b/);
  add("express", /\bexpress(?:\.?js)?\b/);
  add("nest", /\bnest(?:\.?js)?\b/);
  add("rails", /\b(?:ruby on )?rails\b/);
  add("laravel", /\blaravel\b/);
  add("spring", /\bspring(?: boot)?\b/);
  const safe = (s: string) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return [safe(baseStack), ...tokens].filter(Boolean).join("_");
}

/** spec.md + features.md metnini topla (best-effort; yoksa boş). */
async function readSpecText(projectRoot: string): Promise<string> {
  const parts: string[] = [];
  for (const rel of [join(".mycl", "spec.md"), join(".mycl", "features.md")]) {
    try {
      parts.push(await fs.readFile(join(projectRoot, rel), "utf-8"));
    } catch {
      /* yoksa atla */
    }
  }
  return parts.join("\n");
}

/** Zengin stack parmak izi (klasör adı) — base stack + spec'ten dil/framework. */
export async function stackFingerprint(state: State): Promise<string> {
  return composeStackFingerprint(state.stack ?? "unknown", await readSpecText(state.project_root));
}

/** Baseline yolları topla (DENY dizinlerine girmeden recursive). */
async function collectBaselineFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (DENY_SEGMENTS.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // Alt-dizine yalnız baseline-ihtimali varsa in (public/ + src/ giriş). Diğer
      // alt-dizinler (components/api/...) feature → atla (perf + güvenlik).
      if (childRel === "public" || childRel === "src" || childRel === "app" || rel !== "") {
        out.push(...(await collectBaselineFiles(root, childRel)));
      }
    } else if (e.isFile() && matchesBaseline(childRel)) {
      out.push(childRel);
    }
  }
  return out;
}

/**
 * TÜM proje dosyalarını topla (DENY dizinlerine — node_modules/.next/dist/.git/.mycl — girmeden recursive).
 * GREEN-prototip için (YZLLM 2026-06-22 "TÜM dosyalarını"): yeşil koşuda config-iskelet değil, GERÇEK
 * çalışan projenin tamamı (app/components/lib/backend dahil) prototip olarak kaydedilir.
 */
async function collectAllFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (DENY_SEGMENTS.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...(await collectAllFiles(root, childRel)));
    } else if (e.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

/**
 * IMPURE: pipeline-end'de çağrılır. Koşu YEŞİL (gate-fail yok) + stack biliniyorsa,
 * baseline dosyalarını ~/.mycl/prototypes/<stack>/ altına kaydeder (overwrite=tazele) +
 * meta yazar. NON-BLOCKING — asla throw etmez (yan-yarar). Yeşil değilse / stack yoksa no-op.
 */
export async function snapshotPrototype(state: State, opts?: { force?: boolean }): Promise<void> {
  try {
    const baseStack = state.stack;
    if (!baseStack || baseStack === "unknown") return;

    // YZLLM 2026-06-20: baseline (config/scaffold/giriş dosyaları — feature/business kodu HARİÇ,
    // matchesBaseline) test/kalite gate-fail'lerinden ETKİLENMEZ → TAMAMLANAN iterasyon yeşil
    // OLMASA da prototip kaydedilir ("temel modül her durumda prototip olsun"; yeni proje ondan
    // hızlı + düşük-token başlar). Eski "yeşil-zorunlu" kapı prototipi hiç doldurmuyordu (gate-fail'li
    // koşular da boşta kaldı). KÖK FIX (eventsSince) korunur: yalnız BU iterasyona bak. force → manuel
    // snapshot (verdict'i tamamen baypas — pipeline-end dışından force-snapshot için).
    // YZLLM 2026-06-22 ("Faz 17 yeşil → TÜM dosyalar"): YEŞİL (tüm gate'ler PASS, Faz 17 dahil) → GERÇEK
    // çalışan projenin TAMAMI prototip olur. PARTIAL/yeşil-değil ama tamamlanmış → mevcut baseline (config-
    // iskelet, hızlı scaffold fallback). force → tam-snapshot (manuel). Yarım koşu (completed değil) → no-op.
    let green = !!opts?.force;
    if (!opts?.force) {
      const events = await readAuditLog(state.project_root);
      const verdict = computeVerdict(eventsSince(events, state.iteration_started_at ?? 0));
      if (!verdict.completed) return; // en azından iterasyon SONUNA ulaşmış olmalı (yarım koşu prototip olmaz)
      green = verdict.verdict === "PASS";
    }

    const files = green
      ? await collectAllFiles(state.project_root)
      : await collectBaselineFiles(state.project_root);
    if (files.length === 0) return; // kaydedilecek dosya yok

    // Zengin parmak izi (base + spec'ten dil/framework) — klasör adı tam stack'i taşır.
    const stack = await stackFingerprint(state);
    const destDir = prototypeDir(stack);
    // Tazele: eski prototipi temizle (stale dosya kalmasın), yeniden yaz.
    await fs.rm(destDir, { recursive: true, force: true });
    for (const rel of files) {
      const src = join(state.project_root, rel);
      const dest = join(destDir, rel);
      await fs.mkdir(join(dest, ".."), { recursive: true });
      await fs.copyFile(src, dest);
    }
    const meta: PrototypeMeta = {
      stack,
      createdAt: Date.now(),
      nodeVersion: process.version,
      fileCount: files.length,
      full: green, // YEŞİL → tam çalışan proje; değilse config-iskelet (baseline)
    };
    await fs.mkdir(prototypesBaseDir(), { recursive: true });
    await fs.writeFile(prototypeMetaPath(stack), JSON.stringify(meta, null, 2), "utf-8");

    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: state.current_phase,
      event: "prototype-cache-saved",
      caller: "mycl-orchestrator",
      detail: `stack=${stack} files=${files.length}`,
    }).catch(() => {});
    emitChatMessage(
      "system",
      green
        ? `📦 Golden prototip kaydedildi (${stack}, ${files.length} dosya — TAM YEŞİL proje) — bu stack'teki sonraki proje buradan başlar.`
        : `📦 Prototip iskeleti güncellendi (${stack}, ${files.length} baseline dosyası) — koşu tamamen yeşil olunca TAM proje kaydedilir.`,
    );
  } catch (err) {
    // Yan-yarar; ana akışı ASLA bozma. Görünür uyarı (sessiz değil) ama non-fatal.
    log.warn("prototype-cache", "snapshot failed (non-fatal)", err);
  }
}

/**
 * IMPURE: Faz 5 başında çağrılır. greenfield (mevcut-proje değil) + stack biliniyor +
 * cache varsa, prototip dosyalarını projeye kopyalar (mevcut dosyaları EZMEZ) → ana ajan
 * üstüne genişletir. Bayatsa GÖRÜNÜR uyarı (yine kopyalar). NON-BLOCKING — throw etmez.
 * @returns uygulandı mı (true → ajan prompt'una "baseline mevcut, genişlet" notu eklenebilir).
 */
export async function applyPrototype(state: State): Promise<boolean> {
  try {
    const baseStack = state.stack;
    if (!baseStack || baseStack === "unknown") return false;
    // Zengin parmak izi — greenfield'de spec.md'den (istenen stack) türetilir; snapshot ile aynı kaynak → eşleşir.
    const stack = await stackFingerprint(state);
    const srcDir = prototypeDir(stack);
    if (!existsSync(srcDir)) return false; // bu tam-stack için cache yok

    // Yalnız greenfield (mevcut kod yoksa). İterasyon/mevcut projeye uygulama → kirletir.
    if (await isExistingProject(state.project_root)) return false;

    // Bayatlama kontrolü (YZLLM'in işaret ettiği risk) — görünür, sessiz değil.
    let staleNote = "";
    try {
      const meta = JSON.parse(await fs.readFile(prototypeMetaPath(stack), "utf-8")) as PrototypeMeta;
      if (isStale(meta, Date.now())) {
        const ageDays = Math.floor((Date.now() - meta.createdAt) / (24 * 60 * 60 * 1000));
        staleNote = ` ⚠️ Prototip ${ageDays} günlük (${MAX_AGE_DAYS}+) — bağımlılıklar bayat olabilir; ajan güncellemeli.`;
      }
    } catch {
      /* meta yoksa yaş bilinmez — yine de kopyala (uyarısız) */
    }

    // Cache config-iskelet VEYA (yeşil koşuda kaydedilmişse) TAM çalışan proje içerir → tümünü kopyala,
    // mevcut dosyaları EZME (force:false) → ana ajan üstüne genişletir/yeni gereksinime göre değiştirir.
    await fs.cp(srcDir, state.project_root, { recursive: true, force: false, errorOnExist: false });
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: 5,
      event: "prototype-cache-applied",
      caller: "mycl-orchestrator",
      detail: `stack=${stack}`,
    }).catch(() => {});
    emitChatMessage(
      "system",
      `📦 ${stack} golden prototipi uygulandı — ana ajan sıfırdan değil, doğrulanmış prototip üzerine geliştirecek.${staleNote}`,
    );
    return true;
  } catch (err) {
    log.warn("prototype-cache", "apply failed (non-fatal)", err);
    return false;
  }
}
