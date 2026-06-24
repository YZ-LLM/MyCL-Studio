// accessibility-scan — WCAG/erişilebilirlik taraması (Faz 6 UI incelemesinde, SALT-RAPOR).
//
// SAW (SAFe Agentic Workflow) esinli; mahkeme kararı: erişilebilirlik bir GATE OLAMAZ.
// axe-core/lighthouse BOL false-positive üretir (kontrast eşiği, ARIA best-practice) →
// MyCL'in EN BÜYÜK sistemik tehlikesi "gate false-positive → oto-düzeltmeye → tıkanma"yı
// büyütürdü. Bu yüzden:
//   • SALT-RAPOR: hiçbir fazı bloklamaz, oto-fix döngüsü tetiklemez (return tipi yok).
//   • SEVERITY-TABANI: yalnız critical + serious ÖNE çıkarılır (eyleme değer); moderate/minor sayılır.
//   • Karar İNSANDA: Faz 6 zaten kullanıcı UI'yi sürüyor → bulgular onun önüne konur, o karar verir.
//
// Stack-BAĞIMSIZ: hedef projenin stack'ine HİÇ dokunmaz — orchestrator'ın kendi Playwright +
// axe-core'uyla çalışan dev-server URL'ine vurur (Go/Rust/Next/Vite farketmez). Faz 6 yalnız UI'lı
// projede koşar (library/cli'de atlanır) → ayrı has_ui kapısı gerekmez.
//
// Sessiz fallback YOK: araç/launch/timeout hatası → ran:false + GÖRÜNÜR skippedReason (sessizce
// "temiz" denmez). Ama blocking de değil — rapor "tarama yapılamadı" der, pipeline akar.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { log } from "./logger.js";

/** axe `impact` seviyeleri — eylem önceliği. critical/serious = severity-tabanı (öne çıkar). */
export type A11yImpact = "critical" | "serious" | "moderate" | "minor" | null;

export interface A11yViolation {
  /** axe kural kimliği (ör. "color-contrast", "image-alt"). */
  id: string;
  impact: A11yImpact;
  /** İnsan-okur açıklama (axe `help`). */
  help: string;
  /** Etkilenen DOM düğüm sayısı. */
  nodes: number;
  /** axe doküman URL'i (kullanıcı detaya gitsin). */
  helpUrl: string;
}

export interface A11yResult {
  /** Tarama GERÇEKTEN koştu mu (tarayıcı açıldı + axe çalıştı). false → skippedReason dolu. */
  ran: boolean;
  url: string;
  violations: A11yViolation[];
  /** ran=false ise NEDEN (görünür; "temiz" sanılmasın). */
  skippedReason?: string;
}

const SCAN_TIMEOUT_MS = 25_000;

/** axe-core kaynak dosyasının yolunu çöz (node_modules'tan; bundle'da da mevcut — playwright gibi). */
function axeSourcePath(): string {
  const require = createRequire(import.meta.url);
  // package main → axe.js; min sürümü daha küçük (inject hızlı).
  const main = require.resolve("axe-core");
  return main.replace(/axe\.js$/, "axe.min.js");
}

/**
 * Verilen dev-server URL'ini WCAG açısından tara (Playwright headless chromium + axe-core).
 * ASLA throw etmez — her hata görünür `ran:false` + skippedReason döner (blocking değil).
 *
 * @param url  Çalışan dev-server adresi (ör. http://localhost:5173).
 */
export async function runAccessibilityScan(url: string): Promise<A11yResult> {
  const fail = (reason: string): A11yResult => ({ ran: false, url, violations: [], skippedReason: reason });
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (err) {
    log.warn("a11y", "playwright import edilemedi — tarama atlandı (görünür)", { error: String(err) });
    return fail("Playwright bulunamadı (erişilebilirlik taraması bu tur yapılamadı)");
  }
  let axeSource: string;
  try {
    axeSource = await readFile(axeSourcePath(), "utf-8");
  } catch (err) {
    log.warn("a11y", "axe-core kaynağı okunamadı — tarama atlandı (görünür)", { error: String(err) });
    return fail("axe-core kaynağı bulunamadı (erişilebilirlik taraması yapılamadı)");
  }

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: SCAN_TIMEOUT_MS });
    await page.addScriptTag({ content: axeSource });
    // WCAG 2.1 A + AA etiketli kurallar — yaygın, anlamlı kapsam (deneysel/best-practice gürültüsü hariç).
    const raw = (await page.evaluate(async () => {
      // @ts-expect-error — axe sayfa bağlamına inject edildi (global).
      return await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    })) as { violations: Array<{ id: string; impact: A11yImpact; help: string; helpUrl: string; nodes: unknown[] }> };
    const violations: A11yViolation[] = raw.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      help: v.help,
      nodes: Array.isArray(v.nodes) ? v.nodes.length : 0,
      helpUrl: v.helpUrl,
    }));
    return { ran: true, url, violations };
  } catch (err) {
    log.warn("a11y", "tarama çalışırken hata — atlandı (görünür, blocking değil)", { error: String(err) });
    return fail(`Tarama çalıştırılamadı: ${String(err).slice(0, 120)}`);
  } finally {
    await browser?.close().catch(() => {});
  }
}

const SEVERITY_FLOOR: ReadonlySet<A11yImpact> = new Set<A11yImpact>(["critical", "serious"]);

/**
 * SAF (test-edilebilir): tarama sonucunu Faz 6 incelemesi için TR rapora çevir.
 * SEVERITY-TABANI: yalnız critical/serious tek tek listelenir; moderate/minor sadece sayılır.
 * Hiç bloklama dili yok — kullanıcıya bilgi (o karar verir).
 */
export function formatA11yReport(r: A11yResult): string {
  if (!r.ran) {
    return `♿ **Erişilebilirlik (WCAG):** taranamadı — ${r.skippedReason ?? "bilinmeyen neden"} (bilgi; incelemeyi engellemez).`;
  }
  if (r.violations.length === 0) {
    return "♿ **Erişilebilirlik (WCAG 2.1 A/AA):** ✅ axe-core ihlali bulunamadı.";
  }
  const actionable = r.violations.filter((v) => SEVERITY_FLOOR.has(v.impact));
  const minorCount = r.violations.length - actionable.length;
  const lines: string[] = ["♿ **Erişilebilirlik (WCAG 2.1 A/AA)** — axe-core bulguları (bilgi; sen karar ver):"];
  if (actionable.length === 0) {
    lines.push(`• Önemli (critical/serious) bulgu yok.`);
  } else {
    lines.push(`• **${actionable.length} önemli** bulgu (critical/serious):`);
    for (const v of actionable.slice(0, 8)) {
      lines.push(`   - \`${v.id}\` (${v.impact}, ${v.nodes} öğe): ${v.help}`);
    }
    if (actionable.length > 8) lines.push(`   - … +${actionable.length - 8} daha`);
  }
  if (minorCount > 0) {
    lines.push(`• ${minorCount} düşük öncelikli (moderate/minor) bulgu — detay için axe çıktısı.`);
  }
  return lines.join("\n");
}
