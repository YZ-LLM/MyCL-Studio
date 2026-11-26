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
// MAHKEME (2026-07-16): rota başına kısa timeout + TOPLAM bütçe — kırık rotalar Faz 6
// mesajını dakikalarca geciktirmesin (guide-shots 8sn/rota emsali). Bütçe aşılınca
// kalan rotalar GÖRÜNÜR "atlandı" olur (sessiz değil).
const SHOT_TIMEOUT_MS = 8_000;
const TOTAL_BUDGET_MS = 45_000;
/** Sayfanın ilk boyamadan sonra oturması için kısa bekleme (animasyon/font titremesini azaltır). */
const SETTLE_MS = 400;
/** Bu oranın üstü "değişti" satırı olarak tek tek listelenir (altı toplamda özetlenir). */
const NOTABLE_DIFF_RATIO = 0.01;
/** Rota başına saklanan en çok hata satırı ve satır başına en çok karakter (kayıt ve mesaj şişmesin). */
const MAX_ROUTE_ERRORS = 5;
const ROUTE_ERROR_MAX_CHARS = 240;
/** Boş ekran kaydında ve Faz 6 mesajında gösterilen "ilk birkaç" hata. */
const BLANK_ERRORS_SHOWN = 3;
/** Boş ekran denetim kaydı ayrıntısının üst sınırı (tek satırlık kayıt küçük kalsın). */
const BLANK_DETAIL_MAX_CHARS = 700;

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
  /**
   * Bu rotanın AYNI açılışında görülen konsol hataları ve yakalanmamış sayfa hataları (ilk
   * MAX_ROUTE_ERRORS tanesi, tekrarsız, kırpılmış). Rota açıldıysa hep doludur (hata yoksa `[]`);
   * rota hiç açılmadıysa (süre bütçesi) yoktur → "hata yok" ile "ölçülmedi" karışmaz.
   */
  pageErrors?: string[];
  /** Aynı açılışta görülen tekrarsız hata sayısı (saklananlardan fazla olabilir). */
  pageErrorCount?: number;
}

/**
 * SAF: tarayıcıdan gelen tek bir hatayı kayda uygun tek satıra çevir (boşluklar tek boşluk, uzunluk
 * sınırlı). `where` metinde zaten geçmiyorsa sona eklenir — "Failed to load resource" gibi iletiler
 * hangi dosya olduğunu yalnız konumda taşır.
 */
export function clipPageError(kind: "konsol" | "sayfa", text: string, where?: string): string {
  const flat = text.replace(/\s+/g, " ").trim() || "(boş ileti)";
  const tail = where && !flat.includes(where) ? ` @ ${where}` : "";
  const line = `${kind}: ${flat}${tail}`;
  return line.length > ROUTE_ERROR_MAX_CHARS ? `${line.slice(0, ROUTE_ERROR_MAX_CHARS - 1)}…` : line;
}

/**
 * SAF: Faz 6 `phase-6-deferred` denetim kaydının ayrıntısı. Ekran boş değilse boş dizgi (eski davranış).
 * Boşsa `blank_screen` ile başlar (hüküm bu sözcüğü arar) ve boş görünen rotaların açılışında görülen
 * ilk birkaç hatayı taşır — eskiden yalnız `blank_screen` yazılıyordu, neden kayıtta yoktu.
 */
export function blankScreenDetail(diffs: readonly RouteShotDiff[]): string {
  const blanks = diffs.filter((d) => d.nearlyBlank);
  if (blanks.length === 0) return "";
  // Hata dinlemesi hiç yapılmadıysa (alan yok) sayı İDDİA ETME — yalnız eski sözcük.
  if (!blanks.some((d) => d.pageErrors !== undefined)) return "blank_screen";
  const errors = [...new Set(blanks.flatMap((d) => d.pageErrors ?? []))];
  // errors=N: boş görünen rotaların açılışlarında görülen hataların TOPLAMI (rota başına tekrarsız sayım).
  const total = blanks.reduce((n, d) => n + (d.pageErrorCount ?? 0), 0);
  const routes = blanks.map((d) => d.route).join(",");
  if (errors.length === 0) return `blank_screen routes=${routes} errors=0`.slice(0, BLANK_DETAIL_MAX_CHARS);
  return `blank_screen routes=${routes} errors=${total} | ${errors.slice(0, BLANK_ERRORS_SHOWN).join(" | ")}`.slice(
    0,
    BLANK_DETAIL_MAX_CHARS,
  );
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
  } catch (e) {
    // errno-AYRIMI (guide-shots/living-docs konvansiyonu): ENOENT = help-pages yok (meşru
    // → kök "/" ile devam). Parse-hatası/EACCES = bozuk/erişilemez → GÖRÜNÜR uyarı (rota
    // kapsamı sessizce daralmasın), yine "/" ile devam (rapor kısmi de olsa değerli).
    if ((e as { code?: string }).code !== "ENOENT") {
      log.warn("visual-regression", "help-pages.json okunamadı/bozuk — yalnız kök rota karşılaştırılıyor", {
        error: String(e),
      });
    }
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
    // BOŞ EKRANIN NEDENİ (2026-11-27, ekransız deneme koşusu): sayfa boş göründüğünde kayıtta yalnız
    // `blank_screen` vardı; tarayıcının o açılışta ne dediği hiç dinlenmiyordu. Dinleyiciler aynı
    // sayfaya, ilk açılıştan ÖNCE bağlanır: ekran görüntüsünü alan açılış ile hatayı gören açılış aynıdır.
    // Sayfanın politikası atlatılmaz — kullanıcının gördüğü neyse o görülür, yalnız dinlenir.
    let routeErrors: string[] = [];
    let seenErrors = new Set<string>();
    // Pencere yalnız "açılış başladı → ekran görüntüsü alındı" arasında açıktır: önceki sayfanın geç
    // gelen hatası bir sonraki rotaya yazılmasın, görüntüden sonra gelen de boş kararına karışmasın.
    let listening = false;
    const noteError = (line: string): void => {
      if (!listening || seenErrors.has(line)) return;
      seenErrors.add(line);
      if (routeErrors.length < MAX_ROUTE_ERRORS) routeErrors.push(line);
    };
    page.on("pageerror", (err) => noteError(clipPageError("sayfa", err.message)));
    page.on("console", (msg) => {
      if (msg.type() === "error") noteError(clipPageError("konsol", msg.text(), msg.location().url));
    });
    const seenSoFar = (): { pageErrors: string[]; pageErrorCount: number } => ({
      pageErrors: [...routeErrors],
      pageErrorCount: seenErrors.size,
    });
    await fs.rm(pendingDir, { recursive: true, force: true });
    await fs.mkdir(pendingDir, { recursive: true });
    const startedAt = Date.now();
    for (const route of routes) {
      if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
        // Toplam bütçe aşıldı → kalan rotalar GÖRÜNÜR atlanır (Faz 6 mesajı gecikmesin).
        diffs.push({ route, status: "error", errorReason: "süre bütçesi aşıldı — bu tur atlandı" });
        continue;
      }
      // Her rota kendi hatalarını taşır (önceki rotanınkiler karışmasın).
      routeErrors = [];
      seenErrors = new Set<string>();
      listening = true;
      try {
        await page.goto(new URL(route, url).toString(), {
          waitUntil: "domcontentloaded",
          timeout: SHOT_TIMEOUT_MS,
        });
        await page.waitForTimeout(SETTLE_MS);
        const shot = await page.screenshot({ fullPage: false });
        // Ekran görüntüsü anına kadar görülenler — boş kararıyla aynı pencere.
        const seen = seenSoFar();
        listening = false;
        const file = sanitizeRouteForFile(route);
        await fs.writeFile(join(pendingDir, file), shot);
        const nearlyBlank = isNearlyBlank(shot);
        if (!baselineExisted) {
          diffs.push({ route, status: "new", nearlyBlank, ...seen });
          continue;
        }
        let base: Buffer;
        try {
          base = await fs.readFile(join(baselineDir, file));
        } catch {
          diffs.push({ route, status: "new", nearlyBlank, ...seen });
          continue;
        }
        const cmp = comparePngBuffers(base, shot);
        diffs.push({ route, status: cmp.status, diffRatio: cmp.diffRatio, nearlyBlank, ...seen });
      } catch (err) {
        // Rota bazlı hata görünür kalır (sessiz "değişmedi" sanılmasın).
        diffs.push({ route, status: "error", errorReason: String(err).slice(0, 120), ...seenSoFar() });
        listening = false;
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
  const backupDir = `${baselineDir}.old`;
  try {
    const entries = await fs.readdir(pendingDir).catch(() => [] as string[]);
    if (!entries.some((f) => f.endsWith(".png"))) return; // pending yok → no-op
    // MAHKEME (2026-07-16) SWAP deseni: eski tabanı SİLMEDEN önce kenara taşı — rename
    // ortada başarısız olursa eski taban GERİ KONUR (görsel geçmiş kaybolmaz).
    await fs.rm(backupDir, { recursive: true, force: true });
    let hadBaseline = false;
    try {
      await fs.rename(baselineDir, backupDir);
      hadBaseline = true;
    } catch {
      /* taban yoktu (ilk terfi) */
    }
    try {
      await fs.rename(pendingDir, baselineDir);
      await fs.rm(backupDir, { recursive: true, force: true });
    } catch (err) {
      if (hadBaseline) await fs.rename(backupDir, baselineDir).catch(() => {});
      log.warn("visual-regression", "taban terfi edilemedi — eski taban geri kondu; sonraki karşılaştırma eski tabana göre olur", {
        error: String(err),
      });
    }
  } catch (err) {
    log.warn("visual-regression", "taban terfi edilemedi (sonraki karşılaştırma mevcut tabana göre olur)", {
      error: String(err),
    });
  }
}

/**
 * SAF: boş görünen rotaların açılışında tarayıcının bildirdiği hataları rapora ekle (ilk birkaçı).
 * Hata dinlenmediyse (alan yok) satır eklenmez; dinlendi ama hata yoksa bu da açıkça yazılır —
 * "neden boş?" sorusunda "tarayıcı hata vermedi" de bir bilgidir.
 */
function blankErrorLines(blanks: readonly RouteShotDiff[]): string {
  const lines: string[] = [];
  for (const d of blanks) {
    if (d.pageErrors === undefined) continue;
    if (d.pageErrors.length === 0) {
      lines.push(`   • \`${d.route}\` açılışında tarayıcı konsol ya da sayfa hatası bildirmedi.`);
      continue;
    }
    const total = d.pageErrorCount ?? d.pageErrors.length;
    lines.push(`   • \`${d.route}\` açılışında tarayıcının bildirdiği hatalar (${total}):`);
    for (const e of d.pageErrors.slice(0, BLANK_ERRORS_SHOWN)) lines.push(`      - ${e}`);
    if (total > BLANK_ERRORS_SHOWN) lines.push(`      - … +${total - BLANK_ERRORS_SHOWN} daha`);
  }
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
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
      ? `\n⚠️ **Boş görünen sayfa:** ${blanks.map((d) => `\`${d.route}\``).join(", ")} — neredeyse tek renk; sayfa boş/kırık olabilir, göz at.${blankErrorLines(blanks)}`
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
