# MyCL Studio — Değişiklik Günlüğü

> AI (Claude) tarafından yapılan işlerin zaman damgalı kaydı. Yeni → eski.
> Amaç: eski kararları/kuralları unutup bozmamak; bir işi değiştirmeden önce buraya bak.
> Eski bir işi değiştirmek/silmek gerekiyorsa ÖNCE Ümit'e sor (kural, 2026-06-03).

## 2026-06-10

- **fix(KÖR TEŞHİS kökü: dev-server çöküşünün GERÇEK hatasını yakala+göster) [Ümit logları: "bu kadar kolay bişeyi
  çözemedi, node_modules silmeyi düşündü"]:** Log analizi: dev server 3 denemede düşüyordu, ajan port/vite/node_modules
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

- **fix(hata-analizi API modunda da çalışır — CLI-only gate kaldırıldı) [Ümit: "bunu çözmüştük" — ekranda hâlâ
  "Hata analizi yalnız CLI/abonelik modunda yapılır"]:** `analyzeAndAskError` artık backend-aware: orkestratör
  cli → `runClaudeCli` (Read/Grep/Bash ile araştırmalı, eskisi gibi); orkestratör api → Anthropic SDK TEK-ATIŞ
  triage (tool yok — hata mesajı + detail/stderr'den sınıflandır + çözüm öner). `buildErrorAnalysisPrompt(errCtx,
  canInvestigate)` no-tools varyantı. Derin araştırmayı SEÇİLEN FİX downstream (Faz 0 / SDK) yapar → triage hızlı +
  yeterli, fix kalitesi korunur. Böylece API modunda faz-fail OTO-ÇÖZÜM zinciri (analiz → en iyi çözüm → otomatik
  uygula) baştan sona çalışır. +2 test. API-desteği: artık hiçbir LLM yolu CLI-only değil.

- **fix(ayar değişikliği restart'sız aktif + görünür onay) [Ümit: "API moduna geçtim ama kapatıp açmadan anlamadı;
  kapatıp açmadan da aktif olsun seçimim"]:** Backend (api/cli) zaten her save'de `runtime.config` reload edilip
  canlı okunuyordu; ama (1) config-türevi SINGLETON'lar (`setSandboxPolicy` + `setCacheTtl`) yalnız boot/open'da
  set ediliyordu → bu ayarlar gerçekten restart istiyordu. Artık `applyConfigDerivedSettings` TEK NOKTADA toplandı
  ve HER config-yüklemede (emitConfigStatus + open_project + save_features) çağrılıyor → restart'sız aktif.
  (2) Save sonrası GÖRÜNÜR onay: "✅ Ayarlar uygulandı — yeniden başlatma GEREKMEZ. Bir sonraki iş şu ayarla koşar:
  backend main/translator/orchestrator + model + efor" — kullanıcı değişimin geçerli olduğunu görür (önceden sessizdi,
  "anlamadı" algısının kaynağı). NOT: çalışmakta olan bir faz, başladığı config'le biter; YENİ iş/faz yeni ayarla
  koşar (doğru davranış — config mid-flight değişmez). AÇIK (API modu): faz-fail hata-analizi hâlâ CLI-only
  (orkestratör rolü API'de analiz atlıyor) → API modunda oto-çözüm çalışmaz; API agentic-loop yolu sıradaki iş.

- **feat(OTO-EFOR: efor seçimi iş-tipine göre otomatik) [Ümit: "tek darboğaz LLM yanıt süresi; ama düşünme
  vakti vermezsek hata yapar, en küçük hata bile istemiyorum; kolay işte max gereksiz düşünüyor → efor da otomatik"]:**
  `model-catalog.selectEffortForTask`: KALİTE-kritik (strong-tier: codegen/spec/design/review/debug) işler config
  eforunu AYNEN alır (varsayılan max — tam düşünme, DOKUNULMAZ); hafif/sık işler (orkestrasyon/niyet/doğrulama/
  çeviri/sınıflandırma) "high" TAVANINA çekilir (high = Anthropic'in önerilen varsayılanı, kalite tabanı; max kısa
  işte sadece bekletir). Kullanıcının bilinçli DÜŞÜK seçimi asla yükseltilmez; hiçbir iş low'a düşürülmez; geçersiz
  config → güvenli max. Bağlanan yerler (davranış değişen): cli-orchestrator (orkestrasyon — HER TURDA koşan en sık
  çağrı, en büyük gecikme kazancı), qa-askq-cli (niyet/netleştirme), living-docs (doğrulama). Codegen/spec/debug
  yolları değişmedi (max kaldı). +4 test.

- **feat(tasarım paneli çatışma çıtası yükseltildi) [Ümit: 401-vs-403 gibi "çok basit konularda mı çatışma
  oluşmuş?" → "çok iyi tespit, yap"]:** `design-synthesizer.md`'ye CONFLICT BAR eklendi: yerleşik sektör-standardı
  cevabı olan / saf konvansiyon soruları (HTTP status semantiği, isimlendirme, dosya düzeni) ÇATIŞMA DEĞİL —
  sentezleyici kendisi karara bağlar + Decisions log'a yazar. conflicts'e yalnız projeye-özgü + davranış/veri/
  güvenlik/maliyeti maddi değiştiren anlaşmazlıklar gider ("iki kıdemli mühendis BU projede bunu gerçekten tartışır
  mıydı?" testi). Müzakere turları kısalır; adminpanel koşusundaki 3 çatışmanın 2'si (şema migrasyonu — spec
  varsayımını yanlışladı; anket idempotency) yine giderdi, 401/403 gitmezdi.

- **fix(boot-resume: faz başa sarmasın + chat geçmişi geri gelsin) [Ümit ekranı: "kapatıp açtığımda kaldığı
  yerden başlamıyor, fazın başına gidiyor; chat ekranı bile aynı kalmalı"]:** İki kök neden:
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

- **feat(faz-hatası OTO-ÇÖZÜM + E2BIG öz-iyileştirme) [Ümit ekranı: Faz 5 hatası 00:38'den beri askıda; "kolayca
  çözebileceği şeyi bile bana soruyor"]:** Üç kök neden, üç düzeltme:
  (1) **Faz-fail artık sormuyor** — error-analysis JSON'una `best_index` eklendi; `analyzeAndAskError(autoResolve)`
  askq AÇMADAN en iyi çözümü döndürür, `failPhase` aynı routing'le (handleAskqAnswer → debug akışı → D2 oto-fix)
  otomatik uygular. Döngü koruması: aynı faza 45 dk'da en çok 2 otomatik deneme, sonra görünür notla askq'ya düşer.
  Güvenlik override'ı ("Kabul et, devam et") ASLA otomatik seçilmez. F1'in "final kararı kullanıcı verir" tasarımı
  Ümit talimatıyla TERSİNE DÖNDÜ. (Oto-cevap toggle'ı bu askq'yu zaten kapsamıyordu — 20 saat askıda kalmasının
  nedeni; artık askq default açılmadığından sorun kökünden kalktı.)
  (2) **E2BIG öz-iyileştirme (`safe-env.ts`)** — ekrandaki kök neden: shell'de birikerek şişen değişken (uzayan PATH)
  macOS ARG_MAX'i aşınca MyCL'in TÜM alt süreçleri (npm/vite/claude) çöküyordu, MyCL da kullanıcıya "terminali
  yeniden başlat" diyordu. Artık `safeEnv` PATH'i kayıpsız dedupe eder + >100KB kalan değişkeni alt sürece AKTARMAZ
  (bir kez görünür uyarı). `claudeSpawnEnv` PATH'i de dedupe. Dev server/claude/mekanik runner hepsi korunur.
  (3) Testler: PATH dedupe + şişmiş-PATH küçülmesi + devasa-değişken düşürme + best_index parse/sınır.

## 2026-06-09

- **feat(hata çözümü OTOMATİK — askq kaldırıldı) [Ümit: "hata çözümü kullanıcıya sormasın; kendisi en iyi çözümü
  bulup çözsün"]:** v15.7'nin "auto-apply kaldırıldı, kullanıcı her zaman seçer" kararı Ümit talimatıyla TERSİNE
  DÖNDÜ. `report_root_cause` şemasına `recommended_index` (required) eklendi — D1 ajanı uygulayacağı seçeneği kendisi
  seçer (önce doğruluk, sonra en düşük risk/etki-alanı; emin değilse en güvenli doğru seçenek). Faz 0 askq AÇMAZ;
  "🤖 En iyi çözüm otomatik seçildi" + alternatifler chat'te gösterilir (şeffaflık), `pending_diagnostic.
  auto_selected_label` set edilir → index.ts debug_triage akışı `handleAskqAnswer` ile AYNI routing'i otomatik sürer
  (dokunuş haritası + checkpoint + ui-only/backend-only/full-stack yönlendirme aynen). Boot-restore'da da otomatik;
  eski state.json (label yok) → geriye-uyumlu askq. Audit dürüst: otomatik seçim `caller: mycl-orchestrator (auto)`.
  CLI text-JSON + SDK retry prompt'ları güncellendi.

- **feat(agent-skills OTOMATİK kurulum + bağlama) [Ümit: "sadece önermesin, bağlasın projeye"]:** Eski karar
  ("auto-clone yok — supply-chain riski") Ümit talimatıyla tersine döndü; risk PIN ile sınırlandı. Yeni
  `skills-setup.ts` `ensureAgentSkills`: `~/.mycl/agent-skills` yoksa SABİT commit'ten (0427b5b) git fetch+checkout
  ile kurar (.tmp→rename atomik; yarışta no-op; fail → görünür uyarı + elle-kur ipucu). open_project arka planında
  koşar; kurulunca mevcut `resolveSkillsDir` + `--plugin-dir` bağlama otomatik devreye girer (depo gerçek plugin
  formatında: .claude-plugin/plugin.json + skills/). CANLI DOĞRULANDI: kurulum koştu, pin SHA'da `~/.mycl/agent-skills`
  hazır → bir sonraki codegen'den itibaren skill'ler bağlı.
- **fix(çalışırken HER ZAMAN loading + ne yaptığı) [Ümit: "çalışıyor ama hiç loading yok; çalışırken ne yaptığını
  söylesin her zaman"]:** Önceden `emit("phase_running")` sticky banner'ı YALNIZ Faz 0 + DAST kullanıyordu → diğer
  fazlarda (tasarım paneli, müzakere, codegen, mekanik) hiç gösterge yoktu. Fix: (1) `runController`'a `runningLabel`
  param → p1-p9 LLM fazları çalıştığı SÜRECE "⏳ <ne yaptığı>" banner (Niyet toplanıyor / Spec yazılıyor / UI
  yazılıyor / ...); try/finally → askq'da fn döner → idle (bekleme ≠ çalışma), takılı spinner yok. (2) Mekanik fazlar
  (10-17 lint/test/build) `runner.run()` try/finally ile `phaseLabelTR` banner'ı. Artık her faz çalışırken kalıcı
  spinner + ne yaptığı görünür. (3) Faz 5 ince alt-etiketler: "Tasarım paneli çalışıyor (4 perspektif)" → "Tasarım
  çatışmaları müzakere ediliyor" → "UI kodu yazılıyor" (her adım kendi `emitPhaseRunning`'i → staleness yok). (4)
  ÇİFT-⏳ düzeltildi: ChatPanel `.running-spinner` zaten animasyonlu ⏳ (`mycl-spin`) render ediyor → label'dan ⏳
  kaldırıldı (spinner dönüyor + label metni). Banner gerçek animasyonlu loading göstergesi.

- **feat(API desteği TAMAMLANDI: model-discovery de backend-aware) [Ümit: "API yok diye yapmadığın bişey olmasın;
  param olunca her şeyi API ile çalıştıracağım"]:** discovery artık cli → claude CLI WebSearch/WebFetch, **api →
  Anthropic SDK + server-side web_search tool** (`web_search_20250305`, name `web_search`, max_uses 5 — beta header
  GEREKMEZ; tool spec resmi Anthropic dökümanından doğrulandı, tahmin değil). Final text content-block'larından parse.
  Böylece TÜM LLM-çağıran yollar api+cli: decompose/review (runReasoning), worker (createCodegenBackend), discovery
  (cli WebSearch / api web_search). **CLI-only gap KALMADI** — "API yok diye yapma" tamamen kapandı.

- **feat(onboarding git-intent: yabancı projede "neden/ne") [Ümit eksik-listesi #4]:** `onboarding/project-map.ts`
  artık dep-map'e ek olarak `buildBackground`: README özeti (ilk 1200 char) + son 12 commit subject'i → "Proje arka
  planı" digesti. Deterministik (LLM yok, hafif). `ProjectMap.background` + `formatProjectMap` render eder; open'da
  cache'lenip orkestratör bağlamına enjekte. Kod-yok ama README/git olan projede de hakimiyet (available = dep-graph
  VEYA background). +1 test.

- **feat(API desteği: parallel-codegen WORKER backend-aware) [Ümit: "API yok diye yapmadığın bir şey olmasın; param
  olunca her şeyi API ile çalıştıracağım"]:** worker (`module-parallel/worker.ts`) artık `runClaudeCli` (CLI-only)
  yerine `createCodegenBackend` kullanıyor → `backendForRole`'a göre CLI ya da SDK (API). tag "parallel-module"
  CLI_ELIGIBLE_TAGS'e eklendi (CLI'da CLI, API'de SDK). state worktree'ye override (`{...state, project_root:
  worktreePath}`); `runMultiAgentSelection(config, state, request)` + `makeScopedCodegenWorker(config, state)` ile
  state threading (index→select→worker). Per-tool trace observer ile korundu; `outcome.kind` → {ok}. Obsolete
  standalone E2E script'leri (eski runClaudeCli worker + minimal config) kaldırıldı — engine dispatch-test'le, worker
  createCodegenBackend phase-usage'la, akış gerçek-app'le kapsanıyor. Kalan küçük edge: model-discovery WebSearch
  claude CLI aracı (saf-API-no-CLI'de API web_search server-tool gerekir). "API yok diye bırakma" büyük ölçüde kapandı.
- **feat(orkestratör kuralı: dev-ortam ayrımı + dil hattı) [Ümit eksik-listesi #3]:** `orchestrator-system.md`'ye
  eklendi: (1) ÜÇÜNCÜ kategori — DEV-ORTAM sorunu (port/server/install) kod bug'ı DEĞİL → `chat` ile çöz + pipeline'ı
  sürdür, full `debug_triage` YAPMA (o kodu teşhis eder); "kod mu, IDE mi, ortam mı?" diye analiz et. (2) DİL HATTI
  HARD kuralı: kullanıcı İngilizce bilmez; orkestratör Türkçe düşünür; "main"e ASLA DOĞRUDAN gitmez (YASAK), fazlar
  gider + translator Türkçe↔İngilizce köprüler (anlam kaybı yok); ne zaman KENDİ cevaplar (dev-ortam/durum → chat) vs
  faza delege eder kararı. (Mevcut satır 9 zaten reason/message_to_user Türkçe zorunluluğunu içeriyordu.)
- **perf(model-discovery günlük cache) [Ümit eksik-listesi #5]:** Keşif her açılışta web-arama yapıp token yakıyordu.
  `~/.mycl/model-discovery-cache.json` (24s TTL): 24 saat içinde keşif yapıldıysa web-arama ATLANIR (cache döner).
  Modeller global (proje-bağımsız) → global cache. Başarılı keşifte yazılır; bozuk/eski → yeniden ara. Günde bir kez
  web-arama yeterli (yeni model günlük çıkmaz).
- **feat(API desteği: decompose + review backend-aware) [Ümit: "her şey API'yi de desteklesin"]:** `llm-reasoning.ts`
  `runReasoning` — backend-aware (api/cli) tek-atış reasoning (backendForRole → cli=runClaudeCli, api=Anthropic SDK;
  modelId dışarıdan = canlı-tier uyumlu). `decompose.ts` (proposeModules) + `review.ts` (reviewMergedModules) artık
  `runClaudeCli` yerine `runReasoning` → API modunda da çalışır. KALAN (substantial, opt-in): parallel-codegen WORKER
  (agentic codegen loop) hâlâ CLI-only — API yolu State threading + SDK tool-loop ister; model-discovery WebSearch CLI
  aracı (saf-API'de API web_search gerekir). Flag'lendi.
- **fix(model keşfi: YENİ aile otomatik tier'lanıp KULLANILIR — manuel bırakma) [Ümit: "yeni model geldiyse o
  kullanılsın; güncellenmeli, eski kalmasın"]:** Önceki tutum yeni aileyi (Mythos vb.) "manuel" bırakıyordu →
  MyCL eski kalırdı. Düzeltme: discovery prompt artık her modele dökümandaki konumlandırmadan TIER attırır (en
  yetenekli→strong, en hızlı→cheap). `setLiveTiersFromModels` HİBRİT: bilinen aile (opus/sonnet/haiku) DETERMİNİSTİK
  (güvenlik ağı, LLM hatasını ezer), YENİ aile → LLM'in dök-tier'ı → OTOMATİK atanır + kullanılır (en-yetenekli-başta
  sıralı → ilk per-tier kazanır). Yeni flagship (Mythos 1) strong'a girer → codegen/spec onu kullanır. Manuel adım
  YOK; MyCL hep güncel. Test güncellendi (yeni aile auto-atama + selectModelForTask onu verir).
- **fix(model keşfi: API yerine WEB ARAMA) [Ümit: "keşfin API ile alakası yok; LLM internette Anthropic/Claude
  dökümanlarından bulsun"]:** Models-API keşfi (API key gerektiriyordu → abonelik-only kullanıcıda çalışmıyordu)
  WEB-ARAMA keşfiyle DEĞİŞTİRİLDİ. `model-discovery.ts` `discoverModelsViaWeb`: claude CLI (WebSearch/WebFetch)
  Anthropic'in RESMİ dökümanlarını arar → güncel model id'leri/adları → `setLiveTiersFromModels` (deterministik aile-
  tier: opus→strong vs). **API key GEREKMEZ → abonelikte çalışır.** Hatasızlık: yalnız resmi kaynak + `claude-*` id
  deseni doğrulaması (uydurma/yanlış id reddedilir); başarısız → statik katalog. open_project'te background, non-
  blocking. +3 test. (Sandbox dosya/bash hapsi yapar ama WebSearch sunucu-taraflı → ağ engellenmez.)
- **feat(model AUTO-KEŞİF: açılışta güncel modelleri çek + tier'la) [Ümit: "her açışta güncel versiyonları çek,
  yeni çıkanı senin tablon gibi tier'la, 1-2 sürüm yukarı taşı"]:** `model-catalog.ts` `setLiveTiersFromModels` —
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
- **fix(model-alaka "kaliteli hız" kesin tanım: kaliteyi düşüren hız YOK) [Ümit: "kalitesinden ödün vermeyecek
  şekilde hızlı; hız kaliteyi azaltıyorsa yapma"]:** Kalite SABİT kısıt. TASK_RELEVANCE'tan `classification → cheap`
  (haiku) KALDIRILDI → artık HİÇBİR iş cheap(haiku)'ya düşmüyor (haiku sınıflandırma/çeviri kalitesini riske atar);
  en düşük tier = balanced (sonnet, tam-kalite + hızlı). Hız yalnızca kalite-nötr kaynaklardan: paralellik + kalite-
  eşit-yerde-hızlı-model + faz-atlama. Test: "hiçbir iş cheap değil". feedback_kaliteli_hiz belleği kesin tanımla güncel.
- **feat(model "kaliteli hız" — Faz 4 spec + Faz 8 codegen → strong tier) [Ümit: "önemli olan kaliteli hız"]:**
  Auto-override AÇIK + akıllı: KALİTE-kritik fazlar (spec her şeyi sürer, codegen kod üretir) selectModelForTask ile
  strong tier (opus) seçer + formatModelChoice ile chat'te gösterir. Hafif/sık fazlar (orchestration/translation/
  intent — config'te zaten sonnet) hızlı kalır → kalite gereken yerde güçlü model, gerisinde hız. config.model_tiers.
  strong'dan çözülür; geçersiz → güvenli katalog fallback. Aynı desen review/debug'a genişletilebilir.
- **feat(model-alaka listesi — katalog + iş→model seçimi) [Ümit: "iş için doğru modeli seç, hatasız liste, chat'te
  göster, güncel tut"]:** `model-catalog.ts` — TÜM Claude modelleri (opus-4-8/4-7/4-6, sonnet-4-6, haiku-4-5) tier'lı
  HATASIZ katalog + `TASK_RELEVANCE` (iş→tier: classification/translation→fast-değil-balanced, orchestration/intent/
  verification→balanced, spec/codegen/design/review/debug→strong) + `selectModelForTask` (task→tier→model, config
  model_tiers'tan çözer; geçersiz model → katalog varsayılanına GÜVENLİ fallback, sistem bozulmaz) + `formatModelChoice`.
  KRİTİK: çeviri 'fast' DEĞİL (anlam kaybı olmamalı). +12 test (benzersizlik, her tier var, exhaustive eşleme, güvenli
  fallback). GÜNCEL TUTMA: yeni model → MODEL_CATALOG'a satır ekle. Sıradaki: seçimi chat'te göster + LLM-çağrısına bağla.
- **fix(Faz 5 dev-ortam ≠ proje: çalışan server'ı tanı) [Ümit: "5176'da başlatınca çözülmüştü, dev-ortam sorunuydu,
  orkestratör bunu kendi analiz etmeli + kaldığı yerden devam"]:** Faz 5 eskiden HER ZAMAN yeni dev-server spawn
  ediyordu; dışarıdan çalışan server'ı (kullanıcı elle başlatmış, örn. başka portta) tanımıyordu → resume edilince
  boşuna yeniden deneyip fail ediyordu. Düzeltme: spawn'dan ÖNCE aday + yaygın dev portları (5173-5178, 3000) KISA +
  PARALEL HTTP-yoklanıyor (`waitForDevServer`); biri yanıt veriyorsa onu KULLAN + tarayıcı aç + `phase-5-complete`
  (spawn yok). Böylece resume edilen Faz 5 çalışan server'ı bulur, dev-ortam sorunu gereksiz tam-debug'a girmez.
  Yanlış server riski Phase 6 smoke testiyle yakalanır (güvenlik ağı).
- **fix(Faz 4 DİL HATTI: kullanıcıya İngilizce sızıntı kapatıldı) [Ümit: "kullanıcı İngilizce bilmiyor, anlam kaybı
  olmamalı"]:** Ekran kanıtı: spec varsayımları kullanıcıya İNGİLİZCE gösteriliyordu (main spec EN üretir, çevrilmeden
  emit ediliyordu). Düzeltme: (1) `phase-4` preApprovalHook varsayımları emit'ten ÖNCE `translate(..., "en-to-tr")`
  ile Türkçeye çevirir (çeviri başarısızsa İngilizce fallback, bloklamaz). (2) Kör-nokta merceği (`pre-commit-lens`)
  prompt'una "note/recommendation'ı TÜRKÇE yaz (kullanıcı doğrudan okur, İngilizce bilmez)" eklendi → mercek bulguları
  artık Türkçe (format etiketleri zaten Türkçeydi). Faz-sırası: Faz 4 dil işi.
- **fix(UI: askq kartı kronolojik konumda — "yazım yukarı geliyordu") [Ümit]:** ChatPanel eskiden tüm mesajları
  sonra askq kartını render ediyordu → kart hep en altta sabit → askq pending iken composer'dan yazılan mesaj kartın
  ÜSTÜNDE kalıyordu. Artık kart sorulma zamanına (`PendingAskq.ts`) göre KRONOLOJİK render ediliyor: sorudan SONRA
  yazılan mesaj kartın ALTINDA görünür. `PendingAskq.ts` eklendi (App.tsx askq reduce'da Date.now()). Faz-sırası: Faz 1
  (askq/dil) işi.
- **fix(Faz 0 orkestratör hakimiyeti: debug iptali → kaldığı yerden DEVAM) [Ümit: "vazgeç dedim, Faz 0'da kaldı,
  her şeyi unuttu — 'kaldığım yerden devam edeyim' demeli"]:** D2_WAITING "Vazgeç" eskiden sadece `pending_diagnostic`'i
  temizleyip `return` ediyordu → pipeline kaldığı fazda donuyor, orkestratör Faz 0'da takılı görünüyordu. Artık:
  debug bir KESİNTİ olarak ele alınıyor — `debug_triage` zaten `current_phase`'i değiştirmiyor → Vazgeç'te o faz
  mid-flight (Faz 1-9) ise "🔄 Faz N'den kaldığım yerden devam ediyorum" + `advanceToNextPhase(N-1)` ile resume; idle/
  tamamlanmışsa sadece durur. Çalışma sırası: işler MyCL fazlarına göre, Faz 0'dan (hız hariç — o tüm fazlar). KALAN
  (Faz 5): dev-ortam≠proje ayrımı (port yoklama) — resume edilen Faz 5 dev-server'ı yeniden denememesi için.
- **feat(orkestratör düşünme süreci görünür: `thinking` alanı) [Ümit: "sadece kararı yazmış, ne düşündüğünü de
  yazsın"]:** `decide_action` şemasına `thinking` alanı eklendi — **action'dan ÖNCE** (chain-of-thought: önce
  adım-adım muhakeme, sonra karar → karar kalitesine de katkı). SDK yolu (DECIDE_ACTION_TOOL_SCHEMA) + CLI yolu
  (DECISION_OUTPUT_INSTRUCTION) ikisi de üretir; `parseAgentDecision` opsiyonel olarak ayıklar; `AgentDecision.thinking`.
  AgentThinkingModal kararın üstünde "💭 Düşünce:" bloğunda gösterir (whitespace-pre-wrap). Modal başlığı kronolojiğe
  göre düzeltildi ("en yeni altta"). NOT: `tool_choice:"any"` modeli decide_action'a zorladığı için narrative-text
  yakalama güvenilmezdi → şema alanı güvenilir çözüm (model her zaman doldurur).
- **feat(UI: orkestratör düşüncelerini banner'dan aç + kaymasın) [Ümit: "Model çalışıyor'a tıklayınca popup açılsın,
  aşağı kaymasın, manuel kaydırırım"]:** `ChatPanel` running-banner ("🤖 Model çalışıyor") artık tıklanır →
  `onOrchestratorClick` ile orkestratör düşünce modalını (AgentThinkingModal) açar + "💭 düşünceler" ipucu + cursor
  pointer. `AgentThinkingModal` artık KRONOLOJİK (yeni olay ALTTA, eskiden reverse=yeni üstte) → yeni düşünce
  geldiğinde üstte okunan içerik AŞAĞI KAYMAZ; oto-scroll yok, kullanıcı manuel kaydırır. Frontend typecheck temiz.
- **feat(paralel titizlik açığı KAPATILDI: tam kalite pipeline + anlamsal review) [Ümit: "evet işte bu" + "anlamsal/
  business code review edelim"]:** Çoklu Ajan Seçimi yolu artık erken `return` ETMİYOR → paralel sonucu
  `advanceToNextPhase(9)` ile **Faz 10-17 tam kalite pipeline'ından geçiriyor** (codegen'den sonra geldiği için ezmez,
  sadece doğrular: lint/sadeleştir/perf/güvenlik/birim/entegrasyon/e2e/yük) + GERÇEK pipeline-sonu tazeleme (living-
  docs/proje-haritası/handoff) ondan koşar. Önceki `verifyBuild` (yarım subset) + manuel refresh KALDIRILDI (gerçek
  pipeline supersede etti; verify.ts silindi). **+ (b) anlamsal/business code review** (`module-parallel/review.ts`
  `reviewMergedModules`): bağımsız ajanların birleşik çıktısını BÜTÜN hâlinde inceler (business-logic + modüller-arası
  uyum + gizli kuplaj) → mekanik kapıların göremediği semantik katman; bloklamaz, yüzeye çıkarır. +2 test. Decompose
  riski (Luke #2) modüler-ilke (davranışsal-bağlı şeyler ayrı modüle konmaz) + bu review ile kapatıldı.
- **feat(#3: paralel sonrası dinamik kısımlar bayatlamasın — "her zaman dinamik kal") [Ümit: "sonra da MyCL'in hakim
  olduğu kısımlara etkilerini araştır … bayat/eksik kalmasın"]:** ARAŞTIRMA: Çoklu Ajan Seçimi yolu erken `return`
  ettiği için pipeline-SONU tazeleme adımlarını (updateLivingDocs + proje-haritası + handoff + module-stock) ATLIYORDU
  → yaşayan dökümanlar/proje-haritası/devir bayatlıyordu. FIX: paralel build + verify sonrası `updateLivingDocs` +
  `clearProjectMapCache` (+ arka planda recompute) + `appendHandoff` çağrılır → MyCL'in hakim olduğu dinamik kısımlar
  güncel kalır. Relevance zaten on-demand (git/dosyadan okur → otomatik taze, reindex gerekmez). Diğer code-yazan
  yollar (fix/develop) pipeline-sonu tazelemeden zaten geçiyor → kapsam tam.
- **perf(#2: kalite kapısı taramalarını paralelleştir — güvenli kısım) [Ümit: "sonra 2"]:** `mechanical-runner`
  `extra_scans` döngüsü (Faz 13: semgrep/gitleaks/csp/headers vb.) seri `for...await`'ten `Promise.all`'a → BAĞIMSIZ +
  salt-okunur taramalar paralel = saf hız, çakışma yok (kod yazmazlar). abort'ta hiç başlatma; fail-aggregation sıra-
  bağımsız (eşdeğer sonuç). DÜRÜST KAPSAM: fazlar-ARASI paralel YAPILMADI (faz-makinesi/singleton'ı bozar, riskli);
  yalnız faz-İÇİ bağımsız taramalar. Yazan fazlar (lint_fix/simplify) seri kalır.
- **feat(Çoklu Ajan Seçimi TAMAMLANDI — #1: paralel sonrası kalite kapıları + Settings toggle) [Ümit: "1"]:**
  (a) `module-parallel/verify.ts` — `verifyBuild`: paralel build SONRASI stack profilinden build/lint/test/güvenlik
  koşar (komut yoksa skip), `formatVerifyResult` özet. Develop dalında `sel.used` sonrası otomatik çalışır → paralel
  kod "yazıldı" bırakılmaz, doğrulanır. +1 test (saf format). (b) **Settings UI toggle:** `multi_agent_selection` flag'i
  uçtan uca bağlandı — events.ts (2) + save handler (index.ts payload/destructure/flagsPatch/emit) + App.tsx (state/
  receive/param/set/persist/prop) + Settings.tsx (prop/state/checkbox "Çoklu Ajan Seçimi"/onSave). Artık config.json
  düzenlemeden Settings'ten açılıp kapanıyor. Frontend typecheck temiz.
- **feat(ajan-içi TAM İZ — kör nokta kalmasın) [Ümit: "ajanlar birbiriyle konuşuyor, bu süreçleri logla, tam trace"]:**
  `agent-trace.ts` — kalıcı iz (`.mycl/traces/agents.jsonl`): `setAgentTraceRoot` (open_project'te set) +
  `traceAgentEvent` (O_APPEND, non-blocking) + `readAgentTrace`. Bağlandı: (1) `emitAgentEvent` (ipc) artık UI'ya
  gösterdiği HER olayı ize de yazar; (2) paralel worker'lar TÜM tool çağrılarını + final çıktısını modül-etiketiyle
  ize ekler (eski kör nokta: yalnız başla/bit loglanıyordu); (3) gerçek Agent Teams peer-müzakere çıktısı (design-
  fanout CLI yolu) ize eklenir. **GERÇEK E2E doğrulama:** 2-modül paralel koşuda iz 17 kayıt yakaladı (datefmt:7,
  arrutil:10), her worker'ın tool_use'ları ajan-etiketli. +3 test. → Ajan süreçlerinde tam izlenebilirlik, kör nokta yok.
- **feat(ÇOKLU AJAN SEÇİMİ — paralel codegen develop akışına bağlandı) [Ümit: "şimdi kur, adı çoklu ajan seçimi olsun"]:**
  Flag `multi_agent_selection` (config, varsayılan KAPALI → normal akış sıfır etkilenir). `module-parallel/select.ts`
  `runMultiAgentSelection` — flag açık + niyet ≥2 GERÇEKTEN bağımsız modüle bölünüyorsa izole worktree'lerde PARALEL
  yazdırır + ayrık entegre; aksi/hata → seri (fail-closed). Develop girişine (`index.ts` case develop_new_or_iter)
  opt-in dal: kullanıldıysa paralel build + görünür rapor + return (fresh seri pipeline üzerine yazmaz). Worker artık
  per-modül `agent_event` yayınlar → AgentThinkingModal "🤖 <modül>" gösterir (görünürlük tie-in). **GERÇEK E2E
  (flag açık, no mock):** ilk koşu worker scope-dışı (package.json) yazdı → entegrasyon REDDETTİ (defense çalıştı,
  fail-closed); worker promptu sertleştirildi (config/init yasak) → 2. koşu `used:true`, 2 modül paralel + 15 dosya
  entegre, görünürlük olayları aktı. +1 test (flag-kapalı fail-closed). Kalan (ileride): paralel sonrası kalite
  fazlarını otomatik koşma + UI toggle.
- **feat(modül-paralel — decomposition + TÜM canlı zincir E2E GEÇTİ) [Ümit: "devam et"]:** `module-parallel/
  decompose.ts` — `proposeModules` (LLM işi ≥2 AYRIK modüle böler; planlayıcı promptu "kod yazma, SADECE JSON";
  `allowedTools:[]`+`disallowedTools` ile kodlama moduna kaçışı engellenir) + `parseModulesResponse` (saf, +3 test) +
  K1 kapısı doğrular → over-claim/bölünemez → null → SERİ (fail-closed). **GERÇEK uçtan-uca E2E** (`scripts/e2e-
  parallel-full.mjs`, no mock): istek → LLM böldü (2 ayrık modül, 5sn) → `runParallelModules` gerçek worker'larla
  paralel + ayrık entegre (3 dosya, 52sn) → `parallel:true ok:true`, çakışma yok. İLK denemede LLM planlamak yerine
  kodlamaya kalkmıştı (JSON yok→null); prompt sertleştirilince düzeldi. Kalan (opt-in): Faz 5/8 pipeline auto-hook.
- **test(modül-paralel codegen — GERÇEK 2-modül E2E GEÇTİ, no mock) [Ümit: "2 modüllü proje ile E2E, mock yok"]:**
  `orchestrator/scripts/e2e-parallel-codegen.mjs` — geçici git repo + 2 ayrık modül (greet/calc), GERÇEK
  `makeScopedCodegenWorker` (sonnet, abonelik) ile `runParallelModules`. Sonuç: `parallel:true, ok:true`, iki modül
  PARALEL izole worktree'de yazıldı + ayrık entegre (10 sn, 2 api_call), `src/greet/greet.ts` + `src/calc/add.ts`
  doğru gerçek kod, çakışma/sızıntı yok, worktree'ler temizlendi. → Paralel codegen çekirdeği (K1 kapı + K2 worktree +
  K4 dispatch + gerçek worker) UÇTAN UCA KANITLANDI. Kalan (opt-in, ileride): LLM decomposition + Faz 5/8 pipeline hook.
- **feat(#2 onboarding — yabancı koda hakimiyet, ilk artım) [Ümit: "unutma dediğim işi yap"]:** MyCL kendi
  yaratmadığı/ilk gördüğü projeyi anlasın diye: `onboarding/project-map.ts` — `buildProjectMap` (mevcut
  `fix/dep-graph` reverse-import'undan en MERKEZİ modülleri çıkarır = "önce buraya bak, dokunursan etkisi geniş") +
  `formatProjectMap` (saf digest) + cache (`getCachedProjectMap`/`peekProjectMap`/`clearProjectMapCache`).
  `open_project`'te ARKA PLANDA hesaplanır (bloklamaz), `clearProjectMapCache` ile proje değişince sıfırlanır;
  `context-builder` cache'i peek edip orkestratör recall'ına enjekte eder → AI ilk turdan yabancı projenin iskeletini
  bilir. Hafıza notuna sadık: koddan türet, HAFİF dep-map, ağır graph DB YOK (turbogrep dersi). +3 test. Derinleştirme
  (git-niyet, mimari anlatı) sonraki artım.
- **feat(Agent Teams görünürlüğü) [Ümit: "ajanların çalıştığı + hangi ajan ne iş görünür olsun"]:** Mevcut
  `agent_event` + `AgentThinkingModal` altyapısı yalnız TEK orkestratör ajanını gösteriyordu; design-fanout'un 4
  perspektifi (Mimari/UX/Güvenlik/Veri — asıl Agent Teams) hiç emit etmiyordu. Eklendi: `agent_event`'e `agent_label`
  (events.ts + ipc.ts); `design-fanout` her perspektifte started/completed yayınlar (finally ile dengeli sayaç);
  `App.tsx` reduce ETİKETLİ ajanları hem sayar hem listeler (etiketsiz orkestratör eskisi gibi yalnız sayaç);
  `AgentThinkingModal` "🤖 &lt;ajan&gt;" rozetiyle gösterir → kullanıcı hangi ajanın canlı çalıştığını/bittiğini görür.
  Paralel-codegen worker'ları (K4) aynı kanalı modül-id ile kullanabilir. Frontend typecheck temiz.
- **feat(modül-paralel codegen — K4 dispatch motoru) [Ümit: "k3 k4'e devam"]:** `module-parallel/dispatch.ts`
  `runParallelModules`: gate(K1) → her modül izole worktree(K2) → worker'lar PARALEL(`Promise.allSettled`) →
  hepsi başarılıysa disjoint değişiklikleri ana ağaca SERİ entegre (`integrateWorktrees`: kapsam-dışı + dosya-
  çakışması defense'i) → temizlik. Her aşama FAIL-CLOSED (gate/worktree/worker/entegrasyon hatası → temizle + caller
  seri). `runWorker` ENJEKTE → motor mock + gerçek git fixture ile UÇTAN UCA test edildi (happy/worker-fail/kapsam-
  dışı; +`pathWithin`). +4 test. KALAN: gerçek worker (worktree'de scoped codegen) + decomposition (LLM modülleri
  öner) + pipeline hook — opt-in/fail-closed; bu ortamda doğrulanamaz (gerçek ≥2-modül koşusu).
- **feat(modül-paralel codegen — K1 güvenlik kapısı + K2 worktree izolasyon) [Ümit: ">1 modül → paralel yaz, hızlan"]:**
  Plan: additive + gated + fail-closed (mevcut SERİ codegen DEĞİŞMEZ). **K1** `module-parallel/independence.ts` — SAF
  kapı (`pathsOverlap` + `modulesDisjoint` + `shouldParallelize`): paralele YALNIZ flag açık + ≥2 modül + AYRIK
  yol-kapsamı hepsi doğruysa girilir; şüphe/çakışma → seri (Luke'ın çakışma tuzağına karşı yapısal koruma). **K2**
  `git.ts` `createWorktree`/`removeWorktree` — izole çalışma kopyası (başarısız → null → seri). +9 test (gerçek git
  fixture dahil). **KALAN (büyük, çekirdeğe dokunur, AYRI tur):** K3 decomposition (işi ayrık-kapsam modüllere bölme)
  + K4 dispatch/entegrasyon — bu ortamda uçtan-uca DOĞRULANAMAZ (gerçek ≥2-modül koşusu gerekir); güvenli devreye
  alma için opt-in + fail-closed kalacak.

## 2026-06-08

- **feat(WTF/gotcha kaydı — Cichra karar-yakalamanın 4. biçimi) [Ümit: "WTF ekle"]:** "Bu tuhaf şey bilerek böyle,
  dokunma" tuzak notları. `WtfRecord` + `appendWtf`/`readWtf` (audit.ts → ayrı `.mycl/wtf.jsonl`, handoff deseni);
  Faz 0 hata-ayıklaması kök neden + bağımlılık etki-alanını OTOMATİK WTF olarak yazar; `context-builder` son WTF'leri
  orkestratör recall'ına "### Bilinen tuzaklar (dokunmadan önce oku)" diye enjekte eder → bilerek-böyle olan kod
  yanlışlıkla bozulmaz. +2 test. Karar-yakalama artık 4 biçim TAM (ADR=decisions + BDD=AC + PRD=living-docs + WTF).
  Genişletme: WTF'i kodlama-anı tuhaflıklarından da yakalamak (şimdilik yalnız hata-ayıklama). MyCL-Yetenekler.html
  güncellendi (WTF + Agent Teams durumu: Faz 5 tam-aktif).
- **feat(#3 bağımlılık etki-alanı → fix codegen'i) [Ümit: "faydalı isteğe-bağlıları yap"]:** Faz 0 D1'in ZATEN
  hesapladığı deterministik bağımlılık blast-radius'unu (`state.pending_diagnostic.affected`) fix payload'ına ekler →
  Faz 8 codegen AI "bu fix şu dosyaları etkiler"i grep'le yeniden keşfetmeden görür (token tasarrufu + dependent'i
  kaçırmama). Tam da fix/debug penceresi (dep-map'in en parladığı yer). `formatBlastRadius` (SAF, fix/dep-graph;
  +3 test); index.ts fix payload'ına eklendi. **Süzgeç:** #1-Faz2 (marjinal + qa-askq'ya dolaşık) ve
  ④ PRD-relevance / #2 subtract / yabancı-proje onboarding ATLANDI — faydalı-değil / güvenli-aday-yok / "sonra".
- **fix(2 olmazsa-olmaz kusur — aktif "must-have" taramasından) [Ümit: "diğer olmazsa olmaz işleri bul"]:**
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
- **fix(noteCliRateLimitError'ı BAĞLA — yarım-bağlı güvenilirlik yolu) [Ümit: "olmazsa olmaz olanları yap"]:**
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

- **fix(macOS izin pencereleri — KAYNAĞINDA kes: sandbox-exec klasör-guard) [Ümit: "gereksiz yerler için izin
  istiyor"]:** Env bayrakları (DISABLE_ATTACHMENTS vb.) claude'un başlangıç klasör-taramasını (Downloads/Documents/
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
- **feat(③ handoff consumer — devir döngüsünü kapat) [Ümit: "devam et"]:**
  ③'ün yazma-tarafı vardı (handoffs.jsonl); şimdi OKUMA/tüketme: `readHandoffs` (audit.ts) + orkestratör recall
  (context-builder.ts) son 6 faz devrini system-prompt'a enjekte ediyor ("### Recent phase handoffs"). Böylece
  ajan son faz sonuçlarını (özellikle fail + keşfedilen testsiz-AC) görüp HEDEFLİ takip önerebilir (Missions:
  "başarısızlık → hedefli takip-özelliği, rewrite değil"). Missions handoff döngüsü tam: yaz→oku→sonraki kararı besle.
  +2 test (readHandoffs roundtrip/empty).
- **feat(② validator-katmanı framing + ③ structured handoff — Luke/Missions) [Ümit: "1 2 3"]:**
  ② Orchestrator-system.md §14'e "doğrulama katmanı" notu: 3 bağımsız adversarial validator (pre-commit-lens=
  kör-nokta, harness-verdict=scrutiny, verify-feature=user-testing/canlı-davranış) tek disiplin altında; özellik
  milestone'u bitince davranışsal doğrulamayı (verify-feature) çalıştır ("test ettim" demeden), AC↔test bunların
  zorladığı sözleşme. (Prompt-düzeyi, kod riski yok.) ③ `appendHandoff` (audit.ts) → AYRI `.mycl/handoffs.jsonl`
  (gate'in audit.log'unu KİRLETMEZ); Faz 8 complete/fail'de yapılandırılmış devir kaydı (status + green/red/debt/
  score + keşfedilen testsiz-AC) — resume/uzun-koşu + "doğrulama ilk seferde geçmez → hedefli takip" zemini. +2 test.
- **feat(keystone ① ENFORCEMENT — Michal "ölçemiyorsan zorlayamazsın") [Ümit: "1 2 3"]:** Faz 8 gate artık
  KOŞULLU zorluyor: worker testleri AC-id ile etiketliyorsa (`acCov.tagged`) VE kapsanmayan AC varsa → gate GEÇMEZ
  (fail-reason'da testsiz AC'ler + nasıl etiketleneceği). Worker hiç etiketlemiyorsa (SDK modu/eski akış) →
  `tagged=false` → enforcement GRACEFUL kapalı (eski davranış, regresyon yok). Çalıştırılabilir doğrulama-sözleşmesi
  artık sadece görünür değil, zorlanabilir.
- **feat(pre-hoc bağımsız kör-nokta merceği — algoritmanın kalıcı parçası) [Ümit: "her yere lazım"]:**
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
- **fix(macOS izin pencerelerinin ASIL kaynağı: `claude update` claudeSpawnEnv'i baypas ediyordu) [Ümit: "claude bunları istemiyor, başka bir sorun var, onu bul"]:**
  Ümit'in içgörüsü doğru çıktı: claude'u terminalde çalıştırınca izin çıkmıyor ama MyCL'de çıkıyordu →
  kaynak FAZ-1 claude'u değil. [claude-updater.ts:67](orchestrator/src/claude-updater.ts) startup'ta
  `spawn(claudeBin, ["update"])`'i **`env: claudeSpawnEnv()` OLMADAN** çağırıyordu → disable bayraklarım
  (AUTO_CONNECT_IDE/DISABLE_ATTACHMENTS) bu spawn'a HİÇ ulaşmadı; üstelik `claude update` claude'u tam modda
  (headless `-p` değil) başlatıp TÜM taramaları (IDE/tarayıcı/klasör/medya→Apple Music) yapıyordu. **Fix:**
  updater spawn'ına `env: claudeSpawnEnv()` eklendi (NONESSENTIAL_TRAFFIC çıkarıldı ki güncelleme ağı çalışsın).
  Artık startup-update de taramasız → izin pencereleri kaynağında kesilir.
- **fix(macOS izin pencereleri 2: klasör taramasını da kapat — DISABLE_ATTACHMENTS) [Ümit: "gereksiz izin istemesin, sürekli istemesin"]:**
  AUTO_CONNECT_IDE=0 IDE/tarayıcı taramasını kestiyse de "Belgeler/İndirilenler" izinleri sürdü — ayrı yol:
  claude'un `KR7` fonksiyonu `{HOME/Desktop/Documents/Downloads}` haritasını kurup **dosya-ekleme (attachment)**
  özelliği için dokunuyor (yanında MAX_FILE_SIZE 512MB/MAX_FILE_COUNT/COMPRESSION_RATIO limitleri). MyCL claude'a
  dosya-ekleme yaptırmıyor → `claudeSpawnEnv`'e `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` eklendi (claude bununla çalışır,
  doğrulandı ATTACH_OK) → klasör taraması kaynağında kesilir. NOT: teşhis sırasında büyük binary'de `strings`'i
  eşzamanlı koşturmak makineyi çökertti → bundan sonra ağır/eşzamanlı tarama yok (bkz. memory feedback_resource_careful).
- **fix(macOS izin pencerelerinin GERÇEK kaynağı: claude IDE oto-bağlanma taraması) [Ümit: "indirilenler + apple music izni istedi"]:**
  Whack-a-mole çözüldü: claude binary'sinde **ComputerUseSwift** + IDE oto-bağlanma var — `InstalledApps`
  (kurulu uygulama enum → "Apple Music"), Chrome/Brave/Edge `DevToolsActivePort`, DESKTOP/DOCUMENTS/DOWNLOADS
  tarıyor → macOS her korumalı kaynak için ayrı TCC izni soruyor (önce tarayıcı, sonra Downloads, sonra Music...).
  Bu claude'un KENDİ taraması — MyCL'in `--settings` sandbox'ı kapsamıyor + her deploy ad-hoc imzayı değiştirip
  TCC'yi sıfırlıyordu. **Çözüm:** `claudeSpawnEnv`'e `CLAUDE_CODE_AUTO_CONNECT_IDE=0` + `CLAUDE_CODE_DISABLE_
  NONESSENTIAL_TRAFFIC=1` eklendi — MyCL claude'u HEADLESS sürüyor, IDE'ye bağlanma/gereksiz trafiğe ihtiyacı yok →
  tarama yapılmaz → TCC prompt'u çıkmaz. claude'un bu env'lerle sorunsuz çalıştığı doğrulandı (ENVTEST_OK).
  (binary strings ile teşhis: AUTO_CONNECT_IDE gate + InstalledApps/DevToolsActivePort.)
- **fix(görünür hataları temizle: graceful degradation + A2 geri-al) [Ümit: "hala aynı sorunlar... sorunu aşartır"]:**
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
- **fix(list_models "Request timed out" — SDK 0.102 timeout regresyonu) [Ümit: "yaptıklarını bozuyorsun"]:**
  SDK yükseltmesinden (0.40→0.102) sonra startup'ta `list_models failed: Request timed out` çıkıyordu
  (`client.models.list()` geçici API/ağ yavaşlığında 0.102'nin daha kısa varsayılan timeout'uyla patlıyordu;
  0.40 toleranslıydı). `models.list()` aslında çalışıyor (test: 10 model 1.1s) — sorun transient timeout. **Fix:**
  `models.ts` Anthropic client'ına AÇIK `timeout: 20_000` + `maxRetries: 3` → SDK timeout/429/5xx'te otomatik
  retry yapar, geçici hata sessizce atlatılır. (SDK bump regresyonunun düzeltmesi.)
- **fix(relevance CLI prompt-çelişkisi → "no valid relevance_scores block") [Ümit: "kırmızı hata"]:** Abonelik/CLI
  modunda relevance classifier hata veriyordu (trace.log: `cli classifier: no valid relevance_scores block`).
  **Kök neden:** `classifier.ts` SYSTEM_PROMPT'u "Output via the score_chunks **tool**" diyordu (API için), CLI
  yolu buna `CLI_JSON_INSTRUCTION` ("**Do NOT call any tool**, output JSON") EKLİYORDU → ÇELİŞKİ → sonnet-4-6
  `{"kind":"relevance_scores"}` bloğunu üretmiyordu. **Fix:** `SYSTEM_PROMPT_BASE` (çıktı-talimatsız) ayrıldı;
  API tool-suffix, CLI text-JSON-suffix ALIR (çelişki yok). `parseCliScores` dayanıklılaştı (kind eksikse bile
  `scores[]` içeren bloğu kabul eder, `extractLastJsonObject`). **CANLI doğrulandı** (sonnet, gerçek skorlama:
  ilgili chunk 9, alakasız 0). 61 relevance testi yeşil.
- **fix(macOS "başka uygulama verisi" izin penceresi) [Ümit: "her açtığımda izin istiyor"]:** macOS TCC prompt'u
  "MyCL Studio diğer uygulamalardaki verilere erişmek istiyor" çıkıyordu. **Kök neden:** agent-sandbox darwin'de
  `Library` runtime-allow'da (Caches/Playwright için gerekli) → sandboxlı claude ~/Library altında BAŞKA
  uygulamaların verisine (~/Library/{Containers, Application Support, Group Containers}) erişebiliyordu. **Fix:**
  bu 3 "App Data" alt-yolu agent denyRead'ine eklendi (darwin); `Library` KÖKÜ açık kalır (Caches/Preferences/
  Playwright çalışır). claude'un ~/Library'siz auth+okuma yaptığı ampirik doğrulandı; denyCount 9→12. **NOT:**
  TCC prompt'u yalnız gerçek macOS GUI'de doğrulanır (headless değil) + tetikleyici kısmen `claude update`
  (unsandboxed, her açılış) olabilir → Ümit yeni build'de teyit etmeli; sürerse auto-update tarafına bakılır.
- **fix(rate-limit yanlış-pozitif: "allowed_warning" ≠ bloklu) [Ümit raporu: "limit dolu değil"]:** Kullanıcıda
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
- **security(least-privilege: yalnız gerekli Tauri izinleri) [Ümit isteği: "sadece gerekli izinleri istesin"]:**
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
- **style(orkestratör çıktısı: cümleler arası boş satır) [Ümit isteği]:** orchestrator-system.md "## 12. Tone"
  bölümüne "Sentence spacing" alt-kuralı eklendi — orkestratör ajanı `reason` (chat) çıktısında birden çok cümle
  yazınca her cümleyi 1 boş satırla ayırır (chat panelinde ayrı paragraf → okunaklı). Yalnız BİÇİM; mevcut
  "max 1-2 cümle" sınırı korunur. (Bu seansta Ümit'in benden istediği biçimi orkestratöre de taşıma.)
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
- **feat(claude oto-güncelleme) [Ümit isteği: "her açıldığında güncellesin otomatik"]:** MyCL açılışında
  (App.start) claude CLI'yı arka planda otomatik günceller — yeni `claude-updater.ts` (`autoUpdateClaude`):
  non-blocking (boot'u geciktirmez), feature flag `features.auto_update_claude` (default AÇIK), test/CI/harness'ta
  guard'lı (VITEST/CI/NODE_ENV=test/MYCL_DISABLE_AUTO_UPDATE → çalışmaz; yan etki/non-determinizm yok), yalnız
  GERÇEKTEN güncellenince görünür mesaj, hata yutulur. Saf `interpretUpdateOutput` (exit+çıktı → updated/current/
  failed; "exit 0 ama belirsiz → current" = yanlış mesaj verme) + 4 test. `claude update` resmi+güvenli işlem.
- **feat(orkestratör yetenek farkındalığı) [Ümit isteği: "orkestra ajanı da bilsin"]:** orchestrator-system.md'ye
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
- **feat(auto-model) [yapılacak işe göre model + auto-agent — Ümit isteği]:** Fan-out alt-ajan modelleri artık
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
  desenine taşındı. Ümit: "abonelikte de her şey yapılıyor, kısıtlama gereken durum yok" — haklı: bu
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
  onay-gated aktif DAST (nuclei). YENİ ÖZELLİK (Ümit: "composer'ın altında buton, basınca açıkla + emin
  misin?"). design+SERT-adversaryal-güvenlik workflow (wf_3ebf64a7, verdict: rework → bu güvenli sentez).
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
  (Ümit: "tüm katmanların kaliteli çalıştığını kontrol et"). 5-ajanlı adversaryal denetim 6 GERÇEK
  bug buldu (kanıtlı) → hepsi düzeltildi + regresyon testi + `npm run check` yeşil (858 test):
  - **(1) Test izolasyon kaçağı (kanıt: gerçek hasar):** `agent-memory/store.test.ts` credential-warning
    bloğu `MYCL_HOME` izole etmiyordu → her test koşusunda GERÇEK `~/.mycl/agent-memory-general.jsonl`'e
    sahte `sk-ant-…` + `password=…` satırları yazıyordu (618 satır birikmiş; orkestratör recall'ına
    sızıyordu). Kirli dosya yedeklenip temizlendi; teste temp-`MYCL_HOME` izolasyonu eklendi.
  - **(2) Dev-server orphan:** 3 nokta (yeni-iterasyon reset / Faz-2-abandon / Faz-5-respawn) eski
    `dev_server_pid`'i sadece `undefined` yapıyordu → process orphan + port çakışması. Tek doğruluk
    kaynağı `stopActiveDevServer(state)` helper'ı (kill+watcher-detach) eklendi; 3 site + smoke-test'in
    2 kopyası ona indirgendi. +3 test (gerçek detached child spawn → kill doğrulanır).
  - **(3) Gate-fail dürüstlük (Ümit'in #1 endişesi "sessizce TAMAMLANDI deme"):** mekanik gate'ler SOFT
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
- **feat(security) [tamamlık-2]:** Kalan dedicated güvenlik kontrolleri (Ümit: "herşey tam olsun,
  güvenlik ciddi"). (1) `assets/security-rules/web-security.yml` (semgrep, validate+fixture'lı):
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
  sanitizer** (Ümit talebi). (1) `orchestrator/headers-check.mjs`: STATİK güvenlik-HTTP-başlık kontrolü
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
  (Ümit kararı: orchestrator Playwright dep):** `playwright` eklendi AMA `.npmrc`
  `playwright_skip_browser_download=1` → CI'da chromium İNMEZ (gerçek-zorlayıcı CI hafif/yeşil
  kalır); chromium RUNTIME'da lazy kurulur (`npx playwright install chromium`). Fail-closed:
  user-guide.md yoksa / UI'sız projede / chromium kurulamazsa → GÖRÜNÜR skip (asla throw).
  Dev-server kapalıysa metin-only PDF (ss'siz) — yine üretilir. Pipeline-end non-blocking hook.
  Test: 9 (saf). `npm run check` yeşil. **8-iş programının TÜM işleri bitti** (+ doğru-karar
  sistemi). Kalan: ertelenen güvenlik kontrolleri + F4 in-app link (minör). Detay: hafıza
  `project_f4_pdf_plan`.
- **feat(module-stock) [program 5/8]:** Yeniden-kullanılabilir feature modülleri
  (~/.mycl/modules/<token>/). **Kritik pivot (4-ajan workflow + adversaryal review):** Ümit'in
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
  — riski sessizce tahmin etmek yerine kullanıcıya SOMUT seçeneklerle sorar (Ümit: "risk gördüğü
  kısımlarda bana sorsun"; yalnız sürekli orkestratör-içi, sabit faz-kapısı yok). (1) `ask_clarify`
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
  **Küratörleme = doğrulanmış koşudan oto-anlık-görüntü** (Ümit kararı): pipeline YEŞİL
  (gate-fail yok) + stack biliniyorsa pipeline-end'de baseline dosyaları (conservative
  allowlist: config + giriş-iskeleti + public/; **feature kodu HARİÇ** → yeni projeleri
  kirletmez) golden prototip olarak kaydedilir + `<stack>.meta.json` (createdAt + node sürümü).
  **Uygula:** Faz 5 başında greenfield (isExistingProject=false) + stack biliniyor + cache
  varsa, codegen BAŞLAMADAN baseline projeye kopyalanır (mevcut dosya EZİLMEZ) → ana ajan
  sıfırdan değil doğrulanmış baseline üzerine geliştirir. **Bayatlama (Ümit'in işaret ettiği
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
  "TAMAMLANDI deme" (Ümit kararı; MEDIUM dahil bloklar). Güvenlik gate fail olunca
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
  MEDIUM/HIGH_MAYBE — Ümit kararı "MEDIUM da bloklasın"); STRICT_CSP(45)/INFO(60) öneri/uyarı
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
- **20:46 feat(auto-mode-symmetric):** Auto Mode artık SİMETRİK çift-yön, 3 rol de (Ümit:
  "Tam simetrik çift-yön"). Çözülen birincil backend (limit yokken CLI, limitliyse API)
  denenir; KALICI `failed`/throw → görünür mesajla diğerine BİR KEZ geçilir (case 1:
  API→CLI + case 2: CLI→API). Geçici hatalar (overloaded/5xx) zaten backend içinde retry'lı.
  `autoFallbackBackend` yön-bağımsız (makePrimary/makeSecondary + etiket); yeni
  `autoBackendPair(effective, makeCli, makeApi)` yönü seçer. Uygulandı: main (qa-askq 1/2/9,
  production-schema 3/4/7, codegen 5/8 — wantCli'den ÖNCE auto branch), orchestrator
  (throw-based, iki yön), translator (`attempt(useCli)` helper'a refactor + primary/secondary).
  Explicit "api"/"cli" STRICT kalır (sessiz fallback yok). phase-0 D1 (triage girişi)
  bespoke — limit penceresinde SDK'ya çözülür, ortada dolarsa yeniden tetikte. 24 birim test
  (her iki yön + abort→geçiş yok + tek-geçiş + askq routing + yön seçimi). check yeşil (722).
- **20:13 feat(auto-mode-seamless):** Auto Mode'a FAZ-İÇİ kesintisiz retry (Ümit onayı:
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
  interactive-backend wrapper, Ümit kararına bırakıldı — ayrı iş).
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
  resolveClaudePath/claudeSpawnEnv POSIX-only → Windows'ta CLI ENOENT (Ümit'e soruldu).
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
