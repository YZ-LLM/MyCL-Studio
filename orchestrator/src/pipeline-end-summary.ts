// pipeline-end-summary — SAF: akış-sonu DÜRÜST özet satırlarını üretir.
//
// "Sessizce TAMAMLANDI deme" (YZLLM'in #1 endişesi): mekanik gate'ler (Faz 10-17)
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
  if (verdict && verdict.e2eSkipped.length > 0) {
    uyarilar.push(
      `Uçtan uca (E2E) test koşamadı (${verdict.e2eSkipped.join(", ")}) — akış uçtan uca doğrulanmadı.`,
    );
  }
  if (verdict && verdict.realAppSkipped.length > 0) {
    uyarilar.push(
      'Gerçek uygulama doğrulaması koşamadı (Playwright/dev-server yok) — fix yalnız birim-doğrulandı, çalışan app\'te kanıtlanmadı.',
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

  // SAHTE YEŞİL KÖK FİX (2026-09-15, canlı kanıt: cüzdan koşusu). Aşağıdaki dal "Sonuç" satırını
  // hükme değil, UYARI LİSTESİNİN DOLULUĞUNA bakarak seçiyordu. Liste yalnız gate hatası / atlanan
  // tarama / yer tutucu sinyallerinden dolduğu için, listesi boş olan her FAIL sessizce yeşil dala
  // düşüyordu. Kritik olan şu: computeVerdict'in ÜÇ sert FAIL yolu da bu listeleri BOŞ bırakır —
  // kayıt kurcalandı ve boş build dalları sabit boş döner, "pipeline tamamlanmadı" dalında ise koşu
  // hiç gate'e ulaşmadığı için doğal olarak boştur. Yani hüküm ne kadar ağırsa özet o kadar yeşildi.
  // Canlı kanıt: Faz 2-17 HİÇ koşmadı, hüküm FAIL geldi, kullanıcı "tüm gate'ler yeşil" okudu.
  // Hükmün kendi dürüst metni (verdict.summary) zaten üretiliyordu ama hiç okunmuyordu.
  //
  // KAPSAM SINIRI: düzeltme YALNIZ bu özet metnindedir. computeVerdict'in PASS/PARTIAL/FAIL
  // semantiğine dokunulmaz — prototip kaydı (prototype-cache) ve modül stoklaması (module-stock)
  // o hükme bağlıdır; hükmü sertleştirmek onları sessizce devre dışı bırakırdı.
  if (verdict && verdict.verdict !== "PASS" && uyarilar.length === 0) {
    uyarilar.push(verdict.summary);
  }
  // Hüküm HİÇ hesaplanamadıysa (denetim kaydı okunamadı) "tüm gate'ler yeşil" demek kanıtsız bir
  // iddiadır. Çağıran zaten görünür uyarı veriyor ve pipeline_end'i PARTIAL emit ediyor; özet de
  // aynı gerçeği söylesin (üç kanal birbiriyle çelişmesin).
  if (!verdict && uyarilar.length === 0) {
    uyarilar.push(
      "Pipeline sonu hükmü hesaplanamadı (denetim kaydı okunamadı) — gate sonuçları doğrulanmadı.",
    );
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
