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
import { coerceToSchema, extractKindBlock, schemaToSkeleton } from "../cli-json.js";
import { runClaudeCliSession, type CliSessionTurnOpts } from "../cli-session.js";
import { autoBackendPair } from "../cli-rate-limit.js";
import { isApiAccountError, resolveCliProvider } from "../claude-api.js";
import { isClaudeAvailable } from "../codegen/cli-backend.js";
import { backendForRole, isAutoMode } from "../config.js";
import { localizeOptionLabels, t } from "../i18n.js";
import { emitAskq, emitChatMessage, emitClaudeStream, emitError } from "../ipc.js";
import { autoAnswerPick } from "../auto-answer.js";
import { runComprehensionGate } from "../spec-comprehension.js";
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
  const schema = (writeTool?.input_schema as Record<string, unknown> | undefined) ?? {};
  // v15.12: somut örnek — iç içe dizileri GÖSTERİR (ajan düzyazıya çevirmesin).
  const example = JSON.stringify({ kind: "write", ...(schemaToSkeleton(schema) as Record<string, unknown>) });
  return `

---

## OUTPUT FORMAT — CLI mode (no tools, text-JSON)

In this mode the \`${opts.production.write_tool_name}\`/\`${opts.production.approval_tool_name}\` TOOLS DO NOT EXIST.
Investigate with Read/Grep/Glob/Bash if needed (DO NOT write to disk — MyCL writes the file). Steps:

1) Write the output as a SINGLE JSON block: \`{"kind":"write", ...fields}\`. Fields must match this
   JSON Schema EXACTLY (excluding kind):
   ${JSON.stringify(schema)}
   EXACT shape — copy this structure (nested arrays of objects must be JSON arrays, NOT prose):
   ${example}
2) AFTER you receive the "Saved" confirmation: write \`{"kind":"approval","pitch_en":"2-3 sentence English summary"}\`.
3) If the user requests a revision, write an updated new \`{"kind":"write",...}\` block.

RULES: Your ENTIRE answer must be a single JSON block — write NO plain text outside the block (neither
before nor after); valid JSON (double quotes, no trailing comma).`;
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
      emitError("Yanıt geçersiz (soru güncelliğini yitirmiş)", { askqId });
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
    const writeSchema = (writeTool?.input_schema as Record<string, unknown> | undefined) ?? {};
    const required = (writeSchema.required as string[] | undefined) ?? [];
    // v15.12: somut örnek (nudge + son-çare sentez için).
    const writeExample = JSON.stringify({
      kind: "write",
      ...(schemaToSkeleton(writeSchema) as Record<string, unknown>),
    });
    const effort = opts.effortOverride ?? opts.config.claude_code_flags.effort;

    emitClaudeStream({
      sub: "init",
      text: `cli-${opts.tag}`,
      model: opts.modelId,
      cwd: opts.state.project_root,
    });
    emitChatMessage("system", `🤖 Claude Code CLI (abonelik) — ${opts.tag} (model: ${opts.modelId})…`);

    let resume = false;
    let userMessage = opts.initialUserMessage;
    let noJsonNudges = 0; // JSON yok → örnekli nudge (≤2), sonra prose'tan sentez
    let writeFieldNudges = 0; // write eksik-alan → örnekli nudge (≤2), sonra coerce + devam
    // EVRENSEL z.ai fallback: Claude account/kredi/limit hatasında z.ai'ye geç + oturum sonuna kadar
    // YAPIŞKAN kal (her turda Claude'u tekrar denemek --resume'u yanlış endpoint'e gönderir). undefined → Claude.
    let zaiFallbackEnv: Record<string, string> | undefined;
    let zaiFallbackModel: string | undefined;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (this.aborted) return { kind: "aborted" };

      const baseSessionOpts: CliSessionTurnOpts = {
        sessionId,
        resume,
        userMessage,
        systemPrompt: resume ? undefined : systemPrompt,
        modelId: zaiFallbackModel ?? opts.modelId,
        cwd: opts.state.project_root,
        allowedTools: ["Read", "Grep", "Glob", "Bash"],
        disallowedTools: ["Write", "Edit", "NotebookEdit"],
        effort,
        onText: (text) => emitClaudeStream({ sub: "text", text }),
        observer: (tu) =>
          emitClaudeStream({ sub: "tool_use", tool_name: tu.name, tool_input: tu.input }),
        extraEnv: zaiFallbackEnv,
      };
      let res = await runClaudeCliSession(baseSessionOpts);
      // Claude account-error + henüz z.ai'ye düşmediysek + z.ai key varsa → AYNI turu z.ai-CLI ile tekrarla
      // (SDK runTurn:728-745'teki desenin CLI muadili). Müfettiş bu yola girmez. Yapışkan: sonraki turlar z.ai'de.
      if (!res.ok && !zaiFallbackEnv && isApiAccountError(res.error ?? "")) {
        const zai = resolveCliProvider(opts.config, "main", opts.modelId, { accountErrorFallback: true });
        if (zai.extraEnv) {
          zaiFallbackEnv = zai.extraEnv;
          zaiFallbackModel = zai.model;
          emitChatMessage(
            "system",
            `⚠️ Claude erişilemedi (kredi/limit) → z.ai (GLM \`${zai.model}\`) ile devam ediliyor.`,
          );
          res = await runClaudeCliSession({ ...baseSessionOpts, modelId: zai.model, extraEnv: zai.extraEnv });
        }
      }
      if (this.aborted) return { kind: "aborted" };
      if (res.usage) emitClaudeStream({ sub: "token_usage", usage: res.usage });
      if (!res.ok) {
        return { kind: "failed", reason: `claude CLI failed: ${res.error ?? "bilinmeyen"}` };
      }

      let block = extractKindBlock(res.text, ["write", "approval"]);
      if (block === null) {
        if (noJsonNudges < 2) {
          noJsonNudges++;
          resume = true;
          userMessage = `No valid JSON block found. Write ONLY a single JSON block (no prose). Copy this shape: ${writeExample}`;
          continue;
        }
        // v15.12: 2 nudge sonrası hâlâ JSON yok → ASLA takılma. Ajanın metnini write
        // olarak sentezle (prose = içerik) + coerce + GÖRÜNÜR uyarı + devam.
        const { coerced, defaulted } = coerceToSchema({}, writeSchema, res.text);
        block = { kind: "write", ...coerced };
        emitChatMessage(
          "system",
          `⚠️ ${opts.tag}: ajan yapılandırılmış blok üretmedi; mevcut metinle devam edildi (dolduruldu: ${defaulted.join(", ") || "—"}).`,
        );
      }

      if (block.kind === "write") {
        let writeInput: Record<string, unknown> = { ...block };
        delete writeInput.kind;
        const missing = required.filter((f) => {
          const v = writeInput[f];
          return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
        });
        if (missing.length > 0) {
          if (writeFieldNudges < 2) {
            writeFieldNudges++;
            resume = true;
            userMessage =
              `Missing required field(s): ${missing.join(", ")}. Rewrite {"kind":"write",...} with ALL fields + exact shapes ` +
              `(arrays of objects must be JSON arrays, NOT prose). Copy: ${writeExample}`;
            continue;
          }
          // v15.12: nudge sonrası hâlâ eksik → takılma yerine coerce + görünür uyarı + devam.
          const c = coerceToSchema(block, writeSchema, res.text);
          writeInput = { ...c.coerced };
          delete writeInput.kind;
          emitChatMessage(
            "system",
            `⚠️ ${opts.tag}: write bloğunda eksik alan vardı — mevcut bilgiyle dolduruldu, devam edildi (${c.defaulted.join(", ") || "—"}).`,
          );
        }
        let md: string;
        try {
          md = opts.artifactRenderer(writeInput);
        } catch (err) {
          resume = true;
          userMessage = `Output could not be rendered (${String(err).slice(0, 120)}). Fix the fields to match the schema and write {"kind":"write",...} again.`;
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
        userMessage = `Saved: ${path}. Now write ONLY a {"kind":"approval","pitch_en":"..."} block (to request user approval).`;
        continue;
      }

      // block.kind === "approval"
      const pitch_en = String(block.pitch_en ?? block.pitch ?? block.summary ?? "");
      // v15.15: onaydan ÖNCE pre-hoc kör-nokta merceği (SDK ile parite; side-effect, bloklamaz).
      if (this.lastWriteInput) {
        try {
          await this.opts.preApprovalHook?.(this.lastWriteInput);
        } catch (e) {
          log.warn(this.opts.tag, "preApprovalHook failed (non-blocking)", e);
        }
      }
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
          userMessage = "No content has been saved via {\"kind\":\"write\"} yet. Write that first.";
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
      userMessage = "The user requested a revision. Write an updated {\"kind\":\"write\",...} block.";
    }

    return { kind: "failed", reason: `${opts.tag}: MAX_TURNS (${MAX_TURNS}) aşıldı` };
  }

  /** Tek askq emit + cevabı bekle (pendingResolver). allowOther=serbest metin ("okudum anladım"). */
  private async askOnce(question_tr: string, options_tr: string[], allowOther: boolean): Promise<string> {
    // Oto-cevap (YZLLM 2026-06-15): açıksa askq'yi UI'a göstermeden ilk seçenekle yanıtla →
    // pipeline takılmaz. Önceden bu yol (Faz 4 spec / Faz 7 DB netleştirme+kavrama-kapısı)
    // autoAnswer'ı kaçırıyordu → her onayda 47 dk takılma.
    const auto = autoAnswerPick(options_tr);
    if (auto !== null) {
      emitChatMessage("system", `🤖 Otomatik cevap (otomatik onay/ilk seçenek): "${auto}"`);
      return auto;
    }
    const askqId = randomUUID();
    this.currentAskqId = askqId;
    this.pendingAskq = { options_en: options_tr, options_tr };
    emitAskq({ id: askqId, question: question_tr, options: options_tr, allow_other: allowOther });
    const sel = await new Promise<string>((resolve, reject) => {
      this.pendingResolver = resolve;
      this.pendingRejecter = reject;
    });
    this.pendingAskq = null;
    this.currentAskqId = null;
    return sel;
  }

  /** SDK base'iyle birebir: Approve/Revise/Cancel askq (i18n + translate). */
  private async askApproval(pitch_en: string): Promise<"approve" | "revise" | "cancel"> {
    // #6 deliği (YZLLM): spec'i okumadan onay YOK — CLI modunda da. Paylaşılan kapı (AC yoksa atlar).
    await runComprehensionGate(this.opts.config, this.opts.state.project_root, this.opts.phaseId, (q, o, a) =>
      this.askOnce(q, o, a),
    );
    const suffixKey = this.opts.production.approval_suffix_key ?? "generic";
    const options_en = ["Approve", "Revise", "Cancel"];
    const options_tr = localizeOptionLabels(options_en, "tr");
    const r = await translate(this.opts.config, pitch_en, "en-to-tr");
    const question_tr = r.text + t(`askq.approval_suffix.${suffixKey}`, "tr");

    // Oto-cevap (YZLLM 2026-06-15): açıksa onayı UI'a göstermeden ilk seçenekle (Onayla) ver.
    // Bu yol (Faz 4 spec / Faz 7 DB onayı) FIX-5'i kaçırıyordu → her onayda takılma.
    const auto = autoAnswerPick(options_tr);
    let selected_tr: string;
    if (auto !== null) {
      emitChatMessage("system", `🤖 Otomatik cevap (otomatik onay): "${auto}"`);
      selected_tr = auto;
    } else {
      const askqId = randomUUID();
      this.currentAskqId = askqId;
      this.pendingAskq = { options_en, options_tr };
      emitAskq({ id: askqId, question: question_tr, options: options_tr, allow_other: false });

      selected_tr = await new Promise<string>((resolve, reject) => {
        this.pendingResolver = resolve;
        this.pendingRejecter = reject;
      });
      this.pendingAskq = null;
      this.currentAskqId = null;
    }

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
  // Auto Mode: simetrik çift-yön (limit yokken CLI birincil, limitliyse API birincil);
  // birincil KALICI başarısızsa diğerine kesintisiz geçer. claude yoksa → API.
  if (isAutoMode(opts.config, "main")) {
    if (!isClaudeAvailable()) {
      emitChatMessage("system", "ℹ️ Auto Mode: `claude` bulunamadı → API kullanılıyor.");
      return new ProductionSchemaBaseController(opts);
    }
    return autoBackendPair<ProductionOutcome, ProductionBackend>(
      backendForRole(opts.config, "main"),
      () => new ProductionSchemaCliBackend(opts),
      () => new ProductionSchemaBaseController(opts),
      isApiAccountError, // kredi/yetki hatasında CLI↔API boş döngüsünü kır
    );
  }
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
        emitError(`${opts.tag}: claude bulunamadı (CLI arka ucu)`, m);
        emitChatMessage("system", `🔴 ${m}`);
        return { kind: "failed", reason: m };
      },
      abort: () => {},
      submitAskqAnswer: () => {},
    };
  }
  return new ProductionSchemaBaseController(opts);
}
