// phase-6 — UI İncelemesi (DEFERRED mode).
//
// Faz 5 dev server + browser auto-open ile biter ve STOP. Faz 6 askq önceden
// AÇILMAZ — geliştiricinin bir sonraki turn'undaki free-form cevabı intent
// classification ile yorumlanır:
//   - approve_ui  → phase-6-complete, Faz 7'e geç
//   - revise_ui   → Faz 5'ya geri dön, geri bildirimle yeniden yaz
//   - cancel_pipeline → durur
//   - mixed (approve + revise) → revise kazanır
//   - ambiguous → v15: fallback askq (4 seçenek)
//
// Bu controller askq açmaz, AC döngüsü yapmaz, fix turn'ü tetiklemez. Sadece
// chat'e kısa bir yön gösterici mesaj yazıp "deferred" döner. Orchestrator
// state.current_phase = 6 yapıp STOP eder; bir sonraki user_message router'da
// Phase 6 context'inde işlenir (classifier currentPhase=6 ile çağrılır).

import { formatA11yReport, runAccessibilityScan } from "./accessibility-scan.js";
import { appendAudit } from "./audit.js";
import type { MyclConfig } from "./config.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import type { PhaseDeps } from "./phase-deps.js";
import { ensureDevServerForReview } from "./smoke-test.js";
import type { State } from "./types.js";

/**
 * Erişilebilirlik raporunu kur (SALT-RAPOR; ASLA throw etmez → inceleme akışını bozmaz).
 * Port bilinmiyorsa yaygın 5173'e düşer (yanlışsa tarama görünür "taranamadı" der). Audit'e yazar.
 */
async function buildA11yReport(state: State, port: number | undefined): Promise<string> {
  try {
    const url = `http://localhost:${port ?? 5173}`;
    const result = await runAccessibilityScan(url);
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: 6,
      event: result.ran ? "a11y-scan" : "a11y-scan-skipped",
      caller: "mycl-orchestrator",
      detail: result.ran
        ? `${result.violations.length} violation(s)`
        : (result.skippedReason ?? "").slice(0, 120),
    }).catch(() => {});
    return formatA11yReport(result);
  } catch (err) {
    log.warn("phase-6", "erişilebilirlik raporu kurulamadı (non-fatal)", { error: String(err) });
    return "♿ **Erişilebilirlik (WCAG):** taranamadı (beklenmedik hata; incelemeyi engellemez).";
  }
}

export class Phase6Controller {
  public statePatch: Partial<State> = {};
  /** Fail durumunda kullanıcıya gösterilecek mesaj için error context. */
  public lastFailReason?: string;

  private readonly state: State;
  private readonly config: MyclConfig;
  constructor(deps: PhaseDeps) {
    this.state = deps.state;
    // config — dev server canlı değilse yeniden başlatmak için gerekli.
    this.config = deps.config;
    // spec şu an kullanılmıyor; v15.1.2 PhaseDeps pattern'i (gelecekte erişilebilir).
    void deps.spec;
  }

  async run(): Promise<"deferred"> {
    log.info("phase-6", "deferred start");

    // Dev server gerçekten ayakta mı? UI incelemesi "uygulama tarayıcıda açık"
    // varsayar. Boot-resume bu fazı advanceToNextPhase(5) ile yeniden çalıştırır
    // → Faz 5 (dev server spawn) ATLANIR; ayrıca uygulama kapanınca process ölür
    // ama pid state'te kalır. Eskiden hem "çalışmıyor" hem "tarayıcıda açıldı"
    // çelişkili mesajları çıkıyordu. Canlı değilse YENİDEN BAŞLAT.
    // TEK doğruluk kaynağı (DRY): controller + orkestratör reask yolu (index.ts) aynı garantiyi kullanır.
    const dev = await ensureDevServerForReview(this.state, this.config);
    if (dev.ok && !dev.alreadyAlive) {
      // Yeni pid'i persist et — deferred yol normalde state kaydetmez; engine
      // bu statePatch'i uygular (yeniden açılışta zombi/yanlış pid olmasın).
      this.statePatch = { dev_server_pid: this.state.dev_server_pid };
    } else if (!dev.ok) {
      // Yeniden başlatılamadı — "tarayıcıda açıldı" İDDİA ETME (dürüst). Tanıyı
      // ensureDevServerForReview zaten yazdı; kullanıcıya net sonraki adım ver.
      emitChatMessage(
        "system",
        "⚠ **Faz 6: UI İncelemesi** — Dev server otomatik başlatılamadı (yukarıdaki tanıya bak). `▶ Çalıştır` ile başlat, uygulamayı tarayıcıda inceledikten sonra composer'a `tamam` (Faz 7) veya değişiklik isteğini yaz; `iptal` ile durdurabilirsin.",
      );
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 6,
        event: "phase-6-deferred",
        caller: "mycl-orchestrator",
        detail: "dev_server_restart_failed",
      });
      return "deferred";
    }

    // ♿ Erişilebilirlik (WCAG) SALT-RAPOR — dev-server ayakta, tam da kullanıcının UI'yi incelediği an.
    // Mahkeme kararı: GATE DEĞİL (false-positive→tıkanma riski) → bilgi olarak incelemeye eklenir, oto-fix yok,
    // hiçbir şeyi bloklamaz. Hata olursa görünür "taranamadı" (sessiz değil). Bütünüyle best-effort.
    const a11yReport = await buildA11yReport(this.state, dev.port);

    emitChatMessage(
      "system",
      "👀 **Faz 6: UI İncelemesi** — Uygulama tarayıcıda açıldı.\n\n" +
        a11yReport +
        "\n\nUI'yi inceledikten sonra composer'a yaz:\n" +
        "• Beğendiysen → `tamam` / `devam et` / `onayla` → Faz 7'e geçeriz.\n" +
        "• Değişiklik istiyorsan → ne istediğini doğal cümleyle yaz (örn. _\"butonun rengini koyulaştır\"_) → Faz 5'da uygulanır.\n" +
        "• İptal etmek istiyorsan → `iptal` / `vazgeç` → pipeline durur.",
    );

    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 6,
      event: "phase-6-deferred",
      caller: "mycl-orchestrator",
    });

    return "deferred";
  }
}
