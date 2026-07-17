// full-test — 🧪 Full Test: TÜM projenin istek üzerine test edilmesi (bağımsız, pipeline'sız).
//
// Neden (YZLLM 2026-07-16): "bakım yapıldıktan sonra tüm projenin test edilmesi gerekir ve bu
// test Playwright ile MyCL tarafından yapılmalıdır. Ayrı bir butonu da olsun." DAST butonu
// deseni birebir: buton → korumalı onay askq → pipeline'sız koşum → TR rapor → düşen bölümler
// iş kuyruğuna fix işi olarak girer (source:"full-test").
//
// Bölümler: birim suite (profil `test`), entegrasyon (profil `integration`), E2E (Faz 16
// altyapısı), rota taraması (MyCL'in kendi Playwright'ı: konsol hataları + ≥400 yanıtlar +
// boş sayfa), a11y + görsel karşılaştırma (mevcut salt-rapor modülleri, bilgi amaçlı).
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
import { runAccessibilityScan, formatA11yReport } from "./accessibility-scan.js";
import {
  captureAndCompare,
  formatVisualReport,
  isNearlyBlank,
  routesFromHelpPages,
} from "./visual-regression.js";
import { assessPhase16Verification } from "./playwright-setup.js";
import { log } from "./logger.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { State } from "./types.js";

export type FullTestSectionId = "unit" | "integration" | "e2e" | "route-sweep" | "a11y" | "visual";

export interface FullTestSection {
  id: FullTestSectionId;
  /** Rapor başlığı (TR). */
  label_tr: string;
  /** pass/fail yalnız ÇEKİRDEK bölümlerde hüküm taşır; a11y/visual salt bilgidir. */
  status: "pass" | "fail" | "skipped";
  /** Satır gövdesi — pass'te kısa özet, fail'de düşenler, skipped'da NEDEN (zorunlu görünürlük). */
  detail_tr: string;
  /** Düşen test adları / sorunlu rotalar (fix işi metnine girer). */
  failures?: string[];
}

export interface FullTestReport {
  /** Çekirdek bölümlerin (birim/entegrasyon/E2E/rota) hiçbiri fail değil. a11y/görsel bilgidir, hükme girmez. */
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
}

/** Çekirdek (hüküm taşıyan) bölümler — a11y/görsel salt bilgi. */
const CORE_SECTIONS: ReadonlySet<FullTestSectionId> = new Set<FullTestSectionId>([
  "unit",
  "integration",
  "e2e",
  "route-sweep",
]);

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
 * IMPURE: Full Test koşumu. ASLA throw etmez; her bölüm izole. Dev server kalkmazsa
 * canlı-uygulama bölümleri (E2E/rota/a11y/görsel) GÖRÜNÜR atlanır, birim/entegrasyon yine koşar.
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

  // 3) E2E — Faz 16 altyapısı (kurulum + scaffold) + profil e2e komutu.
  if (!devOk) {
    sections.push(liveSkip("e2e", "E2E (Playwright)"));
  } else {
    try {
      const pre = await deps.ensureE2E();
      if (!pre.proceed) {
        sections.push({
          id: "e2e",
          label_tr: "E2E (Playwright)",
          status: "skipped",
          detail_tr: `E2E ön adımı geçilemedi (${pre.reason ?? "bilinmeyen"}) — görünür atlama`,
        });
      } else {
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

  // 4) Rota taraması + 5) a11y + 6) görsel — canlı uygulama ister.
  const baseUrl = `http://localhost:${port ?? 5173}`;
  if (!devOk) {
    sections.push(liveSkip("route-sweep", "Rota taraması"));
    sections.push(liveSkip("a11y", "Erişilebilirlik (bilgi)"));
    sections.push(liveSkip("visual", "Görsel karşılaştırma (bilgi)"));
  } else {
    sections.push(await sweepRoutes(baseUrl, state.project_root));
    try {
      const a11y = await runAccessibilityScan(baseUrl);
      sections.push({
        id: "a11y",
        label_tr: "Erişilebilirlik (bilgi)",
        status: a11y.ran ? "pass" : "skipped",
        detail_tr: formatA11yReport(a11y),
      });
    } catch (err) {
      sections.push({ id: "a11y", label_tr: "Erişilebilirlik (bilgi)", status: "skipped", detail_tr: `taranamadı (${String(err).slice(0, 80)})` });
    }
    try {
      const vis = await captureAndCompare(baseUrl, state.project_root);
      sections.push({
        id: "visual",
        label_tr: "Görsel karşılaştırma (bilgi)",
        status: vis.ran ? "pass" : "skipped",
        detail_tr: formatVisualReport(vis),
      });
    } catch (err) {
      sections.push({ id: "visual", label_tr: "Görsel karşılaştırma (bilgi)", status: "skipped", detail_tr: `yapılamadı (${String(err).slice(0, 80)})` });
    }
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
