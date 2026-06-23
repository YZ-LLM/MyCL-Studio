// visual-design-agent.ts — Faz 5 sonrası GÖRSEL TASARIM ajanı (YZLLM 2026-06-17).
//
// Tek işi: üretilen UI'a GÖRSEL GÜZELLİK katmak — başka hiçbir şey. Faz 5 codegen işleve odaklı
// (CSP / erişilebilirlik / spec) → estetik elde kalıyor (canlı kanıt: sayaç çalışıyor ama çirkin).
// Bu ajan dev-server açıkken sayfanın ekran görüntüsünü alır, görüntü-anlayan claude'a verir (Read
// tool PNG'i GÖRSEL okur — multimodal, ekstra mekanizma gerekmez), ajan SADECE stil (CSS) dosyalarını
// güzelleştirir: renk paleti, boşluk/hizalama, tipografi, görsel hiyerarşi.
//
// GÜVENLİK/KISIT (tool-policy: acceptEdits → allowedTools yalnız oto-onay, GERÇEK kısıt disallowedTools):
//  - disallowedTools = [Bash, Agent, Task] → kod-çalıştırma kaçışı (`cat > file`) + alt-ajan donması engellenir.
//  - SONRASI doğrulama (deterministik): git-diff → yalnız stil dosyaları değişmeli (JSX/TS/HTML/backend HAYIR;
//    değiştiyse o dosyalar git ile GERİ ALINIR) + CSP re-scan → inline-style eklendiyse TÜM rötuş geri alınır
//    (CSP %100 > estetik). Böylece görsel ajan işlevi/güvenliği BOZAMAZ.
//  - non-blocking: her fail → görünür uyarı, pipeline Faz 6'ya devam (asla throw etmez, asla pipeline kırmaz).

import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runClaudeCli } from "./cli-run.js";
import { resolveCliProvider } from "./claude-api.js";
import { escalatedModelEffort } from "./escalation.js";
import { scanCspViolations } from "./csp-compliance.js";
import { appendAudit } from "./audit.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import type { State } from "./types.js";
import type { MyclConfig } from "./config.js";

const execFileP = promisify(execFile);
const VISUAL_DIR_REL = join(".mycl", "visual");
const STYLE_EXT = /\.(css|scss|sass|less|pcss|styl)$/i;

/** IMPURE: dev-server route'unun fullPage screenshot'ını outPath'e yazar. Başarısızsa false (best-effort). */
async function captureScreenshot(port: number, route: string, outPath: string): Promise<boolean> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    return false; // chromium yok (guide-shots lazy-install eder; burada best-effort)
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://localhost:${port}${route}`, { waitUntil: "networkidle", timeout: 8000 });
    await page.screenshot({ path: outPath, fullPage: true });
    return true;
  } catch {
    return false;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** SAF: değişen dosyalar yalnız stil mi? Stil-dışı (JSX/TS/HTML/backend) = ihlal (geri alınır). */
export function nonStyleFiles(files: string[]): string[] {
  return files.filter((f) => f && !STYLE_EXT.test(f));
}

async function git(root: string, args: string[]): Promise<string> {
  // SALT-OKUNUR sorgular için (diff). Mutasyon (checkout/clean) için gitMutate kullan → başarıyı DOĞRULAR.
  const { stdout } = await execFileP("git", ["-C", root, ...args]).catch(() => ({ stdout: "" }));
  return stdout;
}

/**
 * Durum-DEĞİŞTİREN git (checkout/clean): hatayı YUTMA (sessiz-fallback denetimi) — revert sessizce
 * başarısız olursa stil-dışı/CSP-ihlalli dosyalar working-tree'de kalır ama "geri alındı" sanılır →
 * app ihlalli yayınlanır. Başarısızsa false dön; caller RE-VERIFY edip fail-closed davranır.
 */
async function gitMutate(root: string, args: string[]): Promise<boolean> {
  try {
    await execFileP("git", ["-C", root, ...args]);
    return true;
  } catch (e) {
    log.error("visual-design", "git mutasyonu başarısız (revert güvenilmez)", { args, error: String(e) });
    return false;
  }
}

/** Görsel ajanın working-tree'de değiştirdiği dosyalar (git-add baseline'ından SONRA). */
async function gitWorkingChanges(root: string): Promise<string[]> {
  const out = await git(root, ["diff", "--name-only"]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export const VISUAL_SYSTEM_PROMPT = `You are MyCL's Visual Design Agent. Your ONE job: make the already-built UI visually beautiful — nothing else.

The UI already works; Phase 5 focused on logic, CSP, and accessibility. Now improve ONLY the visual aesthetics:
color palette, spacing/alignment, typography, visual hierarchy, consistency, and modern polish.

## What to do
1. Read the screenshot PNG whose path is given in the user message. The Read tool shows it to you visually — study it like a designer: what looks crude, unstyled, cramped, misaligned, or dated?
2. Find the project's STYLE files (use Read/Glob/Grep): src/App.css, src/index.css, src/styles/*.css, *.module.css, or the global stylesheet for this stack.
3. Edit ONLY those stylesheet files to improve aesthetics:
   - Color: a coherent palette (background, surface, primary/accent, text) with good contrast.
   - Spacing: a consistent scale (8px rhythm), breathing room, aligned elements, a centered/constrained layout instead of raw full-width.
   - Typography: clear hierarchy (heading vs body sizes/weights), comfortable line-height, a clean system font stack.
   - Components: buttons/inputs/cards with subtle radius, padding, and hover/focus states; group related items visually.
   - Modern feel: get rid of the raw unstyled browser-default look.

## HARD CONSTRAINTS (non-negotiable — MyCL verifies and reverts violations)
- **Stylesheet files ONLY.** Do NOT edit .jsx/.tsx/.js/.ts/.html or any logic/markup/text. Do NOT change behavior or structure. (Any non-style change is git-reverted.)
- **CSP: NO inline styles.** Never add a \`style="..."\` attribute, a React \`style={{...}}\` prop, or an inline \`<style>\` block — keep everything in external CSS classes. (MyCL re-scans CSP and reverts the ENTIRE retouch if you break it.)
- **Accessibility: keep WCAG AA contrast** (normal text ≥ 4.5:1). Never trade readability for looks.
- **No new dependencies / no UI libraries.** Pure hand-written CSS only. Do NOT touch package.json. Do NOT run commands.
- Keep it tasteful and restrained: one clean, coherent, modern look — not flashy.

## When done
Just stop (no further tool calls). MyCL verifies automatically: only stylesheets changed + CSP still clean. You signal nothing.`;

function buildUserMessage(shotPath: string, root: string): string {
  return `The dev server is running and a full-page screenshot of the CURRENT UI is saved at:
${shotPath}

Read that PNG to SEE the current design, then improve ONLY the stylesheet(s) to make it visually beautiful, per your instructions. Project root: ${root}`;
}

/**
 * IMPURE: Faz 5 sonrası görsel rötuş. dev-server açık (port). screenshot → vision-claude → CSS güzelleştir →
 * stil-only + CSP doğrula. non-blocking: her hata false döner (pipeline devam eder, asla kırılmaz).
 * Döner: estetik iyileştirme gerçekten uygulandı mı.
 */
export async function runVisualDesignAgent(
  state: State,
  port: number,
  config: MyclConfig,
): Promise<boolean> {
  const root = state.project_root;
  const visualDir = join(root, VISUAL_DIR_REL);
  await fs.mkdir(visualDir, { recursive: true }).catch(() => {});
  const beforeShot = join(visualDir, "before.png");

  // 1) Ekran görüntüsü (ana sayfa). Alınamazsa görsel değerlendirme imkânsız → skip (non-blocking).
  // YZLLM 2026-06-18: captureScreenshot HANG edebilir (chromium launch / dev-server yanıt vermez) → 60s
  // timeout ile sınırla. Hang → skip (Faz 5'i KİLİTLEME — canlı bir app'i screenshot'larken 50s+ asıldığı
  // gözlemlendi; try/catch throw'u yakalar ama HANG'i yakalamaz). MyCL'in tekrar eden hang-sınıfının biri.
  const shotOk = await Promise.race([
    captureScreenshot(port, "/", beforeShot),
    new Promise<boolean>((r) => setTimeout(() => r(false), 60_000)),
  ]);
  if (!shotOk) {
    emitChatMessage("system", "🎨 Görsel tasarım: ekran görüntüsü alınamadı/zaman aşımı (chromium/dev-server) → atlanıyor (Faz 6 devam).");
    return false;
  }

  // 2) git baseline: Faz 5 codegen değişikliklerini stage'le → ajan SONRASI working-tree değişikliği = SADECE
  //    görsel ajanın dokunduğu dosyalar (izolasyon). git yoksa diff-verify atlanır; prompt + CSP-scan yine korur.
  const hasGit = await fs.stat(join(root, ".git")).then(() => true).catch((e) => {
    // ENOENT = git yok (meşru). Diğer hata (EACCES/EIO) → görünür kıl (git-tabanlı stil-dışı/CSP revert güvenliği etkilenir).
    if ((e as { code?: string }).code !== "ENOENT") {
      log.warn("visual-design", ".git stat hatası (var ama erişilemez) — git-tabanlı revert güvenliği belirsiz", { code: (e as { code?: string }).code });
    }
    return false;
  });
  if (hasGit) await git(root, ["add", "-A"]);

  const { modelId, effort } = escalatedModelEffort(state, config, "ui-codegen");
  // ⑥ Sağlayıcı=Z.AI (main) ise görsel ajan da z.ai'ye (claude CLI + z.ai env + GLM model) — sessiz claude YOK.
  const cli = resolveCliProvider(config, "main", modelId);
  emitChatMessage("system", `🎨 Görsel tasarım ajanı çalışıyor — estetik rötuş (yalnız CSS; model: ${cli.model})…`);

  const res = await runClaudeCli({
    systemPrompt: VISUAL_SYSTEM_PROMPT,
    userMessage: buildUserMessage(beforeShot, root),
    modelId: cli.model,
    extraEnv: cli.extraEnv,
    cwd: root,
    // acceptEdits → allowedTools yalnız oto-onay; GERÇEK kısıt disallowedTools (Bash/Agent/Task kaçış+donma).
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"],
    disallowedTools: ["Bash", "Agent", "Task"],
    effort,
    timeoutMs: 600_000,
    observer: (t) => log.info("visual-design", "tool", { name: t.name }),
  }).catch((err) => {
    log.warn("visual-design", "runClaudeCli error (non-blocking)", err);
    return null;
  });

  if (!res || !res.ok) {
    emitChatMessage("system", "🎨 Görsel tasarım: ajan tamamlanamadı → mevcut UI korunuyor (Faz 6 devam).");
    return false;
  }

  // 3) GÜVENLİK: yalnız stil dosyaları değişmiş olmalı. Stil-dışı (JSX/TS/HTML/backend) → o dosyaları GERİ AL.
  if (hasGit) {
    const offenders = nonStyleFiles(await gitWorkingChanges(root));
    if (offenders.length > 0) {
      const ok = await gitMutate(root, ["checkout", "--", ...offenders]);
      // RE-VERIFY: revert gerçekten temizledi mi (sessiz başarısızlık yakalansın).
      const stillOffending = ok ? nonStyleFiles(await gitWorkingChanges(root)) : offenders;
      if (stillOffending.length > 0) {
        log.error("visual-design", "stil-dışı revert başarısız — offenders kaldı", { stillOffending });
        emitChatMessage(
          "system",
          `🎨 KRİTİK: ajan stil-dışı dosyalara dokundu ve GERİ ALMA başarısız oldu (${stillOffending.slice(0, 3).join(", ")}${stillOffending.length > 3 ? "…" : ""}) → görsel iyileştirme güvenli değil, mevcut UI korunuyor (elle kontrol gerekebilir).`,
        );
        return false; // fail-closed: stil-dışı değişiklik temizlenemedi → iyileştirmeyi kabul etme
      }
      emitChatMessage(
        "system",
        `🎨 Görsel tasarım: ajan stil-dışı dosyalara dokundu (${offenders.slice(0, 3).join(", ")}${offenders.length > 3 ? "…" : ""}) → o değişiklikler GERİ ALINDI (yalnız CSS'e izin var).`,
      );
    }
  }

  // 4) CSP re-scan: görsel rötuş inline-style eklediyse %100 CSP bozulur → TÜM görsel değişikliği geri al.
  const cspViol = await scanCspViolations(root);
  if (cspViol.length > 0) {
    const reverted = hasGit ? await gitMutate(root, ["checkout", "--", "."]) : false; // codegen staged kalır; görsel working-değişiklik geri
    // RE-VERIFY: CSP ihlali GERÇEKTEN sıfıra düştü mü — revert sessizce başarısız olduysa app ihlalli kalır.
    const remaining = reverted ? await scanCspViolations(root) : cspViol;
    if (remaining.length > 0) {
      log.error("visual-design", "CSP revert başarısız — app CSP-ihlalli kaldı", { remaining: remaining.length, hadGit: hasGit });
      emitChatMessage(
        "system",
        `🎨 KRİTİK: görsel iyileştirme CSP ihlali doğurdu (${cspViol.length}) ve GERİ ALMA başarısız oldu — app HÂLÂ CSP-ihlalli (${remaining.length}). Faz 6'ya bu hâliyle GİTMEMELİ; elle müdahale gerek.`,
      );
      await appendAudit(root, {
        ts: Date.now(), phase: 5, event: "visual-design-csp-revert-FAILED", caller: "mycl-orchestrator",
        detail: `${cspViol.length} ihlal, revert sonrası ${remaining.length} kaldı (hasGit=${hasGit})`,
      });
      return false;
    }
    emitChatMessage(
      "system",
      `🎨 Görsel tasarım: iyileştirme CSP ihlali doğurdu (${cspViol.length}: inline-style) → GERİ ALINDI (doğrulandı: 0 ihlal). CSP %100 korunur, estetik bu sefer atlandı.`,
    );
    await appendAudit(root, {
      ts: Date.now(), phase: 5, event: "visual-design-reverted-csp", caller: "mycl-orchestrator",
      detail: `${cspViol.length} csp ihlali → revert (doğrulandı)`,
    });
    return false;
  }

  // 5) Başarılı — after screenshot (kayıt; ileride before/after karşılaştırma + denetim için).
  await captureScreenshot(port, "/", join(visualDir, "after.png")).catch(() => false);
  emitChatMessage("system", "🎨 Görsel tasarım: estetik iyileştirme uygulandı (renk/boşluk/tipografi — CSS-only, CSP korundu). ✅");
  await appendAudit(root, {
    ts: Date.now(), phase: 5, event: "visual-design-complete", caller: "mycl-orchestrator",
    detail: `model=${modelId} effort=${effort}`,
  });
  return true;
}
