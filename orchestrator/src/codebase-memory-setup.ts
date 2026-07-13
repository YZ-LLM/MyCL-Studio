// codebase-memory-setup — codebase-memory-mcp'yi (DeusData, MIT) OTOMATİK kurar (YZLLM 2026-07-13, opt-in).
//
// Hedef-proje YAPISAL bilgi grafiği (158 tree-sitter grammar + 12 dil LSP tip çözümü): codegen/EDD ajanları grep
// yerine deterministik yapısal olguları (çağrı-zinciri/import/route/ölü-kod) sorgular → dosya-dosya aramaya göre
// ~%99 token tasarrufu. codebase-memory-mcp argsız çalışınca stdio JSON-RPC MCP server'dır; Claude Code CLI'ye
// `--mcp-config <json>` ile bağlanır. Repo başlangıçta belirtilmez → ajan `index_repository(repo_path)` ile indeksler.
//
// Supply-chain: top-level PINNED_VERSION + npm registry integrity (o tarball'ı korur). DÜRÜST NOT: skills-setup'ın
// git-SHA checkout'undan DAHA ZAYIF garanti — (a) lockfile yok → geçişli bağımlılıklar pinli DEĞİL (kurulum anında
// en-son-uyan sürüme çözülür); (b) postinstall lifecycle script'leri kurulumda (flag açıkken) tam yetkiyle çalışır —
// codebase-memory-mcp platform binary'sini fetch/derleme için buna İHTİYAÇ duyabilir → `--ignore-scripts` bilinçli
// EKLENMEDİ (aksi binary kurulmaz). Kabul edilen tradeoff (MIT + vetted paket, opt-in default-kapalı).
// Fail-closed (KATI #4): kurulamaz/eksikse görünür uyarı + --mcp-config EKLENMEZ → ajanlar grep-tabanlı keşfe düşer.
// Flag-gated: features.codebase_memory_mcp (opt-in, default KAPALI — dış bağımlılık, kullanıcı=kral, advisor precedent'i).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import { globalConfigDir } from "./paths.js";
import type { MyclConfig } from "./config.js";

const execFileAsync = promisify(execFile);

/** Pinli versiyon (npm `codebase-memory-mcp`, MIT). Güncelleme = yeni versiyonu gözden geçirip burayı değiştirmek. */
export const CODEBASE_MEMORY_PINNED_VERSION = "0.9.0";

/** Yerel kurulum dizini (global/sudo YOK — npm --prefix). */
function installDir(): string {
  return join(globalConfigDir(), "codebase-memory");
}

/** Kurulu binary yolu (npm --prefix local install → node_modules/.bin). Yoksa null. SAF (varlık kontrolü). */
export function resolveCodebaseMemoryBinary(): string | null {
  const bin = join(installDir(), "node_modules", ".bin", "codebase-memory-mcp");
  return existsSync(bin) ? bin : null;
}

/** Deterministik MCP config JSON yolu. */
function mcpConfigPath(): string {
  return join(installDir(), "mcp-config.json");
}

/** MCP config JSON yaz (Claude Code mcpServers şeması). Binary yoksa yazmaz (no-op). */
async function writeMcpConfig(): Promise<void> {
  const bin = resolveCodebaseMemoryBinary();
  if (!bin) return;
  const cfg = { mcpServers: { "codebase-memory": { command: bin, args: [] as string[] } } };
  await writeFile(mcpConfigPath(), JSON.stringify(cfg, null, 2));
}

/**
 * codebase-memory-mcp yoksa pinli versiyondan kurar (idempotent; varsa config'i tazeleyip no-op) + MCP config yazar.
 * Non-blocking caller (open_project arka planı); başarı/başarısızlık chat'te görünür. Flag KAPALI → hiç çağrılmaz.
 */
export async function ensureCodebaseMemoryMcp(): Promise<"present" | "installed" | "failed"> {
  if (resolveCodebaseMemoryBinary()) {
    // config tazele (idempotent; binary yolu değişmiş olabilir). Hata → GÖRÜNÜR uyar (sessiz yutma YOK, KATI #4):
    // yazılamazsa resolveCodebaseMemoryMcpConfig null döner → --mcp-config eklenmez (grep fallback), kullanıcı bilsin.
    await writeMcpConfig().catch((e: unknown) => {
      log.warn("codebase-memory-setup", "mcp-config yazılamadı (present dalı)", e);
      emitChatMessage(
        "system",
        "⚠️ codebase-memory-mcp kurulu ama MCP config yazılamadı (izin/disk?) — bu açılışta grep fallback; sonraki açılışta yeniden denenir.",
      );
    });
    return "present";
  }
  const dir = installDir();
  try {
    await mkdir(dir, { recursive: true });
    // Yerel kurulum (global/sudo YOK): <dir>/node_modules/.bin/codebase-memory-mcp. npm registry integrity = checksum.
    await execFileAsync(
      "npm",
      ["install", "--prefix", dir, "--no-audit", "--no-fund", `codebase-memory-mcp@${CODEBASE_MEMORY_PINNED_VERSION}`],
      { timeout: 300_000 },
    );
    if (!resolveCodebaseMemoryBinary()) throw new Error("kurulum sonrası binary bulunamadı");
    await writeMcpConfig();
    emitChatMessage(
      "system",
      `🔌 codebase-memory-mcp kuruldu (pin: v${CODEBASE_MEMORY_PINNED_VERSION}) — codegen ajanlarına \`--mcp-config\` ile ` +
        "bağlanıyor (yapısal kod grafiği; grep yerine ucuz sorgu).",
    );
    log.info("codebase-memory-setup", "installed", { dir, version: CODEBASE_MEMORY_PINNED_VERSION });
    return "installed";
  } catch (e) {
    log.warn("codebase-memory-setup", "kurulamadı (görünür uyarı)", e);
    emitChatMessage(
      "system",
      "⚠️ codebase-memory-mcp otomatik kurulamadı (ağ/npm sorunu olabilir) — ajanlar grep-tabanlı keşfe devam eder. " +
        `Elle: \`npm install -g codebase-memory-mcp@${CODEBASE_MEMORY_PINNED_VERSION}\``,
    );
    return "failed";
  }
}

/**
 * IMPURE (cli-backend buildArgs'tan çağrılır): flag AÇIK + binary kurulu + config yazılı ise MCP config yolunu döndür
 * → `--mcp-config`'e verilir. Flag KAPALI / binary yok / config yok → null (--mcp-config EKLENMEZ; ajan grep'e düşer;
 * görünür uyarı ensure aşamasında verildi). SAF (yalnız varlık kontrolü + flag okuma).
 */
export function resolveCodebaseMemoryMcpConfig(config: MyclConfig): string | null {
  if (!config.features.codebase_memory_mcp) return null;
  if (!resolveCodebaseMemoryBinary()) return null;
  const p = mcpConfigPath();
  return existsSync(p) ? p : null;
}
