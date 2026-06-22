// csp-compliance.ts — Faz 5 (UI codegen) çıktısının %100 CSP-uyumluluğunu DETERMİNİSTİK garanti eder.
//
// YZLLM 2026-06-17: "Faz 5'in yaptığı her iş %100 CSP uyumlu olsun, unsafe etiketler kullanmasın."
// Talimat-only yetmedi (canlı test: ajan kodu CSP-temiz yazdı AMA index.html'e katı CSP meta-tag'i
// EKLEMEDİ → tarayıcı politikayı zorlamıyordu). Bu modül iki deterministik kontrol verir:
//   1) scanCspViolations — üretilen kodda `unsafe-inline`/`unsafe-eval` GEREKTİREN yapıları tarar
//      (inline event handler, eval/new Function, string-gövdeli timer, javascript: URL, inline style,
//      CSP-tanımında unsafe-* token). Bunlar deterministik düzeltilemez (kod mantığı) → Faz 5 fail,
//      ajan düzeltir. (Meta'yı bunlar VARKEN eklemek uygulamayı kırardı; o yüzden önce tarama.)
//   2) ensureCspMeta — kod temizken index.html'e (Vite/static) katı CSP meta-tag'i YOKSA EKLER
//      (ajan atlasa bile MyCL kendisi shipler → %100). unsafe-* İÇERMEYEN tek bir politika.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import { log } from "./logger.js";

/** unsafe-* İÇERMEYEN katı baseline CSP. Faz 5 kodu zaten buna uyacak şekilde üretilir. */
export const STRICT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

export interface CspViolation {
  file: string;
  line: number;
  kind: string;
  snippet: string;
}

export interface CspMetaResult {
  action: "added" | "present" | "no-html";
  file?: string;
}

// Taranacak kaynak uzantıları (UI kodu + giriş HTML'i).
const SCAN_EXTS = new Set([".html", ".htm", ".jsx", ".tsx", ".js", ".ts", ".vue", ".svelte", ".mjs", ".cjs"]);
// Üretim/araç dizinleri — tarama dışı (yalnız PROJE kaynağı önemli).
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".mycl", "dist", "build", "coverage", ".next", "out", "devs", "public",
]);
// Test/spec dosyaları TAMAMEN tarama-DIŞI: fixture'ları meşru 'unsafe-inline' ÖRNEKLERİ içerebilir
// (uygulama davranışı DEĞİL). YZLLM 2026-06-17 canlı bulgu: csp.test.js fixture'ı yanlış-flag'leniyordu.
const TEST_FILE_RE = /\.(test|spec)\.(jsx?|tsx?|mjs|cjs)$/i;
// Build/araç config (vite.config, next.config, …): eval/inline-style gibi build-zamanı yapıları yanlış-pozitif
// verir → GENEL tarama-DIŞI. AMA Next.js/Vite header-CSP'si TAM BURADA tanımlanır → yalnız CSP `unsafe-*`
// token'ı için TARANIR (YZLLM 2026-06-19: dev-CSP'de DE unsafe yasak — dev carve-out'u config'e kaçmasın).
const CONFIG_FILE_RE = /\.config\.(js|ts|mjs|cjs)$/i;
// Giriş HTML adayları (Vite kökü, CRA public, src). İlk bulunan kullanılır.
const HTML_CANDIDATES = ["index.html", "public/index.html", "src/index.html"];

/**
 * SAF: tek satırda CSP-ihlali (unsafe-* gerektiren yapı) var mı → kind listesi.
 * Word-boundary'li basit pattern'ler (false-positive minimal: "retrieval(" ≠ eval).
 */
export function violationsInLine(line: string): string[] {
  const hits: string[] = [];
  // Tam yorum satırı (//, * , /* , #) → içindeki `eval()` / 'unsafe-inline' örnek/açıklamadır,
  // GERÇEK kod değil (YZLLM 2026-06-18 canlı: nonce middleware'in açıklama yorumları + dev-dalı
  // yanlış-pozitif veriyordu → Faz 5 false-fail). Kod satırlarını tara. Stack-bağımsız (//, JSDoc *, #).
  if (/^\s*(?:\/\/|\*|\/\*|#)/.test(line)) return hits;
  // Inline HTML event handler: on...="  veya  on...='  — JSX `onClick={...}` ({ ile) HARİÇ (CSP-safe).
  if (/\bon[a-zA-Z]+\s*=\s*["']/.test(line)) hits.push("inline-event-handler");
  // eval / new Function — unsafe-eval.
  if (/\beval\s*\(/.test(line) || /\bnew\s+Function\s*\(/.test(line)) hits.push("eval");
  // String-gövdeli timer: setTimeout("code") / setInterval('code') — unsafe-eval.
  if (/\bset(?:Timeout|Interval)\s*\(\s*["'`]/.test(line)) hits.push("string-timer");
  // javascript: URL (href/src/string içinde) — inline script eşdeğeri.
  if (/["'(\s=]javascript:/.test(line)) hits.push("javascript-url");
  // Inline style: style="..."  veya  React style={{...}} — style-src 'unsafe-inline' gerektirir.
  if (/\bstyle\s*=\s*["']/.test(line) || /\bstyle\s*=\s*\{\{/.test(line)) hits.push("inline-style");
  // CSP tanımında GERÇEK unsafe-* directive — TIRNAK içinde ('unsafe-inline'/'unsafe-eval', CSP söz dizimi).
  // YZLLM 2026-06-19: DEV DAHİL hiç unsafe-* YOK — eski dev-only (NODE_ENV!=='production' / isDev / __DEV__ /
  // import.meta.env.DEV …) carve-out'u KALDIRILDI. Fast Refresh için bile unsafe-eval yazılmaz (anlık-yenileme
  // bozulur → manuel yenileme; "güvenlik > dev-konfor", YZLLM "bu çok önemli"). Yorum satırları line 55'te elenir.
  if (/['"]unsafe-(?:inline|eval)['"]/.test(line)) hits.push("unsafe-token");
  return hits;
}

async function walk(dir: string, root: string, out: CspViolation[]): Promise<void> {
  // errno-AYRIMI (sessiz-fallback denetimi): ENOENT/ENOTDIR = gerçekten yok (meşru). AMA dizin VAR ama
  // okunamıyorsa (EACCES/EIO) bu alt-ağaç TARANMADI → boş-liste "temiz" sanmak FALSE-CLEAN güvenlik taraması.
  // "scan-incomplete" sentinel'i push et → çağıran non-empty görüp fail-closed davranır (eksik tarama ≠ temiz).
  const entries = await readdir(dir, { withFileTypes: true }).catch((e: { code?: string }) => {
    if (e.code !== "ENOENT" && e.code !== "ENOTDIR") {
      log.error("csp", "CSP taraması: dizin okunamadı — alt-ağaç taranmadı (fail-closed)", { dir, code: e.code });
      out.push({ file: relative(root, dir), line: 0, kind: "scan-incomplete", snippet: `[dizin okunamadı: ${e.code}] CSP taraması EKSİK` });
    }
    return [];
  });
  for (const e of entries) {
    const name = String(e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      await walk(join(dir, name), root, out);
    } else if (SCAN_EXTS.has(extname(name)) && !TEST_FILE_RE.test(name)) {
      const p = join(dir, name);
      let content: string;
      try {
        content = await readFile(p, "utf-8");
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "ENOENT") {
          // Taranabilir dosya VAR ama okunamadı → ihlali kaçırırız → "temiz" sanma. Sentinel + görünür.
          log.error("csp", "CSP taraması: kaynak dosya okunamadı — taranmadı (fail-closed)", { file: relative(root, p), code });
          out.push({ file: relative(root, p), line: 0, kind: "scan-incomplete", snippet: `[dosya okunamadı: ${code}] CSP taraması EKSİK` });
        }
        continue;
      }
      // Config dosyaları (vite.config/next.config): yalnız CSP unsafe-token al — build-zamanı
      // eval/inline-style yapıları runtime CSP-ihlali değil (yanlış-pozitif).
      const cspTokenOnly = CONFIG_FILE_RE.test(name);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const kind of violationsInLine(lines[i])) {
          if (cspTokenOnly && kind !== "unsafe-token") continue;
          out.push({ file: relative(root, p), line: i + 1, kind, snippet: lines[i].trim().slice(0, 120) });
        }
      }
    }
  }
}

/** İMPURE: projeyi tara → CSP-ihlali (unsafe-* gerektiren) satırların listesi (boş = temiz). */
export async function scanCspViolations(projectRoot: string): Promise<CspViolation[]> {
  const out: CspViolation[] = [];
  await walk(projectRoot, projectRoot, out);
  return out;
}

/**
 * İMPURE: giriş HTML'inde katı CSP meta-tag YOKSA ekler (deterministik, unsafe-* içermez).
 * Zaten varsa "present", HTML bulunamazsa "no-html" (Next/SSR gibi — gate skip, çağıran loglar).
 * ÖNEMLİ: yalnız scanCspViolations TEMİZ döndükten sonra çağrılmalı (ihlal varken meta uygulamayı kırardı).
 */
export async function ensureCspMeta(projectRoot: string): Promise<CspMetaResult> {
  for (const rel of HTML_CANDIDATES) {
    const p = join(projectRoot, rel);
    let html: string;
    try {
      html = await readFile(p, "utf-8");
    } catch (e) {
      // ENOENT = bu aday yok (meşru, sonrakine bak). Diğer hata (EACCES) = var ama okunamadı → görünür kıl.
      const code = (e as { code?: string }).code;
      if (code !== "ENOENT") {
        log.error("csp", "ensureCspMeta: HTML adayı VAR ama okunamadı", { file: rel, code });
      }
      continue;
    }
    if (/Content-Security-Policy/i.test(html)) return { action: "present", file: rel };
    const meta = `    <meta http-equiv="Content-Security-Policy" content="${STRICT_CSP}" />\n`;
    let next: string;
    if (/<head[^>]*>/i.test(html)) {
      next = html.replace(/(<head[^>]*>)/i, `$1\n${meta}`);
    } else if (/<html[^>]*>/i.test(html)) {
      next = html.replace(/(<html[^>]*>)/i, `$1\n  <head>\n${meta}  </head>`);
    } else {
      next = meta + html; // <head>/<html> yok (parça HTML) → başa ekle
    }
    await writeFile(p, next, "utf-8");
    return { action: "added", file: rel };
  }
  return { action: "no-html" };
}
