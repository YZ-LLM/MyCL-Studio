// entry-graph-check — uygulamanın giriş zinciri sağlam mı (stack bağımsız olgu ölçümü).
//
// CANLI KANIT (cüzdan projesi, 2026-09-17): 27 dosyalık bir uygulama yazıldı — bileşenler, sayfalar,
// oturum, tema, i18n hepsi yerinde. Ama `index.html` `/src/main.jsx` çağırıyordu ve o dosya hiç
// yazılmamıştı. React hiçbir yere bağlanmadı, ekran bomboş kaldı, hiçbir kapı görmedi. Kullanıcı
// günlerce çalışmayan bir uygulamaya baktı.
//
// Bu testlerin YARISI yanlış alarm içindir: bir yanlış pozitif Faz 10'u düşürür ve pipeline'ı
// bloklar. Şüphede "ölçemedim" (3) denir, asla "bulgu var" (1) denmez.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "entry-graph-check.mjs");

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mycl-entry-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function yaz(rel: string, icerik = "x"): Promise<void> {
  const p = join(root, rel);
  await fs.mkdir(dirname(p), { recursive: true });
  await fs.writeFile(p, icerik);
}

/** Betiği koş; exit kodunu ve çıktıyı döndür (execFile sıfır olmayan kodda throw eder). */
async function kos(): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await run("node", [SCRIPT, root]);
    return { code: 0, out: stdout };
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    return { code: err.code ?? -1, out: err.stdout ?? "" };
  }
}

describe("entry-graph-check", () => {
  it("giriş dosyası VAR → zincir sağlam (0)", async () => {
    await yaz("index.html", '<script type="module" src="/src/main.jsx"></script>');
    await yaz("src/main.jsx", "createRoot(...)");
    const r = await kos();
    expect(r.code).toBe(0);
    expect(r.out).toContain("sağlam");
  });

  it("CANLI VAKA: giriş dosyası YOK → kırık zincir (1) ve dosya adı raporlanır", async () => {
    await yaz("index.html", '<script type="module" src="/src/main.jsx"></script>');
    await yaz("src/components/Button.jsx", "export const B = 1;"); // başka dosyalar var
    const r = await kos();
    expect(r.code).toBe(1);
    expect(r.out).toContain("/src/main.jsx");
    expect(r.out).toContain("ekran boş");
  });

  it("uzantısız referans çözülür (bundler davranışının sade karşılığı)", async () => {
    await yaz("index.html", '<script src="/src/main"></script>');
    await yaz("src/main.ts", "x");
    expect((await kos()).code).toBe(0);
  });

  it("dizin referansı index dosyasıyla çözülür", async () => {
    await yaz("index.html", '<script src="/src/app"></script>');
    await yaz("src/app/index.jsx", "x");
    expect((await kos()).code).toBe(0);
  });

  it("YANLIŞ ALARM YOK: şablon motoru yer tutucuları çözülmeye çalışılmaz", async () => {
    await yaz(
      "index.html",
      `<script src="{{ url_for('static', filename='app.js') }}"></script>
       <script src="<%= asset_path('main.js') %>"></script>
       <script src="%PUBLIC_URL%/bundle.js"></script>
       <script src="\${base}/app.js"></script>`,
    );
    const r = await kos();
    expect(r.code).toBe(3); // hiçbiri çözülemedi → ölçülemedi, "bulgu" DEĞİL
  });

  it("YANLIŞ ALARM YOK: dış URL, Vite sanal yolu, sorgu dizesi ve data: atlanır", async () => {
    await yaz(
      "index.html",
      `<script src="https://cdn.example.com/lib.js"></script>
       <script src="//cdn.example.com/x.js"></script>
       <script type="module" src="/@vite/client"></script>
       <script src="/src/main.js?v=123"></script>
       <script src="data:text/javascript,void 0"></script>`,
    );
    expect((await kos()).code).toBe(3);
  });

  it("YANLIŞ ALARM YOK: eksik GÖRSEL uygulamayı çalışmaz yapmaz — taranmaz", async () => {
    await yaz("index.html", '<img src="/yok.png"><script src="/src/main.js"></script>');
    await yaz("src/main.js", "x");
    expect((await kos()).code).toBe(0);
  });

  it("build çıktısındaki HTML taranmaz (bizim sorunumuz değil)", async () => {
    await yaz("dist/index.html", '<script src="/assets/olmayan.js"></script>');
    expect((await kos()).code).toBe(3); // taranacak HTML yok
  });

  it("HTML hiç yoksa ölçülemedi (3) — 'temiz' denmez", async () => {
    await yaz("src/main.js", "x");
    const r = await kos();
    expect(r.code).toBe(3);
    expect(r.out).toContain("ÖLÇÜLEMEDİ");
  });

  it("proje kökünün dışına çıkan referans için iddia üretilmez", async () => {
    await yaz("index.html", '<script src="../../disarisi.js"></script>');
    expect((await kos()).code).toBe(3);
  });

  it("CANLI YANLIŞ ALARM: public/ altındaki dosya kök URL'den servis edilir — bulgu DEĞİL", async () => {
    // 2026-09-18: MyCL `styles.css`'i public/ altına yazdı; index.html `/styles.css` çağırıyordu.
    // Statik kök klasörlerini bilmediğim için "diskte yok" dedim ve Faz 10'u düşürüp pipeline'ı
    // blokladım — tam da bu betiğin kaçınmak zorunda olduğu hata.
    await yaz("index.html", '<link rel="stylesheet" href="/styles.css"><script src="/src/main.jsx"></script>');
    await yaz("public/styles.css", "body{}");
    await yaz("src/main.jsx", "x");
    const r = await kos();
    expect(r.code).toBe(0);
    expect(r.out).toContain("sağlam");
  });

  it("diğer statik kök adları da tanınır (static/, www/)", async () => {
    await yaz("index.html", '<script src="/app.js"></script>');
    await yaz("static/app.js", "x");
    expect((await kos()).code).toBe(0);
  });

  it("hiçbir statik kökte de yoksa YİNE bulgu (kaçış yolu değil)", async () => {
    await yaz("index.html", '<script src="/gercekten-yok.js"></script>');
    await yaz("public/baska.js", "x");
    const r = await kos();
    expect(r.code).toBe(1);
    expect(r.out).toContain("gercekten-yok.js");
  });

  it("stylesheet de zincire dahil; eksikse yakalanır", async () => {
    await yaz("index.html", '<link rel="stylesheet" href="/src/yok.css">');
    const r = await kos();
    expect(r.code).toBe(1);
    expect(r.out).toContain("yok.css");
  });
});
