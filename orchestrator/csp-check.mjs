#!/usr/bin/env node
// csp-check.mjs — Faz 13 güvenlik gate'i için CSP değerlendirici (güvenlik-baseline Unit 1).
//
// Google'ın csp_evaluator paketi (CJS, orchestrator/node_modules) ile projenin
// Content-Security-Policy politikasını değerlendirir — Chrome "CSP Evaluator"
// extension'ının yaptığı analizin OTOMATİK/headless karşılığı. harness.mjs gibi
// orchestrator kökünde durur (tsc derlemez); phase-registry extra_scan'i MUTLAK
// yolla `node <abs>/csp-check.mjs` çağırır (runner cwd=hedef-proje).
//
// KAPSAM (Unit 1, false-positive-free): kaynak-tabanlı. Giriş sayfasındaki meta CSP'sini VE sunucu
// ayar dosyalarındaki literal politika metnini değerlendirir (2026-11-27: ikisi birden); GERÇEK kötü
// policy bulursa fail eder. Statik bulunamayan CSP (helmet/runtime/custom middleware) → GÖRÜNÜR atlama,
// fail DEĞİL (kesin header-tabanlı değerlendirme sonraki turda — çalışan sunucuya bağlanır).
// `script-src 'self'` (karar 2026-11-27): statik uygulamanın (sunucu paketi yok) meta politikasında
// serbest, görünür uyarı basılır; sunucusu olan uygulamada, sunucu ayarında ve `--policy` yolunda yasak.
//
// Eşik (YZLLM 2026-06-04 "MEDIUM da bloklasın"): csp_evaluator severity'de DÜŞÜK
// sayı = DAHA KÖTÜ (HIGH=10, SYNTAX=20, MEDIUM=30, HIGH_MAYBE=40, STRICT_CSP=45,
// MEDIUM_MAYBE=50, INFO=60, NONE=100). Blocking = severity <= 40 (HIGH/SYNTAX/
// MEDIUM/HIGH_MAYBE). STRICT_CSP(45 — nonce/strict-dynamic ÖNERİSİ) ve üstü uyarı,
// fail değil (yoksa güçlü policy'ler yanlış fail ederdi — inverted-threshold tuzağı).
//
// Exit: 0 = yeşil / not-applicable / statik-değerlendirilemedi (görünür not);
//       1 = blocking CSP bulgusu; 2 = fail-closed (csp_evaluator import edilemedi
//       = orchestrator bağımlılığı eksik, sessiz yeşil GEÇME).

import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function argVal(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const explicitPolicy = argVal("policy");
const projectDir = argVal("project") || process.cwd();

// csp_evaluator orchestrator-bundle — eksikse BUG, sessiz skip DEĞİL (fail-closed).
let CspParser, CspEvaluator;
try {
  ({ CspParser } = require("csp_evaluator/dist/parser.js"));
  ({ CspEvaluator } = require("csp_evaluator/dist/evaluator.js"));
} catch (e) {
  console.error(
    "csp-check: csp_evaluator import edilemedi (orchestrator bağımlılığı eksik — bug, sessiz geçilmez): " +
      String(e?.message ?? e),
  );
  process.exit(2);
}

const BLOCK_THRESHOLD = 40; // severity <= 40 → blocking (HIGH/SYNTAX/MEDIUM/HIGH_MAYBE)

/** SAF (YZLLM 2026-06-20): EXPLICIT `script-src` (veya `script-src-elem`) `'self'` taşıyor mu. CSP Evaluator
 *  `'self'`'i script-src'de yalnız UYARI verir; YZLLM YASAK istedi (aynı-origin JSONP/AngularJS/user-upload
 *  bypass). Bunu BLOKLAYAN kontrole çeviririz — KARAR 2026-11-27 (Ümit, "statik uygulamalarda kalksın"): yasak
 *  yalnız SUNUCUSU OLAN uygulamada ve sunucu tarafında verilen politikada geçerli; statik uygulamanın giriş
 *  sayfasındaki meta politikasında `'self'` serbest (bkz. evaluatePolicy `allowScriptSelf`).
 *  NOT: script-src TANIMSIZ + default-src 'self' (script'ler fallback'le self'ten gelir) ayrı/ince bir vaka;
 *  template her zaman explicit script-src ürettiği için burada kapsanmaz (minimal default-src 'self' testi geçer). */
export function scriptSrcHasSelf(policy) {
  const m = /(?:^|;)\s*script-src(?:-elem)?\s([^;]*)/i.exec(String(policy));
  return m ? /'self'/i.test(m[1]) : false;
}

/**
 * HTTP sunucu paketleri — "projenin kendi sunucusu var mı" ölçütü. headers-check.mjs `BACKEND` ile AYNI
 * liste olmalı (iki .mjs ayrı süreç olarak koşar ve içe aktarılınca çalışıp çıkar; ortak dosya yerine iki
 * kopyanın eşitliği test/csp-check.test.ts'te sınanır). Sunucu paketi yoksa (package.json yoksa da) proje
 * STATİK sayılır: giriş sayfası dosya olarak yayımlanır; paketleyicinin geliştirme sunucusu sunucu değildir.
 */
const BACKEND = ["express", "fastify", "koa", "@nestjs/core", "hapi", "@hapi/hapi", "next"];

/**
 * Tek politikayı değerlendirir ve çıktıya yazar; ÇIKMAZ. Döner: engelleyen bulgu var mı.
 * `allowScriptSelf`: yalnız statik uygulamanın giriş sayfası meta politikasında true (karar 2026-11-27).
 * `selfBlockReason`: `'self'` engellendiğinde iletiye eklenecek neden.
 */
function evaluatePolicy(policy, src, { allowScriptSelf, selfBlockReason }) {
  let findings;
  try {
    findings = new CspEvaluator(new CspParser(policy).csp).evaluate();
  } catch (e) {
    // csp_evaluator geçersiz bir kaynakta (ör. `img-src [`) istisna atıyor: eskiden yığın izi + çıkış 1. Artık görünür
    // gerekçe; sonuç yine engel (fail-closed).
    console.log(`csp-check: policy kaynağı = ${src}`);
    console.log(`csp-check: okunan politika = ${policy}`);
    console.error(`csp-check: [BLOCK] politika değerlendirilemedi (${String(e?.message ?? e)}) — kaynak: ${src}. CSP düzeltilmeli.`);
    return true;
  }
  const blocking = findings.filter((f) => f.severity <= BLOCK_THRESHOLD);
  console.log(`csp-check: policy kaynağı = ${src}`);
  // Okunan metin AYNEN basılır: yarım okuma (2026-11-27: meta değeri ilk tek tırnakta kesiliyordu) bir daha gizlenemesin.
  console.log(`csp-check: okunan politika = ${policy}`);
  for (const f of findings) {
    const tag = f.severity <= BLOCK_THRESHOLD ? "BLOCK" : "uyarı";
    const value = f.value ? ` (${f.value})` : "";
    console.log(`  [${tag}] sev=${f.severity} ${f.directive}${value}: ${String(f.description).slice(0, 110)}`);
  }
  let blocked = false;
  if (scriptSrcHasSelf(policy)) {
    if (allowScriptSelf) {
      console.log("csp-check: [uyarı] script-src 'self' statik uygulamada serbest (karar 2026-11-27)");
    } else {
      console.error(
        "csp-check: [BLOCK] script-src'de `'self'` YASAK (YZLLM 2026-06-20) — aynı-origin JSONP/AngularJS/user-upload " +
          `ile bypass'lanabilir. ${selfBlockReason} Çözüm: \`script-src 'nonce-<value>' 'strict-dynamic'\`, ` +
          "politika sunucunun yanıt başlığıyla verilir. (`'self'` yalnız statik uygulamanın giriş sayfası meta " +
          "politikasında serbest — karar 2026-11-27.)",
      );
      blocked = true;
    }
  }
  if (blocking.length > 0) {
    console.error(
      `csp-check: ${blocking.length} blocking CSP bulgusu (severity<=${BLOCK_THRESHOLD}) — kaynak: ${src}. CSP düzeltilmeli.`,
    );
    blocked = true;
  }
  if (!blocked) console.log(`csp-check: CSP yeşil (blocking bulgu yok) — kaynak: ${src}.`);
  return blocked;
}

// 1) Açık policy (test + override yolu) — statik, deterministik. `'self'` yasağı AYNEN (karar 2026-11-27 kapsamı dışı).
if (explicitPolicy !== undefined) {
  const blocked = evaluatePolicy(explicitPolicy, "--policy", {
    allowScriptSelf: false,
    selfBlockReason: "--policy yolunda yasak aynen geçerli.",
  });
  process.exit(blocked ? 1 : 0);
}

// 2) Auto: web-UI tespiti (web framework / index.html). Değilse CSP uygulanamaz.
let pkg = null;
try {
  pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
} catch {
  /* package.json yok — node-dışı proje olabilir */
}
const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
const WEB_FRAMEWORKS = [
  "vite", "next", "react-scripts", "@vue/cli-service", "@angular/core",
  "nuxt", "astro", "@sveltejs/kit", "webpack",
];
const hasWebFramework = WEB_FRAMEWORKS.some((d) => d in deps);
const backendPkgs = BACKEND.filter((d) => d in deps);
const isStatic = backendPkgs.length === 0;

const HTML_CANDIDATES = ["index.html", "public/index.html", "src/index.html", "app/index.html", "dist/index.html"];
const htmlPath = HTML_CANDIDATES.map((p) => join(projectDir, p)).find((p) => existsSync(p));
const isWebUi = hasWebFramework || Boolean(htmlPath);

// STACK-BAĞIMSIZ sıra (YZLLM 2026-06-18): önce TANIMLI bir CSP var mı bak — varsa stack/framework
// tespitinden BAĞIMSIZ değerlendir (CSP tanımlamış proje onu strict istiyor → enforce). CSP hiç
// yoksa AŞAĞIDA "web-UI mi" kapısına düş (pure-API/web-dışı → atla; web-UI ama CSP'siz → görünür atla).

/** SAF: öznitelik değerindeki HTML karakter göndermelerini TEK GEÇİŞTE çöz: yalnız noktalı virgülle biten sayısal
 *  göndermeler ve beş temel ad (`&quot;` `&apos;` `&lt;` `&gt;` `&amp;`). Tarayıcı gibi, çözülmüş çıktı yeniden
 *  taranmaz (`&#38;apos;` → `&apos;`, tırnak DEĞİL — inceleme bulgusu 2026-11-27: zincirli `replace` çift çözüyordu).
 *  Geçersiz kod noktası (ör. `&#x110000;`) U+FFFD olur, denetim çökmez. Çözülmeyen her `&` metinde kalır;
 *  politika için çağıran bunu okunamadı sayar. */
function decodeHtmlEntities(v) {
  const cp = (n) =>
    Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "\uFFFD";
  const NAMED = { quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" };
  return v.replace(/&(?:#[xX]([0-9a-fA-F]+);|#(\d+);|(quot|apos|lt|gt|amp);)/g, (_, hex, dec, name) =>
    hex !== undefined ? cp(parseInt(hex, 16)) : dec !== undefined ? cp(parseInt(dec, 10)) : NAMED[name],
  );
}

/** Politika metninde izin verilen karakterler: görünür ASCII ve ASCII boşluğu (sekme, satır sonu, sayfa sonu,
 *  satır başı, boşluk — WHATWG "ASCII whitespace"). Tarayıcının CSP ayrıştırıcısı yalnız bunlarda ayırır; JS `\s`
 *  ise U+00A0, U+FEFF, U+3000, `\v` gibi karakterlerde de ayırır. İnceleme bulgusu (2026-11-27):
 *  `script-src&#xA0;'nonce-…'` denetimde geçerli bir yönerge, tarayıcıda düşen bir yönergeydi. */
const NON_ASCII_POLICY_CHAR = /[^\x20-\x7E\t\n\f\r]/;

const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/**
 * SAF: `i` etiket adının ilk karakterinde. HTML belirteçleme kurallarına göre etiketi okur: öznitelik adı
 * boşluk, `/`, `>`, `=` ile biter; değer çift tırnaklıysa çift tırnağa, tek tırnaklıysa tek tırnağa kadar,
 * tırnaksızsa boşluğa ya da `>`a kadar (tırnaksız değerdeki `'` ve `"` düz karakterdir). Aynı öznitelik
 * ikinci kez yazılırsa ilki geçerli. Döner: `{ name, attrs, end, eof }` (`eof`: etiket kapanmadan metin bitti).
 */
function readTag(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && !isWs(s[j]) && s[j] !== "/" && s[j] !== ">") j++;
  const name = s.slice(i, j).toLowerCase();
  const attrs = {};
  for (;;) {
    while (j < n && (isWs(s[j]) || s[j] === "/")) j++;
    if (j >= n) return { name, attrs, end: n, eof: true };
    if (s[j] === ">") return { name, attrs, end: j + 1, eof: false };
    const an = j;
    j++; // ilk karakter `=` olsa bile adın parçasıdır
    while (j < n && !isWs(s[j]) && s[j] !== "/" && s[j] !== ">" && s[j] !== "=") j++;
    const attrName = s.slice(an, j).toLowerCase();
    while (j < n && isWs(s[j])) j++;
    let value = "";
    if (s[j] === "=") {
      j++;
      while (j < n && isWs(s[j])) j++;
      const q = s[j];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, j + 1);
        if (close < 0) return { name, attrs, end: n, eof: true };
        value = s.slice(j + 1, close);
        j = close + 1;
      } else {
        const vs = j;
        while (j < n && !isWs(s[j]) && s[j] !== ">") j++;
        value = s.slice(vs, j);
      }
    }
    if (!(attrName in attrs)) attrs[attrName] = decodeHtmlEntities(value);
  }
}

/**
 * SAF: sayfadaki HER `<meta` başlangıcı — yorumun, `<script>`/`<style>`/`<template>` içinin ya da bozuk bir
 * bildirimin içinde olsa bile. BİLEREK fazladan kapsayıcı (fail-closed): tam inceleme (2026-11-27, iki tur)
 * tarayıcının belirteçleme ve ağaç kurma kurallarını taklit eden her atlamanın (kısa yorum `<!-->`, betik
 * içinde çift kaçış, geçersiz bitiş etiketi `</ …>`, `<template>` içi SVG `<style>`/CDATA) tarayıcının
 * UYGULADIĞI zayıf bir meta'yı gizleyebildiğini gösterdi. Burada hiçbir şey atlanmaz: tarayıcının uygulamadığı
 * bir meta da değerlendirilebilir (yalnız fazladan sıkı; 2026-11-27 öncesi davranış da buydu), uygulanan bir
 * meta ise gözden kaçamaz. Her başlangıçtan sonra etiket belirteçleme kurallarıyla okunur (readTag) — bu kısım
 * bağlamdan bağımsızdır, tarayıcıyla aynı öznitelikleri verir.
 */
function scanMetaTags(html) {
  const s = String(html);
  const metas = [];
  const START = /<meta(?=[\t\n\f\r />]|$)/gi;
  // İş sınırı (inceleme bulgusu 2026-11-27): her başlangıç bir sonraki `>`a ya da metnin sonuna kadar okunur;
  // kapanmayan çok sayıda `<meta` karesel süre harcar. Gerçek giriş sayfası bu sınırın çok altındadır; aşılırsa
  // görünür hata (sessiz atlama değil, kural 4).
  let work = 0;
  let m;
  while ((m = START.exec(s))) {
    const tag = readTag(s, m.index + 1);
    work += tag.end - m.index;
    if (work > SCAN_WORK_LIMIT) {
      const e = new Error(`giriş sayfası taranırken iş sınırı (${SCAN_WORK_LIMIT} karakter) aşıldı — çok sayıda kapanmayan <meta etiketi`);
      e.code = "CSP_SCAN_LIMIT";
      throw e;
    }
    metas.push(tag);
  }
  return metas;
}
const SCAN_WORK_LIMIT = 20_000_000;

/**
 * SAF (2026-11-27 düzeltmesi): giriş sayfasındaki CSP meta öğeleri. Eskiden tek bir düzenli ifade
 * `content=["']([^"']+)["']` kullanıyordu: değer İLK tırnakta (iki türden hangisi gelirse) kesiliyordu →
 * `content="default-src 'self'; …"` için okunan metin `default-src ` oluyordu (sahte "Missing object-src",
 * gerçek kusur görünmüyordu); `content` `http-equiv`'den önce yazılınca hiç bulunmuyordu. Artık her `<meta`
 * başlangıcı etiket belirteçleme kurallarıyla okunur (scanMetaTags, readTag); öznitelik sırası ve büyük küçük
 * harf fark etmez.
 * Yalnız `http-equiv` değeri TAM OLARAK `content-security-policy` olan öğe politikadır (`…-Report-Only`
 * meta ile verilemez, tarayıcı yok sayar). Döner: `{ policies: string[], unreadable: number }` — CSP meta
 * öğesi var ama `content`i yok, boş, çözülemeyen karakter göndermesi taşıyor ya da etiket kapanmadan metin
 * bitiyorsa `unreadable` artar (çağıran bunu "atlama" değil HATA sayar, kural 4).
 */
function metaCspFromHtml(html) {
  const policies = [];
  let unreadable = 0;
  for (const tag of scanMetaTags(html)) {
    const equiv = (tag.attrs["http-equiv"] ?? "").trim().toLowerCase();
    if (equiv !== "content-security-policy") continue;
    const content = (tag.attrs.content ?? "").trim();
    // Çözülemeyen karakter göndermesi (`&ast;` → `*`, `&colon;` → `:` gibi; yalnız sayısal göndermeler ve beş
    // temel ad çözülür): tarayıcı bunları çözer ve daha zayıf bir kaynak uygulayabilir → okunamadı say (fail-closed).
    // ASCII dışı ya da denetim karakteri: tarayıcı ile CspParser farklı ayırır → okunamadı say (fail-closed).
    if (tag.eof || !content || content.includes("&") || NON_ASCII_POLICY_CHAR.test(content)) unreadable++;
    else policies.push(content);
  }
  return { policies, unreadable };
}

// 3) Sunucu-tarafı / SSR stack'leri — STACK-BAĞIMSIZ (YZLLM 2026-06-18: "Next.js'e özel
//     yapma; MyCL başka stack'lerde de CSP'yi uygulamalı"). Bu stack'lerde CSP index.html
//     meta'da DEĞİL, sunucu YANIT-BAŞLIĞI olarak gönderilir; kaynakta politika genelde
//     çift-tırnaklı direktif-string'leri olarak yazılır (`"script-src 'self'"` …) — Next.js
//     next.config, Nuxt/SvelteKit/Astro config, edge middleware, ya da ham Node sunucu girişi:
//     biçim aynı. Bu literal direktifleri STATİK çıkar + mevcut CspEvaluator ile değerlendir →
//     bu stack'lerde de "görünür atlama" değil ENFORCE. NOT: yapısal-config stack'leri (helmet
//     objesi, Django `CSP_*` ayarları, Rails DSL) literal direktif-string taşımaz; backtick-
//     template dinamik (per-request nonce) CSP de statik çıkarılamaz → ikisi de aşağıdaki
//     görünür-atlamaya düşer (false-fail YOK, "false-positive-free" korunur; tam stack-bağımsız
//     denetim = çalışan sunucunun gerçek başlığı, sonraki tur).
function cspFromSourceConfig(p) {
  let src;
  try {
    src = readFileSync(p, "utf8");
  } catch {
    return null;
  }
  if (!/content-security-policy/i.test(src)) return null; // CSP hiç tanımlı değil → çıkarma
  // İyi-biçimli, çift-tırnaklı CSP direktif literal'leri (gerçek direktif adıyla BAŞLAYAN).
  // İçindeki tek-tırnaklı CSP anahtarlarını (`'self'`) `[^"]*` kapsar; backtick (dinamik) hariç.
  const DIRECTIVE =
    /"((?:default-src|script-src(?:-elem|-attr)?|style-src(?:-elem|-attr)?|img-src|font-src|connect-src|object-src|base-uri|frame-ancestors|form-action|frame-src|child-src|worker-src|manifest-src|media-src|prefetch-src|upgrade-insecure-requests|block-all-mixed-content)(?:\s[^"]*)?)"/gi;
  const dirs = [];
  let m;
  while ((m = DIRECTIVE.exec(src))) dirs.push(m[1].trim());
  if (dirs.length === 0) return null;
  return [...new Set(dirs)].join("; ");
}
// Stack-bağımsız aday liste (literal-string CSP taşıyan yaygın sunucu/SSR config'leri). Hepsini
// dene; ilk çıkarılabilir politika kazanır (biri var ama CSP'siz ise diğerlerine bak — find DEĞİL).
const SERVER_CSP_CANDIDATES = [
  "next.config.js", "next.config.mjs", "next.config.ts",
  "nuxt.config.js", "nuxt.config.ts", "svelte.config.js", "astro.config.mjs",
  "middleware.js", "middleware.ts", "src/middleware.js", "src/middleware.ts",
  "server.js", "server.ts", "src/server.js", "src/server.ts",
  "app.js", "app.ts", "src/app.js", "src/app.ts",
];

// KARAR 2026-11-27 (3d): İKİ kaynak da değerlendirilir. Eskiden meta bulununca süreç bitiyordu, sunucu ayar
// dosyaları hiç okunmuyordu → `'self'` yasağı sunucu tarafına bir meta eklenerek atlatılabilirdi.
let anyPolicy = false;
let anyBlocked = false;

if (htmlPath) {
  let html = null;
  try {
    html = readFileSync(htmlPath, "utf8");
  } catch (e) {
    // Giriş sayfası VAR ama okunamadı → politika bilinmiyor; "atlama" değil görünür hata (kural 4).
    console.error(`csp-check: giriş sayfası okunamadı (${htmlPath}): ${String(e?.message ?? e)} — CSP değerlendirilemedi.`);
    process.exit(1);
  }
  let meta;
  try {
    meta = metaCspFromHtml(html);
  } catch (e) {
    console.error(`csp-check: [BLOCK] ${String(e?.message ?? e)} (${htmlPath}). CSP değerlendirilemedi; bu bir atlama değildir.`);
    process.exit(1);
  }
  if (meta.unreadable > 0) {
    console.error(
      `csp-check: [BLOCK] giriş sayfasında (${htmlPath}) Content-Security-Policy meta öğesi var ama içeriği ` +
        "okunamadı (content özniteliği yok, boş, çözülemeyen karakter göndermesi — ör. `&ast;` — ya da ASCII dışı " +
        "karakter — ör. bölünmez boşluk — taşıyor, ya da etiket kapanmıyor). Bu bir atlama değildir: politikayı düz " +
        "ASCII metinle " +
        '`<meta http-equiv="Content-Security-Policy" content="…">` biçiminde düzgün yaz.',
    );
    anyBlocked = true;
    anyPolicy = true;
  }
  for (const policy of meta.policies) {
    anyPolicy = true;
    const src = `index.html meta (${htmlPath}; ${isStatic ? "statik uygulama: sunucu paketi yok" : `sunucu paketi var: ${backendPkgs.join(",")}`})`;
    const blocked = evaluatePolicy(policy, src, {
      allowScriptSelf: isStatic,
      selfBlockReason:
        `Projede sunucu paketi var (${backendPkgs.join(",")}): sunucusu olan uygulamada politika yanıt başlığıyla ` +
        "ve nonce ile verilir; meta ile verilse de yasak aynen geçerli.",
    });
    if (blocked) anyBlocked = true;
  }
}

for (const cand of SERVER_CSP_CANDIDATES) {
  const cfgPath = join(projectDir, cand);
  if (!existsSync(cfgPath)) continue;
  const cfgPolicy = cspFromSourceConfig(cfgPath);
  if (!cfgPolicy) continue;
  anyPolicy = true;
  const blocked = evaluatePolicy(cfgPolicy, `sunucu config (${basename(cfgPath)})`, {
    allowScriptSelf: false,
    selfBlockReason: "Politika sunucu tarafında tanımlı: yasak aynen geçerli.",
  });
  if (blocked) anyBlocked = true;
  break; // ilk çıkarılabilir sunucu politikası kazanır (eski davranış)
}

if (anyPolicy) {
  process.exit(anyBlocked ? 1 : 0);
}

// CSP hiçbir kaynakta TANIMLI değil. Web-UI değilse (pure-API / web-dışı backend) → CSP
// uygulanamaz, atla. Web-UI ise (CSP gerekir ama statik bulunamadı: helmet objesi / Django
// CSP_* / Rails DSL / runtime) → aşağıdaki görünür-atlamaya düş.
if (!isWebUi) {
  console.log("csp-check: web-UI değil + tanımlı CSP yok — CSP uygulanamaz, atlandı.");
  process.exit(0);
}

// 4) Web-UI ama statik CSP bulunamadı (helmet/runtime/custom middleware) → kesin
//    değerlendirme çalışan sunucu/header gerektirir (sonraki tur). FALSE-FAIL
//    riski almamak için fail DEĞİL, GÖRÜNÜR atlama (sessiz yeşil değil — not basılır).
const hasHelmet = ["helmet", "@fastify/helmet", "koa-helmet"].some((d) => d in deps);
console.log(
  hasHelmet
    ? "csp-check: helmet tespit edildi; CSP runtime'da kuruluyor → statik değerlendirilemedi (header-tabanlı değerlendirme sonraki turda). Görünür atlama."
    : "csp-check: web-UI ama statik CSP (index.html meta) bulunamadı → header-tabanlı değerlendirme sonraki turda. Görünür atlama.",
);
process.exit(0);
