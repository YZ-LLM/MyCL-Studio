// task-queue/intake — kullanıcının çok-problemli mesajını AYRI, bağımsız işlere
// böler + öneme göre önceliklendirir (YZLLM 2026-06-14: "birden fazla sorun
// yazıldığında sorunları anla + öneme göre sırala + iş kuyruğuna ekle; tek bir
// iş ise bile kuyruğa").
//
// Salt SINIFLANDIRMA (kod araştırması YOK) → araçsız tek-atış; hem CLI/abonelik
// hem API modunda çalışır (feedback_api_support). LLM karar verir — regex YOK:
// "X'i düzelt, bir de Y bozuk" düz-metinden ayrıştırılamaz (anlama gerekir).
// Fail-soft: bölme başarısızsa ham metin TEK iş olarak eklenir (iş asla kaybolmaz).

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { resolveLlmClient } from "../claude-api.js";
import { extractKindBlock } from "../cli-json.js";
import { runClaudeCli } from "../cli-run.js";
import { backendForRole, orchestratorModelId, type MyclConfig } from "../config.js";
import { emitChatMessage, emitClaudeStream } from "../ipc.js";
import { log } from "../logger.js";
import { selectEffortForTask } from "../model-catalog.js";
import { READ_ONLY_DISALLOWED_TOOLS } from "../tool-policy.js";
import { appendTask, readTasks, taskStatus } from "./store.js";
import type { TaskQueueItem } from "./types.js";

export interface SplitTask {
  /** İşin net, kendi başına anlaşılır Türkçe ifadesi (Faz 1'e tek başına girer). */
  text: string;
  /** Öncelik: 1=en yüksek (en önemli/bloklayıcı). */
  priority: number;
  /**
   * YZLLM 2026-06-15: bu iş kuyrukta ZATEN BEKLEYEN bir işle anlamca AYNIYSA true (LLM semantik
   * dedup — kelime-örtüşme parafrazı kaçırıyordu). intakeAndEnqueue true olanları EKLEMEZ.
   */
  already_queued?: boolean;
}

const SPLIT_PROMPT = `Sen MyCL'in iş-ayrıştırma yardımcısısın. Kullanıcı tek mesajda BİR ya da BİRDEN FAZLA sorun/talep yazmış olabilir. Görevin:

1. Mesajı AYRI AYRI ele alınabilecek, BAĞIMSIZ işlere böl. İki şey ancak gerçekten bağımsız ele alınabiliyorsa ayrı iştir; aynı sorunun parçaları (örn. "kayıt olunca hem e-posta gitmiyor hem de yönlendirme yanlış" gibi tek kök-nedene bağlı olabilenler) TEK iştir. TEK bir şey İNŞA ETME talebi de TEK iştir — bir uygulamanın/projenin MODÜLLERİ, KATMANLARI, SAYFALARI ayrı iş DEĞİL: "admin panel: yönetici girişi (auth) + ürün CRUD" → TEK iş; "login + dashboard + ayarlar" → TEK iş; "frontend + backend" → TEK iş (birlikte tek ürün; biri diğerini kapsar/korur). Bölme YALNIZCA gerçekten ayrı, bağımsız talepler için (örn. "şu bug'ı düzelt VE ayrıca yeni bir X özelliği ekle"). CANLI BUG 2026-06-17: "auth + ürün CRUD tek MVP" 2 işe bölündü → ürün modülü düştü, sadece auth kaldı.
2. Her işe ÖNEM sırasına göre öncelik ata: 1 = en yüksek (bloklayıcı/kritik/veri-kaybı), sonra 2, 3, … Eşit önemde olanları mesajdaki sıraya göre numaralandır.
3. Her işi KISA ve ÖZ yaz — YZLLM kuralı: EN FAZLA 2 KISA cümle. Uzun paragraf, gereksiz tekrar, "beklenen vs gözlenen" açıklaması YASAK. Yalnız hangi iş + nerede; tek başına anlaşılır olsun yeter.
4. Tek bir iş varsa TEK elemanlı dizi döndür (bölme uğruna bölme yok).
5. MÜKERRER ÖNLEME (YZLLM): "Kuyrukta zaten bekleyen işler" sana aşağıda verilecek. Çıkardığın bir iş, bekleyen işlerden biriyle ANLAMCA AYNIYSA (FARKLI kelimelerle yazılmış olsa bile — örn. "kullanıcılar sayfasında sadece kendi hesabım görünüyor" ≈ "kullanıcı listesinde diğer kullanıcılar görünmüyor") o işe \`"already_queued":true\` koy. Gerçekten YENİ/farklı işlere \`"already_queued":false\`. (Sil-me, sadece işaretle.) Bekleyen iş yoksa hepsi false.
6. Mesaj salt onay/teşekkür/gözlem ise (örn. "tamam", "çözülmüş görünüyor", "teşekkürler") ve içinde yeni bir iş YOKSA → boş tasks dizisi döndür (\`"tasks":[]\`). Onay metnini iş YAPMA.

ÇIKTI — yalnızca TEK bir JSON bloğu, etrafında başka metin YOK:
\`\`\`json
{"kind":"task_split","tasks":[{"text":"<işin en fazla 2 cümlelik özü>","priority":1,"already_queued":false}]}
\`\`\`

Kurallar: Geçerli JSON (çift tırnak, trailing comma YOK). Açıklama/yorum yazma. Yeni iş yoksa \`"tasks":[]\` geçerlidir.`;

export function buildSplitPrompt(): string {
  return SPLIT_PROMPT;
}

const SPLIT_USER = (rawText: string, pendingTexts: string[]): string => {
  const pendingBlock =
    pendingTexts.length > 0
      ? `Kuyrukta ZATEN BEKLEYEN işler (anlamca aynısını already_queued:true yap):\n` +
        pendingTexts.map((t, i) => `${i + 1}. ${t}`).join("\n")
      : `(Kuyrukta bekleyen iş yok.)`;
  return `Kullanıcı mesajı:\n"""\n${rawText}\n"""\n\n${pendingBlock}\n\nİşleri ayrıştırıp task_split JSON bloğunu şimdi üret.`;
};

/** {kind:task_split} bloğunu parse + doğrula. Geçersiz/boşsa null (fail-soft caller). */
export function parseSplitBlock(raw: string): SplitTask[] | null {
  const block = extractKindBlock(raw, ["task_split"]) as
    | { tasks?: unknown }
    | null;
  if (!block || !Array.isArray(block.tasks)) return null;
  // LLM KASTEN boş döndürdü (salt onay/gözlem mesajı ya da hepsi zaten kuyrukta) → geçerli [].
  // Bunu "parse hatası"ndan (null) ayır ki caller ham-metni tek-iş yapıp duplicate üretmesin.
  if (block.tasks.length === 0) return [];
  const out: SplitTask[] = [];
  for (const t of block.tasks) {
    const rec = t as { text?: unknown; priority?: unknown; already_queued?: unknown };
    if (typeof rec.text === "string" && rec.text.trim()) {
      const priority =
        typeof rec.priority === "number" && rec.priority >= 1
          ? Math.floor(rec.priority)
          : out.length + 1;
      out.push({ text: rec.text.trim(), priority, already_queued: rec.already_queued === true });
    }
  }
  // Girdi boş-değildi ama hiç geçerli iş çıkmadı → malformed (null = fail-soft fallback).
  return out.length > 0 ? out : null;
}

/** Backend'e göre (cli/api) bölme ajanını çalıştır; çıktıyı parse et. Hata → null. */
async function splitTasks(
  config: MyclConfig,
  projectRoot: string,
  rawText: string,
  pendingTexts: string[],
): Promise<SplitTask[] | null> {
  const model = orchestratorModelId(config.selected_models);
  const useCli = backendForRole(config, "orchestrator") === "cli";
  let text: string;
  if (useCli) {
    emitClaudeStream({ sub: "init", text: "cli-task-split", model, cwd: projectRoot });
    const res = await runClaudeCli({
      systemPrompt: SPLIT_PROMPT,
      userMessage: SPLIT_USER(rawText, pendingTexts),
      modelId: model,
      cwd: projectRoot,
      // Salt sınıflandırma — yazma/alt-ajan yasak (kod okumaya da gerek yok).
      disallowedTools: READ_ONLY_DISALLOWED_TOOLS,
      effort: selectEffortForTask("verification", config.claude_code_flags.effort),
      onText: (t) => emitClaudeStream({ sub: "text", text: t }),
      timeoutMs: 120_000,
    });
    if (!res.ok) return null;
    text = res.text;
  } else {
    // z.ai Aşama 2 ⑤b: Sağlayıcı=Z.AI ise iş-bölme turu GLM'e (z.ai key+endpoint) gider; claude'da AYNEN korunur.
    const { client, model: apiModel } = resolveLlmClient(
      config,
      "orchestrator",
      config.api_keys.orchestrator ?? config.api_keys.main,
      model,
      { timeoutMs: 60_000 },
    );
    const response = await client.messages.create({
      model: apiModel,
      max_tokens: 2048,
      system: SPLIT_PROMPT,
      messages: [{ role: "user", content: SPLIT_USER(rawText, pendingTexts) }],
    });
    text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return parseSplitBlock(text);
}

/**
 * Ham kullanıcı talebini işlere böl + önceliklendir + kuyruğa ekle (source=auto,
 * status=pending). HER ZAMAN ≥1 iş ekler (tek iş bile kuyruğa). Eklenen task'ları
 * öncelik-bağımsız ekleme sırasında döndürür (drain öncelik sırasıyla işler).
 */
export async function intakeAndEnqueue(
  config: MyclConfig,
  projectRoot: string,
  rawText: string,
): Promise<TaskQueueItem[]> {
  const clean = rawText.trim();
  if (!clean) return []; // boş/yalnız-boşluk talep → iş yok (boş-text task üretme)
  // Bekleyen işleri ÖNCE oku — hem LLM'e semantik-dedup için ver (parafrazı yakalar) hem aşağıdaki
  // kelime-örtüşme backstop'una. (YZLLM 2026-06-15: "zaten listede varsa ekleme".)
  const acceptedTexts: string[] = (
    await readTasks(projectRoot).catch((e) => {
      // readTasks ENOENT'i [] yapar → bu catch yalnız GERÇEK hatayı (bozuk kuyruk dosyası) maskeler.
      // Sessiz [] = yinelenen-iş kontrolü DEVRE DIŞI → aynı iş tekrar eklenebilir (sessiz-fallback denetimi).
      log.error("task-intake", "iş kuyruğu okunamadı — yinelenen-iş kontrolü bu turda devre dışı (gerçek hata)", { error: String(e) });
      emitChatMessage("system", "⚠️ İş kuyruğu okunamadı (dosya bozuk olabilir) — yinelenen-iş kontrolü bu sefer atlandı; aynı iş iki kez eklenebilir.");
      return [];
    })
  )
    .filter((it) => taskStatus(it) === "pending")
    .map((it) => it.text);
  const split = await splitTasks(config, projectRoot, clean, acceptedTexts).catch((e: unknown) => {
    log.warn("task-intake", "bölme başarısız (fail-soft → tek iş)", e);
    return null;
  });
  const droppedTexts: string[] = [];
  let tasks: SplitTask[];
  if (split === null) {
    // Bölme BAŞARISIZ (LLM/API hatası ya da parse). feedback_no_silent_fallback:
    // sessizce tek-işe düşme — GÖRÜNÜR not + ham talebi tek iş yap (iş kaybolmaz).
    emitChatMessage(
      "system",
      "⚠️ Çok-problem ayrıştırması yapılamadı — talebi TEK iş olarak işliyorum. Birden fazla sorun yazdıysan ayrı ayrı göndermen daha güvenli.",
    );
    tasks = [{ text: clean, priority: 1 }];
  } else {
    // split=[] → salt onay/gözlem mesajı ya da hepsi zaten kuyrukta (yeni iş yok).
    // LLM'in already_queued işaretlediklerini (semantik dedup) çıkar; düşenleri nota yaz.
    for (const t of split) if (t.already_queued) droppedTexts.push(t.text);
    tasks = split.filter((t) => !t.already_queued);
  }
  const now = Date.now();
  const items: TaskQueueItem[] = [];
  let skipped = droppedTexts.length;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    if (acceptedTexts.some((e) => textSimilarity(e, t.text) > 0.7)) {
      skipped++;
      droppedTexts.push(t.text);
      continue;
    }
    const item: TaskQueueItem = {
      id: randomUUID(),
      ts: now + i, // eşit öncelikte stabil FIFO için monoton ts
      text: t.text,
      priority: t.priority,
      status: "pending",
      source: "auto",
    };
    await appendTask(projectRoot, item);
    items.push(item);
    acceptedTexts.push(t.text);
  }
  if (skipped > 0) {
    // Düşen işlerin metnini de göster (denetim bulgusu, YZLLM 2026-06-15): kullanıcı yanlış
    // eleme olduğunu fark edebilsin — sessiz iş kaybı olmasın.
    const list = droppedTexts.map((d) => `"${d}"`).join(", ");
    emitChatMessage(
      "system",
      `ℹ️ ${skipped} iş zaten kuyrukta vardı (aynı iş) — yeniden eklenmedi: ${list}`,
    );
  }
  return items;
}

/** Kelimeye böl (küçük harf, kısa/noktalama at) — benzerlik için. */
function textWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-zçğıöşü0-9 ]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}
/**
 * Jaccard benzerliği (ortak kelime / BİRLEŞİM) — 0..1. Önceki örtüşme-katsayısı paydası
 * Math.min(küme) idi; o, kısa metin uzun metnin alt-kümesiyse ~1.0 verip GERÇEKTEN-AYRI
 * kısa işi yanlışlıkla siliyordu (denetim bulgusu, YZLLM 2026-06-15): örn. "Sipariş oluşturma
 * 500" vs "Sipariş güncelleme 500" → eski 0.80 (silinir), Jaccard 0.67 (eşik 0.7'nin altı →
 * korunur). Birleşim paydası bu alt-küme tuzağını kapatır; yalnız neredeyse-aynı metinler elenir.
 */
function textSimilarity(a: string, b: string): number {
  const wa = textWords(a);
  const wb = textWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union === 0 ? 0 : inter / union;
}
