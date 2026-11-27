// csp-check — Faz 13 CSP değerlendirici exit-kodu sözleşmesi (güvenlik-baseline Unit 1).
// Script'i gerçek alt-process olarak çağırır (csp_evaluator'ı orchestrator/
// node_modules'tan import eder — CI'da npm ci kurar). Severity eşiği (<=40 blocking,
// "MEDIUM da bloklasın") + web-tespiti + fail-closed mantığını sözleşme düzeyinde kanıtlar.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { STRICT_CSP } from "../src/csp-compliance.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "csp-check.mjs");

function runCsp(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [SCRIPT, ...args], { encoding: "utf-8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("csp-check · --policy (severity eşiği)", () => {
  it("zayıf policy (default-src *) → blocking, exit 1", () => {
    const r = runCsp(["--policy", "default-src *"]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/blocking/i);
  });

  it("güçlü policy (nonce>=8 + strict-dynamic) → yeşil, exit 0", () => {
    const r = runCsp([
      "--policy",
      "default-src 'self'; object-src 'none'; base-uri 'self'; script-src 'nonce-abcdefgh' 'strict-dynamic'",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/yeşil/i);
  });

  it("'self' tabanlı policy (MEDIUM_MAYBE=50 > 40) → bloklamaz, exit 0", () => {
    // STRICT_CSP(45)/MEDIUM_MAYBE(50) önerileri fail değil — inverted-threshold
    // tuzağına düşmediğimizin kanıtı (güçlü/makul policy yanlış fail etmez).
    const r = runCsp(["--policy", "default-src 'self'; object-src 'none'; base-uri 'self'"]);
    expect(r.code).toBe(0);
  });

  it("script-src'de 'self' → YASAK, exit 1 (YZLLM 2026-06-20 — JSONP/AngularJS/user-upload bypass)", () => {
    const r = runCsp(["--policy", "default-src 'self'; script-src 'self' 'nonce-abcdefgh'; object-src 'none'"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/script-src.*self.*YASAK/i);
  });
  it("script-src nonce+'strict-dynamic' ('self' YOK) → exit 0", () => {
    const r = runCsp([
      "--policy",
      "default-src 'self'; script-src 'nonce-abcdefgh' 'strict-dynamic'; object-src 'none'; base-uri 'self'",
    ]);
    expect(r.code).toBe(0);
  });
});

describe("csp-check · --auto (web tespiti)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "csp-check-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("web-UI olmayan proje (express backend, index.html yok) → not-applicable, exit 0", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: { express: "^4" } }));
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/uygulanamaz|atlandı/i);
  });

  it("web-UI + index.html meta KÖTÜ CSP → blocking, exit 1", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: { vite: "^5" } }));
    await writeFile(
      join(dir, "index.html"),
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>',
    );
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(1);
  });

  it("web-UI ama statik CSP yok → görünür atlama (false-fail YOK), exit 0", async () => {
    // index.html'i CSP'siz + meta'sız bırak (önceki testteki meta'yı sil).
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: { vite: "^5" } }));
    await writeFile(join(dir, "index.html"), "<html><head></head><body></body></html>");
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/atlama|değerlendirilemedi/i);
  });
});

// KARAR 2026-11-27 (Ümit, "statik uygulamalarda kalksın") + OKUMA DÜZELTMESİ. Danışman main `00b3270` üzerinde
// denetimi elle çalıştırdı: `content="default-src 'self'; …"` meta değeri ilk tek tırnakta kesiliyordu (okunan
// metin `default-src `) → her tırnaklı politika sahte "Missing object-src" ile reddediliyor, `'unsafe-inline'` ve
// `*` görülmüyordu; `content` önce yazılınca politika hiç bulunmuyordu. Bu testlerin HEPSİNDE örnek politika
// tek tırnaklı anahtar sözcük içerir (eski testin `default-src *` hâli hatayı gizliyordu).
describe("csp-check · giriş sayfası meta politikası (tam okuma + statik uygulamada 'self')", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
  });

  /** Geçici proje: `files` = göreli yol → içerik. */
  async function proje(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "csp-check-meta-"));
    dirs.push(dir);
    for (const [rel, body] of Object.entries(files)) await writeFile(join(dir, rel), body);
    return dir;
  }
  /** `ensureCspMeta`'nın yazdığı satırın biçimi. */
  const metaSayfa = (policy: string) =>
    `<!doctype html><html><head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />\n</head><body></body></html>`;
  const VITE = JSON.stringify({ name: "x", devDependencies: { vite: "^5" } });
  const UYARI = "csp-check: [uyarı] script-src 'self' statik uygulamada serbest (karar 2026-11-27)";

  it("STRICT_CSP `frame-ancestors` içermiyor (meta ile verilince tarayıcı yok sayar)", () => {
    expect(STRICT_CSP).not.toMatch(/frame-ancestors/);
    expect(STRICT_CSP).toMatch(/script-src 'self'/);
    expect(STRICT_CSP).toMatch(/object-src 'none'/);
  });

  it("meta'da STRICT_CSP, sunucu paketi yok → exit 0; okunan politika tam, uyarı satırı var", async () => {
    const dir = await proje({ "package.json": VITE, "index.html": metaSayfa(STRICT_CSP) });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(0);
    const okunan = /csp-check: okunan politika = (.*)/.exec(r.stdout)?.[1] ?? "";
    expect(okunan).toBe(STRICT_CSP);
    expect(okunan).toContain("object-src 'none'");
    expect(r.stdout).toContain(UYARI);
    expect(r.stdout).not.toMatch(/Missing object-src/);
  });

  it("package.json yok → statik sayılır (bilinen sınır): meta'da 'self' → exit 0", async () => {
    const dir = await proje({ "index.html": metaSayfa(STRICT_CSP) });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(UYARI);
  });

  it("meta'da script-src 'self' 'unsafe-inline' → exit 1; bulgu 'unsafe-inline'i adıyla söylüyor", async () => {
    const dir = await proje({
      "package.json": VITE,
      "index.html": metaSayfa("default-src 'self'; script-src 'self' 'unsafe-inline'; object-src 'none'"),
    });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/\[BLOCK\][^\n]*'unsafe-inline'/);
    expect(r.stdout).not.toMatch(/Missing object-src/);
  });

  it("meta'da script-src * (öteki yönergeler tırnaklı) → exit 1; bulgu '*'ı söylüyor", async () => {
    const dir = await proje({
      "package.json": VITE,
      "index.html": metaSayfa("default-src 'self'; script-src *; object-src 'none'"),
    });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/\[BLOCK\][^\n]*script-src[^\n]*'\*'/);
  });

  it("`content` özniteliği `http-equiv`'den önce, kusurlu politika → exit 1 (atlama değil)", async () => {
    const dir = await proje({
      "package.json": VITE,
      "index.html":
        `<html><head><META Content="default-src 'self'; script-src 'self' 'unsafe-inline'; object-src 'none'" ` +
        `HTTP-EQUIV='content-security-policy'></head></html>`,
    });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toMatch(/atlama/i);
    expect(r.stdout).toMatch(/okunan politika = default-src 'self'; script-src 'self' 'unsafe-inline'; object-src 'none'/);
  });

  it("CSP meta öğesi var ama içeriği okunamıyor → exit 1 (görünür hata, atlama değil)", async () => {
    const dir = await proje({
      "package.json": VITE,
      "index.html": '<html><head><meta http-equiv="Content-Security-Policy" content=""></head></html>',
    });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/okunamadı/);
    expect(r.stdout).not.toMatch(/atlama/i);
  });

  it("yorumdaki meta da değerlendirilir (bilerek fazladan sıkı: hiçbir içerik atlanmaz) → zayıfsa exit 1", async () => {
    const dir = await proje({
      "package.json": VITE,
      "index.html": `<html><head><!-- ${metaSayfa("default-src *")} --></head></html>`,
    });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(1);
  });

  // İnceleme bulguları (2026-11-27): düzenli ifadeyle okuma tarayıcıdan ayrışıyordu.
  it("`<!-->` kısa yorumundan sonraki zayıf politika gizlenmez → exit 1", async () => {
    const dir = await proje({
      "package.json": VITE,
      "index.html": `<html><head><!--><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src * 'unsafe-inline'; object-src 'none'"><!-- x --></head></html>`,
    });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/okunan politika = default-src 'self'; script-src \* 'unsafe-inline'/);
  });

  it("tırnaksız değerdeki `'` etiketleri birbirine katmaz: gerçek CSP meta değerlendirilir → exit 1", async () => {
    const dir = await proje({
      "package.json": VITE,
      "index.html":
        `<html><head><meta content="default-src 'none'; script-src 'none'; object-src 'none'" name=a'b>` +
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src * 'unsafe-inline'; object-src 'none'">` +
        `<meta name=c'd></head></html>`,
    });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/okunan politika = default-src 'self'; script-src \* 'unsafe-inline'/);
    expect(r.stdout).not.toMatch(/okunan politika = default-src 'none'/);
  });

  // İkinci inceleme turu (2026-11-27): içerik atlayan her okuma tarayıcının uyguladığı meta'yı gizleyebiliyordu.
  const ZAYIF = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src *; object-src 'none'">`;
  for (const [ad, sayfa] of [
    ["betik içinde çift kaçış", `<script><!--<script></script><!--</script>${ZAYIF}`],
    ["geçersiz bitiş etiketi `</ …>`", `</ <!-- >${ZAYIF}`],
    ["`<template>` içi SVG `<style>`", `<template><svg><style></template>${ZAYIF}</style>`],
    ["`<template>` içi CDATA", `<template><svg><![CDATA[ > <!-- ]]></svg></template>${ZAYIF}`],
  ] as const) {
    it(`${ad} zayıf meta'yı gizlemez → exit 1`, async () => {
      const dir = await proje({ "package.json": VITE, "index.html": `<html><head>${sayfa}</head></html>` });
      const r = runCsp(["--project", dir]);
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/okunan politika = default-src 'self'; script-src \*; object-src 'none'/);
    });
  }

  it("çözülemeyen karakter göndermesi (`&ast;` = `*`) → okunamadı, exit 1 (fail-closed)", async () => {
    const dir = await proje({
      "package.json": VITE,
      "index.html": `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src &ast;; object-src 'none'"></head></html>`,
    });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/okunamadı/);
  });

  // Üçüncü inceleme turu (2026-11-27).
  for (const [ad, icerik] of [
    ["çift çözme `&#x26;#32`", "object-src 'none'; base-uri 'none'; script-src&#x26;#32'nonce-r4nd0mABCDEF12' 'strict-dynamic'"],
    ["çift çözme `&#38;apos;`", "script-src 'unsafe-inline' https: &#38;apos;nonce-r4nd0m123&#38;apos;; object-src 'none'"],
    ["bölünmez boşluk göndermesi `&#xA0;`", "object-src 'none'; base-uri 'none'; script-src&#xA0;'nonce-r4nd0mABCDEF12'"],
    ["ham bölünmez boşluk", "object-src 'none'; base-uri 'none'; script-src\u00a0'nonce-r4nd0mABCDEF12'"],
  ] as const) {
    it(`${ad}: tarayıcıyla denetimin ayrıştığı politika okunamadı sayılır → exit 1`, async () => {
      const dir = await proje({ "package.json": VITE, "index.html": metaSayfa(icerik) });
      const r = runCsp(["--project", dir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/okunamadı/);
    });
  }

  it("`&#39;` ve `&apos;` tek geçişte çözülür → okunan politika düz tırnaklı", async () => {
    const dir = await proje({
      "package.json": VITE,
      "index.html": metaSayfa("default-src &#39;self&#39;; script-src &apos;self&apos;; object-src &#39;none&#39;; base-uri &#39;self&#39;"),
    });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("okunan politika = default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'");
  });

  it("kapanmayan çok sayıda `<meta` → iş sınırında görünür hata, exit 1 (askıda kalmaz)", async () => {
    const dir = await proje({ "package.json": VITE, "index.html": "<meta ".repeat(5000) });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/iş sınırı/);
  });

  it("değerlendiricinin geçersiz kaynakta attığı hata görünür gerekçeyle engel olur (yığın izi değil)", async () => {
    const dir = await proje({ "package.json": VITE, "index.html": metaSayfa("default-src 'self'; img-src [; object-src 'none'") });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/politika değerlendirilemedi/);
  });

  it("yalnız `Content-Security-Policy-Report-Only` meta → politika sayılmaz, 'okunamadı' denmez (exit 0, görünür atlama)", async () => {
    const dir = await proje({
      "package.json": VITE,
      "index.html": `<html><head><meta http-equiv="Content-Security-Policy-Report-Only" content="default-src 'self'"></head></html>`,
    });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/okunamadı/);
    expect(r.stdout).toMatch(/atlama/i);
  });

  it("geçersiz karakter kodu (`&#x110000;`) denetimi çökertmez; `&#39;` çözülür", async () => {
    const dir = await proje({
      "package.json": VITE,
      "index.html":
        `<html><head><meta name="description" content="&#x110000;">` +
        `<meta http-equiv="Content-Security-Policy" content="${STRICT_CSP.replace(/'/g, "&#39;")}"></head></html>`,
    });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`okunan politika = ${STRICT_CSP}`);
    expect(r.stderr).not.toMatch(/RangeError/);
  });

  it("meta'da script-src 'self', package.json'da express → exit 1; ileti nedeni söylüyor", async () => {
    const dir = await proje({
      "package.json": JSON.stringify({ name: "x", dependencies: { express: "^4" }, devDependencies: { vite: "^5" } }),
      "index.html": metaSayfa(STRICT_CSP),
    });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/script-src.*self.*YASAK/i);
    expect(r.stderr).toMatch(/sunucu paketi var \(express\)/);
    expect(r.stdout).not.toContain(UYARI);
  });

  it("meta temiz ve statik; server.js'te `script-src 'self'` → exit 1 (iki kaynak da değerlendirilir)", async () => {
    const dir = await proje({
      "package.json": VITE,
      "index.html": metaSayfa(STRICT_CSP),
      "server.js":
        'res.setHeader("Content-Security-Policy", ["default-src \'self\'", "script-src \'self\'", "object-src \'none\'"].join("; "));\n',
    });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(UYARI); // meta'daki 'self' serbest...
    expect(r.stdout).toMatch(/policy kaynağı = sunucu config \(server\.js\)/);
    expect(r.stderr).toMatch(/script-src.*self.*YASAK/i); // ...sunucu ayarındaki değil
  });

  it("REGRESYON (kural 14): yalnız sunucu ayarında `script-src 'self'` → exit 1 (eskisi gibi)", async () => {
    const dir = await proje({
      "package.json": JSON.stringify({ name: "x", dependencies: { express: "^4" } }),
      "server.js":
        'res.setHeader("Content-Security-Policy", ["default-src \'self\'", "script-src \'self\'", "object-src \'none\'"].join("; "));\n',
    });
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/script-src.*self.*YASAK/i);
  });

  it("'sunucu var mı' ölçütü tek: csp-check.mjs ve headers-check.mjs `BACKEND` listeleri birebir aynı", async () => {
    const liste = async (dosya: string): Promise<string[]> => {
      const src = await readFile(join(HERE, "..", dosya), "utf-8");
      const m = /const BACKEND = (\[[^\]]*\]);/.exec(src);
      expect(m, `${dosya}: BACKEND listesi bulunamadı`).not.toBeNull();
      return JSON.parse(m![1]!) as string[];
    };
    const csp = await liste("csp-check.mjs");
    expect(csp.length).toBeGreaterThan(0);
    expect(csp).toEqual(await liste("headers-check.mjs"));
  });
});
