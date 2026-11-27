// 2026-11-28 (ekransız deneme koşusu 33): bağımlılık kurulumu ERESOLVE ile düştü, yine de uygulama üç kez başlatıldı;
// kullanıcıya "vite: command not found" gösterildi ve "elle npm install" dendi. Kurulum düşünce başlatma denenmez,
// düşüş nedeni kurulum komutu + çıktının son satırlarıdır. Faz 5 düşüşünün düzeltmesi Faz 5'i yeniden koşar.

import { describe, expect, it } from "vitest";
import { installFailureReason, installOutputTail } from "../src/service-provision.js";
import { fixRouteKind } from "../src/resume-decision.js";

describe("kurulum düşüşü — neden kurulum çıktısının son satırları", () => {
  it("son satırlar boşluklar atılarak alınır; çakışan paket adları kalır", () => {
    const out = [
      "npm error code ERESOLVE",
      "",
      "npm error ERESOLVE unable to resolve dependency tree",
      "npm error Found: vite@7.0.0",
      "npm error Could not resolve dependency:",
      "npm error peer vite@\"^5.0.0\" from @vitejs/plugin-react@4.2.0",
      "   ",
    ].join("\n");
    const tail = installOutputTail(out, 3);
    expect(tail).toBe(
      'npm error Found: vite@7.0.0\nnpm error Could not resolve dependency:\nnpm error peer vite@"^5.0.0" from @vitejs/plugin-react@4.2.0',
    );
  });
  it("düşüş nedeni komutu ve çıktıyı taşır, uygulamanın başlatılmadığını söyler", () => {
    const r = installFailureReason({ cmd: "npm install", outputTail: "npm error peer vite@^5" });
    expect(r).toContain("`npm install`");
    expect(r).toContain("NOT started");
    expect(r).toContain("npm error peer vite@^5");
  });
});

describe("Faz 5 düşüşünün düzeltme yolu Faz 5'i yeniden koşar", () => {
  it("Faz 5 düşüşünde backend-only → ui-only (rötuş kipi Faz 5'i koşar)", () => {
    expect(fixRouteKind("backend-only", 5)).toBe("ui-only");
  });
  it("öteki etiketler ve öteki fazlar değişmez", () => {
    expect(fixRouteKind("ui-only", 5)).toBe("ui-only");
    expect(fixRouteKind("full-stack", 5)).toBe("full-stack");
    expect(fixRouteKind("backend-only", 8)).toBe("backend-only");
    expect(fixRouteKind("backend-only", undefined)).toBe("backend-only");
  });
});
