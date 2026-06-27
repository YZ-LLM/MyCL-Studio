## 2026-06-27

- **feat(UI): kalıcı yönerge konuşması ana chat yerine orkestratör panelinde + iki buton panele taşındı + müfettiş.md ajanlara öğretildi (YZLLM, 3 istek):**
  **(1) Yönerge → orkestratör paneli:** Kullanıcı "yönerge için konuşurken orkestratör paneli cevap versin; o
  konuştuklarımız ana chat'te olmasın." [handleOrchestratorDirective](orchestrator/src/index.ts) artık cevabı
  (benimse/itiraz/parse-error/hata) `emitChatMessage` yerine yeni `emitDirectiveReply` ile gönderir; kullanıcının
  yönergesi de panele yankılanır → konuşma orkestratör panelinde, aktivite log'una zaman sırasıyla karışır
  ([OrchestratorPanel.tsx](src/components/OrchestratorPanel.tsx) `DirectiveRow` + merge; yeni `directive_reply`
  event + `MainState.directiveMessages`). Ana chat artık yönerge artığı taşımaz.
  **(2) İki buton panele taşındı:** "🧠 Orkestratör" loading göstergesi + "📄 Proje Dökümanı" butonu ChatPanel
  composer-altından ([ChatPanel.tsx](src/components/ChatPanel.tsx)) ait olduğu yere — sağdaki Orkestra Ajanı
  panelinin başlığına — taşındı (`agentBusy`/`onDocClick`/`docAvailable` prop'ları ChatPanel'den kaldırıldı).
  **(3) müfettiş.md ajanlara öğretildi:** Kullanıcının iletişim rehberi (müfettiş.md, repo kökü) runtime okunup
  ([communication-guide.ts](orchestrator/src/communication-guide.ts), her seferinde taze) çevirmen (yalnız
  en-to-tr; YALNIZ Türkçe çıktının biçim disiplini için — mekanik çevirmen kimliği korunur, konuşma davranışı
  benimsetilmez) + orkestratör (tam — kullanıcıyla konuşan ajan) prompt'larına enjekte edilir; bundle resources'a
  eklendi. Rehber okunamazsa görünür sistem mesajı + log.error (iş durmaz; güvenlik aracı değil).
  **Çapraz-aile mahkemesi** (Sonnet 4.6, 3 mercek × düşman doğrulama): 5 LOW bulgu — panel sayacı `items.length`,
  başlık `justify-content` ezme, fail-soft görünürlüğü (log.warn→görünür mesaj), kalıcı oturum guide-tazelik notu
  düzeltildi. check yeşil (1564 test).

- **feat(UI): "Ajan Takımı" popup'ı — çoklu-ajan takımlarını canlı görünür kılar (YZLLM):**
  Sağ kenar çubuğuna **👥 Ajan Takımı** butonu + drawer. O iterasyonda koşan TÜM alt-ajan takımlarını gruplar:
  **Tasarım Paneli** (4 perspektif + Sentezleyici + müzakere, Faz 5), **Kök-neden Mercekleri** (Faz 0),
  **Modül Codegen** (Faz 8), **Faz 9 İncelemesi** (bulucular + çürütücüler). Her ajan için: takım, hangi faz, başlama
  saati, **canlı süre** (koşarken saniyede bir ilerler), durum (çalışıyor/bitti/hata) ve **token** (girdi/çıktı/cache).
  Token atfı tek chokepoint'ten ([recordTokenUsage](orchestrator/src/ipc.ts)) yapılır: yeni
  [agent-cost-context.ts](orchestrator/src/agent-cost-context.ts) `AsyncLocalStorage` ile her ajan kendi bağlamında
  koşar (`withAgentRun`), paralel takımlarda token'lar karışmaz; CLI kolu (`runClaudeCli`) içte, API/z.ai kolu
  ([design-fanout.ts](orchestrator/src/design-fanout.ts)) ayrıca `recordTokenUsage` çağırır → hiçbir kolda 0-token
  kalmaz. Her `agent_event`'e monoton `ev_id` eklendi; frontend reducer
  ([App.tsx](src/App.tsx)) aynı olayı (StrictMode/effect re-fire) tekrar işlerse atlar → token çift-sayımı yok.
  Ajan takımları İngilizce çalışır (ana ajan yöneticileri; çevirmen yalnız kullanıcı↔orkestratör). Yeni iterasyonda
  ([phase_changed](src/App.tsx) freshRun) liste sıfırlanır. **Çapraz-aile mahkemesi** (Sonnet 4.6, 3 mercek × düşman
  doğrulama) diff'i denetledi: sarılmamış **Sentezleyici** ajanı (Faz 5 sentezi, popup'ta görünmüyor + 0 token) MEDIUM
  bulgu olarak yakalanıp kapatıldı; negotiate started-emit tutarsızlığı (LOW) düzeltildi. check yeşil (1564 test).

- **fix(orkestratör): tool-turn limiti "karar veremedi" düşüşünü bitirir — tavan yükseltildi + son turda karar ZORLANIR (YZLLM):**
  SDK orkestratör ajanı 8 tool-turn'de karar (decide_action) veremeyince "MAX_TOOL_TURNS (8) aşıldı" ile DÜŞÜYORDU
  (kompleks çok-dosyalı analizde 8 yetmiyor — canlı: parmak-izi/step-up). [agent.ts](orchestrator/src/orchestrator-agent/agent.ts):
  tavan 8→30 (cömert araştırma alanı) + SON TURDA `tool_choice` forced `decide_action` → ajan MUTLAKA karar verir,
  "decide_action eksik" ile ASLA düşmez. Tavan tamamen kaldırılmadı (sonsuz tool-döngüsü/runaway-maliyet emniyeti);
  son-tur-zorlaması onu hata değil "şimdi karar ver" dürtüsüne çevirir. CLI orkestratör etkilenmez (kendi tool-loop'u).
  check yeşil.

- **chore(temizlik): Linear aynası + İkili Soru Bankası özellikleri TAMAMEN kaldırıldı (YZLLM kararı):**
  Kullanıcı kararı: Linear kullanılmayacak; Soru Bankası'nın değeri ölçüldü (son ~30 gerçek bug'ın yalnız ~%13'ü
  deterministik-yakalanabilir + o da mevcut kapılarca zaten kapanıyor → benzersiz değer ≈ 0). İkisi de söküldü:
  **Linear** — `linear-sync.ts` + testi silindi, `index.ts` import+çağrı, `config.ts` `linear_sync_enabled`/`linear_team_id`
  flag'leri, README maddesi. **Soru Bankası** — `orchestrator/src/question-bank/` (13 modül + 10 test) + `assets/question-banks/`
  silindi, `index.ts` tripwire wiring+import, `config.ts` `question_bank_enabled` (interface+DEFAULT), `phase-registry.ts`
  `questionBanksRoot`, `profile-loader.ts` `artifact_globs` (+ node-npm.json verisi), `tauri.conf.json` bundle resource,
  README maddesi. Çekirdek pipeline etkilenmez (ikisi de opt-in/default-kapalıydı). check yeşil (1625 test).

- **fix(UX): "konu" (üzerinde çalışılan iş) sola alındı + üst bardaki kopyası kaldırıldı (YZLLM):**
  Konu iki yerde gösteriliyordu: üst bar ([AppHeader.tsx](src/components/AppHeader.tsx)) + chat toolbar
  ([ChatPanel.tsx](src/components/ChatPanel.tsx), `panel-label` space-between ile SAĞA itiliyordu). Kullanıcı isteği:
  konu SOLA + üstte yazılmasın. Üst bardaki konu kaldırıldı (tek yer); chat toolbar'da konu kopya-butonuyla sol
  grupta (artık solda). check yeşil.

- **fix(UX): chat otomatik aşağı kaydırma YALNIZ oto-cevap açıkken (YZLLM):**
  Yeni içerikte (mesaj/askq/banner-heartbeat) chat panelini otomatik en alta kaydırma artık yalnız **oto-cevap modu
  açıkken** yapılır ([ChatPanel.tsx](src/components/ChatPanel.tsx)). Oto-cevap kapalıyken kullanıcı içeriği okuyup
  karar verir → yeni mesaj ya da 60 sn'lik banner-heartbeat onu aşağı yankılamaz. İlk-açılış scroll'u ve faza
  tıklayınca o mesaja gitme ayrı/korunur. check yeşil.

- **feat(yedek): ~/.mycl/backups proje başına son 3 yedeği tutar + test artık gerçek ~/.mycl'i kirletmez (YZLLM):**
  Oto-düzeltme öncesi kopya-yedekleri ([fix-snapshot.ts](orchestrator/src/fix-snapshot.ts)) sınırsız birikiyordu
  (adminpanel 111, Vestel_BO 25…). Artık her yeni yedekten sonra o projenin EN YENİ 3 yedeği tutulur, eskiler budanır
  (`pruneProjectBackups`, yalnız o projeye dokunur, fail-soft; just-created yedek hep en yeni→korunur). Ayrıca KÖK
  TEMİZLİK: `fix-snapshot.test.ts` `MYCL_HOME`'u izole etmiyordu → her test koşusu gerçek `~/.mycl/backups`'a
  `mycl-snap-*` artifact'ı bırakıyordu (1835 birikmişti); test artık temp home kullanır (gerçek dizin kirlenmez).
  3 birim test (son-3 / yalnız-kendi-projesi / ≤3-no-op). check yeşil.

- **fix(çeviri): çeviri ajanı artık kelime-kelime DEĞİL, ANLAM-odaklı anlaşılır Türkçe üretir (YZLLM):**
  Eski prompt katı verbatim/kelime-kelimeydi → "device step-up layer" → "cihaz adım yukarı katmanı" gibi anlamsız
  çıktı veriyor, "compliance/schema drift/fail-closed" gibi İngilizce jargonu ya çevirmeden bırakıyor ya saçmalıyordu.
  Yeni prompt ([translator.ts](orchestrator/src/translator.ts) `buildSystemPrompt`): anlamı akıcı/doğal Türkçeyle
  aktar (kullanıcı KONUYU anlasın), İngilizce jargonun anlamını kısa kavram olarak Türkçeye çevir (örnekli); yalnız
  gerçek kod-jetonları + yerleşik kısaltmalar (API/JWT/PII/SMTP/OTP/DDL/CSP…) verbatim kalır. Sadakat korunur (yeni
  bilgi/karar EKLEME, içerik düşürme yok); prompt-injection savunması + tire-bileşik kuralı korundu. Çapraz-aile
  mahkeme (Sonnet 4.6): PROCEED — injection savunması eskisinden güçlü; tek bulgu (uzun örnek→şablon-şişme) düzeltildi.

- **fix(UX): 60 sn'lik "çalışıyor" durumu artık CHAT'i şişirmiyor — alttaki banda yazılıyor (YZLLM):**
  Uzun işlerde dakikada bir gelen heartbeat ("⏳ TDD uygulanıyor — 300s sürüyor · son adım…") chat paneline
  birikiyordu (gürültü). Artık alttaki "çalışıyor" bandına ([ipc.ts](orchestrator/src/ipc.ts) heartbeat tick →
  `phase_running` detail) yazılır; band detail'i her 60 sn'de canlı durumla güncellenir, chat temiz kalır. Band
  çok-satır sarar (kalınlaşır, kesilmez — [ChatPanel.tsx](src/components/ChatPanel.tsx)/App.css). check yeşil.

## 2026-06-26

- **fix(orkestra): aynı-ms olaylar Orkestra panelinden DÜŞMÜYOR — req 3 "yaptığı herşeyi göster" tam karşılandı (YZLLM, bütünsel mahkeme):**
  Reducer `agent_event`'i `ts === d.ts` ile eliyordu → aynı milisaniyede gelen DISTINCT iki tool_use'dan biri sessizce
  düşüyordu (req 3 ihlali). Düzeltme: içerik-bazlı yeniden-işleme guard'ı (yalnız GERÇEK tekrarı eler; distinct same-ms
  olayları korur) + her kabul edilen olaya monoton `seq` → benzersiz React key (key çakışması/olay-düşmesi yok). 11-istek
  bütünsel mahkemesi (Sonnet 4.6, 4 eksen + düşman-doğrulama, 14 bulgu) tüm istekleri DOĞRULADI; tek gerçek kusur buydu
  (diğerleri olumlu-doğrulama + opsiyonel ölü-kod). check yeşil.

- **feat(orkestra): panel altına KALICI YÖNERGE composer'ı — orkestratör benimser/itiraz eder + sonraki tüm işlere uyar (YZLLM req 4):**
  Orkestra panelinin altındaki yeni composer "iş" değil, işin NASIL yapılacağına dair KALICI bir ÇAPA verir (örn.
  "projelerde her zaman versiyonlama yapalım"). Orkestratör salt-okunur değerlendirir ([user-directives.ts](orchestrator/src/user-directives.ts)
  `buildDirectiveEvalPrompt`/`parseDirectiveVerdict`): **itirazı varsa söyler** (kaydetmez), **yoksa benimser** →
  `~/.mycl/directives.md`'ye ekler ([index.ts](orchestrator/src/index.ts) `handleOrchestratorDirective`); benimsenen
  yönerge sonraki TÜM orkestratör prompt'larına "## KULLANICI KALICI YÖNERGELERİ" olarak enjekte edilir
  ([context-builder.ts](orchestrator/src/orchestrator-agent/context-builder.ts)) → çapraz-proje uygulanır (CLI+SDK+Auto
  pariteli). Pipeline/faz TETİKLENMEZ (questionMode). İşaretçi parse edilemezse fail-closed (kaydetmez, dürüst söyler).
  **Çok-eksenli mahkeme (Sonnet 4.6, 4 eksen + düşman-doğrulama) 8 bulgu** (2 olumlu-doğrulama + 6 kusur) buldu+düzeltildi:
  faz-banner/askq heartbeat singleton'ını ezme (çalışan fazı sahte-IDLE / askq sessizliğini bozma → `isPhaseIndicatorActive`
  guard), KARAR işaretçisi reason'da olabilir (message+reason birleştir), dedup normalleştirme, sahte "kaydettim" iddiası
  (appendUserDirective→boolean). Saf seam'lere 14 birim test. HÜKÜM: PROCEED.

- **feat(UI): kapsam onaylanınca çalışacak fazlar belirgin, kapsam-dışı opsiyoneller SOLUK (YZLLM req 11):**
  Kapsam onaylanınca ("Kapsam onaylandı: ...") PhaseSidebar artık çalışacağı belli fazları normal/belirgin,
  GERÇEKTEN atlanacak opsiyonelleri SOLUK (opacity 0.4) gösterir ("Diğerleri pasif görünsün"). Backend
  `needed_phases`'i yeni `needed_phases` IPC event'iyle frontend'e yollar ([ipc.ts](orchestrator/src/ipc.ts)
  `emitNeededPhases` + scope değişen 6 nokta + boot); [PhaseSidebar.tsx](src/components/PhaseSidebar.tsx) kapsam-dışı
  opsiyonelleri `.phase-item-inactive` ile soluklaştırır (tıklanabilir kalır). **Çok-eksenli mahkeme (Sonnet 4.6,
  4 eksen paralel + düşman-doğrulama) 7 gerçek kusur buldu+düzeltildi:** en kritik — frontend {5,6,7,8,9}'u opsiyonel
  sayıp Faz 6/8/9'u "çalışmayacak" diye yanlış soluklaştırıyordu; oysa backend `isPhaseSkippedByScope` YALNIZ Faz 5/7
  atlar (6/8/9 her zaman koşar). Düzeltme correct-by-construction: `SKIPPABLE_PHASES={5,7}` tek kaynaktan dimming +
  "(opsiyonel)/(zorunlu)" etiketi + vurguyu türetir (backend otoritesiyle birebir). Ayrıca boot/resume yarışı
  (handleOpenProject kapsamı state populate sonrası emit eder) + gate-failed faz asla soluklaşmaz. HÜKÜM: PROCEED.

- **fix(z.ai): Claude (abonelik+API) tükenince z.ai'ya OTOMATİK geç — "z.ai tükendi" YALANI kökünden düzeltildi (YZLLM canlı bug):**
  Canlı koşuda z.ai bakiyesi $6.29 olmasına rağmen MyCL Faz 1'de "⛔ tüm sağlayıcılar tükendi (Claude kredisi/limiti + z.ai)"
  deyip işi bloke etti — çünkü hata-analizi ([error-analysis.ts](orchestrator/src/error-analysis.ts)) Claude account-error
  görünce z.ai'yi HİÇ DENEMEDEN `failPermanent` çağırıyordu (önceki "z.ai evrensel" işi bu yolu kapsamamıştı). İlke:
  **"z.ai HER ZAMAN, Claude abonelik VE API yoksa kullanılsın."** Düzeltme: (1) error-analysis account-error'da z.ai
  müsaitse (`zaiKeyForRole` var + `!isZai`) `needsProviderSwitch` sinyali döner, değilse DÜRÜST `failPermanent` (z.ai
  zaten seçili+o da tükendi VEYA z.ai anahtarı yok'a göre net mesaj — sabit yalan yok). (2) [index.ts](orchestrator/src/index.ts)
  `trySwitchSessionToZai()` — Claude account-error + z.ai anahtarı var + z.ai'de değiliz → TÜM rolleri (orkestratör/çevirmen/
  main) z.ai'ya geçir (restart'sız) + fazı tekrar koş; zaten z.ai'deysek geçme (sonsuz döngü yok). `failPhase` account-error
  dalı + `analyzeAndAskError` 3 çağrı yeri (ana / OPT_REANALYZE / Faz 13 güvenlik) + `rerunPhaseAfterProviderSwitch`
  (n≥2→advance, n=1→`detectInterruptedPhase1 ?? lastPhase1Intent`). Çapraz-aile mahkeme (Sonnet 4.6) **4 gerçek kusur**
  buldu+düzeltildi: Faz 13 bayat `cfg` (autofix Claude'a gidip yalanı geri getiriyordu) · iter=1 niyet (canlı
  `lastPhase1Intent`) · `emitConfigStatus`-fail sessiz-stall (görünür hata+false) · null-deref (config-restore invariant:
  `runtime.config` asla null kalmaz). HÜKÜM: PROCEED. check yeşil.

- **feat(UI): sağ panel 3 ayrı ajan görünümüne bölündü (Main / Çeviri / Orkestra) + Orkestratör Kararları paneli (YZLLM):**
  Eski tek "Sağ Panel" butonu kaldırıldı; yerine 3 toggle buton geldi ([RightActionBar.tsx](src/components/RightActionBar.tsx)):
  **🤖 Main Ajan** (Claude Code), **🌐 Çeviri Ajanı**, **🧠 Orkestra Ajanı**. Bir butona basınca o panel sağda açılır,
  açıkken basınca kapanır, başka butona basınca o görünüme geçer (aynı anda yalnız biri açık — [App.tsx](src/App.tsx)
  `activeRightPanel` tek-state toggle). Yeni [OrchestratorPanel.tsx](src/components/OrchestratorPanel.tsx) orkestratörün
  TÜM önemli kararlarını (ne yaptı + neden + düşünce) gösterir; veri kaynağı mevcut `agent_event` (sub="decision") akışı,
  ama kararlar tool gürültüsüne yutulmasın diye AYRI bir 300-cap'li store'da birikir ("bütün kararlar gözüksün").
  Karar render'ı `AgentThinkingModal`'ın `EventRow`'uyla paylaşılır (DRY); modal aynen çalışır. Mahkeme (Sonnet 4.6):
  PROCEED-WITH-NOTE → iki not da giderildi (300-cap store + ölü CSS). check yeşil.

- **fix(sağlayıcı): Claude tükenince z.ai EVRENSEL devralır + kredi/yetki hatasında boş döngüler kırılır (YZLLM canlı bug):**
  Canlı koşuda Claude aboneliği limitli + API kredisi bitti ("credit balance too low") → MyCL anlamsız döngüye
  girdi, z.ai fallback'i devreye girmedi. Dört parça: **(1)** z.ai account-error fallback'i artık CLI/Auto yolunda da
  var (önce yalnız SDK [claude-api.ts](orchestrator/src/claude-api.ts) `runTurn`'deydi): [cli-session.ts](orchestrator/src/cli-session.ts)
  `extraEnv` aldı, `resolveCliProvider`'a `accountErrorFallback` opt'u, [production-schema-cli-backend.ts](orchestrator/src/base/production-schema-cli-backend.ts)
  account-error'da z.ai'ye **yapışkan** geçer (oturum sonuna kadar). **(2)** [cli-rate-limit.ts](orchestrator/src/cli-rate-limit.ts)
  `autoFallbackBackend`'e enjekte `isPermanent` (caller `isApiAccountError` geçirir; circular import'tan kaçınmak için
  import değil enjeksiyon) → CLI↔API 6-tur boş döngüsü kredi/yetki hatasında 1'de kırılır; [index.ts](orchestrator/src/index.ts)
  `failPhase` "tüm sağlayıcılar tükendi" mesajı z.ai-farkında + dürüst (artık "abonelik yok" yanlışı yok). **(3)**
  [error-analysis.ts](orchestrator/src/error-analysis.ts) `permanentNoProvider` → sağlayıcı yokken "Tekrar analiz et"
  SUNULMAZ (hep başarısız → sonsuz döngüydü); analiz account-error'da `failPermanent` (yalnız "kaydet+devam"); CLI hata
  metnine `resultErrorText` eklendi (account-error result-event'te gelir — [cli-run.ts](orchestrator/src/cli-run.ts)+cli-session). **(4)**
  orkestratör + analiz promptlarına "z.ai fallback MEVCUT" bilgisi (ajan "z.ai geçiş yok" yanlışını vermesin).
  Müfettiş ETKİLENMEZ (çapraz-aile için hep Claude — doğrulandı). +13 test. Mahkeme (Sonnet 4.6, çapraz aile): PROCEED
  (6 eksen: müfettiş izolasyonu / yapışkan-oturum / döngü-kırma / circular-import / sınıflandırma / Claude-only regresyon). check yeşil.

- **fix(yönlendirme): yeni iş "Faz N'de kaldığı yerden sürüyor" diye yanlış duyurulmaz (YZLLM: "söylediği halde 8'e geçmedi"):**
  Tamamlanmış önceki koşudan kalan `current_phase=8`'i orkestratör ajanı bayat görmeyip yeni özelliği (tema + responsive)
  "TDD aşamasında, kaldığı yerden sürüyor" diye duyurdu — kullanıcı Faz 8 bekledi ama pipeline Faz 1'den başladı (yeni
  özellik için DOĞRU akış, ama mesaj yanıltıcıydı). İki kök: ajan `current_phase` ile `was_pipeline_completed`'i ayrı
  satırlardan bağlamadı. (1) [context-builder.ts](orchestrator/src/orchestrator-agent/context-builder.ts): pipeline
  tamamlandıysa `current_phase` satırının KENDİSİNE "⚠️ BAYAT — yeni istek Faz 1'den başlar" uyarısı gömüldü (ajan
  kaçıramaz). (2) [orchestrator-system.md](assets/agent-prompts/orchestrator-system.md): yeni iş (`develop_new_or_iter`)
  seçilince mesaj eylemle tutarlı olmalı — bayat faza atıf + "resume" dili yasak. +2 test. check yeşil.

- **fix(dil): MyCL mesajları kullanıcıya sade + kısa + jargonsuz (YZLLM: "kapı mapı anlamam; çok uzatıyor"):**
  YZLLM debug akışındaki mesajların jargonlu ("CSP kapısı", "2. derece bağımlı", "deterministik", "ölü yedek")
  ve uzun olmasından şikayet etti. (1) [phase-0.ts](orchestrator/src/phase-0.ts): uzun "Etki alanı" listesi (8 modül
  + yüksek/düşük risk + neden) KULLANICIDAN kaldırıldı — analiz içeride (audit + WTF + codegen payload) kalır,
  kullanıcı yalnız kök neden + öneriyi görür. (2) [phase-00-debug.md](assets/templates/phase-00-debug.md): kök neden +
  seçenek başlığı + açıklama alanları için PLAIN-LANGUAGE kuralı — teknik olmayan kullanıcıya kısa, jargonsuz; çıplak
  terim yasak (gate → "kontrol", CSP → "tarayıcı güvenlik kuralı" gibi açıkla); iç alan `plan_summary` muaf. (3)
  [orchestrator-system.md](assets/agent-prompts/orchestrator-system.md) Dil disiplini: genel sade + kısa + jargonsuz
  kuralı ("şu sorun var, şöyle çözeceğim" kadar). check yeşil. Açık: diğer akışlar (Faz 9 risk, gate-autofix) sırada.

- **feat(z.ai): z.ai'a geçilince orkestratör ve çevirmen de z.ai kullanır (YZLLM):**
  Önceden main z.ai (glm-5.2) iken çevirmen Claude'da (haiku) kalıp fail veriyordu — pipeline tıkanıyordu.
  [config.ts](orchestrator/src/config.ts) `resolveAgentBackends`: main=zai ise, açıkça ayarlanmamış ("auto")
  orchestrator ve translator otomatik z.ai'ya geçer (açık api/cli/zai seçimi DOKUNULMAZ; müfettiş ayrı yolda
  hep Claude kalır — `backendForRole(zai)="api"` onu korur). `zaiKeyForRole`: tek z.ai anahtarı girilince üç rol
  de bulur (herhangi bir alana düşer — z.ai tek hesap). Tek noktada çözülür → `resolveProvider` + `backendForRole`
  + `isAutoMode` tutarlı; model çözümü zaten sağlayıcıya göre (`glmModelFor` cheap GLM verir, 404 yok). +7 test.
  Mahkeme (Sonnet 4.6, çapraz aile): PROCEED — 6 eksen (cascade zinciri / müfettiş korunumu / isAutoMode /
  forced-CLI / non-zai regresyon / key fallback) doğrulandı. check yeşil (1676 test).

- **fix(dil): kullanıcıya yazılan Türkçe'de tire ile uydurma bileşik kullanılmaz (YZLLM: "anlamıyorum, kullanma"):**
  YZLLM uyardı: "önceden-var" gibi iki kelimeyi tire ile birleştirip uydurma bileşik yapma — okunmuyor; MyCL de
  kullanmasın. Görünür mesaj düzeltildi ([phase-8.ts](orchestrator/src/phase-8.ts): "önceden-var kırmızıdan" →
  "zaten önceden başarısız olan testlerden"). MyCL'e öğretildi: [orchestrator-system.md](assets/agent-prompts/orchestrator-system.md)
  Dil disiplini bölümüne kural + [translator.ts](orchestrator/src/translator.ts) EN→TR sistem prompt'una 8. kural
  (Türkçe üretirken tireyle bileşik yapma — bu sadık çeviridir, yeniden ifade değil; bileşik bozuk Türkçe). DOĞRU yazım:
  "önceden var olan", "yaşayan dökümantasyon", "sahte yeşil". Tire yalnız gerçek teknik jetonda (dosya yolu, kod adı,
  CLI bayrağı, model adı). Koddaki kullanıcıya görünen sabit metinlerdeki ~40 örnek de süpürüldü (17 dosya, çok ajanlı
  paralel akışla; her değişiklik elle gözden geçirildi, bir aşırı düzeltme geri alındı — "gate" terimi korundu). check yeşil (1669 test).

- **feat(entegre/recent): "Proje Aç" ile açılan proje son projelerde görünür — okunamayan-proje KOPYAsı dahil:**
  YZLLM ("entegre modunda açtığım proje de son projelere gelsin"): MyCL okunamayan (ev-altı/sandbox) bir projeyi
  ev-DIŞI `/Users/Shared/MyCL Projeler/<isim>-<hash>`'e kopyalayıp KOPYAYI açıyor (`open_project_request`), ama o
  kopya recent'e DÜŞMÜYORDU — Splash'ın `add_recent_project`'ini baypas ediyordu. [App.tsx](src/App.tsx): recent kaydı
  artık TEK NOKTADAN proje-açılış effect'inde (Splash-pick + recent-tıklama + kopya-reopen hepsi `projectPath` set eder),
  `register_window_project`'TEN BAĞIMSIZ kendi try'ında (mahkeme B-6: register fail edince recent sessizce atlanmasın).
  [Splash.tsx](src/components/Splash.tsx) `recentDisplayLabel`: "MyCL Projeler" altındaki kopya yolu dostça gösterilir
  (hash son-eki atılır → "cave5", **"entegre kopyası"** rozeti); gerçek yol reopen + tooltip'te korunur. Kopya re-copy
  EDİLMEZ (mevcut hedef → işin korunur), recent.rs dedupe → çift-girdi yok. Cross-family mahkeme (Sonnet 4.6): PROCEED. check yeşil (1667 test).

- **feat(entegre): Faz 6 (UI İncelemesi) entegre modunda atlanır + bayat-park unpark guard (KATI #9 bilinçli istisnası):**
  YZLLM ("entegre modunda UI incelemesi atlanmalı"): foreign-origin (mevcut) projede gap-işleri UI-yapımı değil,
  dev-server çoğu zaman yok → Faz 6 atlanır. [index.ts](orchestrator/src/index.ts) 3 giriş yolu kapatıldı
  (`advanceToNextPhaseInner` next===6, `runPhaseOnce` phaseId===6, boot-guard); `phase-6-complete` audit'i korunur
  (sonraki gate'ler bekler). Cross-family mahkeme (Sonnet 4.6) gizli-stall buldu: skip eklenmeden ÖNCE Faz 6'ya girmiş
  foreign proje restart'ta `pending_ui_review=true` ile askıda kalıyordu (`hasPendingQueueWork` boot-resume'u atlar,
  queue-drain `isPipelineParked`'ta durur → DONMUŞ HEDEF #1 ihlali) → boot-guard bayat parkı Faz 7'ye geçirir (tek-shot).
  +2 test [skip-ui-phases-flow.test.ts](orchestrator/test/integration/skip-ui-phases-flow.test.ts). check yeşil (1667 test). (commit 6327ed2)

## 2026-06-22

- **fix(kalıcı oturum): geçici API kesintisi artık "oturum kararsız" diye YANLIŞ etiketlenmez (canlı transcript teşhisi):**
  `translator-en-to-tr` "kararsız sayıldı; cold-start'a düşülüyor" uyarısının kök sebebini canlı `session-transcripts.jsonl`'den tespit ettim. İlk hipotez (çöp log girdisi çevirmeni boğuyor) **çürüdü** — repro: çöp log satırı bile haiku tarafından başarıyla çevriliyor (`is_error:false`). Gerçek sebep: **dış API kesintisi** (`Request timed out` / `Unable to connect (ConnectionRefused)`), zaman-kümeli (20 Haz 20:14–20:41 ~27 dk her 60sn'de timeout). Sezgisel bunu oturum kusuru sanıp (1) yanlış "oturum bozuk" mesajı basıyor, (2) 60sn'de bir SPAM'liyor, (3) sıcak oturumu boş yere öldürüp respawn ediyor — oysa cold-start aynı backend'i kullandığından fayda etmiyor. Düzeltme [persistent-cli-session.ts](orchestrator/src/persistent-cli-session.ts): yeni `isTransientOutage` sınıflandırıcısı dış-kesinti↔yapısal-bozulma ayırır → dış kesinti DÜRÜST mesaj alır ("geçici dış kesinti, oturum sorunu değil; API toparlayınca düzelir") + oturum SICAK tutulur (yalnız yapısal bozulmada öldürülür); epizot başına TEK mesaj (spam yok) + recovery'de "toparladı" bildirimi; yapısal hatada eskiden tamamen yutulan `stderr` tail'i mesaja eklenir (kör teşhis biter). +12 birim test ([persistent-session-health.test.ts](orchestrator/test/persistent-session-health.test.ts)). check yeşil (1405 test).

- **feat(z.ai/GLM çoklu-sağlayıcı — TEMEL + Settings UI iskelesi; routing ⑤'de):**
  z.ai (GLM) claude'un yanına tam sağlayıcı olarak ekleniyor (Yol A: Anthropic-uyumlu endpoint, geniş adapter YOK). **Temel** ([config.ts](orchestrator/src/config.ts) `resolveProvider`/`zaiKeyForRole` + `AgentBackend` 4. değer `"zai"`; [model-catalog.ts](orchestrator/src/model-catalog.ts) `GLM_CATALOG`/`glmModelForTier`/provider-aware `findModel`; [claude-api.ts](orchestrator/src/claude-api.ts) GLM-param uyumu: Anthropic-beta header strip, thinking/efor KALIR — Deep Think Anthropic param şeklini yansıtır). **Settings UI** ([Settings.tsx](src/components/Settings.tsx)+[App.tsx](src/App.tsx)+[events.ts](src/types/events.ts)): 3 rol-başına z.ai key alanı (translator/main/orchestrator), rol-başına **Sağlayıcı** combobox'ı (Otomatik/Claude API/Claude Abonelik/Z.AI), model + iş-seviyesi dropdown'larında GLM optgroup'u. **Sağlayıcı combobox'ı GERİ geldi** — 2026-06-20 "sadece auto" kararını YZLLM'in açık isteğiyle tersine çevirir (z.ai 3. sağlayıcı, "auto" onu seçemez). [index.ts](orchestrator/src/index.ts) backend-validasyonu artık `"zai"`yi sessizce ELEMEZ. Default hâlâ all-auto → z.ai seçilmedikçe davranış aynen claude. check yeşil. **KALAN ⑤:** ~25 call-site'ın `resolveProvider`'a bağlanması (seçim henüz ROUTING yapmaz) + multi-agent + CLI-env + canlı /v4/models keşfi + adversarial review. README z.ai fonksiyonel olunca güncellenecek.

- **feat(mahkeme): Faz 13 güvenlik gate'i bağlayıcı mahkemeden geçer (evrensel-yetki boşluğu kapandı):**
  Mahkeme şimdiye dek gate-autofix yolundaydı ama Faz 13 güvenlik KENDİ dalında raw `runGateAutofix` ile mahkemesiz koşuyordu — "yetki fix-kararları üzerinde evrensel" ilkesindeki boşluk (EN yüksek-risk alan denetimsizdi). [index.ts](orchestrator/src/index.ts) Faz 13 oto-fix'ten ÖNCE genel yolun kanıtlı mahkeme desenini uygular: `inspectGateFinding` "Güvenlik" etiketinden `highStakes=true` türetir → `mahkemeRuling` güvenlikte ASLA suppress etmez. **proceed** → oto-fix (müfettiş gerekçesi B5 ile fix'i besler); **escalate** → oto-fix YOK (çalışan kod korunur) + LOUD accept-continue (oto-modda insan BLOKLANMAZ — frozen-goal; bulgu YUTULMAZ rapora yazılır); **suppress** savunmacı→escalate'e çevrilir. Flag-gated (`inspector_enabled`) + fail-safe (kapalı/hata→proceed, davranış aynen korunur). check yeşil (1370 test); `mahkemeRuling` yüksek-risk→escalate kuralı zaten [inspector.test.ts](orchestrator/test/inspector.test.ts)'de test'li.

## 2026-06-21

- **feat(KENDİ-YETERLİLİK MEKANİZMASI: "iki bilim insanı" müfettiş + müdahale-seçimi + tecrübe katmanı — TEMELLER):**
  Uzun tasarım dialoğunun (handikaplar, çift-yönlü-itiraf, çapraz-aile model) ürünü: orkestratörün ÜSTÜNDE bağımsız MÜFETTİŞ + kanıt-temelli tartışma. (1) [inspector.ts](orchestrator/src/inspector.ts): müfettiş = FARKLI AİLE model (Sonnet, max efor; çapraz-aile çeşitlilik → korelasyonlu kör-noktayı kırar — aynı-aile ardışık sürüm kör-noktayı paylaşır), niyet+yörünge+sonuç görür ama orkestratörün GEREKÇESİNİ değil (bağımsızlık). `runInspectorPass` (kanıt-toplayan Read/Grep/Bash) → verdict; `runScientistsDebate` (bayrak→savunma↔müfettiş, sınırlı tur, kanıt>ilke>insana); FAIL-CLOSED (üretemezse sessiz-agree YOK→escalate); yüksek-riskte "anlaşma tek başına güvenli değil". (2) [inspector-trigger.ts](orchestrator/src/inspector-trigger.ts) MÜDAHALE-SEÇİMİ ("ne zaman konuş/sus"): mekanik taban (döngü/takılma/yüksek-risk→yargısız) + asimetrik eşik (yüksek-riskte düşük, düşük-riskte yüksek) + kademeli (none/flag/debate). (3) [debate-protocol.md](assets/agent-prompts/debate-protocol.md): YZLLM↔AI iletişim manifestosu→orkestratör↔müfettiş protokolü (görünür-filtre/asla-varsayma/önce-problemde-anlaş/kalibre-itiraf). (4) [experience-layer.ts](orchestrator/src/experience-layer.ts) tecrübe katmanı: problem→KANITLI çözüm→ilke deposu (ders=İDDİA, recall ÖNERİ döner+auto-uygula yok, retracted-hariç, verified-önce). (5) [index.ts](orchestrator/src/index.ts) gate-fail yoluna GÖZLEM-modu insertion. GÜVENLİK: `features.inspector_enabled` default KAPALI + gözlem-modu (akış değişmez) + try/catch → pipeline'a SIFIR risk. check yeşil (+22 test). KALAN (canlı-doğrulamadan SONRA): verdict-aksiyon (2/d) + experience populate/wire + API-paritesi.

- **fix(Faz 11 ts-prune Next-aware: config-ignore ÇALIŞMIYOR → CLI `-i` enjeksiyonu — AMPİRİK):**
  Faz 11 framework-convention export'larını (middleware/layout/page/global-error/route/loading + vitest/playwright.config + `.next/`) ölü-kod sanıp false-positive flood'u üretiyordu → stall. DOĞRULA-SONRA-İDDİA kritikti: `.ts-prunerc.json` config-ignore'u bu ts-prune sürümünde UYGULANMIYOR (ampirik Vestel) **ve anchorlu** `-i` regex'i de ÇALIŞMIYOR — yalnız ANCHORSUZ substring `-i` çalışıyor. [mechanical-runner.ts](orchestrator/src/base/mechanical-runner.ts) ts-prune scanCmd'ine Next.js'te `-i '<regex>'` enjekte eder ([ensure-gate-configs.ts](orchestrator/src/ensure-gate-configs.ts) `NEXT_TSPRUNE_IGNORE` tek-kaynak, anchorsuz + tool-config + `.next/`). Vestel'de: exit 1→0, framework false-positive'leri elendi, gerçek bileşen muaf DEĞİL. check yeşil.

- **fix(hata-kataloğu 404-flood: watcher stable-debounce + template self-loop guard):**
  İstemci var route yok → `/api/log-error` 404 flood. (1) SEMPTOM: [runtime-error-watcher.ts](orchestrator/src/runtime-error-watcher.ts) debounce anahtarı line-hash'li `errorCode` içeriyordu → flood'da her satır farklı hash → dedup baypas → her 404 translate'e gider → boğulma. Anahtar STABLE (`typeCode::location`) → translate/emit/DB ÖNCE kesilir. (2) KÖK: [phase-05-ui.md](assets/templates/phase-05-ui.md) self-loop guard — log-POST wrapper kendi hatasını ASLA loglamamalı (re-entry→sonsuz döngü); SİLENT best-effort swallow + route yoksa sessizce fail + route'lar MUTLAKA kurulmalı. check yeşil.


- **feat(BASE STANDART: responsive mobil+tablet + dark/light mode ZORUNLU + Faz 6 dark-açış):**
  [phase-05-ui.md](assets/templates/phase-05-ui.md) yeni MANDATORY bölüm: responsive (mobile-first, fluid layout, breakpoint, tap≥44px) + dark/light (semantic color token, OS-default + toggle + localStorage, `?theme=dark|light` URL-override). [smoke-test.ts](orchestrator/src/smoke-test.ts) `ensureDevServerForReview` → Faz 6 incelemesi `?theme=dark` ile açılır (app destekler; desteklemeyen yoksayar). check yeşil. KALAN (canlı): Vestel'e 2-iterasyonla eklet → prototip.

## 2026-06-20

- **fix(SARI-GATE KÖK: verdict çapraz-iterasyon fail-carryover'ı — Faz 11/12/16 "yine sarı"):**
  Canlı testte Faz 11/12/16 bu iterasyonda 1 kez koşup TEMİZ GEÇTİ (önden-doğru config çalıştı: .ts-prunerc yazıldı vb.) ama yine sarı/PARTIAL kaldı. KÖK: [index.ts](orchestrator/src/index.ts) `computeVerdict(readAuditLog(...))` TÜM audit.jsonl'ı (append-only, tüm iterasyonlar) okuyup ÖNCEKİ iterasyonun `simplify-fail`/`perf-fail`/`e2e-fail` olaylarını BU iterasyona taşıyordu. FIX: yeni [harness-verdict.ts](orchestrator/src/harness-verdict.ts) `eventsSince(events, iterStart)` — verdict yalnız `ts >= iteration_started_at` olaylarına bakar (genuine bu-iterasyon fail'i korunur → doğru sarı; eski carryover elenir → temiz geçen gate yeşil). İlk-ever (iterStart=0) → tümü (geriye-uyumlu). check yeşil (+3 test).

## 2026-06-19

- **fix(GATE 1.3 + STRAY-CLEANUP — son sağlamlaştırmalar):**
  (1) **Gate 1.3:** YZLLM kuralı (Faz 5 UI-işi yoksa atlanır, Faz 6 her zaman inceleme ister) ZATEN uygulu ([index.ts](orchestrator/src/index.ts) `isPhaseSkippedByScope` — Faz 6 hiç scope-skip edilmez, 2026-06-15). Kalan kök: debug `plan_kind` config/build/gate dosyalarını (`.ts-prunerc`/`*.config.*`/`package.json`/`tsconfig`…) UI sanıp `ui-only`→Faz 5 UI-tweak'e gönderiyordu. [phase-00-debug.md](assets/templates/phase-00-debug.md): bunlar `.ts` olsa bile UI DEĞİL → `backend-only` (Faz 8 config yazabilir). Correct-by-construction. (2) **Stray-cleanup:** [cli-backend.ts](orchestrator/src/codegen/cli-backend.ts) codegen claude'u artık `detached: true` (process-group lideri) → ajan kuralları çiğneyip arka-plan dev-server başlatsa bile o orphan claude'un grubuna girer; close + abort'ta `killProcessTree(-pid)` GRUBU (orphan dahil) süpürür (dev-server-launcher ile aynı desen; piped stdio + detached güvenli). check yeşil.

- **feat(Faz 17 "Yük Testi" → "Sızma Testi" = gerçek pentest; bulgular → Faz-3 iterasyon; cascade-guard):**
  Yük testi araçsız atlanıp MAVİ kalıyordu → yerine GERÇEK pentest. (1) Rename: [tr.json](assets/i18n/tr.json) + [index.ts](orchestrator/src/index.ts) + [phase-3.ts](orchestrator/src/phase-3.ts) + [orchestrator-system.md](assets/agent-prompts/orchestrator-system.md) "Sızma Testi". (2) [index.ts](orchestrator/src/index.ts) `runPhase17Pentest`: `next===17`'de mekanik yük-testi YERİNE — ensureDevServerForReview (canlı app) → runDast (katana+nuclei aktif tarama) → bulgular `enqueueSecurityFindings` ile Faz-3 sistem-işleri olur. [phase-registry.ts](orchestrator/src/phase-registry.ts) skip_unless `has_nfr`→`has_ui` (pentest web-UI'da anlamlı; canlı server yoksa runDast görünür no_target). (3) **CASCADE-GUARD** (`_iterationIsSecurityFix`): güvenlik-bulgusundan doğan iterasyonun Faz-17'si bulguları YENİDEN kuyruğa YAZMAZ (yalnız doğrular) → bulgu→Faz3→Faz17→bulgu sonsuz döngüsü kırılır, yakınsar. NOT: şu an çalışan app'in tüm yüzeyini tarar; katı per-route iterasyon-scope'u sonraki rafine (cascade-guard yakınsamayı zaten garantiler). check yeşil (1298 test).

- **feat(Güvenlik bulguları → iş kuyruğuna "sistem işi" → her biri Faz 3'ten iterasyon):**
  "Güvenlik Taraması (DAST)" butonu zaten katana+nuclei ile full-projede aktif tarama yapıyordu; artık BULGULAR otomatik düzeltme-iterasyonlarına dönüşüyor. (1) [dast-runner.ts](orchestrator/src/dast-runner.ts): `runDast` artık `summary` (bulgu detayları) döndürür; yeni SAF `severityToPriority` (kritik→1…info→5), `findingToTaskText`, `dedupeFindingsByTemplate` (aynı zafiyet çok URL'de → tek iş, per-URL sel yok). (2) [task-queue](orchestrator/src/task-queue/types.ts): `source="security"` + `from_phase` alanları; `nextAutoPendingTask` security'yi de auto-drain'e alır. (3) [index.ts](orchestrator/src/index.ts) `enqueueSecurityFindings`: her benzersiz bulgu `source="security"`+`from_phase=3`+severity-önceliğiyle kuyruğa; DAST butonu sonucu bunu çağırır. (4) `runDevelopIteration(text, {seedIntent, startPhase})` + `startNextPendingTask`: güvenlik sistem-işi niyet bulgudan türetildiği için **Faz 1/2 atlanır, intent_summary seed'lenip Faz 3'ten başlar** → sona kadar gider (Faz 3 yalnız intent_summary'yi gerektirir). check yeşil (1298 test, +4). KALAN: Faz 17'yi (Sızma Testi) bu akışa bağlamak.

- **feat(STANDART: ziyaretçi dijital parmak izi + profil + login-mismatch mail doğrulama — her üretilen app):**
  Her MyCL projesi için codegen standardı (backend varsa). [phase-08-tdd.md](assets/templates/phase-08-tdd.md) yeni MANDATORY bölüm: (1) server-side dijital parmak izi (`computeFingerprint` SAF, IP/24 + UA ailesi + dil + client-hints SHA-256; `visitor_id` httpOnly çerez); (2) ziyaretçi profili + revisit tanıma + kullanıcıya çoğa-çok eşleme; (3) sayfa/işlem logu (`visitor_events`, PII'siz); (4) **step-up:** kimlik doğruysa ama parmak izi FARKLIysa korumalı sayfalardan ÖNCE `pending_verification` → kayıtlı maile **8 haneli alfanumerik** (karışan harf çıkarılmış, hash'li) kod → `/dogrulama` → **3 dk** geçerli, 5 deneme kilit → doğru kod parmak izini `known_fingerprints`'e ekler. RED-first TDD adımları. [phase-07-db.md](assets/templates/phase-07-db.md): `visitors`/`visitor_events`/`login_verifications` tabloları. [phase-05-ui.md](assets/templates/phase-05-ui.md): `/dogrulama` sayfası UI (kod formu + 3dk geri sayım + yeniden-gönder, korumalı veri sızdırmaz). check yeşil.

- **feat(UI chat: beyaz assistant balonu → koyu temaya uyumlu + balonlara "Yanıtla" butonu):**
  (1) `.msg.assistant` BEYAZ (`#f0f5f7`) idi, koyu temada sırıtıyordu → [App.css](src/App.css) `--bubble-assistant-bg` koyu nötr gri tint + açık metin + sınır (system'in mavi-tintinden ayırt edilir, uyumlu); beyaz-balon link override'ı (koyu mavi) → açık mavi. (2) Her balona **"Yanıtla" (↩)** butonu ([ChatPanel.tsx](src/components/ChatPanel.tsx), kopyala butonunun solunda, hover'da) → basınca composer üstünde alıntı önizleme chip'i; gönderince mesaja markdown blockquote alıntı (kırpılmış 280 char) eklenir → orkestratör/main bağlamı görür. check yeşil.

- **fix(SORU MODU context tutmuyordu — oturum-içi geçmiş + aç/kapa hatırlatması + cevap-emit disiplini):**
  Soru modunda orkestratör turlar arası bağlamı KAYBEDİYORDU — [handleAskQuestion](orchestrator/src/index.ts) her tur yalnız o anki soruyu geçiriyordu (CLI fresh-spawn, geçmiş yok) → "nereye yazdın?" gibi follow-up'lara alakasız/uydurma cevap (canlı: playwright.config/3000 hayali). FIX: (1) [index.ts](orchestrator/src/index.ts) `questionModeHistory` (in-memory, per-window) — her soru+cevap eklenir (son 16 mesaj), prompt'a bağlam bloğu olarak girer → follow-up'lar bağlanır. (2) Yeni `set_question_mode` IPC: toggle aç/kapa her geçişte geçmişi SİLER ("kapatınca tamamen silinir"); AÇILIŞTA chat'e hatırlatma: "Soru modu açık — konuştuklarımız kapattığınızda tamamen silinir." ([App.tsx](src/App.tsx) toggle gönderir, [events.ts](src/types/events.ts) tip). (3) [agent.ts](orchestrator/src/orchestrator-agent/agent.ts) soru-modu talimatı sıkıldı: "ASIL İÇERİĞİ yaz, 'listeledim' gibi META-cümle YASAK; oturum bağlamını dikkate al" (canlı: "listeledim" deyip listeyi yazmama kusuru). check yeşil (1294 test). NOT: çalışan app'te etki için orkestratör süreci restart + frontend rebuild.

- **fix(GATE SAFETY-NET #1 + #4: Faz-8 repro gate görev-sınıfı-duyarlı + decision/error-analysis hang-timeout):**
  (#1) Faz-8 repro-first gate, tip-only refactor / ölü-kod removal / re-export gibi STATIC-ONLY değişiklikte runtime kırmızı→yeşil İMKANSIZ olduğu için fix'i reddediyordu → fix hiç uygulanmadan döngü (canlı: Faz 11 simplify ↔ Faz 8, affected=0; orkestratör doğruladı). FIX: yeni [git.ts](orchestrator/src/git.ts) `getDiffSinceRef` + [phase-8.ts](orchestrator/src/phase-8.ts) `isStaticOnlyChange`/`isStaticSafeAddedLine` — değişiklik static-only ise (eklenen her satır tip/yorum/boş/import-type/re-export/kapanış VEYA sadece silme; yeni prod dosyası yok) repro zorunluluğu DÜŞER. Suite-green (tddOk) + tech-debt + AC kontrolleri AYNEN kalır → gate ZAYIFLAMAZ, regresyon yine yakalanır; yalnız imkansız-repro döngüsü kırılır (audit: `repro-static-only-exempt`). (#4) Hang-timeout: [error-analysis.ts](orchestrator/src/error-analysis.ts) CLI yolu `timeoutMs:0` + 30dk default wall-clock → triage için fazla (canlı 44dk "model çalışıyor" donması) → `wallClockMs: 900_000` (15dk; idle yok, thinking ölmez). [cli-orchestrator.ts](orchestrator/src/orchestrator-agent/cli-orchestrator.ts) routing kararı `wallClockMs: 600_000` (10dk; idle 3dk no-output hang'i zaten yakalar). check yeşil (1294 test, +6). KALAN gate-fix: #3 fix-dispatch originating-faza dönsün (tetikleyici Task-2'de hafifledi).

- **feat(ÖNDEN-DOĞRU config — "sarı kalmasın": Faz-16 playwright webServer + Faz-11 ts-prune Next.js-aware + Faz-12 perf-DRY):**
  Sarı = gate fail-then-fix. Codegen/MyCL config'i BAŞTAN doğru üretirse gate temiz geçer (ensureCspMeta deseni). (1) **Faz-16:** [playwright-setup.ts](orchestrator/src/playwright-setup.ts) `renderPlaywrightConfig` artık `devCommand` alıp **`webServer` bloğu** yazar (`command`, `url`, `reuseExistingServer:true`, `timeout`, `env.PORT` = MyCL dev-launcher ile aynı) → E2E koşarken dev server OTOMATİK ayağa kalkar (ayaktaysa reuse) → "server yok" fail'i yok. Çağrı yerleri (index.ts/verify-feature.ts) profil `commands.dev`'i geçirir. (2) **Faz-11:** yeni [ensure-gate-configs.ts](orchestrator/src/ensure-gate-configs.ts) `ensureTsPruneConfig` — Next.js projesinde `.ts-prunerc.json` yoksa framework-convention dosyalarını (app router `page/layout/route/…`, `pages/`, `middleware`, `next.config`) `ignore` eden bir tane yazar → ts-prune false-positive vermez (gerçek bileşen ölü-export'u yine yakalanır); [mechanical-runner.ts](orchestrator/src/base/mechanical-runner.ts) ts-prune scan'inden ÖNCE çağırır. (= gate-fix #2 Faz-11 ts-prune Next.js-aware). (3) **Faz-12:** [phase-05-ui.md](assets/templates/phase-05-ui.md) perf script `vite build --mode production && echo` → **`npm run build`** (DRY: build'i yeniden kullan, bundler komutunu çiftleme) + Next.js `outputFileTracingRoot: __dirname` notu (workspace-root uyarısı sussun). check yeşil (1288 test, +6).

- **change(CSP: DEV DAHİL hiç `unsafe-*` YOK — dev-only carve-out KALDIRILDI):**
  Canlı remax_BO CSP'sinde `script-src ... 'unsafe-eval'` vardı (CSP Evaluator flag'ledi) — eski dev-only Fast-Refresh carve-out'undan. (1) [csp-compliance.ts](orchestrator/src/csp-compliance.ts) `violationsInLine`: `devGated` istisnası (NODE_ENV!=='production' / isDev / `__DEV__` / `import.meta.env.DEV` …) KALDIRILDI → tırnaklı `'unsafe-*'` token'ı her zaman ihlal (yorum satırları yine elenir). (2) Tarama kapsamı: config dosyaları (`*.config.js/ts`) artık genel taranmasa da **yalnız CSP `unsafe-token`** için taranır — Next.js/Vite header-CSP'si tam orada tanımlanır (eval/inline-style build-zamanı yapıları yanlış-pozitif vermesin diye diğer türler config'te atlanır); test/spec fixture'ları tam atlanır. (3) [phase-05-ui.md](assets/templates/phase-05-ui.md): "dev hot-reload carve-out" talimatı → "NO dev carve-out — ZERO unsafe-* in dev EITHER; Fast Refresh çalışmayabilir → manuel yenile; güvenlik > dev-konfor; inline bootstrap için per-request nonce". Faz-13 csp-check.mjs zaten herhangi unsafe direktifi (sev≤40) blokluyor — politika dev/prod artık tek+strict olduğu için ek değişiklik gerekmedi. TRADE-OFF: unsafe-eval'siz hot-reload bozulur (manuel refresh). check yeşil (1282 test, +2 CSP testi). ESKİ KARARI TERS ÇEVİRİR (2026-06-17 "vite.config dev-CSP false-positive" → YZLLM 2026-06-19 override).

- **change(PDF KULLANIM KILAVUZU KURALI KALDIRILDI — yalnız app-içi kılavuz + her sayfada "?"):**
  Eski F4 kuralı (program 6/8) proje-içi **PDF kullanım kılavuzu** (`public/docs/kullanim-kilavuzu.pdf`, headless Chromium + `page.pdf()`) üretiyordu. KALDIRILAN: `generateGuidePdf` + PDF-only HTML yardımcıları (`buildGuideHtml`/`markdownToHtml`/`escapeHtml`/`extractRoutesFromFeatures` — sonuncusu zaten [living-docs.ts](orchestrator/src/living-docs.ts)'te kopya, testi orada) + pipeline-end PDF çağrısı ([index.ts](orchestrator/src/index.ts)) + `guide-pdf.test.ts`. KORUNAN: app-içi kılavuzun ekran görüntüleri — `guide-pdf.ts` → **[guide-shots.ts](orchestrator/src/guide-shots.ts)** olarak yeniden adlandırıldı (yalnız `generateGuideShots`; dürüst isim, PDF üretmiyor). [phase-05-ui.md](assets/templates/phase-05-ui.md) zaten "NOT a PDF" diyordu — değişmedi. check yeşil.

- **feat(Faz 5 LOGIN-İSTİSNASI: auth'lu app'te reviewer giremezse tasarımı göremez → MİNİMAL dev-login Faz 5'te):**
  Tavuk-yumurta: Faz 5 UI-only (backend Faz 8). App'te login varsa Faz-6 reviewer authenticated UI'ye (panel) ULAŞAMIYOR — login backend yok → `POST /api/auth/login` 404 → sadece login ekranını görüyor (canlı remax_BO: "giremedim, şifre ne?"). ÇÖZÜM: LOGIN/AUTH için İSTİSNA — Faz 5 minimal çalışan dev-login yazar (login/logout endpoint + session + 1 SABİT seed kullanıcı), reviewer giriş yapıp paneli inceler; gerisi Faz 8. (1) [tool-handlers.ts](orchestrator/src/tool-handlers.ts): `extra_allowed_patterns` — phase-deny'ı (`extra_denied_paths`) EZER ama default-deny'ı (`.mycl/.git`) EZMEZ (güvenlik; 3 test: auth izinli / non-auth denied kalır / `.git` korunur). (2) [phase-5.ts](orchestrator/src/phase-5.ts): `AUTH_EXCEPTION_PATTERNS` (auth/login/logout/session) toolCtx'e bağlı → auth yolları yazılabilir, non-auth app'te no-op. (3) [phase-05-ui.md](assets/templates/phase-05-ui.md): istisna talimatı — minimal scope, stack-bağımsız, seed şifre login ekranında **dev-only ipucu** (reviewer görsün); GÜVENLİK: sabit dev-değeri (gerçek key DEĞİL) + prod'a sızmaz. (4) [phase-08-tdd.md](assets/templates/phase-08-tdd.md): Faz 8 dev-login'i GERÇEK DB-auth ile DEĞİŞTİRİR (çiftleme yok; sabit seed prod'a kalmaz). check yeşil (1289 test).

## 2026-06-18

- **feat(Faz 5: dev-server "ayakta" YETMEZ → 200/3xx SERVİS ettiğini doğrula (build-breaker yakala) + görsel-ajan hang timeout):**
  Canlı remax_BO: `HelpButton` (`'use client'`) server-only `lib/help.server`'ı (`import 'server-only'`+`fs`) import etti → client bundle'a sızdı → Next.js tüm build'i kırdı → TÜM route 500. Ama [dev-server-launcher.ts](orchestrator/src/dev-server-launcher.ts) `tryDevServerChain` "ready" = HERHANGİ HTTP yanıtı (500 dahil) sayıyordu → phase-5 "✅ Dev server hazır" deyip geçiyordu → **bozuk app Faz 6 incelemesine geçti** (kullanıcı 500 gördü). FIX: (1) `waitForDevServer`'a `serving` modu — 5xx HARİÇ her yanıt (2xx/3xx/4xx) OK; 4xx'i kabul eder (404-on-`/` app yanlış-pozitif YOK), yalnız build-kıran 5xx'i reddeder. (2) [phase-5.ts](orchestrator/src/phase-5.ts) create-flow: dev-server "ready" sonrası `/` gerçekten servis ediyor mu (kalıcı 5xx değil) DOĞRULA → değilse `failPhase` → Faz 0 debug ASIL build hatasını (server-only sızıntısı / syntax) bulup düzeltir. Correct-by-construction: "derlendi/process-başladı" ≠ "servis ediyor". (3) [visual-design-agent.ts](orchestrator/src/visual-design-agent.ts): `captureScreenshot` 60s timeout — HANG → skip (canlı bir app'i screenshot'larken 50s+ asıldığı gözlemlendi; try/catch throw'u yakalar HANG'i yakalamaz → MyCL'in tekrar eden hang-sınıfının biri). (4) [pipeline-e2e.test.ts](orchestrator/test/integration/pipeline-e2e.test.ts): dev-server + görsel-ajan mock (gerçek 5173/screenshot'a bağımlı kalmasın → izole). check yeşil (1286 test).

- **change(YÖNLENDİRME KURALI TERSİNE: onarım → her zaman debug_triage fast-path; yeni/değişiklik → develop_new_or_iter tam pipeline):**
  ESKİ kural ([decision.ts](orchestrator/src/orchestrator-agent/decision.ts):329) "her iş Faz 1'den başlar" idi: `develop_new_or_iter`=HER yeni iş (bug/hata düzeltme DAHİL)→tam pipeline; `debug_triage`=YALNIZ pipeline-içi gate-hatası, "kullanıcı talebini buraya ASLA yönlendirme". Sonuç: canlı remax_BO'da "500 veriyor, düzelt" mesajı niyet-toplama+onay→Faz 2 (tüm pipeline ~1 saat) tetikledi — 5 dk'lık debug yerine. YZLLM'in "fix/debug ~5 dk" hedefini ihlal ediyordu. YENİ kural: var olan bir şey BOZUK/çalışmıyor ('bozuldu/çalışmıyor/açılmıyor/500/hata/düzelt') → **HER ZAMAN `debug_triage`** → Faz 0 hızlı-şerit (kök bul + hedefli faza dispatch, tam pipeline'ı yeniden başlatma, onay sorma). YENİ özellik / mevcut özelliği geliştir-değiştir (bozukluk YOK) → `develop_new_or_iter` (Faz 1'den, değişmedi). Ayraç: "bozuk mu?". LLM yine karar verir (no-regex korunur), yalnız routing kuralı netleşti. Mekanizma (debug_triage→Faz 0) zaten vardı, sadece kullanıcı-talebine açıldı. check yeşil (1286 test).

## 2026-06-17

- **change(Faz 5 CSP-talimat güçlendirme — "önden-doğru yaz, gate son-çare"):**
  [phase-05-ui.md](assets/templates/phase-05-ui.md) CSP bölümünün başına PROAKTİF vurgu eklendi: "Get this right UP FRONT while writing — gate fires → phase RE-RUNS (wasted token+time)". Codegen en baştan CSP-uyumlu yazsın; gate güvenlik-ağı olarak KALIR ama tetiklenmemeli. Genel "önden-çözme her konuda" prensibi global CLAUDE.md (Code Design Principles) + memory'ye de yazıldı (yerel, repo-dışı). check yeşil.

- **change(UI: İş göstergesi ChatPanel başlığında da — "Tümünü kopyala" yanında):**
  O anki iş, üst-bar (AppHeader 🔧) yanında artık [ChatPanel.tsx](src/components/ChatPanel.tsx) başlığında "Tümünü kopyala" butonunun YANINDA da görünüyor (🔧 + kısa iş metni, ellipsis). ChatPanel'e `currentJob` prop eklendi; [App.tsx](src/App.tsx) `mainState.iterationIntent`'i geçiriyor. check yeşil.

- **feat(UI: Token Zaman Çizelgesi — Faz 0/1 de gösterilir + ortalama/faz + 17-faz öngörü):**
  (a) Faz 0 (Debug) + Faz 1 (Niyet) çizelgede ATLANIYORDU (Faz 2'den başlıyordu) — çünkü bunlar advanceToNextPhase loop'u DIŞINDA (handleUserMessage / failPhase-debug) çalışıp `beginPhaseCost` almıyordu (Faz 2-9 loop-içinde alır). [index.ts](orchestrator/src/index.ts): Faz 1 (2 yer: 1146 + 2502) + Faz 0 (2346) controller'larından ÖNCE `beginPhaseCost` eklendi → cost-bucket set edilir, flush'u loop sonraki geçişte yapar → token+süreleri çizelgeye yazılır. (b) [TokenTimelinePanel.tsx](src/components/TokenTimelinePanel.tsx): toplam bölümüne **"Ortalama/faz: N token · süre → 17 faz öngörü: N×17 token · süre×17"** satırı eklendi (kullanıcı tam pipeline maliyetini öngörsün). check yeşil; görsel inceleme kullanıcıda.

- **change(UI: AppHeader aksiyon butonları → sağ DİKEY bar (RightActionBar), alt alta):**
  Üst-bardaki aksiyon butonları (Çalıştır/Duraklat/sağ-panel-toggle/Faz-menüsü/İş Kuyruğu/Yeni Pencere/Güncelle/Token/Ayarlar) AppHeader'dan yeni [RightActionBar.tsx](src/components/RightActionBar.tsx)'a **dikey** (alt-alta) taşındı. AppHeader artık YALNIZ bilgi: başlık + build-zamanı + proje-yolu + o-anki-iş + faz-göstergesi + hüküm-çipi. [App.tsx](src/App.tsx) layout: `app-main` grid'ine 6. kolon (`auto`) eklendi, 4 collapse varyantı da güncellendi (her birinde en sağda). Handler'lar + data-testid'ler (execute-btn/pause-btn/new-window-btn/settings-btn) korundu — davranış aynı, yalnız konum/yerleşim değişti. check yeşil; görsel inceleme kullanıcıda.

- **fix(529 tespiti GÜÇLENDİRME: codegen "exit=1" yolunda da 529'u yakala — canlı koşu-3'te HER faz 529 aldı):**
  İlk 529-fix (f9fb803) `failPhase`'e 529-branch ekledi AMA: (1) codegen claude'u AYRI spawn ediyor ([cli-backend.ts](orchestrator/src/codegen/cli-backend.ts), cli-run.ts'i değil); (2) 529 "Overloaded" mesajı claude STDOUT/assistant-text'te, STDERR'de DEĞİL → `reason="claude exit=1"` oluyordu, 529 yansımıyordu → failPhase pattern'i eşleşmiyordu → debug yine 3 dk araştırdı. FIX: hem [cli-run.ts](orchestrator/src/cli-run.ts) hem cli-backend.ts fail-reason'ına assistant-text/output'taki 529 imzasını taşı (`lastTextTail` class-field ile) → reason 529 içerir → failPhase doğru ele alır ("API yoğun, bekle + Çalıştır"). check yeşil. Canlı doğrulama Anthropic API yükü geçince (şu an genel 529 — her faz).

- **fix(Faz fail: 529 Overloaded = geçici API yükü → debug/tweak'e DEĞİL "bekle+Çalıştır"a yönlendir):**
  Canlı temiz koşuda Faz 5 = **11.5 dakika** (cost_phase: 688931ms, 15 tur). Sebep: Anthropic API geçici "529 Overloaded" → Faz 5 codegen fail → [index.ts](orchestrator/src/index.ts) `failPhase`'de 529 için özel-skip YOKtu (auth + ortam hataları var, 529 yok) → oto-çözüm/debug → **tweak-modu** → ajan ne yapacağını bilemeyip **9 dakika** cache/transcript dosyalarını (`cacheprobe.js`, `.claude/projects/...`) kurcaladı, UI yazmadı (boşa). FIX: `failPhase`'e 529/overloaded branch'i (auth/ortam ile AYNI kalıp) → oto-çözüm/debug/tweak SKIP + net mesaj ("API geçici yoğun — birkaç dakika bekle + Çalıştır; debug YAPMADIM çünkü hepsi yine API gerektirir, aynı hatayı verirdi"). check yeşil (pipeline-e2e testi sistem-yükünden flaky'ydi → CPU boşalınca izole geçti).

- **fix(CSP gate YANLIŞ-POZİTİF: yorum + build-config + test-fixture'ı ihlal sanıyordu):**
  Temiz greenfield koşuda Faz 5 CSP-gate 3 "ihlal" raporladı — ÜÇÜ DE yanlış pozitif (MyCL-debug ajanı da bağımsız doğruladı): (1) index.html'de "no unsafe-inline" AÇIKLAMA YORUMU; (2) vite.config.js dev-CSP'si (HMR için gevşek, production-build strict); (3) ajanın yazdığı csp.test.js test-fixture'ındaki `'unsafe-inline'` örneği. Kök: gate ham-metni tarıyordu (yorum/config/test ayırt etmeden). FIX [csp-compliance.ts](orchestrator/src/csp-compliance.ts): (a) `unsafe-token` yalnız TIRNAKLI CSP-directive (`'unsafe-inline'`) yakalar → tırnaksız yorum yakalanmaz; (b) `SKIP_FILE_RE` = `*.config.*` + `*.test.*`/`*.spec.*` (build-config + test = uygulama RUNTIME davranışı DEĞİL, CSP onları çalıştırmaz). İzole doğrulandı: aynı projede **0 ihlal**. check yeşil. NOT (YZLLM prensibi): gate güvenlik-ağı kalır ama yanlış-pozitif token+zaman yakıyordu → önden-doğru-tarama.

- **fix(Faz 6 UI incelemesi: "UI'yi onayla" derken dev-server GARANTİLE — orkestratör reask yolu dev-server'ı atlıyordu):**
  BULGU (adminpanel canlı): boot-resume adminpanel'i Faz 6'dan açtı + Faz 5 (dev-server başlatan faz) koşmadı → dev-server yok (portlar boş). [phase-6.ts](orchestrator/src/phase-6.ts) controller'ı dev-server-restart yapıyor AMA "onaylıyor musun" reask mesajı oradan DEĞİL — orkestratörün Faz 6-context yolundan ([index.ts:1900](orchestrator/src/index.ts)) geliyordu ve o yol dev-server'ı KONTROL ETMİYORDU → kullanıcı neyi onaylayacağını göremiyordu. FIX: ortak `ensureDevServerForReview(state, config)` helper ([smoke-test.ts](orchestrator/src/smoke-test.ts): alive-check + restartDevServerSimple + tarayıcı aç) → HEM Phase6Controller HEM index.ts reask yolu onu çağırır (DRY, tek doğruluk kaynağı). Artık "UI'yi onayla" derken dev-server garantili ayakta. check yeşil; canlı (adminpanel) doğrulanacak.

- **feat(Faz 5 sonrası GÖRSEL TASARIM ajanı — estetik rötuş, yalnız CSS, CSP-güvenli):**
  Motivasyon: Faz 5 codegen işleve odaklı (CSP/a11y/spec) → estetik elde kalıyor (canlı kanıt: sayaç çalışıyor ama çirkin). [visual-design-agent.ts](orchestrator/src/visual-design-agent.ts): dev-server açıkken sayfanın ekran görüntüsünü alır → görüntü-anlayan claude'a verir (**Read tool PNG'i GÖRSEL okur** — multimodal, ekstra mekanizma gerekmez) → ajan SADECE stil (CSS) dosyalarını güzelleştirir (renk paleti / boşluk-hizalama / tipografi / görsel hiyerarşi). [phase-5.ts](orchestrator/src/phase-5.ts): dev-server-hazır sonrası, Faz 6 (kullanıcı incelemesi) ÖNCESİ (her iki complete-yolu) → kullanıcı daha güzel bir başlangıç görür. **GÜVENLİK (işlevi/güvenliği BOZAMAZ):** `disallowedTools=[Bash,Agent,Task]` (kod-çalıştırma kaçışı + alt-ajan donması engel) + git-diff → yalnız stil dosyaları değişmeli (JSX/TS/HTML/backend → GERİ ALINIR) + CSP re-scan → inline-style eklendiyse TÜM rötuş geri alınır (CSP %100 > estetik) + non-blocking (fail → Faz 6 devam, asla pipeline kırmaz) + tweak-skip (kullanıcı-spesifik tweak ezilmez). [visual-design-agent.test.ts](orchestrator/test/visual-design-agent.test.ts) (nonStyleFiles güvenlik ayrımı + prompt kısıtları). check yeşil; canlı (adminpanel) doğrulanacak.

- **fix(sandbox/ağ + cache: npm/paket-yöneticisi engellenmesin — allowedDomains + allowWrite):**
  E2BIG-fix claude'u başlatınca GİZLİ iki engel açığa çıktı (önceden argv-E2BIG claude'u hiç başlatmadığı için görünmüyordu): (1) `sandbox.enabled` → claude AĞI da default DENY-ALL eder → `npm install` registry.npmjs.org'a ulaşamıyordu (greenfield pipeline npm-install'da takıldı, MyCL-debug çözemedi). (2) npm cache `~/.npm` (home-altı) sandbox WRITE-deny → EPERM (npm "root-owned files" diye YANLIŞ raporladı; klasör gerçekte kullanıcı-owned). İKİ fix [agent-sandbox.ts](orchestrator/src/agent-sandbox.ts): (a) `sandbox.allowedDomains` = güvenilir paket registry + prebuilt-binary host (registry.npmjs.org/yarnpkg.com/github.com vb.) — WHITELIST olduğu için keyfi domain (C2/exfil) HÂLÂ deny. (b) `filesystem.allowWrite` = [~/.npm, ~/.cache] (paket/araç cache — executable değil; auth `.claude`/`.config` write-deny KALIR). AMPİRİK (gerçek `claude --settings` + Seatbelt): registry curl=**200**, keyfi-domain=**000** (engel), `npm install` **EXIT=0 + INSTALLED_OK** (2 paket). [agent-sandbox.test.ts](orchestrator/test/agent-sandbox.test.ts) allowedDomains + allowWrite assert. check yeşil.

- **feat(Faz 5: %100 CSP uyumluluğu — talimat + DETERMİNİSTİK gate, unsafe-* YOK):**
  İki katman:
  (1) **Talimat** — [phase-05-ui.md](assets/templates/phase-05-ui.md): kapsamlı CSP bölümü — katı politika (meta-tag; `unsafe-inline`/`unsafe-eval`/`*` YOK) + no inline-script/handler, no `eval`/`new Function`/string-timer, no inline-style (static), no `javascript:`; styling harici CSS/CSS-değişkeni; Verification'a self-verify checkpoint.
  (2) **Deterministik gate** — [csp-compliance.ts](orchestrator/src/csp-compliance.ts) + [phase-5.ts](orchestrator/src/phase-5.ts) (codegen sonrası, dev-server öncesi; HER iki mode). Talimat-only YETMEDİ (canlı test: ajan kod-CSP-temiz yazdı AMA index.html'e meta EKLEMEDİ → tarayıcı zorlamıyordu). Gate iki adım: `scanCspViolations` (kodda unsafe-* gerektiren yapı → deterministik düzeltilemez → Faz 5 **fail**, ajan düzeltir; meta'yı ihlal VARKEN eklemek uygulamayı kırardı → önce tarama) + `ensureCspMeta` (kod temizken giriş HTML'ine katı CSP meta YOKSA MyCL **kendisi ekler** → ajan atlasa bile %100; Next/SSR → no-html skip).
  CANLI test (greenfield sayaç uygulaması): Faz 5 kod-CSP-temiz üretti (App.jsx `className`+`onClick`, harici CSS, no-unsafe) ✓ ama meta eksikti → gate gerçek kodda izole koşturuldu: **0 ihlal + katı meta deterministik eklendi (unsafe-* yok)** ✓. [csp-compliance.test.ts](orchestrator/test/csp-compliance.test.ts) (10 saf pattern + 3 IO fixture). Testler yeşil (CSP testleri dahil).

- **fix(sandbox/E2BIG KÖK: home'u TEK kuralla deny + proje/runtime `allowRead` ile re-allow — "spawn E2BIG: argument list too long" biter, güvenlik AYNI):**
  KÖK: [agent-sandbox.ts](orchestrator/src/agent-sandbox.ts) eski kod home'daki HER girdiyi (YZLLM'in home'unda 355) tek tek `denyRead`'e koyuyordu → claude bunu her Bash çağrısında sandbox-exec/bwrap profil argv'sine çevirince argv ~10KB → spawn `E2BIG` → ajan Bash/test ASLA başlamıyordu (Faz 8 testleri "koşamadı", kırmızı değil — bu yüzden gerçek startup-çökmeleri test edilemeden geçiyordu). DÜZELTME: `denyRead = [home]` (tek kural) + `allowRead = [proje, ...runtime(.claude/.config/.cache/Library…)]`. claude-code `filesystem.allowRead`, denyRead-region'ını OVERRIDE eder (resmi doküman; macOS Seatbelt + Linux bwrap kernel-seviye). Argv 355→2 kural (~1.2KB) → E2BIG biter. GÜVENLİK AYNI: home'daki allow-DIŞI her şey (.ssh/.aws/.gnupg/medya/Documents/diğer-projeler) KAPALI; yalnız proje + runtime açık. Bonus: home-readdir bağımlılığı kalktı (readdir-fail→denyRead-boş güvenlik açığı da gitti). AMPİRİK DOĞRULANDI (gerçek `claude --settings` + Seatbelt, SAHTE-secret ile sızıntısız): proje `cat`→OK; home-altı allow-dışı `cat`→"Operation not permitted" (içerik SIZMADI); `ls $HOME` ve `ls ~/.ssh`→"Operation not permitted" (gizli dosya adları bile görünmez); runtime okunur (claude iki çağrıda da çalıştı). [agent-sandbox.test.ts](orchestrator/test/agent-sandbox.test.ts) yeni mekanizmaya yeniden yazıldı (en kritik assert: gizli girdiler allowRead'de OLMAMALI). 1254 test yeşil.

## 2026-06-16

- **change(UI: ChatPanel "MYCL" başlığı kaldırıldı + iş göstergesi HER ZAMAN kullanıcı-orijinal kısa metin):**
  (1) ChatPanel `panel-label`'daki "MyCL" span kaldırıldı (yer kaplıyordu; "Tümünü kopyala" butonu kalır). (2) İş göstergesi (başlık/currentJob) **boot/resume'da** artık kuyruk-işinin ORİJİNAL kullanıcı-text'ini gösteriyor — [index.ts](orchestrator/src/index.ts) 701: `intent_summary_raw` (uzun-türetilmiş / fix-dispatch prompt'u "backend/src/index.js'de CREATE UNIQUE INDEX...") yerine `readTasks`→aktif(currentTaskId)/running/pending `task.text`. Artık-ölü `emitIterationIntentTr` + `translate` import'u silindi. ("İşi başlığa yazmıştık, şimdi görünmüyor" → uzun-teknik yerine kısa-iş.) 1252 test yeşil.

- **fix(boot-resume devamı: spec-üretici faza resume'da devs/_pending DİZİNİNİ garantile — ENOENT/"boot resume failed" önle):**
  fix(spec-missing→Faz 4) sonrası ikinci edge-case çıktı: boot-resume Faz 4'e yönlendiriyordu ama Faz 1 girişini ATLADIĞI için `ensurePendingIterationDir` çağrılmamış → `devs/_pending/<ts>/` dizini YOK → Faz 4 spec'i oraya YAZAMIYORDU (writeFile `ENOENT: open .../iter-spec.md` → "boot resume failed"). Düzeltme: [index.ts](orchestrator/src/index.ts) boot-resume'da Faz ≤4 resume'da `ensurePendingIterationDir(project_root, iteration_started_at)` çağrılıyor (fail-soft). CANLI doğrulandı (commit öncesi): devs/_pending dizini oluştu ✓, `boot-fail: 0` (önceki koşuda vardı), Faz 4 spec yazmaya başladı. 1252 test yeşil.

- **fix(boot-resume: spec-gerektiren faza resume + iter-spec YOKSA → Faz 4'ten başla — devs/-silme kırılganlığı):**
  YZLLM adminpanel/devs/'i silip tekrar test edince çıktı: boot-resume eski işi Faz 8'den sürüyordu (`iteration_started_at` eski ts) ama spec artık `devs/_pending/<ts>/iter-spec.md`'de (Faz 2+3) ve devs/ silindiği için YOK → Faz 8 "spec.md missing" ile takılıyordu (`currentSpecPath` dosya-varlığını kontrol etmez). Bu, per-iter-spec'in getirdiği kırılganlık (spec kök yerine devs/_pending'de; o silinirse spec-okuyucular spec bulamaz). Düzeltme: [index.ts](orchestrator/src/index.ts) boot-resume'da, resume hedefi Faz >4 (UI-codegen/DB/TDD/risk) ama `currentSpecPath` dosyası yoksa → **Faz 4'ten başla** (spec'i devs/_pending'e yeniden üret) + görünür bilgi. CANLI: devs/ silinmiş adminpanel'de "Faz 8 spec yok → Faz 4'ten devam" + Faz 4 spec yazmaya başladı (eskiden spec-missing fail). 1252 test yeşil.

- **change(merdiven kelimesi temizliği — görünür mesajlardan "(merdiven)" kaldırıldı) [canlı test bulgusu]:**
  Canlı testte yakalandı: merdiven davranışsal kaldırıldı ama 2 görünür mesajda "(merdiven)" etiketi kalmıştı — [phase-4.ts](orchestrator/src/phase-4.ts) "🧠 Spec: … efor X (merdiven)" + [phase-8.ts](orchestrator/src/phase-8.ts) "🧠 Codegen: … efor X (merdiven)". İkisinden de "(merdiven)" çıkarıldı (model+efor artık iş-türüne göre, parantez-etiketi yanıltıcıydı). 1252 test yeşil.

- **fix(Faz 8 gate: suite-EXECUTION-failure (E2BIG/ortam) ≠ GERÇEK test-failure — yanlış-pozitif önleme) [CANLI kanıt]:**
  Canlı adminpanel koşusunda Faz 8 "AC coverage 0/3 + tam-suite KIRMIZI" verdi ve 3 escalation turu + derin-çözüm harcadı — OYSA dedup testleri izole koşunca 5/5 GEÇİYORDU (fix doğruydu). Kök neden: `runIntegrityAnchor` E2BIG/spawn-faultunda `tdd-unverified` yazıp dönüyor (testler KOŞMADI, doğru) ama [phase-8.ts](orchestrator/src/phase-8.ts) gate bunu bilmeyip greens=0 → "0/3 KIRMIZI" (gerçek fail) sanıyordu → escalation/derin-çözüm + fix-doğruyken rollback. Düzeltme: gate `!finalSuiteRun && tdd-unverified VAR` → **ortam-fail**: `lastFailReason`'a E2BIG/"argument list too long" marker konur → `failPhase`'in `isEnvironmentError` dalı yakalar (DUR, kod-fix/escalation YOK) + `lastFailEscalatable=false` + rollback ATLANIR (fix korunur). 1252 test yeşil. (Asıl kök E2BIG'in kendisi sonraki iş: sandbox argv→profil.)

- **change(Token Zaman Çizelgesi: para ($) kaldırıldı, faz + toplam SÜRE eklendi):**
  [TokenTimelinePanel.tsx](src/components/TokenTimelinePanel.tsx)'den `$` gösterimi (toplam 💵 + faz-başı `total_cost_usd`) tamamen kaldırıldı — yalnız token + tur + **süre**. Süre için: cost kovasına (`PhaseCostBucket`) `started_at` eklendi ([ipc.ts](orchestrator/src/ipc.ts) `beginPhaseCost`), faz tamamlanınca `costRec.duration_ms = now − started_at` yazılıyor ([index.ts](orchestrator/src/index.ts)); `CostRecord`'a `duration_ms?` (orchestrator + frontend tip). Panel her faz satırında + toplamda okunabilir süre gösteriyor (`fmtDur`: "12sn" / "2dk 5sn"). `total_cost_usd` veride kalır (gösterilmez). 1252 test yeşil.

- **change(iş göstergesi HER ZAMAN kullanıcı-orijinal kısa metin — Faz 1 türetilmiş özet üzerine yazmaz):**
  İş göstergesi (üst bar 🔧) artık kullanıcının kuyruğa yazdığı KISA orijinal metni (`next.text`, `startNextPendingTask`'te set) gösteriyor. Faz 1 onayı sonrası `emitIterationIntentTr(intent_summary)` ile gelen TÜRETİLMİŞ (uzun, teknik) özetin üzerine-yazması KALDIRILDI ([index.ts](orchestrator/src/index.ts) 2 yer: normal + resume). Her iş `driveWorkQueue`→kuyruk→`startNextPendingTask`→`next.text` yolundan geçtiği için gösterge hep kısa kalır. (boot/açılış `emitIterationIntentTr` korundu — kuyruk başlayınca zaten next.text ile ezilir.) 1252 test yeşil.

- **change(ChatPanel: büyük "İş" kutusu kaldırıldı — yer kaplıyordu, üst bar zaten gösteriyor):**
  ChatPanel üstündeki `first-prompt-box` (iterationIntent display — o anki işin uzun metnini büyük kutuda gösteriyordu) kaldırıldı. İş göstergesi artık yalnız AppHeader üst-barında (🔧 currentJob) — tek yerde, yer kaplamadan. `iterationIntent` prop ChatPanel'den çıkarıldı (App→AppHeader currentJob geçişi korundu). 1252 test yeşil.

- **refactor(escalation iç ölü-kod temizliği — merdiven kaldırmanın 2. parçası):**
  [escalation.ts](orchestrator/src/escalation.ts) ladder altyapısı (`buildLadder`/`firstRung`/`nextRung`/`resolveRung`/`rungForDomain`/`rungLabel`/`isRung`/`Rung`/`Effort`/tier-efor tabloları) tamamen kaldırıldı → dosya yalnızca `escalatedModelEffort` + `DOMAIN_TO_TASK`. `model-strength-report.ts` + test silindi (merdiven-öğrenme raporu, artık kimse çağırmıyor). `types.escalation_rungs` state alanı + index.ts read_selected_models snapshot'ı kaldırıldı. `escalation.test.ts` yeniden yazıldı: artık iş-türü→model/efor davranışını test ediyor (kalite-kritik→strong, intent→balanced, bilinmeyen→codegen, eski escalation_rungs state'i ETKİSİZ). 1252 test yeşil.

- **change(escalation MERDİVENİ kaldırıldı — model/efor İŞ-TÜRÜNE göre, başarısızlıkta tırmanma YOK):**
  Canlı adminpanel koşusunda E2BIG yanlış-pozitifinde merdiven **3 tur boşa** tırmandı (Faz 8 hep "0/3 KIRMIZI" sandı; aslında testler izole 5/5 geçiyordu). YZLLM kaldırma kararı + **"iş-türüne göre oto"** seçti. **Çekirdek:** `escalatedModelEffort` (tek choke-point) artık `selectModelForTask`+`selectEffortForTask` ile İŞ-TÜRÜNE göre çözer ([escalation.ts](orchestrator/src/escalation.ts) `DOMAIN_TO_TASK`: intent→balanced; audit/briefing/spec/ui-codegen/db-design/tdd-codegen/risk-review→strong) — 6 faz (1/3/4/5/7/8 + Faz 9 risk) HİÇ değişmez (imza korundu). **Climb kaldırıldı:** [index.ts](orchestrator/src/index.ts) `failPhase` fail→üst-rung+aynı-fazı-tekrar bloğu + Faz 13 güvenlik climb SİLİNDİ → fail doğrudan derin-çözüme; güvenlik yakınsamazsa doğrudan terminal (yakınsama-kırıcı security-convergence KORUNDU → sonsuz döngü yine önlenir). **UI:** model picker KİLİDİ AÇILDI ([Settings.tsx](src/components/Settings.tsx) — kullanıcı tier modellerini seçer, config kral) + "Tırmanılan seviyeler (escalation)" paneli + `escalation_rungs` event/prop/state ([App.tsx](src/App.tsx), [events.ts](src/types/events.ts)) kaldırıldı. `recordRungOutcome`/`recordPhaseComplete` no-op (strength-öğrenme anlamını yitirdi). Ölü index fonksiyonları (`tryAdoptNewerStrongModel`/`ESCALATION_PHASES`/`phaseDomain`) silindi. Kalan iç ölü-kod (escalation.ts ladder export'ları + model-strength-report.ts + `types.escalation_rungs`) sonraki temizlik commit'inde. 1259 test yeşil.

- **feat(devs/ Faz 5: SORU modu — salt-okunur danışma; composer toggle, pipeline TETİKLENMEZ):**
  Composer'a "Soru modu" toggle'ı (oto-cevap deseni: localStorage + checkbox, [ChatPanel.tsx](src/components/ChatPanel.tsx) `data-testid=question-mode-toggle`). Açıkken kullanıcı bir İŞ değil, geçmiş çalışmadan DERS/bilgi sorar → MyCL `devs/` (iter-spec/page-spec) + `.mycl` + kodu OKUYUP Türkçe cevaplar. **Mimari ():** mesaj `user_message` yerine yeni `ask_question` IPC'sinden gider ([events.ts](src/types/events.ts) + [App.tsx](src/App.tsx) `sendUserMessage` dallanır) → ayrı `handleAskQuestion` ([index.ts](orchestrator/src/index.ts)); `user_message` akışı HİÇ değişmez (regresyon yok). Handler `respondAsOrchestrator(..., {questionMode:true})` çağırır — **mevcut orkestratör backend-seam'i yeniden kullanılır → API/CLI/Auto + no-silent-fallback BEDAVA gelir** (feedback_api_support). Orkestratör salt-okunur (Read/Grep/Bash, Write yok), zaten Türkçe (çevirmen gereksiz), main'e (codegen) gitmez. **Pipeline KESİN tetiklenmez (çift-katman):** (1) `questionMode` system-prompt talimatı `action='chat'`'e yönlendirir ([agent.ts](orchestrator/src/orchestrator-agent/agent.ts) `QUESTION_MODE_INSTRUCTION`, CLI+SDK pariteli via cli-orchestrator/respond threading); (2) handler `message_to_user`'ı basar ama `executeAgentDecision`'ı ÇAĞIRMAZ → LLM yanlış action seçse bile faz/iş başlamaz. composer placeholder + toggle title kullanıcıyı bilgilendirir. Doğrulama bütün-double-check canlı e2e'de (özellik entegrasyon-doğası; saf-mantık yok). 1259 test yeşil.

- **feat(devs/ Faz 4b: iterasyon-SONU spec tazeleme — kök GENEL spec + per-birim page-spec.md):**
  Yeni [devs-spec-refresh.ts](orchestrator/src/devs-spec-refresh.ts) `refreshDevsSpecs(state, config, outcome)` pipeline-end'de `finalizeDevsArtifacts`'tan SONRA FAIL-SOFT çağrılır ([index.ts](orchestrator/src/index.ts)). **İKİ seviye spec tazelenir:** **(1) kök `.mycl/spec.md`** = projenin GENEL spec'i (, detaysız, `## <yetenek>` başlıklı, AC YOK). Faz 2'den beri per-iter spec `_pending`'e yazıldığı için kök spec **bayatlıyordu** → bu onu canlı tutmanın eksik parçası (EXISTING_SPEC_DIGEST çakışma-kontrolü + relevance recall okur; genel anlatım yapısal AC listesinden daha iyi, extractSpecChunks `## Heading` böler→uyumlu, phase-9 `## Risks` artık per-iter okur→etkilenmez). **(2) `devs/<type>/<key>/page-spec.md`** = per-birim KÜMÜLATİF spec ("o sayfanın ne yaptığını iyi anlatır", tüm iterasyonların birikimi). **Desen = living-docs** (orkestratör rolü, salt-okunur Read/Grep/Glob, tek `{"kind":"specs",root_spec_md,page_specs[]}` bloğu döner, YAZIMI MyCL yapar, API modu görünür-not+no-op). `finalizeDevsArtifacts` artık `FinalizeOutcome` döndürür (`units{type,key,dir}` + `iterSpecPath` + `directDir`) → refresh bunu tüketir; dokunulan birim listesinde olmayan page-spec elenir (uydurma birim). Yeni [devs-spec-refresh.md](assets/templates/devs-spec-refresh.md) template (`assets/templates/**/*` glob ile bundle'lı). 7 saf test (prompt-build + parse: root-zorunlu + uydurma-birim-ele + boş-ele) + finalize outcome assert'leri. page-spec geçmiş iter-spec'leri Glob'lar (kümülatif). 1259 test yeşil.

- **feat(devs/ Faz 4a: iterasyon-SONU — _pending/<ts>/ artefaktları iş-birimi klasörlerine böl):**
  Yeni [devs-finalize.ts](orchestrator/src/devs-finalize.ts) `finalizeDevsArtifacts(state)` pipeline-end'de FAIL-SOFT çağrılır ([index.ts](orchestrator/src/index.ts), `updateLivingDocs`'tan sonra — throw pipeline'ı KIRMAZ). Akış: `_pending/<ts>/iter-spec.md`'yi oku → `computeChangedScope` (git yoksa audit write-event'lerinden) → deterministik `resolveUnits` (Faz 1 resolver). **Çoklu-birim = içerik-değil-konum bölme:** iter-spec'in TAM metni **birincil birime** (en çok dosya değişen) `devs/<type>/<key>/<ts>/iter-spec.md`; ikincil birimler `meta.json` + `spec_ref` ile birincile işaret eder (KOPYA YOK, ). Gerçek birim yoksa (saf altyapı) `devs/<ts>/` doğrudan (). `_shared/<ts>/pages.json` = sayfaya bağlanamayan değişiklikler + o iterasyonda dokunulan TÜM birimlere link ("nereler ile ortak"). Her birim `meta.json`: ts/intent/unit/files/all_units. Taşıma sonrası `_pending/<ts>/` temizlenir. iter-spec yoksa / `iteration_started_at` yoksa sessiz no-op. 4 entegrasyon testi (gerçek resolver+scope+audit fixture: çok-birim spec_ref + birim-yok-direkt + spec-yok-noop + ts-yok-noop). page-spec.md zenginleştirme + kök genel-spec tazeleme → Faz 4b. 1256 test yeşil.

- **feat(devs/ Faz 2+3: spec PER-İTERASYON — codegen kök yerine devs/_pending/<ts>/iter-spec.md):**
  **Faz 2 WRITE:** Faz 4 spec'i kök `.mycl/spec.md` yerine `devs/_pending/<ts>/iter-spec.md`'ye yazar — `withDevsPath` TEK choke-point ([devs-paths.ts](orchestrator/src/devs-paths.ts) + [phase-4.ts](orchestrator/src/phase-4.ts)); ikiz SDK+CLI yazıcı paritesi **yapısal garanti** (birini değiştirip ötekini unutmak imkansız). **Faz 3 READ:** codegen spec-okuyucuları `currentSpecPath(state)` ile per-iter okur — phase-8 (stat-guard/AC-count/AC-ids/agent-prompt), phase-5 (UI+design), phase-9 (Risks via getSpecSectionMarkdown→extractSpecChunks +specPath param), adversarial-test, index (faz-seçim/NFR-extractSpecSection +specPath param/manual-guard). + codegen **TEMPLATE'leri** (08-tdd/07-db/05-ui) hardcoded `.mycl/spec.md` → `{{SPEC_PATH}}` (currentSpecRelPath substitution). KÖK okuyucular (Faz 2 EXISTING_SPEC_DIGEST, relevance recall, phase-1 probe, phase-0 debug, precision-existing) `.mycl/spec.md`'de KALIR (çapraz-iter hafıza). brief/db `.mycl`'de kalır (relevance brief okur). **CANLI E2E (gerçek pipeline survey iterasyonu):** spec `devs/_pending/2026-06-16-16-17-33/iter-spec.md`'ye yazıldı (kök yazılMADI, UNIT-A=0 sızıntı yok), Faz 5 doğru atlandı (faz-seçim okudu), Faz 8 spec-missing düşmeden AC'leri okudu. + 4 birim test (path mantığı). 1248 test yeşil.

- **feat(devs/ Faz 1: route-resolver — dosya→birim fallback zinciri, deterministik):**
  Yeni [route-resolver.ts](orchestrator/src/fix/route-resolver.ts): değişen dosya → iş-birimi DETERMİNİSTİK eşleme (LLM YOK), fallback zinciri **sayfa → endpoint → tablo → shared** (). Sayfa ekseni App.jsx-benzeri route config parse (import-map × `<Route path→component>`, minimal regex) → URL slug; route-dışı sayfa → dosya-adı slug; paylaşılan frontend dosyası → MEVCUT dep-graph `getAffected` ile onu kullanan sayfalara. Endpoint = `/routes/<ad>`; tablo = migration `CREATE TABLE` / `*Store`; hiçbiri (altyapı) → `_shared`. Frontend kökü `^src/` çapalı (backend/src/ karışmaz). Salt-okuma, henüz pipeline'a bağlı DEĞİL (Faz 4'te tüketilir). 9 birim test (gerçek-yapı fixture: route-map + dosya-adı + endpoint + tablo + shared + dep-graph paylaşılan→sayfa + çok-birim ayrışma). 1244 test yeşil.

- **feat(devs/ per-iterasyon yapı — Faz 0: temel, davranış değişmez):**
  YZLLM'in tasarımı: her iterasyonun çıktısı (spec/değişiklik/ilerleme + LLM akışı) projede `devs/<birim>/<ts>/` altında yaşar — birim = **sayfa (`devs/pages/`) → endpoint (`devs/endpoints/`) → tablo (`devs/tables/`) → `devs/<ts>` fallback zinciri** (çözümsüz kalmaz). 3-seviye spec: kök `.mycl/spec.md` genel proje / `devs/pages/<sayfa>/page-spec.md` per-sayfa / `<ts>/iter-spec.md` per-iterasyon → spec karışması **yapısal olarak imkansız** + zengin geçmiş + salt-okunur "SORU" modu. 6-ajan entegrasyon analizi → 6-fazlı plan. **Faz 0:** yeni [devs-paths.ts](orchestrator/src/devs-paths.ts) (`formatIterationTs` YYYY-MM-DD-HH-MM-SS + `deriveDevsPaths` + `ensurePendingIterationDir`); [index.ts](orchestrator/src/index.ts) Faz 1 girişinde `iteration_started_at` TEK-KAYNAK garantisi (ilk-ever iterasyon dahil) + `devs/_pending/<ts>/` iskeleti (fail-soft, pipeline kırmaz). 4 birim test (TZ-bağımsız format + deterministik + yollar). 1235 test yeşil.

- **fix(spec-sızıntısı: her spec KENDİNE ÖZEL — eski INCREMENTAL/merge modu kaldırıldı):**
  Canlı survey testinde yakalandı: yeni "anket çift-oy" işinin Faz 4 spec'i 2 ALAKASIZ birim içerdi — UNIT A (eski user-list araştırması) + UNIT B (survey) — oysa Faz 1 niyeti VE Faz 2 enriched_summary'si TERTEMİZ survey'di. Kök neden Faz 4'ün **"INCREMENTAL SPEC" modu** ([phase-4.ts](orchestrator/src/phase-4.ts), v15.9 "spec biriktirilsin"): mevcut `spec.md`'yi okuyup "PRESERVE + FULL merged spec üret" diyordu → alakasız önceki işi diriltti → 7 AC / 2 birim → Faz 8 UNIT A'da boğuldu → **"AC coverage 0/3 + tam-suite KIRMIZI" YANLIŞ-POZİTİF gate fail** (oysa survey fix'i izole 4/4 yeşildi, 16 suite-fail tamamen önceden-vardı). Düzeltme: incremental/merge bloğu KALDIRILDI; Faz 4 artık yalnız BU iterasyonun niyetini kapsayan **standalone** spec yazıyor ("do NOT carry forward/merge prior scope/ACs/risks — each spec is self-contained"). Çakışma kontrolü Faz 2'de `EXISTING_SPEC_DIGEST` ile zaten AYRI yapılıyor (etkilenmez). Kullanılmayan `join` import'u silindi. 1231 test yeşil.

- **perf(Faz 4 lens koşullu + Faz 2 scope-soru guard — kaliteyi DÜŞÜRMEDEN):**
  6-ajan analiz + düşman-kalite-kapısı, cazip kesintileri REDDETTİ (lens'i ucuz-tier'a indirmek + Faz 2 batch kaliteyi bozardı; ayrıca Faz 2 digest'leri ZATEN `Promise.all` paralel — 2026-06-12 optimizasyonu — ve cold-start hipotezi ölçümle doğrulanmadı). Kalan 2 güvenli kaldıraç uygulandı: **(1)** Faz 4 blindspot merceği (~80-110s) artık `specIsConsequential(spec)` ile KOŞULLU ([pre-commit-lens-gate.ts](orchestrator/src/pre-commit-lens-gate.ts)) — DEFAULT koşar; yalnız AÇIKÇA önemsiz spec'te (≤3 AC **VE** güvenlik/veri/yetki/şema/eşzamanlılık/yıkıcı imzası YOK) atlanır → basit fix'lerde ~80-110s kazanç, riskli/karmaşık spec'lerde mercek HER ZAMAN koşar (kuşkuda dahil et). Saf fonksiyon lens-gate modülüne kondu (tek sorumluluk) + 7 birim test davranışı kilitledi. **(2)** Faz 2 ([phase-02-precision.md](assets/templates/phase-02-precision.md)): fix `unambiguous` + güvenli default belliyken `ask_clarifying` ile tur harcama — default'u görünür varsayım yap; gerçek belirsizlikte yine sor. 1231 test yeşil.

- **refactor(MyCL hata-kataloğu DB adı: `errors.db` → `mycl_errors.db`):**
  MyCL'in HER projeye enjekte ettiği hata-kataloğu DB'si artık `error_folder/mycl_errors.db` — net MyCL-isimli, uygulamanın olası kendi `errors.db`'siyle karışmaz. Dün eklenen "errors.db SADECE hata kataloğu" izolasyon kuralının tamamlayıcısı: ayrı isim + ayrı dosya. Rename TUTARLI yapıldı (yarım rename = MyCL bir dosyaya yazıp başkasından okur → sessiz kopukluk): merkezi sabit `errors-db.ts DB_NAME` + tüm hardcoded yollar (phase-5 / smoke-test / index / runtime-http-server / command handler) + 6 şablon (spec / ui / db / tdd / debug / scan'daki sqlite3 sorguları dahil) + test fixture'ları. `error_folder/` klasör adı ve `errors` tablo adı AYNI kaldı (yalnız `.db` dosya adı değişti). Adminpanel'in mevcut `errors.db`'si migration'a kadar durur; MyCL yeni boş `mycl_errors.db` açar.

## 2026-06-15

- **fix(spec: errors.db SADECE hata kataloğu — app verisi ayrı DB'de):**
  Kullanıcı-listesi araştırmasında ortaya çıktı: adminpanel'in `error_folder/errors.db`'si `errors` + `users` + `surveys` + `survey_responses` + `survey_answers` HEPSİNİ tutuyor — yani MyCL'in hata kataloğu uygulamanın iş-verisiyle KİRLENMİŞ. Kök neden: önceki user-persist iterasyonunun spec'i "tek errors.db dosyasını PAYLAŞ (AC1/AC6)" demiş. Düzeltme (phase-04-spec.md): HARD kural — `errors.db` MyCL hata kataloğuna AYRILMIŞ izole bir DB'dir, yalnız `errors` tablosunu tutar; uygulamanın kendi verisi (users/surveys/iş-varlıkları) ASLA errors.db'ye konmaz, kendi app-DB'sinde (app.db vb.) yaşar; iki DB ayrı dosya, paylaşmak yasak. (Adminpanel'in mevcut karışık DB'si ayrı bir migration işi.)

- **fix(Faz 5: "kod zaten spec'i karşılıyor" → temiz tamamla, sonsuz loop yerine):**
  Zaten çözülmüş bir bug (YouTube binding — önceki iterasyon düzeltmiş) tekrar gönderilince: codegen ajanı kodu okudu, doğru olduğunu görüp YAZMADI (prompt'taki "no change needed, move on" gereği) → ama phase-5.ts NORMAL mode'da "no ui-file-write" → düz `return "fail"` → SONSUZ retry loop (kod doğru olduğu için her tur aynı: yazma→fail→tekrar; escalatable=false bile yoktu). Çözüm: ajan DOĞAL bittiyse (outcome="done", fail/abort değil) + hiç write yoksa = kod zaten spec'i karşılıyor → fazı TEMİZ tamamla (phase-5-no-change-needed audit + dev-server + phase-5-complete'e fall-through). Ajan gerçekten üretemediyse downstream (Faz 6 görsel-inceleme + Faz 8 testler + 10-17 gate'ler) yakalar → fail-safe. + phase-05-ui.md: "spec zaten TAM karşılanıyorsa hiç yazma, zorlama". 1224 test yeşil.

- **feat(Faz 6 bileşik mesaj: onay + yeni-iş AYNI mesajda — ikisi de ele alınır):**
  Kullanıcı UI incelemesi (Faz 6 park) sırasında HEM mevcut işi onaylayıp HEM yeni/farklı bir iş bildirebilir ("Tamam bu çözülmüş. Ama başka sorun var: …"). Orkestratör TEK action verdiği için onay kayboluyordu: develop_new_or_iter seçip yeni-işi kuyruğa ekliyor ama mevcut işi onaylamıyordu → iş Faz 6'da takılı kalıyordu (canlı testte yakalandı). Çözüm: karar şemasına `phase6_approval` ("approve"/"reask") eklendi (decision.ts + decide_action input_schema + parse). Orkestratör prompt'u Faz 6'da develop_new_or_iter seçince bu alanı set ediyor: NET onay varsa "approve", yoksa "reask". index.ts develop handler'ı current_phase=6'da: yeni-iş(ler)i kuyruğa ekler + "approve" → mevcut işi onaylayıp Faz 7'e geçer (yeni iş bitince sırayla) / "reask" → UI incelemesi kararını tekrar sorar. Böylece onay da yeni iş de kaybolmaz; kararsızsa kullanıcıya sorar. 1224 test yeşil.

- **fix(intake semantik dedup: "zaten kuyruktaysa ekleme"):**
  Kelime-örtüşme (Jaccard 0.7) PARAFRAZ duplikesini kaçırıyordu — canlı testte aynı kullanıcı-listesi bug'ı iki farklı cümleyle yazılınca İŞ 2 + İŞ 3 olarak İKİ KEZ eklendi (Jaccard ~0.5 < 0.7). Çözüm: split LLM'e artık kuyrukta BEKLEYEN işler veriliyor; çıkardığı bir iş bekleyen biriyle ANLAMCA aynıysa (farklı kelimelerle olsa bile) `already_queued:true` işaretliyor → intake onu EKLEMİYOR. Kelime-örtüşme backstop olarak kalıyor. Ek: salt onay/gözlem mesajı ("tamam", "çözülmüş görünüyor") → boş `tasks:[]` (onay metnini iş yapmaz); parseSplitBlock boş-geçerli ([]) ile parse-hatasını (null) ayırıyor → ham-metin duplicate'i üremez. 1224 test yeşil.

- **fix(dev-server self-heal: Vite runtime-error plugin'i dev-server'dan ÖNCE garantile):**
  Faz 6 zorunlu olunca Faz 5 ATLANAN işlerde (mantık/wiring fix) bir regresyon çıktı: `ensureViteRuntimeInjection` (`.mycl/runtime-error-plugin.cjs`'i üreten) YALNIZ Faz 5'te çağrılıyordu; Faz 5 atlanınca plugin üretilmiyor ama proje `vite.config.js` onu import ettiği için Faz 6'da dev-server `Could not resolve ./.mycl/runtime-error-plugin.cjs` ile crash ediyordu (canlı testte yakalandı; .mycl temizliği de aynı sonucu verir). Çözüm: `restartDevServerSimple` + `restartDevServerForPhase7` artık her dev-server başlatmadan ÖNCE `ensureViteRuntimeInjection`'ı (idempotent) çağırıyor → Faz-5-atlama / fresh-clone / .mycl-temizliği hepsinde plugin kendini onarır. Plugin asset bundle'da (assets/scripts/mycl-runtime-error-plugin.cjs). 1223 test yeşil.

- **fix(spec kapsam-şişmesi: alakasız scope ÖNCEDEN kesildi):**
  KÖK NEDEN (LLM halüsinasyonu DEĞİL, template zorluyordu): phase-04-spec.md error-catalog'u (6 AC: errors.db/şema/middleware/error-boundary/hata-kodlari-sayfası/gitignore) + perf-bütçesini + dev-script'leri HER spec'e ZORUNLU kılıyordu — proje zaten içerse bile. Tek-satır bug-fix bile 8+ alakasız AC alıp Faz 8'in çözemediği şişmiş spec'e dönüşüyordu (eskalasyon tüketiyordu). Üçü de KOŞULLU yapıldı: yalnız ilk-kurulum/eksikse; mevcut projede zaten varsa "DONE, bu işin kapsamı dışı" → tekrar dayatılmaz. Ek: Faz 2 (8-boyut zenginleştirme) + Faz 4'e sıkı kapsam-disiplini ("enriched_summary/AC niyete ORANTILI; kullanıcının anmadığı tablo/sayfa/middleware/bütçe ekleme → out-of-scope"). 1223 test yeşil.

- **feat(STRIDE tehdit-modeli — Faz 9 risk incelemesine 7. eksen):**
  gstack incelemesinden esinli. STRIDE akıl-yürütme-tabanlı olduğu için mekanik Faz 13 (semgrep/gitleaks) yerine akıl-yürütme-tabanlı Faz 9'a (risk incelemesi, bulan→çürüten→oto-fix) eklendi. Faz 9 debate review'a 7. eksen: yapısal STRIDE bulucu — DEĞİŞEN her endpoint/veri-akışı/yetki-sınırı için 6 kategoriyi (Spoofing/Tampering/Repudiation/Information disclosure/DoS/Elevation of privilege) SİSTEMATİK yürür, yalnız AZALTILMAMIŞ tehditleri bulgu yapar (hafif — iterasyonun saldırı yüzeyi, akademik tam-model değil). Mevcut bul→çürüt→fix-dispatch altyapısını kullanır (ekstra altyapı yok). CLI debate (DEBATE_AXES 7 eksen) + API tek-ajan (phase-09-risk.md 7 eksen) — iki yolda da. phase-9.ts mesajı dinamik (DEBATE_AXES.length). 1223 test yeşil.

- **feat(Faz 6 UI incelemesi ARTIK ZORUNLU — asla atlanmaz):**
  Önceden Faz 6 (UI inceleme) opsiyonel kümedeydi {5,6,7}; backend/mantık işinde needed_phases'e girmeyince "Faz 6 atlandı — gerekli değil" deyip es geçiyordu. `isPhaseSkippedByScope`'tan Faz 6 çıkarıldı (yalnız 5/UI-üretimi ve 7/DB opsiyonel kaldı). Artık her iterasyonda Faz 6 koşar → phase-6.ts mevcut dev-server'ı garantiler (yoksa restartDevServerSimple) + tarayıcıyı açar + deferred park eder → kullanıcı UI'yi inceleyip approve_ui/revise_ui ile yön verir. Headless test harness'ı Faz 6 park'ını approve_ui simülasyonuyla (pending_ui_review→phase-6-complete + advance(6)) sürecek şekilde güncellendi. 1223 test yeşil.

- **fix(oto-cevap onay-boşluğu: TÜM backend'lerde onay-askq'leri otomatik yanıtlanır):**
  Canlı testte oto-cevap AÇIK olmasına rağmen Faz 3 brief / Faz 4 spec / Faz 7 DB onayları + faz-kapsam askq'si yanıtlanmadı → pipeline 47 dk takıldı. KÖK NEDEN: FIX-5 yalnız qa-askq backend'lerini (Faz 1/2 netleştirmeleri) yamamıştı; production-schema (Faz 3/4/7), codegen (Faz 8) ve faz-kapsam (index.ts doğrudan emit) AYRI emit yollarından çıkıyor ve `autoAnswerSuggested()` OKUMUYORDU. Çözüm: auto-answer.ts'e ortak saf yardımcı `autoAnswerPick(options_tr, suggested?)` eklendi; tüm yollar emitAskq'den ÖNCE çağırır → açıksa askq UI'a hiç gösterilmeden ilk/önerilen seçenekle auto-resolve. Düzeltilen yollar: production-schema-cli-backend (askOnce+askApproval), production-schema-controller (SDK paritesi), codegen-controller (askUser), index.ts faz-kapsam. Faz 6 görsel-incelemesi AYRIK (deferred) → kullanıcı sürer. Hata-kurtarma (error-analysis) + eskalasyon zaten autoResolve'da otomatik. 1223 test yeşil.

- **fix(kuyruk izolasyon + dedup: canlı test #2 + 14-ajan düşman-denetim bulguları):**
  Canlı 2-bug testi + arka plan düşman-denetim iki gerçek MyCL-bug'ı ortaya çıkardı, ikisi de "2 iş birbirine karışmasın" hedefini bozuyordu:
  - **İzolasyon sızıntısı (canlı, kritik):** FIX-4 yalnız Faz 1'i izole etmişti; Faz 2 hassasiyet-denetimi konuşma geçmişinden orijinal çok-bug'lı mesajı okuyup "bu yineleme hangi kapsam? → her iki hata da" sorusunu sorup işi BİRLEŞTİRİYORDU (phase-2/3/4/7/9 hepsi buildConversationContext çağırıyor). Çözüm: State'e `iteration_isolated` bayrağı; runDevelopIteration true yapar, buildConversationContext görünce BOŞ döner → tüm fazlar tek noktadan uyar. handleUserMessage temizler (orkestratör kararı geçmişi görmeli); restartPhase1WithIntent kalıcı bayrağa güvenir (resume edilen kuyruk-işi izole kalır).
  - **Dedup yanlış-pozitifi (denetim YÜKSEK):** intake mükerrer-elemesi örtüşme-katsayısı (payda Math.min) kullanıyordu → kısa metin uzun metnin alt-kümesiyse ~1.0 verip GERÇEKTEN-AYRI kısa işi sessizce siliyordu ("Sipariş oluşturma 500" vs "Sipariş güncelleme 500" → 0.80 silinir). Jaccard (birleşim paydası) + eşik 0.6→0.7'ye çekildi (denetimin tüm yanlış-pozitifleri ≤0.667); düşen iş metni artık "ℹ️" notunda gösteriliyor.
  - **fix5 bayat yorum:** auto-answer.ts başlığı "onaylar yine kullanıcıya sorulur" diyordu (artık oto-yanıtlanıyor) — güncellendi.
  - **fix3 Faz 6 yönlendirme (denetim 2×ORTA):** (a) backend-kökenli kusur revise_ui→Faz 5'e gidince (backend yolları yasak) sessiz no-op oluyordu → kural: salt-görsel→revise_ui, işlevsel/backend-kökenli→develop_new_or_iter (tam kapsam); (b) yeni-ilgisiz-bug "özellik değil" diye revise'a yutulup intake-dedup'ı baypas ediyordu → ayraç: aynı sayfa→revize, farklı alan→develop_new_or_iter.
  1223 test yeşil.

- **fix(env-uyum: deny-list'ten "MultiEdit" kaldırıldı — güncel Claude Code CLI tanımıyor):**
  Güncel claude CLI "MultiEdit"i araç olarak tanımıyor → disallowedTools'ta geçince `Permission deny rule "MultiEdit" matches no known tool` hatası verip TÜM salt-okunur çağrıları (intake-split, çevirmen, living-docs, orkestratör) çökertiyordu (canlı testte Faz 1 + intake bölme çöktü). WRITE_TOOLS (tool-policy.ts) + cli-orchestrator + production-schema-cli-backend deny-listelerinden çıkarıldı. Edit/Write zaten yasaklı; MultiEdit onların varyantıydı. 1 test güncellendi. 1223 test yeşil.

- **fix(iş-listesi modeli: 5 açık — izolasyon / mükerrer / kısa-açıklama / Faz-6-revize / oto-onay):**
  Canlı test, hızlı kurulan iş-listesi modelinin açıklarını gösterdi; hepsi düzeltildi:
  - **İzolasyon:** Faz 1 kuyruk-işi işlerken KONUŞMA GEÇMİŞİNİ katmıyor (`PhaseDeps.isolatedIntent`; phase-1 convSection atlanır) + prompt "tek işe odaklan, öteki işi katma" → iki hatayı tek niyette birleştirmiyor.
  - **Mükerrer önleme:** intake yeni işi kuyruktaki bekleyen işlerle karşılaştırır (kelime-örtüşme katsayısı > 0.6) → aynı işi yeniden eklemez.
  - **Kısa açıklama:** intake iş metni EN FAZLA 2 cümle (uzun paragraf yasak).
  - **Faz 6 revize:** Faz 6 incelemesi sırasında bug raporu → `revise_ui` (incelenen işin revizyonu), `develop_new_or_iter` DEĞİL → mükerrer iş açmaz (orchestrator-system.md §5).
  - **Oto-cevap onayları da yanıtlar:** oto-cevap açıkken Faz 1-4 onayları otomatik geçer (önceden yalnız netleştirme; onaylar askıda kalıp "stall" görünüyordu). Faz 6 ayrı (deferred, bu backend'den geçmez → kullanıcı sürer). qa-askq controller + cli-backend; 2 test güncellendi. 1223 test yeşil.

- **change(üst barda o anki İŞ + iş başında niyet emit):**
  Header'a `currentJob` (proje yolu ile faz göstergesi arasında "🔧 <iş>") eklendi; App `mainState.iterationIntent` geçer. Backend: `startNextPendingTask` iş başlarken `emitIterationIntent(next.text)` çağırır — "İş" kutusu + üst bar artık işlenmeye BAŞLAR başlamaz dolu (eskiden yalnız Faz 1 sonunda doluyordu). 1223 test yeşil.

- **change(UI: Kılavuz butonu → Proje Dökümanı):**
  Kullanım kılavuzu artık projenin İÇİNDE (Faz 17 in-app kılavuz sayfaları) → MyCL'deki 📖 Kılavuz butonu kaldırıldı. Yerine 📄 Proje Dökümanı butonu: tıklayınca `.mycl/tech-doc.md`'yi gösterir (tech_doc event; açılışta + Faz 17'de emit; GuideModal yeniden kullanıldı, başlık "Proje Dökümanı"). Frontend: userGuide→projectDoc, user_guide→tech_doc handler, onGuideClick→onDocClick, intent-guide→intent-doc. Backend: açılış-emit user-guide.md→tech-doc.md; TECH_DOC_INSTRUCTION "her konuyu KISA ve ÖZ" (kapsam tam, anlatım kısa). 1223 test yeşil.

- **fix(iş-listesi tek sürücü: boot-resume çakışmasını gider):** İş-listesi-güdümlü modelde boot-resume (`detectInterruptedPhase1/2To9`) bekleyen iş-listesini görmezden gelip eski niyeti işliyor + kuyruk aynı işi TEKRAR işliyordu (duplicate). Fix: boot-resume artık bekleyen iş (pending/running) varsa DEVREYE GİRMEZ — kuyruk (kickWorkQueue) Faz 1'den tek sürücü. Boot orphan "running" → "dropped" yerine "pending" (yeniden-kuyruğa; terminal fail'i drain-içi reconcile "dropped" damgalar → sonsuz-retry yok). 1223 test yeşil.

- **change(iş-listesi-güdümlü model: "niyet" → "iş", tüm işler sıra sıra otomatik pipeline):**
  MyCL artık iş-listesini (İş Kuyruğu) kendiliğinden boşalan SIRALI kuyruk olarak kullanır: işler (manuel "İş Ekle" VEYA çok-problem intake — kaynak ayrımı YOK) öncelik sırasıyla TEK TEK Faz 1→17 pipeline'dan otomatik geçer. Değişen: (1) ChatPanel "Niyet" etiketi → "İş" (o anda işlenen iş). (2) Sürücü `nextAutoPendingTask` → `nextPendingTask` (kaynaktan bağımsız tüm bekleyen işler işlenir). (3) `kickWorkQueue` tetikleyicisi: İş Ekle (handleTaskQueueAdd) + proje açılışında bekleyen iş varsa (emitInitialTaskQueue) iş-listesi kullanıcı mesaj göndermeden işlenmeye başlar. (4) UI: "Uygula" kaldırıldı (her iş zaten oto-işlenir; duplicate-tetik riski de gider), bekleyen işler "⏳ Sırada" gösterir. Aktif olması için orkestratör restart. 1223 test yeşil.

## 2026-06-14

- **change(routing: kullanıcının yazdığı HER yeni iş Faz 1'den başlar — bug dahil; debug_triage iç-araç):**
  Önceki kural (orchestrator-system.md, YZLLM 2026-06-10) Faz 1'den yeniden başlamayı "boşa iş + bağlam kaybı" sayıyor ve kullanıcı bug'ını `debug_triage` (Faz 0) ile çözüyordu. Yeni direktif bunun tersi: **yeni iş girişi her zaman Faz 1** (erken fazlar gürültüyü temizler). ÇELİŞKİ ÇÖZÜMÜ — ayrım iş-kimliği üzerinden: (a) kullanıcının YENİ açtığı iş (yeni özellik VE bug) → `develop_new_or_iter` (Faz 1); (b) zaten mid-flight (anlaşılmış, fazlar 1..N-1 bitmiş) bir işe "devam et" → RESUME (Faz 1'den yeniden başlatma YOK — onu yeniden anlamak gerçek boşa iş). `debug_triage` (Faz 0) artık YALNIZ pipeline-içi gate-hatası iç-takibi; kullanıcı talebi buraya yönlenmez. Değişen: `orchestrator-system.md` (satır 40 + RESUME-vs-NEW bloğu), `decision.ts` decide_action şema tarifi. Aktif olması için orkestratör süreci restart gerekir (dev: orchestrator/dist; .app: tauri build).

- **feat(iş-kuyruğu temeli: önceliklendirilmiş yaşam-döngüsü):**
  `TaskQueueItem` genişledi: `priority` (1=en yüksek), `status` (pending/running/done/dropped), `completed_at`, `source` (manual/auto). Append-only store'a `patchTask` (tombstone ikizi — id başına en son patch merge) + `nextPendingTask` (öncelik sonra FIFO) + `taskStatus` eklendi; `readTasks` opsiyonel alanları geriye-uyumlu okur. 6 yeni test. (intake-split + drain-loop + UI sonraki commit'lerde.)

- **feat(iş-kuyruğu: intake bölme + öncelikli drain + UI; + 18-bulgu sağlamlaştırma):**
  - **Intake** (`task-queue/intake.ts`): kullanıcı mesajını LLM ile ayrı işlere böl + öneme göre önceliklendir (CLI runClaudeCli / API SDK; salt-sınıflandırma; fail-soft → ham metin tek iş; boş-metin guard). source=auto/pending kuyruğa.
  - **Sürücü** (`index.ts`): `driveWorkQueue` (develop girişi) + `startNextPendingTask` (en yüksek öncelikli AUTO işi Faz 1'den) + `onTaskMaybeComplete` (pipeline-end → done+completed_at, KİLİT).
  - **Sağlam yaşam-döngüsü** (düşman-inceleme 18 bulgu): tamamlanma TEK yola (pipeline-end) bağlı değil — `reconcileAndDrainTasks` `advanceToNextPhase` finally'sinde (derinlik 0) ÇALIŞIR: park (aktif askq) yoksa orphan işi "dropped" (sonsuza "running"+kuyruk-kilidi yok); drain oturumu açıksa sıradakini SERİ işle (`_handlingUserMessage` yeniden alınır → kullanıcı mesajıyla yarış yok, #7/#8). failPhase/abandon/vazgeç/abort'un HEPSİ bu tek noktadan uzlaşır (#1/#2/#6/#10). Boot'ta orphan "running" → "dropped" (#3/#13). Manuel "İş Ekle" + error-analysis "Kuyruğa al" source=manual → auto-drain'e girmez; UI "Uygula" yalnız manuel (auto duplicate önlenir, #9/#14/#18).
  - **UI** (`TaskQueuePanel.tsx` + `events.ts`): durum rozeti (▶️/✅/⏳/⏹️) + öncelik + tamamlanma-zamanı + done KİLİTLİ.
  - **Routing** (`orchestrator-system.md` §6/§7.6 + örnekler): kullanıcı bug'ı dahil HER iş `develop_new_or_iter` (Faz 1); `debug_triage` yalnız iç gate-hatası takibi (#4/#5/#11).
  - **KALAN (düşük öncelik, ertelendi):** #12 multi_agent_selection yolu kuyruğu baypas eder (default-off flag); #15 park'ta "waiting" durumu; #16 tek-iş intake kısa-devresi. 1223 test yeşil.

- **fix(iş-kuyruğu sağlamlaştırma round-2: yeniden düşman-inceleme 23 bulgu):**
  İkinci çok-ajanlı inceleme (senaryo-izleme + race + regresyon + completeness) çekirdek bir KRİTİK kaçırmayı buldu + düzeltildi:
  - **KRİTİK** — Faz 6 (UI-incelemesi) DEFERRED modda askq açmaz + flag set etmez → `isPipelineParked()` göremiyordu → her UI'lı kuyruk işi kullanıcı onaylamadan "dropped" damgalanıyordu. Fix: `isPipelineParked` artık `current_phase===6`'yı da park sayar (#1).
  - **YÜKSEK** — drain-loop'ta Faz-1 terminal hatası (env/API) currentTaskId'i temizlemez + reconcile tetiklemezdi → kuyruk kilidi. Fix: `reconcileAndDrainTasks` BİRLEŞİK döngü — her turda orphan uzlaştır (park değilse "dropped"+devam, parktaysa dur) + sıradakini başlat; `_draining` await'lerden ÖNCE alınır (#2/#3).
  - **YÜKSEK** — parkta/çalışan iş varken yeni develop isteği `currentTaskId`'i ezip parked işi orphan ediyordu. Fix: `driveWorkQueue` canlı iş varsa YALNIZ kuyruğa ekler (başlatmaz); `startNextPendingTask` canlı `currentTaskId`'i ezmez (#4/#8/#9/#10).
  - **ROUTING** — orchestrator-system.md'de kalan ~7 debug_triage user-entry yolu (§10.2/10.3/§11/§11.1-3/Example 3) tümü `develop_new_or_iter` (Faz 1)'e hizalandı (#5/#6/#7/#13/#14/#15/#20).
  - **intake** sessiz fallback → görünür hata (bölme başarısızsa not + ham talebi tek iş; feedback_no_silent_fallback) (#16).
  - Faz 2 abandon / user-abort → reconcile orphan-drop ile "dropped" (otomatik). KALAN düşük/pre-existing: #11 askq eşzamanlılığı (mevcut), #12 multi-agent baypas, #18 recursion, #19 boot-resume rebind, #21/#22. 1223 test yeşil.

- **fix(iş-kuyruğu round-3: yakınsama-kontrolü — round-2 regresyonu düzeltildi):**
  Üçüncü inceleme round-2'nin SOKTUĞU bir regresyonu buldu: `isPipelineParked()`'taki `current_phase===6` heuristiği, Faz 6 controller'ı (deferred-dönüş yerine) THROW ederse de "park" sanıp kuyruk işini sonsuza kilitliyordu (Faz 7/8 ile asimetrik). KÖK ÇÖZÜM: heuristik yerine gerçek `pending_ui_review` State bayrağı — Faz 6 BAŞARIYLA deferred dönünce set+persist edilir; controller ÇÖKERSE set EDİLMEZ → orphan-drop devreye girer (simetrik). Faz 6 dispatch artık try/catch'li (çökme → görünür emitError + failPhase, sessiz kilit yok). Bayrak approve_ui/revise_ui/cancel_pipeline + yeni-iterasyon reset'inde temizlenir. Ayrıca orchestrator-system.md satır 109'dan son debug_triage user-entry yolu kaldırıldı. KALAN düşük (kilit yok, kozmetik): boot-restart Faz-6-park'ta iş "dropped" görünür ama gerçekte tamamlanır (#2/#4); dropped'a "yeniden ekle" butonu (#11); cross-batch öncelik (#12). 1223 test yeşil.

- **fix(iş-kuyruğu round-4: son iki kilit yolu — yapısal):**
  Dördüncü tur, round-3'ün açtığı bir kilit + bir pre-existing kilit buldu (ikisi de YÜKSEK):
  - **#1/#3/#5 (round-3 regresyonu):** `run_phase`/`resume_pipeline`/`restartPhase1WithIntent` Faz-6-parkından pipeline'ı ilerletince `pending_ui_review` temizlenmiyordu → bayat bayrak → sonraki faz fail'inde isPipelineParked yanlış-true → orphan-drop bloklanır → kalıcı kuyruk kilidi. YAPISAL FIX: `advanceToNextPhase` GİRİŞİNDE bayrağı temizle (tüm ileri-giden yollar buradan geçer — tek nokta).
  - **#2 (pre-existing):** askq cevabı parkı pipeline'ı İLERLETMEDEN çözen dallar (phase-scope "Vazgeç", hata "İş listesine kaydet") reconcile'ı tetiklemiyordu (advanceToNextPhase finally çalışmaz + handleAskqAnswer handleUserMessage'dan geçmez) → orphan + kuyruk durur. FIX: `askq_answer` IPC handler'ı handleAskqAnswer SONRASI reconcileAndDrainTasks çağırır (guard'lı).
  - Yakınsama: round-4 yalnızca bu iki kiliti + düşük/kozmetik (#4/#6/#8 boot-restart, chat-edge) buldu; round-3 pending_ui_review fix'i DOĞRU+TAM onaylandı (#7). 1223 test yeşil.

- **fix(iş-kuyruğu round-5: YAKINSAMA — kilit yolu kalmadı + 2 trivial temizlik):**
  Beşinci tur YAKINSAMAYI ONAYLADI: **0 yüksek/kritik**; "kalıcı kuyruk-kilidi bırakan TEK yol KALMADI — üç reconcile tetikleyicisi (advanceToNextPhase finally / handleUserMessage tail / askq_answer tail) tüm park-çözüm yollarını kapsıyor". Yalnız 2 trivial düşük (round-4 entry-cleanup'tan) temizlendi: (1) `_pipelineDepth++` artık advanceToNextPhase'in İLK satırı (saveState await'i öncesi) → handleUserMessage'ın dayandığı "advance senkron" guard invariant'ı korunur; (2) entry-cleanup'a `updated_at` eklendi (bellek/disk kopya tutarlılığı). KALAN düşük/kozmetik (kilit yok): boot-restart Faz-6 kozmetik dropped, dropped re-add butonu, cross-batch öncelik, orkestrasyon-fonksiyonu integration testi. 1223 test yeşil. **İş-kuyruğu özelliği TAMAM** (5 tur düşman-inceleme; 62 bulgu işlendi, 4 kritik/yüksek kilit dahil).

- **fix(boot-resume: mid-pipeline GATE fazında (10-16) pending_ui_tweak ile parkı önle):**
  Faz 13 (Güvenlik) gibi gate fazında yarıda kalan bir projeyi açınca boot-check pipeline'ı sürdürmek yerine "sessiz
  geç" deyip PARKEDİYORDU (kullanıcının gördüğü "öylece duruyor/sessizlik"). Kök neden: boot-resume koşulu
  (index.ts) `!pending_ui_tweak` istiyordu; deep-solution fix planını pending_ui_tweak'e yazdığı için (Faz 13 vite/
  esbuild fix) resume bloklanıyor, LLM boot-check de mid-pipeline'ı "boot clean, sessiz geç" (action=chat → hiçbir
  şey yapma) diye geçiyordu. Fix: pending_ui_tweak yalnız Faz ≤9 (UI-tweak akışı) resume'unu bloklar; gate fazlarında
  (10-16) kaldığı yerden OTOMATİK devam (advanceToNextPhase → faz yeniden koşar → fix-flow tetiklenir). `detectInterruptedPhase2To9Pure` zaten 2-17 kapsıyordu + Faz 13 fail'de phase-13-complete olmadığı için interrupted döner.

- **change(Faz 13 yakınsama-kırıcı: İNSANA DEVRETME YOK — basamak yükselt + otomatik devam):** Aynı gün eklenen yakınsama-kırıcı
  (aşağıdaki girdi) bulgular azalmayınca oto-düzeltmeyi DURDURUP insana "elle düzelt" diyordu — YZLLM bunu yasakladı.
  Yeni davranış: oto-cevap açıkken Faz 13 İNSANA ASLA devretmez. Bulgular azalmıyorsa fix'i bir ÜST BASAMAĞA
  (`nextRung`) yükseltip OTOMATİK düzeltmeye DEVAM eder; tepe basamakta da otomatik fix üretilemezse OTOMATİK
  "kabul et + devam" (`OPT_ACCEPT_CONTINUE`) ile pipeline tıkanmadan ilerler — ama bulgular YUTULMAZ: loud `error`
  mesajıyla rapora yazılır (). Oto-cevap KAPALIYSA eski blocking-askq
  (kabul/yeniden-analiz — yine "elle düzelt" değil). `_securityAutoResolveCount < 3` cap kaldırıldı (güvenlik artık
  hep otomatik). Yakınsama ölçümü (security-convergence.ts) escalation tetikleyicisi olarak korundu.

- **feat(Faz sidebar ikonları: ▶️ çalışan / ✅ tamamlanan / ⏸️ yarım / ⏹️ çalışmamış):** Debug için Faz 0'a
  dönüldüğünde önceden bitmiş fazlar YEŞİL (✅) kalır (eskiden hepsi 🔘 oluyordu); yarım kalan (kesilen) faz ⏸️,
  çalışan faz ▶️ (play), henüz çalışmamış fazlar ⏹️ (stop). gate-fail ⚠️ override'ı korundu ("sessiz yeşil yalanı"
  önlemi). Frontend `maxPhase` (ulaşılan en yüksek faz) izler — debug'da (currentPhase=0) "yarım kalan" = maxPhase;
  Faz 0/debug maxPhase'i değiştirmez, yeni iterasyon (freshRun) sıfırlar. [PhaseSidebar.tsx](src/components/PhaseSidebar.tsx) + App.tsx reducer.

- **feat(Faz 13 güvenlik yakınsama-kırıcı: yakınsamayan fix-loop'u durdur):**
  Gerçek-koşu: Faz 13 güvenlik bulgularını (semgrep owasp 52 / genel 57 / secrets 53 / audit 52) oto-düzeltmeye
  çalışırken bulgular HİÇ azalmıyordu ama orkestratör fix→re-scan→fix sonsuz döngüsüne girip kotayı yakıyordu.
  Mevcut attempt-cap (`_securityAutoResolveCount < 3`) iterasyon başında sıfırlandığı için (deep-solution yeni
  iterasyon açınca) etkisizdi. Fix: deneme-sayısı yerine **BULGU-AZALMASINA** bak — yeni SAF modül
  [security-convergence.ts](orchestrator/src/security-convergence.ts) (`sumSecurityFindings` + `stepSecurityConvergence`):
  2 ardışık denemede toplam bulgu azalmazsa yakınsamıyor → oto-düzeltme DURUR, bulgular "Kabul et/devam ya da elle
  düzelt" askq'ı ile insana devredilir. Sayaç İTERASYONDAN BAĞIMSIZ kalıcı (deep-solution reset edemez); proje
  açılışında + Faz 13 çözülünce sıfırlanır. Bulgu sayısı parse edilemezse (null) güvenli: var olan attempt-cap'e
  düşer, erken-durdurma yok. 11 birim test.

## 2026-06-13

- **fix(çevirmen/kalıcı-oturum asılması: tek hung LLM çağrısı tüm pipeline'ı donduruyordu):** Canlı koşuda haiku çevirmen kalıcı-oturum turu **16+ dk
  %0 CPU asılı** kaldı; orkestratör her şeyi çevirmenden geçirdiği için tüm pipeline Faz 8'de dondu + öldürünce bile
  toparlamadı. Kök neden: `PersistentClaudeSession.send` turn-timeout timer'ı `await waitIfPaused()` + `start()` +
  `await ensureModelEffort()`'tan SONRA kuruluyordu → bunlardan biri asılırsa timer HİÇ kurulmuyor, tur sonsuz asılıp
  seri-kuyruğu kilitliyordu. Fix: timer artık pause'dan hemen SONRA, setup'tan ÖNCE kuruluyor (pause süresi tavana
  dahil DEĞİL ama post-pause her iş — start + model/efor + result bekleme — tek tavan altında). Ayrıca çevirmen
  cold-start'ına 2dk SERT wall-clock (`wallClockMs: 120_000`) eklendi — stuck/trickle API stream'i idle-timer'ı
  sürekli sıfırlayıp 30dk default-tavana kadar asılabiliyordu; çeviri küçük+hızlı olduğundan 2dk fail-fast doğru.

- **remove(model raporu butonu):** Composer'daki "📊 Model Raporu" düğmesi
  + `get_model_strength_report`/`model_strength_report` IPC yolu (ChatPanel.tsx butonu, App.tsx popup+handler,
  events.ts tip+komut, index.ts handler, `buildStrengthReportTR` importu) kaldırıldı. Escalation telemetri kaydı
  (`recordStrength`, `model-strength.jsonl`) KORUNDU — merdiven öğrenmesi için hâlâ yazılıyor; yalnız rapor-görüntüleme
  butonu gitti.

- **remove(üst-basamak kontrolü "verify-up" + ayarlardaki merdiven-sıfırlama düğmesi):** Her onay/escalation
  fazı (2,3,4,5,7,8,9) tamamlanınca işi bir ÜST basamağa (efor+1 / model+1) yeniden denetleten verify-up adımı
  KALDIRILDI — anlamsızdı ve Faz 4/7'de İYİ işi "yetersiz" sanıp (yanlış-negatif) gereksiz yükseltme+yeniden-koşum
  döngüsü açıyordu. `orchestrator/src/verify-up.ts` silindi; `completePhaseWithVerify` → `recordPhaseComplete`
  (yalnız escalation başarı kaydı tutar, `recordRungOutcome`; üst-rung re-check + "rerun" yolu yok). `_verifyUpRaises`
  bütçesi + "🔍 Üst-basamak kontrolü…" mesajları kaldırıldı. Escalation merdiveni GERÇEK gate-fail'de (failPhase)
  hâlâ tırmanır — yalnız başarılı işi tekrar denetleme katmanı gitti. Ayrıca Ayarlar'daki "🪜 Merdiveni sıfırla"
  düğmesi + `reset_escalation_ladder` IPC komutu (events.ts/App.tsx/Settings.tsx/index.ts) tamamen kaldırıldı.

- **fix(Faz 8 gate: spawn/ortam faultu artık kod-hatası sayılmıyor) [deep-research: adminpanel 21-iterasyon loop kök neden]:**
  Faz 8 final-suite `npm test` runner süreci E2BIG/posix_spawn/ARG_MAX ile BAŞLATILAMAYINCA gate bunu `tdd-red`
  yazıyordu → ortam-hatasını kod-hatası sanıp codegen→rollback→tekrar döngüsüne giriyordu (testler hiç koşmadan).
  `isSpawnEnvFailure` (mechanical-runner.ts) eklendi; phase-8.ts `isMissingCommand` guard'ının yanında, exit-code
  değerlendirmesinden ÖNCE: spawn faultu → `tdd-unverified` + halt (codegen tetiklenmez), kod-fix döngüsü kırılır.
  Exit-code mantığı (kod≠0 → fail) DEĞİŞMEDİ (gerçek test hatalarını maskelemez — deep-research adminpanel'de 12
  GERÇEK test hatası buldu: Navigation token-mock, admin error_code, boş dosyalar; o yüzden gate doğru çalışıyor).

- **feat(Duraklat/Devam düğmesi: token tasarrufu):** Header'da
  ⏸ Duraklat / ▶ Devam düğmesi (data-testid="pause-btn"). Semantik: Duraklat → bir sonraki LLM-çağrı SINIRINDA durur
  (yeni çağrı başlatılmaz), IN-FLIGHT tur İPTAL EDİLMEZ (mevcut LLM cevabı alınır); Devam → kaldığı yerden sürer.
  Çekirdek `orchestrator/src/pause.ts` (`waitIfPaused`/`setPaused`, runtime-only); gate'ler ağır LLM giriş
  noktalarında: `runClaudeCli` (codegen/debug/orchestrator-cli/relevance-cli), `runReasoningTurn` (lens/hipotez/
  error-analysis API), `PersistentClaudeSession.send` (çevirmen/relevance/persistent). IPC: `set_paused` komutu →
  `setPaused`. Frontend durumu optimistic (echo olay yok). Operatör (ben/YZLLM) Playwright'tan da tıklar.

- **fix(orchestrator→debug handoff: bulunan çözüm kaybolmuyor):** Bir faz gate-fail olunca derin-çözüm akışı somut çözümü buluyor
  (`error-analysis.ts` → `solutions_tr`), ama debug_triage'a devirde bu yapılandırılmış çözüm düz-metne çevrilip
  KAYBOLUYORDU → Faz 0 D1 sıfırdan yeniden araştırıp (~5dk, hipotez fan-out) aynı kök nedeni yeniden türetiyordu.
  Fix: `Phase0Controller`'a opsiyonel `priorAnalysis` (`executeDispatchedIntent` → `index.ts:3836` handoff'tan
  taşınır); set'liyse D1, çözümü YÜKSEK-ÖNCELİKLİ kanıt + "DOĞRULA, yeniden türetme" yönlendirmesiyle alır →
  yapılandırılmış `fix_options`/`plan_kind`'i 1-2 turda üretir (auto-apply routing/güvenlik KORUNUR), hipotez
  fan-out'u atlanır. Doğrudan kullanıcı debug'ında (priorAnalysis yok) normal D1 değişmez. (Sentez investigator'ların
  "D1'i atla, direkt uygula" hatasını yakaladı: `solutions_tr` prose-only, planKind yok → direkt uygulama ya
  fix'i hiç koşmaz ya "full-stack" restart yapardı.)

- **fix(orchestrator hız + döngü):** adminpanel'i
  tarayıcı köprüsünde sürerken çıkan 4 verimlilik/doğruluk kusuru. **(1) verify-up yanlış-negatif döngüsü:**
  `phase-7-complete`/`phase-8-complete` audit olaylarında `detail` boştu → üst-kontrol "tamamlama açıklaması yok"
  deyip fazı tekrar-tekrar koşuyordu (~10dk + maliyet); `detail` eklendi (sha256 + test metrikleri), döngü kapandı.
  **(2) per-mesaj relevance-classifier yükü:** aday havuzu istenen chunk sayısı kadar/altındaysa LLM skorlamasını
  (~40s) ATLA (havuz-boyutuna göre, mesaj-içeriğine göre DEĞİL → no-regex kuralı korunur; simetrik API+CLI). **(3)
  ucuz-başlangıç KALDIRILDI:** escalation artık `firstRung` ile cheap·low'a değil config.main tier'ından başlar
  (config kral, ucuz-zorlama yok; merdiven yalnız başarısızlıkta tırmanır) — YZLLM 2026-06-11 "en ucuzdan başla"
  direktifi bugünkü "kaldır" ile geçersiz; 2 doğrudan `index.ts` çağrısı + verify-up etiketi de güncellendi.
  **(4 ERTELENDİ):** gate-fail'de yalnız başarısız taramaları tekrar-koşma — güvenlik gate'i, false-green riski →
  ayrı tura. Ayrıca araştırmada bulunan latent koruma: blindspot-lens awaiti 60s sert-timeout + persistent-CLI
  IIFE `.catch` (timer-öncesi throw'da resolve garantisi) — kritik yollarda timeout'suz-await deadlock sınıfını kapatır.
- **fix(tarayıcı köprüsü sağlamlık) [canlı sürüş regresyonları]:** (a) StrictMode çift-mount churn emici —
  `kill_orchestrator` 2.5s geciktirilir, arada spawn gelirse iptal → orchestrator HİÇ öldürülmez (resume yarıda
  kalmaz). (b) ready-replay — köprü + istemci son `ready`/`config_status`'u cache'leyip geç bağlanan sayfaya replay
  eder (Node-logger orchestrator'ı erken doğurunca sayfa `ready`'yi kaçırıp open_project'i hiç göndermiyordu). (c)
  canlı sürücü harness'i: `e2e/live.mjs` (görünür headed Chromium host, CDP), `e2e/step.mjs` (tek-aksiyon sürücü),
  `e2e/drive.mjs` (otonom). Komut: `node e2e/live.mjs` + `node e2e/step.mjs <komut>`.

- **feat(tarayıcı köprüsü: MyCL Studio'yu düz Chromium'da Playwright ile uçtan-uca test):** Tauri WebView (WKWebView/WebKitGTK)
  Playwright/CDP'ye bağlanamadığı için uygulamayı düz tarayıcıda açan köprü eklendi. Asıl beyin zaten Node
  orchestrator; köprü Rust IPC katmanını BİREBİR taklit eder. (1) `browser-bridge/server.mjs` — Node yerleşik
  `http` ile SSE (olaylar) + HTTP POST (13 invoke komutu), SIFIR yeni bağımlılık; `orchestrator/dist/index.js`'i
  Rust gibi spawn eder, stdout NDJSON → `orchestrator-event`, stdin ← `OrchestratorCommand`. (2)
  `src/browser-bridge/shim/*` — `@tauri-apps/api/{core,event,window}` + `plugin-{dialog,notification,opener}`
  tarayıcı karşılıkları; `vite.config.ts` YALNIZ `MYCL_BROWSER=1` iken alias'lar → bileşen kodu DEĞİŞMEZ, Tauri
  build'i ETKİLENMEZ. (3) `e2e/smoke.mjs` — Playwright (orchestrator/node_modules'taki, zaten kurulu Chromium)
  harness'i: boot→Splash→fixture proje aç→Ana UI (header+faz sidebar+composer) tam DOM erişimi; HİÇBİR faz/LLM
  tetiklenmez (harcama yok); sayfa-içi uncaught hata = kırmızı. (4) Bileşenlere additive `data-testid` kancaları
  (Splash/PhaseSidebar/ChatPanel/AppHeader/AskqCard) — dile/stile bağımsız sağlam seçiciler. Komutlar:
  `npm run dev:browser` / `npm run e2e:smoke` / `npm run bridge`. Sınırlar (bilinçli): çoklu pencere + güncelleme
  tarayıcıda no-op; faz çalıştırınca gerçek orchestrator (API keys varsa maliyet). Detay: `browser-bridge/README.md`.

## 2026-06-11

- **feat(6'lı paket: kalite + merdiven iyileştirmeleri):**
  (1) Popup başlıkları: GuideModal title prop — Model Raporu artık "📊 Model Güç Raporu", spec kapısı "📋 Spec
  İncelemesi" (yanlış "Kullanma Kılavuzu" başlığı gitti).
  (2) Yönlendirmede otomatik geçiş: kullanıcı hedef fazı söylediyse durdur+tekrar-yazdır YOK — abort bitince
  hedef fazdan otomatik devam (_resumePhaseAfterAbort).
  (3) Kesme≠başarısızlık: durdur-butonu (abort_phase) _userInitiatedAbort set eder; /abort/ gerekçesi escalation'a
  kaydedilmez (rapor %0 kirliliği biter). Faz 5/7 SKIP dallarındaki yanlış başarı kayıtları silindi.
  (4) Ayarlar → "🪜 Merdiveni sıfırla": reset_escalation_ladder IPC — tüm domain'ler cheap·low'dan başlar.
  (5) Tepe + yetersizlik → Anthropic SDK'dan (models.list) güncel modeller çekilir; mevcut strong'dan farklı/yeni
  güçlü model varsa OTOMATİK strong tier+main'e alınır + aynı faz onunla denenir (oturum-içi tekrar-benimseme kırıcı).
  (6) VERIFY-UP ("yetersizliği net anla"): faz tamamlanınca işi BİR ÜST basamak (önce efor+1, efor tepedeyse model+1)
  KONTROL eder (verify-up.ts; runReasoning'e effort eklendi — CLI --effort, API yalnız destekleyen modelde
  output_config). Yeterli → basamak kalır; YETERSİZ → rapora başarısızlık + domain basamağı kontrolcüye yükselir +
  faz yeniden koşar (faz başına 2 yükseltme sınırı, iterasyon-başına sıfırlanır; tepe basamakta kontrolcü yok →
  atlanır; kontrolcü hatası fail-open). Fazlar 2,3,4,5,7,8,9 bağlı.

- **feat(escalation L3: merdiven CANLI — sorun çıktıkça tırman + rapor):** Yeni iterasyon `escalation_rung=firstRung` (cheap·low) ile başlar. Spec (Faz 4) +
  codegen (Faz 8) model+eforu artık `escalatedModelEffort` ile MERDİVENden çözülür (config kral: tier→model
  config'ten; efor rung'tan, CLI'da `effortOverride`). Bir faz FAIL olunca `failPhase` merkezi hook'u (yalnız
  ESCALATION_PHASES={4,8}, Oto-cevap açık): denemeyi rapora yazar → `nextRung` ile tırmanır (önce efor, sonra tier) →
  AYNI fazı tekrar dener (debug'a kaçmadan). Tepeye (strong·max) gelince escalation biter → mevcut derin çözüm akışı.
  Başarıda da rapora yazılır. Böylece kolay iş ucuzda biter, zor iş gerektiği kadar tırmanır + rapor hangi modelin
  hangi alanda iyi olduğunu öğrenir (composer "📊 Model Raporu" butonunda görünür). DİĞER fazlar (intent/review/db)
  henüz merdivene bağlı değil — sıradaki adımda eklenecek (failPhase boşa re-run yapmasın diye küme ile sınırlı).

- **fix(model politikası: ayarlar tek doğruluk kaynağı + keşif SORAR + translator SABİT):**
  (A) **Ayarlar dikkate alınıyor:** `selectModelForTask`'tan canlı-keşif override'ı (`_liveTiers`) KALDIRILDI — keşif
  kullanıcı `config.selected_models`'ını eziyordu ("ondan sonra bozuldu" buydu). Artık config tek doğruluk kaynağı.
  `setLiveTiersFromModels` → saf `computeTiersFromModels` (cache yok).
  (B) **Keşif otomatik uygulamaz, SORAR:** boot'ta web-keşfi yeni güçlü model bulursa "main + strong görevler için
  geçeyim mi?" askq'sı; "Evet" → config'e yazılır + reload; "Hayır" → oturumda tekrar sorulmaz.
  (C) **Translator modeli SABİT:** `TRANSLATOR_MODEL` (cheap/hızlı tier) — `config.selected_models.translator` yok
  sayılır; ayarlar sayfasında seçici 🔒 kilitli (değiştirilemez). Backend (API/Abonelik) seçilebilir kalır. Translator
  prompt'u kod tanımlayıcılarını da verbatim geçirir. Testler güncellendi (keşif config'i EZMEZ + TRANSLATOR_MODEL cheap).

# MyCL Studio — Değişiklik Günlüğü

> AI (Claude) tarafından yapılan işlerin zaman damgalı kaydı. Yeni → eski.
> Amaç: eski kararları/kuralları unutup bozmamak; bir işi değiştirmeden önce buraya bak.
> Eski bir işi değiştirmek/silmek gerekiyorsa ÖNCE YZLLM'e sor (kural, 2026-06-03).

## 2026-06-10

- **fix(orkestratör: "N. fazda kaldık" → resume, yeni-iterasyon DEĞİL):** Orkestratör yarım-kalan işi "yeni iterasyon (Faz 1)" diye ele alıp
  tamamlanmış Faz 1-9'u tekrar ediyordu. orchestrator-system.md'ye HARD RULE: "N. fazda kaldık / yarım kaldı, devam"
  + state mid-pipeline ise → `run_phase` target_phase=N (advance modu pipeline'ı N→17 sürdürür, 1..N-1 korunur);
  `develop_new_or_iter` SEÇME (Faz 1'den yeniden = boşuna). Kullanıcının söylediği faza güven, doğrulamak için
  restart etme. Belirsizse resume tercih (tamamlanmış işi yok etmez).

- **fix(geri-alma veri kaybı yapmasın: faz geçince rollback kilitlenir):** Otomatik geri-alma, başka bir hatanın tükenmesinde önceki BAŞARILI bir fazı/düzeltmeyi geri alabiliyordu
  (iyi işi kaybetme). Fix: bir faz başarıyla bitince (`disarmRollback`) rollback noktası temizleniyor — mekanik-pass,
  gate-autofix-resolved, phase-5/8 codegen başarısı + yeni kullanıcı turu. Böylece geri-alma yalnız o anki BAŞARISIZ
  düzeltme-dizisini kapsar; tamamlanmış iyi iş asla geri alınmaz.

- **feat(otomatik geri alma: Oto-cevap açık + çare kalmadıysa MyCL kendi geri alır):** `fix-snapshot.ts`: `restoreSnapshot` (git →
  restoreCheckpoint checkout+clean; copy → yedeği proje üstüne) + rollback-registry (`armRollback` ilk-kazanır =
  dizinin en temiz hali, `takeRollback`, `disarmRollback`). snapshotBeforeAutofix her snapshot'ı arm eder; yeni
  kullanıcı turu disarm eder (bayat restore yok). failPhase'de TÜKENME (aynı hata AUTO_SOLVE_MAX denemeye rağmen
  sürüyor, Oto-cevap açık) = "geri almaktan başka çare yok" → MyCL ilk-fix-öncesi temiz snapshot'a **otomatik geri
  döner** ("↩️ başarısız değişiklikleri geri aldım") + seçenekleri sorar. Junk birikmiş bozuk halde bırakmaz.

- **feat(silme öncesi MUTLAKA yedek — codegen fazları da snapshot'lı):** Codegen ajanı dosya silebilir/üstüne
  yazabilir (supersession: eski sayfa/route'u kaldır). CLI ajanının tek tek `rm`'lerini MyCL araya giremediği için
  en sağlam garanti: **silme/değişiklik yapabilen her faz çalışmadan ÖNCE snapshot.** Faz 5 (UI) + Faz 8 (TDD)
  codegen'den ÖNCE `snapshotBeforeAutofix` çağırıyor (tweak/fix modu zaten debug-fix yolunda snapshot'landı → çift
  yok). Böylece gate-autofix + debug-fix + tüm codegen fazları snapshot'lı → ajan ne silerse silsin git checkpoint
  veya `~/.mycl/backups`'tan geri alınabilir. Snapshot mesajı nötrleştirildi ("silinen/değişen dosyalar geri
  alınabilir").

- **feat(oto-cevap güvenli otonomi: snapshot + gate-integrity + darboğazda durmama):** Oto-cevap AÇIKKEN MyCL artık darboğazları otonom
  geçer, güvenlik ağıyla:
  (1) **Snapshot her oto-düzeltmeden önce** (`fix-snapshot.ts`): git varsa checkpoint; git YOKSA kaynak ağacı
  `~/.mycl/backups/<proje>-autofix-<ts>/`'a kopyalanır (node_modules/dist/.mycl hariç; hedef proje DIŞINDA →
  `fs.cp` self-copy hatası yok). gate-autofix + debug-fix uygulaması bunu çağırır → yanlış düzeltme geri alınabilir.
  (2) **Gate-integrity (sahte-yeşil yasak):** gate-autofix + error-analysis promptlarına KARDİNAL kural — testi
  silme/skip/zayıflatma, eslint-disable/ts-ignore, eşik düşürme, gate/config'i görmezden getirme YOK; altta yatan
  KODU düzelt. Yeşil checkmark değil, gerçekten doğru kod hedef.
  (3) **Darboğazda durmama:** loop-breaker tavanı 2→6 (Oto-cevap açık); farklı hata çıkarsa imza sıfırlanır
  (ilerleme = sınırsız). Yalnız AYNI hata 6 denemeyi aşarsa "gerçekten takıldı" deyip kullanıcıya bırakır (sonsuz
  aynı-fix/kaynak-israfı backstop). +2 test.

- **fix(otonomi = Oto-cevap opt-in: oto-davranışlar toggle'a bağlandı):** KRİTİK uyumsuzluk: faz-fail oto-çözüm (`failPhase`), Faz 0 D2 oto-seçim (`auto_selected_label`)
  ve gate-autofix Oto-cevap toggle'ına HİÇ bakmıyordu — toggle KAPALIYKEN bile otomatik kod değiştiriyorlardı
  ("otonomi tehlikesi"nin asıl kaynağı). Fix: üçü de `autoAnswerSuggested()`'e bağlandı. Oto-cevap KAPALI →
  MyCL otomatik kod değiştirmez, seçenekleri kullanıcıya sorar (görünür "Oto-cevap kapalı — sen seç" notu). AÇIK →
  otomatik çözer. Pipeline-restart (full-stack) Oto-cevap açık olsa bile otomatik değil (guardrail 1 korunur).
  Böylece otonomi gerçekten kullanıcının opt-in'i; güvenlik isteyen Oto-cevap'ı kapatır → her düzeltmeden önce sorulur.

- **fix(2 guardrail: gate-fail asla oto-yeni-iterasyon + MyCL kararını "kullanıcı istiyor" diye yazmaz):**
  (1) **Pipeline-restart asla otomatik değil:** Faz 0 oto-seçimi, planKind `full-stack`/`new-iteration` (tüm
  pipeline'ı yeniden başlatan) bir çözümü AUTO uygulamaz — bu büyük karar kullanıcıya askq ile sorulur (yanlışsa
  tüm ilerleme yok olur). Odaklı fix'ler (ui-only/backend-only) otomatik kalır.
  (2) **Fabrikasyon yok:** yeni-iterasyona giden düzeltme intent'i artık `[MyCL AUTOMATED FIX — NOT a user feature
  request; describe as a fix, never "the user wants..."]` ile işaretli + kullanıcı-mesajı "MyCL pipeline hatasını
  gidermek için" diyor. Faz 1 artık MyCL'in kendi kararını "Kullanıcı X istiyor" diye sunamaz.

- **feat(KÖK FİX: ajanlara PROJE-GERÇEKLERİ ver — JS/TS körlüğü):** Vaka: Faz 11 `ts-prune` (TS-only) JS projesinde
  çöktü → hata-analizi ajanı (API tek-atış, bağlamsız) yalnız hata metnini görüp "tsconfig oluştur" dedi → full-stack
  → yeni iterasyon → "Kullanıcı tsconfig istiyor" diye FABRİKLEDİ. Kök: (a) detectStack JS/TS ayırmıyor (sadece
  node-npm), (b) ajan promptlarında proje-gerçeği YOK. FIX: yeni `project-facts.ts` — dil (JS/TS/mixed), framework,
  tsconfig/config varlığı, paket yöneticisi + enjekte edilebilir özet (deterministik, ucuz). Bu özet artık
  ORKESTRATÖR (context-builder), HATA-ANALİZİ ve GATE-AUTOFIX promptlarına enjekte ediliyor → ajan "bu JS projesi,
  TS aracı uygulanmaz" bilgisiyle karar veriyor. Ayrıca `mechanical-runner.isTsToolNotApplicable` — TS aracı
  (ts-prune/ts-morph/tsc) tsconfig'siz çökerse SKIP (proje hatası değil; tsconfig oluşturma yok). +5 test.
  KALAN (sıradaki): gate-fail asla yeni-iterasyon tetiklemesin; MyCL kendi kararını "kullanıcı istiyor" diye yazmasın.

- **fix(debug dönüş noktası: hata hangi fazda çıktıysa orada düzelt+doğrula — Faz 8'e geri dönme):** Kanıt: debug-fix routing plan_kind'a göre SABİT faza dönüyordu (backend-only → current_phase=7 →
  advanceToNextPhase(7) → TAMAMLANMIŞ Faz 8 yeniden koşar), hatanın çıktığı fazı (Faz 10) hiç dikkate almıyordu.
  Fix: gate-autofix (önceki commit, yalnız fix_cmd'li lint'e bağlıydı) artık HER mekanik gate fail'inde (10-17, Faz 13
  güvenlik hariç — kendi dalı var) çalışıyor → hata fazın İÇİNDE odaklı-minimal düzeltilir + o gate YENİDEN koşulup
  doğrulanır. Geçerse faz tamam. Böylece geç-faz hatası artık erken-faza (Faz 8) geri dönmüyor; "döneceği yer" =
  hatanın çıktığı faz. Olmazsa (1 deneme) investigate+solve.

- **feat(Lint fazı kendi içinde düzeltir — debug'a kaçmaz):** Audit kanıtı: lint fazı reach edildi, `eslint --fix`'i koştu (scan→fix→rescan)
  ama `no-unused-vars`'ı ESLint otomatik SİLMEZ → faz fail → 1 satırlık iş debug→Faz 8 codegen döngüsüne gitti
  (orantısız + kullanıcı oradan çıkamadı). Fix: yeni `gate-autofix.ts` `runGateAutofix` — auto-düzeltilebilir gate
  (fix_cmd VAR = lint) deterministik fix'le çözülemezse, FAZIN İÇİNDE tam o hatalara odaklı MİNİMAL düzeltme yapar
  (backend-aware createCodegenBackend, yalnız Read/Edit/Grep/Glob, refactor/davranış-değişikliği YOK), sonra gate
  YENİDEN koşulup gerçekten geçtiği doğrulanır. Geçerse faz tamam (debug eskalasyonu yok). Bir deneme/koşu
  (`gateAutofixTried`), olmazsa normal investigate+solve. tag "gate-autofix" CLI-eligible. Artık lint fazı reach
  edilince kendi işini bitiriyor.

- **fix(her faz-fail araştırılıp çözülür + MyCL kendi bozuk aracını proje hatası saymaz):**
  (A) `mechanical-runner.isMyclToolBroken`: MyCL'in KENDİ node aracı (csp-check/headers-check) bundle'da kendi
  modülünü bulamayınca (module-not-found + yol app-bundle'ı işaret eder) → PROJE hatası DEĞİL → `skipped` + dürüst
  mesaj ("kendi paketleme bug'ım, güvenlik açığı değil"). Projenin KENDİ 'Cannot find module'ı (bare paket/proje
  yolu) bundle işaretçisi taşımaz → gerçek fail kalır. Ana scan + extra_scans ikisinde de. → sqlite3-v6 felaketi
  gibi yanlış-fix'in kaynağı kapandı.
  (B) Mekanik faz gerçek-fail (lint/simplify/...) artık "soft_complete" diye SESSİZCE geçilmiyor — güvenlik (Faz 13)
  gibi `failPhase` investigate+solve akışına gider: gerçek stderr ile analiz → en iyi çözüm otomatik uygulanır.
  İmza-bazlı döngü-kıran + non-blocking'de "kuyruğa al, devam et" seçeneği → takılma yok. +4 test (tool-broken
  ayrımı). Birlikte: artık her faz hatası (geçerli olanlar) araştırılır + çözülür, MyCL-kendi-bug'ları projeye
  bulaşmaz.

- **fix(KÖR TEŞHİS kökü: dev-server çöküşünün GERÇEK hatasını yakala+göster):** Log analizi: dev server 3 denemede düşüyordu, ajan port/vite/node_modules
  PROJE fix'lerini DÖNGÜDE deniyordu — ama hiçbiri sonucu değiştirmiyordu (kök neden E2BIG spawn-ortamı). Sebep:
  `tryDevServerChain` çöküşü bare "process_died/port_timeout" diye raporluyordu; **spawn stderr'i hiç okunmuyordu +
  E2BIG/ENOENT bir spawn `'error'` olayıdır (stderr değil) ve handler YOKTU** → gerçek hata yutuluyordu → kör teşhis.
  Düzeltmeler (genel, her spawn için): (1) `spawnDevServer` stdout/stderr'i ring-buffer'a (son 4KB) drain eder +
  `child.on("error")` ile spawn-error (E2BIG/ENOENT) yakalar — `handle.recentOutput()`. Drain pipe-hang'ini de önler.
  (2) `DevServerAttempt.output` + chain fail'de yakalanır; phase-5 `lastFailReason`'a GERÇEK çıktı konur → error-analysis
  "asıl hatayı" görür. (3) error-analysis prompt: hata-sınıflarını tanı (E2BIG=ortam, projeye dokunma; ENOENT=eksik
  dep/script; EADDRINUSE=port) + yıkıcı/yavaş fix (node_modules sil/reinstall) EN SONA, ucuz-reversible ÖNCE.
  (4) faz-fail döngü-kıranı sayaç→İMZA bazlı (zaman-penceresiz): aynı hata 2 oto-fix'e rağmen sürerse "sorun
  değiştirdiğim yerde değil" → otomatik tamir DUR, kullanıcıya sor (saatlerce süren döngü logda görülmüştü). +2 test.

- **fix(hata-analizi API modunda da çalışır — CLI-only gate kaldırıldı):** `analyzeAndAskError` artık backend-aware: orkestratör
  cli → `runClaudeCli` (Read/Grep/Bash ile araştırmalı, eskisi gibi); orkestratör api → Anthropic SDK TEK-ATIŞ
  triage (tool yok — hata mesajı + detail/stderr'den sınıflandır + çözüm öner). `buildErrorAnalysisPrompt(errCtx,
  canInvestigate)` no-tools varyantı. Derin araştırmayı SEÇİLEN FİX downstream (Faz 0 / SDK) yapar → triage hızlı +
  yeterli, fix kalitesi korunur. Böylece API modunda faz-fail OTO-ÇÖZÜM zinciri (analiz → en iyi çözüm → otomatik
  uygula) baştan sona çalışır. +2 test. API-desteği: artık hiçbir LLM yolu CLI-only değil.

- **fix(ayar değişikliği restart'sız aktif + görünür onay):** Backend (api/cli) zaten her save'de `runtime.config` reload edilip
  canlı okunuyordu; ama (1) config-türevi SINGLETON'lar (`setSandboxPolicy` + `setCacheTtl`) yalnız boot/open'da
  set ediliyordu → bu ayarlar gerçekten restart istiyordu. Artık `applyConfigDerivedSettings` TEK NOKTADA toplandı
  ve HER config-yüklemede (emitConfigStatus + open_project + save_features) çağrılıyor → restart'sız aktif.
  (2) Save sonrası GÖRÜNÜR onay: "✅ Ayarlar uygulandı — yeniden başlatma GEREKMEZ. Bir sonraki iş şu ayarla koşar:
  backend main/translator/orchestrator + model + efor" — kullanıcı değişimin geçerli olduğunu görür (önceden sessizdi,
  "anlamadı" algısının kaynağı). NOT: çalışmakta olan bir faz, başladığı config'le biter; YENİ iş/faz yeni ayarla
  koşar (doğru davranış — config mid-flight değişmez). AÇIK (API modu): faz-fail hata-analizi hâlâ CLI-only
  (orkestratör rolü API'de analiz atlıyor) → API modunda oto-çözüm çalışmaz; API agentic-loop yolu sıradaki iş.

- **feat(OTO-EFOR: efor seçimi iş-tipine göre otomatik):**
  `model-catalog.selectEffortForTask`: KALİTE-kritik (strong-tier: codegen/spec/design/review/debug) işler config
  eforunu AYNEN alır (varsayılan max — tam düşünme, DOKUNULMAZ); hafif/sık işler (orkestrasyon/niyet/doğrulama/
  çeviri/sınıflandırma) "high" TAVANINA çekilir (high = Anthropic'in önerilen varsayılanı, kalite tabanı; max kısa
  işte sadece bekletir). Kullanıcının bilinçli DÜŞÜK seçimi asla yükseltilmez; hiçbir iş low'a düşürülmez; geçersiz
  config → güvenli max. Bağlanan yerler (davranış değişen): cli-orchestrator (orkestrasyon — HER TURDA koşan en sık
  çağrı, en büyük gecikme kazancı), qa-askq-cli (niyet/netleştirme), living-docs (doğrulama). Codegen/spec/debug
  yolları değişmedi (max kaldı). +4 test.

- **feat(tasarım paneli çatışma çıtası yükseltildi):** `design-synthesizer.md`'ye CONFLICT BAR eklendi: yerleşik sektör-standardı
  cevabı olan / saf konvansiyon soruları (HTTP status semantiği, isimlendirme, dosya düzeni) ÇATIŞMA DEĞİL —
  sentezleyici kendisi karara bağlar + Decisions log'a yazar. conflicts'e yalnız projeye-özgü + davranış/veri/
  güvenlik/maliyeti maddi değiştiren anlaşmazlıklar gider ("iki kıdemli mühendis BU projede bunu gerçekten tartışır
  mıydı?" testi). Müzakere turları kısalır; adminpanel koşusundaki 3 çatışmanın 2'si (şema migrasyonu — spec
  varsayımını yanlışladı; anket idempotency) yine giderdi, 401/403 gitmezdi.

- **fix(boot-resume: faz başa sarmasın + chat geçmişi geri gelsin):** İki kök neden:
  (1) **Chat boş geliyordu** — boot 48s/2000-event yüklüyor ama yoğun codegen oturumunda en yeni 2000 event'in
  ~hepsi claude_stream delta'sı → chat_message pencereye giremiyordu. `history-loader.loadMessages`'a ADİL KOTA:
  chat_message'a ayrı kota (min(400,limit)) → stream seli chat'i boğamaz; iki kota dolunca lazy-chunk. +1 test
  (500 delta + 5 chat → 5'i de gelir).
  (2) **Faz 5 baştan koşuyordu** — boot-resume advanceToNextPhase fazı baştan başlatınca tasarım paneli (4
  perspektif, pahalı) YENİDEN koşuyordu. `designSynthesizedInCurrentIteration` (saf, design-panel-gate):
  audit kuyruğunda bu iterasyonda `ui-design-synthesized` varsa + `.mycl/design.md` duruyorsa panel atlanır,
  görünür mesajla codegen'den devam edilir. +3 test. Codegen tarafı: SDK yolu konuşmayı zaten phase-history'den
  sürdürüyor; CLI yolunda dosyalar diskte kaldığından ajan kaldığı dosyaların üstüne devam ediyor (tam
  konuşma-resume CLI'da yok — bilinen sınır).

- **feat(faz-hatası OTO-ÇÖZÜM + E2BIG öz-iyileştirme):** Üç kök neden, üç düzeltme:
  (1) **Faz-fail artık sormuyor** — error-analysis JSON'una `best_index` eklendi; `analyzeAndAskError(autoResolve)`
  askq AÇMADAN en iyi çözümü döndürür, `failPhase` aynı routing'le (handleAskqAnswer → debug akışı → D2 oto-fix)
  otomatik uygular. Döngü koruması: aynı faza 45 dk'da en çok 2 otomatik deneme, sonra görünür notla askq'ya düşer.
  Güvenlik override'ı ("Kabul et, devam et") ASLA otomatik seçilmez. F1'in "final kararı kullanıcı verir" tasarımı
  YZLLM talimatıyla TERSİNE DÖNDÜ. (Oto-cevap toggle'ı bu askq'yu zaten kapsamıyordu — 20 saat askıda kalmasının
  nedeni; artık askq default açılmadığından sorun kökünden kalktı.)
  (2) **E2BIG öz-iyileştirme (`safe-env.ts`)** — ekrandaki kök neden: shell'de birikerek şişen değişken (uzayan PATH)
  macOS ARG_MAX'i aşınca MyCL'in TÜM alt süreçleri (npm/vite/claude) çöküyordu, MyCL da kullanıcıya "terminali
  yeniden başlat" diyordu. Artık `safeEnv` PATH'i kayıpsız dedupe eder + >100KB kalan değişkeni alt sürece AKTARMAZ
  (bir kez görünür uyarı). `claudeSpawnEnv` PATH'i de dedupe. Dev server/claude/mekanik runner hepsi korunur.
  (3) Testler: PATH dedupe + şişmiş-PATH küçülmesi + devasa-değişken düşürme + best_index parse/sınır.

## 2026-06-09

- **feat(hata çözümü OTOMATİK — askq kaldırıldı):** v15.7'nin "auto-apply kaldırıldı, kullanıcı her zaman seçer" kararı YZLLM talimatıyla TERSİNE
  DÖNDÜ. `report_root_cause` şemasına `recommended_index` (required) eklendi — D1 ajanı uygulayacağı seçeneği kendisi
  seçer (önce doğruluk, sonra en düşük risk/etki-alanı; emin değilse en güvenli doğru seçenek). Faz 0 askq AÇMAZ;
  "🤖 En iyi çözüm otomatik seçildi" + alternatifler chat'te gösterilir (şeffaflık), `pending_diagnostic.
  auto_selected_label` set edilir → index.ts debug_triage akışı `handleAskqAnswer` ile AYNI routing'i otomatik sürer
  (dokunuş haritası + checkpoint + ui-only/backend-only/full-stack yönlendirme aynen). Boot-restore'da da otomatik;
  eski state.json (label yok) → geriye-uyumlu askq. Audit dürüst: otomatik seçim `caller: mycl-orchestrator (auto)`.
  CLI text-JSON + SDK retry prompt'ları güncellendi.

- **feat(agent-skills OTOMATİK kurulum + bağlama):** Eski karar
  ("auto-clone yok — supply-chain riski") YZLLM talimatıyla tersine döndü; risk PIN ile sınırlandı. Yeni
  `skills-setup.ts` `ensureAgentSkills`: `~/.mycl/agent-skills` yoksa SABİT commit'ten (0427b5b) git fetch+checkout
  ile kurar (.tmp→rename atomik; yarışta no-op; fail → görünür uyarı + elle-kur ipucu). open_project arka planında
  koşar; kurulunca mevcut `resolveSkillsDir` + `--plugin-dir` bağlama otomatik devreye girer (depo gerçek plugin
  formatında: .claude-plugin/plugin.json + skills/). CANLI DOĞRULANDI: kurulum koştu, pin SHA'da `~/.mycl/agent-skills`
  hazır → bir sonraki codegen'den itibaren skill'ler bağlı.
- **fix(çalışırken HER ZAMAN loading + ne yaptığı):** Önceden `emit("phase_running")` sticky banner'ı YALNIZ Faz 0 + DAST kullanıyordu → diğer
  fazlarda (tasarım paneli, müzakere, codegen, mekanik) hiç gösterge yoktu. Fix: (1) `runController`'a `runningLabel`
  param → p1-p9 LLM fazları çalıştığı SÜRECE "⏳ <ne yaptığı>" banner (Niyet toplanıyor / Spec yazılıyor / UI
  yazılıyor / ...); try/finally → askq'da fn döner → idle (bekleme ≠ çalışma), takılı spinner yok. (2) Mekanik fazlar
  (10-17 lint/test/build) `runner.run()` try/finally ile `phaseLabelTR` banner'ı. Artık her faz çalışırken kalıcı
  spinner + ne yaptığı görünür. (3) Faz 5 ince alt-etiketler: "Tasarım paneli çalışıyor (4 perspektif)" → "Tasarım
  çatışmaları müzakere ediliyor" → "UI kodu yazılıyor" (her adım kendi `emitPhaseRunning`'i → staleness yok). (4)
  ÇİFT-⏳ düzeltildi: ChatPanel `.running-spinner` zaten animasyonlu ⏳ (`mycl-spin`) render ediyor → label'dan ⏳
  kaldırıldı (spinner dönüyor + label metni). Banner gerçek animasyonlu loading göstergesi.

- **feat(API desteği TAMAMLANDI: model-discovery de backend-aware):** discovery artık cli → claude CLI WebSearch/WebFetch, **api →
  Anthropic SDK + server-side web_search tool** (`web_search_20250305`, name `web_search`, max_uses 5 — beta header
  GEREKMEZ; tool spec resmi Anthropic dökümanından doğrulandı, tahmin değil). Final text content-block'larından parse.
  Böylece TÜM LLM-çağıran yollar api+cli: decompose/review (runReasoning), worker (createCodegenBackend), discovery
  (cli WebSearch / api web_search). **CLI-only gap KALMADI** — "API yok diye yapma" tamamen kapandı.

- **feat(onboarding git-intent: yabancı projede "neden/ne"):** `onboarding/project-map.ts`
  artık dep-map'e ek olarak `buildBackground`: README özeti (ilk 1200 char) + son 12 commit subject'i → "Proje arka
  planı" digesti. Deterministik (LLM yok, hafif). `ProjectMap.background` + `formatProjectMap` render eder; open'da
  cache'lenip orkestratör bağlamına enjekte. Kod-yok ama README/git olan projede de hakimiyet (available = dep-graph
  VEYA background). +1 test.

- **feat(API desteği: parallel-codegen WORKER backend-aware):** worker (`module-parallel/worker.ts`) artık `runClaudeCli` (CLI-only)
  yerine `createCodegenBackend` kullanıyor → `backendForRole`'a göre CLI ya da SDK (API). tag "parallel-module"
  CLI_ELIGIBLE_TAGS'e eklendi (CLI'da CLI, API'de SDK). state worktree'ye override (`{...state, project_root:
  worktreePath}`); `runMultiAgentSelection(config, state, request)` + `makeScopedCodegenWorker(config, state)` ile
  state threading (index→select→worker). Per-tool trace observer ile korundu; `outcome.kind` → {ok}. Obsolete
  standalone E2E script'leri (eski runClaudeCli worker + minimal config) kaldırıldı — engine dispatch-test'le, worker
  createCodegenBackend phase-usage'la, akış gerçek-app'le kapsanıyor. Kalan küçük edge: model-discovery WebSearch
  claude CLI aracı (saf-API-no-CLI'de API web_search server-tool gerekir). "API yok diye bırakma" büyük ölçüde kapandı.
- **feat(orkestratör kuralı: dev-ortam ayrımı + dil hattı):** `orchestrator-system.md`'ye
  eklendi: (1) ÜÇÜNCÜ kategori — DEV-ORTAM sorunu (port/server/install) kod bug'ı DEĞİL → `chat` ile çöz + pipeline'ı
  sürdür, full `debug_triage` YAPMA (o kodu teşhis eder); "kod mu, IDE mi, ortam mı?" diye analiz et. (2) DİL HATTI
  HARD kuralı: kullanıcı İngilizce bilmez; orkestratör Türkçe düşünür; "main"e ASLA DOĞRUDAN gitmez (YASAK), fazlar
  gider + translator Türkçe↔İngilizce köprüler (anlam kaybı yok); ne zaman KENDİ cevaplar (dev-ortam/durum → chat) vs
  faza delege eder kararı. (Mevcut satır 9 zaten reason/message_to_user Türkçe zorunluluğunu içeriyordu.)
- **perf(model-discovery günlük cache):** Keşif her açılışta web-arama yapıp token yakıyordu.
  `~/.mycl/model-discovery-cache.json` (24s TTL): 24 saat içinde keşif yapıldıysa web-arama ATLANIR (cache döner).
  Modeller global (proje-bağımsız) → global cache. Başarılı keşifte yazılır; bozuk/eski → yeniden ara. Günde bir kez
  web-arama yeterli (yeni model günlük çıkmaz).
- **feat(API desteği: decompose + review backend-aware):** `llm-reasoning.ts`
  `runReasoning` — backend-aware (api/cli) tek-atış reasoning (backendForRole → cli=runClaudeCli, api=Anthropic SDK;
  modelId dışarıdan = canlı-tier uyumlu). `decompose.ts` (proposeModules) + `review.ts` (reviewMergedModules) artık
  `runClaudeCli` yerine `runReasoning` → API modunda da çalışır. KALAN (substantial, opt-in): parallel-codegen WORKER
  (agentic codegen loop) hâlâ CLI-only — API yolu State threading + SDK tool-loop ister; model-discovery WebSearch CLI
  aracı (saf-API'de API web_search gerekir). Flag'lendi.
- **fix(model keşfi: YENİ aile otomatik tier'lanıp KULLANILIR — manuel bırakma):** Önceki tutum yeni aileyi (Mythos vb.) "manuel" bırakıyordu →
  MyCL eski kalırdı. Düzeltme: discovery prompt artık her modele dökümandaki konumlandırmadan TIER attırır (en
  yetenekli→strong, en hızlı→cheap). `setLiveTiersFromModels` HİBRİT: bilinen aile (opus/sonnet/haiku) DETERMİNİSTİK
  (güvenlik ağı, LLM hatasını ezer), YENİ aile → LLM'in dök-tier'ı → OTOMATİK atanır + kullanılır (en-yetenekli-başta
  sıralı → ilk per-tier kazanır). Yeni flagship (Mythos 1) strong'a girer → codegen/spec onu kullanır. Manuel adım
  YOK; MyCL hep güncel. Test güncellendi (yeni aile auto-atama + selectModelForTask onu verir).
- **fix(model keşfi: API yerine WEB ARAMA):** Models-API keşfi (API key gerektiriyordu → abonelik-only kullanıcıda çalışmıyordu)
  WEB-ARAMA keşfiyle DEĞİŞTİRİLDİ. `model-discovery.ts` `discoverModelsViaWeb`: claude CLI (WebSearch/WebFetch)
  Anthropic'in RESMİ dökümanlarını arar → güncel model id'leri/adları → `setLiveTiersFromModels` (deterministik aile-
  tier: opus→strong vs). **API key GEREKMEZ → abonelikte çalışır.** Hatasızlık: yalnız resmi kaynak + `claude-*` id
  deseni doğrulaması (uydurma/yanlış id reddedilir); başarısız → statik katalog. open_project'te background, non-
  blocking. +3 test. (Sandbox dosya/bash hapsi yapar ama WebSearch sunucu-taraflı → ağ engellenmez.)
- **feat(model AUTO-KEŞİF: açılışta güncel modelleri çek + tier'la):** `model-catalog.ts` `setLiveTiersFromModels` —
  canlı model listesinden (Anthropic Models API, `listModels`, created_at-desc) her aileye EN YENİ sürümü tier'lar:
  opus→strong, sonnet→balanced, haiku→cheap. `selectModelForTask` artık CANLI tier'ı config'in ÜSTÜNDE kullanır →
  opus-4-9 çıkınca strong otomatik yükselir (auto-bump). `index.ts` open_project'te API key varsa arka planda çeker +
  chat'te "güncel modeller → güçlü/dengeli/hızlı: X" gösterir. Bilinmeyen aile (mythos vb.) `unknownFamilies`'e
  düşer (tier ataması manuel — kapasite API'den bilinemez). +3 test. **API DESTEĞİ:** keşif API-tabanlı (Models API
  key ister); subscription-only (key yok) → atlanır, statik katalog geçerli (elle güncel tutulur).
- **feat(model "kaliteli hız" — Faz 0 debug + parallel-review de strong tier):** Faz 0 debug (kök-neden akıl
  yürütmesi, CLI+SDK+D1 yolları) + `module-parallel/review.ts` (birleşik çıktı incelemesi) artık `selectModelForTask`
  ile strong (opus) seçer; debug ayrıca chat'te gösterir. Böylece TÜM kalite-kritik fazlar opus: codegen/spec/debug/
  review (+ design-fanout zaten tier'lı). Hafif fazlar sonnet (config, hız). "Kaliteli hız" model-seçimi tamam.
- **fix(model-alaka "kaliteli hız" kesin tanım: kaliteyi düşüren hız YOK):** Kalite SABİT kısıt. TASK_RELEVANCE'tan `classification → cheap`
  (haiku) KALDIRILDI → artık HİÇBİR iş cheap(haiku)'ya düşmüyor (haiku sınıflandırma/çeviri kalitesini riske atar);
  en düşük tier = balanced (sonnet, tam-kalite + hızlı). Hız yalnızca kalite-nötr kaynaklardan: paralellik + kalite-
  eşit-yerde-hızlı-model + faz-atlama. Test: "hiçbir iş cheap değil". feedback_kaliteli_hiz belleği kesin tanımla güncel.
- **feat(model "kaliteli hız" — Faz 4 spec + Faz 8 codegen → strong tier):**
  Auto-override AÇIK + akıllı: KALİTE-kritik fazlar (spec her şeyi sürer, codegen kod üretir) selectModelForTask ile
  strong tier (opus) seçer + formatModelChoice ile chat'te gösterir. Hafif/sık fazlar (orchestration/translation/
  intent — config'te zaten sonnet) hızlı kalır → kalite gereken yerde güçlü model, gerisinde hız. config.model_tiers.
  strong'dan çözülür; geçersiz → güvenli katalog fallback. Aynı desen review/debug'a genişletilebilir.
- **feat(model-alaka listesi — katalog + iş→model seçimi):** `model-catalog.ts` — TÜM Claude modelleri (opus-4-8/4-7/4-6, sonnet-4-6, haiku-4-5) tier'lı
  HATASIZ katalog + `TASK_RELEVANCE` (iş→tier: classification/translation→fast-değil-balanced, orchestration/intent/
  verification→balanced, spec/codegen/design/review/debug→strong) + `selectModelForTask` (task→tier→model, config
  model_tiers'tan çözer; geçersiz model → katalog varsayılanına GÜVENLİ fallback, sistem bozulmaz) + `formatModelChoice`.
  KRİTİK: çeviri 'fast' DEĞİL (anlam kaybı olmamalı). +12 test (benzersizlik, her tier var, exhaustive eşleme, güvenli
  fallback). GÜNCEL TUTMA: yeni model → MODEL_CATALOG'a satır ekle. Sıradaki: seçimi chat'te göster + LLM-çağrısına bağla.
- **fix(Faz 5 dev-ortam ≠ proje: çalışan server'ı tanı):** Faz 5 eskiden HER ZAMAN yeni dev-server spawn
  ediyordu; dışarıdan çalışan server'ı (kullanıcı elle başlatmış, örn. başka portta) tanımıyordu → resume edilince
  boşuna yeniden deneyip fail ediyordu. Düzeltme: spawn'dan ÖNCE aday + yaygın dev portları (5173-5178, 3000) KISA +
  PARALEL HTTP-yoklanıyor (`waitForDevServer`); biri yanıt veriyorsa onu KULLAN + tarayıcı aç + `phase-5-complete`
  (spawn yok). Böylece resume edilen Faz 5 çalışan server'ı bulur, dev-ortam sorunu gereksiz tam-debug'a girmez.
  Yanlış server riski Phase 6 smoke testiyle yakalanır (güvenlik ağı).
- **fix(Faz 4 DİL HATTI: kullanıcıya İngilizce sızıntı kapatıldı):** Ekran kanıtı: spec varsayımları kullanıcıya İNGİLİZCE gösteriliyordu (main spec EN üretir, çevrilmeden
  emit ediliyordu). Düzeltme: (1) `phase-4` preApprovalHook varsayımları emit'ten ÖNCE `translate(..., "en-to-tr")`
  ile Türkçeye çevirir (çeviri başarısızsa İngilizce fallback, bloklamaz). (2) Kör-nokta merceği (`pre-commit-lens`)
  prompt'una "note/recommendation'ı TÜRKÇE yaz (kullanıcı doğrudan okur, İngilizce bilmez)" eklendi → mercek bulguları
  artık Türkçe (format etiketleri zaten Türkçeydi). Faz-sırası: Faz 4 dil işi.
- **fix(UI: askq kartı kronolojik konumda — "yazım yukarı geliyordu"):** ChatPanel eskiden tüm mesajları
  sonra askq kartını render ediyordu → kart hep en altta sabit → askq pending iken composer'dan yazılan mesaj kartın
  ÜSTÜNDE kalıyordu. Artık kart sorulma zamanına (`PendingAskq.ts`) göre KRONOLOJİK render ediliyor: sorudan SONRA
  yazılan mesaj kartın ALTINDA görünür. `PendingAskq.ts` eklendi (App.tsx askq reduce'da Date.now()). Faz-sırası: Faz 1
  (askq/dil) işi.
- **fix(Faz 0 orkestratör hakimiyeti: debug iptali → kaldığı yerden DEVAM):** D2_WAITING "Vazgeç" eskiden sadece `pending_diagnostic`'i
  temizleyip `return` ediyordu → pipeline kaldığı fazda donuyor, orkestratör Faz 0'da takılı görünüyordu. Artık:
  debug bir KESİNTİ olarak ele alınıyor — `debug_triage` zaten `current_phase`'i değiştirmiyor → Vazgeç'te o faz
  mid-flight (Faz 1-9) ise "🔄 Faz N'den kaldığım yerden devam ediyorum" + `advanceToNextPhase(N-1)` ile resume; idle/
  tamamlanmışsa sadece durur. Çalışma sırası: işler MyCL fazlarına göre, Faz 0'dan (hız hariç — o tüm fazlar). KALAN
  (Faz 5): dev-ortam≠proje ayrımı (port yoklama) — resume edilen Faz 5 dev-server'ı yeniden denememesi için.
- **feat(orkestratör düşünme süreci görünür: `thinking` alanı):** `decide_action` şemasına `thinking` alanı eklendi — **action'dan ÖNCE** (chain-of-thought: önce
  adım-adım muhakeme, sonra karar → karar kalitesine de katkı). SDK yolu (DECIDE_ACTION_TOOL_SCHEMA) + CLI yolu
  (DECISION_OUTPUT_INSTRUCTION) ikisi de üretir; `parseAgentDecision` opsiyonel olarak ayıklar; `AgentDecision.thinking`.
  AgentThinkingModal kararın üstünde "💭 Düşünce:" bloğunda gösterir (whitespace-pre-wrap). Modal başlığı kronolojiğe
  göre düzeltildi ("en yeni altta"). NOT: `tool_choice:"any"` modeli decide_action'a zorladığı için narrative-text
  yakalama güvenilmezdi → şema alanı güvenilir çözüm (model her zaman doldurur).
- **feat(UI: orkestratör düşüncelerini banner'dan aç + kaymasın):** `ChatPanel` running-banner ("🤖 Model çalışıyor") artık tıklanır →
  `onOrchestratorClick` ile orkestratör düşünce modalını (AgentThinkingModal) açar + "💭 düşünceler" ipucu + cursor
  pointer. `AgentThinkingModal` artık KRONOLOJİK (yeni olay ALTTA, eskiden reverse=yeni üstte) → yeni düşünce
  geldiğinde üstte okunan içerik AŞAĞI KAYMAZ; oto-scroll yok, kullanıcı manuel kaydırır. Frontend typecheck temiz.
- **feat(paralel titizlik açığı KAPATILDI: tam kalite pipeline + anlamsal review):** Çoklu Ajan Seçimi yolu artık erken `return` ETMİYOR → paralel sonucu
  `advanceToNextPhase(9)` ile **Faz 10-17 tam kalite pipeline'ından geçiriyor** (codegen'den sonra geldiği için ezmez,
  sadece doğrular: lint/sadeleştir/perf/güvenlik/birim/entegrasyon/e2e/yük) + GERÇEK pipeline-sonu tazeleme (living-
  docs/proje-haritası/handoff) ondan koşar. Önceki `verifyBuild` (yarım subset) + manuel refresh KALDIRILDI (gerçek
  pipeline supersede etti; verify.ts silindi). **+ (b) anlamsal/business code review** (`module-parallel/review.ts`
  `reviewMergedModules`): bağımsız ajanların birleşik çıktısını BÜTÜN hâlinde inceler (business-logic + modüller-arası
  uyum + gizli kuplaj) → mekanik kapıların göremediği semantik katman; bloklamaz, yüzeye çıkarır. +2 test. Decompose
  riski (Luke #2) modüler-ilke (davranışsal-bağlı şeyler ayrı modüle konmaz) + bu review ile kapatıldı.
- **feat(#3: paralel sonrası dinamik kısımlar bayatlamasın — "her zaman dinamik kal"):** ARAŞTIRMA: Çoklu Ajan Seçimi yolu erken `return`
  ettiği için pipeline-SONU tazeleme adımlarını (updateLivingDocs + proje-haritası + handoff + module-stock) ATLIYORDU
  → yaşayan dökümanlar/proje-haritası/devir bayatlıyordu. FIX: paralel build + verify sonrası `updateLivingDocs` +
  `clearProjectMapCache` (+ arka planda recompute) + `appendHandoff` çağrılır → MyCL'in hakim olduğu dinamik kısımlar
  güncel kalır. Relevance zaten on-demand (git/dosyadan okur → otomatik taze, reindex gerekmez). Diğer code-yazan
  yollar (fix/develop) pipeline-sonu tazelemeden zaten geçiyor → kapsam tam.
- **perf(#2: kalite kapısı taramalarını paralelleştir — güvenli kısım):** `mechanical-runner`
  `extra_scans` döngüsü (Faz 13: semgrep/gitleaks/csp/headers vb.) seri `for...await`'ten `Promise.all`'a → BAĞIMSIZ +
  salt-okunur taramalar paralel = saf hız, çakışma yok (kod yazmazlar). abort'ta hiç başlatma; fail-aggregation sıra-
  bağımsız (eşdeğer sonuç). DÜRÜST KAPSAM: fazlar-ARASI paralel YAPILMADI (faz-makinesi/singleton'ı bozar, riskli);
  yalnız faz-İÇİ bağımsız taramalar. Yazan fazlar (lint_fix/simplify) seri kalır.
- **feat(Çoklu Ajan Seçimi TAMAMLANDI — #1: paralel sonrası kalite kapıları + Settings toggle):**
  (a) `module-parallel/verify.ts` — `verifyBuild`: paralel build SONRASI stack profilinden build/lint/test/güvenlik
  koşar (komut yoksa skip), `formatVerifyResult` özet. Develop dalında `sel.used` sonrası otomatik çalışır → paralel
  kod "yazıldı" bırakılmaz, doğrulanır. +1 test (saf format). (b) **Settings UI toggle:** `multi_agent_selection` flag'i
  uçtan uca bağlandı — events.ts (2) + save handler (index.ts payload/destructure/flagsPatch/emit) + App.tsx (state/
  receive/param/set/persist/prop) + Settings.tsx (prop/state/checkbox "Çoklu Ajan Seçimi"/onSave). Artık config.json
  düzenlemeden Settings'ten açılıp kapanıyor. Frontend typecheck temiz.
- **feat(ajan-içi TAM İZ — kör nokta kalmasın):**
  `agent-trace.ts` — kalıcı iz (`.mycl/traces/agents.jsonl`): `setAgentTraceRoot` (open_project'te set) +
  `traceAgentEvent` (O_APPEND, non-blocking) + `readAgentTrace`. Bağlandı: (1) `emitAgentEvent` (ipc) artık UI'ya
  gösterdiği HER olayı ize de yazar; (2) paralel worker'lar TÜM tool çağrılarını + final çıktısını modül-etiketiyle
  ize ekler (eski kör nokta: yalnız başla/bit loglanıyordu); (3) gerçek Agent Teams peer-müzakere çıktısı (design-
  fanout CLI yolu) ize eklenir. **GERÇEK E2E doğrulama:** 2-modül paralel koşuda iz 17 kayıt yakaladı (datefmt:7,
  arrutil:10), her worker'ın tool_use'ları ajan-etiketli. +3 test. → Ajan süreçlerinde tam izlenebilirlik, kör nokta yok.
- **feat(ÇOKLU AJAN SEÇİMİ — paralel codegen develop akışına bağlandı):**
  Flag `multi_agent_selection` (config, varsayılan KAPALI → normal akış sıfır etkilenir). `module-parallel/select.ts`
  `runMultiAgentSelection` — flag açık + niyet ≥2 GERÇEKTEN bağımsız modüle bölünüyorsa izole worktree'lerde PARALEL
  yazdırır + ayrık entegre; aksi/hata → seri (fail-closed). Develop girişine (`index.ts` case develop_new_or_iter)
  opt-in dal: kullanıldıysa paralel build + görünür rapor + return (fresh seri pipeline üzerine yazmaz). Worker artık
  per-modül `agent_event` yayınlar → AgentThinkingModal "🤖 <modül>" gösterir (görünürlük tie-in). **GERÇEK E2E
  (flag açık, no mock):** ilk koşu worker scope-dışı (package.json) yazdı → entegrasyon REDDETTİ (defense çalıştı,
  fail-closed); worker promptu sertleştirildi (config/init yasak) → 2. koşu `used:true`, 2 modül paralel + 15 dosya
  entegre, görünürlük olayları aktı. +1 test (flag-kapalı fail-closed). Kalan (ileride): paralel sonrası kalite
  fazlarını otomatik koşma + UI toggle.
- **feat(modül-paralel — decomposition + TÜM canlı zincir E2E GEÇTİ):** `module-parallel/
  decompose.ts` — `proposeModules` (LLM işi ≥2 AYRIK modüle böler; planlayıcı promptu "kod yazma, SADECE JSON";
  `allowedTools:[]`+`disallowedTools` ile kodlama moduna kaçışı engellenir) + `parseModulesResponse` (saf, +3 test) +
  K1 kapısı doğrular → over-claim/bölünemez → null → SERİ (fail-closed). **GERÇEK uçtan-uca E2E** (`scripts/e2e-
  parallel-full.mjs`, no mock): istek → LLM böldü (2 ayrık modül, 5sn) → `runParallelModules` gerçek worker'larla
  paralel + ayrık entegre (3 dosya, 52sn) → `parallel:true ok:true`, çakışma yok. İLK denemede LLM planlamak yerine
  kodlamaya kalkmıştı (JSON yok→null); prompt sertleştirilince düzeldi. Kalan (opt-in): Faz 5/8 pipeline auto-hook.
- **test(modül-paralel codegen — GERÇEK 2-modül E2E GEÇTİ, no mock):**
  `orchestrator/scripts/e2e-parallel-codegen.mjs` — geçici git repo + 2 ayrık modül (greet/calc), GERÇEK
  `makeScopedCodegenWorker` (sonnet, abonelik) ile `runParallelModules`. Sonuç: `parallel:true, ok:true`, iki modül
  PARALEL izole worktree'de yazıldı + ayrık entegre (10 sn, 2 api_call), `src/greet/greet.ts` + `src/calc/add.ts`
  doğru gerçek kod, çakışma/sızıntı yok, worktree'ler temizlendi. → Paralel codegen çekirdeği (K1 kapı + K2 worktree +
  K4 dispatch + gerçek worker) UÇTAN UCA KANITLANDI. Kalan (opt-in, ileride): LLM decomposition + Faz 5/8 pipeline hook.
- **feat(#2 onboarding — yabancı koda hakimiyet, ilk artım):** MyCL kendi
  yaratmadığı/ilk gördüğü projeyi anlasın diye: `onboarding/project-map.ts` — `buildProjectMap` (mevcut
  `fix/dep-graph` reverse-import'undan en MERKEZİ modülleri çıkarır = "önce buraya bak, dokunursan etkisi geniş") +
  `formatProjectMap` (saf digest) + cache (`getCachedProjectMap`/`peekProjectMap`/`clearProjectMapCache`).
  `open_project`'te ARKA PLANDA hesaplanır (bloklamaz), `clearProjectMapCache` ile proje değişince sıfırlanır;
  `context-builder` cache'i peek edip orkestratör recall'ına enjekte eder → AI ilk turdan yabancı projenin iskeletini
  bilir. Hafıza notuna sadık: koddan türet, HAFİF dep-map, ağır graph DB YOK (turbogrep dersi). +3 test. Derinleştirme
  (git-niyet, mimari anlatı) sonraki artım.
- **feat(Agent Teams görünürlüğü):** Mevcut
  `agent_event` + `AgentThinkingModal` altyapısı yalnız TEK orkestratör ajanını gösteriyordu; design-fanout'un 4
  perspektifi (Mimari/UX/Güvenlik/Veri — asıl Agent Teams) hiç emit etmiyordu. Eklendi: `agent_event`'e `agent_label`
  (events.ts + ipc.ts); `design-fanout` her perspektifte started/completed yayınlar (finally ile dengeli sayaç);
  `App.tsx` reduce ETİKETLİ ajanları hem sayar hem listeler (etiketsiz orkestratör eskisi gibi yalnız sayaç);
  `AgentThinkingModal` "🤖 &lt;ajan&gt;" rozetiyle gösterir → kullanıcı hangi ajanın canlı çalıştığını/bittiğini görür.
  Paralel-codegen worker'ları (K4) aynı kanalı modül-id ile kullanabilir. Frontend typecheck temiz.
- **feat(modül-paralel codegen — K4 dispatch motoru):** `module-parallel/dispatch.ts`
  `runParallelModules`: gate(K1) → her modül izole worktree(K2) → worker'lar PARALEL(`Promise.allSettled`) →
  hepsi başarılıysa disjoint değişiklikleri ana ağaca SERİ entegre (`integrateWorktrees`: kapsam-dışı + dosya-
  çakışması defense'i) → temizlik. Her aşama FAIL-CLOSED (gate/worktree/worker/entegrasyon hatası → temizle + caller
  seri). `runWorker` ENJEKTE → motor mock + gerçek git fixture ile UÇTAN UCA test edildi (happy/worker-fail/kapsam-
  dışı; +`pathWithin`). +4 test. KALAN: gerçek worker (worktree'de scoped codegen) + decomposition (LLM modülleri
  öner) + pipeline hook — opt-in/fail-closed; bu ortamda doğrulanamaz (gerçek ≥2-modül koşusu).
- **feat(modül-paralel codegen — K1 güvenlik kapısı + K2 worktree izolasyon):**
  Plan: additive + gated + fail-closed (mevcut SERİ codegen DEĞİŞMEZ). **K1** `module-parallel/independence.ts` — SAF
  kapı (`pathsOverlap` + `modulesDisjoint` + `shouldParallelize`): paralele YALNIZ flag açık + ≥2 modül + AYRIK
  yol-kapsamı hepsi doğruysa girilir; şüphe/çakışma → seri (Luke'ın çakışma tuzağına karşı yapısal koruma). **K2**
  `git.ts` `createWorktree`/`removeWorktree` — izole çalışma kopyası (başarısız → null → seri). +9 test (gerçek git
  fixture dahil). **KALAN (büyük, çekirdeğe dokunur, AYRI tur):** K3 decomposition (işi ayrık-kapsam modüllere bölme)
  + K4 dispatch/entegrasyon — bu ortamda uçtan-uca DOĞRULANAMAZ (gerçek ≥2-modül koşusu gerekir); güvenli devreye
  alma için opt-in + fail-closed kalacak.

## 2026-06-08

- **feat(WTF/gotcha kaydı — Cichra karar-yakalamanın 4. biçimi):** "Bu tuhaf şey bilerek böyle,
  dokunma" tuzak notları. `WtfRecord` + `appendWtf`/`readWtf` (audit.ts → ayrı `.mycl/wtf.jsonl`, handoff deseni);
  Faz 0 hata-ayıklaması kök neden + bağımlılık etki-alanını OTOMATİK WTF olarak yazar; `context-builder` son WTF'leri
  orkestratör recall'ına "### Bilinen tuzaklar (dokunmadan önce oku)" diye enjekte eder → bilerek-böyle olan kod
  yanlışlıkla bozulmaz. +2 test. Karar-yakalama artık 4 biçim TAM (ADR=decisions + BDD=AC + PRD=living-docs + WTF).
  Genişletme: WTF'i kodlama-anı tuhaflıklarından da yakalamak (şimdilik yalnız hata-ayıklama). MyCL-Yetenekler.html
  güncellendi (WTF + Agent Teams durumu: Faz 5 tam-aktif).
- **feat(#3 bağımlılık etki-alanı → fix codegen'i):** Faz 0 D1'in ZATEN
  hesapladığı deterministik bağımlılık blast-radius'unu (`state.pending_diagnostic.affected`) fix payload'ına ekler →
  Faz 8 codegen AI "bu fix şu dosyaları etkiler"i grep'le yeniden keşfetmeden görür (token tasarrufu + dependent'i
  kaçırmama). Tam da fix/debug penceresi (dep-map'in en parladığı yer). `formatBlastRadius` (SAF, fix/dep-graph;
  +3 test); index.ts fix payload'ına eklendi. **Süzgeç:** #1-Faz2 (marjinal + qa-askq'ya dolaşık) ve
  ④ PRD-relevance / #2 subtract / yabancı-proje onboarding ATLANDI — faydalı-değil / güvenli-aday-yok / "sonra".
- **fix(2 olmazsa-olmaz kusur — aktif "must-have" taramasından):**
  3-ajan salt-okunur tarama (sessiz-başarısızlık / yarım-bağlı / yeni-eklentiler) + süzgeç → 2 GERÇEK bulgu
  (kalan ~15 aday enhancement/test-açığı/kasıtlı-tasarım diye ATLANDI, ilkeyi çiğnememek için).
  (A) **phase-0 `plan_summary_en` korumasız:** `plan_kind` defensive fallback'liydi ama bu değildi → eksik/boş
  gelirse `index.ts selected.planSummary.length` ÇÖKER / fix payload "undefined" olur. Guard + fallback
  (descTR/labelTR) + warn eklendi.
  (B) **`orchestrator-exit` frontend'de DİNLENMİYORDU:** backend süreci ölünce UI fark etmiyor, "hazır" yalanı
  söyleyip komutları ölü sürece yolluyordu (sessiz başarısızlık). `useOrchestrator` artık exit event'ini (tek +
  çok-pencere) dinliyor → `setReady(false)` + görünür hata mesajı. Elenenler: message_start boş-catch (polish),
  runtime_error structured (hata zaten chat'te görünür), abort/shutdown/ping UI (özellik), Faz4 handoff asimetrisi
  (zenginleştirme), test-açıkları (mantık zaten test'li).
- **fix(noteCliRateLimitError'ı BAĞLA — yarım-bağlı güvenilirlik yolu):**
  `noteCliRateLimitError` tanımlıydı ama HİÇ çağrılmıyordu (ts-prune "ölü" sandı — aslında bağlanmamış). Abonelik
  usage/rate-limit'i `rate_limit_event` YERİNE bir HATA olarak geldiğinde tespit edilmiyor, auto-mode API'ye
  düşmüyordu → sessiz başarısızlık. Eklendi: `detectCliRateLimit` (SAF + DAR imza — usage/rate-limit; çıplak "429"
  YOK çünkü satır-no yanlış-pozitifi) + 3 CLI spawn site'ında (cli-run / cli-session / cli-backend) `result is_error`
  yolunda detect→noteCliRateLimitError. +3 test. **Süzgeç sonucu:** diğer ORTA maddeler (betas uyarısı / ESLint /
  ④ PRD-relevance) "olmazsa olmaz değil" diye ATLANDI; "yan-sınıflandırma routing" zaten parite (scoreChunksViaCli)
  → pending değil.
- **feat(#1 varsayım görünürlüğü — Faz 4 spec) [Gemini-vizyon tartışması → "alan aç, gör + itiraz et"]:** Yapay
  zekânın kullanıcının AÇIKÇA demediği ama spec'in dayandığı varsayımları görünür kılar — KAPI DEĞİL (tek tek
  onaylatmaz, AI'a alan açık kalır; kullanıcı yanlış görürse itiraz eder). write_spec'e opsiyonel
  `assumptions: [{assumption, why}]` eklendi (CLI tool + strict JSON şema — parite); `specToMarkdown` varsayım VARSA
  "## Assumptions" bölümü yazar (yoksa gürültü yok); `preApprovalHook` onaydan ÖNCE varsayımları görünür emit eder.
  Dogfood: bunu kurarken kendi build-varsayımlarımı da kullanıcıya gösterdim + kör-nokta merceğini kendi işime
  uyguladım. +4 saf test. SINIR: yalnız Faz 4 (Faz 2 özet-sapması ayrı tur); değer ajanın alanı dürüst doldurmasına
  bağlı (zorlama yok — yargı işi).
- **test(klasör-guard kararını ağ kapsamına al — "test'i test et" deneyinin sonucu):** check'in gerçek sınırını
  ampirik gösterdik (test edilen mantığı yakalar, test edilmeyen yolu kaçırır). Kaçan örnek tam da guard kararıydı
  (`cli-run.ts` içinde gömülü, testsiz). Karar saf bir fonksiyona çıkarıldı: `shouldFolderGuard` (claude-folder-guard.ts);
  cli-run onu çağırıyor (davranış birebir aynı). +4 test (tool yok→sar, Bash'siz→sar, Bash→sarma, override). Artık
  "tool yoksa sar" kararı ters çevrilirse check kırmızı verir — delik kapandı.

- **fix(macOS izin pencereleri — KAYNAĞINDA kes: sandbox-exec klasör-guard):** Env bayrakları (DISABLE_ATTACHMENTS vb.) claude'un başlangıç klasör-taramasını (Downloads/Documents/
  Desktop/Music/Pictures/Movies) DURDURMUYORDU — bunu kapatan bir bayrak YOK. Yeni: `claude-folder-guard.ts`
  (`buildSeatbeltProfile` + `wrapReadOnlyClaude`) read-only claude çağrılarını `sandbox-exec` ile sarar; korumalı
  klasör okuması syscall'da reddedilir → TCC sorulmaz → pencere çıkmaz. `cli-run.ts` AUTO-classify: Bash tool'u
  YOKSA sar (read-only), VARSA sarma (claude'un iç Bash-sandbox'ıyla nesting riski). Ampirik doğrulandı: claude
  sandbox-exec altında çalışıyor (auth+cevap) + Downloads reddediliyor + proje/~.claude açık. macOS-only (Linux
  no-op). Escape hatch: `MYCL_CLAUDE_FOLDER_GUARD=0`. Apple Music (Media framework, dosya değil) sürebilir → tek
  sefer deny. +3 test.
- **fix(macOS izin — "diğer uygulamaların verisi" + bunun gibi hepsi):** Klasör-guard deny-listesi
  genişletildi: kişisel klasörlere ek olarak `~/Library/{Containers, Group Containers, Application Support,
  Mail, Calendars, Mobile Documents}` (kTCCServiceSystemPolicyAppData "diğer uygulama verisi" + Mail/Takvim/
  iCloud). EMPİRİK doğrulandı: claude bu yolların TÜMÜ reddedilince bile auth+cevap veriyor (config ~/.claude +
  ~/.claude.json, Library ALTINDA değil → açık). Böylece "bunun gibi" tüm TCC pencereleri kaynağında kesiliyor.
- **fix(macOS izin — framework-tabanlı TCC: Apple Music/Media + Photos):** Dosya-deny bunları kesemiyordu
  (kTCCServiceMediaLibrary + kTCCServicePhotos = framework çağrısı, dosya değil). Çözüm: Seatbelt profiline
  `(deny mach-lookup (global-name-regex "^com\.apple\.tccd"))` — claude'un in-process framework'leri (Media/Photos)
  izin SORMAK için tccd'ye ulaşamaz → bu pencereler de AÇILAMAZ. Blanket etki: kalan tüm TCC pencerelerini keser.
  EMPİRİK doğrulandı: claude TAM profil (tüm file-deny + tccd mach-deny) altında auth+cevap veriyor (coding için
  tccd'ye ihtiyaç yok). file-deny'ler least-privilege için korundu (defense-in-depth).

## 2026-06-07

- **feat(keystone ① — AC→test izlenebilirliği: çalıştırılabilir doğrulama-sözleşmesi) [4-talk birleşimi raporu]:**
  Cichra ("çalıştırılabilir şartname") + Missions ("validation-contract-önce-kod") birleşiminin MyCL'deki somut
  karşılığı. Eskiden Faz 8 gate yalnız `tdd-green` SAYIYORDU; hangi AC'nin testi var bilinmiyordu. **Eklendi:** (1)
  `parseAcIds`/`acCoverage` (SAF, test edil/i); (2) Faz 8 worker prompt'u testleri AC-id ile etiketler
  (`MYCL_TEST_RESULT: green: AC3`); (3) gate'te **ADDITIVE** kapsam raporu — kapsanmayan AC'ler GÖRÜNÜR kılınır.
  +6 saf test. Rapor: MISSIONS-ENJEKSIYON-RAPORU.md.
- **feat(③ handoff consumer — devir döngüsünü kapat):**
  ③'ün yazma-tarafı vardı (handoffs.jsonl); şimdi OKUMA/tüketme: `readHandoffs` (audit.ts) + orkestratör recall
  (context-builder.ts) son 6 faz devrini system-prompt'a enjekte ediyor ("### Recent phase handoffs"). Böylece
  ajan son faz sonuçlarını (özellikle fail + keşfedilen testsiz-AC) görüp HEDEFLİ takip önerebilir (Missions:
  "başarısızlık → hedefli takip-özelliği, rewrite değil"). Missions handoff döngüsü tam: yaz→oku→sonraki kararı besle.
  +2 test (readHandoffs roundtrip/empty).
- **feat(② validator-katmanı framing + ③ structured handoff — Luke/Missions):**
  ② Orchestrator-system.md §14'e "doğrulama katmanı" notu: 3 bağımsız adversarial validator (pre-commit-lens=
  kör-nokta, harness-verdict=scrutiny, verify-feature=user-testing/canlı-davranış) tek disiplin altında; özellik
  milestone'u bitince davranışsal doğrulamayı (verify-feature) çalıştır ("test ettim" demeden), AC↔test bunların
  zorladığı sözleşme. (Prompt-düzeyi, kod riski yok.) ③ `appendHandoff` (audit.ts) → AYRI `.mycl/handoffs.jsonl`
  (gate'in audit.log'unu KİRLETMEZ); Faz 8 complete/fail'de yapılandırılmış devir kaydı (status + green/red/debt/
  score + keşfedilen testsiz-AC) — resume/uzun-koşu + "doğrulama ilk seferde geçmez → hedefli takip" zemini. +2 test.
- **feat(keystone ① ENFORCEMENT — Michal "ölçemiyorsan zorlayamazsın"):** Faz 8 gate artık
  KOŞULLU zorluyor: worker testleri AC-id ile etiketliyorsa (`acCov.tagged`) VE kapsanmayan AC varsa → gate GEÇMEZ
  (fail-reason'da testsiz AC'ler + nasıl etiketleneceği). Worker hiç etiketlemiyorsa (SDK modu/eski akış) →
  `tagged=false` → enforcement GRACEFUL kapalı (eski davranış, regresyon yok). Çalıştırılabilir doğrulama-sözleşmesi
  artık sadece görünür değil, zorlanabilir.
- **feat(pre-hoc bağımsız kör-nokta merceği — algoritmanın kalıcı parçası):**
  Felsefe: odak = çevreyi bilinçsizce paranteze almak (kör nokta). Bunu somut yaşadık — Cichra-notu raporumun
  hatalarını üstüne saldığım zıt-odaklı eleştiri workflow'u yakaladı. Çözüm: kritik bir karar/artefakt KOMİT olmadan
  ÖNCE, o işi YAPMAYAN bağımsız bir ajan "neyi paranteze aldı?"yı ucuzca yakalar (pre-hoc, post-hoc değil).
  **Yeni:** `pre-commit-lens.ts` (`runBlindspotLens` → mevcut `runReasoningTurn`'ü reuse [design-fanout.ts export];
  tek READ-ONLY ucuz tur, `verifier` rolü, zıt-odak prompt "bunu sen yazmadın; paranteze alınanı bul; uydurma";
  `extractKindBlock` parse; FAIL-SAFE: hata→görünür not, komit BLOKLANMAZ) + `pre-commit-lens-gate.ts` (SAF gate,
  designPanelDecision deseni; trivial/reversible DAİMA atlanır → anti-friction). **Bağlandığı yerler:** (1) Faz 4
  spec onayı — base production controller'a `preApprovalHook` (SDK+CLI İKİSİ → abonelik paritesi); spec komit olmadan
  önce mercek, bulgular onay öncesi GÖRÜNÜR. (2) Orkestratör consequential kararları (develop/cancel/debug/kod-fazı
  run_phase) — execute öncesi mercek, bulgular görünür. **Flag:** `claude_code_flags.blindspot_lens` "off"/
  "consequential"(default)/"always". **Prompt:** §14'e mercek-disiplini notu (ajan HIGH bulguyu §14 riski sayar).
  +27 yeni test (gate saf + lens fail-safe/parse mock). 967 test yeşil.

- **fix(kod-analiz B7 — ölü kod: duplicate run_phase case) [audit]:**
  `executeAgentDecision` switch'inde `case "run_phase"` İKİ kez vardı; JS ilk eşleşeni (emitPhaseRunAskq)
  çalıştırdığından ikinci dal (pendingAgentDecision onayı) ÖLÜ koddu + yorum tersini iddia ediyordu. İkinci
  daldan `run_phase` etiketi kaldırıldı (davranış korunur — ilk dal zaten ele alıyor). NOT: ESLint
  (`no-duplicate-case`) eklenmesi ayrı bir infra işi olarak ertelendi (31k-satır mevcut kodda çok sayıda ihlal
  yüzeye çıkıp build'i destabilize edebilir → kontrollü ayrı tur gerektirir).
- **fix(kod-analiz B6 — IPC race-guard + Faz 0 D1 parite) [audit]:**
  (1) **IPC dispatch race (kontrol kaybının #1 yapısal kaynağı):** `app.ts rl.on("line")` dispatch'i await
  etmiyordu → kullanıcı faz koşarken ikinci mesaj yazınca İKİ `handleUserMessage` aynı `runtime.state`/
  `runtime.controller`'ı eşzamanlı yazabiliyordu. `handleUserMessage`'e re-entrancy busy-guard (görünür
  "işleniyor" mesajı + finally'de bırak); handleUserMessage tüm fazı await ettiğinden bayrak işlem boyunca
  tutulur, `abort_phase` AYRI handler → durdurma bloklanmaz. (2) **Faz 0 D1 SDK read-only:** D1 salt-araştırma
  ama SDK yolu `spec.allowed_tools` (=Read/Edit/Write/Bash/Glob/Grep, D3-fix için) veriyordu → API'de ajan
  teşhiste dosya yazabiliyordu. SDK D1 artık CLI ile simetrik `[Read,Grep,Glob,Bash,report_root_cause]`.
- **fix(kod-analiz B5 — config kalıcılık merge + list_models stuck-loading) [audit]:**
  (1) **`persistApiKeys` + `persistSelectedModels` artık alan-bazlı MERGE** (`mergeDefinedFields`): eskiden
  tam-üzerine-yazma + UI payload relevance/orchestrator/subagent_models taşımadığından bu key/model'ler sessizce
  SİLİNİP main'e düşüyordu (yanlış tier/kota). Yalnız tanımlı+boş-olmayan alanlar yazılır; gönderilmeyen mevcut
  değer korunur. (2) **list_models terminal event:** başarısız yollarda (api key yok / catch) artık boş `models_list`
  emit ediliyor — frontend loading SADECE bu event'le temizlendiğinden, eskiden dropdown + ↻ sonsuza dek
  "yükleniyor"da/disabled takılıyordu (özellikle abonelik modunda api key yokken).
- **fix(kod-analiz B4 — spawn-env + argv disiplini) [audit]:**
  (1) **orchestrator-agent Grep/Bash** `execAsync` çağrıları `process.env`'i filtrelemeden miras alıyordu →
  child ANTHROPIC_API_KEY/AWS/GH_TOKEN görüyordu (tek savunma `validateBashCommand` allowlist'i). Artık
  `env:{...safeEnv(), LC_ALL:"C"}` (defense-in-depth; diğer 7 spawn'la tutarlı). (2) **`--allowedTools` argv tek
  konvansiyon (SPREAD):** `claude --help` doğrulandı — `<tools...>` variadic; `cli-run` allowedTools'u `join(" ")`
  veriyordu (boşluklu desen `Bash(rm *)` bozulur), `cli-backend` ikisini de join. Hepsi cli-session gibi SPREAD'e
  geçti (her tool ayrı argv) → tool-kısıtı/sandbox yanlış uygulanması giderildi.
- **fix(kod-analiz B3 — false-pass / "yeşil ama atlanmış" deliklerini kapat) [audit]:**
  (1) **harness-verdict false-green:** `isSecuritySkip` sabit isim-listesi (csp/secret-scan/semgrep)
  `security-headers`/`data-sanitization`/`web-security` skip'lerini KAÇIRIYORDU → güvenlik fazı atlansa bile PASS
  verilebiliyordu. Artık **Faz 13 = güvenlik fazı** semantiğine bağlı (oradaki her `-skipped` güvenliktir,
  mechanical-runner skip'leri `phase=phaseId` yazar) — drift-proof. (2) **Faz 8 gate:** `iterStartTs` artık
  `state.iteration_started_at`-öncelikli (resume de bunu kullanıyor); eskiden uzun iterasyonda `iteration-N-start`
  marker'ı 1500-tail'den taşarsa eski iterasyonun tdd-green'leri sayılıp gate yanlış geçiyordu. (3)
  **`phase-09-complete`→`phase-9-complete`** (phase-9.ts + phase-registry required_audits): resume-detection
  padding'siz `phase-${n}-complete` kuruyor; eşleşmiyordu → Faz 9 boot-resume'da gereksiz tekrar koşuyordu. (4)
  **Faz 7 skip structured-öncelikli:** `has_database===true→KOŞ, false→SKIP, undefined→heuristic` (eskiden OR ile
  LLM "DB var" dese de regex tutmazsa atlıyordu); heuristic regex'e mongo/redis/nosql/orm/persist eklendi.
- **fix(kod-analiz B2 — SDK timeout regresyon sınıfını kapat) [audit]:**
  list_models'ı vuran SDK 0.102 kısa-default-timeout yalnız `models.ts`'te yamanmıştı; `runTurn` (codegen/
  orchestrator/relevance/project-type'ın hepsi), `translator`, `conversation-context` hâlâ açıktı. **Tek factory**
  `makeAnthropicClient(apiKey, {timeoutMs, maxRetries, betas})` (claude-api.ts) eklendi, 4 çağrı yeri ona geçti:
  runTurn → 600sn timeout + `maxRetries:0` (dış retry loop zaten var → çift-retry önlendi) + betas header; models →
  20sn; translator/conversation-context → 60sn + SDK retry. Ayrıca `isTransientError`'a SDK timeout deseni
  (`APIConnectionTimeoutError`/`Request timed out`/`Connection error`) eklendi — eskiden uzun Opus turu timeout'a
  takılırsa attempt 1'de NON-transient sayılıp faz sert fail ediyordu; artık retry'lanıyor.
- **fix(kod-analiz B1 — yaşam-döngüsü kilidi + orphan) [18-ajan audit, KOD-ANALIZ-RAPORU.md]:**
  Kontrol kaybı hissinin #1 yapısal kaynağı. (1) `runController(pX, fn)` helper'ı eklendi; `advanceToNextPhase`'in
  TÜM faz siteleri (p1/p2/p3/p4/**p5**/p6/p7/p8/p9) + p1 resume siteleri buna geçirildi → controller throw ederse
  (SDK timeout/ağ) `runtime.controller=null` artık `finally`'de GARANTİLİ; eskiden atlanıp sistem kalıcı "faz zaten
  çalışıyor" kilitleniyordu. Faz 5 ayrıca hiç `runtime.controller` atamıyordu (abort çalışmıyordu) — düzeldi. (2)
  `gracefulShutdown(reason)` tek-nokta: SIGTERM/SIGINT/stdin-close/shutdown-IPC artık dev-server + runtime HTTP +
  error-watcher'ı kapatıp çıkıyor (eskiden düz `process.exit(0)` → 5173 + listener'lar zombi kalıp port çakıştırıyordu).
  (3) verify-feature: dev-server yeni başlatılınca PID HEMEN persist ediliyor → ara adım throw etse de orphan kalmıyor.
- **fix(macOS izin pencerelerinin ASIL kaynağı: `claude update` claudeSpawnEnv'i baypas ediyordu):**
  YZLLM'in içgörüsü doğru çıktı: claude'u terminalde çalıştırınca izin çıkmıyor ama MyCL'de çıkıyordu →
  kaynak FAZ-1 claude'u değil. [claude-updater.ts:67](orchestrator/src/claude-updater.ts) startup'ta
  `spawn(claudeBin, ["update"])`'i **`env: claudeSpawnEnv()` OLMADAN** çağırıyordu → disable bayraklarım
  (AUTO_CONNECT_IDE/DISABLE_ATTACHMENTS) bu spawn'a HİÇ ulaşmadı; üstelik `claude update` claude'u tam modda
  (headless `-p` değil) başlatıp TÜM taramaları (IDE/tarayıcı/klasör/medya→Apple Music) yapıyordu. **Fix:**
  updater spawn'ına `env: claudeSpawnEnv()` eklendi (NONESSENTIAL_TRAFFIC çıkarıldı ki güncelleme ağı çalışsın).
  Artık startup-update de taramasız → izin pencereleri kaynağında kesilir.
- **fix(macOS izin pencereleri 2: klasör taramasını da kapat — DISABLE_ATTACHMENTS):**
  AUTO_CONNECT_IDE=0 IDE/tarayıcı taramasını kestiyse de "Belgeler/İndirilenler" izinleri sürdü — ayrı yol:
  claude'un `KR7` fonksiyonu `{HOME/Desktop/Documents/Downloads}` haritasını kurup **dosya-ekleme (attachment)**
  özelliği için dokunuyor (yanında MAX_FILE_SIZE 512MB/MAX_FILE_COUNT/COMPRESSION_RATIO limitleri). MyCL claude'a
  dosya-ekleme yaptırmıyor → `claudeSpawnEnv`'e `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` eklendi (claude bununla çalışır,
  doğrulandı ATTACH_OK) → klasör taraması kaynağında kesilir. NOT: teşhis sırasında büyük binary'de `strings`'i
  eşzamanlı koşturmak makineyi çökertti → bundan sonra ağır/eşzamanlı tarama yok (bkz. memory feedback_resource_careful).
- **fix(macOS izin pencerelerinin GERÇEK kaynağı: claude IDE oto-bağlanma taraması):**
  Whack-a-mole çözüldü: claude binary'sinde **ComputerUseSwift** + IDE oto-bağlanma var — `InstalledApps`
  (kurulu uygulama enum → "Apple Music"), Chrome/Brave/Edge `DevToolsActivePort`, DESKTOP/DOCUMENTS/DOWNLOADS
  tarıyor → macOS her korumalı kaynak için ayrı TCC izni soruyor (önce tarayıcı, sonra Downloads, sonra Music...).
  Bu claude'un KENDİ taraması — MyCL'in `--settings` sandbox'ı kapsamıyor + her deploy ad-hoc imzayı değiştirip
  TCC'yi sıfırlıyordu. **Çözüm:** `claudeSpawnEnv`'e `CLAUDE_CODE_AUTO_CONNECT_IDE=0` + `CLAUDE_CODE_DISABLE_
  NONESSENTIAL_TRAFFIC=1` eklendi — MyCL claude'u HEADLESS sürüyor, IDE'ye bağlanma/gereksiz trafiğe ihtiyacı yok →
  tarama yapılmaz → TCC prompt'u çıkmaz. claude'un bu env'lerle sorunsuz çalıştığı doğrulandı (ENVTEST_OK).
  (binary strings ile teşhis: AUTO_CONNECT_IDE gate + InstalledApps/DevToolsActivePort.)
- **fix(görünür hataları temizle: graceful degradation + A2 geri-al):**
  Kullanıcı Cmd+Q ile tam yeniden başlattı → relevance fix aktif ama hata sürüyor → deployed-bağlamda claude-CLI
  çağrısının kendisi düşüyor (exit=1 / parse-edilemez; harness'te üretilemedi). Relevance NON-kritik (bağlamsız
  devam) ama KIRMIZI alarm gösteriyordu. **Değişiklikler:** (1) **A2 geri-alındı** — agent-sandbox darwin App-Data
  (~/Library/{Containers,Application Support,Group Containers}) denyRead bloğu kaldırıldı: izin penceresini ÇÖZMEDİ
  (tetik claude'un KENDİ tarayıcı taraması — Chrome/Brave/Edge DevToolsActivePort; claude-içi, sandboxlanamaz) +
  claude'un kendi ~/Library/Application Support/ClaudeCode verisini riske atıyordu (denyCount 12→9, kanıtlı sandbox).
  (2) **relevance-engine** başarısızlıkta `emitError` (kırmızı) → yumuşak system notu ("ℹ️ Geçmiş bağlam alınamadı;
  akış etkilenmez"). (3) **classifier.scoreBatchViaCli** BİR KEZ retry (geçici exit=1/timeout/truncation) + parse
  hatasında ham çıktının başını log'lar (deployed-bağlam teşhisi). (4) **list_models** iki `emitError` → log.warn
  (non-kritik dropdown). **İzin penceresi:** claude'un tarayıcı taraması MyCL'den bastırılamıyor → kullanıcı bir kez
  "İzin Verme" (işlevi bozmaz, macOS hatırlar) + bu SON deploy'dan sonra rebuild durur (ad-hoc imza churn'ü TCC'yi
  sıfırlıyordu). 940+ test yeşil.
- **fix(list_models "Request timed out" — SDK 0.102 timeout regresyonu):**
  SDK yükseltmesinden (0.40→0.102) sonra startup'ta `list_models failed: Request timed out` çıkıyordu
  (`client.models.list()` geçici API/ağ yavaşlığında 0.102'nin daha kısa varsayılan timeout'uyla patlıyordu;
  0.40 toleranslıydı). `models.list()` aslında çalışıyor (test: 10 model 1.1s) — sorun transient timeout. **Fix:**
  `models.ts` Anthropic client'ına AÇIK `timeout: 20_000` + `maxRetries: 3` → SDK timeout/429/5xx'te otomatik
  retry yapar, geçici hata sessizce atlatılır. (SDK bump regresyonunun düzeltmesi.)
- **fix(relevance CLI prompt-çelişkisi → "no valid relevance_scores block"):** Abonelik/CLI
  modunda relevance classifier hata veriyordu (trace.log: `cli classifier: no valid relevance_scores block`).
  **Kök neden:** `classifier.ts` SYSTEM_PROMPT'u "Output via the score_chunks **tool**" diyordu (API için), CLI
  yolu buna `CLI_JSON_INSTRUCTION` ("**Do NOT call any tool**, output JSON") EKLİYORDU → ÇELİŞKİ → sonnet-4-6
  `{"kind":"relevance_scores"}` bloğunu üretmiyordu. **Fix:** `SYSTEM_PROMPT_BASE` (çıktı-talimatsız) ayrıldı;
  API tool-suffix, CLI text-JSON-suffix ALIR (çelişki yok). `parseCliScores` dayanıklılaştı (kind eksikse bile
  `scores[]` içeren bloğu kabul eder, `extractLastJsonObject`). **CANLI doğrulandı** (sonnet, gerçek skorlama:
  ilgili chunk 9, alakasız 0). 61 relevance testi yeşil.
- **fix(macOS "başka uygulama verisi" izin penceresi):** macOS TCC prompt'u
  "MyCL Studio diğer uygulamalardaki verilere erişmek istiyor" çıkıyordu. **Kök neden:** agent-sandbox darwin'de
  `Library` runtime-allow'da (Caches/Playwright için gerekli) → sandboxlı claude ~/Library altında BAŞKA
  uygulamaların verisine (~/Library/{Containers, Application Support, Group Containers}) erişebiliyordu. **Fix:**
  bu 3 "App Data" alt-yolu agent denyRead'ine eklendi (darwin); `Library` KÖKÜ açık kalır (Caches/Preferences/
  Playwright çalışır). claude'un ~/Library'siz auth+okuma yaptığı ampirik doğrulandı; denyCount 9→12. **NOT:**
  TCC prompt'u yalnız gerçek macOS GUI'de doğrulanır (headless değil) + tetikleyici kısmen `claude update`
  (unsandboxed, her açılış) olabilir → YZLLM yeni build'de teyit etmeli; sürerse auto-update tarafına bakılır.
- **fix(rate-limit yanlış-pozitif: "allowed_warning" ≠ bloklu):** Kullanıcıda
  "🔁 abonelik limiti doldu (seven_day) → API'ye geçildi" + ardından "relevance scoring failed" çıkıyordu AMA
  limit dolu değildi. **Kök neden (web+kod doğrulandı):** Claude Code `rate_limit_event.status` sözlüğü
  `{allowed, allowed_warning, rejected}` — `allowed_warning` = istek SERVİS EDİLDİ (sadece limite-yaklaşma
  uyarısı), yalnız `rejected` = bloklandı. `isBlockedStatus` "allowed olmayan her şeyi bloklu" sayıyordu →
  seven_day `allowed_warning`'i "limit doldu" sanıp gereksiz API'ye düşüyordu → relevance API'de (anahtar yok)
  patlıyordu (failure'ın DOĞRUDAN sebebi). **Fix** (`cli-rate-limit.ts`): `isBlockedStatus` artık YALNIZ
  `rejected`'i bloklu sayar; `allowed`/`allowed_warning`/bilinmeyen → bloklanma (bilinmeyen yalnız gözlem-loglanır,
  yanlış fallback yok). `overageStatus` kullanılmıyor (yanıltıcı). Gerçek `rejected` blok regresyonu korundu
  (hâlâ fallback + "limit doldu" mesajı). +allowed_warning/bilinmeyen regresyon testleri (28 test). RateLimitInfo
  yorumu sözlüğe göre güncellendi (seven_day_opus/sonnet dahil).
- **security(least-privilege: yalnız gerekli Tauri izinleri):**
  `src-tauri/capabilities/default.json` plugin izinleri `:default` setlerinden frontend'in GERÇEKTEN çağırdığı
  alt-izinlere daraltıldı (kaynak doğrulandı): `dialog:default`→`dialog:allow-open` (yalnız Splash dosya seçici);
  `opener:default`→`opener:allow-open-url`+`allow-default-urls` (ChatPanel openUrl; scope http/https localhost
  dev linkleri); `notification:default`→yalnız `notification:allow-is-permission-granted`. **Kritik bulgu:**
  `requestPermission`/`sendNotification` Tauri komutu DEĞİL, web Notification API'si (`window.Notification`)
  kullanıyor → Tauri izni gerekmez (kaynak okundu). DROP: dialog save/message/ask/confirm, opener
  open-path/reveal-item-in-dir, notification notify/request-permission/channels/listeners/cancel/get-active vb.
  (15+ kullanılmayan izin). core:* (window/webview/app/path/resources/event) çerçeve tabanı korundu (düşük-
  hassasiyet, çerçeve gereği). **`cargo check` ile gerçek Tauri ACL resolver'ında doğrulandı** (npm run check
  ACL'yi doğrulamaz). Yeni izin istemiyor, mevcutları kısıyor → kullanıcı işlevselliği aynı, saldırı yüzeyi daraldı.
- **style(orkestratör çıktısı: cümleler arası boş satır):** orchestrator-system.md "## 12. Tone"
  bölümüne "Sentence spacing" alt-kuralı eklendi — orkestratör ajanı `reason` (chat) çıktısında birden çok cümle
  yazınca her cümleyi 1 boş satırla ayırır (chat panelinde ayrı paragraf → okunaklı). Yalnız BİÇİM; mevcut
  "max 1-2 cümle" sınırı korunur. (Bu seansta YZLLM'in benden istediği biçimi orkestratöre de taşıma.)
- **fix(API effort) + feat(maliyet toplama, 1h cache) [F1/F2/F3; Claude Code geçmiş-taramasından, plan onaylı]:**
  Geçmiş-tarama workflow'undan (350 özellik) seçilen 3 özellik; F4 (hooks/auto-mode) ertelendi. Ortak ön koşul:
  **`@anthropic-ai/sdk` 0.40.1 → 0.102.0** (output_config/adaptive-thinking/cache_control.ttl gerektiriyor;
  kurulum sonrası 3-tip .d.ts gate'i + tsc temiz doğrulandı).
  - **F3 (DOĞRULANMIŞ BUG FIX):** Opus 4.8 (varsayılan model) `thinking:{type:"enabled",budget_tokens}`'i artık
    **400 ile reddediyor** → geçen hafta gönderdiğimiz ultracode-API yolu API modunda KIRIKTI. `claude-api.ts`
    `thinkingConfigFor` model-koşullu yeniden yazıldı + yeni saf `modelSupportsAdaptive` (Opus 4.7+): adaptive
    modeller → `thinking:{type:"adaptive"}` + `output_config:{effort}` (forced tool_choice'ta İKİSİ DE yok = 0
    risk; ultracode→effort:"max"); eski modeller → legacy budget_tokens (mevcut davranış korunur). **Yan etki:**
    ultracode-DIŞI effort (low..max) artık API'ye GEÇİYOR — eskiden sessizce düşüyordu; effort=max default'u API'de
    artık onurlanır (maliyet ↑ olabilir, Settings'ten düşürülebilir). 12 test.
  - **F1 (DOĞRULANMIŞ BOŞLUK + USD):** `recordTokenUsage` yalnız API yolundan çağrılıyordu → abonelik/CLI modunda
    faz-maliyet kovası HİÇ dolmuyordu (panel boştu). Üç CLI koşucusu (`cli-run`/`cli-session`/`codegen/cli-backend`)
    artık result'ta `recordTokenUsage`'ı `total_cost_usd` (gerçek $) + `model` ile çağırır. `CostRecord` += opsiyonel
    `total_cost_usd`/`model`/`model_usage` (JSONL additive, migration yok). API yolu USD vermez → undefined (uydurma $
    yok). `TokenTimelinePanel` $ + model + per-model dökümü gösterir (karışık session'da "yalnız CLI fazları" notu).
    **CANLI doğrulandı** (abonelik gerçek $0.115 döndürdü). 5 test.
  - **F2 (opt-in 1h cache):** `claude_code_flags.cache_ttl` ("5m" default | "1h"). API: saf `buildCacheControl` →
    `cache_control.ttl:"1h"`. CLI: `setCacheTtl` modül-singleton (setSandboxPolicy deseni) → `claudeSpawnEnv`
    `ENABLE_PROMPT_CACHING_1H=1`. Settings'te "Prompt cache ömrü" seçici. 5 test.
  - **NOT (scope):** API yolu (adaptive/output_config/1h-ttl gerçek kabulü) CLI-only test düzenimizde canlı
    doğrulanamadı (no-API-test kuralı) → model-koşullu + konservatif (forced→thinking yok) + tip/test güvencesi.
  - 934 test yeşil; SDK majör sıçraması mevcut çağrıları kırmadı (tsc temiz).

## 2026-06-06

- **feat(Faz 0 Bash-inceleme: kanıta-dayalı hipotezler) [WS2; ultracode-3, minimal varyant A]:** `agent_teams_optin`
  açık + main backend **CLI/abonelik** iken, Faz 0 D1'den ÖNCE çok-perspektifli kök-neden **İNCELEMESİ** koşar —
  yeni `hypothesis-investigation.ts` `runHypothesisInvestigations`: 3 mercek (state-data/async-timing/integration,
  `HYPOTHESIS_ANGLES` design-fanout'tan reuse) PARALEL `runClaudeCli` ile, her biri `allowedTools:[Read,Grep,Glob,
  Bash]` + `disallowedTools:[Write,Edit,MultiEdit,NotebookEdit]` → kodu GERÇEKTEN okur/arar (akıl-yürütme fan-out'unun
  Bash'li kardeşi; saf kuzeni Bash YOK). Çıktı text-JSON `{kind:"hypothesis"}` → D1 user message'ına enjekte; **D1 yine
  NORMAL koşar** (report_root_cause/D2 değişmez = regresyon-güvenli). **API modu** mevcut saf-akıl-yürütme fan-out'unu
  KORUR (parite; backend-branch). MyCL-native fan-out (Promise.allSettled × N) — claude'un kendi Agent Teams'i değil.
  Maliyet guardrail: gate + N=3 + per-inceleme idle-timeout. **CANLI doğrulandı** (abonelik, sandbox-off harness;
  16.6s'de 3 mercek de buggy `counter.js`'i tam satır numarasıyla buldu — `notify()` count++'tan önce çağrılıyor;
  E2BIG YOK). +5 test, 924 yeşil. **Not:** harness'te enforce-sandbox E2BIG'i (WS1) yüzünden canlı test sandbox-off
  ile yapıldı; ÜRETİM "enforce" kalır (kullanıcıda claude Bash çalışıyor). Pure-CLI'da rate-limit+API-key yoksa
  inceleme zarifçe atlanır (<2 → D1 normal).
- **feat(spec gate: ui_complexity tier) [WS3; ultracode-3]:** Faz 2 sınıflandırıcısı artık projeyi UI
  karmaşıklığına göre de etiketler (`simple`/`moderate`/`complex`) — `has_database` desenini birebir izler:
  TOOL_DEF.input_schema'ya `ui_complexity` enum (required'a EKLENMEDİ = geriye-uyumlu) + SYSTEM_PROMPT guidance
  + CLI text-JSON instruction + `ProjectClassification.ui_complexity` + hem CLI hem API extract (fail-soft
  `parseUiComplexity` → geçersiz/eksik = undefined). `phase-2.ts` koşullu-merge ile `state.ui_complexity`'e
  yazar. `types.ts` `UiComplexity` tipi + `State.ui_complexity`. `state-migrations.ts` v3→v4 no-op migrator
  (eski state'ler undefined kalır). **Faz 5 tasarım paneli gate'i:** karar saf `design-panel-gate.ts`
  `designPanelDecision` → "run"/"skip-simple"/"off"; yalnız `ui_complexity==="simple"` → çok-perspektifli panel
  ATLANIR (tek-ajan tasarım + görünür bilgi mesajı), undefined/moderate/complex → panel KOŞAR. **Regresyon yok:**
  flag "off" → "off"; ui_complexity undefined → "run" = eski davranış birebir (yalnız "simple" yeni dal).
  +14 test (classifier extract/fail-soft, v3→v4 migration, design-panel-gate 9 durum). 919 test yeşil.
- **fix(agent-sandbox denyRead dir-only + brace-trap belgele) [WS1; ampirik /tmp testleri]:** macOS'ta
  `buildAgentSandboxSettings` denyRead'i **dir-only** yapar — Seatbelt subpath semantiği bir dizini reddederken
  içeriğini de reddeder (V3: dir-only "secret" → "secret/data.txt" engellendi), `/**` REDUNDANT → atlamak profili
  ~2x küçültür. Linux (bwrap) subpath semantiği doğrulanmadı → `/**` KORUNUR. `permissions.deny` (prompt-katmanı,
  defense-in-depth) HER İKİ formu korur (yeni ayrı `permDeny` listesi; E2BIG'i etkilemez). **Güvenlik kritik bulgu
  kodda belgelendi:** brace-glob `{a,b}` Seatbelt'te GENİŞLEMEZ (V2 sızdırdı) → denyRead'i glob-compress ETME
  (sessiz açık). **DÜRÜST sınır:** harness'te claude'un per-Bash E2BIG'i (sandbox-exec profil boyutu) bununla TAM
  kapanmaz (harness-özgü — sandbox KAPATINCA Bash çalışıyor; ÜRETİM zaten çalışıyor); WS2 canlı doğrulaması için
  harness'te `agent_sandbox_policy="off"`, üretim "enforce" kalır.
- **feat(claude oto-güncelleme):** MyCL açılışında
  (App.start) claude CLI'yı arka planda otomatik günceller — yeni `claude-updater.ts` (`autoUpdateClaude`):
  non-blocking (boot'u geciktirmez), feature flag `features.auto_update_claude` (default AÇIK), test/CI/harness'ta
  guard'lı (VITEST/CI/NODE_ENV=test/MYCL_DISABLE_AUTO_UPDATE → çalışmaz; yan etki/non-determinizm yok), yalnız
  GERÇEKTEN güncellenince görünür mesaj, hata yutulur. Saf `interpretUpdateOutput` (exit+çıktı → updated/current/
  failed; "exit 0 ama belirsiz → current" = yanlış mesaj verme) + 4 test. `claude update` resmi+güvenli işlem.
- **feat(orkestratör yetenek farkındalığı):** orchestrator-system.md'ye
  "Multi-agent capabilities (v15.13)" bölümü — design panel (Faz 5 fan-out), Agent Teams çatışma-müzakeresi,
  auto-model tier'ları; Claude Code Workflow/Teams/ultracode eşlemesi. OPT-IN + "audit göstermeden çalıştı DEME"
  (NO HALLUCINATION ile hizalı) → ajan kullanıcıya doğru açıklar, uydurmaz. 905 test yeşil.
- **feat(Faz 0 debug hipotez fan-out) [competing-hypotheses]:** `agent_teams_optin` açıkken Faz 0 D1
  araştırmasından ÖNCE 3 mercekten (state-data / async-timing / integration-contract) PARALEL kök-neden
  hipotezi üretilir (MyCL-native saf-akıl-yürütme, toplanan deterministik kanıt üzerine — Bash YOK;
  hypothesis→balanced tier) → adaylar D1 user message'ına enjekte (audit `debug-hypotheses-generated`); D1
  araştırarak doğrular/çürütür (tünel-görüşünü önler). CANLI doğrulandı (abonelik, 23s, 3 farklı somut
  hipotez; async-timing merceği tek-ajanın kaçırabileceği effect-race'i yakaladı). `agent_teams_optin` artık
  "gerçek çok-ajanlı derinlik" umbrella'sı (tasarım müzakeresi + debug fan-out). Tam paralel-İNCELEME (Bash'li,
  gerçek Workflow tool) harness'te E2BIG yüzünden doğrulanamadığından ileriye bırakıldı. Yeni: design-fanout.ts
  `runHypothesisFanout` + phase-0 wiring.

## 2026-06-05

- **feat(Faz 5 tasarım paneli) [Workflow/Agent Teams entegrasyonu — Faz A]:** Çok-perspektifli DETERMİNİSTİK
  tasarım fan-out'u. CREATE (ilk iterasyon) + `claude_code_flags.design_workflow` ("off" default → geriye uyum;
  "create-only"/"always") açıkken, Faz 5 codegen'den ÖNCE: architect/ux/security/data perspektifleri PARALEL
  (read-only akıl yürütme), her biri `subagent_models`'ten rol-modeliyle (yoksa main; `subagentModelId` helper) →
  synthesizer TEK tasarım planı + `conflicts[]` üretir → `.mycl/design.md` yazılır + audit `ui-design-synthesized`;
  codegen "design.md'yi oku + uygula" ekiyle devam. **İki mod (parite):** API = Anthropic `messages.create`,
  abonelik = `runClaudeCli` (`backendForRole("main")` dispatch; auto limitliyken API'ye düşer). Çıktı text-JSON
  (`extractKindBlock "design_plan"` — forced-tool/CLI asimetrisi yok). **Dürüst fallback:** <2 perspektif veya
  sentez başarısız → görünür mesaj + tek-ajan tasarımıyla devam (sessiz değil; flag "off"ta hiç çalışmaz = regresyon
  YOK). **Mimari karar** (tasarım-paneli workflow wf_308567f0 + 2 referans video): MyCL-native fan-out = Workflow
  Tool'un DETERMİNİZM gücü (en güçlü/kontrollü hâl; `claude-agent-sdk` kurulu DEĞİL → literal Workflow Tool
  `agent()` API'si yok, MyCL-native daha deterministik); gerçek Agent Teams'in İLETİŞİM gücü = çatışma-çözümü
  (Layer B — sonraki: `conflicts[]` + CLI → TeamCreate peer-müzakere; API'de cross-critique turu). Agent Teams
  paralel-YAZAR değil (büyük-dev tek-yazar TDD kalır). Yeni: `design-fanout.ts` (saf `parseConflicts`/
  `parseDesignPlan` + test), `assets/templates/design-{architect,ux,security,data,synthesizer}.md`, config
  `design_workflow` + `subagent_models` + `subagentModelId`. +6 test → 896 yeşil. Etkinleştirme (Layer B): env
  `CLAUDE_CODE_WORKFLOWS=1` (Workflow tool) + `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (claudeSpawnEnv, koşullu).
- **feat(Faz 5 Layer B) [Agent Teams çatışma-müzakeresi]:** Faz A synthesizer'ının döndürdüğü `conflicts[]` +
  `agent_teams_optin` (default false) açıksa: abonelik (CLI) modunda **GERÇEK Agent Teams** (env
  `CLAUDE_CODE_WORKFLOWS=1` + `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, cli-run yeni `extraEnv` ile enjekte)
  çelişen-rol savunucularını **peer-müzakereyle** (SendMessage) uzlaştırır → güncellenmiş `.mycl/design.md` +
  audit `ui-design-negotiated`; API modunda MyCL-simüle cross-critique turu (aynı `design-negotiate.md` template,
  tek-tur muhakeme). Başarısızsa synthesizer'ın provizyon kararı kalır (görünür mesaj, sessiz değil). **Headless
  Agent Teams hem raw hem MyCL-sandbox altında CANLI doğrulandı**: ux↔security (silme: geri-al-toast+gecikmeli-
  kalıcı vs modal) ve architect↔data (optimistik tempId vs server-id) çatışmaları kademeli/hibrit çözümle uzlaştı
  (design.md 12KB'a zenginleşti; ~8dk/2 çatışma = opt-in maliyet). TeamCreate+SendMessage+TeamDelete headless
  çalışıyor. Yeni: `negotiateConflicts` + `design-negotiate.md` + cli-run `extraEnv` + config `agent_teams_optin`.
- **feat(auto-model) [yapılacak işe göre model + auto-agent — YZLLM isteği]:** Fan-out alt-ajan modelleri artık
  OTOMATİK iş-seviyesine göre: config `model_tiers` (strong/balanced/cheap — TAM model id, kullanıcı Settings'te
  seçer → hardcoded SÜRÜM yok) + MyCL rolleri tier'a dağıtır (architect/synthesizer/verifier→strong; ux/security/
  data/hypothesis→balanced). `subagentModelId` çözüm sırası: `subagent_models[role]` açık override > `model_tiers[tier]`
  (otomatik, işe göre) > `main` (regresyon yok). Agent Teams müzakeresinde lead, teammate'leri OTOMATİK seçer +
  her birine işine göre model atar (deep/arbitration→strong, advocacy→balanced; `design-negotiate.md` talimatı).
  Kullanıcı 3 katman modelini BİR kez seçer, MyCL her rolü işine göre otomatik atar. +3 test → 901 yeşil.
- **feat(Settings UI) [çok-ajanlı tasarım kontrolleri]:** Modeller sekmesine "Çok-ajanlı tasarım (deneysel)"
  bölümü — `design_workflow` seçici (off/create-only/always) + `agent_teams_optin` toggle + iş-seviyesi model
  katmanı (strong/balanced/cheap) seçicileri. Mevcut `save_settings`/`selected_models` IPC genişletildi (YENİ
  handler/event YOK): `handleSaveSelectedModels` flag'leri `persistClaudeCodeFlags`'e, `model_tiers`'ı (sel'de)
  `persistSelectedModels`'e yazar; read-event üçünü de geri döndürür. Frontend: events.ts (`ModelTiers`/
  `DesignWorkflowMode` tipleri) + App.tsx (state + reducer + save payload) + Settings.tsx (UI + state). Artık
  config.json elle düzenlemeden GUI'den ayarlanır. frontend typecheck temiz, 901 test yeşil.

## 2026-06-04

- **fix(dev-server) [E2E-bulgusu]:** **Port false-match** — Faz 5 dev-server tespiti, beklenen portta
  (5173) yanıt veren BAŞKA bir app'i (kullanıcının adminpanel'i 5173'ü tutuyordu) kendi sunucusu sanıp
  "✅ dev server hazır, tarayıcı açılıyor" diyordu → tarayıcı + Faz 16 e2e YANLIŞ app'e gidiyordu (todo
  app'in gerçek dev server'ı port-çakışmasından ölmüştü). "Sahte-yeşil yok" ihlali. **Otonom E2E testi
  yakaladı** (canlı kanıt: katman-doğrulama işe yarıyor). Fix (design+adversaryal workflow wf_f36835fe,
  verdict rework→sağlam sentez): `tryDevServerChain` artık YALNIZ spawn-ÖNCESİ BOŞ olan bir portu hedefler+
  probe eder → o porta gelen yanıt ya bizim ya hiç (foreign-port ASLA "bizimki" sayılmaz). Yeni saf
  helper'lar: `isPortFree` (connect-probe 127.0.0.1, bind-TOCTOU yok), `findFreePort`, `augmentPortFlag`
  (CLI-flag ile portu zorla — vite `--port --strictPort`, next `-p`, wrapper'a viteHint ile `-- --port`;
  PORT env'i vite yoksaydığı için flag şart; tanınmayan→null=fail-closed). `spawnDevServer`'a event-driven
  `child.on("exit")` (shell:true wrapper pid'i güvenilmez → pid-poll yerine exit-event); `waitForDevServer`
  exited-flag'de erken çıkar + host `localhost`→`127.0.0.1` (IPv6 ::1 false-negative latent bug). İmzalar
  korundu (geriye-uyum: phase-5/smoke-test/verify-feature değişmeden çalışır). adminpanel açıkken bile todo
  app boş portta temiz koşar. +10 test (flag matrisi + false-match entegrasyonu: foreign server portu
  tutarken chain boş porta zorluyor, foreign'a dokunmuyor).
- **fix(API-yolu paritesi) [E2E API-trace bulguları]:** API-backend kod-yolu çift-doğrulama workflow'u
  (wf_9a83bb03) gerçek bulguları (dedup "HIGH" YANLIŞ POZİTİF çıktı — ölü kod): (1) **verify-feature** codegen
  `failed`/`aborted` outcome'unu yutup "özellik bulunamadı" diyordu → artık "codegen başarısız" (dürüst,
  ayrı audit event). (2) **relevance CLI score-coercion**: ajan elle-JSON'da `"8"`/`"7/10"` yazınca skor
  sessizce 0'a düşüp recall'dan kaybolıyordu → parseFloat coerce (API↔CLI parite). (3) **CLI orkestratör
  clarify_options**: proaktif-risk somut-seçenekleri CLI talimatında yoktu → eklendi. Ertelendi (not):
  1M-context beta model-gating (API-only, riskli fix), error-analysis API-modu (görünür-mesajlı, CLI-only).
  +4 test.
- **fix(abonelik-paritesi):** Saf-abonelik (tüm roller CLI) modunda relevance (recall sıralaması) +
  konuşma-özeti ARTIK atlanmıyor — proje-tipindeki (v15.10 `classifyViaCli`) kanıtlı **text-JSON CLI**
  desenine taşındı. — haklı: bu
  yarım kalmış migrasyondu (forced-tool API-only sanılıyordu). Üstelik konuşma-özeti zaten forced-tool
  DEĞİL düz-metin SDK çağrısıydı (mesajdaki "zorlanmış-tool" gerekçesi yanlıştı). Değişiklik: (a)
  `relevance/classifier.ts` → `scoreChunksViaCli` + saf `parseCliScores` (extractKindBlock +
  mevcut `mergeScoresWithChunks` reuse); `relevance-engine.ts` erken-skip kalktı, scoring adımı
  backend'e göre route (abonelik→CLI, aksi→SDK forced-tool); (b) `conversation-context.ts` →
  `generateSummaryViaCli` (düz-metin `runClaudeCli`), abonelik skip'i kalktı; (c) `subscription-mode.ts`
  → `noteSubscriptionSkipOnce` + "atlanıyor" mesajı SİLİNDİ (artık atlama yok; `isSubscriptionMode`
  yalnız routing). Abonelik = tam recall/bağlam paritesi (MyCL "hiçbir şeyi unutmuyor" + "sessiz
  fallback yok"). Tradeoff: abonelikte recall başına ~1 `claude -p` (Haiku, batched) — birkaç sn
  gecikme + abonelik limiti; cache + batch mevcut. +7 test (parseCliScores parse vektörleri + CLI-özet
  parite/fail-safe). `npm run check` yeşil (878 test).
- **feat(WP4) [DAST]:** Composer'da 🛡️ **Güvenlik Taraması** butonu — çalışan localhost uygulamasına
  onay-gated aktif DAST (nuclei). YENİ ÖZELLİK (). design+SERT-adversaryal-güvenlik workflow (wf_3ebf64a7, verdict: rework → bu güvenli sentez).
  İnceleme 3 güvenlik-kritik tuzak yakaladı; hepsi kapatıldı:
  - **Onay-baypası imkânsız:** buton DOĞRUDAN taramaz — `handleRunDastRequest` yalnız açıklama+onay askq'ı
    açar; `runDast` TEK yerden (handleAskqAnswer `pendingDast` branch, KATI eşleşme `askqId===id &&
    selected==="🛡️ Başlat"`, branch'e girince hemen `pendingDast=null` → çift-tık/re-entrancy kapalı)
    çağrılır. emitAskq DOĞRUDAN (qa-askq/auto-answer yolundan GEÇMEZ → Oto-cevap bu onayı otomatikleyemez;
    doğrulandı: askApproval zaten `suggested=null` ile auto-answer'ı tetiklemiyor).
  - **Localhost-kaçağı kapalı:** saf `isLocalhostTarget()` (WHATWG URL parse + literal allowlist
    localhost/127.0.0.0-8/::1 + IPv6-bracket-strip; userinfo/http-dışı-protokol/0.0.0.0/suffix-host
    `localhost.evil.com` → fail-closed RED). decimal/hex/octal IP WHATWG'de 127.0.0.1'e normalize (gerçekten
    loopback → güvenli). Hedef URL'i BİZ kurarız (`http://localhost:PORT`, host config'ten okunmaz); gate
    defansif son-kapı. 12 saldırı-vektörü testi.
  - **Hang/orphan/DoS yok:** spawn detached (process-group) + sabit 120s timeout → `killProcessTree` (tree-kill,
    orphan yok); muhafazakar non-destructive nuclei (`-rate-limit 10 -timeout 5 -exclude-tags intrusive,dos,fuzz
    -no-interactsh -severity low..critical`); maxBuffer cap; bulgular chat'e sanitize edilerek (markdown/log
    injection) basılır.
  - **Araç-eksik fail-closed:** nuclei oto-İNDİRİLMEZ (raw-binary supply-chain riski) — `command -v nuclei`
    yoksa GÖRÜNÜR hata + kurulum talimatı + DUR (sessiz-skip/sahte-yeşil YOK). Platform mac+linux; win32 →
    görünür "desteklenmiyor".
  Yeni `dast-runner.ts` (saf isLocalhostTarget+parseNucleiJsonl test-edilebilir) + run_dast IPC + ChatPanel
  butonu + App.tsx. Spinner mevcut phase_running/idle banner'ından türetilir (yeni frontend state yok).
  `npm run check` yeşil (871 test). nuclei flag-uyumu ilk gerçek koşumda doğrulanmalı (fail-closed: yanlış
  flag → görünür hata, kilitlenme değil).
- **feat(WP3) [kalite-boyutları]:** a11y + i18n + contract + resilience (design+adversaryal workflow,
  wf_b73b3b8f). 5-ajanlı inceleme her boyutu süzdü; memory kurallarıyla (yokluk-tespiti=FP tuzağı,
  minimal-dep, duplikasyon-yok) uyumlu net karar:
  - **a11y → ENTEGRE (tek mekanik kazanç, pozitif-check):** `@axe-core/playwright` (Deque resmi) Faz 16
    Playwright smoke spec'ine enjekte (`playwright-setup.ts` `renderSmokeSpec`) — çalışan DOM'u WCAG ile
    tarar. YALNIZ critical+serious fail (minor/moderate rapor-only, FP-fırtınası önlenir). Paket yoksa
    değişken-specifier dynamic import + try/catch → görünür-skip (compile/runtime kırılmaz). Faz 16 SOFT
    → projeyi kırmaz; has_ui+project_type otomatik gating. ensurePlaywrightInstalled axe'ı Playwright ile
    BİRLİKTE kurar + idempotency artık İKİ paketi de kontrol eder (eski "axe hiç kurulmaz" bug'ı). Scaffold
    marker v15.8→v15.9 (eski smoke'lar refresh). + phase-05-ui.md a11y guidance (semantic-HTML/ARIA-son-çare/
    klavye/form/kontrast, stack-nötr). +1 test.
  - **resilience → ENTEGRE (guidance-only, mekanik check YOK — yokluk-tespiti FP-prone):** phase-08-tdd.md
    (timeout/bounded-retry/graceful-degradation/input-validation, WP2 hata-handler'ına bağlanır, IDE-ölçek
    DEĞİL chaos-eng) + phase-05-ui.md (her async UI için loading/error/empty üç-durum + retry affordance,
    mevcut ErrorBoundary'ye bağlanır).
  - **contract → guidance-only güçlendirme:** phase-08-tdd.md'deki mevcut "API contract" satırı somutlaştı
    (request/response-shape, status-code matrisi 201/400/401/403/404, error-envelope tutarlılığı, OpenAPI
    yalnız dosya varsa). Yeni dep/runner YOK — mevcut integration testine yazılır (Faz 15 koşar).
  - **i18n → mekanik DROP (hardcoded-string check yokluk-tespiti FP-tuzağı; react-i18next dayatma minimal-dep
    ihlali):** sadece hafif koşullu guidance (phase-05-ui.md) — merkezi metin (t("key")), Intl ile biçimleme,
    RTL-hijyeni, "iskelet değil çeviri" + tek-dil ise framework EKLEME.
  `npm run check` yeşil (859 test). Yeni dep yalnız @axe-core/playwright (üretilen UI projelerinde, dev-dep).
- **feat(WP2) [observability]:** Üretilen uygulamaya gözlemlenebilirlik — codegen guidance
  (design+adversaryal workflow, wf_7eee4df7). Adversaryal inceleme 3 gerçek tuzak yakaladı, hepsi
  doğrulanıp uygulandı: **(a) yeni semgrep silent-catch kuralı YAZILMADI** — `tech-debt-scanner.ts`
  empty_catch zaten Faz 8/9'da yakalıyor (yorumlu/best-effort catch'i meşru bırakacak şekilde ayarlı;
  daha geniş kural JSON.parse-fallback/retry/cleanup'ı yanlış yakalar = FP-fırtınası). **(b) Faz 13'e
  KOYULMADI** — orada her -fail blocking (observability güvenlik değil, app'i kırmaz). **(c) yeni
  hata-izleme guidance YAZILMADI** — errors.db/recordError/ErrorBoundary/log-error/Hata-Kodları uçtan
  uca zaten var (duplikasyon olurdu). Net katkı yalnız GERÇEKTEN eksik iki parça (templates'te logger/
  pino/winston/health hiç geçmiyordu — doğrulandı): **yapısal logging** (sıfır-dep console-wrapper;
  pino opsiyonel; stack-nötr React/Vue/Svelte/Express/Fastify/Nest/Next/FastAPI/Flask/Django) +
  **health endpoint** (`GET /health`→200, backend-koşullu; static SPA'da üretilmez). phase-05-ui.md
  (frontend logging + silent-catch, mevcut ErrorBoundary'ye bağlanır) + phase-08-tdd.md (backend
  logging + health + merkezi hata-handler recordError'a bağlanır + stack-sızıntı testi, TDD-RED).
  Mekanik gate EKLENMEDİ (mevcut empty_catch yeterli — over-engineering'den kaçınıldı). `npm run check`
  yeşil (858 test). Not: e2e harness çıktısında WP1'in `pipeline_end` event'i (verdict:PASS) görünüyor.
- **fix(WP1) [katman-denetimi]:** Tüm katmanların gerçekten kaliteli çalıştığını doğrulama programı
  (). 5-ajanlı adversaryal denetim 6 GERÇEK
  bug buldu (kanıtlı) → hepsi düzeltildi + regresyon testi + `npm run check` yeşil (858 test):
  - **(1) Test izolasyon kaçağı (kanıt: gerçek hasar):** `agent-memory/store.test.ts` credential-warning
    bloğu `MYCL_HOME` izole etmiyordu → her test koşusunda GERÇEK `~/.mycl/agent-memory-general.jsonl`'e
    sahte `sk-ant-…` + `password=…` satırları yazıyordu (618 satır birikmiş; orkestratör recall'ına
    sızıyordu). Kirli dosya yedeklenip temizlendi; teste temp-`MYCL_HOME` izolasyonu eklendi.
  - **(2) Dev-server orphan:** 3 nokta (yeni-iterasyon reset / Faz-2-abandon / Faz-5-respawn) eski
    `dev_server_pid`'i sadece `undefined` yapıyordu → process orphan + port çakışması. Tek doğruluk
    kaynağı `stopActiveDevServer(state)` helper'ı (kill+watcher-detach) eklendi; 3 site + smoke-test'in
    2 kopyası ona indirgendi. +3 test (gerçek detached child spawn → kill doğrulanır).
  - **(3) Gate-fail dürüstlük (YZLLM'in #1 endişesi "sessizce TAMAMLANDI deme"):** mekanik gate'ler SOFT
    olduğundan akış-sonu özeti gate patlasa bile "Akış tamamlandı" diyebiliyordu. `computeVerdict`
    audit'ten gerçek hükmü çıkarıyor → saf `pipeline-end-summary.ts` (gate-fail fazlarını listeler +
    güvenlik-skip + "KISMÎ/BAŞARISIZ — doğrulandığını söyleyemem"). Yeni `pipeline_end` event'i frontend'e
    taşır: PhaseSidebar başarısız gate'lere ordinal ✅ yerine ⚠️ basar; AppHeader kısmî/başarısız çipi.
    +9 test.
  - **(4) Deferred Faz 6 boot-resume:** boot-resume `advanceToNextPhase(5)` Faz-5 dev-server spawn'ını
    atlıyordu → Faz 6 hem "dev server çalışmıyor" hem "tarayıcıda açıldı" çelişkili mesajı veriyordu.
    Phase6Controller artık canlılık kontrolü yapıp ölüyse `restartDevServerSimple` (eskiden atıl) ile
    yeniden başlatır + mesajı dürüstleştirir; güncel pid persist edilir.
  - **(5) Resume scope tail-bağımlılığı:** `detectInterruptedPhase2To9` audit tail'i (son 300) uzun
    iterasyonda `iteration-N-start`'ı kaçırınca scope=0'a düşüp önceki iterasyonun complete'ini "tamamlandı"
    sayıp resume'u atlıyordu (deferred Faz 6 takılırdı). `state.iteration_started_at` persist edildi;
    karar mantığı saf `resume-detection.ts`'e çıkarıldı (audit fallback eski state'ler için). +6 test.
- **feat(security) [tamamlık-2]:** Kalan dedicated güvenlik kontrolleri (). (1) `assets/security-rules/web-security.yml` (semgrep, validate+fixture'lı):
  **CORS** wildcard (`*`/`origin:true`/`Access-Control-Allow-Origin:*`) + **cookie** güvensiz
  (httpOnly/secure eksik veya `false`) + **CSRF** (`sameSite:'none'`) — allowlist-CORS + tam-güvenli
  cookie hariç (fixture'da 4 bulgu / 2 güvenli-atlama doğrulandı). (2) **gitleaks** secret-scan
  (semgrep p/secrets'e ek, daha özel entropy+regex) — `detect --no-git` (v8'in tüm sürümlerinde
  çalışır); kurulu değilse 127→skip, leak→blocking. İkisi Faz 13 extra_scan, tool_error_codes:[2].
  (3) **check.sh adım 6/6:** custom semgrep YAML'larını `semgrep --validate` eder (semgrep varsa) —
  bozuk kural Faz 13'ü SESSİZCE düşürmesin (tam senin endişen: güvenlik sessizce kaybolmamalı);
  semgrep yoksa atlanır (CI'yı kırmaz). CSP runtime-header bilinçli yapılmadı (dev-server FP'si;
  statik CSP + helmet-presence zaten kapsıyor). `npm run check` yeşil.
  **Güvenlik tarafı tam: dep-audit + CSP + secrets(semgrep+gitleaks) + 3 OWASP semgrep + security-headers
  + sanitizer + CORS/cookie/CSRF — hepsi Faz 13 blocking (sessizce TAMAMLANDI demez).**
- **feat(security) [tamamlık]:** Faz 13'e iki adanmış kontrol — **security-headers** + **veri-güvenliği
  sanitizer** (YZLLM talebi). (1) `orchestrator/headers-check.mjs`: STATİK güvenlik-HTTP-başlık kontrolü
  (deps + kaynak tarama; canlı-server FP'siz — dev server'lar prod-header koymaz). HTTP backend
  (express/fastify/koa/nest/next) var ama helmet/manuel-header YOKSA bulgu (HSTS/X-Frame-Options/...);
  statik SPA → uygulanamaz skip. (2) `assets/security-rules/data-sanitization.yml` (semgrep, `--validate`
  + fixture-test edildi): kullanıcı verisi sanitize edilmeden tehlikeli sink'lere (innerHTML/outerHTML
  dinamik, dangerouslySetInnerHTML dinamik, eval/Function, SQL string-concat) akıyor mu — sabit-string +
  DOMPurify.sanitize'lı kod hariç (düşük-FP). İkisi Faz 13 extra_scan (mutlak yol securityToolPath/
  securityRulePath; `tool_error_codes:[2]` → bozuk-kural/araç-hatası skip, yanlış-blocking yok). Test: 6
  (headers exit-kodu) + sanitizer fixture-doğrulama. `npm run check` yeşil. (Geri kalan ertelenenler —
  CSRF/CORS/cookie dedicated, gitleaks, CSP runtime-header — mevcut owasp/auto paketleriyle örtüşür.)
- **feat(guide-pdf/F4) [program 6/8 — PROGRAM TAMAM]:** Proje-içi **PDF kullanım kılavuzu**
  (headless Chromium + `page.pdf()`). Yeni `guide-pdf.ts`: `.mycl/user-guide.md` (Türkçe,
  living-docs üretimi) metnini + dev-server AYAKTAYSA rota ekran görüntülerini birleştirip
  `<project>/public/docs/kullanim-kilavuzu.pdf` üretir. SAF + test'li: extractRoutesFromFeatures
  (features.md `/route` parse), markdownToHtml (minimal, dep'siz), buildGuideHtml. **Bağımlılık
  (YZLLM kararı: orchestrator Playwright dep):** `playwright` eklendi AMA `.npmrc`
  `playwright_skip_browser_download=1` → CI'da chromium İNMEZ (gerçek-zorlayıcı CI hafif/yeşil
  kalır); chromium RUNTIME'da lazy kurulur (`npx playwright install chromium`). Fail-closed:
  user-guide.md yoksa / UI'sız projede / chromium kurulamazsa → GÖRÜNÜR skip (asla throw).
  Dev-server kapalıysa metin-only PDF (ss'siz) — yine üretilir. Pipeline-end non-blocking hook.
  Test: 9 (saf). `npm run check` yeşil. **8-iş programının TÜM işleri bitti** (+ doğru-karar
  sistemi). Kalan: ertelenen güvenlik kontrolleri + F4 in-app link (minör). Detay: hafıza
  `project_f4_pdf_plan`.
- **feat(module-stock) [program 5/8]:** Yeniden-kullanılabilir feature modülleri
  (~/.mycl/modules/<token>/). **Kritik pivot (4-ajan workflow + adversaryal review):** YZLLM'in
  "oto-çıkarım sezgisel" kararı dumb-heuristic (features.md-token + dosya-adı kümeleme) ile **çöp-modül**
  üretiyordu → **agent-güdümlü explicit descriptor**'a geçildi (görünür filtre ile bildirildi): hâlâ
  auto ama orkestratör-rol ajanı (living-docs deseni) kodu Read/Grep ile inceleyip NET
  `{kind:"modules",modules:[{name,files,db_tables,routes}]}` döner; emin değilse boş → no-op (sessiz
  çöp YASAK). Yeni `module-stock.ts` (prototype-cache kardeşi): SAF slugToken/matchesModule/isModuleStale/
  sanitizeDescriptor (mutlak/../DENY reddi)/parseModuleBlock + `extractModule` (YEŞİL-gate computeVerdict
  PASS+gateFail0+securitySkip0; yalnız GERÇEK var-olan dosyalar kopyalanır; hepsi yoksa çöp-dizin
  bırakmaz) + `extractStockedModules` (pipeline-end, CLI-only fail-closed, asla throw) + `listAvailableModules`
  (stack-filtre+limit). **Discover:** context-builder `available_modules` (orkestratör bağlamına stoklu
  modüller; orchestrator-system.md §7.1 reuse-öner notu — ajan Read'leyip ADAPTE eder, auto-wire YOK).
  pipeline-end hook (snapshotPrototype yanı). Test: 10 (saf + extract round-trip + guard, MYCL_HOME izole).
  `npm run check` yeşil + ~/.mycl temiz. **ERTELENEN:** dumb-heuristic boundary, applyModule auto-kopya
  (ajan kendi Read+yazar), versiyonlama. Detay: hafıza `project_module_stock_plan`.
- **feat(token-timeline) [program 8/8]:** Faz-bazında token harcaması **zaman çizelgesi UI**
  paneli. Cost altyapısı zaten vardı (cost.jsonl + PhaseCostBucket); eksik olan görselleştirmeydi.
  Backend: faz-sonu cost-flush'ta `emit("cost_phase", rec)` (CANLI) + yeni `load_costs` IPC handler
  → `readCosts` → `emit("cost_history", {costs})` (proje açılışında geçmiş). Frontend: yeni
  `TokenTimelinePanel.tsx` (sağ drawer, kendi-içinde inline-styled) — her faz: input/output/cache
  token + tur + toplam'a oranlı bar + grand-total; event tipleri (CostRecord/CostPhaseEvent/
  CostHistoryEvent), MainState.costTimeline + reducer (cost_phase upsert by phase+iteration,
  cost_history replace), boot'ta load_costs isteği, AppHeader token-badge'i tıklanabilir (panel
  toggle). İzole (gözlemlenebilirlik; kritik karar/pipeline yoluna dokunmaz). `npm run check` yeşil.
  **8-iş programı: 6/8 + doğru-karar; kalan modül-stoğu + F4-PDF + ertelenen güvenlik.**
- **feat(orchestrator/proaktif-risk) [doğru-karar B]:** Orkestratör artık **interaktif + proaktif**
  — riski sessizce tahmin etmek yerine kullanıcıya SOMUT seçeneklerle sorar (; yalnız sürekli orkestratör-içi, sabit faz-kapısı yok). (1) `ask_clarify`
  zenginleştirildi: `AgentDecision.clarify_options` (decision.ts tip+`decide_action` şema+parser:
  trim/dedup/cap-6) — handler (index.ts) doluysa jenerik Evet/Hayır yerine gerçek alternatifleri
  sunar (örn. ["JWT","session-cookie"] + "Vazgeç"); cevap akışı DEĞİŞMEZ (agent_clarify_ →
  handleUserMessage → ajan o yönle yeniden karar). (2) orchestrator-system.md **§14 Proactive Risk
  Assessment**: CLAUDE.md kalibrasyonu birebir (belirgin→sessizce hallet; yalnız gerçekten kararsız/
  geri-dönülemez/geçerli-seçenekler-arası-tercih→sor + öneri ver), önce recall'a bak (tekrar sorma),
  risk çözülünce `save_memory_proposal` öner (storage→recall→reasoning döngüsü). Geveze olma uyarısı
  + TR örnekler. Test: 9 (parser). `npm run check` yeşil. **Doğru-karar sistemi (A recall + B risk)
  TAMAM.**
- **feat(orchestrator/recall) [doğru-karar A]:** Orkestratör karar anında "doğru geri-çağırma"
  güçlendirildi (doğru karar = depolama + **doğru geri-çağırma** + iyi muhakeme). İki katman:
  (1) son-N limitleri artırıldı (context-builder.ts: audit 10→30, ADR 3→8, proje hafıza 10→15,
  genel 5→8; conversation-context: son 3→5 user mesajı). (2) **Relevance-tabanlı geri-çağırma**:
  yeni `buildRelevantOrchestratorContext` (relevance/injectors.ts) — kullanıcının ŞİMDİKİ mesajına
  en İLGİLİ geçmiş audit + vazgeçmeler (recency değil, mevcut relevance-engine ile skorlanır) karar
  prompt'una eklenir → son-N pencerelerinin kaçırdığı eski-ama-ilgili kayıt yüzeye çıkar (tutarlı
  karar + aynı şeyi tekrar sorMAMA). userMessage `buildAgentSystemPrompt`'a thread edildi (agent.ts
  zaten userText'i taşıyordu). Triviyal query (kısa onay "evet"/"tamam") → relevance call ATLA;
  boş/fail → "" (bölüm eklenmez, karar bloklanmaz — fail-safe, abonelik modunda da graceful).
  Test: 2. `npm run check` yeşil. (Part B: proaktif risk-sorma sıradaki.)
- **feat(ultracode) [program 7/8]:** ultracode artık **İKİ MODDA** uygulanıyor. CLI tarafı
  zaten alıyordu (`cli-run`/`cli-session`: `effort==="ultracode"` → `--settings {ultracode}`).
  **Yeni: API tarafı** (`claude-api.ts runTurn`) — ultracode seçiliyse extended-thinking
  (`thinking:{type:"enabled",budget_tokens:16000}`) + system reminder. Saf
  `thinkingConfigFor(effort,toolChoice,maxTokens)` (test edilebilir). **Güvenlik/regresyon:**
  (a) extended-thinking forced tool_choice (any/tool) ile UYUMSUZ → yalnız auto/undefined'da
  enable (classifier/extractor call'ları thinking'siz, davranış aynı); (b) budget<max_tokens
  zorunlu → max_tokens budget+4096'ya yükselir; (c) thinking aktifken temperature unset
  (API kuralı); (d) **ultracode-DIŞI effort'ta plan boş → davranış BİREBİR korunur** (regresyon
  yok, blast-radius yalnız ultracode+API opt-in yolu). Test: 11. `npm run check` yeşil.
- **feat(prototype-cache) [program 4/8]:** Stack başına golden scaffold cache
  (`~/.mycl/prototypes/<stack>/`) — "sağlam + hızlı başlangıç". Yeni `prototype-cache.ts`.
  **Küratörleme = doğrulanmış koşudan oto-anlık-görüntü** (YZLLM kararı): pipeline YEŞİL
  (gate-fail yok) + stack biliniyorsa pipeline-end'de baseline dosyaları (conservative
  allowlist: config + giriş-iskeleti + public/; **feature kodu HARİÇ** → yeni projeleri
  kirletmez) golden prototip olarak kaydedilir + `<stack>.meta.json` (createdAt + node sürümü).
  **Uygula:** Faz 5 başında greenfield (isExistingProject=false) + stack biliniyor + cache
  varsa, codegen BAŞLAMADAN baseline projeye kopyalanır (mevcut dosya EZİLMEZ) → ana ajan
  sıfırdan değil doğrulanmış baseline üzerine geliştirir. **Bayatlama (YZLLM'in işaret ettiği
  risk):** apply'da prototip 30+ günse GÖRÜNÜR uyarı (yine kopyalar, "ajan güncellemeli" notu).
  Her yeşil koşu prototipi tazeler. Non-blocking + fail-closed (snapshot/apply throw etmez).
  Test: 9 (allowlist feature-dışlama, isStale, snapshot+apply round-trip MYCL_HOME-izole,
  yeşil-değil/unknown/existing guard'ları). pipeline-e2e testine MYCL_HOME izolasyonu
  eklendi (gerçek ~/.mycl kirlenmesin). `npm run check` yeşil.
- **feat(security-baseline/Unit 3) [program 3/8 — item 3 TAMAM]:** **secret-scan** + runner
  robustness. gitleaks YERİNE **semgrep `p/secrets`** (4. semgrep extra_scan) — gitleaks'in
  sürüm/komut (`dir` vs deprecated `detect`)/scope kırılganlığı yok; mevcut semgrep mimarisine
  birebir oturur (registry config, path sorunu yok, dil-agnostik, eksik→skip). Yeni
  **`tool_error_codes`** alanı (extra_scan): "araç düzgün çalışmadı" exit kodları (semgrep
  fatal/crash=2; ileride gitleaks eski-sürüm=126) BULGU değil → fail değil **skip** → bozuk
  custom kural / uyumsuz araç sürümü projeyi **yanlış-bloklamaz** (review landmine). 4
  semgrep scan'inin hepsine `tool_error_codes:[2]` eklendi (crash robustness; exit 1 = gerçek
  bulgu blocking kalır). Atlanan tarama harness `securitySkipped`→PARTIAL ile dürüstçe görünür.
  Test: +2 (exit-2→skip, exit-1→fail). `npm run check` yeşil.
  **Bilinçli ERTELENEN (review + dikkatlice):** custom semgrep YAML (security-headers/xss/sqli)
  — "helmet yok→bulgu" gibi yokluk-kuralları yanlış-pozitif fırtınası yapar + mutlak-yol gerektirir;
  xss/sqli zaten `p/owasp-top-ten`+`auto` ile örtüşür. gitleaks (daha özel, sürüm-robust çağrı
  gerekir). CSRF/CORS/cookie (statik tarama FP). Detay: hafıza `project_security_baseline_plan`.
- **feat(security-baseline/Unit 2) [program 3/8]:** Faz 13 (Güvenlik) artık **BLOCKING** —
  "TAMAMLANDI deme" (YZLLM kararı; MEDIUM dahil bloklar). Güvenlik gate fail olunca
  soft-complete (`soft_complete_after_fail`) YAZILMAZ; F1 `analyzeAndAskError` askq'ına
  yönlendirilir (Çöz / **Kabul et, devam et** / Tekrar analiz) — "takılma yok": kullanıcı
  bulguyu kabul edip override edebilir. Kabul → `phase-13-complete` (detail
  `security_accepted_by_user`, soft-fail DEĞİL) + `advanceToNextPhase(13)`; ama runner'ın
  `security-fail` event'i durduğu için harness verdict yine PARTIAL (asla çıplak PASS).
  API modunda (orkestratör CLI değil, analiz yapılamaz) dead-end YOK: LLM'siz doğrudan
  blocking karar askq'ı. error-analysis: `OPT_ACCEPT_CONTINUE` + `buildErrorAnalysisAskq`
  `allowAcceptContinue` param + `analyzeAndAskError` blocking'e zorlar. **harness-verdict
  false-green fix:** bir güvenlik tarayıcısı atlandıysa (csp-evaluator/secret-scan/semgrep/
  phase-13 `-skipped`) PASS değil PARTIAL ("tam tarandı sayılmaz") — yeni `securitySkipped`
  alanı. Test: +10 (allowAcceptContinue option setleri, skip→PARTIAL, accepted-by-user,
  accept-continue wiring → akış ilerler). `npm run check` yeşil. Yalnız Faz 13 blocking
  (10-12,14-17 soft kalır — CHANGELOG kuralı). Unit 3 (gitleaks + semgrep YAML) sıradaki.
- **feat(security-baseline/Unit 1) [program 3/8]:** Faz 13'e **CSP değerlendirme** eklendi —
  Google `csp_evaluator` lib'i (Chrome "CSP Evaluator" extension'ının headless/otomatik
  karşılığı). Yeni `orchestrator/csp-check.mjs` (harness.mjs gibi kök .mjs): web-UI tespiti
  (web framework / index.html) → değilse self-skip; kaynak-tabanlı (index.html meta CSP);
  statik bulunamayan CSP (helmet/runtime) → **görünür atlama, false-fail YOK** (kesin
  header-tabanlı değerlendirme Unit 2'de). Eşik **severity ≤ 40** blocking (HIGH/SYNTAX/
  MEDIUM/HIGH_MAYBE — YZLLM kararı "MEDIUM da bloklasın"); STRICT_CSP(45)/INFO(60) öneri/uyarı
  (inverted-threshold tuzağına düşmeden — review yakaladı). Fail-closed: `csp_evaluator`
  import edilemezse exit 2 (sessiz yeşil değil). phase-registry Faz 13 extra_scans'a MUTLAK
  yolla (`securityToolPath`) eklendi; runner cwd=hedef-proje olduğu için zorunlu.
  `csp_evaluator` orchestrator dep'i (CJS, mac+linux saf-JS). Test: 6 (exit-kodu sözleşmesi).
  Bu Unit 1 — reports-only, pipeline kontrol-akışına dokunmaz. Unit 2 (soft→blocking +
  F1 "Kabul et devam" + harness skip→PARTIAL), Unit 3 (gitleaks secret-scan + custom semgrep
  YAML) sıradaki. CSRF/CORS/cookie statik-tarama yanlış-pozitifi nedeniyle ERTELENDİ (review).
  11-ajan tasarım workflow'u + adversaryal inceleme 7 landmine yakaladı (detay:
  hafıza `project_security_baseline_plan`).
- **feat(error-analysis/F1) [program 2/8]:** Bir faz HATA verince MyCL artık sessiz kalmıyor:
  orkestratör rolüyle (ana ajan değil) tek-atışlık LLM analizi yapıp **karar askq'ı** açıyor +
  (F5'in mevcut askq yolundan) OS bildirimi gidiyor; FINAL kararı kullanıcı veriyor. Yeni
  `error-analysis.ts` (SAF `buildErrorAnalysisAskq`/`parseErrorAnalysisBlock`/prompt + impure
  `analyzeAndAskError`, living-docs deseni: CLI/abonelik modunda `runClaudeCli`, API modunda
  görünür not + null = sessiz fallback YOK). **Şiddet-duyarlı seçenekler:** bloklayıcı →
  [çözümler, "Tekrar analiz et"] (çözmeden ilerlemek yok); bloklayıcı değil → ["İş listesine
  kaydet, çözmeden devam et", çözümler, "Tekrar analiz et"]. index.ts: 9 tekrar eden faz-fail
  noktası (Faz 1×2, 2,3,4,5,7,8,9) tek `failPhase(n, ctrl)` helper'ına alındı (NON-BLOCKING,
  throw etmez, fail-closed: analiz null → askq açılmaz); `handleAskqAnswer`'a controller-fallback'tan
  ÖNCE branch ("Çöz" → mevcut debug_triage/Faz 0; "Kaydet" → `appendTask`; "Tekrar analiz et" →
  yeniden analiz). Seçenek etiketleri modülden export edilen sabitler (TR string drift'i imkânsız).
  Test: 24 saf birim + 3 wiring (pipeline-e2e: kaydet/reanaliz/id-gate). `npm run check` yeşil.
  (Workflow ile paralel taslak + adversaryal inceleme; entegrasyonu elle yaptım — recipe'nin
  fonksiyon-yeniden-tanımı çakışmasını inceleme yakaladı, modülden import edildi.)
- **feat(headless-harness) [program 1/8]:** Tam pipeline'ı GUI'siz, terminalden koşup
  **dürüst verdict** üreten harness — kanıt katmanı. Yeni `harness-verdict.ts` (SAF):
  audit.log → PASS (17-complete + sıfır gate-fail) / PARTIAL (17-complete AMA ≥1 gate-fail) /
  FAIL (complete yok), exit 0/2/1. **Kritik:** mekanik gate'ler SOFT (`soft_complete_after_fail`)
  → "TAMAMLANDI" diyordu; harness artık PARTIAL ile gerçeği yüzeye çıkarır (ekranındaki
  Faz13/14/15/16-fail-ama-tamamlandı kokusu görünür olur). Yeni `harness.mjs`: orchestrator'ı
  alt-process başlatıp stdin/stdout NDJSON ile sürer (Tauri ile aynı kanal), askq'ları oto-cevaplar,
  audit'ten verdict + exit code. `npm run e2e` (gerçek koşu, kanıt için; maliyetli → check'te değil).
  CI tarafı: pipeline-e2e mock koşusu artık `computeVerdict===PASS` assert eder + 6 saf verdict testi.
  (8'lik programın 1.'si; headless-harness → ben/CI uçtan uca doğrularım.)
- **feat(auto-answer) [saha-3/5]:** Composer'da "Orkestrator" yanına "Oto-cevap" checkbox'ı.
  Tikliyken: bir önerisi (suggested_answer) olan NETLEŞTİRME askq'ları otomatik o öneriyle
  yanıtlanır (görünür "🤖 Oto-cevap" notu) → daha hızlı + kaliteli iterasyon. Onaylar
  (Approve/Revise) + önerisi olmayan sorular YİNE kullanıcıya sorulur. Yeni `auto-answer.ts`
  modül-singleton (`set_auto_answer` komutu); qa-askq CLI + SDK backend'leri `emitAndAwait`/
  askq noktasında okur (`!isApproval` + öneri var). Frontend: ChatPanel checkbox + App.tsx
  localStorage + config_status ready'de restore. 2 birim test. (5 saha iyileştirmesinden 3.)
- **feat(os-notification) [saha-5/5]:** Kullanıcı aksiyonu beklenirken (askq) OS bildirimi.
  `tauri-plugin-notification` eklendi (Cargo.toml + lib.rs `.plugin(...init())` + capabilities
  `notification:default` + `@tauri-apps/plugin-notification`). `App.tsx`: açılışta izin iste;
  yeni askq (id değişince) gelince — yalnız pencere ODAKTA DEĞİLSE (spam yok) — bildirim gönder
  (başlık + soru). Tüm askq'ları kapsar (Özellik 1 hata-askq'sı + onaylar dahil). cargo check +
  npm run check yeşil. DRIVE-BY flaky-fix: `app.test.ts` boot testi sabit 2×`setTimeout(0)` ile
  bekliyordu (boot adımlarına ara sıra yetişmiyor → ~4'te 1 fail) → `vi.waitFor` deterministik.
- **feat(living-docs) [saha-2/5]:** `.mycl/features.md` + `user-guide.md` artık ORKESTRATÖR
  rolü yazar (ana ajana/codegen'e GİTMEZ — kullanıcı kuralı). `living-docs.ts`:
  `backendForRole(config,"main")` → `"orchestrator"` (bootstrap + update CLI kapısı);
  model `selected_models.orchestrator ?? .main`. Orkestratör "her şeyi bilen" hafif rol →
  docs için doğru yer; ana ajan codegen'e odaklı kalır. Saf testler etkilenmedi. (5 saha
  iyileştirmesinden 2.)

## 2026-06-03

- **22:06 fix(robustness):** Pipeline ARTIK ajan text-JSON bozukluğunda TAKILMIYOR (kullanıcı
  şartı: "hiçbir yerde takılmamalı; her özellik işini iyi yapmalı"). Tetik: Faz 2 ana ajanı
  `dimensions` dizisini düzyazı yazıp atlayınca backend 1-nudge sonrası hard-fail → pipeline
  durmuştu. Kök neden: CLI'da native tool yok → ajan iç içe diziyi düzyazıya çeviriyor.
  - Yeni `cli-json.ts` saf helper'lar: `schemaToSkeleton(schema)` (şemadan SOMUT örnek —
    iç içe diziyi `[{…}]` gösterir) + `coerceToSchema(block, schema, fallbackText)` (eksik/
    yanlış-tip zorunlu alanı tip-güvenli doldur: array→[], string→alias `summary`/`title`/
    `pitch` ya da ajanın ham metni; v15.9 contract bug'ını fail yerine ONARARAK çözer).
  - `qa-askq` (1/2/9) + `production-schema` (3/4/7): (a) `buildOutputInstruction`'a EXAMPLE
    eklendi (proaktif — ajan ilk seferde doğru şekli görür); (b) eksik-alan nudge'ı somut
    örnekli + deneme **1→2**; (c) nudge sonrası hâlâ bozuksa ASLA hard-fail ETME →
    `coerceToSchema` + tek GÖRÜNÜR uyarı + DEVAM; (d) no-JSON-at-all (2 nudge sonrası) →
    ajan metnini terminal blok olarak sentezle + uyarı + devam. Downstream boş diziyi zaten
    tolere eder (phase-2 dimensions / phase-9 decisions Array.isArray guard).
  - Kapsam DIŞI (doğru şekilde görünür fail-closed kalır): altyapı hataları (claude yok /
    spawn / exit≠0 / sandbox kurulamadı) — ortam sorunu, sessizce "uydurup devam" YANLIŞ olurdu.
  - `cli-interactive-loop` KULLANILMIYOR (legacy) → dokunulmadı. Test: cli-json +9 birim
    (schemaToSkeleton/coerce), qa-askq "iki kez eksik" testi yeni davranışa (coerce+devam)
    güncellendi.
  - DRIVE-BY flaky-test fix: `subscription-mode.test` v15.10'dan beri abonelik-modu
    classifyViaCli'nin GERÇEK `claude` spawn'ını mock'lamıyordu → ~5sn timeout, CI'ı ara ara
    kırıyordu. `runClaudeCli` mock'landı → deterministik + hızlı (kendisi de bir "takılma"ydı).
  - npm run check yeşil.
- **21:38 fix(main-agent-english):** Ana ajan ARTIK kesin İngilizce konuşur (kullanıcı
  şartı; ekran: CLAUDE CODE paneli Faz 2'de Türkçe üretmişti). Kök neden: ajanın GİRDİLERİ
  Türkçe'ydi (kural recency'si zayıf, yenemiyordu). Düzeltme — ana ajanın TÜM girdileri
  İngilizce + recency:
  - `conversation-context.ts`: `buildConversationContext(.., {recentLanguage:"en"})` → son 3
    user mesajı ANA AJAN için `translate()` ile İngilizce'ye çevrilir (set-hash cache'li,
    `recentEnCache`); çeviri başarısızsa boş (ham TR'ye DÜŞMEZ). `renderConversationSection(c,
    {forMainAgent:true})` İngilizce render eder. Orkestratör HAM TR görmeye devam eder (default).
    Boş-sohbet sentinel'i İngilizce. 6 faz caller'ı (1/2/3/4/7/9) güncellendi.
  - Ajana giden Türkçe CLI talimatları İngilizce'ye çevrildi: `qa-askq-cli-backend` +
    `production-schema-cli-backend` `buildOutputInstruction` + tüm resume/nudge userMessage'ları;
    `cli-interactive-loop` STRICT_NUDGE. (UI/log/askq-label stringleri Türkçe kaldı — ajana gitmez.)
  - Recency + resume: `MAIN_AGENT_LANGUAGE_REMINDER` her main-ajan user mesajına eklenir
    (`cli-session` + `codegen/cli-backend` buildArgs) — resume turlarında sistem prompt'u
    yeniden gönderilmediği için tek garanti bu (çevirmen `runClaudeCli` kullanır, etkilenmez).
  - Test: `conversation-context.test.ts` (5 saf test — forMainAgent EN, orkestratör ham-TR
    regresyon, EN sentinel, cache, çeviri-hatası ham-TR'ye düşmez). npm run check yeşil (727).
- **20:46 feat(auto-mode-symmetric):** Auto Mode artık SİMETRİK çift-yön, 3 rol de. Çözülen birincil backend (limit yokken CLI, limitliyse API)
  denenir; KALICI `failed`/throw → görünür mesajla diğerine BİR KEZ geçilir (case 1:
  API→CLI + case 2: CLI→API). Geçici hatalar (overloaded/5xx) zaten backend içinde retry'lı.
  `autoFallbackBackend` yön-bağımsız (makePrimary/makeSecondary + etiket); yeni
  `autoBackendPair(effective, makeCli, makeApi)` yönü seçer. Uygulandı: main (qa-askq 1/2/9,
  production-schema 3/4/7, codegen 5/8 — wantCli'den ÖNCE auto branch), orchestrator
  (throw-based, iki yön), translator (`attempt(useCli)` helper'a refactor + primary/secondary).
  Explicit "api"/"cli" STRICT kalır (sessiz fallback yok). phase-0 D1 (triage girişi)
  bespoke — limit penceresinde SDK'ya çözülür, ortada dolarsa yeniden tetikte. 24 birim test
  (her iki yön + abort→geçiş yok + tek-geçiş + askq routing + yön seçimi). check yeşil (722).
- **20:13 feat(auto-mode-seamless):** Auto Mode'a FAZ-İÇİ kesintisiz retry (YZLLM onayı:
  "Evet, kesintisiz yap"). `cli-rate-limit.ts`'e generic `autoFallbackBackend(makeCli,
  makeApi)`: CLI backend limit YÜZÜNDEN (kind:"failed" + cliCurrentlyLimited) başarısız
  olursa AYNI faz içinde API backend'ine geçip yeniden dener — başka hatada fallback YOK
  (sessiz API kaçışı değil). submitAskqAnswer/abort aktif backend'e yönlenir. 3 ana
  factory'ye uygulandı (yalnız Auto Mode'da): qa-askq (1/2/9), production-schema (3/4/7),
  codegen (5/8). Orchestrator zaten görünür CLI→SDK fallback'e sahip. phase-0 D1 (triage
  girişi) bespoke kaldı — limit dolarsa yeniden tetikte API'ye geçer (backendForRole çözer).
  19:36'daki AÇIK NOT kapandı: ana pipeline artık faz-ortası limitte kesintisiz. 4 yeni test
  (CLI-ok→API yok / CLI-fail+limitsiz→fallback yok / CLI-fail+limitli→API / askq routing).
- **19:36 feat(auto-mode):** Rol başına backend'e 3. seçenek "auto" (Auto Mode) —
  CLI (Claude Code aboneliği) ile başlar; abonelik usage-limit'i dolunca otomatik API'ye
  geçer, limit açılınca CLI'ye döner. Reset zamanı `claude -p` stream-json'undaki
  `rate_limit_event.rate_limit_info.resetsAt` (Unix epoch sn) — canlı doğrulandı,
  "resets in 1h" metni parse etmeye gerek YOK. Yeni `cli-rate-limit.ts` (leaf): global
  limit state + saf çekirdek (isBlockedStatus/computeLimitedUntilMs/isLimited/resolveAuto)
  + `noteRateLimitEvent` (görünür "API'ye geçildi ~Xdk sonra HH:MM açılacak") +
  `cliCurrentlyLimited` (reset geçince "CLI'ye dönüldü"). `backendForRole` tek
  çözüm-noktası: "auto"→runtime'da api/cli'ye çözer (9 dispatch yeri DEĞİŞMEDİ). 3 CLI
  runner stream-json'da `rate_limit_event` yakalar. config `ConfiguredBackend=api|cli|auto`.
  Frontend: Modeller sekmesi seçicisine "Auto" düğmesi. Her geçiş GÖRÜNÜR (sessiz fallback
  istisnası: auto'da CLI→API KASITLI; explicit "cli" hâlâ API'ye düşmez). 17 saf birim test.
  AÇIK NOT: faz-sınırında çalışır (limit dolunca sonraki fazlar API); limit TAM bir fazın
  ortasında dolarsa o faz bir hata verip yeniden tetiklenmeli (in-phase seamless retry =
  interactive-backend wrapper, YZLLM kararına bırakıldı — ayrı iş).
- **18:22 feat(phase-9-tech-debt):** Faz 9 (Risk Review) artık TEKNİK BORÇ kontrolü de yapar
  (kullanıcı: "Faz 9'da teknik borç kontrolü de yapsın" + "sadece o iterasyondaki iş için").
  Yeni `phase-9-tech-debt.ts`: bu iterasyonda değişen ÜRETİM dosyalarını (getChangedFiles
  ile — create'te HEAD baseline, fix'te `fix_checkpoint_ref`; pipeline mid-run commit
  yapmadığından working tree = bu iterasyonun işi) deterministik tarar (`scanTechDebt`),
  bulguları `{{TECH_DEBT_FINDINGS}}`'e enjekte eder. Önceki commit'li borç KAPSAM DIŞI
  (entegrasyon testiyle kanıtlı: değişen dosya taranır, commit'li dosya taranmaz). Ajan
  derinliği: prompt'a 6. eksen "Technical debt" + kapsamlı Read izni — ajan SADECE
  `{{TECH_DEBT_FILES}}` listesindeki değişen dosyaları Read/Grep edip semantik borcu
  (duplikasyon, sızan soyutlama, dead code) değerlendirir, her bulguyu skip/fix/rule gezer.
  Test/spec dosyaları taranmaz (`isTestPath` tech-debt-scanner'a eklendi, paylaşılan).
  Git yoksa DÜRÜST not (sessiz boş değil). `MAX_SCAN_FILES=200` aşımı görünür NOTE.
  12 saf+git-entegrasyon testi. NOT: scope ajan talimatıyla sınırlı (Read'i listeyle bağladım);
  inject-only katı garanti istenirse değiştirilebilir.
- **17:40 chore(scope):** Windows KAPSAM DIŞI bırakıldı (kullanıcı kararı: "sadece linux
  ve mac"). `agent-sandbox.ts`: Windows özel-durumu "mac/linux DIŞI her platform →
  fail-closed catch-all" genellemesine çevrildi (`platform !== "darwin" && !== "linux"`);
  reason artık "bu platform desteklenmiyor — yalnız macOS ve Linux". 17:20'deki CLI-backend
  POSIX-only AÇIĞI KAPANDI: `:` PATH ayracı + POSIX yolları mac+linux için doğru, Windows
  hedef olmadığından sorun değil. Hedef platformlar: macOS + Linux. (26 test yeşil.)
- **17:20 feat(agent-sandbox-xplatform):** Sandbox ÇAPRAZ-PLATFORM yapıldı (kural:
  "her zaman çapraz-platform"; 16:35 macOS-only halini Linux/Windows'a genişletti).
  `agent-sandbox.ts`: (1) `detectSandboxAvailability(platform,hasBwrap,hasSocat)` saf
  fonksiyonu — darwin=Seatbelt yerleşik; linux=bwrap+socat gerekli; win32=desteklenmez
  (WSL2). (2) `sandboxAvailable()` impure (linux'ta `command -v bwrap/socat`, cache'li).
  (3) `guardSandboxOrWarn()` spawn-ÖNCESİ GÖRÜNÜR kapı: enforce+sandbox-yok → Türkçe
  hata + spawn ETME (3 caller'a bağlı); warn+yok → görünür uyarı + hapissiz devam
  (sessiz fallback yasağı). (4) POSIX-only yol bug'ı düzeltildi: `pathPosix.join`/`.sep`
  (hardcoded `/` kaldırıldı). (5) `RUNTIME_ALLOW` platform-aware: ortak + darwin(Library)
  + `.config` (Linux XDG/anthropic SDK config — eksikti, claude'u kırabilirdi). (6) win32 →
  denyRead üretmez (yerli sandbox yok; fail-closed guard + claude failIfUnavailable).
  (7) `readdirSync(home)` hatası → görünür uyarı (sessiz okuma-koruma kaybı yok).
  Adversaryal workflow doğrulaması: claude'un `failIfUnavailable:true`'si desteklenmeyen
  platformda DA exit-1 yapar (sessiz unsandboxed DEĞİL). Test: 26 saf birim (14 yeni);
  macOS canlı yeniden-doğrulandı. AÇIK (ayrı/önceden var): `codegen/cli-backend.ts`
  resolveClaudePath/claudeSpawnEnv POSIX-only → Windows'ta CLI ENOENT (YZLLM'e soruldu).
- **16:35 feat(agent-sandbox):** GÜVENLİK — spawn edilen `claude` ajan alt-süreçleri artık
  YALNIZ açık proje klasörü + alt klasörlerine erişir, OS-zorlamalı (macOS Seatbelt).
  Yeni `agent-sandbox.ts`: `--settings` ile `sandbox.enabled:true` +
  `allowUnsandboxedCommands:false` → YAZMA+BASH otomatik proje-hapsine girer; OKUMA için
  home top-level girdileri (runtime + proje HARİÇ) `denyRead` + `permissions.deny Read()`.
  3 spawn noktasına (`cli-run`/`cli-session`/`codegen/cli-backend`) enjekte edildi (eski
  ultracode-only `--settings` dalı yerine; ultracode merge korunur). Config:
  `claude_code_flags.agent_sandbox_policy` (varsayılan `enforce`: sandbox kurulamazsa
  fail-closed; `warn`/`off` kapıları). Canlı doğrulandı: proje okunur/yazılır, `~/Music`/
  `~/Documents`/diğer-projeler/`.ssh` reddedilir ("denied by your permission settings").
  Tetikleyici: macOS'ta ajanın Apple Music/Photos (TCC) izni istemesi — kapandı.
  `agent-sandbox.test.ts` (12 saf birim test). Kural: `--add-dir` HAPİS DEĞİL, sandbox hapistir.
- **15:32 fix(main-agent-language):** Main ajan GENEL kuralla yalnız İngilizce yazar —
  ortak `MAIN_AGENT_LANGUAGE_RULE` (yeni `agent-language.ts`) tüm main-ajan backend
  factory'lerine (qa-askq / production-schema / codegen, CLI+SDK) + Faz 0'a enjekte edildi.
  Çevirmen + orkestratör HARİÇ. Kök neden: faz prompt'larında EN-çıktı kuralı yoktu +
  conversation context ham TR → ajan Türkçe'ye kayıyordu. AYRICA living-docs çelişkisi
  çözüldü: `features.md` artık İngilizce (EN ana-ajana gider), `user-guide.md` Türkçe
  (kullanıcı-yüzlü). [14:50 98eb69e'deki ⚠️ çelişki kapatıldı.]
- **14:50 `98eb69e` feat(living-docs):** Yaşayan özellik dökümantasyonu (`.mycl/features.md`)
  + UI kullanma kılavuzu (`.mycl/user-guide.md`). Pipeline-sonu incremental güncelleme +
  mevcut projede ilk-açılış bootstrap. Relevance ChunkSource ("features"/"user-guide") →
  Faz 1/2 + orkestratör enjeksiyonu. Frontend: 📖 Kılavuz butonu + GuideModal + `user_guide` event.
- **12:32 `e3b8882` fix(runtime-watcher):** infra/başlangıç hataları (EADDRINUSE/ECONNREFUSED/
  ENOENT/EACCES/EPERM) artık chat'e basılmıyor (ortam sorunu, app bug'ı değil). errors.db + event korunur.
- **12:07 `609a28b` fix:** CLI/abonelik saha-doğrulamasından çıkan 10 düzeltme — CLI streaming
  (observer/onText/idle-timeout/token_usage + --include-partial-messages), stack stale-detection
  re-detect, project_type abonelik text-JSON sınıflandırma, fix-safety tüm kod fix'lerine (D2
  checkpoint + repro-gate-logic), gitignore idempotency (ortak util), phase-2 dimensions +
  phase-9 decisions Array.isArray guard, isMissingCommand npx-missing skip, playwright scaffold testDir.

## 2026-06-02

- **17:19 `7cc66c1` fix(cli):** codegen `--max-budget-usd` cap'i kaldırıldı (gerekli codegen'i kesiyordu).
- **16:34 `23d1ffe` fix(cli):** QA-askq terminal blok zorunlu-alan doğrulaması + nudge (Faz 2 contract bug).
- **14:23–14:07 `4a82db3` `32f430e` `2a19d4e` feat(scope):** scoped mekanik gate'ler — pipeline akışına
  bağlama + mod ayrımı/skip, scope-aware komut + profil şablonları, değişen-kapsam altyapısı (git diff + blast-radius).
- **12:52–11:01 fix/dev olgunlaşması (D1-D6):** Faz 8 repro-first gate + checkpoint + regresyonda rollback;
  git checkpoint/rollback; incremental spec (eski spec.md korunur); D2 blast-radius + dokunuş haritası;
  çok-dilli reverse-import bağımlılık grafiği; Faz 8 bütünlük çapası deterministik TAM-SUITE;
  greenfield-vs-iterate deterministik ayrım; Faz 0 D1'e deterministik kanıt (errors.db + git blame).
- **09:48 `1cbb672` fix(updater):** paketli app'te orchestrator değişikliği de "full" güncelleme tetikler.

## 2026-06-01

- **23:53 `499075a` refactor:** ölü chat/question handler + legacy router.ts kaldırıldı.
- **22:46 `0b13e57` fix(cli):** codegen'den `--bare` kaldırıldı (abonelik OAuth/keychain'i kırıyordu).
- **22:30 `0515aa1` fix(cli):** production-schema CLI talimatı sıkılaştırıldı.

## Kalıcı mimari kurallar (bozma!)
- **Ana ajan Türkçe bilmemeli:** Claude Code panelindeki main-ajan output'u EN; brief.md EN;
  yalnız orkestratörün `reason`/`message_to_user` + askq UI gösterimi TR (çevirmen çevirir).
  Kaynak: `assets/agent-prompts/orchestrator-system.md:115`.
- **CLI seçiliyken sessiz API fallback yok** (görünür hata + dur).
- **Ajan dosya hapsi:** spawn edilen `claude` YALNIZ proje + alt klasörlerine erişir
  (`--settings` sandbox, OS-zorlamalı). `--add-dir` hapis değildir; sandbox hapistir.
  Tek kaynak `agent-sandbox.ts`; 3 buildArgs oradan beslenir.
- **Çapraz-platform = macOS + Linux** (Windows KAPSAM DIŞI): her özellik baştan mac **ve**
  Linux düşünülür; macOS-only yazıp Linux'u "sonraki faza" erteleme. Platform-özel araç
  (bwrap+socat / Seatbelt) eksikse görünür + fail-closed. mac/linux dışı → fail-closed
  catch-all (Windows'a özel kod yazma). Yol için `node:path` (hardcoded `/` yok).
- **Her anlamlı değişiklikten sonra `npm run check` yeşil olmalı** (proje gate'i).
- **Tamamlanan + check-yeşil işi sormadan commit + main'e push.**
