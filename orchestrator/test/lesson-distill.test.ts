// lesson-distill — sızdırmasız projeler arası öğrenme döngüsü testleri.
// KAYIP > SIZINTI: leakGate fail-closed; LLM enjekte (CI'da LLM yok); depo MYCL_HOME izole.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendGlobalLesson,
  distillAndStoreGlobalLesson,
  formatGlobalLessonsTR,
  leakGate,
  parseDistilledLesson,
  readGlobalLessons,
} from "../src/lesson-distill.js";
import type { MyclConfig } from "../src/config.js";

const CLEAN =
  "Test çerçevesini dosya uzantısından değil, içerikteki imzadan tespit et; uzantı tek başına yanıltır.";

describe("leakGate — deterministik sızıntı kapısı (fail-closed)", () => {
  it("temiz, genel Türkçe ilke → GEÇER", () => {
    expect(leakGate(CLEAN, "arcelik").ok).toBe(true);
  });

  it("genel çerçeve adları (Next.js, Node.js) dosya-adı sayılmaz → GEÇER", () => {
    const v = leakGate("Next.js projelerinde derleme çıktısını taramadan hariç tut, sahte bulgu üretir.", "cave5");
    expect(v.ok).toBe(true);
  });

  it("dosya yolu → RED", () => {
    expect(leakGate("Sorun /Users/ali/proje/src dizinindeki yapılandırmadan kaynaklanıyordu, oradan düzelt.", "p").ok).toBe(false);
  });

  it("çıplak dosya adı → RED", () => {
    expect(leakGate("Hata auth.service.ts dosyasındaki oturum kontrolünden geliyordu, orayı sıkılaştır.", "p").ok).toBe(false);
  });

  it("camelCase tanımlayıcı → RED", () => {
    expect(leakGate("Oturum süresini getUserProfile fonksiyonu üzerinden doğrulamak gerekir, aksi halde yanılır.", "p").ok).toBe(false);
  });

  it("snake_case tanımlayıcı → RED", () => {
    expect(leakGate("Veri tabanı bağlantısını user_repository katmanında havuzla, yoksa bağlantı tükenir.", "p").ok).toBe(false);
  });

  it("URL / e-posta / backtick → RED", () => {
    expect(leakGate("Ayrıntı için https://ornek.com/dok sayfasına bakılmalı, oradaki adımlar geçerli.", "p").ok).toBe(false);
    expect(leakGate("Sorumluya ali@ornek.com adresinden ulaşıp anahtarı yeniletmek gerekiyordu burada.", "p").ok).toBe(false);
    expect(leakGate("Kuralı `nosemgrep` ekiyle susturmak yerine kök nedeni düzeltmek gerekir her zaman.", "p").ok).toBe(false);
  });

  it("proje adı → RED (büyük/küçük harf duyarsız)", () => {
    expect(leakGate("Bu ders Arcelik projesindeki panel davranışından çıkarıldı, genel kural şudur.", "arcelik").ok).toBe(false);
  });

  it("çok kısa / çok uzun → RED", () => {
    expect(leakGate("Kısa ders.", "p").ok).toBe(false);
    expect(leakGate("Çok uzun. " + "Aynı cümle tekrar ediyor. ".repeat(30), "p").ok).toBe(false);
  });
});

describe("parseDistilledLesson", () => {
  it("geçerli global_lesson → ayrışır; kategori küçük harfe iner", () => {
    const r = parseDistilledLesson(`{"kind":"global_lesson","category":"Test-Kurgusu","principle_tr":"${CLEAN}"}`);
    expect(r).toEqual({ category: "test-kurgusu", principle_tr: CLEAN });
  });

  it("skip → 'skip' (dürüst atlama)", () => {
    expect(parseDistilledLesson('{"kind":"skip"}')).toBe("skip");
  });

  it("bozuk çıktı / yanlış kind → null (fail-closed)", () => {
    expect(parseDistilledLesson("ders şu: her zaman dikkat")).toBeNull();
    expect(parseDistilledLesson('{"kind":"başka","principle_tr":"x"}')).toBeNull();
  });

  it("geçersiz kategori → 'genel'e düşer", () => {
    const r = parseDistilledLesson(`{"kind":"global_lesson","category":"çok geçersiz !! kategori","principle_tr":"${CLEAN}"}`);
    expect(r).toEqual({ category: "genel", principle_tr: CLEAN });
  });
});

describe("global depo + uçtan uca damıtma (MYCL_HOME izole, LLM enjekte)", () => {
  let home: string;
  const orig = process.env.MYCL_HOME;
  const cfg = {} as MyclConfig; // llm enjekte edildiği için config'e dokunulmaz
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "mycl-glessons-"));
    process.env.MYCL_HOME = home;
  });
  afterEach(async () => {
    if (orig === undefined) delete process.env.MYCL_HOME;
    else process.env.MYCL_HOME = orig;
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  const raw = { projectRoot: "/tmp/proje-x", problem: "sorun", resolution: "çözüm", principle: "ilke" };

  it("append + read + format round-trip (limit son N)", async () => {
    await appendGlobalLesson({ ts: 1, category: "a", principle_tr: "Birinci genel ders cümlesi burada." });
    await appendGlobalLesson({ ts: 2, category: "b", principle_tr: "İkinci genel ders cümlesi burada." });
    const all = await readGlobalLessons(1);
    expect(all.length).toBe(1);
    expect(all[0].category).toBe("b");
    expect(formatGlobalLessonsTR(all)).toBe("- [b] İkinci genel ders cümlesi burada.");
  });

  it("temiz ders → stored + dosyada", async () => {
    const out = await distillAndStoreGlobalLesson(cfg, raw, async () =>
      `{"kind":"global_lesson","category":"tespit","principle_tr":"${CLEAN}"}`);
    expect(out).toBe("stored");
    expect((await readGlobalLessons()).map((l) => l.principle_tr)).toEqual([CLEAN]);
  });

  it("sızıntılı ders → rejected + dosyaya YAZILMAZ (kayıp > sızıntı)", async () => {
    const out = await distillAndStoreGlobalLesson(cfg, raw, async () =>
      '{"kind":"global_lesson","category":"x","principle_tr":"Sorun /Users/ali/proje/src altında çözüldü, oradan bak."}');
    expect(out).toBe("rejected");
    expect(await readGlobalLessons()).toEqual([]);
  });

  it("aynı ilke ikinci kez → duplicate (tekilleştirme)", async () => {
    const llm = async () => `{"kind":"global_lesson","category":"tespit","principle_tr":"${CLEAN}"}`;
    expect(await distillAndStoreGlobalLesson(cfg, raw, llm)).toBe("stored");
    expect(await distillAndStoreGlobalLesson(cfg, raw, llm)).toBe("duplicate");
    expect((await readGlobalLessons()).length).toBe(1);
  });

  it("skip ve bozuk çıktı → saklanmaz", async () => {
    expect(await distillAndStoreGlobalLesson(cfg, raw, async () => '{"kind":"skip"}')).toBe("skip");
    expect(await distillAndStoreGlobalLesson(cfg, raw, async () => "anlamsız çıktı")).toBe("error");
    expect(await readGlobalLessons()).toEqual([]);
  });
});
