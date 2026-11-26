// Anahtarsız (yalnız abonelik) çalışma — API anahtarı HİÇ yokken MyCL açılır ve roller abonelikle çalışır.
//
// Önce: loadConfig, sağlayıcı ayarına bakmadan ApiKeyMissingError atıyordu → config_status ready:false
// (api_keys_missing) → roller "cli" olsa bile proje açılamıyordu.
// Şimdi: anahtar zorunlu değil; hangi yolun kullanılacağına tek yerde backendForRole karar verir.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  backendForRole,
  hasApiKeys,
  isAutoMode,
  loadConfig,
  resolveSelectedModels,
  rolesForcedToSubscription,
  type MyclConfig,
} from "../src/config.js";
import { noteCliRateLimitError, resetCliRateLimitState, cliCurrentlyLimited } from "../src/cli-rate-limit.js";
import { TRANSLATOR_MODEL } from "../src/model-catalog.js";

const KEY_ENV = [
  "ANTHROPIC_API_KEY",
  "MYCL_API_KEY_TRANSLATOR",
  "MYCL_API_KEY_MAIN",
  "MYCL_API_KEY_ORCHESTRATOR",
  "MYCL_API_KEY_RELEVANCE",
];

const cfg = (keys: { translator?: string; main?: string }, backends: Record<string, string> = {}): MyclConfig =>
  ({
    api_keys: { translator: keys.translator ?? "", main: keys.main ?? "" },
    agent_backends: { orchestrator: "auto", translator: "auto", main: "auto", ...backends },
  }) as unknown as MyclConfig;

describe("anahtarsız çalışma — arka uç seçici", () => {
  afterEach(() => resetCliRateLimitState());

  it("anahtar yok: ayar ne olursa olsun her rol abonelik (cli)", () => {
    for (const v of ["auto", "api", "cli"]) {
      const c = cfg({}, { main: v, translator: v, orchestrator: v });
      for (const role of ["main", "translator", "orchestrator"] as const) {
        expect(backendForRole(c, role), `${role}=${v}`).toBe("cli");
      }
    }
  });

  it("anahtar yok + abonelik limiti DOLU: auto yine API'ye dönmez (bekle ve devam et yoluna düşer)", () => {
    noteCliRateLimitError();
    expect(cliCurrentlyLimited()).toBe(true);
    expect(backendForRole(cfg({}), "main")).toBe("cli");
  });

  it("anahtar yok: auto sayılmaz → fabrikalar anahtarsız bir API yedeği KURMAZ", () => {
    const c = cfg({});
    expect(isAutoMode(c, "main")).toBe(false);
    expect(isAutoMode(c, "translator")).toBe(false);
    expect(isAutoMode(c, "orchestrator")).toBe(false);
  });

  it("anahtar yok + rol açıkça 'api': görünür bildirim için o roller listelenir (sessiz geçiş yok)", () => {
    expect(rolesForcedToSubscription(cfg({}, { main: "api", orchestrator: "api" }))).toEqual(["main", "orchestrator"]);
    expect(rolesForcedToSubscription(cfg({}))).toEqual([]); // auto / cli için bildirim gerekmez
    expect(rolesForcedToSubscription(cfg({ translator: "k1", main: "k2" }, { main: "api" }))).toEqual([]);
  });

  it("yarım anahtar (yalnız biri) anahtar YOK sayılır — eski doğrulamadaki ölçütün aynısı", () => {
    expect(hasApiKeys(cfg({ main: "k" }))).toBe(false);
    expect(hasApiKeys(cfg({ translator: "k" }))).toBe(false);
    expect(hasApiKeys(cfg({ translator: "  ", main: "k" }))).toBe(false);
    expect(hasApiKeys(cfg({ translator: "k1", main: "k2" }))).toBe(true);
  });

  // KATI #14: anahtar VARKEN davranış aynen kalır.
  it("anahtar VAR: auto → limit yokken cli, limit doluyken api; api → api; cli → cli (değişmedi)", () => {
    const keyed = (b: Record<string, string> = {}) => cfg({ translator: "k1", main: "k2" }, b);
    expect(backendForRole(keyed(), "main")).toBe("cli");
    expect(backendForRole(keyed({ main: "api" }), "main")).toBe("api");
    expect(backendForRole(keyed({ main: "cli" }), "main")).toBe("cli");
    expect(isAutoMode(keyed(), "main")).toBe(true);
    expect(isAutoMode(keyed({ main: "api" }), "main")).toBe(false);
    noteCliRateLimitError();
    expect(backendForRole(keyed(), "main")).toBe("api");
    expect(backendForRole(keyed({ main: "cli" }), "main")).toBe("cli");
  });
});

describe("anahtarsız çalışma — yapılandırma yükleme", () => {
  let home = "";
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "mycl-keyless-"));
    for (const k of [...KEY_ENV, "MYCL_HOME"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.MYCL_HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(home, { recursive: true, force: true });
  });

  it("gizli dosya yok, ortam değişkeni yok: loadConfig hata ATMAZ; anahtarlar boş, roller abonelik", async () => {
    await writeFile(join(home, "config.json"), JSON.stringify({ selected_models: { main: "claude-opus-5" } }));
    const c = await loadConfig();
    expect(c.api_keys.translator).toBe("");
    expect(c.api_keys.main).toBe("");
    expect(hasApiKeys(c)).toBe(false);
    expect(backendForRole(c, "main")).toBe("cli");
    expect(backendForRole(c, "translator")).toBe("cli");
    expect(backendForRole(c, "orchestrator")).toBe("cli");
    // Çevirmen modeli sabittir ve arayüzde seçilemez → kayıtlı değilse sabit model.
    expect(c.selected_models.translator).toBe(TRANSLATOR_MODEL);
    expect(c.selected_models.main).toBe("claude-opus-5");
  });

  it("anahtar VARSA loadConfig bugünkü nesneyi verir (değişmedi)", async () => {
    await writeFile(join(home, "config.json"), JSON.stringify({ selected_models: { translator: "t", main: "m" } }));
    await writeFile(join(home, "secrets.json"), JSON.stringify({ api_keys: { translator: "sk-t", main: "sk-m" } }));
    const c = await loadConfig();
    expect(c.api_keys.translator).toBe("sk-t");
    expect(c.api_keys.main).toBe("sk-m");
    expect(c.selected_models.translator).toBe("t");
    expect(hasApiKeys(c)).toBe(true);
  });

  it("ana model seçilmemişse hâlâ model seçimi hatası (anahtarla ilgisiz)", () => {
    expect(() => resolveSelectedModels({})).toThrow(/Model seçimi eksik/);
    expect(() => resolveSelectedModels({ selected_models: { translator: "t" } } as never)).toThrow(/Model seçimi eksik/);
  });
});

// Gerçek süreç: derlenmiş orkestratör anahtarsız ortamda açılınca "hazır" diyor mu.
describe("anahtarsız çalışma — orkestratör süreci hazır olur", () => {
  const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
  let home = "";
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "mycl-keyless-proc-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function boot(configJson: unknown): Promise<Array<{ kind: string; data: Record<string, unknown> }>> {
    return new Promise((resolveP, reject) => {
      void writeFile(join(home, "config.json"), JSON.stringify(configJson)).then(() => {
        const env: NodeJS.ProcessEnv = { ...process.env, MYCL_HOME: home };
        for (const k of KEY_ENV) delete env[k];
        const child = spawn("node", [ENTRY], { env, stdio: ["pipe", "pipe", "ignore"] });
        const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
        let buf = "";
        const done = (): void => {
          clearTimeout(timer);
          child.kill();
          resolveP(events);
        };
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`config_status gelmedi; olaylar: ${events.map((e) => e.kind).join(",")}`));
        }, 20_000);
        child.stdout.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf-8");
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("{")) continue;
            try {
              const ev = JSON.parse(line) as { kind: string; data: Record<string, unknown> };
              events.push(ev);
              if (ev.kind === "config_status") done();
            } catch {
              /* JSON olmayan satır */
            }
          }
        });
        child.on("error", reject);
      }, reject);
    });
  }

  it("anahtar yok + ana model seçili → config_status ready:true", async () => {
    const events = await boot({ selected_models: { main: "claude-opus-5" } });
    const status = events.find((e) => e.kind === "config_status");
    expect(status?.data).toEqual({ ready: true });
  }, 30_000);

  it("anahtar yok + rol açıkça 'api' → hazır olur VE sohbete görünür bildirim düşer", async () => {
    const events = await boot({
      selected_models: { main: "claude-opus-5" },
      agent_backends: { main: "api", translator: "auto", orchestrator: "api" },
    });
    expect(events.find((e) => e.kind === "config_status")?.data).toEqual({ ready: true });
    const notice = events.find((e) => e.kind === "chat_message" && String(e.data.text).includes("API anahtarı yok"));
    expect(notice, "anahtarsız 'api' rolü için görünür bildirim").toBeDefined();
    expect(String(notice!.data.text)).toContain("main, orchestrator");
  }, 30_000);

  it("anahtar yok + model de yok → eksik olan MODEL seçimidir, anahtar değil", async () => {
    const events = await boot({});
    expect(events.find((e) => e.kind === "config_status")?.data).toEqual({
      ready: false,
      reason: "model_selection_missing",
    });
  }, 30_000);
});
