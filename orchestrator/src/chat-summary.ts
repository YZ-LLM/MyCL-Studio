// chat-summary — 🧾 Özet butonu (YZLLM 2026-07-19: "sağ tarafa özet butonu koy. chat ekranındaki
// konuşmaları özetlesin bana. önemli yerleri atlamadan.")
//
// Salt okuma yan görev: proje sohbet geçmişini (history.log chat_message kayıtları) ORKESTRATÖR
// rolüyle Türkçe özetler ve sonucu chat'e basar. Dil hattına uygun: main'e HİÇBİR ŞEY gitmez —
// orkestratör kullanıcıyla Türkçe konuşan roldür (dd38a27 sınırı ihlal edilmez). plan-mode çift
// backend deseni (CLI abonelik → runClaudeCli araçsız; API → tek atış). ASLA throw etmez; her
// hata görünür mesaj (KATI #4).

import Anthropic from "@anthropic-ai/sdk";
import { resolveLlmClient } from "./claude-api.js";
import { runClaudeCli } from "./cli-run.js";
import { backendForRole, type MyclConfig } from "./config.js";
import { loadMessages, type HistoryEntry } from "./history-loader.js";
import { emitChatMessage, withClaudeStreamBanner } from "./ipc.js";
import { log } from "./logger.js";
import { selectEffortForTask, selectModelForTask } from "./model-catalog.js";
import { ZERO_TOOLS_DISALLOWED } from "./tool-policy.js";

export interface SummaryChatEntry {
  role: string;
  text: string;
  ts: number;
}

/** SAF: history event'lerinden sohbet satırlarını çıkar (chat_message dışı + boş metin elenir). */
export function extractChatEntries(events: HistoryEntry[]): SummaryChatEntry[] {
  const out: SummaryChatEntry[] = [];
  for (const e of events) {
    if (e.kind !== "chat_message") continue;
    const d = e.data as { role?: unknown; text?: unknown } | null;
    if (!d || typeof d.role !== "string" || typeof d.text !== "string") continue;
    const text = d.text.trim();
    if (text === "") continue;
    out.push({ role: d.role, text, ts: e.ts });
  }
  return out;
}

/** Özet girdisi karakter bütçesi — EN YENİ mesajlar korunur (eskiler kırpılır, görünür işaretlenir). */
export const SUMMARY_CHAR_BUDGET = 120_000;

/** SAF: bütçeye sığan EN YENİ mesajları seç (kuyruktan biriktir). truncated → başa not düşülür. */
export function selectEntriesForSummary(
  entries: SummaryChatEntry[],
  budget = SUMMARY_CHAR_BUDGET,
): { selected: SummaryChatEntry[]; truncated: boolean } {
  let total = 0;
  let start = entries.length;
  while (start > 0 && total + entries[start - 1]!.text.length + 24 <= budget) {
    total += entries[start - 1]!.text.length + 24;
    start--;
  }
  return { selected: entries.slice(start), truncated: start > 0 };
}

const SUMMARY_SYSTEM = `Sen MyCL'in sohbet özetleyicisisin. Sana bir yazılım geliştirme oturumunun sohbet dökümü verilecek (kullanıcı + MyCL sistem/asistan mesajları, Türkçe).

Görev: dökümü SADE TÜRKÇE, madde işaretli olarak özetle. ÖNEMLİ HİÇBİR ŞEYİ ATLAMA. Şu başlıkları kullan (boş kalan başlığı yazma):
## Yapılan işler
## Alınan kararlar
## Hatalar ve çözümleri
## Bekleyen işler ve açık sorular
## Önemli uyarılar

Kurallar: tekrarları birleştir; kronolojiyi koru; dosya adı/komut gibi teknik jetonlar aynen kalsın; yorum/övgü ekleme; YALNIZ özeti yaz (başka hiçbir şey yazma).`;

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** SAF: sistem + kullanıcı prompt'unu kur. */
export function buildChatSummaryPrompt(
  entries: SummaryChatEntry[],
  truncated: boolean,
): { system: string; user: string } {
  const lines = entries.map((e) => `[${fmtClock(e.ts)} ${e.role}] ${e.text}`);
  const head = truncated
    ? "(NOT: döküm uzundu — yalnız EN YENİ kısım verildi; özetin başında bunu tek cümleyle belirt.)\n\n"
    : "";
  return { system: SUMMARY_SYSTEM, user: `${head}${lines.join("\n")}` };
}

let _running = false;

/**
 * IMPURE: özet koşumu. Geçmişi okur, orkestratör rolüyle özetler, sonucu chat'e basar.
 * Tek uçuş (buton spam'i ikinci koşum başlatmaz); ASLA throw etmez.
 */
export async function runChatSummary(config: MyclConfig, projectRoot: string): Promise<void> {
  if (_running) {
    emitChatMessage("system", "🧾 Özet zaten hazırlanıyor — bitince chat'e düşecek.");
    return;
  }
  _running = true;
  try {
    const result = await loadMessages(projectRoot, { since_ts: 0, limit: 400 }).catch(() => null);
    const entries = extractChatEntries(result?.events ?? []);
    if (entries.length === 0) {
      emitChatMessage("system", "🧾 Özetlenecek konuşma bulunamadı (geçmiş boş).");
      return;
    }
    const { selected, truncated } = selectEntriesForSummary(entries);
    const { system, user } = buildChatSummaryPrompt(selected, truncated);
    emitChatMessage("system", `🧾 Sohbet özeti hazırlanıyor (${selected.length} mesaj)…`);
    const model = selectModelForTask("orchestration", config.selected_models.model_tiers).modelId;
    const useCli = backendForRole(config, "orchestrator") === "cli";
    let text: string;
    if (useCli) {
      const res = await withClaudeStreamBanner({ text: "cli-ozet", model, cwd: projectRoot }, () =>
        runClaudeCli({
          systemPrompt: system,
          userMessage: user,
          modelId: model,
          cwd: projectRoot,
          // Girdi zaten prompt'ta — araçsız (proje okuması gereksiz; hızlı + sızıntı yüzeyi yok).
          disallowedTools: ZERO_TOOLS_DISALLOWED,
          effort: selectEffortForTask("orchestration", config.claude_code_flags.effort),
          // onText BİLEREK yok: Türkçe özet akışı "Main Ajan" başlıklı panele düşerdi (kullanıcı
          // dün bunu dil ihlali olarak gördü). Banner meşguliyeti gösterir; sonuç chat'e düşer.
          timeoutMs: 180_000,
        }),
      );
      if (!res.ok) {
        emitChatMessage("system", `🧾 Özet hazırlanamadı: ${String(res.error).slice(0, 140)}`);
        return;
      }
      text = res.text;
    } else {
      const { client, model: apiModel } = resolveLlmClient(
        config,
        "orchestrator",
        config.api_keys.orchestrator ?? config.api_keys.main,
        model,
        { timeoutMs: 120_000 },
      );
      const response = await client.messages.create({
        model: apiModel,
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content: user }],
      });
      text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    }
    const clean = text.trim();
    if (!clean) {
      emitChatMessage("system", "🧾 Özet hazırlanamadı (boş yanıt) — tekrar dene.");
      return;
    }
    emitChatMessage("assistant", `🧾 **Sohbet özeti**\n\n${clean}`);
  } catch (err) {
    log.warn("chat-summary", "özet koşumu hata", { error: String(err) });
    emitChatMessage("system", `🧾 Özet hazırlanamadı: ${String(err).slice(0, 140)}`);
  } finally {
    _running = false;
  }
}
