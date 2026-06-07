# MyCL × 4-Talk Birleşimi — Pragmatik Enjeksiyon Raporu

**2026-06-07.** Ümit talebi: "4 talk'ı birleştir; o birleşimi hem MERCEK hem YÖNTEM olarak kullan; MyCL'i baştan
sona tara; rapor üret." Bu rapor 3-ajanlı çok-mercek tarama (Missions'ın çok-ajanlı yöntemi) + ardından bağımsız
kör-nokta merceğiyle adversarial filtre (validation-contract/validator disiplini) ile üretildi. Dört talk: harness
engineering (Tejas Kumar/IBM), turbogrep/semantik-getirme (Kuba Rogut/Turbopuffer), BDD-ADR-PRD (Michal Cichra/Safe
Intelligence), Missions çok-ajanlı mimari (Luke Alvoeiro/Factory).

## 1. BİRLEŞİM (4 talk → tek tez)
**Model zekâyı verir; HARNESS disiplini verir — disiplin = bağımsız adversarial ajanlarca doğrulanan, ZORLANABİLİR
+ ÇALIŞTIRILABİLİR şartnameler; seri yürütme + yapılandırılmış handoff; agentic-arama (RAG değil) → doğruluk
uzun-koşuda BİRİKİR (compounding correctness).**

- **Harness (Tejas):** kaldıraç modelde değil sarmalayıcıda → MyCL zaten bir harness.
- **Cichra:** kararlar/spec'ler ÇALIŞTIRILABİLİR + ZORLANABİLİR olmalı ("ölçemiyorsan zorlayamazsın"; ADR=nasıl-zorlanıyor,
  PRD=neden+hâlâ-geçerli-mi, BDD=çalıştırılabilir-şartname).
- **Missions:** orchestrator/worker/validator + validation-contract-ÖNCE-kod + adversarial validator (kodu önce görmez)
  + SERİ yürütme (paralel yazılımda çöker; salt-okunur işler paralel) + yapılandırılmış handoff + role-göre-model +
  prompt-driven + mission-control.
- **turbogrep:** agentic-arama > pre-built embedding (Claude Code RAG'i bıraktı → MyCL embedding EKLEMEMELİ).

## 2. MyCL bu merceğin neresinde (dürüst)
**MyCL zaten ~Missions-şeklinde** (3 bağımsız ajan da doğruladı):
- **Orchestrator:** `orchestrator-agent/*` (decide_action, §14 proaktif-risk, recall).
- **Worker:** Faz 0-17 makinesi (`phase-registry` + `base/*` controller'lar), SERİ koşuyor → Missions'ın seri-yürütme
  tezini DOĞRULUYOR. CREATE/FIX/DEVELOPMENT akışları.
- **Validator çekirdeği (3 parça):** `pre-commit-lens` (adversarial, pre-hoc, kör-nokta) + `harness-verdict` (scrutiny:
  audit→PASS/PARTIAL/FAIL) + `verify-feature` (user-testing: Playwright/computer-use E2E).
- **Çok-ajan fan-out:** `design-fanout` (Faz 5 panel) + `hypothesis-investigation` (Faz 0) + Agent Teams köprüsü +
  deterministik Workflow.
- **Mission-control:** task-queue + TokenTimelinePanel + PhaseSidebar.
- **turbogrep duruşu DOĞRU:** relevance = keyword+LLM (embedding yok) — bilinçli + onaylanan karar.

**KÖR-NOKTA FİLTRESİ (yöntem dogfood'u):** Tarama ajanlarının "kritik boşluk" dediklerinin ÇOĞU bu oturumda ZATEN
düzeltildi — IPC race (B6 busy-guard), try/finally (B1 runController), false-green (B3 harness-verdict phase===13),
phase-9 event uyumu (B3), dev-server orphan (B1). Bunlar "yapılacak" SAYILMADI (yeşil + push'lu). İki ajan ayrıca
kapsam-genişleten öneriler uydurdu → §5'te REDDEDİLDİ.

## 3. GERÇEK boşluklar — pragmatik enjeksiyon (filtrelenmiş, öncelik sırası)

### ① KEYSTONE — Çalıştırılabilir validation-contract: AC→test izlenebilirliği
Cichra (çalıştırılabilir spec) + Missions (contract-önce-kod) tam burada birleşir; pre-commit lens validator'ı
tohumladı. **Bugün:** Faz 4 AC'leri (`assets/schemas/phase-04-spec.json`, `^AC[0-9]+$`) koddan önce yazılıyor AMA
Faz 8 gate (`assets/gates/phase-08.ts`) yalnız `tdd-green ≥ eşik` sayıyor — AC-başına test EŞLEMESİ yok, audit
event'leri AC-id taşımıyor. **Enjeksiyon:** test event'leri AC-id ile etiketlenir + gate "her AC'ye ≥1 yeşil test"
doğrular + verify-feature spec AC'lerini E2E'ye eşler. Mevcut AC-id şeması + gate hazır → genişletme.

### ② Validator rolünü TUTARLI çerçevele
3 validator parçası var ama Missions'ın "scrutiny vs user-testing, milestone sınırında, kodu önce görmez"
disiplinine göre tek kavram altında adlandırılmamış. Çoğu FRAMING + ①'in AC bağı; az kod.

### ③ Yapılandırılmış handoff zenginleştirme
Audit bugün yalnız event (phase-complete bool). Missions handoff = yapılan/yapılmayan/exit-kod/keşfedilen-sorun.
Faz-sonu audit detail'ine küçük yapılandırılmış özet → uzun-koşu + resume zemini. Mütevazı.

### ④ (DÜŞÜK) PRD-relevance / feature-sunset
living-docs/features.md var ama "X özellik N iterasyon kullanılmadı → hâlâ gerekli mi?" sorusu yok (Cichra PRD'nin
"silinmeli mi" boyutu). Şimdilik işaret.

## 4. Dogfood notu (yöntem = birleşim)
Birleşim YÖNTEM olarak kullanıldı: (a) çok-ajanlı tarama (3 paralel Explore = Missions delegation/broadcast),
(b) adversarial sentez — ajan çıktısı körü körüne toplanmadı; kör-nokta merceğiyle stale/scope-creep ELENDİ
(validation-contract disiplini: "iddiayı kanıtla, uydurma"). Reddedilenler §5'te GÖRÜNÜR (sessiz değil).

## 5. REDDEDİLENLER (anti-scope-creep — kör-nokta merceği)
- **Çok-sağlayıcı (OpenAI/Gemini) validator** — Missions "farklı sağlayıcı bias kırar" der AMA MyCL bilinçli
  claude-merkezli (API + Claude Code aboneliği); 3. sağlayıcı abonelik modeline + paritesine ters. REDDET.
- **Ağır ArtifactEvent versiyonlama (.mycl/artifacts.jsonl)** — git zaten artifact geçmişi tutuyor; ikinci sistem
  gereksiz (turbogrep dersi: ikinci index kurma). REDDET.
- **Confidence-threshold auto-answer revizyonu** — over-engineering; mevcut yeterli. REDDET.
- **Tam "Missions modu" yeniden-yazımı** — deterministik seri-faz makinesi seri-yürütme tezini ZATEN karşılıyor;
  rewrite değil keystone (①) gerek. REDDET.
- Ajanların re-surface ettiği AUDIT bulguları — ZATEN düzeltildi (§2).

## 6. Öncelik
①(keystone AC→test) → ②(validator framing) → ③(handoff) → ④(düşük). ① tek başına en yüksek kaldıraç:
"ölçemiyorsan zorlayamazsın"ın MyCL'deki somut karşılığı + uzun-koşu doğruluk-birikiminin çekirdeği.
