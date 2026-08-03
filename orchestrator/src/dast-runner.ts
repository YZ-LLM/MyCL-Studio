// dast-runner — WP4: çalışan localhost uygulamasına AKTİF güvenlik taraması (nuclei).
//
// TÜM PROJE TARAMASI (YZLLM 2026-06-12 "tüm projeyi tarasın"): nuclei tek başına yalnız
// kök URL'i test eder (route keşfi yapmaz). Çalışan app'in TÜM route'larını taramak için
// önce katana (ProjectDiscovery crawler, nuclei'yle aynı satıcı) ile gezilir → keşfedilen
// localhost URL'leri nuclei'ye `-l` ile beslenir. katana yoksa GÖRÜNÜR not + yalnız kök
// taranır (kapsam açıkça bildirilir; sahte "tüm proje" iddiası YOK).
//
// GÜVENLİK-KRİTİK (adversaryal inceleme wf_3ebf64a7 verdict'i: rework → bu sentez):
//  - Aktif saldırı aracı → SADECE kullanıcı onayından sonra çağrılır (index.ts
//    pendingDast askq branch; tek çağrı-noktası, onay-baypası imkânsız).
//  - YALNIZ localhost hedef: isLocalhostTarget() WHATWG URL parse + literal
//    allowlist + 127/8 + ::1; octal/hex/decimal IP, userinfo, localhost.evil.com,
//    redirect-host → fail-closed RED. Hedef URL'i BİZ kurarız (host hep "localhost"),
//    config'ten host okumayız — yine de gate defansif. katana'nın KEŞFETTİĞİ her URL de
//    nuclei'ye verilmeden önce isLocalhostTarget()'ten geçer (off-host kaçağı imkânsız).
//  - Sessiz fallback YOK: nuclei kurulu değilse GÖRÜNÜR hata + dur (sahte-yeşil yok).
//    katana yoksa → görünür "yalnız kök tarandı" notu (kapsam yalan söylenmez).
//  - Hang/orphan yok: spawn detached + sabit timeout → killProcessTree (process-group).
//  - Yıkıcı template yok: nuclei -exclude-tags intrusive,dos,fuzz + rate-limit. katana
//    PASİF gezer: headless YOK + automatic-form-fill (-aff) YOK → form göndermez, sadece
//    GET link-traversal (mutasyon yapmaz). Aktif test → onay metninde "gerçek istek" uyarısı.
//  - mac+linux; win32 → görünür "desteklenmiyor" fail-closed.

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit } from "./audit.js";
import { killProcessTree, waitForDevServer } from "./dev-server-launcher.js";
import {
  detectStack,
  expectedPortsFor,
  readNodeScripts,
} from "./intent-router/handlers/command.js";
import { devServerCandidates } from "./dev-server-command.js";
import { log } from "./logger.js";
import { isProcessAliveSync } from "./process-utils.js";
import { safeEnv } from "./safe-env.js";
import type { State } from "./types.js";

const DAST_TIMEOUT_MS = 120_000; // tek-URL nuclei üst sınırı — hang yok, kullanıcı uzatamaz.
const DAST_LIST_TIMEOUT_MS = 300_000; // çoklu-route (tüm-proje) nuclei üst sınırı — yine sabit/bounded.
const KATANA_TIMEOUT_MS = 90_000; // crawl process üst sınırı (katana'nın -ct'sinden uzun, güvenlik kemeri).
const KATANA_CRAWL_DURATION = "60s"; // katana kendi crawl süresini sınırlar (process-timeout'tan önce biter).
const KATANA_DEPTH = 3;
const KATANA_RATE_LIMIT = 50; // dev server'ı boğma (nuclei'den hızlı olabilir; yine de nazik).
const MAX_SCAN_URLS = 250; // nuclei hedef tavanı: timeout + dev-server koruması + dev argv/E2BIG riski.
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 2_500;

/**
 * TARAMA PROFİLİ (YZLLM kararı 2026-08-03): "uçtan uca endüstri seviyesi, hiçbir katmanda açık yok" hedefi
 * için sızma testi OTOMATİK koşmalı — ama pipeline'da her tur tam tarama makineyi ısıtıyordu (2026-06-22'de
 * bu yüzden kaldırılmıştı). Çözüm iki profil:
 *   - "fast": Faz 17'nin otomatik koşumu. YALNIZ yüksek/kritik şablonlar, şablon güncelleme yok, ikinci
 *     (autologin'siz) tur yok, dar tavan → toplam ~85 saniye duvar saati.
 *   - "full": 🛡️ Güvenlik Taraması butonunun BUGÜNKÜ davranışı, birebir korunur (varsayılan).
 * YIKICI ŞABLON DIŞLAMASI (intrusive/dos/fuzz) HER İKİ PROFİLDE PAZARLIKSIZ — profil hızı değiştirir,
 * güvenliği DEĞİL.
 */
export type DastProfileId = "fast" | "full";

export interface DastProfile {
  id: DastProfileId;
  katana: { enabled: boolean; depth: number; crawlDuration: string; rateLimit: number; timeoutMs: number };
  nuclei: { severities: string; rateLimit: number; requestTimeoutSec: number; timeoutMs: number };
  /** nuclei'ye verilecek URL tavanı. */
  maxScanUrls: number;
  /** nuclei şablonlarını güncelle (ağ + ~120 sn). */
  updateTemplates: boolean;
  /** Autologin'siz ikinci tur (giriş akışını gerçekten test eder). */
  secondPassNoAutologin: boolean;
}

export const DAST_PROFILES: Readonly<Record<DastProfileId, DastProfile>> = {
  fast: {
    id: "fast",
    // Crawl kısa: dev sunucu zaten ayakta, amaç en kritik yüzeyi hızla görmek.
    katana: { enabled: true, depth: 2, crawlDuration: "20s", rateLimit: KATANA_RATE_LIMIT, timeoutMs: 25_000 },
    nuclei: { severities: "high,critical", rateLimit: 10, requestTimeoutSec: 5, timeoutMs: 60_000 },
    maxScanUrls: 40,
    updateTemplates: false,
    secondPassNoAutologin: false,
  },
  full: {
    id: "full",
    katana: {
      enabled: true,
      depth: KATANA_DEPTH,
      crawlDuration: KATANA_CRAWL_DURATION,
      rateLimit: KATANA_RATE_LIMIT,
      timeoutMs: KATANA_TIMEOUT_MS,
    },
    nuclei: {
      severities: "low,medium,high,critical",
      rateLimit: 10,
      requestTimeoutSec: 5,
      timeoutMs: DAST_LIST_TIMEOUT_MS,
    },
    maxScanUrls: MAX_SCAN_URLS,
    updateTemplates: false, // çağıran opts ile açar (bugünkü davranış)
    secondPassNoAutologin: true,
  },
};

export interface DastResult {
  ok: boolean;
  /** Kullanıcıya gösterilecek özet (TR). */
  summary_tr: string;
  findings_count?: number;
  /** YZLLM 2026-06-19: bulgu detayları — her biri iş kuyruğuna "sistem işi" olarak yazılır (Faz-3 iterasyonu). */
  summary?: DastSummary;
  error?: string;
}

export interface NucleiFinding {
  templateId: string;
  severity: string;
  name: string;
  matchedAt: string;
}

export interface DastSummary {
  total: number;
  bySeverity: Record<string, number>;
  /** İlk N bulgu (detay örneklemi); total tüm satırları sayar. */
  findings: NucleiFinding[];
}

// ---------------------------------------------------------------------------
// SAF — birim-test edilebilir (I/O yok).
// ---------------------------------------------------------------------------

/**
 * Hedef host loopback mı? WHATWG URL parse + literal allowlist + 127.0.0.0/8 +
 * ::1. Fail-closed: parse edilemeyen / http(s) olmayan / userinfo'lu / octal-hex-
 * decimal IP / localhost.evil.com → false. Substring (.includes) ASLA kullanılmaz.
 */
export function isLocalhostTarget(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false; // parse edilemeyen → RED
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false; // file:/data:/javascript: → RED
  if (u.username || u.password) return false; // user:pw@host injection → RED
  // Node URL.hostname IPv6'da köşeli parantezi KORUR ("[::1]") → soy.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  if (host === "::1") return true; // IPv6 loopback
  // 127.0.0.0/8 (tam dört-oktet, her oktet 0-255). NOT: WHATWG URL, http(s) special
  // scheme'de decimal/hex/octal IPv4'ü (2130706433 / 0x7f000001 / 0177.0.0.1)
  // dotted-decimal "127.0.0.1"e NORMALİZE eder — yani bunlar GERÇEKTEN loopback'tir,
  // başka host'a kaçamaz; kabul güvenli. (Ayrıca runner her zaman http://localhost:PORT
  // kurar; kodlanmış form pratikte hiç gelmez — bu yalnız defansif kapı.)
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return host
      .split(".")
      .every((o, i) => i === 0 || (Number(o) >= 0 && Number(o) <= 255));
  }
  return false; // 0.0.0.0, ::ffff:127.0.0.1, localhost.evil.com, public host → RED
}

/**
 * URL'i kanonik biçime indir (WHATWG `new URL().href`). Parse edilemezse null.
 * GÜVENLİK (I1): gate'in doğruladığı string ile dosyaya yazılan string AYNI olsun —
 * `new URL()` satır-içi kontrol char'ları (\r \n \t) sessizce siler, bu yüzden gate'e
 * verilen ham string ≠ kanonik olabilir; hep kanoniği kullan → enjeksiyon kaynakta ölür.
 */
function canonicalUrl(raw: string): string | null {
  try {
    return new URL(raw).href;
  } catch {
    return null;
  }
}

/**
 * Yıkıcı (state-değiştiren) GET-yol kalıpları. Non-destructive PAZARLIKSIZ değişmez:
 * katana default crawler keşfettiği her link'e GERÇEK GET atar → /logout, /delete?id=,
 * /admin/purge gibi GET-side-effect endpoint'leri tetiklenebilir. Bu kalıplar HEM
 * katana'ya `-crawl-out-scope` ile (crawl'da hiç ziyaret etme) HEM nuclei-listesi
 * filtresine (test etme) verilir — defense-in-depth. Go RE2 + JS ortak alt-küme.
 * Tek kaynak: PATTERN string'i; JS RegExp ondan türetilir.
 */
// Yıkıcı fiil, bir sınırlayıcıdan (/ = ? & - _ veya satır-başı) SONRA + ardından kelime-sınırı
// (\b) gelmeli → "/delete", "?action=delete", "/cache/clear" yakalanır; "/deleted" (salt-okunur
// görünüm), "/dropdown", "/preset" YAKALANMAZ (yanlış-pozitif azaltma). Go RE2 + JS ortak.
const DESTRUCTIVE_PATH_PATTERN =
  "(?i)([/=?&_-]|^)(log[-_]?out|sign[-_]?out|delete|destroy|purge|remove|drop|reset|revoke|deactivate|disable|wipe|truncate|flush|cancel|clear)\\b";
// JS RegExp: inline `(?i)` JS'te yok → prefix'i sıyır + `i` flag'i ver (Go RE2 string aynen katana'ya gider).
const DESTRUCTIVE_PATH_RE = new RegExp(
  DESTRUCTIVE_PATH_PATTERN.replace(/^\(\?i\)/, ""),
  "i",
);

/** Chat'e basılmadan önce nuclei alanını temizle (markdown/log injection + kontrol char). */
function sanitizeField(s: string, max = 120): string {
  return s
    .replace(/[\u0000-\u001f\u007f]/g, " ") // kontrol karakterleri
    .replace(/[`*_~|<>]/g, "") // markdown/HTML meta
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** nuclei -jsonl çıktısını ayrıştır. Bozuk satır atlanır; total = geçerli bulgu satırı. */
export function parseNucleiJsonl(stdout: string): DastSummary {
  const bySeverity: Record<string, number> = {};
  const findings: NucleiFinding[] = [];
  let total = 0;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t || !t.startsWith("{")) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // bozuk satır → atla
    }
    const info = (o.info ?? {}) as Record<string, unknown>;
    const sev = String(info.severity ?? "unknown").toLowerCase();
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
    total++;
    if (findings.length < 20) {
      findings.push({
        templateId: sanitizeField(String(o["template-id"] ?? ""), 80),
        severity: sanitizeField(sev, 16),
        name: sanitizeField(String(info.name ?? ""), 120),
        matchedAt: sanitizeField(
          String(o["matched-at"] ?? o["host"] ?? ""),
          160,
        ),
      });
    }
  }
  return { total, bySeverity, findings };
}

/**
 * katana çıktısından (plain: satır başına bir URL — sürüm-bağımsız, -jsonl şema
 * değişikliklerine bağımlı değil) taranacak URL listesini kur. GÜVENLİK-KRİTİK:
 *  - Her satır isLocalhostTarget()'ten geçer → off-host (CDN/dış-link) URL ATILIR
 *    (katana scope'tan kaçsa bile defense-in-depth: nuclei'ye dış host GİTMEZ).
 *  - baseUrl HER ZAMAN ilk + dahildir (cap'lense bile kök taranır).
 *  - MAX_SCAN_URLS tavanı (timeout/dev-server/argv koruması); aşılırsa capped=true
 *    → kapsam görünür bildirilir (sessiz kırpma YOK).
 * Set insertion-order → baseUrl ilk eklendiği için slice(0, cap) onu hep içerir.
 */
export function parseKatanaUrls(
  stdout: string,
  baseUrl: string,
): { urls: string[]; capped: boolean } {
  const all = new Set<string>();
  // baseUrl'i de NORMALİZE et (gate'le yazılan-değer eşit kalsın — I1 ile tutarlı).
  if (isLocalhostTarget(baseUrl)) all.add(canonicalUrl(baseUrl) ?? baseUrl);
  // Evrensel satır-sonu (\r\n | \r | \n) — yalnız \n'de bölmek, satır-içi \r ile
  // birden çok URL'in tek satıra sıkışmasına izin verirdi (I1 düşman-gözü bulgusu).
  for (const line of stdout.split(/\r\n|\r|\n/)) {
    const t = line.trim();
    if (!t) continue;
    // I1 SAVUNMA: ham satırda kontrol karakteri varsa AT (WHATWG new URL() onları
    // sessizce siler → gate "localhost" görür ama dosyaya ham \r/\t'li string yazılır →
    // nuclei -l satır-böler → off-host kaçağı). Kontrol-char taşıyan satıra hiç güvenme.
    if (/[\u0000-\u001f\u007f]/.test(t)) continue;
    const canon = canonicalUrl(t);
    if (!canon || !isLocalhostTarget(canon)) continue; // localhost-DIŞI / parse-fail → at
    if (DESTRUCTIVE_PATH_RE.test(canon)) continue; // I2 SAVUNMA: yıkıcı GET-yolu → nuclei'ye verme
    all.add(canon); // KANONİK biçim eklenir → dosyaya yazılan = gate'in doğruladığı
  }
  const unique = [...all];
  return { urls: unique.slice(0, MAX_SCAN_URLS), capped: unique.length > MAX_SCAN_URLS };
}

/** Tarama kapsamı — özette dürüstçe bildirilir (sahte "tüm proje" iddiası yok). */
export interface ScanCoverage {
  /** katana ile gezildi mi (true → çok-route; false → yalnız kök). */
  crawled: boolean;
  /** Taranan URL/route sayısı. */
  urlCount: number;
  /** MAX_SCAN_URLS tavanına takıldı mı (daha fazla route vardı). */
  capped: boolean;
  /** katana kurulu değil mi (kullanıcıya kurulum önerisi). */
  katanaMissing: boolean;
  /** Full Security: nuclei template'leri güncel CVE setine çekildi mi (true) / denenip
   *  başarısız (false) / hiç denenmedi (undefined). */
  templatesUpdated?: boolean;
}

/** Kapsamı tek satırda TR olarak betimle (özet başlığına eklenir). */
export function coverageLine(cov: ScanCoverage): string {
  if (cov.crawled) {
    if (cov.capped) {
      return `${cov.urlCount} route tarandı (ilk ${MAX_SCAN_URLS} ile sınırlandı — daha fazla route var; en kritik yüzeyi kapsar)`;
    }
    // I4 SAVUNMA: crawl çalıştı ama yalnız kök bulunduysa (client-side route'lu SPA /
    // her şeyi login'e yönlendiren auth-wall → katana headless'sız JS-route izleyemez)
    // "tüm proje tarandı" demek YALAN olur. Gerçek route keşfi (>1) varsa öyle de.
    return cov.urlCount > 1
      ? `tüm proje tarandı — ${cov.urlCount} route`
      : "yalnız ana sayfa tarandı (crawl ek route bulamadı — örn. client-side route'lu SPA; ek route'lar test EDİLMEDİ)";
  }
  if (cov.katanaMissing) {
    return (
      "yalnız ana sayfa tarandı — TÜM route'lar için crawler `katana` gerekli: " +
      "macOS `brew install katana` / Linux `go install github.com/projectdiscovery/katana/cmd/katana@latest`"
    );
  }
  return "yalnız ana sayfa tarandı (route keşfi/crawl başarısız)";
}

/** Özet bulgu raporunu (TR, sanitize'lı) kur. */
function formatSummary(
  target: string,
  s: DastSummary,
  cov: ScanCoverage,
): string {
  const scope =
    coverageLine(cov) +
    (cov.templatesUpdated === true
      ? " · güncel CVE template'leriyle"
      : cov.templatesUpdated === false
        ? " · template güncellenemedi, mevcutla tarandı"
        : "");
  if (s.total === 0) {
    return (
      `🛡️ Güvenlik taraması tamam: ${target} (${scope}) — bulgu yok.\n` +
      `Not: bu "tamamen güvenli" garantisi DEĞİL — yalnız nuclei template setinin bulduğu sorun yok.`
    );
  }
  const order = ["critical", "high", "medium", "low", "info", "unknown"];
  const sevLine = order
    .filter((k) => s.bySeverity[k])
    .map((k) => `${k}:${s.bySeverity[k]}`)
    .join(" ");
  const top = s.findings
    .slice(0, 8)
    .map((f) => `• [${f.severity}] ${f.name || f.templateId} — ${f.matchedAt}`)
    .join("\n");
  return (
    `⚠️ Güvenlik taraması tamam: ${target} (${scope}) — ${s.total} bulgu (${sevLine}).\n` +
    `${top}\n` +
    `Tam liste .mycl/audit.log'da. (Aktif tarama — bazı bulgular yanlış-pozitif olabilir.)`
  );
}

// ---------------------------------------------------------------------------
// I/O — hedef türetme + araç kontrolü + exec.
// ---------------------------------------------------------------------------

/** Bir aracın PATH'te olup olmadığı. POSIX `command -v` (mac+linux). Sessiz; hata → false. */
/** Arac PATH'te mi. Faz 17 karari da bunu kullanir (tek dogruluk kaynagi). */
export function toolInstalled(bin: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Çalışan dev server'ın localhost URL'ini bul. Host'u BİZ "localhost" olarak
 * kurarız (config'ten okumayız); yalnız PORT türetilir + canlılık prob edilir.
 * dev_server_pid ölü/yok ya da hiçbir aday port yanıt vermiyorsa null.
 */
async function resolveLocalhostTarget(state: State): Promise<string | null> {
  if (
    state.dev_server_pid === undefined ||
    !isProcessAliveSync(state.dev_server_pid)
  ) {
    return null; // çalışan app yok
  }
  // Aday portlar: dev komutundan türetilen + yaygın fallback'ler (dedup).
  let derived: number[] = [];
  try {
    const stack = detectStack(state.project_root);
    const scripts = readNodeScripts(state.project_root);
    const cmds = await devServerCandidates(stack, scripts); // profil `dev` öncelikli (KATI #1) → doğru port türetme
    derived = cmds.flatMap((c) =>
      expectedPortsFor(c, scripts, state.project_root),
    );
  } catch {
    /* türetilemedi → yalnız fallback'ler */
  }
  const candidates = [
    ...new Set([...derived, 5173, 3000, 8080, 5174, 4321, 8000]),
  ];
  for (const port of candidates) {
    if (port < 1 || port > 65535) continue;
    if (await waitForDevServer(port, PROBE_TIMEOUT_MS)) {
      const url = `http://localhost:${port}`;
      if (isLocalhostTarget(url)) return url; // defansif son-kapı
    }
  }
  return null;
}

/** Timeout'ta SIGTERM gönderildikten sonra SIGKILL'e tırmanma + force-resolve gecikmesi. */
const SIGKILL_GRACE_MS = 5_000;

/**
 * Bir aracı spawn et (detached process-group), byte-cap'li stdout topla, sabit
 * timeout'ta tree-kill (orphan yok). nuclei + katana ortak güvenlik kemeri — tek
 * yerde: detached grup + killProcessTree + safeEnv + çıktı tavanı. Asla throw etmez.
 *
 * HANG SAVUNMASI (I3 düşman-gözü): killProcessTree YALNIZ SIGTERM gönderir; bir Go
 * aracı SIGTERM'i yutar/uzun graceful-shutdown yaparsa `close` hiç fire etmeyebilir →
 * Promise sonsuza askıda kalır. Bu yüzden timeout'ta: (1) SIGTERM (killProcessTree),
 * (2) GRACE sonra SIGKILL (yakalanamaz) + `close`'u BEKLEMEDEN Promise'i ZORLA çöz.
 * `settled` guard → ikinci resolve no-op. Böylece dönüş timeoutMs+grace ile SINIRLI.
 */
type SpawnCappedResult = {
  stdout: string;
  timedOut: boolean;
  spawnError?: Error;
  // YZLLM 2026-06-23 (sessiz-fallback denetimi): stderr + exitCode YAKALANIR. Eskiden ikisi de yutuluyordu →
  // araç HATA verip (exit!=0, stderr dolu, stdout boş) "0 bulgu = temiz" sanılıyordu (false-clean güvenlik taraması).
  stderr: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
};

function spawnCapped(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<SpawnCappedResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        cwd,
        detached: true, // process-group lideri → killProcessTree tüm ağacı yakalar
        env: { ...safeEnv(), LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ stdout: "", timedOut: false, spawnError: e as Error, stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: SpawnCappedResult) => {
      if (settled) return; // idempotent — ilk çözüm kazanır
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(r);
    };
    child.stdout?.on("data", (d: Buffer) => {
      bytes += d.length;
      if (bytes <= MAX_OUTPUT_BYTES) stdout += d.toString("utf-8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      // Artık YUTULMAZ — cap'li biriktir; araç-hatasını (exit!=0 + stderr) tool-error ayrımı için consumer kullanır.
      errBytes += d.length;
      if (errBytes <= MAX_OUTPUT_BYTES) stderr += d.toString("utf-8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid); // 1) SIGTERM (grup)
      killTimer = setTimeout(() => {
        // 2) GRACE sonra hâlâ kapanmadıysa: SIGKILL (yakalanamaz) + close'u bekleme.
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL"); // grup
          } catch {
            /* zaten ölmüş olabilir */
          }
          try {
            process.kill(child.pid, "SIGKILL"); // lider (grup başarısızsa)
          } catch {
            /* zaten ölmüş olabilir */
          }
        }
        finish({ stdout, timedOut: true, stderr }); // ZORLA çöz — hang yok
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);
    child.on("error", (e: Error) => finish({ stdout, timedOut, spawnError: e, stderr }));
    child.on("close", (code, signal) => finish({ stdout, timedOut, stderr, exitCode: code, exitSignal: signal }));
  });
}

/**
 * nuclei'yi çalıştır. input: tek URL (`-u`) veya URL-listesi dosyası (`-l`, çok-route
 * tüm-proje taraması). Muhafazakar + non-destructive: yıkıcı/DoS/fuzz template'leri
 * hariç; düşük rate-limit (dev server'ı boğma); per-request timeout; OOB (interactsh) kapalı.
 */
/** SAF: nuclei argümanları (test edilebilir — yıkıcı dışlamanın her profilde durduğu kilitlenir). */
export function buildNucleiArgs(
  input: { kind: "url"; url: string } | { kind: "list"; file: string },
  profile: DastProfile,
  headers: string[] = [],
): string[] {
  const inputArgs = input.kind === "url" ? ["-u", input.url] : ["-l", input.file];
  return [
    ...inputArgs,
    ...headers.flatMap((h) => ["-H", h]), // autologin bypass çerezi (login'i gerçekten test et)
    "-jsonl",
    "-silent",
    "-no-interactsh",
    "-timeout",
    String(profile.nuclei.requestTimeoutSec),
    "-rate-limit",
    String(profile.nuclei.rateLimit),
    "-severity",
    profile.nuclei.severities,
    // PAZARLIKSIZ (her iki profilde): yıkıcı/DoS/fuzz şablonları asla koşmaz.
    "-exclude-tags",
    "intrusive,dos,fuzz",
  ];
}

function runNucleiCapped(
  input: { kind: "url"; url: string } | { kind: "list"; file: string },
  cwd: string,
  headers: string[] = [],
  profile: DastProfile = DAST_PROFILES.full,
): Promise<SpawnCappedResult> {
  const args = buildNucleiArgs(input, profile, headers);
  // Çok-route taraması daha uzun sürer → daha uzun (ama yine sabit/bounded) timeout.
  // Hızlı profil kendi dar tavanını dayatır (tek URL'de bile).
  const timeout =
    profile.id === "fast"
      ? profile.nuclei.timeoutMs
      : input.kind === "list"
        ? DAST_LIST_TIMEOUT_MS
        : DAST_TIMEOUT_MS;
  return spawnCapped("nuclei", args, cwd, timeout);
}

/**
 * katana ile çalışan app'i gez. DÜRÜST not (I2 düşman-gözü): katana default crawler
 * AKTİFTİR — keşfettiği her link'e GERÇEK GET atar (form-fill/headless YOK ama saf GET
 * bile /logout, /delete?id= gibi state-değiştiren GET endpoint'ini tetikler). Bu yüzden
 * non-destructive'i KORUMAK için `-crawl-out-scope` ile yıkıcı GET-yol kalıpları crawl'dan
 * DIŞLANIR (katana onları hiç ziyaret etmez); parseKatanaUrls aynı kalıbı nuclei
 * listesinden de eler (defense-in-depth). Scope host-bazlı (off-host link izlemez);
 * keşfedilen URL'ler parseKatanaUrls'te ayrıca isLocalhostTarget'tan geçer.
 * Plain çıktı (satır başına bir URL) — sürüm-bağımsız.
 */
/** SAF: katana argümanları (pasif + on-host olduğunun kilidi testte). */
export function buildKatanaArgs(url: string, profile: DastProfile, headers: string[] = []): string[] {
  return [
    ...headers.flatMap((h) => ["-H", h]), // örn. Cookie: mycl_no_autologin=1 (autologin bypass)
    "-u",
    url,
    "-silent",
    "-depth",
    String(profile.katana.depth),
    "-crawl-duration",
    profile.katana.crawlDuration, // katana kendi crawl süresini sınırlar
    "-rate-limit",
    String(profile.katana.rateLimit),
    "-timeout",
    "5",
    "-concurrency",
    "10",
    // I2 SAVUNMA: yıkıcı (state-değiştiren) GET-yollarını crawl'da hiç ziyaret etme.
    "-crawl-out-scope",
    DESTRUCTIVE_PATH_PATTERN,
    // headless (-hl) YOK, automatic-form-fill (-aff) YOK, no-scope (-ns) YOK → pasif + on-host.
  ];
}

function runKatanaCapped(
  url: string,
  cwd: string,
  headers: string[] = [],
  profile: DastProfile = DAST_PROFILES.full,
): Promise<SpawnCappedResult> {
  return spawnCapped("katana", buildKatanaArgs(url, profile, headers), cwd, profile.katana.timeoutMs);
}

/**
 * DAST'i çalıştır — onay SONRASI tek çağrı-noktasından (index.ts pendingDast
 * branch) çağrılır. Tüm fail yolları GÖRÜNÜR + fail-closed. Asla throw etmez
 * (DastResult döner; caller emitChatMessage + audit yapar).
 */
/** SAF (YZLLM 2026-06-19): nuclei severity → iş-kuyruğu önceliği (1=en yüksek). Bilinmeyen/info → en düşük. */
export function severityToPriority(sev: string): number {
  switch (String(sev).toLowerCase()) {
    case "critical":
      return 1;
    case "high":
      return 2;
    case "medium":
      return 3;
    case "low":
      return 4;
    default:
      return 5; // info / unknown
  }
}

/** SAF: bir güvenlik bulgusundan iş-kuyruğu metni (Faz-3 brief girişi olur). */
export function findingToTaskText(f: NucleiFinding): string {
  return (
    `[Güvenlik bulgusu — ${f.severity}] ${f.name}\n` +
    `Şablon: ${f.templateId} · Konum: ${f.matchedAt}\n` +
    `Bu zafiyeti GİDER: kök nedeni bul + düzelt (yamayla gizleme), düzeltmeyi doğrulayan test ekle.`
  );
}

/**
 * SAF: bulgu listesini templateId'ye göre TEKİLLEŞTİR (aynı zafiyet birçok URL'de → tek iş; per-URL
 * sel olmasın, doğru granülerlik = zafiyet-türü başına bir düzeltme). En yüksek severity korunur.
 */
export function dedupeFindingsByTemplate(findings: NucleiFinding[]): NucleiFinding[] {
  const byTemplate = new Map<string, NucleiFinding>();
  for (const f of findings) {
    const prev = byTemplate.get(f.templateId);
    if (!prev || severityToPriority(f.severity) < severityToPriority(prev.severity)) {
      byTemplate.set(f.templateId, f);
    }
  }
  return [...byTemplate.values()];
}

// nuclei community template'leri = "internette yayınlanan GÜNCEL açıklar/CVE'ler".
// Full Security (🛡️ buton) bunları son sürüme çeker; bounded + süreç-başına bir kez.
const TEMPLATE_UPDATE_TIMEOUT_MS = 120_000;
let _nucleiTemplatesUpdatedThisProcess = false;
async function ensureNucleiTemplatesUpdated(cwd: string): Promise<boolean> {
  if (_nucleiTemplatesUpdatedThisProcess) return true;
  const r = await spawnCapped("nuclei", ["-update-templates", "-silent"], cwd, TEMPLATE_UPDATE_TIMEOUT_MS);
  if (!r.spawnError && !r.timedOut) {
    _nucleiTemplatesUpdatedThisProcess = true;
    return true;
  }
  log.warn("dast-runner", "nuclei template güncellenemedi (mevcut template'lerle taranır)", {
    timedOut: r.timedOut,
    err: r.spawnError?.message,
  });
  return false;
}

export async function runDast(
  state: State,
  opts?: { updateTemplates?: boolean; noAutologin?: boolean; profile?: DastProfileId },
): Promise<DastResult> {
  // Profil VARSAYILANI "full" → 🛡️ butonunun bugünkü davranışı BİREBİR korunur (KATI #14).
  // Faz 17'nin otomatik koşumu "fast" geçer. Açık `opts` alanları profili EZER (geriye uyum).
  const profile = DAST_PROFILES[opts?.profile ?? "full"];
  // YZLLM 2026-06-20: login modülünü autologin BYPASS'lamadan test et — `mycl_no_autologin`
  // çerezi katana+nuclei'ye eklenir → app otomatik dev-oturumu açmaz, gerçek login akışı taranır.
  const headers = opts?.noAutologin ? ["Cookie: mycl_no_autologin=1"] : [];
  const plat = platform();
  if (plat !== "darwin" && plat !== "linux") {
    return {
      ok: false,
      summary_tr:
        "🛡️ DAST yalnız macOS ve Linux'ta desteklenir (bu platform kapsam dışı).",
      error: "unsupported_platform",
    };
  }
  const target = await resolveLocalhostTarget(state);
  if (!target) {
    return {
      ok: false,
      summary_tr:
        "❌ Çalışan localhost uygulaması bulunamadı. Önce uygulamayı çalıştır (▶ Çalıştır / Faz 5), sonra taramayı tekrar dene.",
      error: "no_target",
    };
  }
  // Sessiz fallback YASAK: nuclei yoksa görünür hata + dur (sahte-yeşil yok).
  if (!toolInstalled("nuclei")) {
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: state.current_phase,
      event: "dast-tool-missing",
      caller: "mycl-orchestrator",
    }).catch(() => {});
    return {
      ok: false,
      summary_tr:
        "❌ Güvenlik taraması aracı `nuclei` kurulu değil — tarama YAPILMADI (sahte-yeşil yok).\n" +
        "Kurulum:\n" +
        "• macOS: `brew install nuclei`\n" +
        "• Linux: `go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest`\n" +
        "Kurduktan sonra butona tekrar bas.",
      error: "nuclei_not_installed",
    };
  }

  // TÜM PROJE: önce katana ile gez → tüm localhost route'larını keşfet → nuclei'ye besle.
  // katana yoksa → görünür "yalnız kök" notu (sessiz fallback değil; kapsam yalanlanmaz).
  let scanUrls = [target];
  const cov: ScanCoverage = {
    crawled: false,
    urlCount: 1,
    capped: false,
    katanaMissing: false,
  };
  // Full Security (🛡️ buton): internette yayınlanan GÜNCEL açıkları/CVE'leri tara → önce
  // nuclei template'lerini son sürüme çek. Yalnız `updateTemplates` verildiğinde (hafif
  // koşumlar template çekmez).
  if (opts?.updateTemplates ?? profile.updateTemplates) {
    cov.templatesUpdated = await ensureNucleiTemplatesUpdated(state.project_root);
  }
  if (profile.katana.enabled && toolInstalled("katana")) {
    log.info("dast-runner", "crawling app with katana", { target, profile: profile.id });
    const cr = await runKatanaCapped(target, state.project_root, headers, profile);
    if (cr.spawnError || cr.timedOut) {
      // crawl başarısız → kök taramaya düş (görünür: coverageLine "crawl başarısız" der).
      log.warn("dast-runner", "katana crawl failed (root-only scan)", {
        timedOut: cr.timedOut,
        err: cr.spawnError?.message,
      });
    } else {
      const parsed = parseKatanaUrls(cr.stdout, target);
      // Profil tavanı (hızlı profil daha dar) — kapsam DÜRÜSTÇE capped olarak bildirilir.
      scanUrls = parsed.urls.slice(0, profile.maxScanUrls);
      cov.crawled = true;
      cov.capped = parsed.capped || parsed.urls.length > profile.maxScanUrls;
      cov.urlCount = scanUrls.length;
    }
  } else {
    cov.katanaMissing = true;
  }

  // nuclei input: tek URL → -u; çok-route → -l geçici dosya (büyük argv/E2BIG'den kaçın).
  // Geçici dosya yaşam-döngüsü try/finally ile (orphan dosya yok).
  log.info("dast-runner", "starting nuclei scan", {
    target,
    urls: scanUrls.length,
    crawled: cov.crawled,
  });
  let listFile: string | undefined;
  try {
    let result: SpawnCappedResult;
    if (scanUrls.length <= 1) {
      result = await runNucleiCapped({ kind: "url", url: target }, state.project_root, headers, profile);
    } else {
      // I3(B) SAVUNMA: writeFileSync ENOSPC/EACCES atabilir → runDast "asla throw etmez"
      // sözleşmesini KORU (her çağıran için), throw etme — görünür hata DastResult'ı dön.
      listFile = join(tmpdir(), `mycl-dast-${process.pid}-${Date.now()}.txt`);
      try {
        writeFileSync(listFile, scanUrls.join("\n") + "\n", "utf-8");
      } catch (e) {
        return {
          ok: false,
          summary_tr: `❌ Geçici tarama listesi yazılamadı (disk/izin): ${sanitizeField(String((e as Error)?.message ?? e), 160)}`,
          error: "list_write_failed",
        };
      }
      result = await runNucleiCapped({ kind: "list", file: listFile }, state.project_root, headers, profile);
    }
    const { stdout, timedOut, spawnError, stderr, exitCode } = result;
    if (timedOut) {
      const limit =
        (profile.id === "fast"
          ? profile.nuclei.timeoutMs
          : scanUrls.length > 1
            ? DAST_LIST_TIMEOUT_MS
            : DAST_TIMEOUT_MS) / 1000;
      return {
        ok: false,
        summary_tr: `⏱ Güvenlik taraması ${limit}s sınırında durduruldu (takılma koruması; ${cov.urlCount} route). Hedef: ${target}.`,
        error: "timeout",
      };
    }
    if (spawnError) {
      log.warn("dast-runner", "nuclei spawn error", spawnError.message);
      return {
        ok: false,
        summary_tr: `❌ Güvenlik taraması başlatılamadı: ${sanitizeField(spawnError.message, 200)}`,
        error: "spawn_error",
      };
    }
    // nuclei bulgu bulunca exit kodu !=0 dönebilir — çıktıyı yine PARSE et
    // (semgrep exit-2 dersi: exit kodunu fail sayma, stdout'u oku).
    const summary = parseNucleiJsonl(stdout);
    // TOOL-ERROR ayrımı (sessiz-fallback denetimi): bulgu varken exit!=0 + stdout'ta JSONL (total>0) gelir.
    // AMA total==0 + exit!=0 (sayısal) + stderr'de hata imzası = nuclei HATA verdi (template/config/ağ) — temiz
    // tarama exit 0 dönerdi. "0 bulgu = temiz" SANMA (false-clean güvenlik taraması). Görünür tool-error.
    if (
      summary.total === 0 &&
      typeof exitCode === "number" &&
      exitCode !== 0 &&
      /error|failed|panic|cannot|unable|no such|fatal|could not|invalid/i.test(stderr)
    ) {
      log.warn("dast-runner", "nuclei tool error (exit!=0, 0 bulgu, stderr-hata) — false-clean önlendi", {
        exitCode,
        stderr: stderr.slice(0, 300),
      });
      return {
        ok: false,
        summary_tr: `❌ Güvenlik taraması aracı (nuclei) HATA verdi (exit ${exitCode}) — "0 bulgu" GÜVENİLİR DEĞİL (tarama tamamlanmadı, temiz değil): ${sanitizeField(stderr, 160)}`,
        error: "tool_error",
      };
    }
    return {
      ok: true,
      findings_count: summary.total,
      summary, // bulgu detayları → caller iş kuyruğuna sistem işi olarak yazabilir
      summary_tr: formatSummary(target, summary, cov),
    };
  } finally {
    if (listFile) {
      try {
        rmSync(listFile, { force: true });
      } catch {
        /* geçici dosya temizliği best-effort */
      }
    }
  }
}
