// project-facts — projenin TEMEL gerçekleri (dil JS/TS, framework, ana config'ler, paket yöneticisi).
//
// Ümit (2026-06-10): MyCL "salak" davrandı çünkü ajanlara projenin temel doğası verilmiyordu — örn. hata-analizi
// ajanı "tsconfig yok" görüp "tsconfig oluştur" dedi; projenin JS olduğunu BİLMİYORDU. detectStack ise yalnız
// "node-npm" döndürüyor (JS/TS ayırmıyor). Bu modül ucuz + deterministik proje-gerçekleri çıkarır ve HER ajan
// promptuna enjekte edilebilen kısa bir özet üretir. "Proje bilgisini cömertçe ver → daha iyi yanıt."

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ProjectFacts {
  language: "typescript" | "javascript" | "mixed" | "unknown";
  hasTsconfig: boolean;
  framework: string; // "vite" | "next" | "react" | "express" | ... | "unknown"
  packageManager: "npm" | "yarn" | "pnpm" | "bun" | "unknown";
  /** Ajan promptuna enjekte edilecek tek-paragraf özet (İngilizce — ana ajan İngilizce çalışır). */
  summary: string;
}

/** package.json deps+devDeps'ten framework + TS sinyali. */
function frameworkFromDeps(deps: Record<string, string>): { framework: string; tsDep: boolean } {
  const has = (n: string) => Object.prototype.hasOwnProperty.call(deps, n);
  const tsDep = has("typescript");
  let framework = "unknown";
  // Sıra önemli: en spesifik framework önce.
  if (has("next")) framework = "next";
  else if (has("vite")) framework = "vite";
  else if (has("react-scripts")) framework = "create-react-app";
  else if (has("@angular/core")) framework = "angular";
  else if (has("vue")) framework = "vue";
  else if (has("svelte")) framework = "svelte";
  else if (has("express")) framework = "express";
  else if (has("fastify")) framework = "fastify";
  else if (has("react")) framework = "react";
  return { framework, tsDep };
}

function detectPackageManager(projectRoot: string): ProjectFacts["packageManager"] {
  if (existsSync(join(projectRoot, "bun.lockb"))) return "bun";
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectRoot, "yarn.lock"))) return "yarn";
  if (existsSync(join(projectRoot, "package-lock.json"))) return "npm";
  return "unknown";
}

/** src/ (yoksa kök) altındaki ilk ~200 dosyada .ts/.tsx vs .js/.jsx sayımı → dil kararı. */
async function countSourceLangs(projectRoot: string): Promise<{ ts: number; js: number }> {
  let ts = 0;
  let js = 0;
  const roots = [join(projectRoot, "src"), join(projectRoot, "app"), projectRoot];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (/\.tsx?$/.test(e) && !e.endsWith(".d.ts")) ts++;
      else if (/\.jsx?$/.test(e)) js++;
    }
    if (ts + js >= 5) break; // yeterli sinyal
  }
  return { ts, js };
}

/**
 * Projenin temel gerçeklerini çıkarır. Fail-safe: okunamayan alan "unknown"/false. SAF değil (dosya okur) ama
 * deterministik + ucuz (package.json + lockfile + birkaç dizin listesi).
 */
export async function buildProjectFacts(projectRoot: string): Promise<ProjectFacts> {
  const hasTsconfig = existsSync(join(projectRoot, "tsconfig.json"));
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    // package.json yok/bozuk → deps boş
  }
  const { framework, tsDep } = frameworkFromDeps(deps);
  const { ts, js } = await countSourceLangs(projectRoot);

  let language: ProjectFacts["language"] = "unknown";
  if (hasTsconfig || tsDep) language = ts > 0 && js > ts ? "mixed" : "typescript";
  else if (js > 0 && ts === 0) language = "javascript";
  else if (ts > 0 && js === 0) language = "typescript";
  else if (ts > 0 || js > 0) language = ts >= js ? "typescript" : "javascript";

  const packageManager = detectPackageManager(projectRoot);

  const summary =
    `Project facts (detected): language=${language}` +
    `${hasTsconfig ? "" : " (NO tsconfig.json — do NOT assume TypeScript tooling applies)"}` +
    `, framework=${framework}, packageManager=${packageManager}.` +
    (language === "javascript"
      ? " This is a JavaScript project — TypeScript-only tools (tsc, ts-prune, ts-morph) are NOT applicable; do not add a tsconfig or TS tooling unless the user explicitly asks."
      : "");

  return { language, hasTsconfig, framework, packageManager, summary };
}
