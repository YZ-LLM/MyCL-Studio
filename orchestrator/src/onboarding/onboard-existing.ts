// onboard-existing — "Proje Aç": var olan (yabancı) bir projeyi MyCL'e entegre etme (onboarding).
//
// NON-DESTRUCTIVE GARANTİ (çapraz-aile Sonnet 4.6 mahkemesi): bu modül YALNIZ `.mycl/` altına yazar;
// yabancı projenin HİÇBİR kaynak dosyasını DEĞİŞTİRMEZ. Kaynak-değiştiren MyCL standartları (test/
// responsive/güvenlik/parmak-izi/hata-kataloğu route'ları) onboarding'de UYGULANMAZ → GAP-RAPORU olarak
// yüzeye çıkar; kullanıcı onayıyla normal gate'li iterasyonda (Faz 1→17) yapılır. Tüm adımlar fail-soft +
// GÖRÜNÜR (KATI #4 — sessiz-skip yok).
//
// Akış: derin anla (snapshot + bağımlılık-merkezi + git-arka-plan + dil/framework) → `.mycl/project-map.json`
//       kalıcılaştır → living-docs (features/tech-doc) → gap-raporu → `.mycl/onboarding-report.md` →
//       chat özeti → state.onboarded_at damgala (idempotent: re-open'da yeniden tam-tarama yapılmaz).

import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import type { State } from "../types.js";
import type { MyclConfig } from "../config.js";
import { emitChatMessage } from "../ipc.js";
import { log } from "../logger.js";
import { save } from "../state.js";
import { buildProjectMap, type ProjectMap } from "./project-map.js";
import { buildProjectFacts, type ProjectFacts } from "../project-facts.js";
import { bootstrapLivingDocs } from "../living-docs.js";

const PROJECT_MAP_REL = join(".mycl", "project-map.json");
const ONBOARD_REPORT_REL = join(".mycl", "onboarding-report.md");

/** Bir MyCL standardı ve onboarding'de NEDEN uygulanmadığı (kaynak-değiştiren → gap). */
interface GapItem {
  standard: string;
  /** Ön-değerlendirme (heuristik VEYA "iterasyonda doğrulanır"). Kesin iddia DEĞİL. */
  status: string;
  /** Bu eksiği hangi MyCL fazı çözer. */
  phase: string;
  /** Uygulanırsa yabancı kaynağın nesine dokunulur (risk şeffaflığı). */
  touches: string;
}

/** Deterministik tarih damgası (YYYY-AA-GG). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Test altyapısı VAR mı? Ucuz + güvenilir heuristik (yalnız dosya/dizin varlığı; içerik okumaz).
 * Bilinen test runner config'i veya test dizini → true. Yanlış-pozitif düşük; yine de raporda
 * "ön-değerlendirme" diye işaretlenir (kesin kontrol Faz 8/14'te).
 */
async function hasTestInfra(root: string): Promise<boolean> {
  const signals = [
    "vitest.config.ts", "vitest.config.js", "jest.config.ts", "jest.config.js",
    "jest.config.mjs", "playwright.config.ts", "playwright.config.js",
  ];
  for (const s of signals) {
    try { await fs.access(join(root, s)); return true; } catch { /* yok */ }
  }
  for (const d of ["test", "tests", "__tests__"]) {
    try {
      const st = await fs.stat(join(root, d));
      if (st.isDirectory()) return true;
    } catch { /* yok */ }
  }
  return false;
}

/**
 * MyCL standartlarına karşı GAP listesi. Kaynak-değiştiren her standart "eksik" olarak listelenir,
 * ASLA otomatik uygulanmaz. Yalnız test-altyapısı ucuz heuristikle ön-değerlendirilir; gerisi
 * "iterasyonda doğrulanır" (verify-before-claim — yanlış-pozitif iddia etme).
 */
export async function buildGapReport(root: string): Promise<GapItem[]> {
  const testInfra = await hasTestInfra(root);
  return [
    {
      standard: "Test / TDD",
      status: testInfra
        ? "ön-değerlendirme: test altyapısı VAR (kapsam Faz 8/14'te ölçülür)"
        : "ön-değerlendirme: test altyapısı görünmüyor",
      phase: "Faz 8 / 14",
      touches: "test dosyaları + (gerekirse) üretim kodu eklenir",
    },
    {
      standard: "Responsive + karanlık/aydınlık mod",
      status: "iterasyonda doğrulanır",
      phase: "Faz 5 / 6",
      touches: "tema/CSS + bileşenler (mevcut tema ezilebilir → dikkat)",
    },
    {
      standard: "Güvenlik baseline (CSP / secret / SAST)",
      status: "iterasyonda salt-okuma taranır (bulgular rapora girer)",
      phase: "Faz 13",
      touches: "tarama salt-okuma; düzeltme başlık/config + kaynak (onayla)",
    },
    {
      standard: "Dijital parmak-izi + giriş-doğrulama (step-up)",
      status: "iterasyonda doğrulanır",
      phase: "Faz 5 / güvenlik",
      touches: "auth middleware + yeni DB tablo + e-posta doğrulama akışı",
    },
    {
      standard: "Hata-kataloğu route/UI (/api/errors, ErrorBoundary)",
      status: "iterasyonda doğrulanır (DB ilk iterasyonda Faz 0'da kurulur)",
      phase: "Faz 5",
      touches: "API route + ErrorBoundary + 'Hata Kodları' sayfası",
    },
    {
      standard: "App-içi '?' kullanım kılavuzu",
      status: "iterasyonda doğrulanır",
      phase: "Faz 17",
      touches: "kılavuz sayfası + public/ ekran-görüntüsü varlıkları",
    },
  ];
}

function renderReport(opts: {
  projectName: string;
  facts: ProjectFacts | null;
  map: ProjectMap | null;
  docsStatus: string;
  gaps: GapItem[];
}): string {
  const { projectName, facts, map, docsStatus, gaps } = opts;
  const central =
    map && map.available && map.central.length > 0
      ? map.central.map((c) => `  - \`${c.file}\` — ${c.importedBy} modül tarafından import ediliyor`).join("\n")
      : "  - (bağımlılık-merkezi analizi bu proje/dil için sınırlı)";
  const gapRows = gaps
    .map((g) => `| ${g.standard} | ${g.status} | ${g.phase} | ${g.touches} |`)
    .join("\n");

  return `# MyCL Onboarding Raporu — ${projectName}

> Üretim: ${today()} · Köken: **yabancı proje (MyCL'e entegre edildi)**
> MyCL bu projenin KAYNAĞINA DOKUNMADI — yalnız \`.mycl/\` altına yazıldı.

## 1. Proje Hakimiyeti (MyCL ne anladı)

- **Dil:** ${facts?.language ?? "bilinmiyor"}${facts?.hasTsconfig ? " (tsconfig var)" : ""}
- **Framework:** ${facts?.framework ?? "bilinmiyor"}
- **Paket yöneticisi:** ${facts?.packageManager ?? "bilinmiyor"}
- **Dosya sayısı (bağımlılık grafiği):** ${map?.available ? map.fileCount : "—"}
- **En merkezi modüller (önce buraya bak, dokunursan etkisi geniş):**
${central}
- **Arka plan (README + son commit yönü, deterministik):**
${map?.background ? map.background.split("\n").map((l) => `  > ${l}`).join("\n") : "  > (README/git geçmişi yok → arka plan türetilemedi)"}

## 2. Kurulan MyCL Dosyaları (\`.mycl/\` — non-destructive)

- \`.mycl/state.json\`, \`.mycl/SCHEMA.md\` — MyCL durum/şema
- \`.mycl/project-map.json\` — bu taramanın kalıcı haritası
- \`.mycl/features.md\` + \`.mycl/tech-doc.md\` — ${docsStatus}
- \`.mycl/onboarding-report.md\` — bu rapor

## 3. MyCL Standartlarına Göre Eksikler (GAP — OTOMATİK UYGULANMADI)

> Aşağıdakiler **kaynak-değiştiren** standartlar. MyCL bunları onboarding'de **uygulamaz** (projeni bozmamak
> için). Her biri **senin onayınla** normal gate'li iterasyonda (Faz 1→17) yapılır. Durum sütunu bir
> **ön-değerlendirmedir** — kesin kontrol ilgili fazda olur.

| Standart | Durum (ön-değerlendirme) | Hangi faz çözer | Uygulanırsa neye dokunur |
|---|---|---|---|
${gapRows}

## 4. Sıradaki Adım

Bir geliştirme/iyileştirme yaz → proje artık birinci-sınıf MyCL projesi; normal pipeline (Faz 1→17)
çalışır. Yukarıdaki eksiklerden istediğini tek tek söyle; MyCL onaylı + gate'li olarak ekler.
`;
}

/**
 * Yabancı projeyi MyCL'e entegre et. handleOpenProject 'foreign' sınıfında + integrate bayrağıyla çağırır.
 * Idempotent: state.onboarded_at set ise no-op. Fail-soft + GÖRÜNÜR (her adım yan-yarar; ana akışı bloklamaz).
 */
export async function runOnboarding(state: State, config: MyclConfig): Promise<void> {
  const root = state.project_root;
  if (state.onboarded_at) {
    log.info("onboarding", "zaten onboard edilmiş — atlanıyor", { onboarded_at: state.onboarded_at });
    return;
  }
  const projectName = basename(root.replace(/\/+$/, "")) || "proje";
  emitChatMessage(
    "system",
    `📂 **Proje entegrasyonu başladı — ${projectName}**\nYabancı proje anlaşılıyor, MyCL dosyaları (\`.mycl/\`) kuruluyor. Mevcut KAYNAĞINA DOKUNULMAZ; eksikler rapor olarak çıkar.`,
  );

  // 1. DERİN ANLAMA (hepsi salt-okuma, fail-soft).
  const facts = await buildProjectFacts(root).catch((e: unknown) => {
    log.warn("onboarding", "buildProjectFacts başarısız", e);
    return null;
  });
  const map = await buildProjectMap(root).catch((e: unknown) => {
    log.warn("onboarding", "buildProjectMap başarısız", e);
    return null;
  });

  // 2. project-map.json kalıcılaştır (.mycl/ — re-open'da yeniden hesaplanmasın).
  if (map) {
    await fs
      .writeFile(join(root, PROJECT_MAP_REL), JSON.stringify(map, null, 2) + "\n", "utf-8")
      .catch((e: unknown) => log.warn("onboarding", "project-map.json yazılamadı", e));
  }

  // 3. Living-docs (features.md + tech-doc.md). API modunda görünür-atlanır (KATI #4 — living-docs.ts içinde).
  //    Not: handleOpenProject onboarding yolunda arka-plan bootstrapLivingDocs çağrısını ATLAR (yarış yok).
  let docsStatus = "üretildi";
  try {
    await bootstrapLivingDocs(state, config);
  } catch (e) {
    log.warn("onboarding", "bootstrapLivingDocs başarısız", e);
    docsStatus = "üretilemedi (görünür uyarı verildi)";
  }
  // features.md gerçekten yazıldı mı? (API modunda no-op → kullanıcıya dürüst durum)
  try {
    await fs.access(join(root, ".mycl", "features.md"));
  } catch {
    docsStatus = "bu sağlayıcı modunda atlandı (CLI/abonelik VEYA z.ai gerektirir)";
  }

  // 4. GAP-RAPORU (kaynak-değiştiren standartlar — UYGULAMA YOK).
  const gaps = await buildGapReport(root);

  // 5. onboarding-report.md yaz (.mycl/).
  const report = renderReport({ projectName, facts, map, docsStatus, gaps });
  await fs
    .writeFile(join(root, ONBOARD_REPORT_REL), report, "utf-8")
    .catch((e: unknown) => log.warn("onboarding", "onboarding-report.md yazılamadı", e));

  // 6. Durumu damgala (idempotent) + persist.
  state.onboarded_at = Date.now();
  if (state.origin == null) state.origin = "foreign";
  await save(state).catch((e: unknown) => log.warn("onboarding", "state kaydedilemedi", e));

  // 7. Chat özeti — kısa, dürüst, non-destructive vurgulu.
  const centralTop =
    map && map.available && map.central[0] ? ` En merkezi modül: \`${map.central[0].file}\`.` : "";
  emitChatMessage(
    "system",
    `✅ **${projectName} entegre edildi.** ${map?.available ? map.fileCount + " dosya analiz edildi." : "Yapı tarandı."}${centralTop}\n` +
      `MyCL meta dosyaları \`.mycl/\` altına kuruldu; **kaynağına dokunulmadı**. ` +
      `Eksikler (test/güvenlik/responsive vb.) \`.mycl/onboarding-report.md\`'de — otomatik uygulanmadı. ` +
      `Bir geliştirme yaz, normal pipeline'dan onaylı+gate'li geçer.`,
  );
  emitChatMessage("system", "📄 Onboarding raporu: `.mycl/onboarding-report.md`");
}
