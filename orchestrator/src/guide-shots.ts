// guide-shots — app-içi kullanım kılavuzunun rota ekran görüntülerini üretir.
//
// living-docs `.mycl/help-pages.json` route'larının ekran görüntülerini (dev server ayaktaysa)
// <project>/public/docs/guide-shots/<route>.png olarak yazar; app-içi "?" kılavuz popup'ı
// bunları <img> ile gömer. page.screenshot() YALNIZ headless Chromium → orchestrator'a
// `playwright` dep eklendi; chromium npm-install'da SKIP (.npmrc — CI hafif), RUNTIME'da lazy
// install (`npx playwright install chromium`). Pipeline-end non-blocking yan-yarar; precondition
// yoksa GÖRÜNÜR skip; ASLA throw etmez (prototype-cache/csp-check fail-closed deseni).
//
// NOT (YZLLM 2026-06-19): PDF kullanım kılavuzu kuralı KALDIRILDI — yalnız app-içi kılavuz +
// her sayfada "?" yeterli. Eski generateGuidePdf + PDF-only HTML yardımcıları bu dosyadan çıkarıldı.

import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { appendAudit } from "./audit.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import type { State } from "./types.js";

// YZLLM 2026-06-14: app-içi kılavuzun ekran görüntüleri — hedef-app'in public'ine yazılır, <img> ile gömülür.
const HELP_PAGES_REL = join(".mycl", "help-pages.json");
const SHOTS_DIR_REL = join("public", "docs", "guide-shots");
const CANDIDATE_PORTS = [5173, 5174, 4173, 3000, 8080, 4321];
// YZLLM 2026-06-19: PDF kullanım kılavuzu kuralı KALDIRILDI. Eski koşulardan kalan kullanim-kilavuzu.pdf
// (eski generateGuidePdf üretmişti) diskte kalıp kafa karıştırıyor → her tazelemede BAYATI SİL.
const STALE_PDF_REL = join("public", "docs", "kullanim-kilavuzu.pdf");

/** SAF: route → güvenli png dosya adı ("/" kök → anasayfa). */
export function sanitizeRouteForFile(route: string): string {
  const s = route
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return `${s || "anasayfa"}.png`;
}

// guide-shots.js dist/'te → ".." orchestrator kökü (playwright + npx burada).
const ORCH_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Lazy: chromium yoksa orchestrator-owned kur (npx playwright install chromium). */
function ensureChromium(): Promise<boolean> {
  return new Promise((res) => {
    try {
      const p = spawn("npx", ["playwright", "install", "chromium"], {
        cwd: ORCH_ROOT,
        stdio: "ignore",
        timeout: 240_000,
      });
      p.on("close", (code) => res(code === 0));
      p.on("error", () => res(false));
    } catch {
      res(false);
    }
  });
}

async function launchChromium(): Promise<Browser | null> {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    emitChatMessage("system", "🖼️ Kılavuz ekran görüntüleri için Chromium kuruluyor (ilk sefer, ~1 dk)…");
    if (!(await ensureChromium())) return null;
    try {
      return await chromium.launch({ headless: true });
    } catch {
      return null;
    }
  }
}

/** Dev server hangi port'ta canlı? Aday portları HTTP probe et; ilk yanıt → o. */
async function detectLivePort(): Promise<number | null> {
  for (const port of CANDIDATE_PORTS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1200);
      const r = await fetch(`http://localhost:${port}/`, { signal: ctrl.signal }).catch(() => null);
      clearTimeout(t);
      if (r) return port;
    } catch {
      /* sonraki port */
    }
  }
  return null;
}

/**
 * IMPURE: pipeline-end. .mycl/help-pages.json'daki HER route'un ekran görüntüsünü hedef-app'in
 * public/docs/guide-shots/<route>.png'sine yazar (app-içi kılavuz bunları <img> ile gömer). Dev server
 * kapalıysa GÖRÜNÜR skip (sahte-yeşil yok). BAYAT TEMİZLİĞİ: help-pages'ta artık olmayan eski .png'ler silinir.
 * ASLA throw etmez. UI'sız projede no-op.
 */
export async function generateGuideShots(state: State): Promise<void> {
  let browser: Browser | null = null;
  try {
    // Bayat PDF temizliği (YZLLM 2026-06-19): PDF kuralı kalktı; eski koşulardan kalan PDF'i sil
    // (yoksa no-op; UI'sız projede zaten yok). skip_ui kontrolünden ÖNCE — her durumda temizlensin.
    await fs.rm(join(state.project_root, STALE_PDF_REL), { force: true }).catch(() => {});
    if (state.skip_ui_phases) return;
    let routes: string[];
    try {
      const hp = JSON.parse(await fs.readFile(join(state.project_root, HELP_PAGES_REL), "utf-8"));
      routes = Array.isArray(hp)
        ? [...new Set(hp.map((p) => (p as { route?: unknown })?.route).filter((r): r is string => typeof r === "string"))]
        : [];
    } catch (e) {
      // errno-AYRIMI: ENOENT = help-pages.json yok (meşru no-op). Parse-hatası/EACCES = bozuk/erişilemez → görünür kıl.
      if ((e as { code?: string }).code !== "ENOENT") {
        log.warn("guide-shots", "help-pages.json okunamadı/parse edilemedi (bozuk?) — kılavuz çekimi atlandı", { error: String(e) });
      }
      return;
    }
    if (routes.length === 0) return;
    const port = await detectLivePort();
    if (!port) {
      emitChatMessage(
        "system",
        "ℹ️ Kılavuz ekran görüntüleri alınamadı — dev server kapalı (sahte-yeşil yok). Sonraki tazelemede çekilir.",
      );
      return;
    }
    browser = await launchChromium();
    if (!browser) {
      // Load-bearing skip (sessiz-fallback denetimi): kılavuz çekimi atlanıyor → kullanıcı NEDEN bilmeli.
      emitChatMessage(
        "system",
        "ℹ️ Kılavuz ekran görüntüleri alınamadı — Chromium kurulamadı/başlatılamadı (sahte-yeşil yok). Sonraki tazelemede denenir.",
      );
      return;
    }
    // YZLLM 2026-06-20: ÇİFT DİLLİ çekim — her dil için ayrı context (locale → app
    // navigator.language'ı algılar) + `?lang=<code>` deterministik override (şablon
    // bunu zorunlu kılar). Çıktı guide-shots/<lang>/<route>.png; "?" popup kullanıcının
    // seçili diline göre doğru klasörü gösterir.
    const LANGS = [
      { code: "tr", locale: "tr-TR" },
      { code: "en", locale: "en-US" },
    ];
    let captured = 0;
    const total = routes.length * LANGS.length;
    for (const lang of LANGS) {
      const ctx = await browser.newContext({ locale: lang.locale });
      const page = await ctx.newPage();
      const shotsDir = join(state.project_root, SHOTS_DIR_REL, lang.code);
      await fs.mkdir(shotsDir, { recursive: true });
      const wanted = new Set<string>();
      for (const route of routes) {
        const fname = sanitizeRouteForFile(route);
        wanted.add(fname);
        try {
          const sep = route.includes("?") ? "&" : "?";
          await page.goto(`http://localhost:${port}${route}${sep}lang=${lang.code}`, {
            waitUntil: "networkidle",
            timeout: 8000,
          });
          await fs.writeFile(join(shotsDir, fname), await page.screenshot({ fullPage: true }));
          captured++;
        } catch {
          /* bu route ss alınamadı → atla */
        }
      }
      // Bayat temizliği: help-pages'ta artık olmayan eski .png'leri (bu dilde) sil.
      try {
        for (const f of await fs.readdir(shotsDir)) {
          if (f.endsWith(".png") && !wanted.has(f)) await fs.rm(join(shotsDir, f)).catch(() => {});
        }
      } catch {
        /* dizin okunamadı */
      }
      await ctx.close().catch(() => {});
    }
    // Eski tek-dilli koşulardan kök guide-shots/*.png kalmışsa temizle (artık <lang>/ altında).
    try {
      const rootDir = join(state.project_root, SHOTS_DIR_REL);
      for (const f of await fs.readdir(rootDir)) {
        if (f.endsWith(".png")) await fs.rm(join(rootDir, f)).catch(() => {});
      }
    } catch {
      /* dizin okunamadı */
    }
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: state.current_phase,
      event: "guide-shots-generated",
      caller: "mycl-orchestrator",
      detail: `dir=${SHOTS_DIR_REL}/{tr,en} captured=${captured}/${total}`,
    }).catch(() => {});
    emitChatMessage(
      "system",
      `🖼️ Kılavuz ekran görüntüleri güncellendi (TR+EN): \`${SHOTS_DIR_REL}/{tr,en}/\` (${captured}/${total} görüntü).`,
    );
  } catch (err) {
    log.warn("guide-shots", "generateGuideShots failed (non-fatal)", err);
  } finally {
    await browser?.close().catch(() => {});
  }
}
