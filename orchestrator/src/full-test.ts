// full-test — 🧪 Full Test: TÜM projenin istek üzerine test edilmesi (bağımsız, pipeline'sız).
//
// Neden (YZLLM 2026-07-16): "bakım yapıldıktan sonra tüm projenin test edilmesi gerekir ve bu
// test Playwright ile MyCL tarafından yapılmalıdır. Ayrı bir butonu da olsun." DAST butonu
// deseni birebir: buton → korumalı onay askq → pipeline'sız koşum → TR rapor → düşen bölümler
// iş kuyruğuna fix işi olarak girer (source:"full-test").
//
// Bölümler (4 çekirdek — YZLLM 2026-07-22 "sadece bunları yapsın"): birim suite (profil `test`),
// entegrasyon (profil `integration`), E2E (Faz 16 altyapısı), rota taraması (MyCL'in kendi Playwright'ı:
// konsol hataları + ≥400 yanıtlar + boş sayfa). a11y + görsel karşılaştırma ÇIKARILDI (bu modüller Faz 6'da
// yaşamaya devam eder; Full Test butonunda artık koşmaz).
//
// ASLA throw etmez; her bölüm ayrı try/catch. Koşulamayan bölüm GÖRÜNÜR "atlandı + neden"
// (KATI #4 — sessiz yeşil yok). Bu bir GATE DEĞİL: hiçbir fazı bloklamaz; bulgular kuyruğa
// görünür iş olarak düşer, kararı kullanıcı/pipeline verir.

import { runSuiteProcess } from "./behavior-baseline.js";
import { parseFailures } from "./regression-diff.js";
import {
  isMissingCommand,
  isSpawnEnvFailure,
  resolveMechanicalCmd,
} from "./base/mechanical-runner.js";
import {
  isNearlyBlank,
  routesFromHelpPages,
} from "./visual-regression.js";
import { assessPhase16Verification } from "./playwright-setup.js";
import { log } from "./logger.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { State } from "./types.js";
// Yalnız TİP importu (runtime döngü yok — verify-feature full-test'i import etmez; tип erasure).
// İşlevsel bölümün gerçek koşumu deps.verifyIntent seam'inden gelir (index.ts enjekte eder).
import type { RealAppGateOutcome } from "./verify-feature.js";

export type FullTestSectionId = "unit" | "integration" | "e2e" | "route-sweep" | "functional";

export interface FullTestSection {
  id: FullTestSectionId;
  /** Rapor başlığı (TR). */
  label_tr: string;
  /** pass/fail hüküm taşır (4 bölümün hepsi çekirdek); koşulamayan bölüm "skipped" (görünür, sahte-yeşil değil). */
  status: "pass" | "fail" | "skipped";
  /** Satır gövdesi — pass'te kısa özet, fail'de düşenler, skipped'da NEDEN (zorunlu görünürlük). */
  detail_tr: string;
  /** Düşen test adları / sorunlu rotalar (fix işi metnine girer). */
  failures?: string[];
}

export interface FullTestReport {
  /** Çekirdek bölümlerin (birim/entegrasyon/E2E/rota/işlevsel) hiçbiri fail değil. */
  ok: boolean;
  sections: FullTestSection[];
  durationMs: number;
}

/** index.ts'ten enjekte edilen yardımcılar — döngüsel import yok, test edilebilirlik. */
export interface FullTestDeps {
  /** Dev server ayakta mı / kaldırılabildi mi (ensureDevServerForReview sarmalayıcısı). */
  ensureDevServer: () => Promise<{ ok: boolean; port?: number }>;
  /** Playwright kurulum + scaffold ön adımı (ensurePlaywrightForPhase16 sarmalayıcısı). */
  ensureE2E: () => Promise<{ proceed: boolean; reason?: string }>;
  /** İlerleme geri-bildirimi (banner "i/N: <özellik>" + sohbet ekmek-kırıntısı). Yoksa sessiz. */
  onProgress?: (msg: string) => void;
  /** İptal sinyali — kullanıcı "İptal"e basınca özellikler arası döngü durur (kalanlar görünür atlanır). */
  signal?: AbortSignal;
  /** İŞLEVSEL DOĞRULAMA seam'i — bir niyeti çalışan app'te gerçek (mock'suz) E2E ile doğrular.
   *  index.ts verifyIntentAgainstApp'i enjekte eder; YOKSA işlevsel bölüm görünür atlanır (geriye uyumlu). */
  verifyIntent?: (intentEn: string, opts?: { signal?: AbortSignal }) => Promise<RealAppGateOutcome>;
}

/** Çekirdek (hüküm taşıyan) bölümler — birim/entegrasyon/E2E/rota + işlevsel (a11y/görsel 2026-07-22'de ÇIKARILDI). */
const CORE_SECTIONS: ReadonlySet<FullTestSectionId> = new Set<FullTestSectionId>([
  "unit",
  "integration",
  "e2e",
  "route-sweep",
  "functional",
]);

/** İşlevsel doğrulama için bir belgelenmiş özellik → codegen niyeti. */
export interface FeatureIntent {
  /** Rapor/ilerleme başlığı (TR). */
  label_tr: string;
  /** Codegen'e giden İngilizce niyet (route + beklenen davranış). */
  intentEn: string;
}

/** collectFeatureIntents çıktısı — niyetler + hangi kaynaktan geldiği (görünür atlama için). */
export interface FeatureIntentSource {
  intents: FeatureIntent[];
  source: "help-pages" | "features" | "none";
}

/** SAF: davranış kaynaklarından işlevsel-doğrulama niyetleri çıkar (test edilebilir; IO yok).
 *  Birincil kaynak `.mycl/help-pages.json` (route + beklenen davranış); yoksa `.mycl/features.md`
 *  (## başlık bloklarına bölünür). İkisi de boşsa source="none" → çağıran görünür atlar (KATI #4). */
export function collectFeatureIntents(helpPagesRaw: unknown, featuresMd: string): FeatureIntentSource {
  // Birincil: help-pages.json — her sayfanın body'si = beklenen davranış (Full Test bugüne dek ATIYORDU).
  if (Array.isArray(helpPagesRaw)) {
    const intents: FeatureIntent[] = [];
    const seen = new Set<string>();
    for (const p of helpPagesRaw) {
      const o = p as {
        route?: unknown;
        title_tr?: unknown;
        title_en?: unknown;
        body_tr?: unknown;
        body_en?: unknown;
      };
      const route = typeof o?.route === "string" && o.route.startsWith("/") ? o.route : "";
      const titleEn =
        typeof o?.title_en === "string" && o.title_en.trim()
          ? o.title_en.trim()
          : typeof o?.title_tr === "string"
            ? o.title_tr.trim()
            : "";
      const bodyEn =
        typeof o?.body_en === "string" && o.body_en.trim()
          ? o.body_en.trim()
          : typeof o?.body_tr === "string"
            ? o.body_tr.trim()
            : "";
      if (!route || !bodyEn) continue; // route + davranış İKİSİ de şart (yalnız açılış rota-taramasının işi)
      if (seen.has(route)) continue;
      seen.add(route);
      const label_tr =
        typeof o?.title_tr === "string" && o.title_tr.trim() ? o.title_tr.trim() : titleEn || route;
      const intentEn = `Page "${titleEn || route}" at route ${route}. Expected behavior (verify this actually WORKS, not just that the page loads): ${bodyEn}`;
      intents.push({ label_tr, intentEn });
    }
    if (intents.length > 0) return { intents, source: "help-pages" };
  }

  // Fallback: features.md — ## başlıklarına böl (What/Where/Behavior gövdesi = niyet).
  const md = (featuresMd ?? "").trim();
  if (md) {
    const intents: FeatureIntent[] = [];
    // split[0] = ilk `##` ÖNCESİ gelen her şey (başlık/giriş önsözü) → TANIM GEREĞİ özellik değil, koşulsuz atla.
    // (MAHKEME 2026-07-22: eski `startsWith("#")` sezgisi, önsöz `#` ile başlamazsa onu yanlışlıkla özellik sayardı.)
    const parts = md.split(/^##\s+/m).slice(1);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const nl = trimmed.indexOf("\n");
      const heading = (nl >= 0 ? trimmed.slice(0, nl) : trimmed).trim();
      const body = (nl >= 0 ? trimmed.slice(nl + 1) : "").trim();
      if (!heading || !body) continue;
      intents.push({
        label_tr: heading,
        intentEn: `Feature "${heading}". Expected behavior (verify this actually WORKS, not just that the page loads): ${body}`,
      });
    }
    if (intents.length > 0) return { intents, source: "features" };
  }

  return { intents: [], source: "none" };
}

/** IO: davranış kaynaklarını oku (.mycl/help-pages.json + features.md; ENOENT tolere) → collectFeatureIntents. */
async function readFeatureIntents(projectRoot: string): Promise<FeatureIntentSource> {
  let helpRaw: unknown = null;
  try {
    helpRaw = JSON.parse(await fs.readFile(join(projectRoot, ".mycl", "help-pages.json"), "utf-8"));
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      log.warn("full-test", "help-pages.json okunamadı (işlevsel doğrulama) — features.md'ye düşülüyor", {
        error: String(e),
      });
    }
  }
  let featuresMd = "";
  try {
    featuresMd = await fs.readFile(join(projectRoot, ".mycl", "features.md"), "utf-8");
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      log.warn("full-test", "features.md okunamadı (işlevsel doğrulama)", { error: String(e) });
    }
  }
  return collectFeatureIntents(helpRaw, featuresMd);
}

const ROUTE_TIMEOUT_MS = 8_000;
const ROUTE_BUDGET_MS = 45_000;
const ROUTE_SETTLE_MS = 400;

/** SAF: bir komut sonucunu bölüme çevir (birim/entegrasyon/E2E ortak sınıflandırma). */
export function classifySuiteResult(
  id: FullTestSectionId,
  label_tr: string,
  res: { code: number; stdout: string; stderr: string },
): FullTestSection {
  if (isMissingCommand(res) || isSpawnEnvFailure(res)) {
    return {
      id,
      label_tr,
      status: "skipped",
      detail_tr: "komut/araç bulunamadı veya ortam faultu — koşulamadı (sahte yeşil değil)",
    };
  }
  if (res.code === 0) return { id, label_tr, status: "pass", detail_tr: "yeşil" };
  const failures = [...parseFailures(`${res.stdout}\n${res.stderr}`)];
  const tail = `${res.stdout}\n${res.stderr}`.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
  return {
    id,
    label_tr,
    status: "fail",
    detail_tr:
      failures.length > 0
        ? `${failures.length} test düştü: ${failures.slice(0, 8).join(", ")}${failures.length > 8 ? "…" : ""}`
        : `kırmızı (çıktı sonu: ${tail})`,
    failures,
  };
}

export interface RouteSweepIssue {
  route: string;
  problem: string;
}

/** sweepOneRoute'un ihtiyaç duyduğu asgari Playwright Page yüzeyi (birim test edilebilirlik). */
export interface SweepPage {
  on(event: "console", handler: (m: { type(): string; text(): string }) => void): unknown;
  on(event: "response", handler: (r: { status(): number; url(): string }) => void): unknown;
  off(event: "console", handler: (m: { type(): string; text(): string }) => void): unknown;
  off(event: "response", handler: (r: { status(): number; url(): string }) => void): unknown;
  goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts: { fullPage: boolean }): Promise<Buffer>;
}

/**
 * Tek rotayı tarar: konsol hataları + ≥400 yanıtlar + neredeyse boş sayfa.
 * Dinleyiciler ROTA-YEREL takılır ve finally'de sökülür — önceki rotadan geç gelen olay
 * sonraki rotaya YAZILMAZ (mahkeme bulgusu: sayfa-ömürlü paylaşılan dinleyici + ortak dizi,
 * rota geçişinde olayı yanlış rotaya mal edebiliyordu).
 */
export async function sweepOneRoute(
  page: SweepPage,
  baseUrl: string,
  route: string,
): Promise<{ opened: boolean; issues: RouteSweepIssue[] }> {
  const issues: RouteSweepIssue[] = [];
  const consoleErrors: string[] = [];
  const badResponses: string[] = [];
  const onConsole = (m: { type(): string; text(): string }) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160));
  };
  const onResponse = (r: { status(): number; url(): string }) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url().slice(0, 120)}`);
  };
  page.on("console", onConsole);
  page.on("response", onResponse);
  let opened = false;
  try {
    await page.goto(new URL(route, baseUrl).toString(), {
      waitUntil: "domcontentloaded",
      timeout: ROUTE_TIMEOUT_MS,
    });
    await page.waitForTimeout(ROUTE_SETTLE_MS);
    opened = true;
    const shot = await page.screenshot({ fullPage: false });
    if (isNearlyBlank(shot)) issues.push({ route, problem: "sayfa neredeyse boş görünüyor (tek renk)" });
    if (consoleErrors.length > 0) {
      issues.push({ route, problem: `konsol hatası: ${consoleErrors[0]}${consoleErrors.length > 1 ? ` (+${consoleErrors.length - 1})` : ""}` });
    }
    if (badResponses.length > 0) {
      issues.push({ route, problem: `başarısız istek: ${badResponses[0]}${badResponses.length > 1 ? ` (+${badResponses.length - 1})` : ""}` });
    }
  } catch (err) {
    issues.push({ route, problem: `açılamadı: ${String(err).slice(0, 100)}` });
  } finally {
    page.off("console", onConsole);
    page.off("response", onResponse);
  }
  return { opened, issues };
}

/** Rota taraması — her rotada konsol hataları + ≥400 yanıtlar + neredeyse boş sayfa. */
async function sweepRoutes(baseUrl: string, projectRoot: string): Promise<FullTestSection> {
  const label_tr = "Rota taraması";
  let routes: string[] = ["/"];
  try {
    const raw = JSON.parse(await fs.readFile(join(projectRoot, ".mycl", "help-pages.json"), "utf-8")) as unknown;
    const fromDocs = routesFromHelpPages(raw);
    if (fromDocs.length > 0) routes = fromDocs;
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      log.warn("full-test", "help-pages.json okunamadı/bozuk — yalnız kök rota taranıyor", { error: String(e) });
    }
  }
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (err) {
    return {
      id: "route-sweep",
      label_tr,
      status: "skipped",
      detail_tr: `Playwright bulunamadı — rota taraması yapılamadı (${String(err).slice(0, 80)})`,
    };
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const issues: RouteSweepIssue[] = [];
  let sweptCount = 0;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const startedAt = Date.now();
    for (const route of routes) {
      if (Date.now() - startedAt > ROUTE_BUDGET_MS) {
        issues.push({ route, problem: "süre bütçesi aşıldı — bu tur taranamadı" });
        continue;
      }
      const r = await sweepOneRoute(page, baseUrl, route);
      if (r.opened) sweptCount++;
      issues.push(...r.issues);
    }
  } catch (err) {
    return {
      id: "route-sweep",
      label_tr,
      status: "skipped",
      detail_tr: `tarayıcı başlatılamadı — ${String(err).slice(0, 100)}`,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
  if (issues.length === 0) {
    return { id: "route-sweep", label_tr, status: "pass", detail_tr: `${sweptCount} rota temiz (konsol/istek/boş-sayfa)` };
  }
  return {
    id: "route-sweep",
    label_tr,
    status: "fail",
    detail_tr: issues
      .slice(0, 8)
      .map((i) => `\`${i.route}\`: ${i.problem}`)
      .join("; ") + (issues.length > 8 ? ` (+${issues.length - 8})` : ""),
    failures: issues.map((i) => `${i.route} — ${i.problem}`),
  };
}

/**
 * IMPURE: İŞLEVSEL DOĞRULAMA — her belgelenmiş özelliğin çalışan uygulamada GERÇEKTEN doğru çalıştığını
 * (yalnız sayfanın açıldığını DEĞİL) gerçek (mock'suz) E2E ile doğrular. deps.verifyIntent yoksa görünür
 * atlanır (API-modu/no-UI). SIRALI koşar (paylaşılan history slotu 16 → paralelleşemez); özellikler arası
 * iptal edilebilir (signal). Aggregate → TEK bölüm: herhangi fail → fail; fail yok + pass var → pass; hiç
 * pass/fail yok (hepsi cannot_run/iptal) → skipped (görünür). `cannot_run` verdict'i DÜŞÜRMEZ (yalnız gerçek
 * fail) — yoksa kaynak-yok/API-modu yanlış ❌ üretir. Test'te sahte verifyIntent ile doğrudan çağrılır. */
export async function verifyDocumentedFeatures(state: State, deps: FullTestDeps): Promise<FullTestSection> {
  const id: FullTestSectionId = "functional";
  const label_tr = "İşlevsel doğrulama";
  const verifyIntent = deps.verifyIntent;
  if (!verifyIntent) {
    return {
      id,
      label_tr,
      status: "skipped",
      detail_tr:
        "işlevsel doğrulama bu modda kapalı (yalnız CLI/abonelik + UI projesinde çalışır) — açılış/rota taraması yapıldı",
    };
  }

  let src: FeatureIntentSource;
  try {
    src = await readFeatureIntents(state.project_root);
  } catch (err) {
    return {
      id,
      label_tr,
      status: "skipped",
      detail_tr: `davranış kaynağı okunamadı (${String(err).slice(0, 80)}) — açılış/rota taraması yapıldı`,
    };
  }
  if (src.source === "none" || src.intents.length === 0) {
    return {
      id,
      label_tr,
      status: "skipped",
      detail_tr:
        "davranış kaynağı yok (.mycl/help-pages.json veya features.md — yalnız CLI/abonelik + UI modunda üretilir); yalnız açılış/rota taraması yapıldı",
    };
  }

  const total = src.intents.length;
  const passed: string[] = [];
  const failures: string[] = [];
  const couldNotRun: string[] = [];
  let cancelled = 0;

  for (let i = 0; i < total; i++) {
    const intent = src.intents[i];
    if (deps.signal?.aborted) {
      cancelled = total - i; // kalan tüm özellikler iptalle atlandı (görünür)
      break;
    }
    deps.onProgress?.(`İşlevsel doğrulama ${i + 1}/${total}: ${intent.label_tr}`);
    let outcome: RealAppGateOutcome;
    try {
      outcome = await verifyIntent(intent.intentEn, { signal: deps.signal });
    } catch (err) {
      // Seam beklenmedik istisna → "kanıtlayamadım" say (verdict'i DÜŞÜRMEZ; bölüm izolasyonu — runFullTest throw etmez).
      log.warn("full-test", "işlevsel doğrulama özelliği patladı — kanıtlanamadı sayıldı", {
        feature: intent.label_tr,
        error: String(err),
      });
      couldNotRun.push(intent.label_tr);
      continue;
    }
    if (outcome.outcome === "fail") {
      const firstLine =
        outcome.failSnippet
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)[0] ?? "";
      failures.push(`${intent.label_tr}${firstLine ? ` — ${firstLine.slice(0, 160)}` : ""}`);
    } else if (outcome.outcome === "pass") {
      passed.push(intent.label_tr);
    } else {
      // cannot_run (no_dev_server/no_playwright/codegen_failed/not_found/error) → kanıtlanamadı (DÜŞÜRMEZ).
      couldNotRun.push(intent.label_tr);
    }
  }

  const parts: string[] = [`${passed.length}/${total} özellik doğrulandı`];
  if (couldNotRun.length > 0) parts.push(`${couldNotRun.length} kanıtlanamadı`);
  if (cancelled > 0) parts.push(`${cancelled} iptalle atlandı`);
  const summary = parts.join(", ");

  if (failures.length > 0) {
    return {
      id,
      label_tr,
      status: "fail",
      detail_tr:
        `${failures.length} özellik beklendiği gibi çalışmıyor (${summary}): ` +
        failures
          .slice(0, 6)
          .map((f) => `\`${f}\``)
          .join("; ") +
        (failures.length > 6 ? ` (+${failures.length - 6})` : ""),
      failures,
    };
  }
  if (passed.length > 0) {
    return { id, label_tr, status: "pass", detail_tr: summary };
  }
  // Hiç pass, hiç fail → hepsi cannot_run/iptal → GÖRÜNÜR atlama (sahte-yeşil DEĞİL, sahte-kırmızı da değil).
  return {
    id,
    label_tr,
    status: "skipped",
    detail_tr:
      cancelled >= total
        ? "iptal edildi — hiçbir özellik doğrulanmadan durduruldu"
        : `hiçbir özellik doğrulanamadı (${summary}) — kaynak/ortam elvermedi (görünür atlama)`,
  };
}

/**
 * IMPURE: Full Test koşumu. ASLA throw etmez; her bölüm izole. Dev server kalkmazsa
 * canlı-uygulama bölümleri (E2E/rota/işlevsel) GÖRÜNÜR atlanır, birim/entegrasyon yine koşar.
 */
export async function runFullTest(state: State, deps: FullTestDeps): Promise<FullTestReport> {
  const t0 = Date.now();
  const sections: FullTestSection[] = [];

  const runProfileSuite = async (
    id: FullTestSectionId,
    label_tr: string,
    key: "test" | "integration",
  ): Promise<FullTestSection> => {
    try {
      const cmd = await resolveMechanicalCmd({ type: "profile_key", key }, state);
      if (!cmd) {
        return { id, label_tr, status: "skipped", detail_tr: `profilde \`${key}\` komutu yok — bu stack'te desteklenmiyor` };
      }
      return classifySuiteResult(id, label_tr, await runSuiteProcess(cmd, state.project_root));
    } catch (err) {
      return { id, label_tr, status: "skipped", detail_tr: `beklenmedik hata — koşulamadı (${String(err).slice(0, 100)})` };
    }
  };

  // 1-2) Birim + entegrasyon — canlı uygulama GEREKMEZ, her durumda koşar.
  sections.push(await runProfileSuite("unit", "Birim testleri", "test"));
  sections.push(await runProfileSuite("integration", "Entegrasyon testleri", "integration"));

  // Dev server — canlı-uygulama bölümlerinin ön koşulu.
  let port: number | undefined;
  let devOk = false;
  try {
    const dev = await deps.ensureDevServer();
    devOk = dev.ok;
    port = dev.port;
  } catch (err) {
    log.warn("full-test", "dev server kontrolü beklenmedik hata", { error: String(err) });
  }
  const liveSkip = (id: FullTestSectionId, label_tr: string): FullTestSection => ({
    id,
    label_tr,
    status: "skipped",
    detail_tr: "dev server başlatılamadı — canlı uygulama testi atlandı (sahte yeşil değil)",
  });

  // Playwright ön adımı (kurulum + scaffold) — E2E VE işlevsel doğrulama AYNI scaffold'u paylaşır → BİR KEZ.
  // (verifyIntentAgainstApp Playwright'ın hazır olduğunu varsayar; scaffold'ı burada garantiliyoruz.)
  let e2ePre: { proceed: boolean; reason?: string } = { proceed: false, reason: "dev server yok" };
  if (devOk) {
    try {
      e2ePre = await deps.ensureE2E();
    } catch (err) {
      e2ePre = { proceed: false, reason: `ön adım hata: ${String(err).slice(0, 80)}` };
    }
  }

  // 3) E2E — Faz 16 altyapısı (kurulum + scaffold yukarıda) + profil e2e komutu.
  if (!devOk) {
    sections.push(liveSkip("e2e", "E2E (Playwright)"));
  } else if (!e2ePre.proceed) {
    sections.push({
      id: "e2e",
      label_tr: "E2E (Playwright)",
      status: "skipped",
      detail_tr: `E2E ön adımı geçilemedi (${e2ePre.reason ?? "bilinmeyen"}) — görünür atlama`,
    });
  } else {
    try {
      const cmd = await resolveMechanicalCmd({ type: "project_type", which: "e2e" }, state);
      if (!cmd) {
        sections.push({
          id: "e2e",
          label_tr: "E2E (Playwright)",
          status: "skipped",
          detail_tr: "bu proje tipi için E2E runner tanımlı değil (profil)",
        });
      } else {
        const section = classifySuiteResult("e2e", "E2E (Playwright)", await runSuiteProcess(cmd, state.project_root));
        // Dürüstlük notu: koşan smoke MyCL yer tutucusu mu, gerçek test mi?
        try {
          const honesty = await assessPhase16Verification(state.project_root);
          if (honesty.smokeKind === "placeholder" && section.status === "pass") {
            section.detail_tr += " — DİKKAT: koşan test MyCL yer tutucu duman testi (gerçek kapsam değil)";
          }
        } catch {
          /* dürüstlük notu opsiyonel zenginleştirme */
        }
        sections.push(section);
      }
    } catch (err) {
      sections.push({
        id: "e2e",
        label_tr: "E2E (Playwright)",
        status: "skipped",
        detail_tr: `beklenmedik hata — koşulamadı (${String(err).slice(0, 100)})`,
      });
    }
  }

  // 4) Rota taraması — canlı uygulama ister (konsol hataları + ≥400 yanıtlar + boş sayfa).
  const baseUrl = `http://localhost:${port ?? 5173}`;
  if (!devOk) {
    sections.push(liveSkip("route-sweep", "Rota taraması"));
  } else {
    sections.push(await sweepRoutes(baseUrl, state.project_root));
  }

  // 5) İşlevsel doğrulama — her belgelenmiş özellik çalışan app'te GERÇEKTEN doğru çalışıyor mu (mock'suz E2E).
  //    Canlı app + Playwright scaffold'u ZATEN hazır olmalı (devOk + e2ePre.proceed); verifyIntent enjekte edilmeli.
  if (!deps.verifyIntent) {
    sections.push({
      id: "functional",
      label_tr: "İşlevsel doğrulama",
      status: "skipped",
      detail_tr:
        "işlevsel doğrulama bu modda kapalı (yalnız CLI/abonelik + UI projesinde çalışır) — açılış/rota taraması yapıldı",
    });
  } else if (!devOk) {
    sections.push({
      id: "functional",
      label_tr: "İşlevsel doğrulama",
      status: "skipped",
      detail_tr: "dev server başlatılamadı — işlevsel doğrulama atlandı (sahte yeşil değil)",
    });
  } else if (!e2ePre.proceed) {
    sections.push({
      id: "functional",
      label_tr: "İşlevsel doğrulama",
      status: "skipped",
      detail_tr: `Playwright ön adımı geçilemedi (${e2ePre.reason ?? "bilinmeyen"}) — işlevsel doğrulama atlandı`,
    });
  } else {
    sections.push(await verifyDocumentedFeatures(state, deps));
  }

  const ok = sections.every((s) => !(CORE_SECTIONS.has(s.id) && s.status === "fail"));
  return { ok, sections, durationMs: Date.now() - t0 };
}

/** SAF: raporu TR sohbet mesajına çevir. */
export function formatFullTestReport(r: FullTestReport): string {
  const icon = (s: FullTestSection): string => (s.status === "pass" ? "✅" : s.status === "fail" ? "❌" : "⏭");
  const lines = r.sections.map((s) => `${icon(s)} **${s.label_tr}:** ${s.detail_tr}`);
  const head = r.ok
    ? `🧪 **Full Test tamamlandı** (${Math.round(r.durationMs / 1000)}sn) — çekirdek bölümler temiz.`
    : `🧪 **Full Test tamamlandı** (${Math.round(r.durationMs / 1000)}sn) — ❌ sorun bulundu; düşen bölümler iş kuyruğuna eklendi.`;
  return `${head}\n\n${lines.join("\n")}`;
}

/** SAF: düşen ÇEKİRDEK bölüm başına ≤1 kaba fix işi metni (kuyruk floodu olmasın). */
export function fixTasksFromReport(r: FullTestReport): string[] {
  const tasks: string[] = [];
  for (const s of r.sections) {
    if (!CORE_SECTIONS.has(s.id) || s.status !== "fail") continue;
    const evidence = (s.failures ?? []).slice(0, 8).join("; ");
    tasks.push(
      `Full Test '${s.label_tr}' bölümü düştü — kök nedeni bul ve düzelt. Kanıt: ${evidence || s.detail_tr}. Düzeltme sonrası ilgili suite yeşil geçmeli.`,
    );
  }
  return tasks;
}
