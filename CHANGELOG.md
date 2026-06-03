# MyCL Studio — Değişiklik Günlüğü

> AI (Claude) tarafından yapılan işlerin zaman damgalı kaydı. Yeni → eski.
> Amaç: eski kararları/kuralları unutup bozmamak; bir işi değiştirmeden önce buraya bak.
> Eski bir işi değiştirmek/silmek gerekiyorsa ÖNCE Ümit'e sor (kural, 2026-06-03).

## 2026-06-04

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
