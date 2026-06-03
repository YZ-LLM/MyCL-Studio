# MyCL Studio — Değişiklik Günlüğü

> AI (Claude) tarafından yapılan işlerin zaman damgalı kaydı. Yeni → eski.
> Amaç: eski kararları/kuralları unutup bozmamak; bir işi değiştirmeden önce buraya bak.
> Eski bir işi değiştirmek/silmek gerekiyorsa ÖNCE Ümit'e sor (kural, 2026-06-03).

## 2026-06-03

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
