// guide-pdf — proje-içi PDF kullanım kılavuzu (headless Chromium + page.pdf()).
//
// living-docs `.mycl/user-guide.md` (Türkçe, "## Nasıl: <görev>") metnini + (dev server
// ayaktaysa) rota ekran görüntülerini birleştirip <project>/public/docs/kullanim-kilavuzu.pdf
// üretir. page.pdf() YALNIZ headless Chromium → orchestrator'a `playwright` dep eklendi
// (Ümit kararı); chromium npm-install'da SKIP (.npmrc — CI hafif), RUNTIME'da lazy install
// (`npx playwright install chromium`). Pipeline-end non-blocking yan-yarar; precondition
// yoksa GÖRÜNÜR skip; ASLA throw etmez (prototype-cache/csp-check fail-closed deseni).

import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { appendAudit } from "./audit.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import type { State } from "./types.js";

const GUIDE_REL = join(".mycl", "user-guide.md");
const FEATURES_REL = join(".mycl", "features.md");
const PDF_REL = join("public", "docs", "kullanim-kilavuzu.pdf");
const CANDIDATE_PORTS = [5173, 5174, 4173, 3000, 8080, 4321];
const MAX_ROUTES = 8;

// guide-pdf.js dist/'te → ".." orchestrator kökü (playwright + npx burada).
const ORCH_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** SAF: features.md'den ss alınacak rotaları çıkar. "`/route`" backtick-yolları +
 *  her zaman "/". Dedup + cap. (Sezgisel — bulunamazsa yalnız "/".) */
export function extractRoutesFromFeatures(featuresMd: string): string[] {
  const routes = new Set<string>(["/"]);
  for (const m of featuresMd.matchAll(/`(\/[A-Za-z0-9._\-/:]*)`/g)) {
    let r = m[1]!;
    if (r.includes("://")) continue; // URL değil, yol
    r = r.replace(/\/+$/, "") || "/";
    if (r.length <= 40) routes.add(r);
    if (routes.size >= MAX_ROUTES) break;
  }
  return [...routes];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** SAF: kullanım-kılavuzu markdown'ını basit HTML'e çevir (## / ### başlık, **kalın**,
 *  "1." / "-" liste, paragraf). Format living-docs üretimi (kontrollü) — minimal yeter. */
export function markdownToHtml(md: string): string {
  const inline = (t: string): string =>
    escapeHtml(t).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const out: string[] = [];
  let listType: "ol" | "ul" | null = null;
  const closeList = (): void => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const h3 = /^###\s+(.*)$/.exec(line);
    const h2 = /^##\s+(.*)$/.exec(line);
    const h1 = /^#\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (h3) {
      closeList();
      out.push(`<h3>${inline(h3[1]!)}</h3>`);
    } else if (h2) {
      closeList();
      out.push(`<h2>${inline(h2[1]!)}</h2>`);
    } else if (h1) {
      closeList();
      out.push(`<h1>${inline(h1[1]!)}</h1>`);
    } else if (ol) {
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inline(ol[1]!)}</li>`);
    } else if (ul) {
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inline(ul[1]!)}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join("\n");
}

/** SAF: tam HTML belgesi (stil + kılavuz gövdesi + ss görselleri base64). */
export function buildGuideHtml(
  title: string,
  bodyHtml: string,
  shots: Array<{ route: string; dataUri: string }>,
): string {
  const shotHtml = shots
    .map(
      (s) =>
        `<figure><figcaption>Ekran: <code>${escapeHtml(s.route)}</code></figcaption>` +
        `<img src="${s.dataUri}" /></figure>`,
    )
    .join("\n");
  return [
    "<!doctype html><html lang='tr'><head><meta charset='utf-8'><style>",
    "body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222;line-height:1.5;padding:24px;max-width:760px;margin:auto}",
    "h1{font-size:24px;border-bottom:2px solid #4a9eff;padding-bottom:6px}h2{font-size:18px;margin-top:24px;color:#1a1a1a}h3{font-size:15px;color:#444}",
    "ol,ul{padding-left:22px}li{margin:3px 0}p{margin:8px 0}",
    "figure{margin:16px 0;page-break-inside:avoid}figcaption{font-size:12px;color:#666;margin-bottom:4px}",
    "img{max-width:100%;border:1px solid #ddd;border-radius:6px}code{background:#f3f3f3;padding:1px 4px;border-radius:3px}",
    "</style></head><body>",
    `<h1>${escapeHtml(title)}</h1>`,
    bodyHtml,
    shots.length > 0 ? "<h2>Ekran Görüntüleri</h2>" + shotHtml : "",
    "</body></html>",
  ].join("\n");
}

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
    emitChatMessage("system", "📄 PDF kılavuz için Chromium kuruluyor (ilk sefer, ~1 dk)…");
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
 * IMPURE: pipeline-end. user-guide.md varsa PDF üret (dev server ayaktaysa rota ss'leri
 * dahil, değilse metin-only). chromium yoksa lazy kur; kurulamıyorsa GÖRÜNÜR skip.
 * ASLA throw etmez. Web-UI olmayan (skip_ui_phases) projede no-op.
 */
export async function generateGuidePdf(state: State): Promise<void> {
  let browser: Browser | null = null;
  try {
    if (state.skip_ui_phases) return; // UI yok → kullanım kılavuzu PDF'i anlamsız
    const guidePath = join(state.project_root, GUIDE_REL);
    let guideMd: string;
    try {
      guideMd = (await fs.readFile(guidePath, "utf-8")).trim();
    } catch {
      return; // user-guide.md yok (living-docs üretmedi) → no-op
    }
    if (!guideMd) return;

    browser = await launchChromium();
    if (!browser) {
      emitChatMessage(
        "system",
        "ℹ️ PDF kılavuz üretilemedi — Chromium kurulamadı. Manuel: `npx playwright install chromium`.",
      );
      return;
    }
    const page = await browser.newPage();

    // Dev server ayaktaysa rota ss'leri (best-effort). Değilse metin-only PDF.
    // HTTP probe yetkilidir (pid canlı ama server hazır olmayabilir ya da tersi).
    const shots: Array<{ route: string; dataUri: string }> = [];
    const port = await detectLivePort();
    if (port) {
      let routes = ["/"];
      try {
        const feat = await fs.readFile(join(state.project_root, FEATURES_REL), "utf-8");
        routes = extractRoutesFromFeatures(feat);
      } catch {
        /* features.md yok → yalnız "/" */
      }
      for (const route of routes) {
        try {
          await page.goto(`http://localhost:${port}${route}`, {
            waitUntil: "networkidle",
            timeout: 8000,
          });
          const buf = await page.screenshot({ fullPage: true });
          shots.push({ route, dataUri: `data:image/png;base64,${buf.toString("base64")}` });
        } catch {
          /* bu rota ss alınamadı → atla */
        }
      }
    }

    const html = buildGuideHtml("Kullanım Kılavuzu", markdownToHtml(guideMd), shots);
    await page.setContent(html, { waitUntil: "load" });
    const outPath = join(state.project_root, PDF_REL);
    await fs.mkdir(dirname(outPath), { recursive: true });
    await page.pdf({ path: outPath, format: "A4", printBackground: true, margin: { top: "16mm", bottom: "16mm", left: "12mm", right: "12mm" } });

    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: state.current_phase,
      event: "guide-pdf-generated",
      caller: "mycl-orchestrator",
      detail: `path=${PDF_REL} shots=${shots.length}`,
    }).catch(() => {});
    emitChatMessage(
      "system",
      `📄 Kullanım kılavuzu PDF'i üretildi: \`${PDF_REL}\`${shots.length > 0 ? ` (${shots.length} ekran görüntüsü dahil)` : " (metin; dev server kapalıydı, ekran görüntüsü yok)"}.`,
    );
  } catch (err) {
    log.warn("guide-pdf", "generateGuidePdf failed (non-fatal)", err);
  } finally {
    await browser?.close().catch(() => {});
  }
}
