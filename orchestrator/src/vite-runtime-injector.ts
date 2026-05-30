// vite-runtime-injector — Kullanıcı projesindeki Vite config'e MyCL'in
// runtime-error plugin'ini idempotent şekilde ekler. Spawn etmek üzere
// olan dev server'a hazırlık yapar: 1) plugin'i `.mycl/` klasörüne
// kopyala, 2) `.gitignore`'a satır ekle, 3) vite.config.{ts,js,mjs,cjs}'i
// minimal şekilde edit et (import + plugins[] içine push).
//
// Tek bir Vite stack için tasarlandı; başka build tool'lar (Next.js,
// Webpack, Remix) için ileride genişletilebilir. Bulamazsa graceful skip
// (chat'e bilgi mesajı emit etmez, sessiz no-op).

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";
import { getRuntimeHttpPort } from "./runtime-http-server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ASSET = join(
  __dirname,
  "..",
  "..",
  "assets",
  "scripts",
  "mycl-runtime-error-plugin.cjs",
);

const MARKER_BEGIN = "/* mycl-runtime-injector: begin */";
const MARKER_END = "/* mycl-runtime-injector: end */";

const VITE_CONFIG_NAMES = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
];

const FRONTEND_SUBDIRS = ["", "frontend", "client", "ui", "apps/web"];

/**
 * Kullanıcı projesinde dev server spawn edilmeden ÖNCE çağrılır. Vite
 * config'i bulup MyCL plugin import'unu ekler. İkinci çağrıda no-op
 * (idempotent). Vite stack bulunamazsa hiçbir şey yapmaz.
 */
export async function ensureViteRuntimeInjection(projectRoot: string): Promise<{
  injected: boolean;
  configPath: string | null;
}> {
  const configPath = await findViteConfig(projectRoot);
  if (!configPath) {
    log.info("vite-injector", "no vite config — skip", { projectRoot });
    return { injected: false, configPath: null };
  }

  // 1) Plugin dosyasını projenin .mycl/'ine kopyala (idempotent: aynı içerikse skip).
  const targetPluginPath = join(projectRoot, ".mycl", "runtime-error-plugin.cjs");
  let pluginSource: string;
  try {
    pluginSource = await fs.readFile(PLUGIN_ASSET, "utf-8");
  } catch (err) {
    log.warn("vite-injector", "plugin asset not found", err);
    return { injected: false, configPath };
  }
  // v15.2 Core: port placeholder substitution. runtime-http-server boot'ta
  // 9273-9299 aralığında ilk müsait portu bind eder; plugin'in browser
  // script'i bu portu kullanmalı. activePort henüz set değilse fallback 9273
  // (single-instance backward-compat).
  const runtimePort = getRuntimeHttpPort() ?? 9273;
  pluginSource = pluginSource.replace(
    /\{\{MYCL_RUNTIME_PORT\}\}/g,
    String(runtimePort),
  );
  try {
    await fs.mkdir(join(projectRoot, ".mycl"), { recursive: true });
    let existing = "";
    try {
      existing = await fs.readFile(targetPluginPath, "utf-8");
    } catch {
      // dosya yok — yazılacak
    }
    if (existing !== pluginSource) {
      await fs.writeFile(targetPluginPath, pluginSource, "utf-8");
      log.info("vite-injector", "plugin copied", { targetPluginPath });
    }
  } catch (err) {
    log.warn("vite-injector", "plugin copy failed", err);
    return { injected: false, configPath };
  }

  // 2) .gitignore'a `.mycl/` ekle (yoksa)
  await appendGitignoreEntry(projectRoot, ".mycl/");

  // 3) vite.config.*'i edit et — idempotent marker ile.
  let configContent = "";
  try {
    configContent = await fs.readFile(configPath, "utf-8");
  } catch (err) {
    log.warn("vite-injector", "config read failed", err);
    return { injected: false, configPath };
  }

  if (configContent.includes(MARKER_BEGIN)) {
    // Zaten enjekte edilmiş — no-op
    return { injected: true, configPath };
  }

  // Config dosyasının konumuna göre plugin path'i relatif yap (config'in
  // bulunduğu dizinden .mycl/'e göre).
  const configDir = dirname(configPath);
  const projectAbs = projectRoot.replace(/\/+$/, "");
  const configDirAbs = configDir.replace(/\/+$/, "");
  const relToProject = configDirAbs === projectAbs
    ? "."
    : configDirAbs.startsWith(projectAbs + "/")
      ? "..".repeat(configDirAbs.slice(projectAbs.length + 1).split("/").length)
      : ".";
  const pluginRequirePath = relToProject === "."
    ? "./.mycl/runtime-error-plugin.cjs"
    : `${relToProject}/.mycl/runtime-error-plugin.cjs`;

  const isTs = configPath.endsWith(".ts");
  const isCjs = configPath.endsWith(".cjs");
  const importLine = isCjs
    ? `const myclRuntimeErrorPlugin = require(${JSON.stringify(pluginRequirePath)});`
    : `import myclRuntimeErrorPlugin from ${JSON.stringify(pluginRequirePath)};`;

  // Strateji: dosyanın en üstüne marker + import; defineConfig içinde
  // plugins[] array'i regex ile bul, içine `myclRuntimeErrorPlugin()`
  // push et. Regex fail ederse graceful skip (mesaj log'a düşer).
  const importBlock = `${MARKER_BEGIN}\n${importLine}\n${MARKER_END}\n`;

  const pluginsArrayRe = /plugins\s*:\s*\[/;
  const match = configContent.match(pluginsArrayRe);
  if (!match) {
    log.warn("vite-injector", "plugins array not found in config — skip edit", {
      configPath,
    });
    // En azından import ekle; kullanıcı manuel plugin çağırabilir
    return { injected: false, configPath };
  }
  const insertAt = (match.index ?? 0) + match[0].length;
  const newConfig =
    importBlock +
    configContent.slice(0, insertAt) +
    `myclRuntimeErrorPlugin(), ${MARKER_END} ` +
    configContent.slice(insertAt);

  // Suppress unused warning for isTs (kept for future TS-specific handling)
  void isTs;

  try {
    await fs.writeFile(configPath, newConfig, "utf-8");
    log.info("vite-injector", "vite config injected", { configPath });
    return { injected: true, configPath };
  } catch (err) {
    log.warn("vite-injector", "config write failed", err);
    return { injected: false, configPath };
  }
}

async function findViteConfig(projectRoot: string): Promise<string | null> {
  for (const sub of FRONTEND_SUBDIRS) {
    const base = sub ? join(projectRoot, sub) : projectRoot;
    for (const name of VITE_CONFIG_NAMES) {
      const candidate = join(base, name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // try next
      }
    }
  }
  return null;
}

async function appendGitignoreEntry(
  projectRoot: string,
  entry: string,
): Promise<void> {
  const giPath = join(projectRoot, ".gitignore");
  let current = "";
  try {
    current = await fs.readFile(giPath, "utf-8");
  } catch {
    // yok — oluşturulacak
  }
  const lines = current.split("\n").map((l) => l.trim());
  if (lines.includes(entry) || lines.includes(entry.replace(/\/$/, ""))) return;
  const next = current.length === 0
    ? `${entry}\n`
    : current.endsWith("\n")
      ? `${current}${entry}\n`
      : `${current}\n${entry}\n`;
  try {
    await fs.writeFile(giPath, next, "utf-8");
  } catch (err) {
    log.warn("vite-injector", ".gitignore write failed", err);
  }
}
