# MyCL Studio — Değişiklik Günlüğü

> AI (Claude) tarafından yapılan işlerin zaman damgalı kaydı. Yeni → eski.
> Amaç: eski kararları/kuralları unutup bozmamak; bir işi değiştirmeden önce buraya bak.
> Eski bir işi değiştirmek/silmek gerekiyorsa ÖNCE Ümit'e sor (kural, 2026-06-03).

## 2026-06-04

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
