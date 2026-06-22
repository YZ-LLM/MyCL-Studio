// persistent-session-health — kalıcı oturum hata SINIFLANDIRMASI (YZLLM 2026-06-22 canlı teşhis).
//
// Kök sorun: translator-en-to-tr "kararsız" uyarıları çöp girdiden DEĞİL, dış API kesintilerinden
// (timeout/ConnectionRefused) doğuyordu; sezgisel bunları "oturum bozuk" diye yanlış etiketliyordu.
// isTransientOutage geçici-dış kesintiyi yapısal bozulmadan ayırır → mesaj dürüst, sıcak oturum boş yere ölmez.

import { describe, it, expect } from "vitest";
import { isTransientOutage } from "../src/persistent-cli-session.js";

describe("isTransientOutage — dış kesinti vs yapısal bozulma", () => {
  // GERÇEK transcript çıktıları (session-transcripts.jsonl, başarısız translator turları).
  const transient = [
    { ok: false, text: "Request timed out", error: "session turn is_error" },
    { ok: false, text: "API Error: Unable to connect to API (ConnectionRefused)", error: "session turn is_error" },
    { ok: false, text: "", error: "turn timeout 60000ms" },
    { ok: false, text: "Overloaded", error: "session turn is_error" },
    { ok: false, text: "", error: "fetch failed (ECONNRESET)" },
    { ok: false, text: "429 Too Many Requests", error: "session turn is_error" },
    { ok: false, text: "503 Service Unavailable", error: "session turn is_error" },
  ];
  for (const r of transient) {
    it(`GEÇİCİ: ${(r.text || r.error).slice(0, 40)}`, () => {
      expect(isTransientOutage(r)).toBe(true);
    });
  }

  // Yapısal: oturumun kendisi bozuk — cold-start GERÇEKTEN gerekli, "kararsız" damgası doğru.
  const structural = [
    { ok: false, text: "", error: "session start failed" },
    { ok: false, text: "", error: "stdin write failed: EPIPE" },
    { ok: false, text: "", error: "session exited code=1" },
    { ok: false, text: "", error: "no child" },
  ];
  for (const r of structural) {
    it(`YAPISAL: ${r.error}`, () => {
      expect(isTransientOutage(r)).toBe(false);
    });
  }

  it("çöp log girdisinin BAŞARILI çevirisi (ok:true) zaten sınıflandırmaya girmez", () => {
    // Repro kanıtı: çöp log satırı haiku tarafından başarıyla çevrildi (is_error:false).
    // applyHealth ok:true'da hiç classify etmez; burada sadece transient olmadığını teyit.
    expect(isTransientOutage({ ok: false, text: "GET /api/errors 404 62ms'de", error: undefined })).toBe(false);
  });
});
