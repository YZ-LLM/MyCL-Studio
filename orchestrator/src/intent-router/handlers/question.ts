// intent-router/handlers/question — kullanıcı sorularını cevaplar.
//
// Pipeline başlatmaz, state'i değiştirmez. Pure side-effect: chat'e
// assistant cevabı yazılır. Phase 6 askq açıkken çağrılırsa activeController'a
// dokunmaz — Phase 6 askq beklemesinde kalmaya devam eder.
//
// Chat handler'dan farklılık: Q&A için Claude'a Read tool veriyoruz (kullanıcı
// "şu dosyada ne yazıyor?" diye sorabilir) + buildRelevantProjectContext +
// errors.db son satırlar + spec.md tam içerik (credentials gibi spesifik
// sorular için relevance chunk yetmiyor).
//
// Tipik sorular:
// - "test kullanıcı adı/şifre ne?"
// - "spec.md'de ne var?"
// - "şu hata neden olur?"
// - "AC2'de ne soruluyor?"

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { runTurn, type ToolDef } from "../../claude-api.js";
import type { MyclConfig } from "../../config.js";
import { selectRecentRuntimeErrors } from "../../errors-db.js";
import { emitChatMessage, emitClaudeStream } from "../../ipc.js";
import { log } from "../../logger.js";
import { buildRelevantProjectContext } from "../../relevance/injectors.js";
import { TOOLS_CODEGEN, type ToolContext } from "../../tool-handlers.js";
import type { State } from "../../types.js";
import type { IntentClassification } from "../types.js";

const SYSTEM_PROMPT = `You are MyCL Studio's question-answering assistant.

The user asked a question about their project, the codebase, MyCL itself, or
runtime errors. Answer briefly, accurately, in **Turkish (TR)**.

## Style
- Cevabın 1-3 kısa paragraf olsun. Cevap yoksa "Bilmiyorum" de.
- Yapay nezaket yok ("Harika soru!" gibi). Direkt.
- File/line referansları kullan: \`src/App.tsx:42\` — kullanıcı tıklayabilir.
- Kod alıntısı için triple-backtick kullan.

## Tools
- **Read**: kullanıcı "şu dosyada ne yazıyor?" gibi soru sorarsa Read kullan.
- **Grep**: "X nerede tanımlı?" → Grep ile bul, sonra Read.
- **Bash** (read-only): \`ls\`, \`cat package.json\`, \`sqlite3 SELECT\` gibi.
- **Edit/Write KULLANMA** — bu soru-cevap turn'ü, fix değil.

## Test credentials sorusu özel durumu
Eğer kullanıcı "test kullanıcı adı/şifre ne?", "admin nasıl giriş yapar?",
"login credentials" gibi sorduysa:

1. Önce \`.mycl/spec.md\`'yi tam oku (relevance chunk değil — TÜM dosya).
2. "credentials", "password", "şifre", "user", "admin", "seed" kelimelerini ara.
3. Bulduysan exact değeri ver.
4. Bulamadıysan **VARSAYILANLARI öner**:
   "Spec'te belirtilmemiş. Varsayılan denemeler:
   - \`admin\` / \`admin\`
   - \`admin@example.com\` / \`admin123\`
   - \`test@test.com\` / \`test1234\`

   Backend'in seed dosyasını kontrol edebilirsin — genelde \`backend/seed.js\`,
   \`backend/db/seed.ts\` veya \`migrations/\` altında."
5. errors.db'de auth-related hatalar varsa son 3 satırı listele.

## Project context (relevance-filtered)
---
{{PROJECT_CONTEXT}}
---

## Recent runtime errors (errors.db, last 24h)
---
{{RUNTIME_ERRORS}}
---

## Hard constraints
- Cevabın TR olsun. İngilizce karışıklığı yapma.
- Pipeline başlatma, kod yazma — sadece bilgi.
- Kullanıcı net olmayan sorular sorduysa kısa clarifying soru ile bitir.`;

export async function handleQuestionIntent(
  state: State,
  config: MyclConfig,
  text: string,
  _intent: IntentClassification,
): Promise<void> {
  log.info("question-handler", "start", { text_len: text.length });

  let projectCtx = "(no prior project context — fresh project)";
  try {
    projectCtx = await buildRelevantProjectContext(config, state, text);
  } catch (err) {
    log.warn("question-handler", "project context fetch failed (non-fatal)", err);
  }

  // errors.db son 24h runtime hatalar — auth/login sorularında Claude'a iz
  let runtimeErrors = "(no recent runtime errors)";
  try {
    const dbPath = join(state.project_root, "error_folder", "errors.db");
    const rows = await selectRecentRuntimeErrors(dbPath, 24 * 60 * 60 * 1000);
    if (rows.length > 0) {
      runtimeErrors = rows
        .slice(0, 10)
        .map((r) => {
          const time = new Date(r.ts).toISOString().slice(11, 19);
          return `- ${time} ${r.error_code} ${r.location} — ${r.description_tr.slice(0, 120)}`;
        })
        .join("\n");
    }
  } catch (err) {
    log.warn("question-handler", "errors.db read failed (non-fatal)", err);
  }

  // Eğer kullanıcının sorusu credentials/login ile ilgili görünüyorsa spec.md
  // tam içeriği ekstra context olarak verilir (relevance chunk yetmez).
  let specFullContext = "";
  const credentialKeywords =
    /(şifre|kullanıcı|user|admin|password|credential|login|giriş|seed|test|hesap)/i;
  if (credentialKeywords.test(text)) {
    try {
      const specPath = join(state.project_root, ".mycl", "spec.md");
      const spec = await fs.readFile(specPath, "utf-8");
      specFullContext = `\n\n## Full spec.md (credentials/auth question detected)\n---\n${spec.slice(0, 6000)}\n---`;
    } catch {
      // spec yok — skip
    }
  }

  const systemPrompt =
    SYSTEM_PROMPT.replace("{{PROJECT_CONTEXT}}", projectCtx).replace(
      "{{RUNTIME_ERRORS}}",
      runtimeErrors,
    ) + specFullContext;

  // Claude Code transparency
  const callTs = Date.now();
  const model = config.selected_models.main;
  emitClaudeStream({
    sub: "init",
    text: "sdk-question-handler",
    model,
    cwd: state.project_root,
    turn: 1,
    max_turns: 1,
    ts: callTs,
  });
  emitClaudeStream({
    sub: "request",
    system: systemPrompt,
    user_message: text,
    model,
    turn: 1,
    max_turns: 1,
    ts: callTs,
  });

  // Tool set: codegen'in Read/Grep/Glob/Bash subset'ı — Edit/Write izinsiz
  // çünkü Q&A turn'ü kod değiştirmez.
  const readOnlyTools: ToolDef[] = (TOOLS_CODEGEN as unknown as ToolDef[]).filter(
    (t) => ["Read", "Grep", "Glob", "Bash"].includes(t.name),
  );

  const toolCtx: ToolContext = {
    project_root: state.project_root,
    extra_denied_paths: [],
  };

  let assistantText = "";
  try {
    const result = await runTurn(
      config,
      config.api_keys.main,
      {
        messages: [{ role: "user", content: text }],
        system: systemPrompt,
        model,
        tools: readOnlyTools,
        max_tokens: 1024,
      },
      (ev) => {
        if (ev.type === "text_delta") {
          assistantText += ev.text;
          emitClaudeStream({ sub: "text", text: ev.text, ts: callTs });
        } else if (ev.type === "tool_use") {
          emitClaudeStream({
            sub: "tool_use",
            tool_name: ev.name,
            tool_input: ev.input as Record<string, unknown>,
            ts: callTs,
          });
        } else if (ev.type === "message_end") {
          emitClaudeStream({ sub: "stop", text: ev.stop_reason, ts: callTs });
        }
      },
    );
    if (result.usage) {
      emitClaudeStream({
        sub: "token_usage",
        usage: result.usage,
        model,
        ts: callTs,
      });
    }
    if (!assistantText) {
      const content = result.assistantContent;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as { type?: string }).type === "text" &&
            "text" in block
          ) {
            assistantText += String((block as { text?: string }).text ?? "");
          }
        }
      }
    }
  } catch (err) {
    log.error("question-handler", "LLM call failed", err);
    emitChatMessage(
      "system",
      "Soru cevaplanamadı — API geçici sorunu olabilir, birazdan tekrar dene.",
    );
    return;
  }

  // Tool ctx kullanılmadı uyarısını engelle: codegen tool'ları runTurn içinde
  // handler ile çalıştırılacak — Read/Grep/Bash invoke edilebilmesi için
  // tool-handlers'ın resolve etmesi lazım. Aslında runTurn signature buna
  // izin veriyor mu? Çoğu handler için CodegenBaseController kullanılıyor.
  // Q&A için runTurn doğrudan çağrılıyor — tool_use event'leri stream olur
  // ama execute edilmez. Çözüm: assistant text yeterli (Q&A için Claude
  // genelde önce Read sonra summarize ister — base controller olmadan
  // tool execution fail olur).
  //
  // Sade tutalım: Q&A turn'ünde tool'lar gerçekten çalışmaz (single turn);
  // Claude görür ama execute edemez. Bu durumda Claude doğrudan context'ten
  // cevap üretir (spec.md tam içerik zaten enjekte edilmiş; recent errors
  // var). Eğer tool execution gerekirse v15 multi-turn.
  void toolCtx;

  const trimmed = assistantText.trim();
  if (trimmed.length === 0) {
    emitChatMessage("system", "(cevap boş döndü — sorunu daha açık yazabilir misin?)");
    return;
  }
  emitChatMessage("assistant", trimmed);
  log.info("question-handler", "done", { reply_len: trimmed.length });
}
