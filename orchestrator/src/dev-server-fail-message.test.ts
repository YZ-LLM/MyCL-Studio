import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDevServerFailMessage } from "./dev-server-launcher.js";

// DONMUŞ HEDEF #1: otonom ("hiçbir şey sorma") modda MyCL kullanıcıya "sen çöz + 'devam et' yaz" DEMEMELİ.
// Canlı bug: Faz 5 dev-server fail'de bu park talimatı KOŞULSUZ basılıyordu. Bu testler mod-farkındalığı kilitler.
describe("buildDevServerFailMessage — otonom mod farkındalığı", () => {
  const mkProj = async (pkg?: object): Promise<string> => {
    const dir = await fs.mkdtemp(join(tmpdir(), "dsfm-"));
    if (pkg) await fs.writeFile(join(dir, "package.json"), JSON.stringify(pkg));
    return dir;
  };

  it("neverAsk=false → 'devam et yazın' park talimatı VAR (mevcut manuel davranış)", async () => {
    const dir = await mkProj({ scripts: {} });
    try {
      const msg = await buildDevServerFailMessage(dir, -1, 5173, 15000, false);
      expect(msg).toContain('"devam et"');
      expect(msg).toContain("Faz 5 yeniden başlar");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("neverAsk=true → 'devam et' park talimatı YOK; otonom mesaj VAR", async () => {
    const dir = await mkProj({ scripts: {} });
    try {
      const msg = await buildDevServerFailMessage(dir, -1, 5173, 15000, true);
      expect(msg).not.toContain('"devam et"');
      expect(msg).not.toContain("Faz 5 yeniden başlar");
      expect(msg).toContain("Otonom mod");
      expect(msg).toContain("dürüstçe duruyorum");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("backend/start-tabanlı proje (dev yok, start VAR) → 'npx vite' ÖNERMEZ, backend mesajı verir", async () => {
    // cave gibi: yalnız start script'i olan Express backend. Eski mesaj alakasız "npx vite" öneriyordu.
    const dir = await mkProj({ scripts: { start: "node ./bin/www" } });
    try {
      const msg = await buildDevServerFailMessage(dir, -1, 5173, 15000, true);
      expect(msg).toContain("backend/start-tabanlı proje");
      expect(msg).toContain("npm start");
      expect(msg).not.toContain("npx vite");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("dev de start da yok → mevcut 'npx vite' fallback korunur (geriye-uyumlu)", async () => {
    const dir = await mkProj({ scripts: {} });
    try {
      const msg = await buildDevServerFailMessage(dir, -1, 5173, 15000, true);
      expect(msg).toContain("npx vite");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("varsayılan (param yok) → neverAsk=false davranışı (geriye-uyumlu)", async () => {
    const dir = await mkProj({ scripts: {} });
    try {
      const msg = await buildDevServerFailMessage(dir, -1, 5173, 15000);
      expect(msg).toContain('"devam et"');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("her iki modda da TEŞHİS gövdesi korunur (pid/port/sebep bilgisi)", async () => {
    const dir = await mkProj({ scripts: {} });
    try {
      for (const na of [true, false]) {
        const msg = await buildDevServerFailMessage(dir, -1, 5173, 15000, na);
        expect(msg).toContain("Dev server başlatılamadı");
        expect(msg).toContain("beklenen port=5173");
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
