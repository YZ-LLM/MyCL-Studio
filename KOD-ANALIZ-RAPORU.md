Veri çok büyük ve sonu kesilmiş (truncated). Mevcut maps + confirmedCritHigh + mediumLow JSON'unu sentezleyeceğim. Önce eldeki verinin tamamını anlamak için raporu yazıyorum — JSON kesik olsa da maps (15 alt-sistem), confirmedCritHigh ve mediumLow bulgularının büyük çoğunluğu elimde.

Raporu doğrudan döndürüyorum.

# MyCL Studio — Kod Tabanı Analiz Raporu (2026-06-07)

## 1. Yönetici Özeti — Kontrol Durumu

Ekibin "kontrolü kaybediyoruz" hissi **gerçek bir yapısal kaynağa** dayanıyor: kod tabanı kural-bilinçli yazılmış (spawn-env tek-nokta, fail-closed sandbox, sessiz-fallback çoğunlukla görünür hata ile değiştirilmiş), ancak son turlarda çıkan regresyonlar (SDK 0.102 timeout, claude-updater baypası) **münferit değil, tekrarlayan sınıfların** birer örneği. Asıl risk tekil bug'lardan çok şu üç sistemik desende: (1) **IPC dispatch hiç seri-leştirilmiyor** — eşzamanlı mesaj/faz-tetik shared state'i bozabilir; (2) **fix bir yerde uygulanıp eşine taşınmıyor** (timeout sertleştirmesi `models.ts`'te yapılıp `runTurn`/`translator`/`conversation-context`'e uygulanmamış; resume `iteration_started_at` önceliğine geçirilmiş ama Faz 8 gate ve Faz 1 resume hâlâ kırılgan audit-tail'e güveniyor); (3) **`try/finally` eksikliği** controller throw ederse runtime'ı kalıcı kilitliyor. Pozitif tarafta: kuralların (e) spawn-env, (b) regex-routing yasağı, (f) test-framework içerik tespiti, (d) çapraz-platform fail-closed büyük ölçüde **sağlanıyor**.

**En kritik 5 sorun:**

1. **IPC dispatch seri-leştirmesi yok (race condition)** — `app.ts` her stdin satırını bağımsız async görev başlatıyor; mutex/kuyruk yok. Eşzamanlı `user_message` + faz-tetik aynı `runtime.state`/`runtime.controller`'ı yazar. Faz regresyonu hissinin yapısal kaynağı bu olabilir.
2. **`advanceToNextPhase` controller throw'da kalıcı kilitlenir** — `try/finally` yok; faz controller'ı (örn. SDK timeout) throw ederse `runtime.controller = null` atlanır, sistem "faz zaten çalışıyor" deyip her şeyi reddeder. `runPhaseOnce` doğru deseni zaten içeriyor.
3. **API client timeout/maxRetries seti `runTurn`/`translator`/`conversation-context`'te yok** — SDK 0.102 regresyonu yalnız `models.ts`'te yamandı; ana turn döngüsü hâlâ aynı pencereye açık + SDK timeout'u "non-transient" sayılıp faz sert fail ediyor.
4. **harness-verdict false-green deliği** — `security-headers`/`data-sanitization`/`web-security` skip event'leri `isSecuritySkip`'le eşleşmiyor; güvenlik fazı atlanmasına rağmen PASS verilebilir. Modülün önlemeyi amaçladığı şeyin tam karşıtı.
5. **`persistApiKeys`/`persistSelectedModels` tam-üzerine-yazma** — `relevance` ve `subagent_models` UI payload'unda yok; Settings kaydı bu alanları sessizce siler → per-rol key/model main'e düşer (sessiz fallback).

---

## 2. Mimari Haritası

**Genel mimari (ADR-001, 2-katmanlı):** Tauri 2 (Rust) shell ↔ stdin/stdout NDJSON ↔ Node/TS orkestratör ↔ (Anthropic SDK / `claude -p` abonelik) ↔ Claude. Rust shell domain mantığı taşımaz; yalnız pencere/subprocess yaşam döngüsü + OS köprüsü.

- **Tauri shell (Rust):** `lib.rs` multi-window + single-instance; `orchestrator.rs` node subprocess (absolute path spawn, stdout→Tauri event); `sys_path.rs` platform-aware executable çözümü (fail-closed); `updater.rs` in-app güncelleme. **Kritik not:** Rust hiçbir yerde `claude` spawn etmez (yalnız node/npm/bash) — TCC izin penceresi kaynağı `claudeSpawnEnv()` tamamen Node katmanında; bu katmanda kural (e) ihlali yok.

- **Çekirdek olay döngüsü + IPC (Node):** `app.ts` composition root + stdin readline loop; `ipc-router.ts` kind→handler map; `index.ts` (3854 satır) `handleUserMessage`→`respondAsOrchestrator`→`executeAgentDecision`, `advanceToNextPhase` ardışık N→N+1 faz döngüsü, `handleAskqAnswer` (8+ pending dalı). `ipc.ts` NDJSON emit + askq LIFO stack (cap 8).

- **Orkestratör ajanı + niyet:** Tek LLM ajan her serbest-metin mesajı yorumlar (`decide_action`, 14 action). İki backend: SDK (forced-tool) + CLI (text-JSON). Klasik Haiku classifier kaldırılmış; regex fast-path yasağı (kural b) korunuyor.

- **Faz çekirdeği:** `phase-registry.ts` (PHASE_SPECS + transitions + güvenlik extra_scan komutları); `base/codegen-controller.ts` (SDK turn-loop), `base/mechanical-runner.ts` (LLM'siz lokal komut, Faz 10-17), `base/qa-askq-*` + `base/production-schema-*` (SDK custom-tool ↔ CLI text-JSON paritesi).

- **Fazlar 0-9:** 0 (debug triyaj D1/D2), 1 (niyet), 2 (hassasiyet + proje tipi sınıflandırma), 3 (brief), 4 (spec), 5 (UI build + tasarım fan-out), 6 (UI review, deferred), 7 (DB tasarım), 8 (TDD), 9 (risk review). Hepsi TR↔EN çeviri + relevance enjeksiyonu + api↔cli ikili-backend deseni paylaşır.

- **Backend katmanları:** `claude-api.ts` (SDK stream + retry), `cli-backend.ts`/`cli-run.ts`/`cli-session.ts` (claude `-p` spawn, `claudeSpawnEnv`), `cli-rate-limit.ts` (abonelik usage-limit), `config.ts` `backendForRole()` tek-otorite routing.

- **Relevance/recall + ajan-hafıza:** `relevance-engine.ts` (chunk topla → keyword pre-filter → LLM skorla → süz), 3 JSONL hafıza deposu (proje/genel/karar), cross-project leak filtresi.

- **Sandbox + runtime:** `agent-sandbox.ts` (Seatbelt/bwrap fail-closed), `dev-server-launcher.ts` (detached spawn + port-probe), `runtime-http-server.ts` (browser-error toplayıcı), `dast-runner.ts` (nuclei), `playwright-setup.ts` (içerik-bazlı framework tespiti).

- **Frontend (React):** `types/events.ts` tek doğruluk IPC sözleşmesi (22 event + 22 komut union), `useOrchestrator` Tauri köprüsü, `App.tsx` reducer, `Settings.tsx` model/key/backend seçimi.

**İki spawn ailesi net ayrılmış:** (1) `claude` alt-süreçleri → `claudeSpawnEnv()` (4 nokta, hepsi uyumlu); (2) kullanıcı projesi komutları → `safeEnv()`.

---

## 3. Bulgular

### KRİTİK / YÜKSEK

#### Eşzamanlılık & yaşam-döngüsü (kontrol kaybının çekirdeği)

**IPC dispatch hiç seri-leştirilmiyor (race condition)** `orchestrator/src/app.ts:111-132`, `ipc-router.ts:36-43`, `index.ts:1022/1687` — `rl.on("line", async ...)` her satır için bağımsız async görev başlatır, await'i beklemez; `IpcRouter.dispatch` tek `await handler`, kuyruk/mutex yok. Kullanıcı faz koşarken ikinci mesaj yazarsa iki `executeAgentDecision`/`runPhaseOnce` eşzamanlı çalışıp aynı `runtime.state`/`runtime.controller`'ı okuyup yazar. **Öneri:** `App.start`'ta promise-chain kuyruğu (`this.queue = this.queue.then(()=>dispatch(parsed))`) veya en azından `handleUserMessage`+`advanceToNextPhase` girişine "busy" bayrağı + görünür "işlem sürüyor" mesajı (sessiz reddetme değil).

**`advanceToNextPhase` controller throw'da kalıcı kilitlenir (try/finally yok)** `orchestrator/src/index.ts:1857-1859, 1934-1936, 1979-1981, 2138-2140, 2157-2159, 2178-2180; ayrıca 1617-1619, 676-678` — Her LLM faz controller'ı `runtime.controller = pX; const r = await pX.run(); runtime.controller = null;` deseni kullanıyor, `try/finally` yok. `pX.run()` throw ederse (SDK timeout, ağ kopması) null ataması atlanır; boot-resume `void advance(...).catch(log)` olduğundan sonrası hep "faz zaten çalışıyor" reddeder. `runPhaseOnce` (3347+) doğru `try/finally` desenini zaten içeriyor — fix paterni kod tabanında mevcut. **Öneri:** Tüm `await pX.run()` ikililerini `try/finally`'ye sar; tek `runController(pX, fn)` helper'ında topla.

**Faz 5 `runtime.controller`'ı hiç set etmiyor — abort çalışmaz + re-entrancy deliği** `orchestrator/src/index.ts` — `advanceToNextPhase` Faz 5 bloğu diğer fazların aksine `runtime.controller = p5` atamıyor. Sonuç: uzun süren UI codegen iptal edilemez (`abort_phase` "aktif faz yok" der); re-entrancy guard'ı bypass olur. `runPhaseOnce` case 5 (3393) doğru atıyor. **Öneri:** Faz 5'i diğer fazlarla aynı `try/finally` desenine getir.

**Çıkışta dev-server + runtime HTTP server temizlenmiyor (orphan zombie)** `orchestrator/src/app.ts:134-145`, `index.ts:3791` — SIGTERM/SIGINT/`rl.close`/shutdown doğrudan `process.exit(0)`; `stopActiveDevServer`/`stopRuntimeHttpServer`/`detachActiveWatcher` çağrılmaz. Dev-server `detached:true`+`unref` olduğundan OS otomatik öldürmez → her kapanış 5173 portunu + 9273-9299 listener'ını arkada bırakır → sonraki oturumda port çakışması. **Öneri:** Tek `gracefulShutdown()` ekle, tüm exit yolları onu çağırsın.

**Faz-içi askq promise'lerinin timeout'u yok — faz sonsuza dek asılır** `orchestrator/src/base/codegen-controller.ts:451-454`, `production-schema-cli-backend.ts:277-284` — `await new Promise(...)` resolver/rejecter'ı timeout'suz; kullanıcı cevaplamazsa veya (race ile) cevap eski resolver'a ulaşamazsa promise askıda kalır, dev-server/CLI child'ını tutar. **Öneri:** Idle-timeout + görünür "cevap bekleniyor" uyarısı; cevabı `currentAskqId` ile sıkı doğrula. Bulgu#1 (seri-leştirme) bunu büyük ölçüde kapatır.

#### Backend timeout / regresyon sınıfı

**`runTurn` SDK client'ında explicit timeout/maxRetries yok + SDK timeout'u non-transient sayılıyor** `orchestrator/src/claude-api.ts:278-283, 68-87` — `models.ts:61` SDK 0.102 regresyonunu `timeout:20s, maxRetries:3` ile yamadı; ama codegen/orchestrator/relevance/project-type'ın hepsinin geçtiği `runTurn` client'ı default'a (10dk) düşüyor. Dahası `isTransientError` SDK'nın kendi `APIConnectionTimeoutError`/`APIConnectionError`'ını listelemiyor → uzun Opus/ultracode turu SDK timeout'una takılırsa attempt 1'de NON-transient sınıflanıp faz sert fail eder. `list_models`'ı vuran regresyonun ana turn döngüsünde yamasız hali. **Öneri:** `runTurn` client'ına bilinçli timeout (uzun turlar için ≥600s) ekle; `isTransientError`'a `/timed out|Request timed out|APIConnection/` desenini ekle. Çift-retry'ı netleştir (dış loop varsa SDK `maxRetries:0`).

**`conversation-context` SDK özet çağrısında timeout yok** `orchestrator/src/conversation-context.ts` — `generateSummary` `new Anthropic({apiKey})` (timeout/maxRetries yok). `handleUserMessage`/boot yolunda çağrıldığında hang süresince orkestratör yanıtı gecikir → "kontrolü kaybediyoruz" algısını besler. **Öneri:** `models.ts` ile aynı timeout/maxRetries; tüm process-içi SDK client kurulumu için ortak factory.

#### api↔cli parite ihlalleri (kural c)

**Faz 0 D1: SDK yolu Edit/Write'a izin veriyor, CLI yolu yasaklıyor** `orchestrator/src/phase-0.ts:394-397 vs 684-685` — D1 sözleşmesi salt-araştırma (yorum 360-361); CLI yolu `disallowedTools=[Write,Edit,...]` zorluyor ama SDK yolu `spec.allowed_tools` (Write/Edit dahil) + `report_root_cause` veriyor, `denied_paths=null`. API kullanıcısında teşhis turunda ajan dosya yazabilir/düzenleyebilir. Hem parite hem faz-sınır disiplini ihlali. **Öneri:** SDK D1'i CLI ile simetrik `[Read,Grep,Glob,Bash,report_root_cause]` ile sınırla.

**`betas` (1M context) SDK'da geçilip CLI backend'lerinde sessizce düşürülüyor** `orchestrator/src/base/qa-askq-cli-backend.ts`, `production-schema-cli-backend.ts`, `codegen/cli-backend.ts` — Faz 3/4/5/7/8 `betas`'ı geçiyor; SDK iletiyor, 3 CLI backend hiç kullanmıyor. CLI/Auto modunda büyük spec'lerde SDK 1M, CLI standart pencere → aynı faz farklı kapasitede, kullanıcıya uyarı yok. **Öneri:** CLI'da `betas` doluyken bir kez görünür uyarı (sessiz düşürme yerine).

**`detectRecurringTopic` abonelik modunda `scoreChunks` (API) çağırır, CLI eşine geçmez** `orchestrator/src/agent-memory/dedup.ts:125-131` — Şu an dead-code (erken return), ama re-enable edilince saf-abonelik kullanıcısında API key yok → 401 → catch yutar → dedup sessizce hiç çalışmaz. Hem parite (c) hem sessiz-fallback (a) ihlali. **Öneri:** `getRelevantChunks` gibi `isSubscriptionMode` dallanması ekle; re-enable etmeden gider.

#### Resume / gate doğruluğu

**Faz 8 gate iteration-N-start'ı tail-window'da kaçırırsa eski iterasyon green'lerini sayar (yanlış-pass)** `orchestrator/src/phase-8.ts:402-418` — Gate `readAuditLogTail(1500)` ile `iteration-${iterCount}-start` arar; bulamazsa `iterStartTs = 0` → tüm phase-8 green'leri sayılır → gate yanlış geçer. Bu, `resume-detection.ts:13-17`'nin uyardığı tuzak; resume bu yüzden `state.iteration_started_at`'ı birincil yaptı ama Faz 8 gate aynı fix'i almadı. 30-50 AC'li uzun iterasyonda marker pencere dışına çıkabilir. **Öneri:** `iterStartTs = iterCount>1 ? (state.iteration_started_at ?? audit.find(...)?.ts ?? 0) : 0`.

**`phase-09-complete` event adı resume-detection ile uyumsuz** `orchestrator/src/phase-9.ts:204` — Faz 9 zero-padded `phase-09-complete` yazıyor; tüm diğer fazlar padding'siz. `resume-detection.ts:37` `phase-9-complete` kurar → asla eşleşmez → Faz 9 boot-resume'da gereksiz baştan koşar, kullanıcı risk sorularını tekrar görür. **Öneri:** `phase-9-complete` (padding'siz) + `phase-registry.ts:239` `required_audits`'i de güncelle.

**`detectInterruptedPhase1` audit-tail'e bağlı (300 satır)** `orchestrator/src/index.ts` — Faz 2-9 `iteration_started_at` öncelikli yapıldı ama Faz 1 hâlâ sadece audit-tail; uzun Faz 1'de mid-resume sessizce atlanabilir. Faz 1 event hacmi düşük olduğundan düşük olasılık. **Öneri:** Faz 1'i de `iteration_started_at`-öncelikli yap.

#### Frontend / config kalıcılık

**`list_models` başarısız olunca dropdown kalıcı "yükleniyor" takılır + sessiz log.warn (kural a ihlali)** `src/components/Settings.tsx:267-278`, `src/App.tsx:768-773`, `orchestrator/src/index.ts:917-934` — Loading bayrağını temizleyen tek yol `models_list` event'i; backend apiKey-yok ve catch durumunda yalnız `log.warn` + return, event emit etmez. Abonelik (CLI) modunda apiKey yokken rutin tetiklenir → dropdown + ↻ butonu sonsuza dek disabled. **Öneri:** Backend başarısız yollarda da terminal sinyal (boş `models_list` veya görünür durumlu event); frontend'de timeout + görünür hata metni.

**`persistApiKeys` tam-üzerine-yazma → relevance API key sessizce silinir** `orchestrator/src/config.ts:465-469, 285-311` — `JSON.stringify({api_keys: keys})` ile dosyayı tamamen ezer (merge etmez). UI payload `relevance` taşımıyor (`App.tsx:724-729`); input'lar mevcut secrets'tan populate edilmiyor. Settings kaydında relevance/orchestrator key kalıcı kaybolur → `relevanceApiKey()` sessizce main'e düşer (yanlış tier/kota). **Öneri:** `persistSelectedModels` gibi merge yap (`loadSecrets()` → spread); UI'a relevance alanı ekle.

**`persistSelectedModels` tam-replace → `selected_models.relevance` ve `subagent_models` sessizce düşer** `orchestrator/src/config.ts` — `selected_models`'ı gelen `sel` ile tamamen değiştiriyor; UI payload relevance/subagent_models göndermiyor → manuel yazılan per-rol modeller silinir, main'e fallback eder. **Öneri:** `selected_models`'ı field-bazlı merge et; UI'ın bu alanları round-trip ettiğini doğrula.

#### Güvenlik / verdict

**harness-verdict false-green deliği: `security-headers`/`data-sanitization`/`web-security` skip'leri sayılmıyor** `orchestrator/src/harness-verdict.ts:42-50` — `isSecuritySkip` yalnız `phase-13-skipped`/`csp-evaluator*`/`secret-scan*`/`semgrep*` prefixlerini sayar; `phase-registry.ts:354-378`'deki gerçek tarayıcılar `security-headers`/`data-sanitization`/`web-security` adlarıyla `-skipped` yazar → eşleşmez. Custom YAML kuralları semgrep exit-2 ile çökerse güvenlik fazı atlanmasına rağmen PASS verilir. Ayrıca `secret-scan` prefix'i hiçbir event'le eşleşmiyor (gerçek ad `semgrep-secrets`) — ölü dal. **Öneri:** `isSecuritySkip`'i isim-prefix yerine "Faz 13 + missing/tool_error nedeniyle -skipped" mantığına bağla veya `phase-registry`'deki tüm güvenlik extra_scan adlarından türetilen tek-kaynak set kullan.

**`verify-feature` handler exception'ında dev-server PID kaybolur (orphan)** `orchestrator/src/verify-feature.ts:268-282, 307-322` — `dev.statePatch` yalnız normal return'de persist edilir; server başlatıldıktan sonraki herhangi bir adım (snapshot/codegen/translate) throw ederse PID state'e hiç yazılmaz → orphan. MEMORY `smoke_bash_side_effects` ile birebir aynı sınıf. **Öneri:** Handler'ı `try/finally` ile sar; server alive olur olmaz PID'i hemen persist et veya exception'da kapat.

#### CLI argv / spawn-env disiplini

**`--allowedTools`/`--disallowedTools` üç farklı argv konvansiyonu (biri yanlış)** `orchestrator/src/cli-run.ts:80, 83` (+ `cli-session.ts:93,96`, `codegen/cli-backend.ts:379,381`) — `cli-run` allowedTools'u `join(" ")` STRING, disallowedTools'u SPREAD veriyor (kendi içinde tutarsız); `cli-session` ikisini de spread; `codegen/cli-backend` ikisini de join. `design-fanout.ts:83` `Bash(rm *)` gibi boşluklu değerler spread/join farkıyla bozulabilir → en az bir spawn yolu tool-kısıtlamasını yanlış uygular (sandbox zayıflar veya gerekli araç bloklanır). **Öneri:** Tek konvansiyonu `claude --help`/canlı doğrulamayla belirle, tüm spawn yollarını ortak args-builder'a çıkar; boşluklu kalıpları canlı doğrula.

**orchestrator-agent Bash/Grep tool'u `process.env`'i filtrelemeden miras alıyor (safe-env baypası)** `orchestrator/src/orchestrator-agent/agent.ts:249, 262` — `execAsync` çağrılarına `env: safeEnv()` verilmemiş → child tüm `process.env`'i (ANTHROPIC_API_KEY, AWS_*, GH_TOKEN) miras alır. Projedeki diğer 7 spawn `{...safeEnv(), LC_ALL:'C'}` uyguluyor. Şu an `validateBashCommand` allowlist'iyle kısmen maskeli ama bu tek savunma; allowlist gediği doğrudan secret ifşasına döner. **Öneri:** Her iki `execAsync`'e `env: {...safeEnv(), LC_ALL:'C'}` ekle (defense-in-depth).

#### Faz skip önceliklendirme

**Faz 7 skip kapısı: brittle regex pozitif LLM sinyalini geçersiz kılıyor** `orchestrator/src/index.ts:2106-2136` (+ `shouldRunMechanical 1650-1674`) — Yorum "structured `has_database` öncelikli" diyor ama kod `if (structuredSkip || !hasDbHeuristic)` (OR). LLM "veritabanı VAR" (`has_database===true`) dese bile spec.md regex'e (`database|veritabanı|db|prisma|sql|postgres|mysql|sqlite`) takılmazsa (Mongo/Redis/NoSQL/"kayıt saklama") Faz 7 atlanır → DB şeması hiç üretilmez (sessiz kapsam kaybı). Aynı OR deseni Faz 5/6'da da var. **Öneri:** `has_database===true → KOŞ`, `===false → SKIP`, yalnız `undefined`'da heuristic; regex'e mongo/redis/nosql/orm/persist ekle.

#### Dead-code / dispatch riski

**`noteCliRateLimitError` hiç çağrılmıyor — result-event usage-limit Auto Mode'a sinyal vermiyor** `orchestrator/src/cli-rate-limit.ts:128-132` — Export edilmiş ama tek referansı kendi tanımı. `cli-run`/`cli-session`/`cli-backend` result `is_error`'da rate-limit imzasını incelemiyor → abonelik limiti `result is_error` olarak yüzeye çıkarsa `_limitedUntilMs` set edilmez → Auto Mode her fazda CLI'yi yine dener, her seferinde API'ye düşer. **Öneri:** Result `is_error` dalında stderr'i rate-limit imzası için kontrol edip `noteCliRateLimitError` çağır; yoksa fonksiyonu kaldır.

**`run_phase` case'i `executeAgentDecision` switch'inde iki kez (ikincisi ölü kod + yanıltıcı yorum)** `orchestrator/src/index.ts:1145 ve 1182` — JS switch ilk eşleşeni çalıştırır; 1182 bloğu (`pendingAgentDecision` onayı) asla çalışmaz; yorum tersini iddia ediyor. tsc duplicate-case'i hata saymaz, `check.sh`'te ESLint yok → sessizce geçer. **Öneri:** 1182'den `run_phase` etiketini kaldır; `check.sh`'e ESLint (`no-duplicate-case` + `no-fallthrough`) ekle.

---

### ORTA / DÜŞÜK

#### Backend / parite tutarsızlıkları

- **`conversation-context` özet routing `isSubscriptionMode` (3-rol) kullanıyor ama çeviri `backendForRole('translator')`** `orchestrator/src/conversation-context.ts` — Karışık config'te (translator:cli, main:api) özet sessizce API'ye sapar; aynı translator modeli bir çağrıda CLI bir çağrıda API. **Öneri:** Özeti de `backendForRole('translator')==='cli'` ile yönlendir.
- **`project-type-classifier` `isSubscriptionMode` ile route + yanlış rolden (main) API key alıyor** `orchestrator/src/project-type-classifier.ts:184, 188-189` — Karışık config'te API'ye sapar + `api_keys.main` (translator değil) kullanır → fail-soft "unknown" → Faz 5/6/7 skip + Faz 16/17 runner kararı sessizce bozulur. **Öneri:** `backendForRole('translator')==='cli'` + `api_keys.translator`.
- **`production-schema` SDK tek-turn plain-text'te anında fail; qa-askq ve CLI retry/nudge yapıyor** `orchestrator/src/base/production-schema-controller.ts` — Faz 3/4/7 + main=API + zayıf model bir kez tool'suz metin dönerse pipeline hard fail; CLI/qa modunda toparlanır. **Öneri:** qa-askq'daki 1-retry + `tool_choice:any` kurtarmasını paylaşımlı helper'a çıkar.
- **CLI backend 2-nudge sonrası ajan metnini artifact olarak sentez edip diske yazıyor** `production-schema-cli-backend.ts:169`, `qa-askq-cli-backend.ts:218-223` — `coerceToSchema` ile serbest metni spec.md/brief'e render + audit; görünür uyarı var ama yapılandırılmamış içerik onay akışına girebilir (quality-first / half-finished work kuralları). **Öneri:** Sentez yolunda kullanıcı onayını zorunlu kıl veya "failed" yapıp tekrar dene.
- **codegen-controller `maxTurns` aşımında "done" döndürüyor** `orchestrator/src/base/codegen-controller.ts` — Kesilen ajan başarılı sanılır + `clearHistory` ile resume zinciri kopar. Şu an Faz 0 gate audit'e baktığından maskeli. **Öneri:** Ayrı `{kind:'budget_exhausted'}` döndür; maxTurns yolunda history silme.
- **`betas` default `context-1m` tüm fazlara körü körüne gönderiliyor** `orchestrator/src/config.ts` — 1M desteklemeyen model seçilirse her tur `invalid_request` riski; bulgu#6 yüzünden humanize edilmeden. **Öneri:** beta'yı modele göre koşullu uygula veya beta-kaynaklı hatayı humanize et.
- **`detectRecurringTopic` re-enable'da regex pre-filter rule (b) gözden geçirilmeli** `orchestrator/src/agent-memory/dedup.ts:94+` — Erken return sonrası ~60 satır ölü kod; `isMetaOrStatusQuestion` regex orkestratör prompt'unu şekillendiriyor. **Öneri:** Re-enable planı yoksa sil; varsa parite + rule (b) uyumu + debug-triage eleme deseni değerlendir.

#### Mechanical / regex sadeleştirme (kural g)

- **`isMissingCommand` çok-satırlı npm regex hiç eşleşmiyor (ve gereksiz)** `orchestrator/src/base/mechanical-runner.ts:140` — Bir üstteki `/Missing script:/` zaten kapsıyor; dotAll'sız regex çok-satır npm çıktısını yakalamıyor. **Öneri:** L140'ı sil; substring kontrollerini `.includes()` ile sadeleştir.
- **Mechanical runner abort'u `skipped`(aborted) yapıyor → güvenlik fazı false-green'e dönüşebilir** `orchestrator/src/base/mechanical-runner.ts:189-191` — Faz 13 abort edilirse "skipped" raporlanır, skip'i pass sayan akışta güvenlik geçilmiş görünür. **Öneri:** Ayrı `{kind:'aborted'}` veya `phase-N-aborted` audit.
- **Faz 5/8 codegen CLI backend AskUserQuestion eskalasyonunu yüzeye çıkaramıyor** `orchestrator/src/codegen/cli-backend.ts` — `submitAskqAnswer` yok; ajan non-interactive kendi varsayımıyla devam eder (bilinçli asimetri, `phase-registry.ts:162-163` belgeliyor). **Öneri:** En azından CLI'da eskalasyon denemesinde görünür not.

#### Erken fazlar

- **Faz 2 tool açıklamaları "7 dimension" diyor ama prompt + askq_config 8 boyut (COMPLIANCE eksik)** `orchestrator/src/phase-2.ts:35, 80, 98` — Model 7'de durabilir veya COMPLIANCE'ı atlayabilir → uyum/abandon geçişi zayıflar. **Öneri:** Üç açıklamayı 8'e + enum'a COMPLIANCE ekle.
- **Probe spec'i `--quiet` ile koşuyor — parse edilen console.log bastırılabilir** `orchestrator/src/phase-0-ui-probe.ts:177` — `--quiet` test stdout'unu (PROBE-RESULTS bloğu) bastırır → fallback reporter özeti, gerçek DOM kanıtı kaybolur. **Öneri:** `--quiet`'i kaldır veya çıktıyı dosyaya yaz.
- **Kodbase snapshot `app/` dizinini frontend sayıyor** `orchestrator/src/phase-1-codebase-probe.ts:56` — Next app-router/Rails/Python `app/` yanlış sınıflanır → yanlış route hint. **Öneri:** `app`'i çıkar veya içerikten (react/vue dependency) tespit et (kural f ruhu).
- **Faz 0 CLI yolunda "force retry da başarısız" yanıltıcı mesaj** `orchestrator/src/phase-0.ts:508-511` — CLI'da force-retry yok; mesaj yanlış. **Öneri:** `wantCli`'ye göre dallandır.

#### Geç fazlar

- **Faz 5 tweak modunda `dev_server_pid` yoksa `pending_ui_tweak` temizlenmez (bayat tweak sızar)** `orchestrator/src/phase-5.ts:384-385, 478` — Server ölmüşse temizleme guard'ı atlanır, sonraki Faz 5 girişinde eski tweak yeniden uygulanır. **Öneri:** Başarı yollarındaki `statePatch`'e `pending_ui_tweak: undefined` ekle.
- **Faz 8 tech-debt clean/detected eşleşmesi `:` içeren path'e kırılgan** `orchestrator/src/phase-8.ts:428, 431, 752, 762` — detected `split(':')[0]`, clean tam string → path'te `:` varsa eşleşmez, temizlenmiş borç "detected" kalır. **Öneri:** Ortak path-extraction helper.
- **Faz 9 tech-debt scope geçersiz `fix_checkpoint_ref`'te sessizce HEAD'e düşer** `orchestrator/src/phase-9-tech-debt.ts:89` (`git.ts:391`) — Fix iterasyonunda ref bozuksa kapsam sessizce HEAD; modül "sessiz fallback yok" iddiasıyla çelişir. **Öneri:** Görünür "ref-invalid" notu.
- **Faz 8 fix-mode reused `fix_checkpoint_ref`'in temiz working-tree garantisi yok (rollback veri kaybı)** `orchestrator/src/phase-8.ts:342-346` — D2'den gelen ref kirli tree'den alınmışsa `restoreCheckpoint` fix-dışı commit'lenmemiş değişiklikleri de geri alır. **Öneri:** Reused-ref yolunda temiz-tree invariant'ını doğrula veya rollback'i kapat + uyarı.
- **Faz 8 `acCount=0` olunca `minGreens=1`'e düşer (spec parse fail = zayıf gate)** `orchestrator/src/phase-8.ts:238-240, 459-460` — Katı AC regex spec'i farklı yazılmışsa 0 döner → 30 AC'lik spec'te 1 yeşil yeterli. **Öneri:** "0 AC mı parse-fail mi" ayır; format tespit edilemezse uyarı/belirsiz.
- **Faz 7/9 emitError'larında yanlış faz numarası (renumber kalıntısı)** `orchestrator/src/phase-7.ts:177,182` (`phase-8`), `phase-9.ts:109,114` (`phase-10`) — Tanı yanıltıcı. **Öneri:** `phase-7`/`phase-9` yap.
- **`module-stock`/`living-docs` CLI-only — API modunda parite eksiği (görünür, sessiz değil)** `orchestrator/src/module-stock.ts:240-246`, `living-docs.ts:90,110` — API kullanıcısı bu özelliklerden mahrum; `design-fanout` gibi API yolu eklenebilirdi. **Öneri:** Orta vade API yolu ekle.
- **Faz 8 CLI'da integrity anchor komut yoksa gate ajan self-report'una güvenir** `orchestrator/src/phase-8.ts:599, 91-105, 702-707` — `isTestCommand` sabit regex listede olmayan runner (`npm run test:ci`, `make test`) `lastTestCmd`'yi set etmez → deterministik garanti kaybolur. **Öneri:** Çapa atlanınca görünür uyarı; `isTestCommand`'ı içerik-bazlı genişlet.
- **tech-debt-scanner: `$` içeren credential kaçar + tek-satır kısıtı çok-satır boş catch'i atlar** `orchestrator/src/tech-debt-scanner.ts:62, 71, 92` — En yaygın boş-catch yazımı (`catch(e){\n}`) yakalanmaz. **Öneri:** EMPTY_CATCH_RE'yi `/s` flag + içerik üzerinde çalıştır; `$` hariç tutmayı ayrı env-kontrolle değiştir.

#### Orkestratör askq / routing inceliği

- **`was_pipeline_completed` tail-window'da false-positive** `orchestrator/src/orchestrator-agent/context-builder.ts:130-136` — `iteration-N-start` tail dışına kayarsa `startTs=0` → önceki iterasyonun completion'ı sayılır → ajana "pipeline tamamlandı" der. **Öneri:** `startEvent` yoksa `wasCompleted=false` (güvenli taraf).
- **Grep/Bash tool'unda symlink-escape post-check yok** `orchestrator/src/orchestrator-agent/agent.ts:241-267` (`path-sandbox.ts:159`) — Read `realpathWithinRoot` yapıyor ama Grep/Bash yapmıyor; root içi dışarı-gösteren symlink ile sandbox bypass. **Öneri:** Grep/Bash'e de var-olan path için realpath kontrolü.
- **`answer_askq` her zaman LIFO `getActiveAskq()`'a forward + option doğrulaması yok** `orchestrator/src/index.ts` (`decision.ts:229-237`) — Çoklu-askq'da yanlış askq cevaplanabilir; eşleşmeyen cevap pending'i sessizce silebilir (örn. küçük harf "evet"). Ek risk: ajan onay-bekleyen phase-run/agent_decision askq'sını composer mesajında otomatik onaylayabilir → maliyetli aksiyon istenmeden tetiklenir. **Öneri:** Hedef askq id'sini karara taşı; option'larla doğrula; onay-tipi askq'larda programatik onayı reddet + görünür uyarı.
- **Boot check "clean" sentinel'i `msg.length<5` ile de tetikleniyor** `orchestrator/src/index.ts` — Kısa-ama-geçerli durum mesajı bastırılabilir (ajan kendi çıktısı, rule b ihlali değil). **Öneri:** Uzunluk eşiğini kaldır, explicit `reason==='boot-clean'`.
- **`clarify_options` parser cap'i (6) prompt rehberiyle (2-4) çelişiyor + memory_proposal CLI parite eksiği** `orchestrator/src/orchestrator-agent/decision.ts:283, 371` (`cli-orchestrator.ts:78-79`) — CLI talimatı `affected_*`/`change_description` alanlarını tanıtmıyor. **Öneri:** Cap'i 4'e indir; CLI talimatına opsiyonel alanları ekle.

#### Rate-limit / token muhasebesi

- **`noteRateLimitEvent` stale `_lastResetsAtMs` ile geçmiş "until" → rejected event yutulur** `orchestrator/src/cli-rate-limit.ts:109` — Kardeş `noteCliRateLimitError` guard'a sahip (`_lastResetsAtMs > nowMs`); bu fonksiyonda yok → geçmiş until ile `enterLimited` çağrılır, anında false döner, bloklu CLI'da kalır (sessiz). **Öneri:** Aynı guard'ı uygula; ortak helper.
- **`cli-session` resume turlarında `recordTokenUsage` her turda çağrılıyor — kümülatif usage çift sayılabilir** `orchestrator/src/cli-session.ts:210` — Resume aynı session-id'yi sürdürürse `result.usage` kümülatif gelebilir → maliyet paneli şişer. **Öneri:** claude resume usage semantiğini canlı doğrula; delta al veya son turda tek-sefer kaydet.
- **Çevirmen API harcaması session token sayacına hiç dahil değil** `orchestrator/src/translator.ts` — `callApi` `response.usage`'ı okumuyor; diğer tüm yollar `recordTokenUsage` çağırıyor → UI toplamı translator'ı undercount eder. **Öneri:** `callApi`'de usage oku + kaydet.
- **CLI relevance retry rate-limit/usage-limit'i tekrar deneyerek maliyeti ikiye katlar** `orchestrator/src/relevance/classifier.ts` — Hata sınıfı ayrılmadığından kalıcı limit'te ikinci tam tur (2×120s + 2× tüketim). **Öneri:** Retry'ı hata tipine koşulla; usage-limit'te retry atla.

#### Relevance doğruluğu

- **Tekrarlı `## Heading` chunk id çakışması — aynı id'li chunk'lar skoru ezer** `orchestrator/src/relevance/chunk-store.ts:69-74` — `${source}-${heading}` benzersiz değil; iki "## Notes" section'ı aynı id → `mergeScoresWithChunks` Map ezer, ikisine de yanlış skor → ilgili section recall'dan düşebilir. **Öneri:** id'ye artan index ekle (`${source}-${idx}-${slug(heading)}`).
- **`parseCliScores` kind'siz fallback rastgele `{scores:[...]}` bloğunu yakalayabilir** `orchestrator/src/relevance/classifier.ts` — CoT içindeki örnek/şablon scores yanlış işlenir (RelevanceError atılmaz, sessiz yanlış skor). **Öneri:** Predicate'e `every(s => 'id' in s && 'score' in s)` ekle.
- **`mergeScoresWithChunks` skorlanmayan chunk'a score=0 → model atlarsa sessizce recall'dan düşer** `orchestrator/src/relevance/classifier.ts` (`relevance-engine.ts:185`) — CLI/Haiku uzun batch'te chunk atlayabilir; "hiçbir şeyi unutmuyor" iddiası zayıflar. **Öneri:** Atlanan chunk'ları log.warn + yeniden-skorla veya nötr skor.
- **`readGeneralMemory(undefined stack)` cross-project filtreyi atlar (leak riski)** `orchestrator/src/agent-memory/store.ts` (`context-builder.ts:163`) — `state.stack` undefined ise tüm entry'ler döner; stack-specific genel hafıza alakasız projeye sızar (v15.7 leak-koruma ilkesiyle çelişir). **Öneri:** Stack undefined iken yalnız `universal` entry'ler (fail-closed).
- **`extractGitChunks` 30 commit için sınırsız `Promise.all` git spawn** `orchestrator/src/relevance/chunk-store.ts` — Her relevance query'de 30 eşzamanlı git süreci. **Öneri:** Eşzamanlılık limiti veya tek `git log --numstat`.
- **Stopword listesi yalnız EN; TR niyet pre-filter'da gürültülenir** `orchestrator/src/relevance/relevance-engine.ts` — `buildRelevantOrchestratorContext` ham TR mesajı translate'siz geçirir → ilgili chunk topK dışında kalabilir (sessiz recall kaybı). **Öneri:** Intent'i translate et veya TR stopword ekle.

#### Sandbox / runtime / güvenlik

- **`runtime-http-server` 127.0.0.1 kimliksiz + CORS `*` → sahte runtime-hata/chat enjeksiyonu** `orchestrator/src/runtime-http-server.ts` — Herhangi yerel süreç/web sayfası `POST /__mycl/runtime-error` ile errors.db'ye yazıp markdown'lı chat toast bastırabilir (sanitize yok); orkestratör "gerçek hata" sayıp fix tetikleyebilir. **Öneri:** Plugin'e session token enjekte et + doğrula; chat'e basılanı sanitize et.
- **vite-injector nested config (`apps/web`) için `"..".repeat(n)` bozuk** `orchestrator/src/vite-runtime-injector.ts:113-120` — `'..'.repeat(2)==='....'` (ayraçsız) → require resolve edemez → vite crash veya plugin yüklenmez (runtime-error yakalama tamamen ölü). Tek-seviye tesadüfen çalışır. **Öneri:** `Array(depth).fill('..').join('/')` veya `path.posix.relative`.
- **vite-injector `plugins[]` regex bulunamazsa sessizce atlar (sadece log.warn)** `orchestrator/src/vite-runtime-injector.ts` — Farklı config yazımında (fonksiyon çağrısı/spread) plugin bağlanmaz, kullanıcı çalıştığını sanır (kural a gerginliği). **Öneri:** Faz5 başında görünür system mesajı.
- **`tryDevServerChain` augment edilemeyen wrapper'da target≠gerçek port → false-negative + orphan** `orchestrator/src/dev-server-launcher.ts:372-413` — `augmentPortFlag` null dönerse komut değişmeden spawn; server kendi config portunda dinler ama probe `target`'ı kontrol eder → "başlatılamadı" deyip canlı server öldürülür. **Öneri:** augment null'da target'ı primary'e sabitle veya tüm `cand.ports`'u probe et.
- **DAST `resolveLocalhostTarget` yanlış porta tarama yapabilir** `orchestrator/src/dast-runner.ts` — Sabit fallback portlardan ilk yanıt vereni hedef seçer; MyCL'in sahibi olmadığı bir localhost servise nuclei aktif tarama yapabilir (wrapper pid yanıltıcı). **Öneri:** State'te kaydedilen gerçek dinleme portuna bağla; sahiplik kanıtını DAST'a taşı.
- **`permissions.deny` çift-slash üretiyor (`Read(//Users/...)`)** `orchestrator/src/agent-sandbox.ts:247` — Matcher normalize etmezse defense-in-depth katmanı no-op; `denyRead` ile format tutarsızlığı. **Öneri:** Permission specifier formatını test ile sabitle.
- **agent-acl registry runtime'da enforce edilmiyor** `orchestrator/src/agent-acl.ts` — "Kapı bekçisi" iddiası ama `isToolAllowed` çağrılmıyor; controller tool listesiyle drift olabilir. **Öneri:** Söz verilen cross-check test'i ekle veya tool-dispatch'te gerçek gate olarak bağla.
- **`isProcessAlive(Sync)` wrapper pid'i için "canlı" yanlış-pozitifi** `orchestrator/src/dev-server-launcher.ts:36-38` — Shell wrapper canlı ama alttaki vite ölmüş olabilir → DAST/resume yanılır. **Öneri:** Canlılığı port-probe ile doğrula; pid'i yalnız kill için kullan.
- **`runtime-error-watcher` stdout/stderr interleave + translate await yarışı** `orchestrator/src/runtime-error-watcher.ts:254/270` — `void flushPending()` + `await translate` arası `pendingEntry` ezilebilir → stack satırları yanlış entry'e iliştirilir. **Öneri:** `flushPending`'i sırala veya stdout/stderr için ayrı pendingEntry.
- **`augmentPortFlag` regex'i `-p`/`-S` framework-spesifik komutlarda yanlış-pozitif/negatif** `orchestrator/src/dev-server-launcher.ts` — Idempotency çift-flag veya kaçırma üretebilir. **Öneri:** Sadece bilinen leaf komutun kendi flag'ine bağla.
- **`smoke-test` ikinci 20s probe redundant (worst-case ~40s)** `orchestrator/src/smoke-test.ts:200` — 5xx senaryosunda gereksiz polling. **Öneri:** `tryDevServerChain`'e `okOnly2xx` parametresi geçir; ikinci probe'u kaldır.

#### API backend incelikleri

- **Legacy modellerde effort ayarı sessizce düşüyor; yorum yanıltıcı** `orchestrator/src/claude-api.ts:320-321` — "ultracode DIŞI effort ARTIK API'ye geçer" yalnız Opus 4.7+ için doğru; legacy + `effort:'max'` sessizce yok sayılır (kural a gerginliği). **Öneri:** `output_config.effort`'u legacy'de de gönder (fail-closed) veya yorumu düzelt + görünür log.
- **`stream.on('message')` yanlış semantikle `message_start` emit + hiçbir caller tüketmiyor** `orchestrator/src/claude-api.ts` — Yanlış-isimli ölü event. **Öneri:** Gerçek `streamEvent` dinle veya event'i kaldır.

#### Çekirdek / config doküman drift'i

- **`splitSentences` marker geri-koyma regex'i kullanıcı metnindeki ` CB<d> `/` IC<d> ` ile çakışıp `undefined` enjekte edebilir** `orchestrator/src/ipc.ts` — Korumasız sentinel. **Öneri:** Görünmez karakter sentinel veya `?? _` fallback.
- **`RECENT_LIMIT=5` ama yorumlar "son 3" diyor** `orchestrator/src/conversation-context.ts:9,33,39` — Doküman drift. **Öneri:** Yorumları `RECENT_LIMIT (5)` ile güncelle.
- **`claude-updater` timeout/error sessizce yutuluyor (gri alan)** `orchestrator/src/claude-updater.ts:79,85,96` — Fail-soft gerekçe meşru ama "update başarısız" tamamen sessiz (rule a sınırda). **Öneri:** Tekrarlayan başarısızlıkta bir kez görünür ipucu veya CHANGELOG'da fail-soft istisnasını belgele.
- **`interpretUpdateOutput` substring tespiti dile/sürüme kırılgan** `orchestrator/src/claude-updater.ts` — Lokalize/yeni format çıktıda gerçek güncelleme "current" raporlanır. **Öneri:** `claude --version` öncesi/sonrası karşılaştır.
- **`isProcessAliveSync` Windows'ta sessizce false** `orchestrator/src/process-utils.ts` — Kapsam-dışı; pessimistic false fail-closed. **Öneri:** Bırakılabilir; JSDoc uyarısını call-site'larda enforce et.
- **`restoreCheckpoint` checkout `.` + exclude + clean kombinasyonu eksik geri-alma riski** `orchestrator/src/git.ts` — `clean -fd` (`-x` yok) fix'in `.gitignore`'ladığı yeni untracked dizinleri temizlemez → kısmi rollback. **Öneri:** `git reset --hard` + selektif restore veya kısmi başarısızlığı görünür kıl.

---

## 4. Kontrolü Geri Alma — Öncelikli Aksiyon Planı

Sıra: önce regresyon/baypas/yanlış-pass sınıfı (kontrolü doğrudan etkileyen), sonra parite/sessiz-fallback, sonra doğruluk.

1. **Eşzamanlılık + yaşam-döngüsü kilidi (kontrolün temeli).** Bulgu#1 (dispatch seri-leştirme), Bulgu#2 (`advanceToNextPhase` try/finally), Faz 5 controller atama, `gracefulShutdown`, askq timeout. Bunlar birlikte "faz regresyonu / kilitlenme / orphan" hissinin yapısal kaynağını kapatır. Tek `runController(pX, fn)` + tek dispatch-kuyruğu helper'ı.

2. **SDK timeout regresyon sınıfını tamamen kapat.** `runTurn` + `translator` + `conversation-context` client'larına `models.ts` ile tutarlı timeout/maxRetries; `isTransientError`'a SDK timeout deseni; çift-retry'ı netleştir. Tüm SDK client kurulumu için **tek factory** (regresyonun bir daha yarım yamanmasını önler).

3. **False-pass deliklerini kapat.** harness-verdict güvenlik-skip kapsamını `phase-registry` tek-kaynağından türet; Faz 8 gate'i `iteration_started_at`-öncelikli yap; `phase-09-complete`→`phase-9-complete` + `required_audits`; Faz 7 skip'i structured-öncelikli yap. Bunlar "yeşil ama aslında atlanmış/yarım" durumlarını eler.

4. **Spawn-env + argv disiplinini tek noktaya topla.** orchestrator-agent Grep/Bash'e `safeEnv()`; `--allowedTools`/`--disallowedTools` tek args-builder + canlı doğrulama; Grep/Bash symlink post-check. (kural e + sandbox bütünlüğü)

5. **Config kalıcılığını merge'e çevir + sessiz dropdown'u düzelt.** `persistApiKeys`/`persistSelectedModels` field-bazlı merge; `list_models` başarısızında terminal event + frontend timeout/görünür hata. (kural a)

6. **Parite tutarsızlıklarını hizala.** Faz 0 D1 SDK read-only; yan-sınıflandırma routing'i (`project-type`, `conversation-context summary`) `backendForRole('translator')`'a; `betas` CLI'da görünür ele al; `noteCliRateLimitError`'ı bağla veya kaldır. (kural c)

7. **Statik kontrol + canlı doğrulamalar.** `check.sh`'e ESLint (`no-duplicate-case`, `no-fallthrough`) ekle (Bulgu: duplicate `run_phase`); `claude --help` argv konvansiyonu, claude resume `result.usage` semantiği, beta-model uyumu canlı doğrula.

8. **Orta/düşük doğruluk düzeltmeleri.** vite-injector nested-path, relevance chunk-id çakışması + parseCliScores predicate + general-memory stack-undefined fail-closed, runtime-http-server token, tech-debt-scanner çok-satır boş-catch, doküman/faz-no drift'leri.

---

## 5. Desenler & Sistemik Riskler

Tekil bug'ların altında **beş tekrarlayan sınıf** var; kalıcı önlem her sınıf için tek-nokta zorunluluğu + statik kontrol:

1. **"Fix bir yerde, eşinde değil" (yarım yamama).** SDK timeout `models.ts`'te yamandı ama `runTurn`/`translator`/`conversation-context`'te değil; resume `iteration_started_at`'a geçti ama Faz 8 gate + Faz 1 resume kırılgan tail'de kaldı; rate-limit guard `noteCliRateLimitError`'da var ama `noteRateLimitEvent`'te yok. **Önlem:** Aynı sınıf çağrıları **tek factory/helper**'a çıkar (SDK client factory, `runController`, ortak audit-tail-scope helper, ortak rate-limit guard). Fix helper'a girsin, tüm call-site'lar otomatik alsın.

2. **`try/finally` / lifecycle eksikliği → kalıcı kilit + orphan.** advance loop, verify-feature, askq promise, shutdown. **Önlem:** Controller yürütme ve dış-kaynak (process/server/promise) açan her yol zorunlu `try/finally`; tek `runController` + `gracefulShutdown`.

3. **Eşzamanlılık varsayımı (tek-akış sanılıyor).** IPC dispatch, askq resolver, runtime-watcher interleave. **Önlem:** Tek dispatch-kuyruğu (seri-leştirme) — birçok race'i kökten kapatır.

4. **Sessiz davranış farkı (kural a/c ruhu).** Config tam-replace key kaybı, list_models takılma, betas CLI'da düşme, legacy effort yutma, yan-sınıflandırma backend sapması, vite plugin sessiz atlama. **Önlem:** Davranış farkı = **görünür `emitChatMessage`/terminal event** zorunlu; per-rol backend kararı **tek predikat** (`backendForRole(role)`), `isSubscriptionMode` yalnız gerçek 3-rol anlamı olan yerlerde.

5. **Tek-kaynak iddiası ama enforce edilmeyen ikinci kopya.** agent-acl (audit-only), PhaseSidebar REQUIRED_PHASES duplike, harness güvenlik-skip prefix listesi `phase-registry`'den türetilmemiş, faz-no string'leri. **Önlem:** Türetilebilen her liste **kaynaktan türet** (registry'den); türetilemezse cross-check **testi** ekle. `check.sh`'e ESLint (`no-duplicate-case`/`no-fallthrough`) — bu turun duplicate `run_phase`'i gibi landmine'ları CI'da yakalar.

**Genel değerlendirme:** Kontrol kaybedilmiş değil; kurallar büyük ölçüde uygulanmış. Asıl tehlike, doğru fix'lerin **eşlerine taşınmaması** ve **eşzamanlılığın hiç varsayılmamış olması**. Adım 1-3 (lifecycle + timeout + seri-leştirme) tamamlandığında ekibin "regresyon ve kilitlenme" hissinin yapısal zemini büyük ölçüde ortadan kalkar.

*Not: Sağlanan veri JSON'unun sonu kesik geldi (`mediumLow` dizisinin son birkaç git/config bulgusu eksik olabilir). Bu rapor eldeki tüm haritalar + tüm `confirmedCritHigh` + sentezlenebilen `mediumLow` bulgularını kapsar; eksik kuyruk geri gönderilirse config/git bölümüne ek bulgu işlenebilir.*