#!/usr/bin/env node
// entry-graph-check — uygulamanın GİRİŞ ZİNCİRİ sağlam mı? STACK BAĞIMSIZ.
//
// NEDEN (cüzdan projesi, 2026-09-17): MyCL 27 dosyalık bir uygulama yazdı — bileşenler, sayfalar,
// oturum yönetimi, tema, i18n hepsi yerindeydi. Ama `index.html` `/src/main.jsx` çağırıyordu ve o
// dosya HİÇ yazılmamıştı. React hiçbir yere bağlanmadığı için ekran bomboştu. Buna rağmen hiçbir
// kapı bunu görmedi: "teslim edilebilir var mı?" ölçütü klasörde görünür bir şey arıyor, içeriğe
// bakmıyor. Kullanıcı günlerce çalışmayan bir uygulamaya baktı.
//
// ÖLÇTÜĞÜ ŞEY BİR OLGUDUR, YORUM DEĞİL: "bu HTML, diskte OLMAYAN yerel bir dosyayı referanslıyor."
// HTML semantiği her ekosistemde aynıdır → hiçbir dile/çerçeveye bağlı değil (KATI #1).
//
// YANLIŞ ALARM YASAĞI (bu betiğin en sert kuralı): bir yanlış pozitif Faz 10'u düşürür ve pipeline'ı
// bloklar. Bu yüzden yalnız TARTIŞMASIZ durumlar bulgu olur; çözemediğim her şey ATLANIR ve şüphede
// "ölçemedim" (çıkış 3) denir — asla "bulgu var" (çıkış 1) denmez.
//
// Çıkış: 0 = zincir sağlam · 1 = kırık referans (belirgin) · 3 = ölçülemedi (atlama, "temiz" DEĞİL)

import { promises as fs } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";

const projectRoot = process.argv[2] ?? process.cwd();

// Taranmayan dizinler: üretilen/dış kod. Build çıktısındaki kırık yol bizim sorunumuz değil.
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".mycl", "devs", "dist", "build", "out", ".next", ".nuxt", ".output",
  "vendor", "target", "coverage", ".venv", "venv", "__pycache__", ".cache", ".turbo",
  "Pods", "DerivedData", ".gradle", ".svelte-kit", "bower_components", "third_party", "error_folder",
]);
const MAX_HTML = 50;
const MAX_BYTES = 2 * 1024 * 1024;

/** Uzantısız referanslar için denenecek sonekler (bundler çözümlemesinin sade karşılığı). */
const TRY_EXT = ["", ".js", ".mjs", ".jsx", ".ts", ".tsx", ".vue", ".svelte"];
/** Dizin referansında denenecek giriş dosyaları. */
const TRY_INDEX = ["index.js", "index.mjs", "index.jsx", "index.ts", "index.tsx"];
/**
 * STATİK KÖK KLASÖRLERİ: içerikleri kök URL'den servis edilir, yani `public/styles.css` tarayıcıya
 * `/styles.css` olarak gider. CANLI YANLIŞ ALARM (2026-09-18): bunu bilmediğim için `public/` altına
 * yazılmış bir stil dosyasını "diskte yok" sanıp Faz 10'u düşürdüm ve pipeline'ı blokladım — tam da
 * bu betiğin kaçınmak zorunda olduğu hata. Kök-göreli her referans bu klasörlerde de aranır.
 */
const STATIC_ROOTS = ["public", "static", "www", "assets", "dist", "build"];

async function collectHtml(dir, acc = []) {
  if (acc.length >= MAX_HTML) return acc;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (acc.length >= MAX_HTML) break;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await collectHtml(full, acc);
    else if (e.isFile() && /\.html?$/i.test(e.name)) acc.push(full);
  }
  return acc;
}

/**
 * Bu referansı ÇÖZEMEZ miyiz? Çözemediğimiz her şey atlanır — iddia üretmeyiz.
 * Kapsanan kaçışlar: mutlak URL, protokolsüz URL, data/blob, çapa, sorgu dizesi, şablon motoru
 * yer tutucuları (Jinja/Django, EJS/ERB, Handlebars, CRA), Vite sanal yolları, ortam değişkenleri.
 */
function cozulemez(ref) {
  if (!ref || !ref.trim()) return true;
  const r = ref.trim();
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(r) ||      // http:, https:, data:, blob:, mailto:
    r.startsWith("//") ||                   // protokolsüz mutlak
    r.startsWith("#") ||                    // çapa
    r.includes("?") ||                      // sorgu dizesi (cache-bust, versiyon)
    r.includes("{{") || r.includes("}}") || // Handlebars / Jinja / Vue
    r.includes("{%") || r.includes("%}") || // Jinja / Django / Liquid
    r.includes("<%") || r.includes("%>") || // EJS / ERB / ASP
    r.includes("${") ||                     // şablon dizesi
    r.includes("%PUBLIC_URL%") ||           // CRA
    r.includes("$") ||                      // PHP/Blade değişkeni
    r.startsWith("/@")                      // Vite sanal modül (/@vite/client)
  );
}

/** Referansı diskte ara. "yes" bulundu · "no" kesinlikle yok · "unknown" karar veremedim. */
async function cozumle(ref, htmlFile) {
  const temiz = ref.trim().split("#")[0];
  if (!temiz) return "unknown";
  // Köke göreli ("/src/main.jsx") ya da dosyaya göreli ("./main.jsx").
  // Kök-göreli referans ("/styles.css") hem proje kökünde hem statik kök klasörlerinde aranır;
  // dosyaya göreli ("./main.jsx") yalnız HTML'in yanında.
  const adaylar = temiz.startsWith("/")
    ? [join(projectRoot, temiz.slice(1)), ...STATIC_ROOTS.map((r) => join(projectRoot, r, temiz.slice(1)))]
    : [resolve(dirname(htmlFile), temiz)];
  for (const taban of adaylar) {
    // Proje kökünün DIŞINA çıkan referans bizim ölçemeyeceğimiz bir şeydir.
    if (!resolve(taban).startsWith(resolve(projectRoot) + sep)) return "unknown";
    for (const ext of TRY_EXT) {
      try {
        const st = await fs.stat(taban + ext);
        if (st.isFile()) return "yes";
        if (st.isDirectory()) {
          for (const idx of TRY_INDEX) {
            try {
              if ((await fs.stat(join(taban + ext, idx))).isFile()) return "yes";
            } catch { /* sıradaki */ }
          }
        }
      } catch { /* sıradaki uzantı */ }
    }
  }
  return "no";
}

const htmlFiles = await collectHtml(projectRoot);
if (htmlFiles.length === 0) {
  process.stdout.write("entry-graph: taranacak HTML giriş dosyası yok — bu boyut ÖLÇÜLEMEDİ ('temiz' sayılmaz)\n");
  process.exit(3);
}

const kirik = [];
let bakilan = 0;
for (const f of htmlFiles) {
  let html;
  try {
    const st = await fs.stat(f);
    if (st.size > MAX_BYTES) continue;
    html = await fs.readFile(f, "utf-8");
  } catch {
    continue;
  }
  const rel = f.slice(projectRoot.length + 1);
  // YALNIZ script src ve stylesheet href — uygulamayı ayağa kaldıran zincir budur.
  // <img>, <a>, <video> bilerek DIŞARIDA: eksik bir görsel uygulamayı çalışmaz yapmaz.
  const refs = [
    ...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi),
    ...html.matchAll(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*\bhref\s*=\s*["']([^"']+)["']/gi),
  ].map((m) => m[1]);
  for (const ref of refs) {
    if (cozulemez(ref)) continue;
    const sonuc = await cozumle(ref, f);
    // "unknown" SAYILMAZ: çözemediğim bir referansı ne kırık ne sağlam ilan ederim. Sayaca dahil
    // etmek onu sessizce "sağlam" tarafına yazardı — ölçemediğine olumlu iddia da bir iddiadır.
    if (sonuc === "unknown") continue;
    bakilan++;
    if (sonuc === "no") kirik.push({ file: rel, ref: ref.trim() });
  }
}

if (bakilan === 0) {
  process.stdout.write("entry-graph: çözülebilir yerel referans bulunamadı — bu boyut ÖLÇÜLEMEDİ\n");
  process.exit(3);
}
if (kirik.length > 0) {
  process.stdout.write(
    `entry-graph: uygulamanın giriş zinciri KIRIK — HTML var olmayan dosyaları çağırıyor:\n` +
      kirik.slice(0, 10).map((k) => `    · ${k.file} → ${k.ref} (diskte yok)`).join("\n") +
      `\n  Bu haliyle uygulama açıldığında ekran boş kalır.\n`,
  );
  process.exit(1);
}
process.stdout.write(`entry-graph: giriş zinciri sağlam (${bakilan} yerel referans çözüldü)\n`);
process.exit(0);
