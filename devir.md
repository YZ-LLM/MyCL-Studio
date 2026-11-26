# Devir notu — harness kaçış denetimi (2026-11-26)

> Bu dosya geçicidir. Devri okuyup işi devraldıktan sonra **sil ve silmeyi commit'le**
> (`git rm devir.md`). `main`'e birleşmemeli.

## Nerede duruyoruz

- Dal: `fix/harness-kacis-yollari` — PR: https://github.com/YZ-LLM/MyCL-Studio/pull/1
- Son kod commit'i: `a38502e`. CI `check` adımı yeşil; `tauri-compile` (macOS + Linux) son
  bakıldığında sürüyordu → **önce sonucuna bak**.
- Çalışma kuralları: kökteki `CLAUDE.md` (14 katı kural + `npm run check`). Ayrıntılı gerekçe:
  `CHANGELOG.md` → `## 2026-11-26`.

## Sorulan soru

Ümit'in endişesi: model söyleneni **gözden kaçırabilir** ya da o anki akıl yürütmesiyle
**tersini mantıklı bulup** harness'tan çıkabilir. MyCL bu açıdan incelendi.
(Eski `my-claude-lang` reposu kapsam dışı; doğru repo bu.)

## Bu dalda yapılanlar

1. **Süreç içi kayıt tanığı** — `orchestrator/src/audit-ledger.ts` (yeni).
   Açık: `refreshAuditAnchor` iterasyon başında öneki çapalıyor; hüküm ise
   `eventsSince(iteration_started_at)` ile o iterasyonun satırlarından çıkıyor → o satırlar
   çapanın dışında. Kanıt: `test/audit-ledger.test.ts` → "ASIL AÇIK".
   Çözüm: `appendAudit` yazdığı her satırın özetini bellekte tutar; `emitPipelineEndSummary`
   (`index.ts`) defteri okumadan önce ve sonra `verifyLedger` çağırır; sapma → `auditTampered` → FAIL.
   `accepted-findings.jsonl` "additions" kipinde (satır silmek serbest).
2. **Ajan talimat yüzeyi yazmaya kapalı** — proje kökünde `CLAUDE.md`, `CLAUDE.local.md`,
   `.mcp.json`, `.claude/`. CLI: `agent-sandbox.ts` (`denyWrite` + `permissions.deny`).
   API: `tool-handlers.ts` (`isAgentInstructionPath`) + `bash-guard.ts` desenleri. Okuma açık.
3. **Eski boşluk** — politika "off" + ultracode/overlay yokken `sandboxSettingsArgs` `[]`
   dönüyordu; ".mycl yazmaya kapalı" ayarı hiç gönderilmiyordu. Artık her zaman gönderilir.
4. Mahkeme (Sonnet) koşturuldu; Y1, Y2, O1, O2, O3, O5 düzeltildi. Kalan düşük bulgular aşağıda.

## Doğrulanmadı — ilk yapılacak iş

Bu değişiklik Linux'ta, `claude` kurulu olmayan bir ortamda yazıldı. Gerçek ortamda dene:

- Yeni `denyWrite` girdileri gerçek `claude` + macOS Seatbelt altında çalışıyor mu? Özellikle
  **henüz var olmayan** `CLAUDE.md` / `.mcp.json` için: yazma reddediliyor mu, yer tutucu boş
  dosya oluşuyor mu, boş `.mcp.json` MCP yüklemesini bozuyor mu?
- `Edit(<mutlak yol>)` kuralları bu dosyalarda etkili mi (mevcut `.mycl` kurallarıyla aynı biçim)?
- Bir iterasyonu baştan sona koştur: iş sonunda **yanlış** "kayıt bütünlüğü doğrulanamadı"
  çıkıyor mu? Çıkarsa `orchestrator` log'unda `süreç içi kayıt tanığı` satırına bak.

KATI #13 geçerli: hedef projeyi sen koşturma; MyCL koştursun, sen kanıtına bak.

## Ümit'ten karar bekleyen iki iş (başlanmadı)

1. **Proje komutlarını işletim sistemi hapsine almak.** `base/mechanical-runner.ts` (`execp`),
   dev sunucu ve API yolundaki `handleBash` hapis dışında, kullanıcı yetkisiyle koşuyor. Kayıt
   sahteciliği artık yakalanıyor ama `~/.mycl` altındaki diğer dosyalar (ör. `directives.md` —
   her orkestratör prompt'una enjekte edilir) o komutlara açık.
   Risk: ev dizinine yazan araçlar (Gradle, Cargo, Playwright tarayıcıları) kırılabilir; iç içe
   Seatbelt (Chromium) sorunu olabilir. Öneri: ayrı PR, dar kapsam (yalnız proje `.mycl` +
   `~/.mycl` yazma reddi, gerisi serbest), Mac'te denenerek.
2. **Kapı ölçütünün gevşetilmesini göstermek.** Ajan test/lint komutunun tanımını değiştirirse
   (`"test": "exit 0"`, lint ayarını boşaltma) bunu gösteren bir şey yok. Engel yapmak, test
   altyapısını ilk kez kuran meşru iterasyonda yanlış alarm üretir. Öneri: hükmü değiştirmeyen
   görünür uyarı ("bu iterasyonda test komutunun tanımı değişti: eski → yeni"). KATI #1:
   dosya adları profildeki `manifest_files`'tan gelmeli, hardcode değil.

## Bilinen sınırlar (README'de yazılı)

- Tanık süreçle doğar; MyCL yeniden başlayınca sıfırlanır. Taban, o dosyaya ilk yazımda ölçülür.
- Tanık yalnız iş bitiminde sorulur; faz içi ara kontroller defteri doğrulamadan okur.
- Çalışırken `audit.log` elle düzenlenirse ya da aynı proje iki pencerede açıksa "yabancı satır".
- Yalnız proje kökü korunur; alt dizinlerdeki `CLAUDE.md` kapsam dışı.
- API yolunda ve hapis kapalıyken talimat yüzeyi koruması yalnız yazma araçları + regex
  (dolaylı komutla aşılır).

## Mahkemenin açık bıraktığı düşük bulgular

- D2: `ledgers` haritası süreç boyu temizlenmiyor; ilk `appendAudit` tüm defteri okuyup özetliyor
  (çok büyük defterde gecikme).
- D3: `isAgentInstructionPath` gerçek yola değil göreli ada bakıyor (sembolik bağ ile aşılır;
  `.mycl` için de aynı eski sınır).
- Paralel modül işçileri (`module-parallel/worker.ts`) kendi worktree defterine yazıyor; o
  defterler hiç doğrulanmıyor.

## Yerel ortam notu

`npm run check` bu dalda tek kırmızı verebilir: `test/mycl-source-gap.test.ts` — yalnız **root**
olarak koşulduğunda ("yazılamayan yol" yazılabiliyor). Normal kullanıcıda ve CI'da yeşil.
