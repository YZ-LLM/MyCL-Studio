# prototypes/ — golden prototip önbelleği (git'te, public)

MyCL bir iterasyonu tamamladığında o projeyi buraya kaydeder. Ne kaydedildiği koşunun
sonucuna göre DEĞİŞİR:

- **Tam yeşil koşu** (tüm gate'ler PASS): projenin **TAMAMI** kaydedilir — feature/business
  kodu DAHİL (`app/`, `components/`, `lib/`, `backend/`, testler). Meta'da `full: true`.
- **Tamamlanmış ama yeşil olmayan koşu**: yalnız baseline iskele kaydedilir
  (config + giriş dosyaları + `public/**`; feature/business kodu HARİÇ). Meta'da `full: false`.

Yarım kalan koşu (iterasyon sonuna ulaşmamış) ve deliverable üretmemiş proje hiç kaydedilmez.

```
prototypes/<tam-stack>/            # ör. node-npm_typescript_react/
prototypes/<tam-stack>.meta.json   # stack, tarih, dosya sayısı, full, modül listesi
```

`<tam-stack>` = base stack + spec'ten dil/framework (deterministik parmak izi). Yeni bir proje
aynı stack'te ise, codegen BAŞLAMADAN bu prototip projeye kopyalanır → sıfırdan değil,
doğrulanmış iskele üzerine geliştirilir (hızlı + sağlam başlangıç).

**Neden git'te (public):** taze bir clone'da hazır prototipler gelsin → her makinede hızlı
başlangıç. Tam yeşil koşuda içerik projenin tamamıdır; depoya sır girmez (`.env`, `.env.*`,
`secrets.json` repo `.gitignore`'unda).

Kod: [orchestrator/src/prototype-cache.ts](../orchestrator/src/prototype-cache.ts)
(`snapshotPrototype` yazar, `applyPrototype` okur). Test/izole koşu için `MYCL_PROTOTYPES_DIR`
env override'ı vardır.
