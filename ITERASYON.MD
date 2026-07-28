# MyCL İterasyon Pipeline'ı — 17 Fazın Her Biri Ne İş Yapar

> Bu doküman, MyCL orkestratörünün bir geliştirme iterasyonunda koştuğu **17 fazın** her birinin
> gerçek koddan (controller + `phase-registry.ts` + şablon + gate) çıkarılmış eksiksiz açıklamasıdır.
> Kaynak: `orchestrator/src/phase-*.ts`, `orchestrator/src/phase-registry.ts` (`PHASE_SPECS`),
> `orchestrator/src/base/*`, `assets/templates/phase-*.md`, `assets/profiles|security-rules/*`.

## Genel çerçeve

**Pipeline lineerdir:** `1 → 2 → 3 → … → 17` (dallanma yok, `PHASE_TRANSITIONS`). Buna ek olarak
**Faz 0 (Hata Ayıklama / Debug Triage)** pipeline DIŞINDA duran bir iç araçtır: yalnızca pipeline-içi
bir gate hatası takibinde içeriden tetiklenir; kullanıcı bug raporları Faz 1'den girer.

**Görev sınıfları** (`PHASE_SPECS[n].type`):

| Sınıf | Ne yapar | Örnek fazlar |
|---|---|---|
| `qa` | Soru sorar / onay alır (askq); LLM soru-cevap | 1, 2, 6, 9 |
| `production` | Bir artefakt üretir (`.mycl/*.md`) + onay ister | 3, 4, 7 |
| `codegen` | Gerçek kod yazar (Read/Edit/Write/Bash döngüsü) | 0, 5, 8 |
| `mechanical` | Yerel komut koşar (lint/test/build…), **LLM kullanmaz** | 10–17 |

**Zorunlu / opsiyonel** (`REQUIRED_PHASES` / `OPTIONAL_PHASES`):
- **Zorunlu:** 1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17 — her geliştirmede koşar, atlanamaz.
- **Opsiyonel:** 5 (UI), 6 (UI inceleme), 7 (DB). Faz 3 kapsamı önerir + kullanıcı doğrular; ancak
  kullanıcının kapsam seçimi (`needed_phases`, `isPhaseSkippedByScope`) yalnız **5 ve 7'yi** düşürebilir.
  **Faz 6 kapsamla düşürülemez** — UI varsa her zaman koşar (backend/mantık işinde bile mevcut UI'yi kullanıcıya
  gösterir; "artık zorunlu", KATI #9); yalnız hiç-UI (`skip_ui_phases`) veya entegre-mod istisnasıyla atlanır.
  Faz 7 ayrıca `has_database`'e bağlıdır. (Not: Faz 8/TDD `write_brief` enum'unda görünse de **zorunludur.**)

**Kapı (gate) & denetim (audit):** Her faz `audit.jsonl`'e `required_audits` olaylarını yazar; bir fazın
"tamam" sayılması bu olaylara + gate koşuluna bağlıdır. Mekanik fazlarda gate = komutun `exit 0`'ı +
`phase-N-complete` audit'i (registry'deki `gate_module_path` çoğu mekanik fazda vestigial — dosya yok,
yüklenmez). Kalite hattının çekirdeği: **sahte-yeşil yasağı** — boş/atlanmış tarama "temiz" sayılmaz.

**Model & eskalasyon:** Her faz modelini `escalatedModelEffort(state, config, '<iş-türü>')`'ten alır
(kullanıcı config'i kral; iş-türüne göre model+efor). Backend seçimi: **CLI** (Claude Code aboneliği) ↔
**API/SDK** ↔ **z.ai (GLM)**. Katı kural: CLI seçiliyken `claude` yoksa **API'ye sessizce düşülmez** —
görünür hata verilir.

**Gate-fail ne olur:** bir gate patlarsa → mahkeme müfettişi (`inspectGateFinding`, BAĞLAYICI:
proceed/suppress/escalate) + `runGateAutofix` (fazın içinde codegen ile düzelt) + (faz ≥9 ise)
regresyon guard; yakınsama yoksa `error-analysis` askq'si (kullanıcıya "nasıl ilerleyelim").

**Stack-bağımsızlık:** Tüm stack komutları `assets/profiles/<stack>.json`'dan `resolveMechanicalCmd` ile
okunur; `npm`/`Next` hiçbir yere hardcode edilmez; profilde anahtar yoksa **görünür skip** (`phase-N-skipped`).

---

## Hızlı tablo

| Faz | Ad | Sınıf | Zorunlu | Özet |
|----|----|-------|---------|------|
| 1 | Niyet Toplama | qa | ✔ | Kullanıcının bu projede ne istediğini netleştirir, onaylı EN özet üretir |
| 2 | Hassasiyet Denetimi | qa | ✔ | Niyeti 8 boyutta denetler, zenginleştirir, proje tipini sınıflar |
| 3 | Mühendislik Brifingi | production | ✔ | Yapısal brief + iterasyon kapsamı (hangi opsiyonel fazlar) |
| 4 | Spec Yazımı | production | ✔ | Test edilebilir kabul kriterli (AC) şartname |
| 5 | UI Yapımı | codegen | — | Spec'teki arayüzü yazar, bağımlılığı kurar, dev server açar |
| 6 | UI İncelemesi | qa | — | Uygulamayı kullanıcının incelemesi için park eder (deferred) |
| 7 | Veritabanı Tasarımı | production | — | DB şeması + çalıştırılabilir migration SQL'leri |
| 8 | BDD + TDD Uygulama | codegen | ✔ | Davranış-önce çift döngüyle kodu yazar; sahte-yeşil avlar |
| 9 | Risk İncelemesi | qa | ✔ | Bulan+çürüten düşman inceleme (7 eksen); fix kararları |
| 10 | Lint | mechanical | ✔ | Profil lint + kod-kalite semgrep + mimari kontrol |
| 11 | Sadeleştirme | mechanical | ✔ | Ölü kod taraması (node-npm'de ts-prune) |
| 12 | Performans | mechanical | ✔ | Profil perf/benchmark komutu |
| 13 | Güvenlik | mechanical | ✔ | Bağımlılık denetimi + 9 ek tarama; **BLOCKING** |
| 14 | Birim Testler | mechanical | ✔ | Profil test komutu (izole birimler) |
| 15 | Entegrasyon Testleri | mechanical | ✔ | Profil integration komutu (modüller arası) |
| 16 | E2E Testler | mechanical | ✔ | **Playwright** ile gerçek tarayıcı akışı (Cypress/Selenium yasak) |
| 17 | Sızma Testi | mechanical | ✔ | Otomatik pentest NO-OP; DAST 🛡️ butonuyla manuel |

---

## Faz 1 — Niyet Toplama (Intent Gathering) · qa · zorunlu

**Amaç.** Kullanıcının bu MyCL penceresine bağlı proje için ne yapmak/değiştirmek istediğini netleştirir.
Türkçe ham niyeti çevirmenle İngilizceye çevirir; şablona **deterministik kodbase snapshot** + alakalı
proje bağlamı + konuşma bağlamını enjekte eder; sonra qa-askq base controller'ını koşar. Ajan yalnız
"inşa edileni DEĞİŞTİRECEK" belirsizlikleri sorar (hedef ≤3, sert tavan 4 soru), gerisini muhafazakâr
varsayımla geçer ve 3-5 cümlelik özet üretir. Odak **WHAT** (ne isteniyor); HOW (mimari/kütüphane) sormak yasaktır.

- **Girdi:** kullanıcının TR niyeti → `intent_en`. `buildRelevantProjectContext` (spec/brief/audit/git'ten
  LLM-filtreli bağlam), `buildConversationContext` (son 5 mesaj; `isolatedIntent` ise katılmaz),
  `buildCodebaseSnapshot` (dil-agnostik FS gezisi).
- **Çıktı:** `approvedSummary` (EN) → orkestratör `state.intent_summary_raw`'a yazar (Faz 4 girdisi).
  Audit: `phase-1-intent-approve`, `phase-1-complete`.
- **Kapı & denetim:** `approved` VE özet **boş değil** (boşsa `fail` — sessiz kötü-devam engellenir).
  askq_config/çeviri/şablon hatası → tek mesajla `fail`.
- **Model & eskalasyon:** `escalatedModelEffort(…, 'intent')`. Backend Auto Mode simetrik CLI↔API;
  `cli` ama `claude` yok → görünür fail. No-tool-use kurtarma: SDK 1 retry + `tool_choice:any`; CLI ≤2
  nudge sonra prose'u şemaya sentezler (takılma yok).
- **Stack-bağımsızlık:** qa fazı, stack komutu koşmaz. Tek stack-duyarlı parça snapshot ve çok-dilli
  (`package.json`/`requirements.txt`/`go.mod`/`Cargo.toml`/…); FS okumaları fail-safe.
- **Dikkat çeken davranışlar:**
  - **Tek pencere = tek proje (HARD):** "yeni proje mi?", "devam mı geçiş mi?" gibi soru kalıpları yasak.
  - **Bug raporu** ("çalışmıyor/500/crash") → Faz 1 sorusu açmaz; özette Faz 0 Debug Triage'a yönlendirir.
  - **Tek işe odaklan:** geçmişteki başka sorunları bu niyete katmaz (`isolatedIntent`).
  - Kullanıcı "sen karar ver/farketmez" derse ajan soruyu tekrarlamaz, makul varsayımla ilerler.
  - Oto-cevap Faz 1 netleştirme sorularını **kapsam dışı** bırakır (ürün/mimari tercihini kullanıcı seçer).
  - Cevap-hatırlama merdiveni bu faza **uygulanmaz** (yalnız gate-error + Faz 3 kapsam).
  - CLI backend salt-okunur (`Read/Grep/Glob`; Write/Edit/Bash/Agent yasak).
- **Anahtar dosyalar:** `phase-1.ts`, `phase-1-codebase-probe.ts`, `phase-registry.ts:91-107`,
  `base/qa-askq-controller.ts`, `assets/templates/phase-01-intent.md`.

## Faz 2 — Hassasiyet Denetimi (Precision Audit) · qa · zorunlu

**Amaç.** Faz 1'in onaylı niyetini **8 boyutta** denetler, kritik belirsizlikleri yüzeye çıkarır ve Faz
3/4'ün güvenebileceği **`enriched_summary`** (4-6 cümle, kullanıcının literal seçimleri korunarak) üretir.
Ayrıca `classifyProjectType` (çevirmen rolünün seçili modeli) ile proje tipini türetir → `project_type` + `skip_ui_phases` +
`has_database` + `ui_complexity` state'e yazılır (Faz 5/6/7 skip ve Faz 16 runner seçimi buna bağlanır).
8. boyut **COMPLIANCE** en sonda koşar; kullanıcı uyumsuzlukları görüp "Vazgeç" derse faz `abandoned` döner.

- **Girdi:** `auditIntent = intent_summary_raw` (DAİMA **ham** niyet — enriched'i denetleyip döngüsel
  self-audit yapmasını engeller). 4 paralel relevance digest'i (spec/abandoned/features/ADR).
- **Çıktı:** `{intent_summary: enriched, project_type, skip_ui_phases, has_database?, ui_complexity?}`.
  Audit: boyut başına `precision-dimension`, `phase-2-precision-complete`, `phase-2-complete`.
  `abandoned` → `abandoned-intents.jsonl`'a yazılır + Faz 1'e reset.
- **Kapı & denetim:** `approved` VE enriched boş değil. `dimensions` bozuk şema gelirse `Array.isArray`
  guard'ıyla []'e düşer ama **sessiz değil** (log + chat uyarısı).
- **Model & eskalasyon:** `escalatedModelEffort(…, 'audit')`; Faz 1 ile aynı backend yolu.
  Tool seti: `ask_clarifying` + `abandon_iteration` + `complete_precision_audit`.
- **Stack-bağımsızlık:** stack komutu koşmaz; `classifyProjectType` çıktısı downstream skip/runner'ı sürer
  (framework hardcode yok). Relevance digest'leri fail-safe (hata → sentinel, faz çökmez).
- **Dikkat çeken davranışlar:**
  - **8 boyut:** SCOPE, USERS, DATA, SUCCESS, EDGE, PERFORMANCE, SECURITY, COMPLIANCE.
  - **SCOPE DISCIPLINE (HARD):** boyutlar niyeti netleştirmek için — küçük işi büyütmek için değil;
    bug-fix gibi dar işte çoğu boyut "N/A, değişmedi"; uydurma perf-bütçesi/güvenlik alt-sistemi yasak.
  - `project_type='unknown'` → sessiz yanlış sınıflandırma yerine net uyarı.
  - Oto-cevap Faz 2 netleştirme sorularını da kapsam dışı bırakır; cevap-hatırlama uygulanmaz.
- **Anahtar dosyalar:** `phase-2.ts`, `phase-registry.ts:108-142`, `base/qa-askq-cli-backend.ts`,
  `index.ts:4190` (appendAbandonedIntent), `assets/templates/phase-02-precision.md`.

## Faz 3 — Mühendislik Brifingi · production · zorunlu

**Amaç.** Faz 2'nin zenginleştirilmiş niyetini yapısal bir mühendislik brifine çevirir: başlık, özet,
kanonik etiketler (`auth`, `crud`, `ui:web`, `database:*`, `dev_workflow:*`…), paydaşlar, kısıtlar. Ayrıca
bu iterasyonun **kapsamını** belirler — `write_brief` enum'u [5,6,7,8]'i değerlendirir, **ama** kullanıcının
kapsam onayı gerçekte yalnız **Faz 5 (UI) ve Faz 7 (DB)'yi** düşürebilir; Faz 6 (UI varsa) ve Faz 8 zorunludur. `write_brief` ile bir kez yazar → `.mycl/brief.md`, sonra `request_brief_approval`
ile onay ister.

- **Girdi:** `state.intent_summary` (yoksa fail); `phase-03-brief.md` şablonu; konuşma bağlamı.
- **Çıktı:** `.mycl/brief.md`; `statePatch.needed_phases_proposed = computeNeededPhases(…)` (zorunlular +
  geçerli opsiyoneller). Audit: `phase-3-brief-approve`, `phase-3-complete`. ADR karar-kaydı (`appendDecision`).
- **Kapı & denetim:** production-schema base controller'ın Approve/Revise/Cancel askq'si. `gate_module_path`
  registry'de yazar ama **dosya yok** — tamamlanma controller'ın `complete` dönüşü + `recordPhaseComplete(3)`.
- **Model & eskalasyon:** `escalatedModelEffort(…, 'briefing')`, model_role=main. CLI'de Claude
  kredi/limit hatasında z.ai (GLM) fallback'e **yapışkan** geçiş.
- **Stack-bağımsızlık:** brief saf prose+etiket; stack komutu yok. `dev_workflow` etiketi heuristikle
  (concurrent/frontend-only/backend-only) — framework adı türetilir, hardcode edilmez.
- **Dikkat çeken davranışlar:**
  - **KRİTİK:** Faz 3 onayından sonra `needed_phases` HEMEN set edilmez — `index.ts` ayrı bir
    **kapsam-doğrulama askq'si** açar (kullanıcı "önerilen seti onayla" / "tüm fazları çalıştır" / override).
  - Oto-cevap açıksa "önerilen seti onayla" otomatik seçilir (47 dk takılma düzeltmesi).
  - **Cevap-hatırlama (2026-07-03):** aynı önerilen faz-seti tekrar gelirse önceki karar hatırlanır.
  - ADR yazımı başarısızsa **görünür** uyarı (orkestratör belleği eksik kalmasın).
- **Anahtar dosyalar:** `phase-3.ts` (TOOL_WRITE_BRIEF, `computeNeededPhases`), `phase-registry.ts:143-157`,
  `index.ts:4247-4300` (kapsam-doğrulama askq), `assets/templates/phase-03-brief.md`.

## Faz 4 — Spec Yazımı · production · zorunlu

**Amaç.** Niyet + briefinden yapısal şartname üretir: başlık, kapsam (dahil+hariç), **3-7 test edilebilir
kabul kriteri (AC — tercihen Given/When/Then)**, kapsam-dışı, teknik riskler, kullanıcının açıkça demediği
varsayımlar. `write_spec` ile bir kez yazılır, `request_spec_approval` ile onay istenir. Onayla
`spec_approved=true` + `spec_hash`. **Her spec kendine özeldir** — eski spec'in scope/AC/risk'i artık merge edilmez.

- **Girdi:** `state.intent_summary`; `phase-04-spec.md` şablonu; `buildRelevantEngineeringBrief`
  (Faz 3 brief'i relevance-filtreli); "yalnız BU iterasyonun niyetini kapsa" talimatı.
- **Çıktı:** `devs/_pending/<ts>/iter-spec.md` (her iterasyon kendi spec'i). Audit: `spec-block`,
  `phase-4-spec-approve`, `phase-4-complete`. ADR kaydı.
- **Kapı & denetim:** `required_audits` (spec-block → phase-4-spec-approve → phase-4-complete); kapı mantığı controller içinde (approve→complete/cancel→fail).
  `output_schema` `phase-04-spec.json` (AC 3-7, id pattern `^AC[0-9]+$`).
- **Model & eskalasyon:** `escalatedModelEffort(…, 'spec')`. Model değişince chat'e "🧠 Spec: <model> · efor N".
- **Stack-bağımsızlık:** spec yalnız **gözlemlenebilir davranışı** tanımlar — dosya yolu/kütüphane/mimari
  YASAK (hard constraint + red-flag). Perf AC yalnız niyet gerçekten gerektiriyorsa.
- **Dikkat çeken davranışlar:**
  - **preApprovalHook:** (1) varsayımları Türkçeye çevirip **görünür** eder (kapı değil, kullanıcı itiraz
    etsin); (2) önemli spec'lerde bağımsız **kör-nokta merceği** koşar.
  - **Incremental/merge modu KALDIRILDI (2026-06-16):** alakasız eski işi diriltip Faz 8'i boğuyordu.
  - GWT temizliği: fantom-AC guard (boş given/when/then placeholder'ları elenir → yanlış-fail önlenir).
  - `runComprehensionGate` şu an **NO-OP** (kullanıcı okuma sorumluluğunu alıyor, spec chat'te biçimli).
- **Anahtar dosyalar:** `phase-4.ts`, `phase-registry.ts`,
  `assets/schemas/phase-04-spec.json`, `assets/templates/phase-04-spec.md`.

## Faz 5 — UI Yapımı (UI Build) · codegen · **opsiyonel**

**Amaç.** Spec'teki arayüzü sıfırdan yazar veya var olanı genişletir: UI bileşenleri/sayfaları + **tam bir
`package.json`** (import edilen her kütüphane dependencies'e) üretir; ajan kurulum/build/dev-server
**ÇALIŞTIRMAZ** — yalnız dosya yazar. Ajan durunca **MyCL bağımlılıkları kendisi senkron kurar** (profilden),
dev server'ı arka planda başlatıp tarayıcıyı açar (Faz 6 için ayakta olmalı). Ürettiği kod **%100 CSP-uyumlu**
olmalı (unsafe-* yok). İki mod: normal (sıfırdan/genişletme) ve **tweak** (Faz 6 revize talebiyle minimal değişiklik).

- **Girdi:** Faz 4 spec'i; prototip-cache (`applyPrototype` golden baseline); `pending_ui_tweak`;
  `state.stack` (install/build); `ui_complexity` + `design_workflow` flag.
- **Çıktı:** UI dosyaları + `package.json`; opsiyonel `.mycl/design.md`. Emit edilen audit'ler: `ui-file-write`,
  `ui-dev-server-spawn`, `phase-5-complete` + CSP/kurulum/dev-server durum event'leri. `dev_server_pid`.
  (Registry'deki `required_audits`=ui-file-write/**ui-ready**/phase-5-complete'te "ui-ready" **vestigial** — kodda
  emit edilmez; codegen fazında gate'i sürmez, tamamlanma çıktı-tabanlıdır.)
- **Kapı & denetim:** en az 1 `ui-file-write` VEYA no-op + `package.json` var + CSP temiz + dev server
  2xx/3xx (5xx build-breaker → fail). Tamamlama **çıktı-tabanlı** (diskte gerçekte ne var), marker-echo'ya güvenilmez.
- **Model & eskalasyon:** `escalatedModelEffort(…, 'ui-codegen')` (codegen/strong). Tweak no-op fail'de
  merdiven tırmanmaz (model gücü çözmez) → doğrudan error-analysis.
- **Stack-bağımsızlık:** install/build/dev komutları `loadProfile(state.stack)`'tan; profil yoksa npm
  fallback (yalnız `package.json` varsa). CSP mekanizması stack'e göre (Vite meta vs Next header).
  `denied_paths` backend yollarını (src/api, backend, prisma, migrations…) engeller.
- **Dikkat çeken davranışlar:**
  - **Faz 5 backend YAZMAZ** (`denied_paths`). **LOGIN İSTİSNASI:** `**/auth/**`, `**/login/**` deny'ı
    ezer → minimal dev-login yazılabilir (reviewer Faz 6'da giriş yapsın; tavuk-yumurta).
  - **CSP GATE (fail-closed):** inline handler/eval/`javascript:` bulursa fail (ajan düzeltir); temizse
    `ensureCspMeta` katı CSP meta ekler → %100 CSP shiplenir.
  - **BUILD-BREAKER yakalama:** dev server "ayakta" yetmez — kalıcı 5xx (server-only/fs import bundle
    sızıntısı) → fail → Faz 0.
  - **no-change-needed:** ajan hiç dosya yazmazsa "kod zaten spec'i karşılıyor" → temiz geç (loop fix).
  - Dış dev server tespiti: portta 2xx varsa yeniden başlatmaz (dev-ortam ≠ proje sorunu).
  - `snapshotBeforeAutofix` → ajanın sildiği geri alınabilir; başarıda `disarmRollback`.
  - **Tasarım fan-out** (design_workflow): architect/ux/security/data paralel → sentez → `.mycl/design.md`.
  - Atlama YALNIZ yapısal `skip_ui_phases` (library/cli/api/ml/game) + spec'te UI işareti yok (regex tek
    başına skip vermez — yıkıcı yanlış-skip önlemi).
- **Anahtar dosyalar:** `phase-5.ts`, `phase-registry.ts:176-201`, `base/codegen-controller.ts`,
  `csp-compliance.ts`, `dev-server-launcher.ts`, `assets/templates/phase-05-ui.md`.

## Faz 6 — UI İncelemesi (UI Review) · qa (DEFERRED) · **opsiyonel**

**Amaç.** Kullanıcının uygulamayı tarayıcıda **gerçekten incelemesi** için pipeline'ı park eder — controller
askq açmaz, AC döngüsü/fix turu tetiklemez; yalnız dev server'ın ayakta olduğunu garanti eder + kısa yön
gösterici mesaj yazıp `deferred` döner. Dev server canlı değilse `ensureDevServerForReview` ile yeniden
başlatır; başlatamazsa "açıldı" **iddia etmez**. **Erişilebilirlik (WCAG) salt-rapor** eklenir (GATE değil).
Kullanıcının bir sonraki mesajı `approve_ui` / `revise_ui` / `cancel_pipeline` olarak yorumlanır.

- **Girdi:** `dev_server_pid` + `project_root`; a11y için `dev.port` (bilinmezse 5173). Kullanıcının
  bir **sonraki** composer mesajı.
- **Çıktı:** Audit: `phase-6-deferred`, `a11y-scan`. `pending_ui_review=true` +
  `emitPhaseChanged(6,6,'waiting')` (Header "yanıt bekleniyor"). Onayda: approve→`phase-6-complete`+Faz 7;
  revise→`pending_ui_tweak`+Faz 5 tweak; cancel→durdur.
- **Kapı & denetim:** controller `deferred` döner; gerçek "tamam" kararını **kullanıcı** verir.
  **Faz 6 ASLA oto-geçilmez/atlanmaz** (yapısal `skip_ui_phases` hariç) — **KATI KURAL #9**.
- **Model & eskalasyon:** deferred modda **LLM çağrılmaz**; sonraki mesajın sınıflandırması orkestratörün
  intent classifier'ında (çevirmen hattı).
- **Stack-bağımsızlık:** dev server yeniden başlatma Faz 5 ile aynı stack-agnostik launcher (DRY);
  a11y `runAccessibilityScan` canlı URL'e (DOM tabanlı, framework-agnostik).
- **Dikkat çeken davranışlar:**
  - A11y raporu **GATE değil** (false-positive→tıkanma riski); bilgi amaçlı, bloklamaz.
  - **Onay yorumlama (en kritik karar):** salt-görsel kusur → `revise_ui` (Faz 5 tweak); işlevsel/backend
    kökenli kusur ("500", "kayıt kalmıyor") → `develop_new_or_iter` (Faz 5 tweak backend'i düzeltemez).
  - Controller çökerse `pending_ui_review` set edilmez → orphan-drop simetrisi + görünür fail.
- **Anahtar dosyalar:** `phase-6.ts`, `phase-registry.ts:202-224`, `index.ts:3115-3172`,
  `smoke-test.ts`, `accessibility-scan.ts`, `orchestrator-system.md:254-265`.

## Faz 7 — Veritabanı Tasarımı (Database Design) · production · **opsiyonel**

**Amaç.** Spec'in ima ettiği veri modelini yapısal DB şemasına + migration planına çevirir: tablolar/alanlar/
PK/FK/index'ler + sıralı **çalıştırılabilir DDL/DML SQL** migration'ları. `write_db_schema` (title+tables+
migrations zorunlu) → `request_db_approval`. Onayla `.mycl/db-schema.md` render edilir VE her migration
`.mycl/migrations/NNN-<slug>.sql`'e yazılır (Faz 8 uygular). `pending_db_fix` set ise **hedefli-fix** modu
(tüm şemayı yeniden tasarlamaz).

- **Girdi:** `state.intent_summary`; `phase-07-db.md`; `buildRelevantEngineeringBrief`; `pending_db_fix`;
  `state.stack` (Postgres/SQLite/MySQL SQL hedefi).
- **Çıktı:** `.mycl/db-schema.md` + `.mycl/migrations/*.sql`. `statePatch.pending_migrations`. Audit:
  `phase-7-db-approve`, `phase-7-complete`. ADR kaydı.
- **Kapı & denetim:** `approved` + migration dosyaları başarıyla yazıldı. **Migration yazımı başarısızsa →
  `fail`** (eskiden sessizce `complete` dönüp Faz 8'e gidiyordu — FROZEN-GOAL fix).
- **Model & eskalasyon:** `escalatedModelEffort(…, 'db-design')` (design/strong); production-schema CLI backend.
- **Stack-bağımsızlık:** kanonik SQL tipleri (text/integer/boolean/timestamptz/uuid); migration `.sql` formatı
  agnostik. Skip: `has_database===true`→koş, `false`→skip, `undefined`→spec heuristic.
- **Dikkat çeken davranışlar:**
  - Yapısal sinyal (`has_database`) **öncelikli** (eski OR-bug: LLM "DB var" dese bile regex kaçırınca atlanıyordu).
  - Migration SQL **zorunlu** (sözde değil, gerçek DDL); boş SQL → görünür hata (sessiz skip yok).
  - Ziyaretçi parmak-izi standardı (visitors/visitor_events/login_verifications) — ama iterasyon kapsamına
    saygı (küçük/alakasız işe zorla sokmaz).
- **Anahtar dosyalar:** `phase-7.ts`, `phase-registry.ts:225-239`, `index.ts:4470-4520`,
  `assets/templates/phase-07-db.md`.

## Faz 8 — BDD Dış Döngü + TDD İç Döngü (çift döngü) · codegen · zorunlu

**Amaç.** Faz 4 spec'ini **davranış-önce çift döngüyle** koda döker: önce her yeni/değişen AC için insan-okur
`features/*.feature` Gherkin dosyası (**dış döngü**, çalıştırılmaz — parser/runner yok, stack-bağımsız), sonra
smoke-first + integration-first **TDD** (kırmızı-yeşil-refactor, **iç döngü**). Ajan test yazar, prod kod yazar,
test koşar; MyCL her Write/Edit'i observer ile izler (`tdd-test-write`/`tdd-prod-write`/`tdd-green`/`tdd-red`).
Faz sonunda **MyCL profil tam-suite'ini KENDİ koşar** (bütünlük çapası) — ajanın "yeşil" raporuna körü körüne
güvenmez, gerçek exit-code otoriter olur. Sıfır teknik borç zorlanır; gerçek-yeşil suite'te **mutasyon probu +
bağımsız düşman-test yazarı** ile sahte-yeşil avlanır.

- **Girdi:** `spec.md`; `pending_migrations` (Faz 7); `pending_backend_fix`/`fix_checkpoint_ref` (Faz 0 D2
  fix routing); `pending_behavior_consent_note`; iterasyon sınırı; profil test komutu (bütünlük çapası).
- **Çıktı:** `features/*.feature` + prod/test kodu. Audit: `tdd-test-write`, `tdd-prod-write`,
  `bdd-scenario-write`, `tdd-green/red`, `tdd-tech-debt-detected/clean`, `tdd-tests-weak`, `tdd-unverified`,
  `phase-8-complete`, `behavior-consent-violation`. `.mycl/handoffs.jsonl`. `tdd_compliance_score`.
- **Kapı & denetim (hepsi gerekir):** `greens ≥ minGreens` (AC'ye orantılı) VE son event `tdd-green` VE
  `techDebtCount===0` VE bütünlük çapası son 10 event'te tdd-green VE (fix modunda) **repro kırmızı-önce-yeşil**
  VE AC-kapsama tam. Suite koşamadıysa (E2BIG/ortam) → `tdd-unverified` + fail (rollback yok, `escalatable=false`).
- **Model & eskalasyon:** `escalatedModelEffort(…, 'tdd-codegen')`; **retry KALDIRILDI** (tek deneme, token
  maliyeti). Gate-fail'de `lastFailEscalatable`: yalnız kod-kalite fail'i VE aynı regresyon tekrarlamıyorsa true.
- **Stack-bağımsızlık:** test komutu `profile_key:test`'ten (13 runner tanınır); yok/ayrıştırılamaz →
  baseline null + `tdd-unverified` görünür. `.feature` bilerek stack-bağımsız (ayrı BDD çerçevesi kurma).
- **Dikkat çeken davranışlar:**
  - **Bütünlük çapası** (`runIntegrityAnchor`): tam-suite'i MyCL koşar → yanlış-green + regresyon elenir.
  - **Sahte-yeşil panzehiri:** `runMutationProbe` (değişen dosyayı boz, test kırmızıya dönmeli) +
    `runAdversarialTester` (bağımsız kod-kıran ajan).
  - **Regresyon-farkında verdict:** fix öncesi baseline; yalnız önceden-kırık testler kalırsa geçer, yeni
    düşen test → REGRESYON fail. Aynı imza iki denemede tekrarsa tırmanma kesilir (boş yakma önlenir).
  - **Repro-first görev-sınıfı-duyarlı** 3 muafiyet (static-only/yalnız-test/yalnız-config) → imkânsız-repro
    döngüsü (Faz 11↔8, 16↔8) kırılır.
  - Fix modu rollback: `FixSnapshot` (git checkpoint / yedek); başarısız/regresyonlu fix otomatik geri alınır,
    restore başarısızsa LOUD uyarı.
  - E2BIG/spawn ortam faultu = kod hatası **değil** → `tdd-unverified`, codegen tetiklenmez.
  - `bdd-scenario-write` GATE değil (görünürlük); refactor iterasyonunda `.feature` yokluğu normal.
- **Anahtar dosyalar:** `phase-8.ts` (982-1114 gate, 1120-1149 mutasyon, 100-215, 740-823),
  `phase-registry.ts:240-250`, `assets/templates/phase-08-tdd.md`.

## Faz 9 — Risk İncelemesi (bulan + çürüten düşman inceleme) · qa · zorunlu

**Amaç.** Faz 8 çıktısının kalan risklerini **düşman gözüyle** gezer — insan incelemesinin yerini alan son
savunma hattı. Her riski `skip/fix/rule` sınıflar ve "fix"leri `fix_phase` (ui/db/code) ile etiketler ki
orkestratör otomatik uygulasın. CLI/abonelik VEYA z.ai modunda **çok-ajanlı "bulan + çürüten" tartışma**
(7 eksen, STRIDE dahil): N uzman bulucu paralel tarar, her bulguyu **bağımsız çürütücü** gerçek koda karşı
yeniden doğrular → yanlış-pozitif elenir (etkileşimsiz, kullanıcı onayı yok). API modunda tek-ajan qa-askq'ya düşer.

- **Girdi:** spec `Risks` bölümü; relevance-filtreli Faz 9 audit; `collectIterationTechDebt` (bu iterasyonda
  değişen prod dosyaların borç taraması); bayat-artefakt kontrolü; ajanın SCOPED Read/Grep sınırı (değişen dosyalar).
- **Çıktı:** Audit: `phase-9-tech-debt-scan`, `risk-decision`, `phase-9-complete`. `riskDecisions[]`
  (risk/decision/detail/fix_phase) → orkestratör `dispatchRiskFixes` ile Faz 5/7/8'e yönlendirir.
- **Kapı & denetim:** **Faz 9 ZORUNLU** (atlanırsa kontrol delinir). Debate `ok:false` (Dalga-1 bulucular
  **tümü** patlarsa — **fail-closed**, boş sonuç "risk yok" sayılmaz) → fail. `auto_conclude:true`.
- **Model & eskalasyon:** `escalatedModelEffort(…, 'risk-review')`. CLI/z.ai → debate; aksi tek-ajan.
  Bulucular salt-okunur.
- **Stack-bağımsızlık:** tamamen dil/framework agnostik (kod-yolu + audit + spec). Git yoksa "değişen dosya
  belirlenemedi" dürüst notu (deterministik tarama atlanır ama ajan spec+audit ile değerlendirir).
- **Dikkat çeken davranışlar:**
  - **7 eksen 2 dalgada:** Dalga 1 (correctness/security/performance/maintainability) paralel; Dalga 2
    (error-paths/STRIDE/tech-debt) Dalga-1 bulgularını görür + tekrar etmez.
  - **Çürütücü mimarisi:** her bulgu bağımsız doğrulanır; `is_real!==true` → elenir; çürütücü patlarsa
    kuşkuda **düşür** (refute-default).
  - Dedup muhafazakâr metin-birebir (semantik LLM-dedup kaldırıldı — gerçek bulgu düşürme riski).
  - **VERIFY FIRST:** ajan kod-faktını kendi okur, kullanıcıya "kod ne yapıyor" diye sormaz.
  - **fix-dispatch:** "fix"ler senkron mini-döngüyle ilgili faza (ui→5/db→7/code→8); pipeline ilerlemez
    (current_phase 9'da kalır), fail-soft.
- **Anahtar dosyalar:** `phase-9.ts`, `phase-9-debate-review.ts`, `phase-9-debate-dedup.ts`,
  `phase-9-tech-debt.ts`, `phase-registry.ts:251-269`, `index.ts:3828-3919`.

## Faz 10 — Lint · mechanical · zorunlu

**Amaç.** Stack profilinden çözülen lint komutunu (`npm run lint` / `uv run ruff check .` /
`cargo clippy -- -D warnings`…) proje kökünde koşar; `exit 0` = geçti. Fail'de profildeki fix komutunu
çalıştırıp bir kez yeniden tarar (`max_rescans=1`). Yanında **iki ek paralel tarama:** (1) **`code-quality`**
semgrep (güvenlik-DIŞI anti-pattern: yutulan hata, debug artığı, ts-suppress kaçağı); (2) **`architecture`**
(`arch-check.mjs` — client kodun DB-sürücüsü/node builtin import etmesi).

- **Kapı & denetim:** `lint-pass`/`lint-fail`; "tamam" = ana scan `exit 0` VE tüm extra_scans pass/skip.
  Fail → gate-autofix mahkeme + `runGateAutofix`; çözülmezse `error-analysis`.
- **Model & eskalasyon:** mekanik faz **LLM kullanmaz**; LLM yalnız **fail sonrası** (mahkeme müfettişi +
  autofix codegen). Müfettiş `proceed/suppress/escalate` (BAĞLAYICI).
- **Stack-bağımsızlık:** `scan_cmd={profile_key:"lint"}`; profilde yoksa görünür skip. `SEMGREP_EXCLUDE_FLAGS`
  build-dir (`.next`/`dist`/`build`/`out`/`coverage`) + vendor + minified'ı eler → **yalnız kaynak taranır**.
- **Dikkat çeken davranışlar:**
  - code-quality semgrep CANLI-BUG (Arcelik_BO): `.next` webpack bundle'ını tarayıp 17 false-positive üretip
    tıkıyordu → build-dir exclude'ları eklendi.
  - `tool_error_codes=[2,7]`: bozuk-kural/tarama exit 2/7 → **fail değil skip**; gerçek bulgu exit 1 → fail.
  - extra_scans **paralel** (`Promise.all`); `ensureSemgrepIgnore` ile `.semgrepignore` yazılır.
  - `SCOPED_GATES_DISABLED=true`: "hiçbir faz atlanamaz" → `changed_scope` temizlenir, tüm-proje taranır.
- **Anahtar dosyalar:** `phase-registry.ts:270-316`, `base/mechanical-runner.ts:262-491`,
  `index.ts:5034-5150` (gate-autofix), `semgrep-excludes.ts`, `assets/quality-rules/code-quality.yml`, `arch-check.mjs`.

## Faz 11 — Sadeleştirme · mechanical · zorunlu

**Amaç.** Ölü kod / gereksiz karmaşıklık taraması: profildeki `simplify` komutunu koşar. node-npm'de
`npx --no-install ts-prune --error` (kullanılmayan export = ölü kod); çoğu diğer profilde `simplify` null →
**görünür skip**. `fix_cmd`/`extra_scans` yok, `max_rescans=0` → tek tarama, oto-düzeltme yok.

- **Kapı & denetim:** `simplify-pass`/`simplify-fail`; ilk fail doğrudan fail (sonra gate-autofix).
- **Stack-bağımsızlık:** yalnız node-npm'de ts-prune tanımlı; python/rust/go null → skip.
- **Dikkat çeken davranışlar:**
  - **ts-prune JS-projesinde çalışmaz** → `ts_tool_js_project` skip (N/A-nötr; boş tarama sahte-yeşil sayılmaz).
  - **Next.js-aware:** `isNextJsProject` ise CLI'ye `-i '<ignore>'` eklenir (middleware/layout/page/… convention
    export'ları false-positive vermesin).
  - tsconfig yoksa `ts_tool_not_applicable` skip; ts-prune kurulu değilse `isMissingCommand` skip.
- **Anahtar dosyalar:** `phase-registry.ts:317-329`, `base/mechanical-runner.ts:549-585`,
  `assets/profiles/node-npm.json`.

## Faz 12 — Performans · mechanical · zorunlu

**Amaç.** Performans/benchmark taraması: profildeki `perf` komutunu koşar (`npm run perf` / `cargo bench` /
`go test -bench`). Profilde yoksa görünür skip. `max_rescans=0`.

- **Kapı & denetim:** `perf-pass`/`perf-fail`; `exit 0` = geçti.
- **Dikkat çeken davranışlar:**
  - **echo-stub tespiti** (`isStubGateCommand`): `… && echo 'perf check passed'` gibi sahte komut →
    "DOĞRULANMADI" görünür skip (YZLLM "1 saniyede geçti — normal mi?" vakası; sahte-yeşil önleme).
  - Çoğu stack'te `perf` null → skip; yalnız gerçek benchmark tanımlıysa koşar.
- **Anahtar dosyalar:** `phase-registry.ts:330-343`, `base/mechanical-runner.ts:533-548`.

## Faz 13 — Güvenlik · mechanical · zorunlu · **BLOCKING**

**Amaç.** Çok-katmanlı güvenlik: ana scan bağımlılık-denetimi (`npm audit --omit=dev --audit-level=high` /
`pip-audit` / `cargo audit` / `govulncheck`), üzerine **9 ek paralel tarama** — csp-evaluator (severity≤40
blocking), semgrep-secrets (`p/secrets`), semgrep auto, `p/security-audit`, `p/owasp-top-ten`, security-headers,
data-sanitization + web-security (custom YAML), gitleaks. En riskli faz olduğu için **BLOCKING'dir:** gate-fail
"tamamlandı" sayılmaz.

- **Kapı & denetim:** `security-pass`/`security-fail` + ek tarama başına pass/fail/skip. Fail → **akış durur**;
  "Kabul et+devam" → `phase-13-complete(security_accepted_by_user)` + fix sonrası `runRegressionGuard`.
- **Model & eskalasyon:** en kritik LLM yolu: `inspectGateFinding` mahkemesi **`highStakes=true`** ile —
  güvenlikte `suppress` hükmü zorla `escalate`'e çevrilir (sessiz-gömme yasak). Mahkeme erişilemezse görünür
  "DENETİMSİZ geçti" uyarısı. `stepSecurityConvergence` (saf karar): fix-döngüsünde bulgu **azalmıyorsa**
  (`converging=false` — deneme sayısı yerine bulgu-azalması ölçütü), döngü **durur** → LOUD "kabul et+devam" veya
  insana blocking askq. **Model-merdiveni yok** (2026-06-16 "merdiven kullanmıcaz" ile kaldırıldı).
- **Stack-bağımsızlık:** ana scan profil `security`'den; semgrep config'leri dil-agnostik. Araç kurulu değilse
  skip; ama **profil-null security nötr-N/A'dan bilerek çıkarıldı** ("bu stack güvenli" demek değil → PARTIAL).
- **Dikkat çeken davranışlar:**
  - BLOCKING: `index.ts` `next===13` özel dalı; MEDIUM dahil bloklar.
  - semgrep `tool_error_codes=[2]`: crash/bozuk-kural exit 2 → bulgu değil → skip; gerçek bulgu exit 1 blocking.
  - gitleaks kurulu değil → skip; leak → exit 1 blocking (`--source src/`).
  - `isMyclToolBroken`: csp/headers `.mjs` module-not-found → **PROJE hatası değil** → skip (güvenlik açığı değil).
- **Anahtar dosyalar:** `phase-registry.ts:344-440`, `index.ts:4799-5027`, `base/mechanical-runner.ts:332-491`,
  `csp-check.mjs`, `headers-check.mjs`, `assets/security-rules/*.yml`.

## Faz 14 — Birim Testler · mechanical · zorunlu

**Amaç.** Birim test paketini LLM olmadan yerelde koşar: profil `test` komutu (`npm test`) proje cwd'sinde;
`exit 0` = geçti. `max_rescans=0`, `fix_cmd` yok → ilk fail doğrudan başarısızlık (birim testte oto-kod-yaması yapılmaz).

- **Kapı & denetim:** `unit-pass`/`unit-fail`; pass VEYA skip → complete + ilerle; fail → jenerik `failPhase`.
- **Stack-bağımsızlık:** `scan_cmd={profile_key:'test', scoped_key:'test_scoped'}`; profil/key null → skip;
  script yoksa `isMissingCommand` skip (fail değil).
- **Dikkat çeken davranışlar:**
  - `isSpawnEnvFailure` (E2BIG/timeout/ENOMEM) → testler **koşmadı** sayılır: `[ENV]`-imzalı görünür fail,
    retry yok, "proje hatası değil" (adminpanel 21-iter döngü kökü).
  - `skip_unless='always'` → hep koşmaya çalışır (yalnız komut/stack yoksa skip).
- **Anahtar dosyalar:** `phase-registry.ts:441-454`, `base/mechanical-runner.ts:497-728`, `profile-loader.ts:168-198`.

## Faz 15 — Entegrasyon Testleri · mechanical · zorunlu

**Amaç.** Modüller-arası entegrasyon paketini koşar (birimden geniş): profil `integration` komutu
(`npm run --silent test:integration`). Faz 14 ile aynı iskelet; scoped varyant yok, `max_rescans=0`.

- **Kapı & denetim:** `integration-pass`/`integration-fail`; profilde `integration` yoksa/script eksikse
  görünür skip (birçok projede `test:integration` yok → akış sürer).
- **Dikkat çeken davranışlar:**
  - `SCOPED_SKIP_PHASES={11,12,15,17}` içinde (tüm-sistem gate'i); ama `SCOPED_GATES_DISABLED=true` → hep tam koşar.
  - `scoped_cmd_template` yok → değişen-dosya daraltması uygulanmaz (Faz 14'ten farkı).
- **Anahtar dosyalar:** `phase-registry.ts:455-466`, `base/mechanical-runner.ts:497-728`.

## Faz 16 — E2E Testler · mechanical · zorunlu

**Amaç.** Uçtan uca testleri çalışan uygulamaya karşı **Playwright** ile koşar — **Cypress/Selenium/WebdriverIO
YASAK** (orchestrator-system HARD RULE). Faz'a girmeden önce spec `has_ui` heuristiği + Playwright feature-toggle
+ kurulum/scaffold/auth ön-adımları; sonra `project_type`'a göre E2E komutu (`npx --no-install playwright test
--headed`). UI olmayan projede (api/cli/library/ml/game) → skip.

- **Kapı & denetim:** `e2e-pass`/`e2e-fail`; `skip_unless='has_ui'` false → faz hiç koşmadan skip+complete.
  Pass sonrası **`emitPhase16HonestyNote`** — placeholder smoke / doldurulmamış auth için **dürüst not**
  ("geçti" tek başına yeterli sayılmaz).
- **Stack-bağımsızlık:** `scan_cmd={project_type, which:'e2e'}` → profil `e2e_by_project_type` (web/desktop→
  playwright, api/cli/library→null=skip, mobile→detox). Playwright ön-adımı yalnız node-* stack'te.
- **Dikkat çeken davranışlar:**
  - **4 katmanlı skip:** has_ui false / feature-toggle off / install-scaffold fail / unsupported stack → hepsi
    `phase-16-skipped`+complete (fail değil). "unsupported" artık görünür bilgi (FROZEN-GOAL #14).
  - `--headed` → gerçek tarayıcı; `webServer` bloğuna profil dev komutu girer (E2E server'ı oto-başlatır, sarı
    kalmasın).
  - `has_ui` yalnız **pozitif** sinyal ("web" terimi çıkarıldı — library/API spec'lerinde "web browsers" geçiyordu).
- **Anahtar dosyalar:** `phase-registry.ts:467-481`, `index.ts:6654-6783` (Playwright kurulum),
  `orchestrator-system.md:210-212` (HARD RULE), `assets/profiles/node-npm.json`.

## Faz 17 — Sızma Testi (Pentest) · mechanical · zorunlu

**Amaç.** Kayıt tipi `mechanical` olsa da mekanik runner **koşmaz** — `index.ts` `if (next===17)` özel dalı
`runPhase17Pentest`'i çağırır. Tasarım niyeti: çalışan localhost'a **aktif DAST** (katana route keşfi + nuclei
zafiyet taraması). **ANCAK (YZLLM 2026-06-22)** otomatik pentest **çıkarıldı** — otomatik pipeline'da çok ağırdı
(katana/nuclei + dev-server + headed Chromium = makine ısınması). Bugün **`runPhase17Pentest` bir NO-OP'tur:**
"pentest artık 🛡️ Güvenlik Taraması butonuyla manuel koşar" der ve `{status:'complete', partial:false}` döner.

- **Kapı & denetim:** `phase-17-complete`; pentest bulguları gate'i **düşürmez** (faz her zaman complete).
  Son faz olduğundan sonraki-faz yeşil sinyali gelmez → `emitPhaseChanged(17,17,'complete')` elle verir.
- **Model & eskalasyon:** no-op; manuel DAST saf araç-orkestrasyonudur (katana+nuclei spawn), LLM yok.
  Manuel butonda `ensureSecurityTools` nuclei/katana/semgrep'i **kurar** (yoksa görünür hata, sessiz-fallback yok).
- **Stack-bağımsızlık:** `skip_unless='has_web_target'` (HTTP sunan her proje — web VEYA api; CLI/library/ml
  atlanır). Manuel DAST hedef portu profilden türetir + yaygın fallback (5173/3000/8080…).
- **Dikkat çeken davranışlar (manuel DAST motoru):**
  - **fail-closed hedef:** `isLocalhostTarget` (127/8 + ::1; octal/hex/`localhost.evil.com` → RED); üretim/uzak
    host **asla** taranmaz.
  - **Non-destructive:** nuclei `-exclude-tags intrusive,dos,fuzz` + rate-limit; katana yıkıcı yolları
    (logout/delete/purge) hem crawl'da hem nuclei'de eler.
  - **Sessiz-fallback yasak:** nuclei yoksa görünür hata+dur; katana yoksa "yalnız kök tarandı" notu.
  - Hang/orphan koruması: `spawnCapped` detached process-group + timeout → `killProcessTree`.
  - **Manuel onay KATI:** `pendingDast` üçlü eşleşme (set + askqId + "Başlat") → onay-baypası imkânsız;
    auto-answer bu onayı otomatikleyemez.
  - win32 → görünür "desteklenmiyor" (yalnız macOS+Linux).
- **Anahtar dosyalar:** `phase-registry.ts:482-499`, `index.ts:4731-4751` (Faz 17 özel dal), `dast-runner.ts`,
  `index.ts:5475-5530` (manuel DAST).

---

## Ek: Faz 0 — Hata Ayıklama (Debug Triage) · codegen · standalone

Pipeline dışında bir **iç araçtır** (kullanıcı doğrudan girmez). Bir gate hatası veya bug takibinde tetiklenir:
Read/Grep/Bash ile **araştırır (D1)** → kök nedeni + çözüm seçeneklerini raporlar; sonra **çözüm uygular (D2)**.
Non-destructive fix sınırı (büyük refactor için onay bekler). Çözüm alanına göre fix Faz 5/8'e köprülenir
(`fix_checkpoint_ref`). Şablon: `assets/templates/phase-00-debug.md`; registry: `phase-registry.ts:77-90`.

## Kesişen sistemler (tüm fazlara uygulanır)

- **Kapı-autofix mahkemesi:** her gate-fail'de bağımsız müfettiş (`inspectGateFinding`) bulgunun gerçek mi
  (proceed), yanlış-pozitif mi (suppress), insana mı (escalate) olduğuna **bağlayıcı** karar verir; ardından
  `runGateAutofix` fazın içinde düzeltir + yeniden doğrular; faz ≥9 ise regresyon guard.
- **Eskalasyon merdiveni:** ucuzdan başla, çözülmezse model/efor tırman (`escalatedModelEffort`); saf
  etiketleme/ortam faultu gibi "model gücüyle çözülmeyen" fail'ler tırmandırılmaz.
- **Sağlayıcı bağımsızlığı:** CLI (abonelik) ↔ API/SDK ↔ z.ai (GLM); rol bazlı `backendForRole`; sessiz
  fallback yasak (CLI'de `claude` yoksa görünür hata).
- **Doğrulama katmanı / sahte-yeşil yasağı:** bütünlük çapası (Faz 8), mutasyon probu + düşman-test,
  echo-stub tespiti (Faz 12), dürüstlük notları (Faz 16), fail-closed boş-sonuç (Faz 9/13), profil-null
  güvenlik nötr sayılmaz (Faz 13).
- **Stack profilleri:** tüm mekanik komutlar `assets/profiles/<stack>.json`'dan; `npm`/`Next` hiçbir yere
  hardcode edilmez; anahtar yoksa görünür skip.

---

*Bu doküman koddan üretilmiştir; pipeline davranışı değiştiğinde tazelenmelidir. Kaynak referansları
`orchestrator/src/phase-registry.ts` (`PHASE_SPECS`) ve ilgili `phase-*.ts` / `base/*` / `assets/*`.*
