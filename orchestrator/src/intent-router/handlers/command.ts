// intent-router/handlers/command — kullanıcının "çalıştır / test / build /
// install / lint" niyetlerini MyCL kendi tetikler. Stack-agnostic: manifest
// dosyalarından stack tespit edilir (Node/Python/Rust/Go/Ruby/PHP/JVM/Elixir/
// Dart/Swift/.NET) ve doğru komut türetilir. Kullanıcı manuel terminalde
// komut çalıştırmaz; MyCL spawn eder, çıktıyı chat'e yansıtır.
//
// İki yol:
//   1. Node dev-server (npm/yarn/pnpm/bun + dev/start script) →
//      dev-server-launcher (detached, browser open, ready probe). Phase 5'nın
//      success path'i ile aynı.
//   2. Diğer tüm komutlar (test/build/install/lint + non-Node run) → exec
//      one-shot. Çıktı stdout/stderr ile chat'e yansıtılır.
//
// Non-Node web framework'lerinin dev server'larını (uvicorn, rails server,
// mix phx.server, vs.) detached spawn etmek henüz desteklenmiyor — run intent
// runOneShot'a düşer ve uzun ömürlü server'da timeout'a yakalanır. İleri tur.
//
// state.current_phase **DEĞİŞMEZ** — komut bir yan-eylem. dev_server_pid
// güncellenebilir (Node dev server spawn edildiyse).

import { exec } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendAudit } from "../../audit.js";
import { type MyclConfig } from "../../config.js";
import {
  buildDevServerFailMessage,
  openBrowser,
  tryDevServerChain,
  type DevServerAttempt,
} from "../../dev-server-launcher.js";
import { emitChatMessage } from "../../ipc.js";
import { log } from "../../logger.js";
import { replaceActiveWatcher } from "../../runtime-error-watcher.js";
import { safeEnv } from "../../safe-env.js";
import { ensureViteRuntimeInjection } from "../../vite-runtime-injector.js";
import type { State, StackId } from "../../types.js";
import type { IntentClassification } from "../types.js";

// StackId tipi v15.0'da types.ts'ye taşındı (state.stack alanı için). Eski
// importer'lar değişmeden çalışsın diye buradan re-export ediliyor.
export type { StackId };

const execp = promisify(exec);
const EXEC_TIMEOUT_MS = 300_000;
const DEV_SERVER_TIMEOUT_MS = 15_000;

export type CommandIntentKind = "run" | "test" | "build" | "install" | "lint";

// StackId tipi v15.0'da types.ts'ye taşındı; üstte re-export ile geri uyumlu.

export const NODE_STACKS: ReadonlySet<StackId> = new Set<StackId>([
  "node-npm",
  "node-yarn",
  "node-pnpm",
  "node-bun",
]);

// v15.7 (2026-05-27): detectIntentKind regex KALDIRILDI.
// Önceki davranış: kullanıcı metnini TR/EN pattern matching ile "run/test/build/
// install/lint" alt-türüne sınıflandırıyordu. Kullanıcı kuralı: "regex
// güvenilir değil" — pluralization/tonlama edge case'leri yanlış komut
// tetikliyordu. Yeni: caller (UI butonu) `intent_kind`'ı doğrudan verir;
// IntentClassification.intent_kind veya extracted_command zorunlu.

/**
 * FS: projeRoot içindeki manifest dosyalarından stack tespit et. İlk eşleşen
 * stack döner; eşleşme yoksa "unknown". Stack tespiti deterministik —
 * package.json varsa Node, kilit dosyasına göre paket yöneticisi.
 */
export function detectStack(projectRoot: string): StackId {
  const has = (rel: string): boolean => existsSync(join(projectRoot, rel));
  if (has("package.json")) {
    if (has("bun.lockb") || has("bunfig.toml")) return "node-bun";
    if (has("pnpm-lock.yaml")) return "node-pnpm";
    if (has("yarn.lock")) return "node-yarn";
    return "node-npm";
  }
  if (has("deno.json") || has("deno.jsonc")) return "deno";
  if (has("Cargo.toml")) return "rust";
  if (has("pyproject.toml")) {
    try {
      const content = readFileSync(join(projectRoot, "pyproject.toml"), "utf8");
      if (/\[tool\.poetry\]/.test(content)) return "python-poetry";
      if (/\[tool\.uv\]/.test(content) || has("uv.lock")) return "python-uv";
    } catch {
      // okuyamadıysak pip varsayalım
    }
    return "python-pip";
  }
  if (has("requirements.txt") || has("setup.py") || has("setup.cfg")) return "python-pip";
  if (has("go.mod")) return "go";
  if (has("Gemfile")) return "ruby";
  if (has("composer.json")) return "php";
  if (has("pom.xml")) return "maven";
  if (has("build.gradle") || has("build.gradle.kts")) return "gradle";
  if (has("mix.exs")) return "elixir";
  if (has("pubspec.yaml")) return "dart";
  if (has("Package.swift")) return "swift";
  if (hasFileWithExts(projectRoot, [".csproj", ".sln", ".fsproj"])) return "dotnet";
  return "unknown";
}

function hasFileWithExts(dir: string, exts: readonly string[]): boolean {
  try {
    return readdirSync(dir).some((f) => exts.some((ext) => f.endsWith(ext)));
  } catch {
    return false;
  }
}

/**
 * FS: Node projeleri için package.json:scripts oku. Hata olursa boş obje.
 */
export function readNodeScripts(projectRoot: string): Record<string, string> {
  try {
    const raw = readFileSync(join(projectRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

/**
 * package.json scripts içinden full-stack ipuçlarını çıkarır. Pure helper —
 * Phase 5 dev server chain'i + `commandsFor` fallback üretimi için kullanılır.
 *
 * `hasVite`: scripts içinde "vite" geçen bir komut var mı?
 * `isConcurrent`: dev script concurrently / npm-run-all kullanıyor mu?
 * `devFrontend`/`devBackend`: ayrı dev script adları (varsa).
 *
 * Motivasyon: todomaster gibi full-stack projelerde `dev` script sadece
 * backend başlatıyor; chain runner Vite'ı ayrı denesin diye bu bilgi gerek.
 */
export interface FullStackScripts {
  dev: string | null;
  devFrontend: string | null;
  devBackend: string | null;
  hasVite: boolean;
  isConcurrent: boolean;
}

export function detectFullStackScripts(
  scripts: Record<string, string>,
): FullStackScripts {
  const findKey = (re: RegExp): string | null => {
    for (const k of Object.keys(scripts)) {
      if (re.test(k)) return k;
    }
    return null;
  };
  const devFrontend = findKey(/^dev:(frontend|client|web|ui)$/);
  const devBackend = findKey(/^dev:(backend|server|api)$/);
  const dev = scripts.dev ?? null;
  // Vite ipucu: herhangi bir script "vite" çalıştırıyor mu?
  const hasVite = Object.values(scripts).some((s) =>
    /(^|[\s&|])vite(\s|$|\s+(dev|preview|build))/.test(s),
  );
  // Concurrent ipucu: dev veya başka script concurrently/npm-run-all içeriyor mu?
  const isConcurrent = Object.values(scripts).some((s) =>
    /\b(concurrently|npm-run-all|run-p|run-s)\b/.test(s),
  );
  return { dev, devFrontend, devBackend, hasVite, isConcurrent };
}

/**
 * Pure: stack + niyet → komut string. Node stack'leri için package.json
 * scripts'i opsiyonel argüman olarak enjekte edilir; o sayede dev/start script
 * adı bulunabilir. Stack için niyet desteklenmiyorsa null.
 */
export function commandFor(
  stack: StackId,
  intentKind: CommandIntentKind,
  nodeScripts: Record<string, string> = {},
): string | null {
  switch (stack) {
    case "node-npm":
    case "node-yarn":
    case "node-pnpm":
    case "node-bun":
      return nodeCommand(stack, intentKind, nodeScripts);
    case "deno":
      return {
        run: "deno task dev",
        test: "deno test",
        build: "deno task build",
        install: "deno cache --reload .",
        lint: "deno lint",
      }[intentKind];
    case "rust":
      return {
        run: "cargo run",
        test: "cargo test",
        build: "cargo build",
        install: "cargo fetch",
        lint: "cargo clippy",
      }[intentKind];
    case "python-poetry":
      return {
        run: "poetry run python main.py",
        test: "poetry run pytest",
        build: null,
        install: "poetry install",
        lint: "poetry run ruff check .",
      }[intentKind];
    case "python-uv":
      return {
        run: "uv run python main.py",
        test: "uv run pytest",
        build: null,
        install: "uv sync",
        lint: "uv run ruff check .",
      }[intentKind];
    case "python-pip":
      return {
        run: "python main.py",
        test: "pytest",
        build: null,
        install: "pip install -r requirements.txt",
        lint: "ruff check .",
      }[intentKind];
    case "go":
      return {
        run: "go run .",
        test: "go test ./...",
        build: "go build ./...",
        install: "go mod download",
        lint: "go vet ./...",
      }[intentKind];
    case "ruby":
      return {
        run: "bundle exec ruby main.rb",
        test: "bundle exec rspec",
        build: null,
        install: "bundle install",
        lint: "bundle exec rubocop",
      }[intentKind];
    case "php":
      return {
        run: "php -S localhost:8000",
        test: "vendor/bin/phpunit",
        build: null,
        install: "composer install",
        lint: "vendor/bin/phpcs",
      }[intentKind];
    case "maven":
      return {
        run: "mvn spring-boot:run",
        test: "mvn test",
        build: "mvn package",
        install: "mvn install",
        lint: "mvn checkstyle:check",
      }[intentKind];
    case "gradle":
      return {
        run: "./gradlew run",
        test: "./gradlew test",
        build: "./gradlew build",
        install: "./gradlew build",
        lint: "./gradlew check",
      }[intentKind];
    case "elixir":
      return {
        run: "mix run --no-halt",
        test: "mix test",
        build: "mix compile",
        install: "mix deps.get",
        lint: "mix credo",
      }[intentKind];
    case "dart":
      return {
        run: "flutter run",
        test: "flutter test",
        build: "flutter build apk",
        install: "flutter pub get",
        lint: "flutter analyze",
      }[intentKind];
    case "swift":
      return {
        run: "swift run",
        test: "swift test",
        build: "swift build",
        install: "swift package resolve",
        lint: null,
      }[intentKind];
    case "dotnet":
      return {
        run: "dotnet run",
        test: "dotnet test",
        build: "dotnet build",
        install: "dotnet restore",
        lint: "dotnet format --verify-no-changes",
      }[intentKind];
    case "unknown":
      return null;
  }
}

function nodeCommand(
  stack: StackId,
  intentKind: CommandIntentKind,
  scripts: Record<string, string>,
): string | null {
  const mgr = stack === "node-yarn" ? "yarn"
    : stack === "node-pnpm" ? "pnpm"
    : stack === "node-bun" ? "bun"
    : "npm";

  switch (intentKind) {
    case "install":
      return `${mgr} install`;
    case "test":
      // npm test / yarn test / pnpm test / bun run test hepsi çalışır.
      return mgr === "bun" ? "bun run test" : `${mgr} test`;
    case "run": {
      const script = scripts.dev ? "dev" : scripts.start ? "start" : null;
      if (!script) return null;
      return `${mgr} run ${script}`;
    }
    case "build":
      return scripts.build ? `${mgr} run build` : null;
    case "lint":
      return scripts.lint ? `${mgr} run lint` : null;
  }
}

/**
 * Chain-aware komut listesi: primary komut + olası fallback'ler.
 * Tek-app durumunda `commandFor` ile aynı sonuç (`[primary]`). Full-stack
 * (Vite + backend) durumunda fallback chain: `["npm run dev", "npm run
 * dev:frontend", "npx vite"]`. Phase 5 dev-server chain runner ilk komutla
 * başlar, fail ise sonrakini dener.
 *
 * Bun stack için `npx` → `bunx`. Sadece `run` intent için chain genişletilir;
 * diğer intent'ler tek komut döner.
 */
export function commandsFor(
  stack: StackId,
  intentKind: CommandIntentKind,
  nodeScripts: Record<string, string> = {},
): string[] {
  const primary = commandFor(stack, intentKind, nodeScripts);
  if (!primary) return [];
  if (intentKind !== "run") return [primary];
  if (!NODE_STACKS.has(stack)) return [primary];

  const info = detectFullStackScripts(nodeScripts);
  const mgr = stack === "node-yarn" ? "yarn"
    : stack === "node-pnpm" ? "pnpm"
    : stack === "node-bun" ? "bun"
    : "npm";
  const runner = stack === "node-bun" ? "bunx" : "npx";

  const chain: string[] = [primary];
  // Frontend-specific dev script (ör: dev:frontend) varsa 2. aday.
  if (info.devFrontend && !primary.endsWith(info.devFrontend)) {
    chain.push(`${mgr} run ${info.devFrontend}`);
  }
  // Vite scripts'te varsa son çare olarak doğrudan vite çağır.
  if (info.hasVite) {
    chain.push(`${runner} vite`);
  }
  return chain;
}

/**
 * Composed: kullanıcı metni + classifier hint + proje stack'i → komut.
 * Sıra:
 *   1. classifier hint (extracted_command) verilmişse onu kullan (verbatim)
 *   2. kind verilmişse stack profili ile commandFor() üzerinden komut türet
 *   3. ikisi de yoksa null (caller hata gösterir)
 *
 * v15.7 (2026-05-27): Regex `detectIntentKind` kaldırıldı; caller `kind`
 * vermek zorunda (UI butonu veya LLM agent extracted_command'ı).
 */
export function deriveCommand(
  projectRoot: string,
  kind: CommandIntentKind | null,
  hint?: string,
): string | null {
  if (hint && hint.trim().length > 0) return hint.trim();
  if (!kind) return null;
  const stack = detectStack(projectRoot);
  if (stack === "unknown") return null;
  const scripts = NODE_STACKS.has(stack) ? readNodeScripts(projectRoot) : {};
  return commandFor(stack, kind, scripts);
}

/**
 * Pure security guard: komut shell injection vector içeriyor mu?
 * `cmd` LLM classifier `extracted_command`'inden gelebilir (kontrolsüz kullanıcı
 * input → LLM output → shell). Hem `spawnDevServer` (`shell: true`) hem
 * `runOneShot` (`exec()` shell) için gateway. Zincirleme (`;`, `&&`, `||`),
 * pipe (`|`), redirect (`<`, `>`), backtick, command substitution (`$(`),
 * background (`&`) reddedilir. Normal flag/arg/path/port karakterleri geçer.
 */
const SHELL_METACHARS = /[;|&<>`]|\$\(|\|\||&&/;

export function isUnsafeShellCommand(cmd: string): boolean {
  return SHELL_METACHARS.test(cmd);
}

/**
 * Komut long-running web dev-server tipi mi? (HMR/auto-reload, browser açılacak)
 * Stack-agnostic: Node + Python + Ruby + PHP + Elixir Phoenix + JVM Spring Boot
 * + .NET ASP.NET. Rust/Go/Swift `run` komutları DAHIL DEĞİL (genellikle CLI
 * app; web service ise kullanıcı classifier hint ile override eder).
 */
export function isDevServerCommand(cmd: string): boolean {
  return (
    /\b((npm|yarn|pnpm|bun)\s+run\s+(dev|start)|npx\s+vite|vite(\s|$)|next\s+dev|webpack-dev-server)\b/.test(cmd) ||
    /\b(uvicorn|gunicorn|hypercorn|daphne|flask\s+run|manage\.py\s+runserver)\b/.test(cmd) ||
    /\b(rails\s+s(erver)?|bundle\s+exec\s+(rails|puma)|puma)\b/.test(cmd) ||
    /\b(php\s+-S|artisan\s+serve)\b/.test(cmd) ||
    /\bmix\s+phx\.server\b/.test(cmd) ||
    /\b(spring-boot:run|bootRun)\b/.test(cmd) ||
    /\bdotnet\s+(run|watch)\b/.test(cmd)
  );
}

/**
 * Pure: komuta göre beklenen HTTP port'u tahmin et. Framework default'ları:
 * Vite=5173, Next/Rails=3000, Flask=5000, Phoenix=4000, Spring/Vapor=8080,
 * uvicorn/Django/PHP/Laravel/Gunicorn=8000, .NET Kestrel=5000, Puma=9292.
 * `php -S host:N` formatından port okunur. Eşleşme yoksa 8080 fallback.
 */
export function expectedPortFor(cmd: string): number {
  const phpPort = /php\s+-S\s+\S*?:(\d+)/.exec(cmd);
  if (phpPort) return parseInt(phpPort[1], 10);
  if (/\b(npx\s+vite|vite(\s|$))/.test(cmd)) return 5173;
  if (/\bnext\s+dev\b/.test(cmd)) return 3000;
  if (/\b(npm|yarn|pnpm|bun)\s+run\s+(dev|start)\b/.test(cmd)) return 5173;
  if (/\b(rails\s+s(erver)?|bundle\s+exec\s+rails)\b/.test(cmd)) return 3000;
  if (/\bpuma\b/.test(cmd)) return 9292;
  if (/\b(uvicorn|gunicorn|hypercorn|daphne)\b/.test(cmd)) return 8000;
  if (/\bmanage\.py\s+runserver\b/.test(cmd)) return 8000;
  if (/\bflask\s+run\b/.test(cmd)) return 5000;
  if (/\b(php\s+-S|artisan\s+serve)\b/.test(cmd)) return 8000;
  if (/\bmix\s+phx\.server\b/.test(cmd)) return 4000;
  if (/\b(spring-boot:run|bootRun)\b/.test(cmd)) return 8080;
  if (/\bdotnet\s+(run|watch)\b/.test(cmd)) return 5000;
  return 8080;
}

/**
 * Multi-probe port list. Komuta + opsiyonel scripts hint'ine göre olası
 * port'ları sıralı dön. Tek-port arayan caller `result[0]` kullanır
 * (backward-compat). Chain runner sırayla probe eder.
 *
 * Örnek: `npm run dev` + scripts.dev backend ipucu içeriyor (`node` veya
 * `nodemon`) → `[5173, 3000]` (Vite önce dene, sonra Express).
 */
export function expectedPortsFor(
  cmd: string,
  _scripts: Record<string, string> = {},
  projectRoot?: string,
): number[] {
  const primary = expectedPortFor(cmd);

  // Vite-ish komutlarda vite.config(.ts|.js|.mjs) içinde `server.port` override
  // olabilir (todomaster 5174 örneği). Config port'u primary olarak kullan,
  // default 5173'ü fallback olarak ekle. Multi-port probe chain runner'da
  // sıralı denenir.
  const isViteish = /\b(npx|bunx)\s+vite|\bvite(\s|$)/.test(cmd) ||
    /\b(npm|yarn|pnpm|bun)\s+run\s+(dev|start)\b/.test(cmd);
  if (isViteish && projectRoot) {
    const configPort = detectViteConfigPort(projectRoot);
    if (configPort && configPort !== primary) {
      return [configPort, primary];
    }
  }
  return [primary];
}

/**
 * vite.config.{ts,js,mjs} dosyasından `server.port` değerini regex ile çıkar.
 * Bulunamazsa null. Pure helper; vite.config'i evaluate ETMEZ (TS/JS runtime
 * gerekecekti), sadece statik regex match. Kırılgan ama yaygın pattern
 * (`server: { port: N }`) için yeterli. Multi-line + tek-line her ikisini de
 * yakalar.
 */
function detectViteConfigPort(projectRoot: string): number | null {
  for (const name of ["vite.config.ts", "vite.config.js", "vite.config.mjs"]) {
    try {
      const raw = readFileSync(join(projectRoot, name), "utf8");
      const m = /server\s*:\s*\{[\s\S]*?\bport\s*:\s*(\d{2,5})/.exec(raw);
      if (m) {
        const port = parseInt(m[1], 10);
        if (port > 0 && port < 65536) return port;
      }
    } catch {
      /* dosya yok veya okunamadı */
    }
  }
  return null;
}

export async function handleCommandIntent(
  state: State,
  config: MyclConfig,
  _text: string,
  intent: IntentClassification,
): Promise<void> {
  log.info("command-handler", "start", {
    has_extracted: !!intent.extracted_command,
    intent_kind: intent.intent_kind,
  });

  const kind: CommandIntentKind | null = intent.intent_kind ?? null;
  const cmd = deriveCommand(
    state.project_root,
    kind,
    intent.extracted_command,
  );
  if (!cmd) {
    const stack = detectStack(state.project_root);
    log.warn("command-handler", "derive failed", {
      stack,
      intent_kind: kind,
      has_extracted: !!intent.extracted_command,
    });
    if (stack === "unknown") {
      emitChatMessage(
        "system",
        `❌ Proje stack'i tespit edilemedi (package.json / Cargo.toml / pyproject.toml / go.mod / Gemfile / pom.xml / build.gradle / mix.exs / pubspec.yaml / Package.swift / .csproj bulunamadı). Çalıştırmak istediğin tam komutu yaz (örn. "make build").`,
      );
    } else {
      emitChatMessage(
        "system",
        `❌ Hangi komutu çalıştıracağımı anlayamadım (stack: ${stack}). Daha spesifik yaz (örn. "projeyi çalıştır", "testleri koş", "build et", "install et", "lint").`,
      );
    }
    return;
  }

  // Security: cmd LLM classifier'dan veya kullanıcı metninden türemiş olabilir.
  // Shell meta-karakterleri (zincirleme/pipe/redirect/substitution) reddet —
  // hem `spawnDevServer(shell:true)` hem `runOneShot(exec)` shell üzerinden
  // çalıştığı için injection vektörü kapatılır.
  if (isUnsafeShellCommand(cmd)) {
    log.warn("command-handler", "unsafe shell command rejected", { cmd });
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: state.current_phase,
      event: "command-unsafe-rejected",
      caller: "user",
      detail: `cmd="${cmd.slice(0, 200)}"`,
    });
    emitChatMessage(
      "error",
      `⚠ Güvenlik: komut shell meta-karakter (\`;\` \`|\` \`&\` \`<\` \`>\` \`\\\`\` \`$(\`) içeriyor → reddedildi.\n\n\`${cmd}\`\n\nTek bir komut yaz (zincirleme/yönlendirme yok). Birden fazla işlem gerekiyorsa her birini ayrı mesaj olarak gönder.`,
    );
    return;
  }

  emitChatMessage("system", `▶ Komut: \`${cmd}\``);

  if (isDevServerCommand(cmd)) {
    await runDevServer(state, config, cmd);
    return;
  }

  await runOneShot(state, cmd);
}

async function runDevServer(
  state: State,
  _config: MyclConfig,
  cmd: string,
): Promise<void> {
  if (state.dev_server_pid) {
    emitChatMessage(
      "system",
      `Dev server zaten ayakta (pid=${state.dev_server_pid}). Yeni spawn yapılmadı.`,
    );
    return;
  }

  // Chain-aware: stack + scripts üzerinden full-stack fallback chain üret.
  // Tek-app durumunda chain tek-aday (bu cmd). Phase 5 ile aynı pattern;
  // tek fark caller event'inde `command-dev-server-*` audit'i (Phase 5 yerine).
  const stack = detectStack(state.project_root);
  const scripts = NODE_STACKS.has(stack) ? readNodeScripts(state.project_root) : {};
  let chainCmds = NODE_STACKS.has(stack)
    ? commandsFor(stack, "run", scripts)
    : [cmd];
  // Eğer caller'dan gelen cmd chain'in head'i değilse, başa al (kullanıcı
  // explicit script seçmiş olabilir).
  if (chainCmds.length > 0 && chainCmds[0] !== cmd) {
    chainCmds = [cmd, ...chainCmds.filter((c) => c !== cmd)];
  }
  if (chainCmds.length === 0) chainCmds = [cmd];

  const candidates = chainCmds.map((c) => ({
    cmd: c,
    ports: expectedPortsFor(c, scripts, state.project_root),
  }));

  // Vite plugin inject — kullanıcı projesine browser runtime hata hook'larını
  // ekle (idempotent). Sadece Vite stack için aktif olur.
  try {
    await ensureViteRuntimeInjection(state.project_root);
  } catch (err) {
    log.warn("command-handler", "vite injection failed (non-fatal)", err);
  }

  const chainResult = await tryDevServerChain(
    state.project_root,
    candidates,
    DEV_SERVER_TIMEOUT_MS,
  );

  if (!chainResult.ok || !chainResult.handle || !chainResult.cmd) {
    const last = chainResult.attempts[chainResult.attempts.length - 1];
    const diagnostic = await buildDevServerFailMessage(
      state.project_root,
      last?.reason === "process_died" ? -1 : 0,
      last?.port ?? expectedPortFor(cmd),
      DEV_SERVER_TIMEOUT_MS,
    );
    const attemptsLog = chainResult.attempts
      .map((a: DevServerAttempt) => `  • \`${a.cmd}\` (port=${a.port}, ${a.reason})`)
      .join("\n");
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: 5,
      event: "command-dev-server-fail",
      caller: "user",
      detail: `cmd="${cmd}" attempts=${chainResult.attempts.length}`,
    });
    emitChatMessage(
      "error",
      `${diagnostic}\n\nDenenen komutlar (hepsi başarısız):\n${attemptsLog}`,
    );
    return;
  }

  const handle = chainResult.handle;
  const usedCmd = chainResult.cmd;
  replaceActiveWatcher({
    pid: handle.pid,
    stdout: handle.stdout,
    stderr: handle.stderr,
    projectRoot: state.project_root,
    dbPath: `${state.project_root}/error_folder/errors.db`,
    config: _config,
  });
  emitChatMessage(
    "system",
    `✅ Dev server hazır: http://localhost:${handle.port} (komut=\`${usedCmd}\`). Tarayıcı açılıyor.`,
  );
  openBrowser(`http://localhost:${handle.port}`);
  await appendAudit(state.project_root, {
    ts: Date.now(),
    phase: 5,
    event: "command-dev-server-start",
    caller: "user",
    detail: `cmd="${usedCmd}" pid=${handle.pid} port=${handle.port} prior_attempts=${chainResult.attempts.length}`,
  });
}

async function runOneShot(state: State, cmd: string): Promise<void> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const result = await execp(cmd, {
      cwd: state.project_root,
      timeout: EXEC_TIMEOUT_MS,
      env: { ...safeEnv(), LC_ALL: "C" },
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = String(result.stdout);
    stderr = String(result.stderr);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    exitCode = typeof e.code === "number" ? e.code : 1;
    stdout = String(e.stdout ?? "");
    stderr = String(e.stderr ?? e.message ?? "");
  }

  await appendAudit(state.project_root, {
    ts: Date.now(),
    phase: state.current_phase,
    event: "command-run",
    caller: "user",
    detail: `cmd="${cmd}" exit=${exitCode}`,
  });

  const outSlice = stdout.slice(0, 2000);
  const errSlice = stderr.slice(0, 2000);
  const truncated = stdout.length > 2000 || stderr.length > 2000;

  if (exitCode === 0) {
    emitChatMessage(
      "assistant",
      `✅ \`${cmd}\` başarılı (exit=0)${truncated ? " — çıktı kısaltıldı" : ""}.\n\n` +
        (outSlice
          ? `**stdout:**\n\`\`\`\n${outSlice}\n\`\`\`\n`
          : "(stdout boş)\n") +
        (errSlice ? `**stderr:**\n\`\`\`\n${errSlice}\n\`\`\`` : ""),
    );
  } else {
    emitChatMessage(
      "error",
      `❌ \`${cmd}\` fail (exit=${exitCode})${truncated ? " — çıktı kısaltıldı" : ""}.\n\n` +
        `**stderr:**\n\`\`\`\n${errSlice || "(boş)"}\n\`\`\`\n` +
        (outSlice ? `**stdout:**\n\`\`\`\n${outSlice}\n\`\`\`` : ""),
    );
  }
}
