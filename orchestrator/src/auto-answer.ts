// auto-answer — "Oto-cevap" toggle (saha 3/5). Kullanıcı composer'daki "Orkestrator"
// butonunun yanındaki checkbox'ı tikleyince pipeline kendiliğinden akar:
//   • ÖNERİLİ netleştirme askq'ları → ana ajanın suggested_answer'ıyla,
//   • önerisi-OLMAYAN netleştirme + ONAYLAR (Approve/Revise/Cancel) → ilk/güvenli seçenekle
// otomatik yanıtlanır (f4941dc, YZLLM 2026-06-15: "oto-cevap onayları da yanıtlar").
// AYRIK: Faz 6 görsel-incelemesi bu yoldan GEÇMEZ (deferred) → kullanıcı sürer.
//
// Modül-singleton (setSandboxPolicy deseni); frontend checkbox `set_auto_answer` komutuyla set
// eder. qa-askq backend'leri (CLI + SDK) emitAndAwait/askq noktasında bunu okur.
// YZLLM 2026-06-20: DEFAULT AÇIK isteniyor → FRONTEND default'u açık (App.tsx localStorage !== "0") +
// mount'ta set_auto_answer{true} ile burayı sync eder. Backend default'u FALSE kalır (headless/test
// izolasyonu: frontend sync'i olmayan birim-testler manuel-onay akışını bozmadan koşar).
//
// KATEGORİ-FARKINDA (YZLLM 2026-07-08, "entegre modda güvenli oto-cevap"): entegre (foreign) projede oto-cevap
// eskiden TAMAMEN bastırılıyordu (_integrateSuppressed). Artık kategori-bazlı: yalnız GÜVENLİ-AKIŞ kararları
// (onay/toplayıcı/faz-kapsam/kavrama) foreign'de oto-cevaplanır; KOD-DEĞİŞTİREN ve KULLANICI-TERCİHİ kararlar
// foreign'de kullanıcıya kalır (bugünkü güvenlik korunur — regresyon yok). Non-foreign davranış BYTE-AYNI.
//
// HİÇBİR ŞEY SORMA modu (YZLLM 2026-07-09, "herşeye o karar versin; zor şeylerde mahkemeye soruyor zaten"): _neverAsk
// ÜST-SEVİYE (superset) bayrak — açıkken decideAutoAnswer HER kategoriyi oto-cevaplar (foreign dahil), _enabled/
// _integrateSuppressed'ı AŞAR. KULLANICI KARARI (2026-07-09 AskUserQuestion): foreign'de var olan kodu DEĞİŞTİREN fix'ler
// "GÖSTER + otomatik uygula" — KÖR değil: kod-değiştiren yollar (gate-autofix / failPhase / debug / risk / Faz 13)
// uygulamadan önce dokunulan davranışı/niyeti GÖSTERİR (emitForeignAutoFixNotice / emitSecurityFixImpact / foreign-write-
// consent göster-katmanı). GÜVENLİK TABANI (mod açıkken bile): bash-guard denylist; cancel_pipeline (yıkıcı iş-iptali);
// forceUserPrompt (düşük-güven/sentezlenmiş onay); mahkeme salt-okunur. Mod "sormadan ama GÖSTEREREK" (LOUD, sessiz değil).
// Varsayılan KAPALI → mod kapalıyken bu dosyanın kararı BYTE-AYNI (neverAsk=false ilk satırı atlanır).

let _enabled = false;
// YZLLM (cave5): ENTEGRE (foreign-origin) projede oto-cevap bastırma bayrağı. handleOpenProject origin'e göre set eder.
// Artık tam-blok DEĞİL: decideAutoAnswer'da kategoriyle birlikte değerlendirilir (yalnız güvenli-akış foreign'de geçer).
let _integrateSuppressed = false;
// HİÇBİR ŞEY SORMA (tam otonom) — kullanıcıya sıfır soru; frontend `set_never_ask` ile set eder. Superset: açıkken
// oto-cevap zorla-açık sayılır (isAutoAnswerEnabled/autoAnswerSuggested). Güvenlik tabanı AYRI katmanlarda korunur.
let _neverAsk = false;

/**
 * Oto-cevap karar kategorisi:
 *   safe-flow       = sadece akışı ilerletir/toplar (onay, ack, faz-kapsam, kavrama) — foreign'de OTO-CEVAPLANABİLİR.
 *   dangerous-write = yabancı kodu/davranışı değiştiren aksiyon tetikler (gate-autofix, risk, debug, codegen) — foreign'de KULLANICIDA.
 *   user-preference = kullanıcının kendi tercihi (mock mu gerçek-DB mi gibi) — foreign'de KULLANICIDA.
 */
export type AutoAnswerCategory = "safe-flow" | "dangerous-write" | "user-preference";

/**
 * SAF karar: bu askq oto-cevaplanmalı mı? PARİTE DEĞİŞMEZİ: `if (!suppressed) return true` category'den ÖNCE → non-foreign
 * davranışı eski `_enabled` ile BYTE-AYNI (category ne olursa olsun). Foreign'de yalnız safe-flow geçer; safe-flow
 * clarify'da ek koşul "ajan öneri koydu" (hasSuggestion) — "sadece emin olduğu konularda" (YZLLM). Test edilebilir.
 */
export function decideAutoAnswer(
  category: AutoAnswerCategory,
  s: { enabled: boolean; suppressed: boolean; isApproval?: boolean; hasSuggestion?: boolean; neverAsk?: boolean },
): boolean {
  // HİÇBİR ŞEY SORMA: her kategori oto — foreign dahil (YZLLM 2026-07-09 kararı: "foreign'de GÖSTER + otomatik uygula").
  // KÖR-oto DEĞİL: bu yalnız "oto-cevapla" kararıdır; foreign'de VAR OLAN kodu değiştiren yollar (gate-autofix / failPhase /
  // debug / risk / Faz 13) uygulamadan önce dokunacağı davranışı GÖSTERİR (emitSecurityFixImpact / foreign-write-consent
  // göster-katmanı / entegre-mod oto-fix notu) → "sormadan ama göstererek". Güvenlik tabanı AYRI: bash-guard denylist,
  // cancel_pipeline (yıkıcı) ve forceUserPrompt (düşük-güven) korunur. Non-foreign parite (never-ask öncesi = _enabled).
  if (s.neverAsk) return true;
  if (!s.enabled) return false; // ⬇ neverAsk=false → mevcut mantık BİREBİR (mod kapalı = byte-aynı; parite değişmezi)
  if (!s.suppressed) return true; // NON-FOREIGN: kategori'ye bakmadan eski davranış (parite)
  if (category !== "safe-flow") return false; // FOREIGN: dangerous + user-preference → kullanıcıda
  if (s.isApproval) return true; // foreign güvenli onay/ack → oto
  return s.hasSuggestion === true; // foreign güvenli clarify → yalnız ajan öneri koyduysa
}

/**
 * SAF: qa-askq (Faz 1/2/9) askq'sını kategoriye çevir. Faz 1/2 NETLEŞTİRME (onay değil) = kullanıcı-tercihi
 * (mock mu gerçek-DB mi → mevcut isUserPreferenceClarify niyeti); Faz 9 risk = kod-değiştiren (dispatchRiskFixes);
 * diğer (onaylar + diğer faz clarify) = güvenli-akış. Test edilebilir.
 */
export function classifyQaAskq(tag: string, isApproval: boolean): AutoAnswerCategory {
  if (!isApproval && (tag === "phase-1" || tag === "phase-2")) return "user-preference";
  if (tag === "phase-9") return "dangerous-write";
  return "safe-flow";
}

export function setAutoAnswerSuggested(on: boolean): void {
  _enabled = on;
}

/** Entegre-projede oto-cevap bastırma bayrağını set et (origin==="foreign"). */
export function setIntegrateModeSuppression(on: boolean): void {
  _integrateSuppressed = on;
}

/** HİÇBİR ŞEY SORMA (tam otonom) modunu set et. Frontend `set_never_ask` komutu çağırır. */
export function setNeverAsk(on: boolean): void {
  _neverAsk = on;
}

/**
 * Hiçbir şey sorma modu açık mı. Tüketiciler (doğrudan-emitAskq kapıları — decideAutoAnswer'ı BYPASS ederler, ayrı okur):
 * behavior-consent-gate (oto-onay+not+GÖSTER), foreign-write-consent (oto-onay+GÖSTER), qa-askq controller/cli-backend
 * (user-preference clarify oto), index.ts inspectClarify (mahkeme ask=true→oto-ilerle + döngü guard), memory-proposal
 * (oto "Projeye özel"), model-upgrade (kalıcı ayara dokunma→bilgi), Faz 6 (oto görsel-inceleme+ilerle),
 * emitForeignAutoFixNotice (foreign kod-değiştiren fix'lerde "yabancı kod değişiyor" GÖSTER). KORUNAN istisnalar (mod
 * açıkken bile sorar/durur): yıkıcı iş-iptali (cancel_pipeline), düşük-güven/sentezlenmiş onay (forceUserPrompt),
 * bash-guard denylist. Foreign kod-değiştirme: kör DEĞİL → GÖSTER + oto (kullanıcı kararı 2026-07-09).
 */
export function isNeverAsk(): boolean {
  return _neverAsk;
}

// (isIntegrateSuppressed KALDIRILDI — mahkeme denetimi 2026-07-11: 0 çağıran, ölü export.)

/**
 * Kullanıcının GLOBAL oto-cevap tercihi (entegre-bastırmadan BAĞIMSIZ). Foreign'de autoAnswerSuggested() bastırma
 * yüzünden false döner; bu ise ham toggle'ı verir. YZLLM 2026-07-09: entegre modda GÜVENLİK düzeltmelerini "ajan eminse
 * otomatik uygula" opt-in'i için — güvenlik-fix kararı (Faz 13) foreign'de bu bayrakla açılır (kategori-bastırmayı aşar).
 */
export function isAutoAnswerEnabled(): boolean {
  return _enabled || _neverAsk; // superset: hiçbir şey sorma açıksa ham toggle da açık sayılır (Faz 13 güvenlik opt-in vb.)
}

/**
 * Oto-cevap AÇIK + bu kategori foreign'de izinli mi? Çağıran kategorisini verir; DEFAULT "dangerous-write" = FAIL-SAFE
 * (etiketlenmemiş çağrı foreign'de OFF, non-foreign'de parite). opts: isApproval (onay/ack), hasSuggestion (öneri var mı).
 */
export function autoAnswerSuggested(
  category: AutoAnswerCategory = "dangerous-write",
  opts?: { isApproval?: boolean; hasSuggestion?: boolean },
): boolean {
  return decideAutoAnswer(category, {
    enabled: _enabled,
    suppressed: _integrateSuppressed,
    isApproval: opts?.isApproval,
    hasSuggestion: opts?.hasSuggestion,
    neverAsk: _neverAsk,
  });
}

/**
 * Oto-cevap AÇIKSA (ve bu kategori foreign'de izinliyse) bu askq için seçilecek TR cevabı döndürür (öneri varsa onu,
 * yoksa ilk seçeneği); değilse null → caller kullanıcı cevabını bekler. Mesaj YAZMAZ (saf). category DEFAULT dangerous.
 */
export function autoAnswerPick(
  options_tr: string[],
  suggested_tr?: string,
  category: AutoAnswerCategory = "dangerous-write",
  opts?: { isApproval?: boolean },
): string | null {
  const allowed = decideAutoAnswer(category, {
    enabled: _enabled,
    suppressed: _integrateSuppressed,
    isApproval: opts?.isApproval,
    hasSuggestion: suggested_tr !== undefined,
    neverAsk: _neverAsk,
  });
  if (!allowed) return null;
  if (suggested_tr === undefined && options_tr.length === 0) return null;
  return suggested_tr ?? options_tr[0]!;
}

// ── HİÇBİR ŞEY SORMA: kapsanmamış askq'leri orkestra ajanı/mahkeme otonom cevaplasın (YZLLM 2026-07-10) ──
// SAF çekirdek (index.ts run-loop'undan ayrı, test edilebilir). never-ask'ta emitAskq'ye ULAŞAN (yani kategori-guard'ıyla
// bypass EDİLMEMİŞ) askq'ler bugün asılı kalıyordu → orkestra ajanı/mahkeme bağlam-farkında cevaplar. Bu helper'lar
// yıkıcı-seçim korumasını + döngü emniyetini SAF tutar.

/**
 * SAF: bu askq id-öneki YIKICI / kullanıcı-tetikli mi → never-ask'ta bile otonom cevaplanMAZ (bilinçli korunur).
 * agent_decision_* = cancel_pipeline (iş/pipeline iptali, geri-alınamaz iş kaybı). dast_confirm_* = 🛡️ Güvenlik Taraması
 * (kullanıcı butonu, makine yükü + yan etki). full_test_confirm_* = 🧪 Full Test, maintenance_confirm_* = 🔧 Bakım Turu
 * (kullanıcı butonları, makine yükü + bakımda bağımlılık yazımı). plan_approve_* = 🗺️ plan onayı (kullanıcının açık
 * şartı: plan HERKESİN onayından değil, ONUN onayından geçer). Otonom ajan bunları seçmemeli.
 */
export function isProtectedAskqId(id: string): boolean {
  return (
    id.startsWith("agent_decision_") ||
    id.startsWith("dast_confirm_") ||
    id.startsWith("full_test_confirm_") ||
    id.startsWith("maintenance_confirm_") ||
    id.startsWith("plan_approve_")
  );
}

/**
 * SAF: bu askq YÜKSEK RİSKLİ / büyük-karar mı → otonom cevaplanır AMA yalnız MAHKEME karar verir (orkestra "hedefi
 * ilerlet" biası TEHLİKELİ; muhafazakâr-default de yanlış olabilir). restart_consent_* = phase-0 GUARDRAIL 1:
 * tüm pipeline'ı yeniden başlatan (full-stack/new-iteration) debug çözümü — iş kaybı riski. Mahkeme kararsızsa
 * otomatik uygulanmaz (kullanıcıya bırakılır). isProtectedAskqId'den farkı: korunmaz (cevaplanır) ama court-first.
 */
export function isCourtFirstAskqId(id: string): boolean {
  return id.startsWith("restart_consent_");
}

/**
 * SAF: bu askq never-ask'ta OTONOM cevaplanabilir mi? KULLANICI-ONLY ise HAYIR — (a) id-öneki korumalı (agent_decision_
 * cancel / dast_confirm_ DAST) VEYA (b) protected bayraklı (forceUserPrompt düşük-güven onay — düz-uuid id, önek taşımaz).
 * Bu koruma TEK KAYNAK: hem otonom-cevap hook'u (onAutonomousAskq) hem prompt-üreten renderActiveAskqSection aynı kararı verir.
 */
export function isAutonomouslyAnswerableAskq(askq: { id: string; protected?: boolean }): boolean {
  return !isProtectedAskqId(askq.id) && !askq.protected;
}

/**
 * SAF: LLM/mahkeme cevabını geçerli seçeneklerden BİRİNE eşle (uydurma yasak) — exact, sonra çift-yön includes; yoksa null.
 * Motorun ürettiği metin bir seçeneğe birebir/kapsayan biçimde uymazsa null → çağıran mahkemeye/varsayılana düşer.
 */
export function matchAnswerToOption(ans: string, options: string[]): string | null {
  const a = ans.trim();
  const exact = options.find((o) => o === a);
  if (exact) return exact;
  return options.find((o) => o.includes(a) || a.includes(o)) ?? null;
}

/**
 * SAF: yıkıcı/vazgeç seçeneklerini ELE — otonom cevap motoru bunları GÖRMESİN (yıkıcı seçim yapısal olarak imkansız).
 * `index.ts`'teki `filter(o !== "Vazgeç")` deseninin genelleştirmesi. Kalan yoksa [] (çağıran "yalnız-yıkıcı → cevaplama").
 */
export function stripDestructiveOptions(options: string[]): string[] {
  // toLocaleLowerCase("tr"): Türkçe İ→i (ASCII regex "İptal"i kaçırmasın; JS i-flag Unicode İ≠I).
  return options.filter((o) => !/vazgeç|iptal|cancel|\bsil\b|discard|reddet|❌\s*hayır/.test(o.toLocaleLowerCase("tr")));
}

/** SAF: hiçbir motor geçerli cevap üretemezse muhafazakâr varsayılan — ilk constructive (yıkıcı-olmayan) seçenek; yoksa null. */
export function pickConservativeDefault(options: string[]): string | null {
  const c = stripDestructiveOptions(options);
  return c.length > 0 ? c[0]! : null;
}

/** SAF: otonom-cevap döngü emniyeti — art arda otonom-cevap sayısı MAX'ı aştı mı (askq→cevap→yeni-askq sonsuz döngüsünü kır). */
export function shouldStopAutoAnswer(chain: number, max: number): boolean {
  return chain >= max;
}
