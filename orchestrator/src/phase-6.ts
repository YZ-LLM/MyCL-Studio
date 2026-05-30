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
// MyclConfig phase-6 deferred mode'da kullanılmıyor (PhaseDeps üzerinden geliyor).
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import type { PhaseDeps } from "./phase-deps.js";
import type { State } from "./types.js";

export class Phase6Controller {
  public statePatch: Partial<State> = {};
  /** Fail durumunda kullanıcıya gösterilecek mesaj için error context. */
  public lastFailReason?: string;

  private readonly state: State;
  constructor(deps: PhaseDeps) {
    this.state = deps.state;
    // Phase 6 deferred mode — config/spec şu an kullanılmıyor; v15.1.2 PhaseDeps
    // pattern'i altına alındı (gelecekte gerekirse erişilebilir).
    void deps.config;
    void deps.spec;
  }

  async run(): Promise<"deferred"> {
    log.info("phase-6", "deferred start");

    if (!this.state.dev_server_pid) {
      emitChatMessage(
        "system",
        "⚠ Dev server çalışmıyor — Faz 5'yı önce tamamlamalısın. **▶ Çalıştır** ile başlatabilirsin.",
      );
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
