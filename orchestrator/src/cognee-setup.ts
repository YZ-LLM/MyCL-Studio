// cognee-setup — cognee-mcp'yi (topoteretes, Apache-2.0) OTOMATİK kurar (YZLLM 2026-07-13, opt-in, Phase B).
//
// Kalıcı çapraz-oturum bilgi grafiği + vektör hafıza (remember/recall/forget). GÖMÜLÜ backend (SQLite+LanceDB+Kuzu,
// Docker/Postgres YOK); argsız `python server.py` = stdio JSON-RPC MCP server; Claude Code'a --mcp-config ile bağlanır.
// LLM = MyCL'in KENDİ sağlayıcısı (cognee LiteLLM kullanır → Claude "anthropic/<model>" veya z.ai anthropic-base;
// AYRI OpenAI key YOK → "sağlayıcı=kral" korunur). Canlı smoke doğrulandı (2026-07-13): install(uv sync) + stdio +
// remember/recall/forget + gömülü SQLite/Kuzu/LanceDB migration'ları dış servissiz koştu.
//
// AĞIR: PyPI paketi yok → kaynak-klon (PINNED_SHA) + `uv sync --all-extras` (codebase-memory'nin tek npm'inden ağır).
// Ön-koşul: python3 + git + KULLANILABİLİR API key. Salt-abonelik/CLI modunda (oauth, key yok) cognee LLM'i besleyemez
// → görünür fallback (KATI #4 sessiz fallback YOK). Flag-gated: features.cognee_memory (opt-in, default KAPALI).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import { globalConfigDir } from "./paths.js";
import { orchestratorModelId, resolveProvider, type MyclConfig } from "./config.js";

const execFileAsync = promisify(execFile);

/** Pinli cognee commit (canlı smoke doğrulandı 2026-07-13). Güncelleme = yeni SHA'yı gözden geçirip değiştirmek. */
export const COGNEE_PINNED_SHA = "252f2c3efb184533a0955e31e83a28ea7db9813d";
export const COGNEE_REPO = "https://github.com/topoteretes/cognee.git";

/** Per-çağrı benzersiz tmp eki (aynı-süreçte eşzamanlı ensureCognee çakışmasın — BULGU 4 mahkeme). */
let _installSeq = 0;

function installDir(): string { return join(globalConfigDir(), "cognee-src"); }
function mcpDir(): string { return join(installDir(), "cognee-mcp"); }
function venvPython(): string { return join(mcpDir(), ".venv", "bin", "python"); }
function serverPy(): string { return join(mcpDir(), "src", "server.py"); }
function mcpConfigPath(): string { return join(globalConfigDir(), "cognee-mcp-config.json"); }
function dataDir(): string { return join(globalConfigDir(), "cognee-data"); }

/** Kurulu mu (venv python + server.py mevcut). SAF. */
export function resolveCogneeInstalled(): boolean {
  return existsSync(venvPython()) && existsSync(serverPy());
}

/**
 * cognee LLM env'ini MyCL sağlayıcısından türet (LiteLLM anthropic formatı). Kullanılabilir API key yoksa
 * (salt-abonelik/CLI modu) null → cognee kullanılamaz. SAF, test edilebilir.
 */
/** SAF (test edilebilir): apiKey + model + isZai/baseURL → cognee LiteLLM env (anthropic formatı). apiKey yoksa null. */
export function cogneeLlmEnvFromTarget(
  apiKey: string,
  model: string,
  isZai: boolean,
  baseURL?: string,
): Record<string, string> | null {
  if (!apiKey) return null; // salt-abonelik/CLI: gerçek key yok → cognee cognify LLM'ini besleyemez
  const env: Record<string, string> = {
    LLM_API_KEY: apiKey,
    LLM_MODEL: `anthropic/${model}`, // LiteLLM anthropic provider (Claude modeli veya z.ai glm)
  };
  if (isZai && baseURL) env.LLM_ENDPOINT = baseURL; // z.ai anthropic-uyumlu base
  return env;
}

export function buildCogneeLlmEnv(config: MyclConfig): Record<string, string> | null {
  const t = resolveProvider(config, "orchestrator");
  return cogneeLlmEnvFromTarget(t.apiKey, orchestratorModelId(config.selected_models), t.isZai, t.baseURL);
}

/** Proje kökünden kısa deterministik hash (per-proje izole depo dizini). */
function projectHash(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
}

/**
 * Gömülü backend + YEREL embedder env (Docker/Postgres/dış-key YOK). SAF.
 * BULGU 1 (mahkeme): cognify/recall EMBEDDING'i LLM'den AYRI ister; cognee default'u OpenAI (LLM_API_KEY'i embedding'de
 * kullanır → Anthropic/z.ai embeddings API sunmaz → patlar). Fix: YEREL fastembed (ONNX) → dış key YOK ("sağlayıcı=kral").
 * BULGU 2 (mahkeme): DATA_DIRECTORY PROJE-BAZLI izole (global depo çapraz-proje hafıza sızıntısına yol açardı).
 */
export function cogneeEmbeddedEnv(projectRoot: string): Record<string, string> {
  const projData = join(dataDir(), projectHash(projectRoot));
  return {
    DB_PROVIDER: "sqlite",
    VECTOR_DB_PROVIDER: "lancedb",
    GRAPH_DATABASE_PROVIDER: "kuzu",
    EMBEDDING_PROVIDER: "fastembed", // yerel ONNX embedder; model ilk kullanımda indirilir (tek sefer)
    EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5",
    EMBEDDING_DIMENSIONS: "384",
    DATA_DIRECTORY: projData,
    SYSTEM_DIRECTORY: join(projData, "system"),
  };
}

/** MCP config JSON yaz (Claude Code mcpServers; gömülü + LLM env, per-proje). Key yok / kurulu değilse yazmaz (false). */
async function writeCogneeMcpConfig(config: MyclConfig, projectRoot: string): Promise<boolean> {
  const llm = buildCogneeLlmEnv(config);
  if (!llm || !resolveCogneeInstalled()) return false;
  const cfg = {
    mcpServers: {
      cognee: { command: venvPython(), args: [serverPy()], env: { ...cogneeEmbeddedEnv(projectRoot), ...llm } },
    },
  };
  // GÜVENLİK: env içinde LLM_API_KEY (gerçek anahtar) var → dosya 0600 (secrets.json gibi; başkası okuyamasın).
  await writeFile(mcpConfigPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return true;
}

/** python3 + git var mı (execFile --version). Yoksa false + neden. */
async function checkPrereqs(): Promise<{ ok: boolean; missing?: string }> {
  for (const [cmd, args] of [["python3", ["--version"]], ["git", ["--version"]]] as const) {
    try {
      await execFileAsync(cmd, args, { timeout: 15_000 });
    } catch {
      return { ok: false, missing: cmd };
    }
  }
  return { ok: true };
}

/**
 * cognee-mcp yoksa pinli SHA'dan kurar (kaynak-klon + uv sync --all-extras; AĞIR, dakikalar) + MCP config yazar.
 * Idempotent (kurulu → config tazele, return). Non-blocking caller (open_project arka planı). Flag KAPALI → hiç çağrılmaz.
 * Fail-closed (KATI #4): ön-koşul/key/kurulum eksikse GÖRÜNÜR uyarı; cognee bağlanmaz (MyCL mevcut bellek+EDD ile sürer).
 */
export async function ensureCognee(config: MyclConfig, projectRoot: string): Promise<"present" | "installed" | "failed"> {
  // Key ön-kontrolü (kurulumu boşa yapma): salt-abonelik/CLI → cognee cognify LLM'ini besleyemez.
  if (!buildCogneeLlmEnv(config)) {
    emitChatMessage(
      "system",
      "⚠️ cognee açık ama kullanılabilir API anahtarı yok (salt-abonelik/CLI modu) — cognee kalıcı hafızası LLM'e ihtiyaç " +
        "duyar; devre dışı (MyCL mevcut EDD/relevance/karar-hafızasıyla sürer). Claude API veya z.ai anahtarı gir.",
    );
    return "failed";
  }
  if (resolveCogneeInstalled()) {
    await writeCogneeMcpConfig(config, projectRoot).catch((e: unknown) => {
      log.warn("cognee-setup", "mcp-config yazılamadı (present)", e);
      emitChatMessage("system", "⚠️ cognee kurulu ama MCP config yazılamadı (izin/disk?) — bu açılışta bağlanmıyor.");
    });
    return "present";
  }
  const pre = await checkPrereqs();
  if (!pre.ok) {
    emitChatMessage(
      "system",
      `⚠️ cognee kurulamıyor: \`${pre.missing}\` bulunamadı (cognee gömülü Python bilgi-grafiği için gerekli). ` +
        "Kur ve tekrar dene; şimdilik cognee devre dışı (MyCL mevcut hafızayla sürer).",
    );
    return "failed";
  }
  const dir = installDir();
  const tmp = `${dir}.tmp-${process.pid}-${++_installSeq}`;
  try {
    emitChatMessage("system", "🧠 cognee kalıcı hafızası kuruluyor (kaynak + Python bağımlılıkları — birkaç dakika sürebilir)…");
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    // Pinli SHA shallow fetch (skills-setup deseni) — sürpriz upstream yok.
    await execFileAsync("git", ["init", "-q"], { cwd: tmp, timeout: 60_000 });
    await execFileAsync("git", ["remote", "add", "origin", COGNEE_REPO], { cwd: tmp, timeout: 60_000 });
    await execFileAsync("git", ["fetch", "-q", "--depth", "1", "origin", COGNEE_PINNED_SHA], { cwd: tmp, timeout: 300_000 });
    await execFileAsync("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: tmp, timeout: 60_000 });
    // uv yoksa kur (python -m uv ile çağrılır — PATH gerekmez).
    try {
      await execFileAsync("python3", ["-m", "uv", "--version"], { timeout: 15_000 });
    } catch {
      await execFileAsync("python3", ["-m", "pip", "install", "--quiet", "uv"], { timeout: 300_000 });
    }
    // AĞIR: gömülü backend'ler + LiteLLM dahil tüm bağımlılıklar (--all-extras). 10dk tavan.
    await execFileAsync("python3", ["-m", "uv", "sync", "--all-extras"], {
      cwd: join(tmp, "cognee-mcp"),
      timeout: 600_000,
    });
    if (!existsSync(join(tmp, "cognee-mcp", ".venv", "bin", "python"))) {
      throw new Error("uv sync sonrası venv bulunamadı");
    }
    // BULGU 1 (mahkeme): YEREL embedder (fastembed, ONNX) — cognify/recall embedding'i DIŞ KEY'siz. `uv sync --all-extras`
    // bunu içermiyor → venv'e ayrı kur (pyproject'e dokunmadan). Canlı doğrulandı: fastembed 0.8.0 + bge-small-en-v1.5.
    await execFileAsync(
      "python3",
      ["-m", "uv", "pip", "install", "--python", join(tmp, "cognee-mcp", ".venv", "bin", "python"), "fastembed"],
      { cwd: join(tmp, "cognee-mcp"), timeout: 300_000 },
    );
    if (existsSync(dir)) {
      await rm(tmp, { recursive: true, force: true }); // yarış: başka süreç kurmuş
    } else {
      const { rename } = await import("node:fs/promises");
      await rename(tmp, dir);
    }
    await writeCogneeMcpConfig(config, projectRoot);
    emitChatMessage(
      "system",
      `🧠 cognee kalıcı hafızası kuruldu (pin: ${COGNEE_PINNED_SHA.slice(0, 7)}, gömülü SQLite+Kuzu+LanceDB, LLM=senin ` +
        "sağlayıcın) — codegen ajanına remember/recall/forget bağlanıyor.",
    );
    log.info("cognee-setup", "installed", { dir, sha: COGNEE_PINNED_SHA });
    return "installed";
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    log.warn("cognee-setup", "kurulamadı (görünür uyarı)", e);
    emitChatMessage(
      "system",
      "⚠️ cognee otomatik kurulamadı (ağ/python/uv sorunu olabilir) — cognee devre dışı, MyCL mevcut hafızayla sürer. " +
        `Detay log'da. Elle: \`git clone ${COGNEE_REPO} && cd cognee/cognee-mcp && uv sync --all-extras\``,
    );
    return "failed";
  }
}

/**
 * IMPURE (buildArgs'tan): flag AÇIK + kurulu + config yazılı ise MCP config yolunu döndür → --mcp-config'e verilir.
 * Flag KAPALI / kurulu değil / config yok → null (bağlanmaz). SAF (varlık + flag).
 */
export function resolveCogneeMcpConfig(config: MyclConfig): string | null {
  if (!config.features.cognee_memory) return null;
  if (!resolveCogneeInstalled()) return null;
  // BULGU 3 (mahkeme): kullanılabilir anahtar YOKKEN bağlama — anahtar sonradan kaldırılsa bile diskteki bayat config
  // (eski anahtarla) wire edilmesin (ensure "devre dışı" uyarısıyla tutarlı). Anahtar varlığını canlı kontrol et.
  if (!buildCogneeLlmEnv(config)) return null;
  const p = mcpConfigPath();
  return existsSync(p) ? p : null;
}
