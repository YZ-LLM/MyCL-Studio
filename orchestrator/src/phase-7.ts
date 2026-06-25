// phase-7 — Database Design (production-schema, has_database koşullu).
//
// v15.7 (2026-05-27): Dosya header rot düzeltildi (eski "phase-8" yazıyordu).
// Phase7Controller → Phase 7 = DB tasarımı.

import { escalatedModelEffort } from "./escalation.js";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { appendAudit, appendDecision } from "./audit.js";
import { currentSpecRelPath } from "./devs-paths.js";
import type { ProductionBackend } from "./base/production-schema-controller.js";
import { createProductionSchemaBackend } from "./base/production-schema-cli-backend.js";
import type { ToolDef } from "./claude-api.js";
import type { MyclConfig } from "./config.js";
import { emitError, emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import { buildRelevantEngineeringBrief } from "./relevance/injectors.js";
import { substitute } from "./template-engine.js";
import {
  buildConversationContext,
  renderConversationSection,
} from "./conversation-context.js";
import type { PhaseDeps } from "./phase-deps.js";
import type { PhaseSpec, State } from "./types.js";

const TOOL_WRITE_DB: ToolDef = {
  name: "write_db_schema",
  description: "Persist the database schema + migration plan.",
  input_schema: {
    type: "object",
    required: ["title", "tables", "migrations"],
    properties: {
      title: { type: "string" },
      tables: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "fields"],
          properties: {
            name: { type: "string" },
            fields: {
              type: "array",
              items: {
                type: "object",
                required: ["name", "type"],
                properties: {
                  name: { type: "string" },
                  type: { type: "string" },
                  nullable: { type: "boolean" },
                  pk: { type: "boolean" },
                  fk: { type: "string" },
                },
              },
            },
            indexes: { type: "array", items: { type: "string" } },
          },
        },
      },
      migrations: {
        type: "array",
        items: {
          type: "object",
          required: ["order", "description", "sql"],
          properties: {
            order: { type: "integer", description: "Migration sırası (1, 2, 3...)." },
            description: {
              type: "string",
              description: "Kısa İngilizce açıklama (örn. 'create users table'). Dosya adında kebab-case karşılığı kullanılır.",
            },
            sql: {
              type: "string",
              description:
                "v15.7 (2026-05-27) ZORUNLU. Gerçek, çalıştırılabilir DDL/DML SQL. Şablon/sözde değil. Hedef veritabanı (Postgres/SQLite/MySQL) için VALID syntax. CREATE TABLE, ALTER, INSERT, CREATE INDEX vb. Orkestratör bu SQL'i `.mycl/migrations/NNN-<description>.sql` dosyasına yazar; Phase 8 migration apply komutu ile uygular. Down/rollback için ayrı entry; UP-only migration yeterli değilse iki entry oluştur (örn. 1: create, 2: drop_old).",
            },
          },
        },
      },
    },
  },
};

const TOOL_APPROVAL: ToolDef = {
  name: "request_db_approval",
  description: "After schema is saved, 2-3 sentence pitch + approval ask.",
  input_schema: {
    type: "object",
    required: ["pitch"],
    properties: { pitch: { type: "string" } },
  },
};

interface DbField {
  name: string;
  type: string;
  nullable?: boolean;
  pk?: boolean;
  fk?: string;
}
interface DbTable {
  name: string;
  fields: DbField[];
  indexes?: string[];
}
interface DbMigration {
  order: number;
  description: string;
  /** v15.7 (2026-05-27): Zorunlu — gerçek DDL/DML. */
  sql: string;
  /** Legacy field — bazı eski state'lerde sql_sketch olabilir. Backward compat. */
  sql_sketch?: string;
}
interface DbSchemaData {
  title: string;
  tables: DbTable[];
  migrations: DbMigration[];
}

function schemaToMarkdown(s: DbSchemaData): string {
  const tables = s.tables
    .map((t) => {
      const rows = t.fields
        .map((f) => {
          const flags: string[] = [];
          if (f.pk) flags.push("PK");
          if (f.fk) flags.push(`FK→${f.fk}`);
          if (f.nullable) flags.push("nullable");
          return `| ${f.name} | ${f.type} | ${flags.join(", ")} |`;
        })
        .join("\n");
      const idx = (t.indexes ?? []).map((i) => `- ${i}`).join("\n");
      return `### ${t.name}\n\n| Field | Type | Flags |\n|---|---|---|\n${rows}\n\n${idx ? `**Indexes:**\n${idx}\n` : ""}`;
    })
    .join("\n\n");
  const migs = s.migrations
    .sort((a, b) => a.order - b.order)
    .map((m) => {
      const sql = m.sql ?? m.sql_sketch ?? "";
      return `**${m.order}. ${m.description}**${sql ? `\n\n\`\`\`sql\n${sql}\n\`\`\`` : ""}`;
    })
    .join("\n\n");
  return `# ${s.title}

## Tables

${tables}

## Migration Plan

${migs}
`;
}

export class Phase7Controller {
  private base: ProductionBackend | null = null;
  /** Fail durumunda kullanıcıya gösterilecek mesaj için error context. */
  public lastFailReason?: string;
  public statePatch: Partial<State> = {};

  private readonly state: State;
  private readonly config: MyclConfig;
  private readonly spec: PhaseSpec;
  constructor(deps: PhaseDeps) {
    this.state = deps.state;
    this.config = deps.config;
    this.spec = deps.spec;
  }

  submitAskqAnswer(askqId: string, selected_tr: string): void {
    this.base?.submitAskqAnswer(askqId, selected_tr);
  }

  abort(): void {
    this.base?.abort();
  }

  async run(): Promise<"complete" | "fail"> {
    log.info("phase-7", "run start");

    if (!this.state.intent_summary) {
      emitError("phase-8: intent_summary missing", null);
      this.lastFailReason = "intent_summary missing (Phase 1 incomplete)";
      return "fail";
    }
    if (!this.spec.production_config) {
      emitError("phase-8 production_config missing", null);
      this.lastFailReason = "production_config missing in spec";
      return "fail";
    }

    // Brief.md artık relevance engine ile section-bazlı filter ediliyor.
    // Phase 3 skip edildiyse "(no relevant brief sections found)" sentinel.
    let systemPrompt: string;
    try {
      // YZLLM 2026-06-12 (sıfır-risk perf): brief + template + conversation-context bağımsız salt-okunur → paralel.
      const [tmpl, engineeringBrief, convSection] = await Promise.all([
        readFile(this.spec.prompt_template_path!, "utf-8"),
        buildRelevantEngineeringBrief(this.config, this.state, this.state.intent_summary),
        buildConversationContext(this.config, this.state, { recentLanguage: "en" })
          .then((c) => renderConversationSection(c, { forMainAgent: true }))
          .catch(() => ""),
      ]);
      systemPrompt = substitute(tmpl, {
        INTENT_SUMMARY: this.state.intent_summary,
        ENGINEERING_BRIEF: engineeringBrief,
        CONVERSATION_CONTEXT: convSection,
        SPEC_PATH: currentSpecRelPath(this.state),
      });
    } catch (err) {
      log.error("phase-7", "template load failed", err);
      emitError("template load failed", String(err));
      this.lastFailReason = `template load failed: ${String(err)}`;
      return "fail";
    }
    const escMe = escalatedModelEffort(this.state, this.config, "db-design");
    this.base = createProductionSchemaBackend({
      tag: "phase-7",
      phaseId: 7,
      state: this.state,
      config: this.config,
      systemPrompt,
      modelId: escMe.modelId,
      effortOverride: escMe.effort,
      apiKey: this.config.api_keys.main,
      // YZLLM 2026-06-13: Faz 9 risk-fix dispatch'i pending_db_fix set ederse HEDEFLİ-fix modu —
      // tüm şemayı yeniden tasarlama, yalnız bu riski düzelt (Faz 5 tweak / Faz 8 fix deseni).
      initialUserMessage: this.state.pending_db_fix
        ? `Targeted DB fix — apply ONLY this change. Do NOT redesign the whole schema; preserve everything else. Risk to fix:\n${this.state.pending_db_fix}`
        : "Begin Phase 7: design the database schema and migration plan.",
      tools: [TOOL_WRITE_DB, TOOL_APPROVAL],
      production: this.spec.production_config,
      betas: this.config.claude_code_flags.betas,
      artifactRenderer: (input) => schemaToMarkdown(input as unknown as DbSchemaData),
    });

    const outcome = await this.base.run();
    if (outcome.kind !== "approved") {
      const o = outcome as { kind: string; reason?: string };
      this.lastFailReason =
        o.kind === "failed" ? o.reason ?? "unknown reason" : `outcome kind=${o.kind}`;
      return "fail";
    }

    // v15.7 (2026-05-27): Batch A1 — onaylanan schema'nın migration array'inden
    // gerçek SQL dosyaları yaz. Phase 8 başlangıcı bunları apply edecek.
    // Dosya formatı: <project>/.mycl/migrations/NNN-<description>.sql
    // NNN: 3 haneli zero-padded order; description kebab-case slugify.
    try {
      const schema = outcome.writeInput as unknown as DbSchemaData | undefined;
      if (schema?.migrations && Array.isArray(schema.migrations)) {
        const migrationDir = `${this.state.project_root}/.mycl/migrations`;
        await mkdir(migrationDir, { recursive: true });
        const writtenPaths: string[] = [];
        for (const m of schema.migrations) {
          const sql = m.sql ?? m.sql_sketch;
          if (!sql || sql.trim().length === 0) {
            // ZORUNLU alan boş = model/coercion sorunu (sessiz-fallback denetimi). Sessiz skip → migration
            // yazılmaz → DB şeması eksik → Faz 8 yanlış-temiz olabilir. GÖRÜNÜR kıl.
            log.error("phase-7", "migration ZORUNLU SQL'i boş — yazılmadı (DB şeması eksik kalabilir)", { order: m.order, description: m.description });
            emitError(
              "Faz 7: bir migration'ın SQL'i boş geldi",
              `order=${m.order} "${m.description}" — bu migration YAZILMADI; DB şeması eksik kalabilir, elle kontrol et.`,
            );
            continue;
          }
          const order = String(m.order).padStart(3, "0");
          const slug = m.description
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60);
          const filename = `${order}-${slug || "migration"}.sql`;
          const fullPath = `${migrationDir}/${filename}`;
          await writeFile(fullPath, sql + "\n", "utf-8");
          writtenPaths.push(`.mycl/migrations/${filename}`);
        }
        this.statePatch = { ...this.statePatch, pending_migrations: writtenPaths };
        log.info("phase-7", "migrations written", { count: writtenPaths.length });
      }
    } catch (err) {
      // Migration yazımı DB doğruluğu için olmazsa-olmaz (sessiz-fallback denetimi): sessiz log.warn →
      // migrations kaybolur → DB şeması yanlış → Faz 8 yanlış-temiz. GÖRÜNÜR kıl.
      log.error("phase-7", "migration dosya yazımı BAŞARISIZ — DB şeması eksik kalabilir", err);
      emitError(
        "Faz 7: migration yazımı başarısız",
        `${String(err).slice(0, 200)} — DB şeması eksik olabilir; disk/izin kontrol et.`,
      );
      // FROZEN-GOAL #13: eski kod yine 'complete' dönüyordu → eksik DB şeması SESSİZCE Faz 8'e gidip
      // "yanlış-temiz" oluyordu. 'fail' dön → failPhase görünür hata + eyleme dönük askq açar (sessiz-pass YOK).
      this.lastFailReason = "Faz 7: migration yazımı başarısız — DB şeması eksik (disk/izin)";
      return "fail";
    }

    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 7,
      event: "phase-7-db-approve",
      caller: "user",
      detail: `sha256=${outcome.artifact_hash}`,
    });
    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 7,
      // detail ZORUNLU: verify-up kanıtı audit detail'inden okur; boş bırakılırsa
      // "tamamlama açıklaması yok" yanlış-negatifi → faz tekrar-tekrar koşar (döngü).
      event: "phase-7-complete",
      caller: "mycl-orchestrator",
      detail: `DB şeması yazıldı + onaylandı; sha256=${outcome.artifact_hash}`,
    });
    // ADR: şema/migration kararı (otomatik, non-blocking).
    try {
      const wi = outcome.writeInput as unknown as DbSchemaData | undefined;
      const tableCount = Array.isArray(wi?.tables) ? wi!.tables.length : 0;
      const migCount = Array.isArray(wi?.migrations) ? wi!.migrations.length : 0;
      await appendDecision(this.state.project_root, {
        ts: Date.now(),
        phase: 7,
        iteration: this.state.iteration_count ?? 1,
        title: String(wi?.title ?? "Database schema"),
        context: `${tableCount} tables, ${migCount} migrations`,
        alternatives_considered: [],
        chosen: String(wi?.title ?? "Database schema"),
        reason: Array.isArray(wi?.migrations)
          ? wi!.migrations.map((m) => m.description ?? "").filter(Boolean).join("; ").slice(0, 280)
          : "",
      });
    } catch (err) {
      // ADR karar-kaydı (DB şeması — müfettiş/orkestratör trajectory'sini besler) → sessiz log.warn yerine
      // log.error + görünür (phase-3/4 ile tutarlı; tekrarlayan = disk/izin).
      log.error("phase-7", "DB-şeması karar-kaydı (ADR) yazılamadı — orkestratör belleği eksik kalabilir", err);
      emitChatMessage("system", "⚠️ Faz 7: DB-şeması karar-kaydı yazılamadı (disk/izin?) — orkestratör belleği eksik kalabilir.");
    }
    log.info("phase-7", "complete");
    return "complete";
  }
}
