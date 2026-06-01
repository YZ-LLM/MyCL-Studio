// intent-router/types — kullanıcı mesajı sınıflandırma + dispatch tipleri.
//
// Vibe coding evrimi (2026-05-19): MyCL artık her user_message'i Phase 1'e
// zorla göndermez. LLM-based intent classifier mesajın **türünü** belirler;
// router uygun handler'a dispatch eder. Kullanıcı kuralı [[feedback-
// multi-modal-dispatch]]: "kullanıcı manuel komut çalıştırmamalı; MyCL kendi
// tetikler; destructive eylemler onaylı."

export type IntentKind =
  /** Yeni özellik, refactor, sıfırdan proje: "feature ekle", "spec yaz". */
  | "develop"
  /** Hazır komut çalıştır: "projeyi çalıştır", "test", "build", "install". */
  | "command"
  /** Yeni dosya yarat: "yeni dosya src/utils.ts oluştur". (Tur B placeholder) */
  | "file_create"
  /** Mevcut dosyayı değiştir: "şu function'ı düzelt". (Tur B placeholder) */
  | "file_edit"
  /** Dosya sil — destructive: onay askq gerekir. (Tur C placeholder) */
  | "file_delete"
  /** Proje / kod / MyCL hakkında soru. (Tur D placeholder) */
  | "question"
  /** Tartışma, "şunu denesek mi?". (Tur D placeholder) */
  | "suggestion"
  /** Açık resume: "devam et", "continue", "sürdür". */
  | "resume_pipeline"
  /** Selam, teşekkür, geyik. */
  | "chat"
  /**
   * Bug rapor / hata mesajı / "düzelt": Phase 0 Debug Triage'e dispatch
   * edilir. Pipeline reset YAPMA — mevcut spec/kod üzerinde Claude
   * Read/Grep/Bash ile araştırır + fix uygular veya diagnostic rapor sunar.
   */
  | "debug"
  /** Phase 6 UI Review'da kullanıcı onayı ("tamam", "iyi", "devam"). */
  | "approve_ui"
  /** Phase 6'de UI değişiklik isteği — Faz 5 tweak mode'a yönlendirir. */
  | "revise_ui"
  /** Pipeline durdurma cue'ları ("iptal", "vazgeç"). */
  | "cancel_pipeline";

export interface IntentClassification {
  kind: IntentKind;
  /** LLM'in 1-2 cümlelik gerekçesi — UI'da şeffaflık için gösterilir. */
  reasoning: string;
  /**
   * "command" intent için: kullanıcının cümlesinden çıkarılmış spesifik komut
   * (örn. "npm run dev", "npm test"). Yoksa handler kind'a göre stack komutu
   * çıkarır.
   */
  extracted_command?: string;
  /**
   * v15.7 (2026-05-27): "command" intent için: UI butonundan gelen alt-tür
   * (run/test/build/install/lint). Önceden orchestrator metni regex'le
   * yorumluyordu (`detectIntentKind`); artık caller doğrudan veriyor.
   * Yoksa varsayılan "run" kabul edilir (gerizek bypass için).
   */
  intent_kind?: "run" | "test" | "build" | "install" | "lint";
  /**
   * "chat" intent için: cevaplanacak konunun kısa özeti — context için ipucu.
   */
  chat_topic?: string;
}

/**
 * Caller'a dispatch sonucunu söyleyen outcome. v15.7 öncesi router.ts içinde
 * dispatchByIntent tarafından üretilirdi; v15.8'de legacy router.ts kaldırıldı
 * (chat/question handler'ları da ölüydü, silindi) — artık bu tipi yalnızca
 * executeAgentDecision (index.ts) `fakeOutcome` olarak construct ediyor.
 *
 * `handled: true` = yan-eylem yapıldı (command handler); caller başka iş yapmaz.
 * `handled: false` = caller develop/resume/debug/approve_ui/revise_ui/
 * cancel_pipeline akışını çalıştırmalı.
 */
export type DispatchOutcome =
  | { handled: true; intent: IntentClassification }
  | {
      handled: false;
      intent: IntentClassification;
      action:
        | "develop_new_or_iter"
        | "resume_pipeline"
        | "debug_triage"
        | "approve_ui"
        | "revise_ui"
        | "cancel_pipeline";
    };

// v15.7 (2026-05-25): IntentClassifierError kaldırıldı — classifier.ts silindi.
