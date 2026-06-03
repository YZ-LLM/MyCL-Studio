// base/production-schema-cli-backend — production-schema fazlarının (Faz 3/4/7) CLI
// (Claude Code aboneliği) karşılığı. SDK ProductionSchemaBaseController ile birebir
// davranır: custom tool (write_X/approval) yerine text-JSON blokları kullanır, ama
// `writeInput`'u AYNI `artifactRenderer` ile markdown'a çevirip AYNI dosyaya yazar
// (parite — faz controller'ları `outcome.writeInput`'u değişmeden okur).
//
// Akış: ajan {kind:"write",<şema alanları>} yazar → MyCL render+yaz+sha256+audit →
// resume "approval iste" → ajan {kind:"approval","pitch_en"} → askq Approve/Revise/
// Cancel → approve: approved; cancel: cancelled; revise: resume "yeni write yaz".
//
// Custom tool yok (text-JSON) + dosyayı MyCL yazar → ajana Write izni VERİLMEZ
// (sadece Read/Grep/Glob/Bash araştırma). Abonelik (cli-session API key enjekte etmez).

import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAIN_AGENT_LANGUAGE_RULE } from "../agent-language.js";
import { appendAudit } from "../audit.js";
import { extractKindBlock } from "../cli-json.js";
import { runClaudeCliSession } from "../cli-session.js";
import { isClaudeAvailable } from "../codegen/cli-backend.js";
import { backendForRole } from "../config.js";
import { localizeOptionLabels, t } from "../i18n.js";
import { emitAskq, emitChatMessage, emitClaudeStream, emitError } from "../ipc.js";
import { log } from "../logger.js";
import { translate } from "../translator.js";
import {
  ProductionSchemaBaseController,
  type ProductionBackend,
  type ProductionOutcome,
  type ProductionRunOpts,
} from "./production-schema-controller.js";

const ABORT_SENTINEL = Symbol("production-cli-aborted");
const MAX_TURNS = 14; // write + approval + birkaç revize turu

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

/** Faz controller'larının verdiği write-tool şemasından CLI çıktı talimatı üret. */
function buildOutputInstruction(opts: ProductionRunOpts): string {
  const writeTool = opts.tools.find((tt) => tt.name === opts.production.write_tool_name);
  const schema = writeTool?.input_schema ?? {};
  return `

---

## ÇIKTI FORMATI — CLI modu (tool YOK, text-JSON)

Bu modda \`${opts.production.write_tool_name}\`/\`${opts.production.approval_tool_name}\` TOOL'LARI YOKTUR.
Gerekirse Read/Grep/Glob/Bash ile araştır (DOSYAYA YAZMA — dosyayı MyCL yazar). Adımlar:

1) Çıktıyı TEK bir JSON bloğu olarak yaz: \`{"kind":"write", ...alanlar}\`. Alanlar AYNEN şu
   JSON Schema'ya uymalı (kind hariç):
   ${JSON.stringify(schema)}
2) "Kaydedildi" onayını aldıktan SONRA: \`{"kind":"approval","pitch_en":"2-3 cümle İngilizce özet"}\` yaz.
3) Kullanıcı revizyon isterse güncellenmiş yeni bir \`{"kind":"write",...}\` yaz.

KURALLAR: CEVABININ TAMAMI tek bir JSON bloğu olmalı — blok DIŞINDA düz metin YAZMA (ne öncesinde
ne sonrasında); geçerli JSON (çift tırnak, trailing comma yok).`;
}

interface PendingAskq {
  options_en: string[];
  options_tr: string[];
}

export class ProductionSchemaCliBackend implements ProductionBackend {
  private pendingResolver: ((selected_tr: string) => void) | null = null;
  private pendingRejecter: ((reason: unknown) => void) | null = null;
  private currentAskqId: string | null = null;
  private pendingAskq: PendingAskq | null = null;
  private aborted = false;
  private lastArtifactPath: string | null = null;
  private lastArtifactHash: string | null = null;
  private lastWriteInput: Record<string, unknown> | null = null;

  constructor(private readonly opts: ProductionRunOpts) {}

  submitAskqAnswer(askqId: string, selected_tr: string): void {
    if (!this.pendingAskq || this.currentAskqId !== askqId) {
      emitError("stale askq answer", { askqId });
      return;
    }
    const resolver = this.pendingResolver;
    this.pendingResolver = null;
    this.pendingRejecter = null;
    if (resolver) resolver(selected_tr);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    log.info(this.opts.tag, "cli abort requested");
    const rejecter = this.pendingRejecter;
    this.pendingResolver = null;
    this.pendingRejecter = null;
    this.pendingAskq = null;
    this.currentAskqId = null;
    if (rejecter) rejecter(ABORT_SENTINEL);
  }

  async run(): Promise<ProductionOutcome> {
    const { opts } = this;
    const sessionId = randomUUID();
    const systemPrompt = opts.systemPrompt + buildOutputInstruction(opts);
    const writeTool = opts.tools.find((tt) => tt.name === opts.production.write_tool_name);
    const required = (writeTool?.input_schema?.required as string[] | undefined) ?? [];
    const effort = opts.config.claude_code_flags.effort;

    emitClaudeStream({
      sub: "init",
      text: `cli-${opts.tag}`,
      model: opts.modelId,
      cwd: opts.state.project_root,
    });
    emitChatMessage("system", `🤖 Claude Code CLI (abonelik) — ${opts.tag} (model: ${opts.modelId})…`);

    let resume = false;
    let userMessage = opts.initialUserMessage;
    let nudged = false;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (this.aborted) return { kind: "aborted" };

      const res = await runClaudeCliSession({
        sessionId,
        resume,
        userMessage,
        systemPrompt: resume ? undefined : systemPrompt,
        modelId: opts.modelId,
        cwd: opts.state.project_root,
        allowedTools: ["Read", "Grep", "Glob", "Bash"],
        disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
        effort,
        onText: (text) => emitClaudeStream({ sub: "text", text }),
        observer: (tu) =>
          emitClaudeStream({ sub: "tool_use", tool_name: tu.name, tool_input: tu.input }),
      });
      if (this.aborted) return { kind: "aborted" };
      if (res.usage) emitClaudeStream({ sub: "token_usage", usage: res.usage });
      if (!res.ok) {
        return { kind: "failed", reason: `claude CLI failed: ${res.error ?? "bilinmeyen"}` };
      }

      const block = extractKindBlock(res.text, ["write", "approval"]);
      if (block === null) {
        if (nudged) {
          return { kind: "failed", reason: `${opts.tag}: geçerli write/approval JSON üretilemedi` };
        }
        nudged = true;
        resume = true;
        userMessage =
          "Geçerli JSON blok yoktu. SADECE tek bir {\"kind\":\"write\",...} ya da {\"kind\":\"approval\",...} bloğu yaz.";
        continue;
      }
      nudged = false;

      if (block.kind === "write") {
        const writeInput: Record<string, unknown> = { ...block };
        delete writeInput.kind;
        const missing = required.filter((f) => !(f in writeInput));
        if (missing.length > 0) {
          resume = true;
          userMessage = `Eksik zorunlu alan(lar): ${missing.join(", ")}. Tüm alanlarla yeniden {"kind":"write",...} yaz.`;
          continue;
        }
        let md: string;
        try {
          md = opts.artifactRenderer(writeInput);
        } catch (err) {
          resume = true;
          userMessage = `Çıktı render edilemedi (${String(err).slice(0, 120)}). Alanları şemaya uygun düzelt + tekrar {"kind":"write",...} yaz.`;
          continue;
        }
        const hash = sha256(md);
        const path = join(opts.state.project_root, opts.production.output_artifact_path);
        await writeFile(path, md, { encoding: "utf-8" });
        this.lastArtifactPath = path;
        this.lastArtifactHash = hash;
        this.lastWriteInput = writeInput;
        log.info(opts.tag, "cli artifact written", { path, sha256: hash, len: md.length });
        if (opts.production.artifact_audit_event) {
          const detail = opts.artifactAuditDetail
            ? opts.artifactAuditDetail(writeInput, hash)
            : `sha256=${hash}`;
          await appendAudit(opts.state.project_root, {
            ts: Date.now(),
            phase: opts.phaseId,
            event: opts.production.artifact_audit_event,
            caller: "mycl-bridge",
            detail,
          });
        }
        emitChatMessage("system", `📄 ${path} (sha256: ${hash.slice(0, 12)}…)`);
        resume = true;
        userMessage = `Kaydedildi: ${path}. Şimdi SADECE {"kind":"approval","pitch_en":"..."} bloğu yaz (kullanıcıdan onay iste).`;
        continue;
      }

      // block.kind === "approval"
      const pitch_en = String(block.pitch_en ?? block.pitch ?? block.summary ?? "");
      let decision: "approve" | "revise" | "cancel";
      try {
        decision = await this.askApproval(pitch_en);
      } catch (err) {
        if (err === ABORT_SENTINEL) return { kind: "aborted" };
        return { kind: "failed", reason: `approval flow failed: ${String(err)}` };
      }
      if (decision === "approve") {
        if (!this.lastArtifactPath || !this.lastArtifactHash || !this.lastWriteInput) {
          // Onay write'tan önce geldi — yazmaya yönlendir.
          resume = true;
          userMessage = "Henüz {\"kind\":\"write\"} ile içerik kaydedilmedi. Önce onu yaz.";
          continue;
        }
        return {
          kind: "approved",
          artifact_path: this.lastArtifactPath,
          artifact_hash: this.lastArtifactHash,
          writeInput: this.lastWriteInput,
        };
      }
      if (decision === "cancel") return { kind: "cancelled" };
      // revise
      resume = true;
      userMessage = "Kullanıcı revizyon istedi. Güncellenmiş bir {\"kind\":\"write\",...} bloğu yaz.";
    }

    return { kind: "failed", reason: `${opts.tag}: MAX_TURNS (${MAX_TURNS}) aşıldı` };
  }

  /** SDK base'iyle birebir: Approve/Revise/Cancel askq (i18n + translate). */
  private async askApproval(pitch_en: string): Promise<"approve" | "revise" | "cancel"> {
    const suffixKey = this.opts.production.approval_suffix_key ?? "generic";
    const options_en = ["Approve", "Revise", "Cancel"];
    const options_tr = localizeOptionLabels(options_en, "tr");
    const r = await translate(this.opts.config, pitch_en, "en-to-tr");
    const question_tr = r.text + t(`askq.approval_suffix.${suffixKey}`, "tr");

    const askqId = randomUUID();
    this.currentAskqId = askqId;
    this.pendingAskq = { options_en, options_tr };
    emitAskq({ id: askqId, question: question_tr, options: options_tr, allow_other: false });

    const selected_tr = await new Promise<string>((resolve, reject) => {
      this.pendingResolver = resolve;
      this.pendingRejecter = reject;
    });
    this.pendingAskq = null;
    this.currentAskqId = null;

    const trIdx = options_tr.indexOf(selected_tr);
    const selected_en = trIdx >= 0 ? options_en[trIdx] : selected_tr;
    emitChatMessage("system", `→ Claude'a: ${selected_en}`);
    if (/^approve$/i.test(selected_en.trim())) return "approve";
    if (/^cancel$/i.test(selected_en.trim())) return "cancel";
    return "revise";
  }
}

/**
 * Aktif config'e göre production-schema backend'i seç (Faz 3/4/7 factory).
 * main rolü "cli" + claude var → CLI; "cli" ama claude yok → görünür fail (sessiz
 * API YOK); aksi halde SDK. Faz controller'ları dönüş tipini (ProductionBackend) bilir.
 */
export function createProductionSchemaBackend(opts: ProductionRunOpts): ProductionBackend {
  // v15.11: main ajan yalnız İngilizce yazar (genel kural, CLI+SDK). Çevirmen hariç.
  opts = { ...opts, systemPrompt: opts.systemPrompt + MAIN_AGENT_LANGUAGE_RULE };
  const wantCli = backendForRole(opts.config, "main") === "cli";
  if (wantCli) {
    if (isClaudeAvailable()) {
      log.info(opts.tag, "using CLI production-schema backend (abonelik)");
      return new ProductionSchemaCliBackend(opts);
    }
    const m =
      `Main 'Claude Code Aboneliği' (CLI) seçili ama \`claude\` bulunamadı — ` +
      `Faz ${opts.phaseId} (${opts.tag}) çalıştırılamadı. API'ye SESSİZCE DÜŞÜLMEDİ. ` +
      `\`claude\` kur ya da Ayarlar → Modeller'den main'i 'API' yap.`;
    log.warn(opts.tag, "CLI seçili ama claude yok — görünür fail");
    return {
      run: async (): Promise<ProductionOutcome> => {
        emitError(`${opts.tag}: claude bulunamadı (CLI backend)`, m);
        emitChatMessage("system", `🔴 ${m}`);
        return { kind: "failed", reason: m };
      },
      abort: () => {},
      submitAskqAnswer: () => {},
    };
  }
  return new ProductionSchemaBaseController(opts);
}
