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
import { captureAndCompare, formatVisualReport } from "./visual-regression.js";
import { join } from "node:path";
import { appendAudit } from "./audit.js";
import type { MyclConfig } from "./config.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import { selectRecentRuntimeErrors } from "./errors-db.js";

/** Faz 6 incelemesinde "bu koşuda" sayılan çalışma zamanı hatası penceresi. */
const RUNTIME_ERROR_WINDOW_MS = 10 * 60_000;
import type { PhaseDeps } from "./phase-deps.js";
import { ensureDevServerForReview } from "./smoke-test.js";
import type { State } from "./types.js";

/**
 * Görsel önce/sonra raporunu kur (SALT-RAPOR; ASLA throw etmez — a11y deseni). Önceki Faz 6
 * tabanıyla piksel karşılaştırır; "hiçbir şey sorma" modunda kullanıcı gözünün emniyet ağı.
 * Taban terfisi advanceToNextPhase(6)'da (onay/oto-geçiş) — burada yalnız çekim + rapor.
 */
async function buildVisualReport(
  state: State,
  port: number | undefined,
): Promise<{ text: string; nearlyBlank: boolean }> {
  try {
    const url = `http://localhost:${port ?? 5173}`;
    const result = await captureAndCompare(url, state.project_root);
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: 6,
      event: result.ran ? "visual-diff" : "visual-diff-skipped",
      caller: "mycl-orchestrator",
      detail: result.ran
        ? `baseline=${result.baselineExisted} routes=${result.diffs.length} changed=${result.diffs.filter((d) => d.status !== "unchanged").length}`
        : (result.skippedReason ?? "").slice(0, 120),
    }).catch(() => {});
    return {
      text: formatVisualReport(result),
      // BOŞ SAYFA BAYRAĞI (2026-09-17): eskiden yalnız rapor METNİNE gömülüyordu, hiçbir karar bunu
      // okumuyordu. Canlı kanıt (cüzdan koşusu): `/` neredeyse tek renkti — uygulama hiç mount
      // olmuyordu çünkü giriş dosyası yazılmamıştı — ve inceleme yine de onaylandı. Bayrak artık
      // state'e taşınıyor ve onay kapısı onu görüyor.
      nearlyBlank: result.diffs.some((d) => d.nearlyBlank),
    };
  } catch (err) {
    log.warn("phase-6", "görsel karşılaştırma raporu kurulamadı (non-fatal)", { error: String(err) });
    return {
      text: "🖼️ **Görsel karşılaştırma:** yapılamadı (beklenmedik hata; incelemeyi engellemez).",
      nearlyBlank: false, // ölçülemedi → "boş" İDDİA EDİLMEZ (yanlış alarm yasağı)
    };
  }
}

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
    // 🖼️ Görsel önce/sonra (iterasyonlar arası) SALT-RAPOR — aynı desen; never-ask'ta da görünür.
    const visual = await buildVisualReport(this.state, dev.port);
    const visualReport = visual.text;

    emitChatMessage(
      "system",
      "👀 **Faz 6: UI İncelemesi** — Uygulama tarayıcıda açıldı.\n\n" +
        a11yReport +
        "\n\n" +
        visualReport +
        "\n\nUI'yi inceledikten sonra composer'a yaz:\n" +
        "• Beğendiysen → `tamam` / `devam et` / `onayla` → Faz 7'e geçeriz.\n" +
        "• Değişiklik istiyorsan → ne istediğini doğal cümleyle yaz (örn. _\"butonun rengini koyulaştır\"_) → Faz 5'da uygulanır.\n" +
        "• İptal etmek istiyorsan → `iptal` / `vazgeç` → pipeline durur.",
    );

    // ÇALIŞMA ZAMANI HATASI BAYRAĞI (2026-09-18): uygulama açıldıktan sonra tarayıcı/dev-server
    // hata yayınladıysa bunu onay kapısına taşı. Bu sinyalin bugüne kadar hiçbir tüketicisi yoktu:
    // Vite sürekli "Failed to load url /src/main.jsx" diye bağırdı, uygulama hiç açılmadı ve hiçbir
    // karar bunu görmedi. Okumak best-effort — okunamazsa hata SAYILMAZ (ölçemediğine iddia yok).
    let runtimeHata = 0;
    try {
      const rows = await selectRecentRuntimeErrors(
        join(this.state.project_root, "error_folder", "mycl_errors.db"),
        RUNTIME_ERROR_WINDOW_MS,
      );
      runtimeHata = rows.length;
    } catch (err) {
      log.warn("phase-6", "runtime hata sayımı okunamadı (non-fatal)", { error: String(err) });
    }

    // Boş ekran bayrağını park durumuna taşı — onay kapısı (approve_ui) bunu okuyacak.
    this.statePatch = {
      ...this.statePatch,
      ui_review_blank: visual.nearlyBlank,
      ui_review_runtime_errors: runtimeHata,
    };
    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 6,
      event: "phase-6-deferred",
      caller: "mycl-orchestrator",
      detail: visual.nearlyBlank ? "blank_screen" : "",
    });

    return "deferred";
  }
}

/**
 * SAF: Faz 6 onayı geldi — boş ekran yüzünden bir kez teyit istenmeli mi?
 *
 * Boş bir ekran "gördüm ve beğendim" anlamına gelemez; çıplak onay bir kez geri çevrilir. Ama bu bir
 * gate DEĞİL: kullanıcı ısrar ederse (bayrak temizlendiği için) ikinci onay geçer — irade ezilmez.
 * CANLI KANIT (cüzdan koşusu, 2026-09-16): giriş dosyası hiç yazılmadığı için ekran bomboştu, görsel
 * tarama bunu tespit edip rapora yazdı, ama hiçbir karar okumadı ve inceleme onaylandı (sahte yeşil).
 */
export type BlankScreenGate = { kind: "confirm-needed" } | { kind: "accept" };

export function blankScreenGate(state: { ui_review_blank?: boolean }): BlankScreenGate {
  return state.ui_review_blank ? { kind: "confirm-needed" } : { kind: "accept" };
}

/**
 * SAF: Faz 6 onayı geldi — çalışma zamanı hatası yüzünden bir kez teyit istenmeli mi?
 *
 * `blankScreenGate`'in ikizi ve aynı sözleşme: GATE DEĞİL, bilinçli onay. Bayrak teyit istenirken
 * temizlendiği için ikinci onay geçer — kullanıcının fazına bloklayıcı kapı konmaz (KATI #9).
 * Uygulama açılırken hata fırlatıyorsa "gördüm ve beğendim" demek zor; bunu bir kez sormak,
 * kullanıcının kırık bir uygulamayı farkında olmadan onaylamasını engeller.
 */
export type RuntimeErrorGate = { kind: "confirm-needed"; count: number } | { kind: "accept" };

export function runtimeErrorGate(state: { ui_review_runtime_errors?: number }): RuntimeErrorGate {
  const n = state.ui_review_runtime_errors ?? 0;
  return n > 0 ? { kind: "confirm-needed", count: n } : { kind: "accept" };
}
