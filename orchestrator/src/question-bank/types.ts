// İkili Soru Bankası — tip modeli (deterministik omurga, Dilim 1).
//
// Kontrol-noktası deterministik TRIPWIRE: kod-kararlı değişmezleri ikili
// (Evet=yeşil) sorulara indirger, yanıtı KOD verir — LLM yanıt-yolunda YOK.
// Bu modül SADECE tip + saf veri; I/O (depolama/üretim/lock) ayrı dilimde.
//
// KRİTİK ÇERÇEVE: bu bir DOĞRULUK-KAPISI DEĞİL. "Hepsi yeşil" yalnızca
// "yazılmış mekanik değişmezler tutuyor" demek; "iş doğru" demek DEĞİL. Banka
// yalnız kod-kararlı soruları taşır; yargı gerektiren her şey ayrı hatta gider.

import type { StackId } from "../types.js";

/**
 * Bir check'in ham yürütme sonucu DÖRT-değerli — ikili-by-construction DEĞİL.
 * "INCONCLUSIVE" (araç yok / komut crash / timeout) ASLA "Evet"e çevrilmez;
 * sessiz sahte-yeşil panzehiri. "NA" = bu stack/artefakt için uygulanamaz
 * (profil komutu null) — cezalandırılmaz ama raporda "uncovered" görünür.
 */
export type CheckOutcome = "PASS" | "FAIL" | "INCONCLUSIVE" | "NA";

/** Sorunun aciliyet sınıfı — yalnız "blocking" FAIL pipeline'ı durdurur. */
export type BlockingClass = "blocking" | "advisory";

/** Bir checkpoint'in toplu hükmü. INCONCLUSIVE → infra-hattı (defect değil). */
export type GateDecision = "green" | "halt_defect" | "halt_infra";

/**
 * Soru-bankası KEY'i — checkpoint × stack × artefakt-tipi. HER eksen
 * deterministik (FS-türevli): checkpoint sabit, stack `detectStack()`,
 * artefakt profil `artifact_globs`'tan. project_type (LLM, 'unknown'a
 * fail-soft) KEY'e GİRMEZ — soft kova seçimi = laundering.
 */
export interface BankKey {
  /** Gate/checkpoint kimliği — örn. "phase-10". */
  checkpoint: string;
  /** detectStack() çıktısı — deterministik. */
  stack: StackId;
  /** Profil artifact_globs eşleşmesi; eşleşmeyen → WIDEST_ARTIFACT ("*"). */
  artifact: string;
}

/**
 * Bir check'i yürüten komutun ternary'e çevrim sözleşmesi. Mevcut
 * `mechanical_config.tool_error_codes` deseniyle aynı omurga:
 *   exit 0 → PASS, inconclusive kodu → INCONCLUSIVE, diğer → FAIL.
 */
export interface CheckSpec {
  /** Hedef-proje cwd'sinde koşturulacak deterministik komut. Boş → NA. */
  cmd: string;
  /**
   * "Bulgu değil, değerlendirilemedi" exit kodları (örn. semgrep crash 2/7).
   * Bunlar INCONCLUSIVE'e maplenir, ASLA Yes'e değil. 126/127 (not-exec /
   * not-found) ve 124/137/143 (timeout/kill) zaten daima INCONCLUSIVE.
   */
  inconclusive_codes?: number[];
}

/**
 * Banka sorusu. `text` İKİLİ ve Evet=yeşil polariteli ("X JSON ile mi
 * yapılmış?" → Evet=geçer). `real_to_proxy`: partition-laundering'e karşı,
 * checkin gerçek özelliği mi yoksa proxy'yi mi ölçtüğü yazılı kalır.
 */
export interface BankQuestion {
  id: string;
  /** İkili, Evet=yeşil polariteli soru metni (insan-raporu için). */
  text: string;
  /** Yanıtı üreten deterministik check. */
  check: CheckSpec;
  blocking_class: BlockingClass;
  /** "gerçek özellik → ölçülen proxy" eşlemesi (denetlenebilir partition). */
  real_to_proxy: string;
}

/**
 * Bir KEY için sorular + sürüm. Diskte:
 * questions/<checkpoint>/<stack>/<artifact>.json (Dilim 2 depolama).
 */
export interface QuestionBank {
  key: BankKey;
  questions: BankQuestion[];
  /** Şema sürümü — gelecekte göç için. */
  version: number;
}

/** Tek bir sorunun değerlendirme sonucu. */
export interface QuestionVerdict {
  question_id: string;
  outcome: CheckOutcome;
  blocking_class: BlockingClass;
}

/** Kapsama-şeffaflığı: "hepsi yeşil ≠ doğru" rakamla görünür olsun diye. */
export interface CoverageReport {
  pass: number;
  fail: number;
  inconclusive: number;
  na: number;
  total: number;
  /** Mekanik kapsama oranı = pass / total (total 0 ise 0). */
  fraction: number;
}

/** Bir checkpoint'in toplu hükmü + dökümü. */
export interface GateResult {
  decision: GateDecision;
  /** Blocking sınıfı FAIL'ler — halt_defect sebebi. */
  blocking_fail: QuestionVerdict[];
  /** Blocking sınıfı INCONCLUSIVE'ler — halt_infra sebebi. */
  blocking_inconclusive: QuestionVerdict[];
  /** Advisory FAIL/INCONCLUSIVE — durdurmaz, toplu rapora girer. */
  advisory_findings: QuestionVerdict[];
  coverage: CoverageReport;
}

/** Banka dosyalarının şema sürümü. */
export const BANK_SCHEMA_VERSION = 1;
