// linear-sync — Linear gate-kanıt AYNASI (SAW esinli; opt-in, tek-yönlü, fail-OPEN + LOUD).
//
// Mahkeme kararı (oybirliği): Linear "system of record" OLAMAZ — dış servis bağımlılığı
// "sessiz fallback yok" + self-contained ilkesini kırar; servis hatası tüm pipeline'ı bloklarsa
// donmuş-hedefin "asla sessizce tıkanmama"sı dış API yüzünden delinir. Bu yüzden:
//   • KAYNAK yerel: `.mycl/audit.jsonl` system-of-record'dur; Linear yalnız İSTEĞE-BAĞLI AYNA.
//   • DEFAULT KAPALI: linear_sync_enabled !== true → modül HİÇ çağrılmaz (sıfır dış istek, sıfır gürültü).
//   • Fail-OPEN ama LOUD: Linear hatası pipeline'ı ASLA bloklamaz → GÖRÜNÜR uyarı + devam
//     (sessiz değil — kullanıcı yansıma olmadığını bilir; yerel kanıt zaten yazılı).
//   • Sır env'den: `LINEAR_API_KEY` ortamdan okunur, config dosyasına YAZILMAZ → secret-gate temiz.

import type { MyclConfig } from "./config.js";
import type { HarnessVerdict } from "./harness-verdict.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import type { State } from "./types.js";

const LINEAR_API = "https://api.linear.app/graphql";
const TIMEOUT_MS = 12_000;

const ISSUE_CREATE = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { url identifier } }
}`;

/** Linear aynası gerçekten aktif mi: flag AÇIK **ve** env key var. İkisinden biri yoksa tamamen kapalı (no-op). */
export function isLinearSyncEnabled(config: MyclConfig): boolean {
  const key = process.env.LINEAR_API_KEY;
  return config.features.linear_sync_enabled === true && typeof key === "string" && key.trim() !== "";
}

/** SAF (test-edilebilir): verdict'i Linear issue açıklamasına (markdown) çevir. Yerel kanıtın aynası. */
export function buildVerdictMarkdown(state: State, verdict: HarnessVerdict): string {
  const lines = [
    `**MyCL pipeline verdict: ${verdict.verdict}**`,
    "",
    `- Intent: ${(state.intent_summary ?? "(none)").slice(0, 200)}`,
    `- Summary: ${verdict.summary}`,
  ];
  if (verdict.gateFailures.length > 0) {
    lines.push(`- Failed gates: ${verdict.gateFailures.map((g) => `Phase ${g.phase} (${g.event})`).join(", ")}`);
  }
  if (verdict.securitySkipped.length > 0) {
    lines.push(`- Security scans skipped: ${verdict.securitySkipped.join(", ")}`);
  }
  lines.push("", "_Source of record: local `.mycl/audit.jsonl`. This Linear issue is a one-way mirror._");
  return lines.join("\n");
}

/** SAF: verdict'ten kısa issue başlığı. */
export function buildVerdictTitle(state: State, verdict: HarnessVerdict): string {
  const intent = (state.intent_summary ?? "iteration").trim().slice(0, 80) || "iteration";
  return `MyCL ${verdict.verdict}: ${intent}`;
}

/** Fail-OPEN + LOUD: görünür uyarı + log; pipeline ETKİLENMEZ (yerel kanıt kaynaktır). */
function loudFail(reason: string): void {
  log.warn("linear-sync", "Linear aynası başarısız (fail-open)", { reason });
  emitChatMessage(
    "system",
    `⚠️ Linear aynası başarısız (${reason}) — pipeline ETKİLENMEDİ; yerel \`.mycl/audit.jsonl\` kanıt kaynağıdır.`,
  );
}

/**
 * Pipeline-end verdict'ini Linear'a TEK-YÖNLÜ yansıt (yeni issue). DEFAULT KAPALI → enabled değilse no-op.
 * ASLA throw etmez; her hata fail-open + LOUD (pipeline bloklanmaz). Bilinçli "yeni issue per iterasyon"
 * (yorum/issue-eşleme kapsam dışı; minimal-tam birim).
 */
export async function mirrorVerdictToLinear(
  state: State,
  config: MyclConfig,
  verdict: HarnessVerdict,
): Promise<void> {
  if (!isLinearSyncEnabled(config)) return; // OFF (default) → hiç dış istek, gürültü yok
  const teamId = config.features.linear_team_id;
  if (!teamId || teamId.trim() === "") {
    emitChatMessage(
      "system",
      "⚠️ Linear aynası açık ama `linear_team_id` ayarlı değil — yansıtılmadı (yerel audit kaynaktır).",
    );
    return;
  }
  const key = process.env.LINEAR_API_KEY as string;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(LINEAR_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({
        query: ISSUE_CREATE,
        variables: { input: { teamId, title: buildVerdictTitle(state, verdict), description: buildVerdictMarkdown(state, verdict) } },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      loudFail(`HTTP ${res.status}`);
      return;
    }
    const json = (await res.json()) as {
      errors?: unknown;
      data?: { issueCreate?: { success?: boolean; issue?: { url?: string; identifier?: string } } };
    };
    if (json.errors || !json.data?.issueCreate?.success) {
      loudFail(`API: ${JSON.stringify(json.errors ?? "unknown").slice(0, 140)}`);
      return;
    }
    const issue = json.data.issueCreate.issue;
    emitChatMessage(
      "system",
      `🔗 Gate kanıtı Linear'a yansıtıldı: ${issue?.identifier ?? ""} ${issue?.url ?? ""}`.trim(),
    );
  } catch (err) {
    // AbortError (timeout) dahil her hata fail-open.
    loudFail(String((err as Error)?.message ?? err).slice(0, 140));
  } finally {
    clearTimeout(timer);
  }
}
