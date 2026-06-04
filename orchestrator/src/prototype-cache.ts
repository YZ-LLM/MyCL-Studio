// prototype-cache — stack başına golden scaffold cache (~/.mycl/prototypes/<stack>/).
//
// Vizyon (Ümit): "sağlam + hızlı başlangıç". Bir stack'in projesi pipeline'ı baseline+
// güvenlik YEŞİL geçince (gate-fail yok), MyCL o projenin BASELINE dosyalarını (feature
// kodu HARİÇ — conservative allowlist) golden prototip olarak kaydeder (oto-anlık-görüntü,
// Ümit kararı 2026-06-04). Aynı stack'te yeni greenfield proje Faz 5 başında bu prototipten
// kopyalanır → ana ajan üstüne genişletir (sıfırdan değil).
//
// Bayatlama (Ümit'in işaret ettiği risk): her prototiple `<stack>.meta.json` (createdAt +
// araç sürümü); apply'da MAX_AGE_DAYS'ten eskiyse GÖRÜNÜR uyarı (yine kopyalanır ama
// "taze değil" notu — sessiz değil). Her yeşil koşu prototipi tazeler (overwrite).
//
// Güvenli: snapshot pipeline-end yan-etkisi (ASLA throw etmez); apply yalnız greenfield
// (isExistingProject=false) + stack biliniyor + cache var. Conservative allowlist →
// feature kodu prototipe SIZMAZ (yeni projeleri kirletmez). Çapraz-platform (mac+linux).

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { appendAudit, readAuditLog } from "./audit.js";
import { computeVerdict } from "./harness-verdict.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import { globalConfigFile } from "./paths.js";
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
}

/** SAF: meta MAX_AGE_DAYS'ten eski mi (bayat). now ms epoch. */
export function isStale(meta: PrototypeMeta, now: number, maxAgeDays = MAX_AGE_DAYS): boolean {
  return now - meta.createdAt > maxAgeDays * 24 * 60 * 60 * 1000;
}

function prototypeDir(stack: string): string {
  return globalConfigFile(join("prototypes", stack));
}
function prototypeMetaPath(stack: string): string {
  return globalConfigFile(join("prototypes", `${stack}.meta.json`));
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
 * IMPURE: pipeline-end'de çağrılır. Koşu YEŞİL (gate-fail yok) + stack biliniyorsa,
 * baseline dosyalarını ~/.mycl/prototypes/<stack>/ altına kaydeder (overwrite=tazele) +
 * meta yazar. NON-BLOCKING — asla throw etmez (yan-yarar). Yeşil değilse / stack yoksa no-op.
 */
export async function snapshotPrototype(state: State): Promise<void> {
  try {
    const stack = state.stack;
    if (!stack || stack === "unknown") return;

    // YEŞİL mi? audit'ten gate-fail yok + tamamlandı.
    const events = await readAuditLog(state.project_root);
    const verdict = computeVerdict(events);
    if (!verdict.completed || verdict.gateFailures.length > 0) return; // yalnız doğrulanmış koşu

    const files = await collectBaselineFiles(state.project_root);
    if (files.length === 0) return; // kaydedilecek baseline yok

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
    };
    await fs.mkdir(globalConfigFile("prototypes"), { recursive: true });
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
      `📦 Golden prototip güncellendi (${stack}, ${files.length} baseline dosyası) — bu stack'te sonraki proje buradan hızlı başlar.`,
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
    const stack = state.stack;
    if (!stack || stack === "unknown") return false;
    const srcDir = prototypeDir(stack);
    if (!existsSync(srcDir)) return false; // bu stack için cache yok

    // Yalnız greenfield (mevcut kod yoksa). İterasyon/mevcut projeye uygulama → kirletir.
    if (await isExistingProject(state.project_root)) return false;

    // Bayatlama kontrolü (Ümit'in işaret ettiği risk) — görünür, sessiz değil.
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

    // Cache yalnız baseline içerir (snapshot filtreledi) → tümünü kopyala, mevcut dosyaları EZME.
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
      `📦 ${stack} golden prototipi uygulandı — ana ajan sıfırdan değil, doğrulanmış baseline üzerine geliştirecek.${staleNote}`,
    );
    return true;
  } catch (err) {
    log.warn("prototype-cache", "apply failed (non-fatal)", err);
    return false;
  }
}
