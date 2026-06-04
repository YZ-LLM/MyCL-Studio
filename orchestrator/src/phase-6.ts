// phase-6 — UI İncelemesi (DEFERRED mode, MyCL_Pseudocode.md:145-174).
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

import { appendAudit } from "./audit.js";
import type { MyclConfig } from "./config.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import type { PhaseDeps } from "./phase-deps.js";
import { isProcessAliveSync } from "./process-utils.js";
import { restartDevServerSimple } from "./smoke-test.js";
import type { State } from "./types.js";

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
    const alive =
      this.state.dev_server_pid !== undefined &&
      isProcessAliveSync(this.state.dev_server_pid);
    if (!alive) {
      log.info("phase-6", "dev server not alive — restarting for UI review");
      // restartDevServerSimple kendi mesajlarını yazar (✅ hazır / tanı) +
      // tarayıcıyı açar + state.dev_server_pid'i (ref) günceller.
      const restart = await restartDevServerSimple(this.state, this.config);
      if (restart.ok) {
        // Yeni pid'i persist et — deferred yol normalde state kaydetmez; engine
        // bu statePatch'i uygular (yeniden açılışta zombi/yanlış pid olmasın).
        this.statePatch = { dev_server_pid: this.state.dev_server_pid };
      } else {
        // Yeniden başlatılamadı — "tarayıcıda açıldı" İDDİA ETME (dürüst). Tanıyı
        // restartDevServerSimple zaten yazdı; kullanıcıya net sonraki adım ver.
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
    }

    emitChatMessage(
      "system",
      "👀 **Faz 6: UI İncelemesi** — Uygulama tarayıcıda açıldı.\n\n" +
        "UI'yi inceledikten sonra composer'a yaz:\n" +
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
