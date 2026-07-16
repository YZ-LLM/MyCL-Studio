// visual-regression — iterasyonlar arası GÖRSEL önce/sonra karşılaştırması (Faz 6, SALT-RAPOR).
//
// Neden (YZLLM 2026-07-16, boşluk kapatma): kullanıcının gözü Faz 6'da tek emniyetti; "hiçbir şey
// sorma" modunda Faz 6 oto-geçildiği için görsel bozulma (boş sayfa, kayan yerleşim) HİÇ
// yakalanmıyordu. Bu modül önceki Faz 6'daki rota görüntülerini taban alır, bu iterasyonun
// görüntüleriyle piksel karşılaştırır ve raporu Faz 6 mesajına ekler — her iki modda da görünür.
//
// a11y-scan desenini birebir izler (mahkeme kararı emsali): GATE DEĞİL, oto-fix tetiklemez,
// hiçbir fazı bloklamaz; hata → görünür "karşılaştırılamadı" (sessiz değil; KATI #4). Stack'ten
// BAĞIMSIZ: hedef projenin stack'ine dokunmaz, orchestrator'ın kendi Playwright'ıyla çalışan
// dev-server URL'ine vurur (KATI #1). Rotalar living-docs `.mycl/help-pages.json`'dan (guide-shots
// ile aynı kaynak); yoksa yalnız kök "/".
//
// Taban çizgisi yaşam döngüsü: çekimler `.mycl/visual-pending/`e yazılır; Faz 6 GEÇİLİNCE
// (onay veya never-ask oto-geçiş → advanceToNextPhase(6)) pending → `.mycl/visual-baseline/`e
// terfi eder. Yani taban = "son Faz 6'da görülüp devam edilen görünüm"; rapor bu iterasyonun
// görsel deltasını gösterir. revise_ui'de terfi olmaz (taban eski onaylı hâlde kalır).

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { log } from "./logger.js";
import { sanitizeRouteForFile } from "./guide-shots.js";

const BASELINE_DIR_REL = join(".mycl", "visual-baseline");
const PENDING_DIR_REL = join(".mycl", "visual-pending");
const VIEWPORT = { width: 1280, height: 720 };
const SHOT_TIMEOUT_MS = 20_000;
/** Sayfanın ilk boyamadan sonra oturması için kısa bekleme (animasyon/font titremesini azaltır). */
const SETTLE_MS = 400;
/** Bu oranın üstü "değişti" satırı olarak tek tek listelenir (altı toplamda özetlenir). */
const NOTABLE_DIFF_RATIO = 0.01;

export type RouteShotStatus = "unchanged" | "changed" | "new" | "dim-changed" | "error";

export interface RouteShotDiff {
  route: string;
  status: RouteShotStatus;
  /** Farklı piksel oranı (0-1) — yalnız changed/unchanged'da dolu. */
  diffRatio?: number;
  /** Güncel görüntü NEREDEYSE BOŞ mu (tek renk ≥ %99 — olası beyaz/boş sayfa). */
  nearlyBlank?: boolean;
  /** status=error ise görünür neden. */
  errorReason?: string;
}

export interface VisualRegressionResult {
  /** Çekim GERÇEKTEN koştu mu (tarayıcı açıldı). false → skippedReason dolu. */
  ran: boolean;
  url: string;
  /** Karşılaştırılacak taban var mıydı (ilk koşuda false → yalnız kayıt). */
  baselineExisted: boolean;
  diffs: RouteShotDiff[];
  skippedReason?: string;
}

/** SAF: help-pages.json içeriğinden rota listesi (guide-shots ile aynı şekil: [{route}]); geçersiz → []. */
export function routesFromHelpPages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .map((p) => (p as { route?: unknown })?.route)
        .filter((r): r is string => typeof r === "string" && r.startsWith("/")),
    ),
  ];
}

/** SAF: iki PNG buffer'ını karşılaştır. Boyut farkı → dim-changed (piksel kıyası anlamsız). */
export function comparePngBuffers(
  baseline: Buffer,
  current: Buffer,
): { status: "unchanged" | "changed" | "dim-changed"; diffRatio: number } {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(current);
  if (a.width !== b.width || a.height !== b.height) {
    return { status: "dim-changed", diffRatio: 1 };
  }
  const diffPixels = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.1 });
  const ratio = diffPixels / (a.width * a.height);
  return { status: ratio > 0 ? "changed" : "unchanged", diffRatio: ratio };
}

/**
 * SAF: görüntü neredeyse boş mu — en baskın rengin oranı ≥ %99 ise true (olası beyaz/boş sayfa).
 * "Hiçbir şey sorma" modunda boş sayfa sinyali: gate değil, rapora ⚠️ satırı.
 */
export function isNearlyBlank(pngBuffer: Buffer): boolean {
  const img = PNG.sync.read(pngBuffer);
  const counts = new Map<number, number>();
  const total = img.width * img.height;
  for (let i = 0; i < img.data.length; i += 4) {
    // 4 bit/kanal kaba kovalama — anti-aliasing gürültüsünü tek renge toplar.
    const key =
      ((img.data[i] >> 4) << 8) | ((img.data[i + 1] >> 4) << 4) | (img.data[i + 2] >> 4);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let max = 0;
  for (const c of counts.values()) if (c > max) max = c;
  return max / total >= 0.99;
}

/**
 * IMPURE: rotaların güncel görüntülerini çek (pending'e yaz) + varsa tabanla karşılaştır.
 * ASLA throw etmez — her hata görünür `ran:false`/route-error olarak döner (a11y deseni).
 */
export async function captureAndCompare(url: string, projectRoot: string): Promise<VisualRegressionResult> {
  const fail = (reason: string): VisualRegressionResult => ({
    ran: false,
    url,
    baselineExisted: false,
    diffs: [],
    skippedReason: reason,
  });

  let routes: string[] = ["/"];
  try {
    const raw = JSON.parse(await fs.readFile(join(projectRoot, ".mycl", "help-pages.json"), "utf-8")) as unknown;
    const fromDocs = routesFromHelpPages(raw);
    if (fromDocs.length > 0) routes = fromDocs;
  } catch {
    /* help-pages yok/bozuk → kök "/" ile devam (rapor yine değerli) */
  }

  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (err) {
    log.warn("visual-regression", "playwright import edilemedi — karşılaştırma atlandı (görünür)", { error: String(err) });
    return fail("Playwright bulunamadı (görsel karşılaştırma bu tur yapılamadı)");
  }

  const pendingDir = join(projectRoot, PENDING_DIR_REL);
  const baselineDir = join(projectRoot, BASELINE_DIR_REL);
  let baselineExisted = false;
  try {
    baselineExisted = (await fs.readdir(baselineDir)).some((f) => f.endsWith(".png"));
  } catch {
    /* taban yok → ilk kayıt */
  }

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const diffs: RouteShotDiff[] = [];
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: VIEWPORT });
    await fs.rm(pendingDir, { recursive: true, force: true });
    await fs.mkdir(pendingDir, { recursive: true });
    for (const route of routes) {
      try {
        await page.goto(new URL(route, url).toString(), {
          waitUntil: "domcontentloaded",
          timeout: SHOT_TIMEOUT_MS,
        });
        await page.waitForTimeout(SETTLE_MS);
        const shot = await page.screenshot({ fullPage: false });
        const file = sanitizeRouteForFile(route);
        await fs.writeFile(join(pendingDir, file), shot);
        const nearlyBlank = isNearlyBlank(shot);
        if (!baselineExisted) {
          diffs.push({ route, status: "new", nearlyBlank });
          continue;
        }
        let base: Buffer;
        try {
          base = await fs.readFile(join(baselineDir, file));
        } catch {
          diffs.push({ route, status: "new", nearlyBlank });
          continue;
        }
        const cmp = comparePngBuffers(base, shot);
        diffs.push({ route, status: cmp.status, diffRatio: cmp.diffRatio, nearlyBlank });
      } catch (err) {
        // Rota bazlı hata görünür kalır (sessiz "değişmedi" sanılmasın).
        diffs.push({ route, status: "error", errorReason: String(err).slice(0, 120) });
      }
    }
    return { ran: true, url, baselineExisted, diffs };
  } catch (err) {
    log.warn("visual-regression", "çekim çalışırken hata — atlandı (görünür, blocking değil)", { error: String(err) });
    return fail(`Görsel çekim çalıştırılamadı: ${String(err).slice(0, 120)}`);
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * IMPURE: Faz 6 GEÇİLİNCE çağrılır (advanceToNextPhase(6) — onay ve never-ask oto-geçiş dahil
 * TÜM ilerleme yolları). pending → baseline terfi; pending yoksa no-op. Hata görünür log (non-fatal).
 */
export async function promoteVisualBaseline(projectRoot: string): Promise<void> {
  const pendingDir = join(projectRoot, PENDING_DIR_REL);
  const baselineDir = join(projectRoot, BASELINE_DIR_REL);
  try {
    const entries = await fs.readdir(pendingDir).catch(() => [] as string[]);
    if (!entries.some((f) => f.endsWith(".png"))) return; // pending yok → no-op
    await fs.rm(baselineDir, { recursive: true, force: true });
    await fs.rename(pendingDir, baselineDir);
  } catch (err) {
    log.warn("visual-regression", "taban terfi edilemedi (sonraki karşılaştırma eski tabana göre olur)", {
      error: String(err),
    });
  }
}

/**
 * SAF (test edilebilir): sonucu Faz 6 incelemesi için TR rapora çevir. SALT-RAPOR dili —
 * bloklama yok, kullanıcıya bilgi (a11y raporu deseni). Kayda değer değişim (>%1) tek tek,
 * gerisi özet; boş görünen sayfa ⚠️ ile öne çıkar.
 */
export function formatVisualReport(r: VisualRegressionResult): string {
  const head = "🖼️ **Görsel karşılaştırma (önceki iterasyona göre):**";
  if (!r.ran) {
    return `${head} yapılamadı — ${r.skippedReason ?? "bilinmeyen neden"} (bilgi; incelemeyi engellemez).`;
  }
  const blanks = r.diffs.filter((d) => d.nearlyBlank);
  const blankLine =
    blanks.length > 0
      ? `\n⚠️ **Boş görünen sayfa:** ${blanks.map((d) => `\`${d.route}\``).join(", ")} — neredeyse tek renk; sayfa boş/kırık olabilir, göz at.`
      : "";
  if (!r.baselineExisted) {
    return `${head} ilk görüntüler kaydedildi (${r.diffs.length} rota) — karşılaştırma bir sonraki iterasyonda başlar.${blankLine}`;
  }
  const errors = r.diffs.filter((d) => d.status === "error");
  const notable = r.diffs.filter(
    (d) => (d.status === "changed" && (d.diffRatio ?? 0) >= NOTABLE_DIFF_RATIO) || d.status === "dim-changed",
  );
  const newOnes = r.diffs.filter((d) => d.status === "new");
  const quiet = r.diffs.filter(
    (d) => d.status === "unchanged" || (d.status === "changed" && (d.diffRatio ?? 0) < NOTABLE_DIFF_RATIO),
  );
  const lines: string[] = [];
  for (const d of notable) {
    lines.push(
      d.status === "dim-changed"
        ? `• \`${d.route}\` — görüntü boyutu değişti (yerleşim büyük olasılıkla değişti)`
        : `• \`${d.route}\` — %${((d.diffRatio ?? 0) * 100).toFixed(1)} değişim`,
    );
  }
  for (const d of newOnes) lines.push(`• \`${d.route}\` — yeni rota (tabanda yoktu)`);
  for (const d of errors) lines.push(`• \`${d.route}\` — çekilemedi: ${d.errorReason ?? "bilinmeyen"}`);
  const summary =
    lines.length === 0
      ? " ✅ kayda değer görsel değişim yok"
      : `\n${lines.join("\n")}`;
  const quietNote = quiet.length > 0 && lines.length > 0 ? `\n(${quiet.length} rota değişmedi/önemsiz düzeyde)` : "";
  return `${head}${summary}${quietNote}${blankLine}`;
}
