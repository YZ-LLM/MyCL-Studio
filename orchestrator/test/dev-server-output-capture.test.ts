// dev-server-output-capture — sunucu açılamadığında yakalanan GERÇEK çıktının başı kaybolmasın.
//
// CANLI KANIT (ekransız deneme koşusu 11, 2026-11-27): `npm run dev` bir saniyede öldü. Çıktı yalnız son
// 4000 karakterlik halkada tutuluyordu; esbuild'in uzun yığın izi halkayı doldurunca ilk hata satırı
// atıldı, ize yığının son 500 karakteri yazıldı ve kullanıcıya giden ileti sabit bir tahmin listesiyle
// "yeni terminalde elle başlatın" diyordu. Faz 6 kaydı yalnız `dev_server_restart_failed` taşıyordu.
//
// Gerçek süreç başlatılmaz: yakalama ve ileti saf işlevlerle, ileti için gerçek geçici klasörle sınanır.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_HEAD_MAX,
  CAPTURE_TAIL_MAX,
  appendCapturedOutput,
  buildDevServerFailMessage,
  clipHeadTail,
  extractErrorLines,
  renderCapturedOutput,
  type CapturedOutput,
} from "../src/dev-server-launcher.js";

const ERROR_LINE = "✘ [ERROR] The service was stopped: write EPIPE";
const STACK_LINE = "    at /proje/node_modules/esbuild/lib/main.js:968:34";

/** Koşu 11'in biçimi: başta hata satırı, ardından 4000 karakterden çok daha uzun bir yığın. */
function longCrashOutput(): string {
  const stack = Array.from({ length: 200 }, () => STACK_LINE).join("\n");
  expect(stack.length).toBeGreaterThan(CAPTURE_TAIL_MAX);
  return `> deneme@0.0.0 dev\n> vite --port 5173 --strictPort\n\n${ERROR_LINE}\n${stack}\n    at Socket.afterClose (main.js:613:28)\n`;
}

/** Çıktıyı sürecin yaptığı gibi küçük parçalar hâlinde yakala. */
function captureInChunks(text: string, size = 97): string {
  let c: CapturedOutput = { head: "", tail: "", dropped: false };
  for (let i = 0; i < text.length; i += size) c = appendCapturedOutput(c, text.slice(i, i + size));
  return renderCapturedOutput(c);
}

async function mkProject(pkg: object): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "mycl-dev-out-"));
  await fs.writeFile(join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

const VITE_PKG = { scripts: { dev: "vite" } };

describe("yakalanan çıktı — baş da saklanır", () => {
  it("4000 karakterden uzun yığında ilk hata satırı kayıtta kalır, yığının sonu da", () => {
    const out = captureInChunks(longCrashOutput());
    expect(out).toContain(ERROR_LINE); // eskiden halka bunu atıyordu
    expect(out).toContain("Socket.afterClose"); // sonu da duruyor
    expect(out).toContain("(çıktının ortası atıldı)"); // atılan kısım saklanmıyor, açıkça işaretli
    expect(out.length).toBeLessThanOrEqual(CAPTURE_HEAD_MAX + CAPTURE_TAIL_MAX + 40);
    // İz satırı da baş + son taşır (eskiden output.slice(-500)).
    const logged = clipHeadTail(out, 600, 400);
    expect(logged).toContain(ERROR_LINE);
    expect(logged).toContain("Socket.afterClose");
  });

  it("kısa çıktı olduğu gibi kalır (işaret yok)", () => {
    const short = `${ERROR_LINE}\n${STACK_LINE}`;
    expect(captureInChunks(short, 5)).toBe(short);
  });

  it("ilk hata satırları yığın satırlarını atlar", () => {
    const lines = extractErrorLines(captureInChunks(longCrashOutput()));
    expect(lines[0]).toBe(ERROR_LINE);
    expect(lines.some((l) => l.startsWith("at "))).toBe(false);
  });
});

describe("buildDevServerFailMessage — gerçek hata satırları", () => {
  it("süreç öldü + çıktı var → ileti hata satırını içerir, tahmin listesi ve 'elle başlatın' yok", async () => {
    const dir = await mkProject(VITE_PKG);
    try {
      const msg = await buildDevServerFailMessage(dir, -1, 5173, 20_000, false, {
        phaseLabel: "Faz 6",
        output: captureInChunks(longCrashOutput()),
      });
      expect(msg).toContain(ERROR_LINE);
      expect(msg).toContain("Sürecin bildirdiği ilk hata satırları");
      expect(msg).not.toContain("Olası nedenler");
      expect(msg).not.toContain("manuel başlatın");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("hiç çıktı yoksa ileti eskisi gibi tahmin listesi ve 'elle başlatın' yolunu gösterir", async () => {
    const dir = await mkProject(VITE_PKG);
    try {
      for (const opts of [{}, { output: "" }, { output: "   \n  " }]) {
        const msg = await buildDevServerFailMessage(dir, -1, 5173, 20_000, false, opts);
        expect(msg).toContain("Olası nedenler");
        expect(msg).toContain("manuel başlatın");
        expect(msg).not.toContain("Sürecin bildirdiği ilk hata satırları");
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("çıktı var ama hata sözcüğü yok (yalnız npm başlığı) → başlık 'hata' diye gösterilmez, tahmin listesi kalır", async () => {
    const dir = await mkProject(VITE_PKG);
    try {
      const banner = "> deneme@0.0.0 dev\n> vite --port 5173 --strictPort\nKilled";
      expect(extractErrorLines(banner)).toEqual([]);
      const msg = await buildDevServerFailMessage(dir, -1, 5173, 20_000, false, { output: banner });
      expect(msg).not.toContain("Sürecin bildirdiği ilk hata satırları");
      expect(msg).toContain("Sürecin son çıktı satırları");
      expect(msg).toContain("Killed");
      expect(msg).toContain("Olası nedenler");
      expect(msg).not.toContain("manuel başlatın"); // çıktı yakalandı → elle başlatma önerilmez
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("sıradan sözcükler hata sayılmaz (büyük küçük harf duyarlı hata kodu)", () => {
    expect(extractErrorLines("  ➜  Network: use --host to expose\nFound 0 errors\n- Environments: .env.local")).toEqual([]);
    expect(extractErrorLines("Error: listen EADDRINUSE: address already in use :::5173")).toHaveLength(1);
  });

  it("REGRESYON: öteki dallar anlamca aynı; çıktı varsa yalnız hata satırları eklenir", async () => {
    const dir = await mkProject({ scripts: { start: "node server.js" } });
    try {
      const msg = await buildDevServerFailMessage(dir, -1, 3000, 20_000, false, { output: ERROR_LINE });
      expect(msg).toContain("backend/start-tabanlı proje");
      expect(msg).toContain(ERROR_LINE);
      const deps = await buildDevServerFailMessage(dir, -1, 3000, 20_000, false, { depsMissing: true, output: ERROR_LINE });
      expect(deps).toContain("Bağımlılıklar kurulu değil");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
