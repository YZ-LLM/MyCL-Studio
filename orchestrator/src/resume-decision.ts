// resume-decision — kesinti sonrası "baştan mı, kaldığı yerden mi?" kararı (SAF, test edilebilir).
//
// KÖK NEDEN (canlı cave kanıtı 2026-07-30): sağlayıcı kesintisinde pipeline duruyor, ama orphan
// uzlaştırması (reconcileAndDrainTasks) iterasyon durumunu KOŞULSUZ sıfırlıyordu
// (current_phase:1, intent_summary/spec_approved/needed_phases silinir). Erişim dönünce iş Faz 1'den
// yeniden başlıyor: niyet, brifing ve spec baştan üretiliyor. cave'de bu 23 kez oldu; Faz 1-4 toplam
// maliyetin ~%35'ini yedi ve hiçbir iş ilerlemedi.
//
// Ayrım net: TERMİNAL HATA (iş gerçekten çuvalladı) → durumu temizle, sonraki iş sıfırdan başlasın
// (bayat niyet/spec sonraki işe SIZMASIN — bu davranış 2026-07-03 mahkemesinde bilerek konuldu).
// KESİNTİ (sağlayıcı kapalı, bekliyoruz) → hiçbir şey çuvallamadı, yalnız duraklandı → durumu KORU.

import type { AgentAction } from "./orchestrator-agent/decision.js";

/** Kesintide durum korunmalı mı? preserve=true ise çağıran state'i SIFIRLAMAZ ve resume bilgisini yazar. */
export function shouldPreserveIterationState(p: {
  /** llm-outage bekleme aktif mi (sağlayıcıya erişim yok, otomatik devam kurulu). */
  outageWaiting: boolean;
  /**
   * Kullanıcı BİLEREK başka bir faza yönlendirdi mi (sidebar'dan faz çalıştırma / açık talimat)?
   *
   * CANLI KANIT (cüzdan koşusu, 2026-09-17): Faz 7 koşarken Faz 5 istendi. Bu bir yönlendirmedir,
   * terminal hata DEĞİL — ama akış onu terminal hata sayıp iterasyon durumunu sıfırladı
   * (current_phase=1, intent_summary=undefined, spec_approved=false, iteration_started_at=undefined)
   * ve deneme sayacını tavana çıkardı. Sıfırlama artefaktı silmedi; artefakta giden TEK İŞARETÇİYİ
   * (iteration_started_at) sildi — o işaretçiyi Faz 5/8/9, düşman testi ve davranış onayı kapısı
   * birlikte okuduğu için beşi aynı anda körleşti. Hepsi tek satır uyarı bile çıkmadan oldu.
   */
  userRedirect?: boolean;
  /** İşin kesildiği faz. */
  currentPhase: number;
  /** Niyet üretilmiş mi (yoksa korunacak anlamlı ilerleme yok). */
  hasIntent: boolean;
  /** İterasyon başlangıç damgası — resume'da eşleşme anahtarı. */
  iterationStartedAt?: number;
}): { preserve: boolean; resumePhase?: number; resumeIterTs?: number; why: string } {
  // Kullanıcı yönlendirmesi ÜÇÜNCÜ durumdur: ne terminal hata ne sağlayıcı kesintisi. Kullanıcı
  // nereye gideceğini zaten söyledi; durumu silmek onun verdiği hedefi de siler.
  if (p.userRedirect) {
    return {
      preserve: true,
      resumePhase: p.currentPhase,
      ...(p.iterationStartedAt !== undefined ? { resumeIterTs: p.iterationStartedAt } : {}),
      why: "kullanıcı yönlendirmesi — terminal hata değil, iterasyon durumu korunuyor",
    };
  }
  if (!p.outageWaiting) {
    return { preserve: false, why: "kesinti yok — terminal hata: bayat durum sonraki işe sızmasın" };
  }
  if (!p.hasIntent || p.currentPhase <= 1) {
    return { preserve: false, why: "korunacak ilerleme yok (niyet üretilmemiş ya da Faz 1)" };
  }
  if (!p.iterationStartedAt) {
    return { preserve: false, why: "iterasyon damgası yok — resume doğrulanamaz, baştan güvenli" };
  }
  return {
    preserve: true,
    resumePhase: p.currentPhase,
    resumeIterTs: p.iterationStartedAt,
    why: `sağlayıcı kesintisi — Faz ${p.currentPhase} ilerlemesi korunuyor`,
  };
}

/** Bir kuyruk işi nasıl başlatılmalı. */
export type IterationStart =
  /** Bugünkü varsayılan: Faz 1'den yeni iterasyon. */
  | { kind: "fresh" }
  /** Güvenlik/pentest sistem işi: niyet bulgudan türetildiği için Faz 3'ten (mevcut davranış). */
  | { kind: "seeded"; startPhase: number }
  /** Kesintiden dönüş: kaldığı fazdan devam (niyet/spec korunmuş). */
  | { kind: "resume"; startPhase: number; note?: string };

/**
 * SAF: iş hangi modda başlatılmalı?
 *
 * resume YALNIZ çift anahtar tutarsa: (1) işte resume_phase var, (2) resume_iter_ts state'in AKTİF
 * iterasyon damgasıyla birebir aynı, (3) niyet hâlâ duruyor. Aksi halde bayat resume bilgisiyle yanlış
 * fazdan başlamaktansa baştan başlanır — ve bu GÖRÜNÜR not olarak söylenir (sessiz fallback yok).
 */
export function decideIterationStart(p: {
  task: { source?: string; from_phase?: number; resume_phase?: number; resume_iter_ts?: number };
  stateIterationStartedAt?: number;
  stateHasIntent: boolean;
}): IterationStart {
  const t = p.task;
  if (t.resume_phase !== undefined && t.resume_phase > 1) {
    const tsMatch = t.resume_iter_ts !== undefined && t.resume_iter_ts === p.stateIterationStartedAt;
    if (tsMatch && p.stateHasIntent) return { kind: "resume", startPhase: t.resume_phase };
    return {
      kind: "fresh",
      // Not: çağıran bunu kullanıcıya söyler — "kaldığı yerden sürdürülemedi" sessiz kalmasın.
    };
  }
  // MEVCUT DAVRANIŞ (değişmedi): güvenlik sistem işi bulgudan türetilen niyetle Faz 3'ten başlar.
  if (t.source === "security" && t.from_phase !== undefined && t.from_phase > 1) {
    return { kind: "seeded", startPhase: t.from_phase };
  }
  return { kind: "fresh" };
}

/** SAF: resume denendi ama tutmadı mı (kullanıcıya görünür not gerekir)? */
export function resumeWasStale(p: {
  task: { resume_phase?: number; resume_iter_ts?: number };
  stateIterationStartedAt?: number;
  stateHasIntent: boolean;
}): boolean {
  if (p.task.resume_phase === undefined || p.task.resume_phase <= 1) return false;
  const tsMatch =
    p.task.resume_iter_ts !== undefined && p.task.resume_iter_ts === p.stateIterationStartedAt;
  return !(tsMatch && p.stateHasIntent);
}

/**
 * SAF: "kaldığın yerden devam et" hangi noktadan başlamalı?
 *
 * `advanceToNextPhase(prev)` semantiği "prev fazından SONRAKİNE geç"tir. Faz 1 için prev=0 olur, ama
 * PHASE_TRANSITIONS[0] = null (Faz 0 pipeline dışı, tek başına çalışan hata ayıklama fazı) → döngü
 * HİÇBİR faz koşturmadan doğrudan pipeline sonuna düşer.
 *
 * CANLI KANIT (cüzdan koşusu, 2026-09-15): kullanıcı devam dedi; log aynı saniyede hem "Akış Faz
 * 1'ten devam ediyor" hem `pipeline_end` yazdı. Faz 2-17 hiç çalışmadı, üstelik özet "tamamlandı"
 * göründü. Aynı hata 2026-05-25'te `run_phase` yolunda düzeltilmiş, bu yolda düzeltilmemişti —
 * kararı saf bir fonksiyona taşımak iki yolun bir daha ayrışmasını engeller.
 */
export type ResumeEntry = { kind: "phase1" } | { kind: "advance"; from: number };

export function resumeEntryPoint(currentPhase: number): ResumeEntry {
  // Faz 1 (ve savunma olarak 1'in altı) advanceToNextPhase ile ifade EDİLEMEZ → Faz 1 doğrudan başlar.
  if (currentPhase <= 1) return { kind: "phase1" };
  return { kind: "advance", from: currentPhase - 1 };
}

/**
 * SAF (2026-11-28, ekransız deneme koşusu 32): bir faz düştüğünde kurulu kullanıcı durdurması bu düşüşe mi ait?
 *
 * KANIT: Faz 9 çalışırken orkestratör `run_phase` (Faz 9) verdi → durdurma bayrağı ve "Faz 9'dan devam" kuruldu. Faz 9
 * durmadı, normal bitti; bayraklar yalnız `failPhase` içinde tüketildiği için kurulu kaldı. 11 dakika sonra Faz 10'un
 * regresyon düşüşü "sen yönlendirdin" sayıldı ve akış Faz 9'a döndü (kullanıcı bir şey yazmamıştı).
 *
 * KURAL: durdurma, durdurulan fazın (`abortedPhase`) kendi düşüşüne aittir. Başka fazın düşüşü → "stale" (bayraklar
 * atılır, düşüş normal işlenir). Durdurulan faz bilinmiyorsa (`null`, ör. faz denetleyicisi dışı bir iş) → eski davranış.
 */
export function decideUserAbortOnFail(p: {
  flag: boolean;
  abortedPhase: number | null;
  failedPhase: number;
}): "none" | "redirect" | "stale" {
  if (!p.flag) return "none";
  if (p.abortedPhase === null || p.abortedPhase === p.failedPhase) return "redirect";
  return "stale";
}

/** SAF: biten faz, kurulu durdurmanın hedefi mi? Evet → durdurma tutmadı (faz normal bitti), bayraklar atılmalı. */
export function userAbortOutlivedPhase(p: { flag: boolean; abortedPhase: number | null; completedPhase: number }): boolean {
  return p.flag && p.abortedPhase !== null && p.abortedPhase === p.completedPhase;
}

/**
 * SAF (2026-11-28, ekransız deneme koşusu 33): Faz 0 düzeltmesinin hangi yoldan uygulanacağı.
 *
 * KURAL: düşen faz Faz 5 ise (error-analysis akışı) `backend-only` etiketi rötuş kipine (`ui-only`) çevrilir.
 * `backend-only` Faz 8'den başlar; Faz 5'in kapısı (CSP taraması, bağımlılık kurulumu, uygulamanın açılması) ve Faz 6
 * incelemesi hiç yeniden koşmazdı. Rötuş kipi Faz 5'i koşar ve paket bildirimi (ör. `package.json`) Faz 5'in kapsamındadır.
 * Öteki etiketler ve öteki fazlar değişmez (`full-stack` zaten Faz 1'den başlar).
 */
export function fixRouteKind<K extends string>(planned: K, fromFailedPhase: number | undefined): K | "ui-only" {
  if (fromFailedPhase === 5 && planned === "backend-only") return "ui-only";
  return planned;
}

/**
 * SAF (2026-11-28, ekransız deneme koşusu 35): yeni istek, parkta bekleyen işin arkasında kuyruğa eklendiğinde ileti.
 * KANIT: kullanıcı "Uygulama açılmıyor … Düzelt." yazdı; ileti yalnız "çalışan iş bitince" dedi. Çalışan iş kullanıcının
 * arayüz onayını bekliyordu; kullanıcı ne yapacağını bilmedi ve hiçbir şey olmadı. İleti neyin beklendiğini ve akışı
 * hangi cevabın sürdüreceğini söyler. Kuyruk sırası değişmez.
 */
export function queuedBehindParkedMessage(count: number, waiting: "ui-review" | "question" | null): string {
  const head = `📥 ${count} iş kuyruğa eklendi (öncelikle) — çalışan iş bitince sırayla, her biri Faz 1'den işlenecek.`;
  if (waiting === "ui-review") {
    return (
      `${head} Çalışan iş Faz 6 arayüz incelemesinde **senin onayını bekliyor**: uygulamayı inceleyip \`tamam\` ` +
      `yazarsan akış sürer ve sıra yeni işe gelir; değişiklik istiyorsan onu yaz, işi durdurmak için \`iptal\` yaz.`
    );
  }
  if (waiting === "question") {
    return `${head} Çalışan iş açık bir soruya **senin cevabını bekliyor**: sorudaki seçeneklerden birini seçersen akış sürer.`;
  }
  return head;
}

// ---------------------------------------------------------------------------------------------------------------
// TEK AKIŞ KURALI (2026-11-28, prompt 26; koşu 31 ve 38). Açılıştaki kendiliğinden sürdürme kullanıcı iletisi
// kilidinin DIŞINDA koşuyor. O sırada gelen "devam et" `resume_pipeline` kararıyla İKİNCİ bir boru hattı
// başlatıyordu; iki akış aynı projede aynı anda kod yazdı (koşu 31'de arka uç iki kez: `.js` ve `.ts`).

/** Bir kullanıcı kararının çalışan bir akışla ilişkisi. */
export type DecisionFlowKind =
  /** Akış başlatır ya da sürdürür (faz koşturur, kod yazar, bağımlılık değiştirir) → akış sürerken REDDEDİLİR. */
  | "starts-flow"
  /** Faz yönlendirmesi: çalışan denetleyici varsa onu durdurup oradan sürdürür (prompt 22) — kendi dalı karar verir. */
  | "redirect"
  /** Yeni iş: başlatılmaz, kuyruğa eklenir — kendi dalı karar verir. */
  | "queue"
  /** Akışa dokunmaz (sohbet, soru cevabı, hafıza, iptal onayı sorusu…). */
  | "safe";

/**
 * SAF: karar türünü sınıfla. Switch EKSİKSİZ (`never`): yeni bir karar türü eklenince derleme burada kırılır →
 * tek akış kuralını sessizce atlayamaz (önden çöz).
 */
export function decisionFlowKind(action: AgentAction): DecisionFlowKind {
  switch (action) {
    case "approve_ui":
    case "revise_ui":
    case "resume_pipeline":
    case "debug_triage":
    case "verify_feature":
      return "starts-flow";
    case "run_phase":
      return "redirect";
    case "develop_new_or_iter":
      return "queue";
    case "chat":
    case "ask_clarify":
    case "cancel_pipeline":
    case "save_memory_proposal":
    case "set_optional_phases":
    case "answer_askq":
    // Bakım turu yalnız onay sorusu açar; başlatma anında kendi denetimi var (handleAskqAnswer bakım dalı).
    case "run_maintenance":
    // Uygulamayı çalıştırma iş kuyruğundan (command_direct) geçer; kuyruk akış sürerken bekletir.
    case "run_project":
    case "fallback_to_classifier":
      return "safe";
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

/** SAF: ikinci akış reddedilince kullanıcıya yazılacak ileti (hangi fazın sürdüğünü söyler). */
export function flowAlreadyRunningMessage(phase: number | null | undefined, droppedRequest?: string): string {
  const where = typeof phase === "number" ? `Faz ${phase}` : "Akış";
  const base =
    `▶️ ${where} zaten sürüyor — ikinci bir akış başlatmadım (iki akış aynı projede aynı anda kod yazardı). ` +
    "Bitince akış kendiliğinden sürecek; başka bir faza geçmek istersen o fazı yaz.";
  // Sessiz düşüş yok (KATI #4): bekletilmeyen istek adıyla söylenir.
  if (!droppedRequest?.trim()) return base;
  const t = droppedRequest.trim();
  return `${base} Bu isteğini bekletmedim: "${t.slice(0, 80)}${t.length > 80 ? "…" : ""}" — akış bitince yeniden yazarsan işlerim.`;
}

/**
 * SAF: bu giriş, sürmekte olan akışın DIŞINDAN mı geliyor (ikinci akış olur mu)?
 * - Hiçbir şey sürmüyorsa (sayaç 0, denetleyici boş) → hayır, yeni akış serbest.
 * - Çağıranın taşıdığı akış işareti sürenin işaretiyse → akışın KENDİ iç içe çağrısı (failPhase → advance…) → hayır.
 * - Aksi hâlde → evet. Eski bir akıştan kalan işaret (o akışın zamanlayıcısı) sürenin işareti olmadığı için evet sayılır.
 */
export function isForeignFlowEntry(p: {
  depth: number;
  controllerBusy: boolean;
  store: symbol | undefined;
  active: symbol | null;
}): boolean {
  if (p.depth === 0 && !p.controllerBusy) return false;
  return !(p.store !== undefined && p.store === p.active);
}

