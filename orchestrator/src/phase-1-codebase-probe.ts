// phase-1-codebase-probe — Pre-Phase-1 deterministic codebase snapshot.
//
// v15.7 (2026-05-27): Kullanıcı kuralı: "uygulamada ne var ne yok bilmeli.
// bana sormasın."
//
// Phase 1 ana ajan tool seti askq + approve ile sınırlı (Read/Grep YOK).
// Ajan dosya yapısını göremezse "frontend mi backend mi eksik?" gibi
// kullanıcıya zaten yanıtı kodda olan sorular sorar — UX kaybı.
//
// Çözüm: Pre-Phase-1 hook deterministik snapshot üretir (top-level dirs +
// src tree + package.json deps + frontend/backend route hint'leri) ve
// template'e enjekte edilir. Ajan WHAT-user-wants sorgusuna odaklanır;
// WHICH-files-exist asla sormaz.
//
// Akış:
//   1. project_root altı top-level dirs (1 seviye, gizli yok)
//   2. package.json (varsa) — deps + scripts özet
//   3. src/ varsa içeriği 2 seviye derinlik
//   4. frontend/ + backend/ + server/ + api/ varsa 1 seviye listele
//   5. Route hint: backend için *.ts/*.js içinde app|router.\w+ pattern;
//      frontend için *.tsx/*.jsx içinde <Route ... path= pattern
//   6. Format: markdown blok, ~3KB token cap
//
// Boş/erişilemez proje root durumunda kısa "(empty project)" sentinel döner.
// Hiç crash etmez — fail-safe.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.js";

const MAX_OUTPUT_CHARS = 3500;
const TOP_LEVEL_DIR_LIMIT = 25;
const SRC_TREE_DIR_LIMIT = 40;
const FILES_PER_DIR_LIMIT = 8;
const ROUTE_HINT_LIMIT = 12;

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".mycl",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  ".vscode",
  ".idea",
  "coverage",
  "target",
  "__pycache__",
  ".venv",
  "venv",
]);

const FRONTEND_DIRS = ["frontend", "client", "web", "ui", "app"];
const BACKEND_DIRS = ["backend", "server", "api"];

interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function safeReaddir(
  dir: string,
): Promise<Array<{ name: string; isDir: boolean }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith("."))
      .filter((e) => !IGNORE_DIRS.has(e.name))
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
}

async function safeReadJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function listTopLevel(projectRoot: string): Promise<string[]> {
  const entries = await safeReaddir(projectRoot);
  const dirs = entries.filter((e) => e.isDir).map((e) => `${e.name}/`);
  const files = entries.filter((e) => !e.isDir).map((e) => e.name);
  return [...dirs, ...files].slice(0, TOP_LEVEL_DIR_LIMIT);
}

async function summarizePackageJson(projectRoot: string): Promise<string | null> {
  const pkg = await safeReadJson<PackageJson>(join(projectRoot, "package.json"));
  if (!pkg) return null;
  const lines: string[] = [];
  if (pkg.name) lines.push(`name: ${pkg.name}`);
  const scripts = pkg.scripts ?? {};
  const scriptKeys = Object.keys(scripts);
  if (scriptKeys.length > 0) {
    lines.push(`scripts: ${scriptKeys.slice(0, 10).join(", ")}`);
  }
  const deps = Object.keys(pkg.dependencies ?? {});
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  if (deps.length > 0) {
    lines.push(`dependencies (${deps.length}): ${deps.slice(0, 20).join(", ")}`);
  }
  if (devDeps.length > 0) {
    lines.push(
      `devDependencies (${devDeps.length}): ${devDeps.slice(0, 15).join(", ")}`,
    );
  }
  return lines.join("\n");
}

async function listDirTree(
  rootDir: string,
  relPath: string,
  depth: number,
  maxDepth: number,
  budget: { remaining: number },
): Promise<string[]> {
  if (depth > maxDepth || budget.remaining <= 0) return [];
  const here = relPath ? join(rootDir, relPath) : rootDir;
  const entries = await safeReaddir(here);
  const lines: string[] = [];
  let fileCount = 0;
  for (const e of entries) {
    if (budget.remaining <= 0) break;
    const indent = "  ".repeat(depth);
    if (e.isDir) {
      lines.push(`${indent}${e.name}/`);
      budget.remaining--;
      const child = await listDirTree(
        rootDir,
        relPath ? `${relPath}/${e.name}` : e.name,
        depth + 1,
        maxDepth,
        budget,
      );
      lines.push(...child);
    } else if (fileCount < FILES_PER_DIR_LIMIT) {
      lines.push(`${indent}${e.name}`);
      budget.remaining--;
      fileCount++;
    }
  }
  return lines;
}

async function detectFrontendBackend(
  projectRoot: string,
): Promise<{ frontend: string | null; backend: string | null }> {
  const entries = await safeReaddir(projectRoot);
  const dirNames = entries.filter((e) => e.isDir).map((e) => e.name);
  const frontend = FRONTEND_DIRS.find((d) => dirNames.includes(d)) ?? null;
  const backend = BACKEND_DIRS.find((d) => dirNames.includes(d)) ?? null;
  return { frontend, backend };
}

const BACKEND_ROUTE_RE = /\b(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const FRONTEND_ROUTE_RE = /<Route[^>]*\bpath\s*=\s*['"`]([^'"`]+)['"`]/g;

async function walkForRoutes(
  dir: string,
  extensions: Set<string>,
  collector: (filePath: string, content: string) => void,
  budget: { filesRead: number },
  maxFiles = 60,
): Promise<void> {
  if (budget.filesRead >= maxFiles) return;
  const entries = await safeReaddir(dir);
  for (const e of entries) {
    if (budget.filesRead >= maxFiles) return;
    const full = join(dir, e.name);
    if (e.isDir) {
      await walkForRoutes(full, extensions, collector, budget, maxFiles);
    } else {
      const dot = e.name.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = e.name.slice(dot);
      if (!extensions.has(ext)) continue;
      try {
        const content = await fs.readFile(full, "utf-8");
        collector(full, content);
        budget.filesRead++;
      } catch {
        // unreadable — skip
      }
    }
  }
}

async function detectBackendRoutes(rootDir: string): Promise<string[]> {
  const routes: string[] = [];
  const seen = new Set<string>();
  const budget = { filesRead: 0 };
  await walkForRoutes(
    rootDir,
    new Set([".ts", ".js", ".mjs", ".cjs"]),
    (_path, content) => {
      let m: RegExpExecArray | null;
      while ((m = BACKEND_ROUTE_RE.exec(content)) !== null) {
        const verb = m[1]?.toUpperCase();
        const path = m[2];
        const key = `${verb} ${path}`;
        if (!seen.has(key) && verb && path) {
          seen.add(key);
          routes.push(key);
          if (routes.length >= ROUTE_HINT_LIMIT) break;
        }
      }
      BACKEND_ROUTE_RE.lastIndex = 0;
    },
    budget,
  );
  return routes;
}

async function detectFrontendRoutes(rootDir: string): Promise<string[]> {
  const routes: string[] = [];
  const seen = new Set<string>();
  const budget = { filesRead: 0 };
  await walkForRoutes(
    rootDir,
    new Set([".tsx", ".jsx"]),
    (_path, content) => {
      let m: RegExpExecArray | null;
      while ((m = FRONTEND_ROUTE_RE.exec(content)) !== null) {
        const path = m[1];
        if (path && !seen.has(path)) {
          seen.add(path);
          routes.push(path);
          if (routes.length >= ROUTE_HINT_LIMIT) break;
        }
      }
      FRONTEND_ROUTE_RE.lastIndex = 0;
    },
    budget,
  );
  return routes;
}

/**
 * Build a deterministic, markdown-formatted codebase snapshot. Always
 * returns a usable string (never throws). When the project is empty/new
 * or the root is unreadable, returns a clear sentinel block.
 */
export async function buildCodebaseSnapshot(
  projectRoot: string,
): Promise<string> {
  const start = Date.now();
  try {
    const topLevel = await listTopLevel(projectRoot);
    if (topLevel.length === 0) {
      return "## Codebase snapshot\n\n_(empty project — no files yet)_";
    }

    const sections: string[] = ["## Codebase snapshot", ""];
    sections.push("**Top-level:** " + topLevel.join(", "));
    sections.push("");

    const pkgSummary = await summarizePackageJson(projectRoot);
    if (pkgSummary) {
      sections.push("**package.json:**", "```", pkgSummary, "```", "");
    }

    const srcDir = join(projectRoot, "src");
    if (await dirExists(srcDir)) {
      const budget = { remaining: SRC_TREE_DIR_LIMIT };
      const tree = await listDirTree(srcDir, "", 0, 2, budget);
      if (tree.length > 0) {
        sections.push("**src/ tree:**", "```", "src/", ...tree, "```", "");
      }
    }

    const { frontend, backend } = await detectFrontendBackend(projectRoot);
    if (frontend) {
      const dir = join(projectRoot, frontend);
      const budget = { remaining: SRC_TREE_DIR_LIMIT };
      const tree = await listDirTree(dir, "", 0, 1, budget);
      if (tree.length > 0) {
        sections.push(
          `**${frontend}/ tree:**`,
          "```",
          `${frontend}/`,
          ...tree,
          "```",
          "",
        );
      }
      const routes = await detectFrontendRoutes(dir);
      if (routes.length > 0) {
        sections.push(
          "**Frontend routes (detected):** " + routes.join(", "),
          "",
        );
      }
    }
    if (backend) {
      const dir = join(projectRoot, backend);
      const budget = { remaining: SRC_TREE_DIR_LIMIT };
      const tree = await listDirTree(dir, "", 0, 1, budget);
      if (tree.length > 0) {
        sections.push(
          `**${backend}/ tree:**`,
          "```",
          `${backend}/`,
          ...tree,
          "```",
          "",
        );
      }
      const routes = await detectBackendRoutes(dir);
      if (routes.length > 0) {
        sections.push("**Backend routes (detected):**", "```");
        for (const r of routes) sections.push(r);
        sections.push("```", "");
      }
    } else {
      // Root-level backend route detection (no backend/ subdir)
      const routes = await detectBackendRoutes(projectRoot);
      if (routes.length > 0) {
        sections.push("**Backend routes (detected at root):**", "```");
        for (const r of routes) sections.push(r);
        sections.push("```", "");
      }
    }

    let out = sections.join("\n").trim();
    if (out.length > MAX_OUTPUT_CHARS) {
      out = out.slice(0, MAX_OUTPUT_CHARS) + "\n\n_(snapshot truncated)_";
    }
    log.info("phase-1-codebase-probe", "snapshot built", {
      chars: out.length,
      ms: Date.now() - start,
    });
    return out;
  } catch (err) {
    log.warn("phase-1-codebase-probe", "snapshot failed", err);
    return "## Codebase snapshot\n\n_(snapshot unavailable — proceed without it)_";
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await fs.stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await fs.stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Bilinen proje manifest dosyaları (çok dilli). */
const PROJECT_MANIFESTS = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "setup.py",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Package.swift",
  "mix.exs",
  "Gemfile",
  "composer.json",
];

/** Bilinen kaynak dizinleri. */
const SOURCE_DIRS = ["src", "app", "lib", "backend", "frontend", "server", "pkg", "cmd"];

/**
 * Proje MEVCUT KOD içeriyor mu? Tamamen DETERMİNİSTİK (dosya sistemi; LLM ve
 * relevance engine YOK). `.mycl/spec.md`, bilinen bir manifest dosyası veya
 * kaynak dizini varsa true. Relevance engine boş dönse bile (bu niyet için
 * indekslenmiş MyCL bağlamı yokken) projenin gerçekten boş olup olmadığını
 * ayırt eder → greenfield false-positive'ini (mevcut kodu "fresh project"
 * sanma) engeller. Fail-safe: erişim hatası → false (boş varsay).
 */
export async function isExistingProject(projectRoot: string): Promise<boolean> {
  if (await fileExists(join(projectRoot, ".mycl", "spec.md"))) return true;
  for (const m of PROJECT_MANIFESTS) {
    if (await fileExists(join(projectRoot, m))) return true;
  }
  for (const d of SOURCE_DIRS) {
    if (await dirExists(join(projectRoot, d))) return true;
  }
  return false;
}

// .mycl (MyCL state) + devs (spec çalışma alanı) + ASLA-deliverable-olmayan türetilen/cache dizinleri.
// NOT (mahkeme): dist/build/out BİLEREK ÇIKARILDI — bunlar gerçek bir çıktı/deliverable dizini OLABİLİR
// (ör. Go `-o out/`, statik `dist/`), blocklist'te false-fail üretirler. Boş-build'de zaten hiçbiri yok
// (yalnız .mycl+devs) → çıkarmak guard'ı zayıflatmaz, yalnız dist-only gerçek build'i yanlış-FAIL'den korur.
const NON_DELIVERABLE_TOP = new Set([
  "devs", "node_modules", "coverage", "error_folder", ".turbo", ".cache", ".vite",
]);

/**
 * Proje GERÇEK bir deliverable (üretilmiş uygulama/kaynak dosyası) içeriyor mu? `isExistingProject`'ten
 * FARKLI: o `.mycl/spec.md` (MyCL metadata) varlığında bile true döner → boş-build'i (Faz 5 yanlış atlandı,
 * hiç kod üretilmedi) "var" sanar. Bu ise YALNIZ gerçek dosyaya bakar: .mycl/devs/türetilen-dizinler DIŞINDA
 * görünür (nokta-olmayan) bir top-level girdi varsa true. STACK-BAĞIMSIZ (framework/manifest varsaymaz).
 * Boş-build sahte-yeşil koruması için: deliverable yoksa koşu YEŞİL sayılamaz. Fail-safe: erişim hatası →
 * TRUE (okunamayan dizinde gerçek build'i yanlışlıkla FAIL etme; guard yalnız BARİZ boş projeyi yakalar).
 */
export async function hasDeliverable(projectRoot: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(projectRoot, { withFileTypes: true });
    return entries.some((e) => !e.name.startsWith(".") && !NON_DELIVERABLE_TOP.has(e.name));
  } catch (e) {
    log.warn("phase-1-probe", "hasDeliverable: proje kökü okunamadı → true (boş-build guard'ı atlanır)", { error: String(e) });
    return true;
  }
}
