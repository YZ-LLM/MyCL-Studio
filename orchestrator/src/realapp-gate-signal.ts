// realapp-gate-signal — GERÇEK-APP doğrulama kapısı SAF karar mantığı (YZLLM 2026-07-21, canlı cave:
// /profile "boş sonuç" bug'ı için MyCL fix yazıp Faz 8'i "complete score=100" damgaladı ama gerçek bug
// SÜRDÜ — çünkü yalnız birim-suite yeşili + repro red→green doğrulandı, GERÇEK ÇALIŞAN UYGULAMA hiç
// görülmedi). Bu modül, bir fix iterasyonunun sonunda gerçek-app doğrulaması (Playwright E2E, orijinal
// buga karşı) KOŞMALI mı diye deterministik karar verir — yanlış-pozitif minimuma indirilmiş.
//
// SAF: FS/LLM yok; caller sinyalleri toplar (getChangedFiles vb.), bu fonksiyon yalnız karar üretir → birim testli.

import { isRuntimeProdFile, isTestPath } from "./file-classify.js";
import type { ProjectType } from "./types.js";

// Web app'te UI-GÖZLENEN görsel/markup varlıklar — çalışma-zamanı kaynak dosyası (.ts/.tsx/.js) DEĞİL ama
// tarayıcıda görünür DOM/görsel davranışı etkiler → gerçek-app E2E ile doğrulanabilir (Playwright toBeVisible
// vb. CSS görünürlüğünü hesaba katar). MAHKEME BULGU 4: salt-CSS görsel bug'ı (örn. z-index/overlay ile buton
// gizli) isRuntimeProdFile'a uymadığı için eskiden gate'i atlatıyordu — oysa bu tam da E2E'nin doğrulayacağı sınıf.
const UI_VISUAL_EXTS = new Set([
  ".css", ".scss", ".sass", ".less", ".html", ".htm",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
]);

/** Dosya çalışma-zamanı davranışını VEYA web UI'sini etkiler mi (E2E ile gözlenebilir mi). */
function isUiOrRuntimeObservable(path: string): boolean {
  if (isRuntimeProdFile(path)) return true; // çalışma-zamanı üretim kaynağı (.ts/.tsx/.js)
  if (isTestPath(path)) return false; // test dosyası → çalışma-zamanı davranışı değil
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return UI_VISUAL_EXTS.has(ext); // stil/markup/görsel → web UI-gözlenen
}

export interface RealAppGateSignals {
  /** Bu iterasyon bir FIX mi (Faz 0 debug / fix-modu kaynaklı)? Kapı yalnız fix'lerde koşar (greenfield/yeni-özellik değil). */
  isFixIteration: boolean;
  /** state.project_type (undefined = sınıflanmamış). */
  projectType: ProjectType | undefined;
  /** project_type unknown iken spec/intent'te UI sinyali (RE_HAS_UI) var mı — fallback. */
  hasUiSpecSignal: boolean;
  /** Fix'in DEĞİŞTİRDİĞİ proje-relative dosyalar. null = tespit edilemedi (non-git / checkpoint yok). */
  changedFiles: string[] | null;
  /** config.features.playwright_enabled !== false — kullanıcı Playwright'ı kapattıysa kapı koşmaz (mevcut toggle korunur). */
  playwrightEnabled: boolean;
}

export interface RealAppGateDecision {
  run: boolean;
  reason: string;
}

/** Playwright ile tarayıcıdan SÜRÜLEBİLİR (UI-gözlenen) proje tipleri. api/cli/library/mobile/ml/game → dışı. */
function isBrowserDriveable(pt: ProjectType | undefined, hasUiSpecSignal: boolean): boolean {
  if (pt === "web" || pt === "desktop") return true;
  // Sınıflanmamışsa spec/intent UI sinyaline düş (fail-safe: yalnız pozitif sinyalde koş).
  if (pt === undefined || pt === "unknown") return hasUiSpecSignal;
  return false;
}

/**
 * SAF: gerçek-app doğrulama kapısı koşmalı mı? Öncelik: en spesifik "koşma" nedeni önce.
 * KRİTİK karar: değişen dosyanın route/page olması ARANMAZ — yalnız isRuntimeProdFile yeterli. Canlı vaka
 * (`buildCustomerSearchQuery` = backend .ts) UI-gözlenen ama frontend dosyası değil; route/page şartı bug'ı kaçırırdı.
 */
export function realAppGateDecision(s: RealAppGateSignals): RealAppGateDecision {
  if (!s.isFixIteration) {
    return { run: false, reason: "fix iterasyonu değil (greenfield/yeni-özellik) — kapı yalnız fix'lerde" };
  }
  if (!s.playwrightEnabled) {
    return { run: false, reason: "Playwright kapalı (Settings) — mevcut toggle korunur, downgrade yok" };
  }
  if (!isBrowserDriveable(s.projectType, s.hasUiSpecSignal)) {
    return { run: false, reason: `proje tipi tarayıcıdan sürülemez (${s.projectType ?? "unknown"}) — verify-feature web-odaklı` };
  }
  // changedFiles null = tespit edilemedi (non-git / checkpoint yok) → FAIL-OPEN: doğrulanamayan değişikliği
  // "çözüldü" saymaktansa güvenli taraf, koş (fix + web zaten sağlandı).
  if (s.changedFiles === null) {
    return { run: true, reason: "değişen dosyalar tespit edilemedi (non-git) — fail-open, gerçek-app doğrula" };
  }
  // MAHKEME BULGU 1 (3 müfettiş birleşti — CRITICAL): getChangedFiles git-komutu BAŞARISIZ olduğunda da []
  // döner (kendi sözleşmesi: "küme güvenilmez → boş dön, caller kuşkuda-full yapsın"). Boş dizi "gerçekten
  // değişiklik yok" İLE "tespit güvenilmez"i AYIRT EDEMEZ → ikisi de FAIL-OPEN KOŞ (sessizce atlamaktansa
  // doğrula; fix'in hiç dosya değiştirmemesi zaten anomali). Eski "boş → koşma" sessiz false-green üretiyordu.
  if (s.changedFiles.length === 0) {
    return { run: true, reason: "değişen dosya kümesi boş/güvenilmez (git-hatası olabilir) — fail-open, gerçek-app doğrula" };
  }
  // MAHKEME BULGU 4: yalnız test/config/doküman değiştiyse çalışma-zamanı/UI davranışı etkilenmez → atla.
  // Çalışma-zamanı kaynağı VEYA UI-görsel varlık (.css/.html/.svg…) değiştiyse KOŞ (salt-CSS görsel bug dahil).
  if (!s.changedFiles.some((f) => isUiOrRuntimeObservable(f))) {
    return { run: false, reason: "yalnız test/config/doküman değişti — çalışma-zamanı/UI davranışı etkilenmez, E2E anlamsız" };
  }
  return { run: true, reason: "fix + web + çalışma-zamanı/UI dosyası değişti — gerçek-app doğrulanmalı" };
}

export interface RealAppMarkerInputs {
  /** Bu fix error-analysis akışından mı (bir gate-fail'i düzeltmek için) — öyleyse marker KURULMAZ. */
  fromErrorAnalysis: boolean;
  /** Kullanıcının orijinal şikayeti (repro hedefi); yoksa rootCauseTr'ye düşer (eski state.json). */
  bugReportTr?: string;
  rootCauseTr: string;
  /** Zaten-İngilizce repro hedefi (tam-develop sentezinde intent_summary) — verilirse runRealAppBugGate çeviriyi ATLAR. */
  bugIntentEn?: string;
  fixLabel: string;
  checkpointRef?: string;
  iteration: number;
}
export interface RealAppMarkerFields {
  pending_realapp_verify?: {
    bug_intent_tr: string;
    bug_intent_en?: string;
    root_cause_tr: string;
    fix_label: string;
    checkpoint_ref?: string;
    created_iter: number;
  };
}

/** SAF: tam-develop iterasyonu sonunda gerçek-app kapısı SENTEZLENMELİ mi (Faz 0 marker'ı yokken). Trigger:
 *  UI-sürülebilir proje + Faz 6 insan-incelemesi YAPILMADI (skip) + doğrulanacak niyet var + Playwright açık.
 *  Neden: bug'lar hep tam-develop'a (Faz 1-17) yönleniyor (Faz 0 debug değil — canlı kanıt), Faz 6 foreign/never-ask'ta
 *  atlanıyor, Faz 16 placeholder → UI hiç uçtan-uca doğrulanmadan "done" oluyor (cave /wellcome sahte-yeşili). */
export interface FullDevelopGateSignals {
  hasPhase0Marker: boolean;
  projectType: ProjectType | undefined;
  /** Proje GERÇEKTEN UI dosyaları içeriyor mu (views/*.ejs, .tsx…). project_type=unknown iken sürülebilirlik
   *  sinyali BU — spec-regex DEĞİL (MAHKEME MEDIUM: yanlış-sınıflı backend spec'te "html/dom" geçince regex
   *  yanlış-pozitif verip sentezleyip bloklayabiliyordu; gerçek UI-dosyası kontrolü belirsizliği keser). */
  hasUiFiles: boolean;
  /** Faz 6 (UI incelemesi) bu iterasyonda İNSAN tarafından incelendi mi (yoksa foreign/never-ask ile atlandı mı). */
  phase6HumanReviewed: boolean;
  /** state.intent_summary var mı (doğrulama hedefi). */
  hasIntent: boolean;
  playwrightEnabled: boolean;
}
/** Sentez sürülebilirliği: web/desktop KESİN; unknown → GERÇEK UI-dosyası var mı (regex değil); diğer → hayır. */
function isSynthDriveable(pt: ProjectType | undefined, hasUiFiles: boolean): boolean {
  if (pt === "web" || pt === "desktop") return true;
  if (pt === undefined || pt === "unknown") return hasUiFiles;
  return false;
}
export function decideFullDevelopGate(s: FullDevelopGateSignals): RealAppGateDecision {
  if (s.hasPhase0Marker) return { run: false, reason: "Faz 0 marker'ı zaten var — sentez gereksiz" };
  if (!s.playwrightEnabled) return { run: false, reason: "Playwright kapalı" };
  if (!isSynthDriveable(s.projectType, s.hasUiFiles)) {
    return { run: false, reason: `sürülebilir UI değil (tip=${s.projectType ?? "unknown"}, ui-dosya=${s.hasUiFiles})` };
  }
  if (s.phase6HumanReviewed) return { run: false, reason: "Faz 6'da insan UI'yi inceledi — ayrıca gerçek-app kapısı gereksiz" };
  if (!s.hasIntent) return { run: false, reason: "doğrulanacak niyet (intent_summary) yok" };
  return { run: true, reason: "tam-develop + gerçek UI + Faz 6 insan-incelemesi yok → gerçek-app doğrulaması sentezle" };
}

/**
 * SAF (mahkeme v2 MEDIUM — regresyon-guard): fix-routing state literal'ine spread edilecek gerçek-app marker
 * alanı. Error-analysis gate-fix → BOŞ ({}) döner (marker KURULMAZ; sentetik "Phase N failed" repro hedefi
 * anlamsız + gate zaten yeniden koşar; nested durumda orijinal kullanıcı-bug marker'ı EZİLMEZ). Aksi →
 * kullanıcı-şikayeti hedefli marker (bug_report_tr yoksa rootCauseTr fallback). Bu davranış artık ÖRTÜK spread
 * sırasına değil, test edilen bu SAF fonksiyona bağlı — biri dalı "temizlik"le bozarsa test kırılır.
 */
export function buildRealAppVerifyMarker(i: RealAppMarkerInputs): RealAppMarkerFields {
  if (i.fromErrorAnalysis) return {};
  return {
    pending_realapp_verify: {
      bug_intent_tr: i.bugReportTr ?? i.rootCauseTr,
      ...(i.bugIntentEn ? { bug_intent_en: i.bugIntentEn } : {}),
      root_cause_tr: i.rootCauseTr,
      fix_label: i.fixLabel,
      checkpoint_ref: i.checkpointRef,
      created_iter: i.iteration,
    },
  };
}
