// pipeline-end-summary — SAF: akış-sonu DÜRÜST özet satırlarını üretir.
//
// "Sessizce TAMAMLANDI deme" (Ümit'in #1 endişesi): mekanik gate'ler (Faz 10-17)
// SOFT olduğundan pipeline bir gate patlasa bile `phase-N-complete` yazıp devam
// eder → eski özet yalnız smoke/auth'a bakıp "Akış tamamlandı" diyebiliyordu. Bu
// modül computeVerdict (gate-fail + güvenlik-skip) ile Faz-16 doğrulamasını
// birleştirip işin GERÇEKTEN doğrulanıp doğrulanmadığını açıkça yazar.
//
// Saf (IO yok) → orchestrator vitest'te test edilebilir; index.ts yalnız audit/
// cost okuyup bu fonksiyonu çağırır + sonucu emit eder.

import type { HarnessVerdict } from "./harness-verdict.js";
import type { Phase16Verification } from "./playwright-setup.js";

/** readCosts CostRecord'unun bu özetin ihtiyaç duyduğu yapısal alt-kümesi. */
export interface PipelineEndCost {
  phase: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

export interface PipelineEndInput {
  /** state.intent_summary (boş olabilir). */
  intent: string;
  /** Faz 16 (E2E) doğrulama: smoke gerçek mi yer-tutucu mu, giriş yapıldı mı. */
  v16: Phase16Verification;
  /** computeVerdict çıktısı; audit okunamazsa null (özet yine üretilir). */
  verdict: HarnessVerdict | null;
  /** Faz-bazında token harcaması (boş olabilir). */
  costs: PipelineEndCost[];
}

/**
 * SAF: akış-sonu özet satırları. Gate-fail / güvenlik-skip / yer-tutucu-test /
 * giriş-yok varsa açık "KISMÎ/BAŞARISIZ — doğrulandığını söyleyemem" verdict'i;
 * hiçbiri yoksa "✅ Tamamlandı". Verdict kelimesi geliştiricinin dilinde (TR).
 */
export function buildPipelineEndLines(input: PipelineEndInput): string[] {
  const { intent, v16, verdict, costs } = input;
  const lines: string[] = ["📋 **Akış özeti**"];
  lines.push(
    intent
      ? `• İstediğin: ${intent.slice(0, 200)}`
      : "• İstediğin: (kayıtlı bir niyet özeti yok)",
  );

  const uyarilar: string[] = [];
  // Mekanik kalite-gate'leri (lint/test/perf/güvenlik/e2e/load) — en yüksek öncelik.
  if (verdict && verdict.gateFailures.length > 0) {
    const fazlar = verdict.gateFailures.map((g) => `Faz ${g.phase}`).join(", ");
    uyarilar.push(
      `Kalite-gate'leri geçemedi: ${fazlar} — bu fazlar başarısız ama akış devam etti (sonuç doğrulanmadı).`,
    );
  }
  if (verdict && verdict.securitySkipped.length > 0) {
    uyarilar.push(
      `Güvenlik taraması atlandı (${verdict.securitySkipped.join(", ")}) — araç eksikti, "tam tarandı" denemez.`,
    );
  }
  if (v16.smokeKind === "placeholder") {
    uyarilar.push(
      "E2E testi genel bir sayfa kontrolüydü; istediğin özellik **özel olarak test edilmedi**.",
    );
  }
  if (v16.authStatus === "placeholder") {
    uyarilar.push("Giriş yapılmadı (giriş bilgisi yer tutucu).");
  }

  if (uyarilar.length > 0) {
    lines.push("• ⚠ Dürüst uyarı: " + uyarilar.join(" "));
    const sonucKelime =
      verdict?.verdict === "FAIL" ? "BAŞARISIZ" : "KISMÎ (tam doğrulanmadı)";
    lines.push(
      `• Sonuç: ${sonucKelime} — akış ilerledi ama yukarıdaki nedenlerle işin **gerçekten doğrulandığını söyleyemem**.`,
    );
  } else {
    lines.push("• Sonuç: ✅ Tamamlandı — tüm gate'ler yeşil, güvenlik tarandı.");
  }

  // Token gözlemi — toplam + per-faz döküm (regresyon görünür).
  if (costs.length > 0) {
    const inTok = costs.reduce((s, c) => s + c.input_tokens, 0);
    const outTok = costs.reduce((s, c) => s + c.output_tokens, 0);
    const cacheRead = costs.reduce((s, c) => s + c.cache_read_input_tokens, 0);
    const turns = costs.reduce((s, c) => s + c.turns, 0);
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    lines.push(
      `• 🧮 Token: ${k(inTok)} giriş / ${k(outTok)} çıkış · ${turns} tur · cache okuma ${k(cacheRead)}`,
    );
    const perPhase = costs
      .filter((c) => c.input_tokens + c.output_tokens > 0)
      .map((c) => `Faz ${c.phase}=${k(c.input_tokens + c.output_tokens)}`)
      .join(", ");
    if (perPhase) lines.push(`   ${perPhase}`);
  }

  return lines;
}
