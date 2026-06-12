// claude-updater — MyCL açılışında claude CLI'yı OTOMATİK günceller (Ümit isteği:
// "mycl studio her açıldığında güncellesin otomatik"). Non-blocking (boot'u geciktirmez),
// feature-flag'li (default açık), görünür (yalnız gerçekten güncellenince mesaj), hata yutulur.
// `claude update` resmi + güvenli bir işlemdir (agent-skills auto-clone gibi supply-chain riski yok).

import { spawn } from "node:child_process";
import { claudeSpawnEnv, resolveClaudePath } from "./codegen/cli-backend.js";
import { wrapReadOnlyClaude } from "./claude-folder-guard.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";

export type UpdateOutcome = "updated" | "current" | "failed";

/**
 * `claude update` çıktısını yorumla. SAF (test edilebilir). exit!=0 → failed; "up to date"/
 * "already"/"güncel" → current; "updated"/"success"/"güncellendi" → updated; exit 0 ama belirsiz
 * → current (güvenli varsayım, yanlış "güncellendi" mesajı verme).
 */
export function interpretUpdateOutput(code: number | null, out: string): UpdateOutcome {
  if (code !== 0) return "failed";
  const t = out.toLowerCase();
  if (t.includes("up to date") || t.includes("already") || t.includes("güncel")) return "current";
  if (t.includes("updated") || t.includes("success") || t.includes("güncellendi")) return "updated";
  return "current";
}

const UPDATE_TIMEOUT_MS = 60_000;

/**
 * Açılışta çağrılır (App.start, non-blocking `void`). Feature flag kapalıysa veya claude yoksa
 * sessizce atlar. Güncelleme olursa görünür mesaj; "zaten güncel" yalnız log. Hata → log + yut
 * (boot'u ASLA bozma).
 */
export async function autoUpdateClaude(): Promise<void> {
  // Test / CI / harness ortamında ASLA çalıştırma — yan etki (gerçek `claude update` spawn'ı)
  // + non-determinizm. VITEST/CI bayrakları + açık MYCL_DISABLE_AUTO_UPDATE override.
  if (
    process.env.VITEST ||
    process.env.CI ||
    process.env.NODE_ENV === "test" ||
    process.env.MYCL_DISABLE_AUTO_UPDATE
  ) {
    return;
  }
  try {
    const { readFeatures } = await import("./config.js");
    const features = await readFeatures();
    if (features.auto_update_claude === false) return; // kullanıcı açıkça kapatmış
  } catch {
    // config okunamadı → yine de dene (default açık).
  }

  const claudeBin = resolveClaudePath();
  if (!claudeBin) {
    log.info("claude-updater", "claude bulunamadı — oto-güncelleme atlandı");
    return;
  }

  await new Promise<void>((resolve) => {
    let out = "";
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    // KRİTİK (macOS izin pencereleri): `claude update`'i de claudeSpawnEnv ile spawn et — yoksa
    // disable bayrakları (AUTO_CONNECT_IDE/ATTACHMENTS → IDE/klasör/medya taraması) buna ulaşmaz ve
    // startup'taki `claude update` tüm taramaları yapıp "Belgeler/Apple Music/..." izinlerini tetikler.
    // NONESSENTIAL_TRAFFIC'i ÇIKAR: o güncelleme ağ çağrısını engelleyebilir, update'in çalışması lazım.
    const updaterEnv = { ...claudeSpawnEnv() };
    delete updaterEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    // Ümit 2026-06-12: env tek başına yetmiyordu → `claude update`'i de folder-guard (sandbox-exec) ile
    // sar. Read-only (Bash yok); update ağ + kendi install dizinini kullanır (guarded-dir değil → açık).
    const guarded = wrapReadOnlyClaude(claudeBin, ["update"]);
    const child = spawn(guarded.cmd, guarded.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: updaterEnv,
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* zaten bitti */ }
      log.warn("claude-updater", "update zaman aşımı (görmezden gelindi)");
      done();
    }, UPDATE_TIMEOUT_MS);
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", (d) => { out += String(d); });
    child.on("error", (err) => {
      log.warn("claude-updater", "update spawn başarısız (görmezden gelindi)", err);
      done();
    });
    child.on("exit", (code) => {
      const outcome = interpretUpdateOutput(code, out);
      if (outcome === "updated") {
        emitChatMessage("system", "🔄 Claude Code CLI otomatik güncellendi (MyCL açılışı).");
        log.info("claude-updater", "güncellendi", { out: out.slice(0, 200) });
      } else if (outcome === "current") {
        log.info("claude-updater", "zaten güncel");
      } else {
        log.warn("claude-updater", "güncelleme başarısız (görmezden gelindi)", { code, out: out.slice(0, 200) });
      }
      done();
    });
  });
}
