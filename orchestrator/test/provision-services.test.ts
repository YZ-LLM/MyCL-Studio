// provision-services — servis tablosu yükleyici doğrulama + readManifestText testleri.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { loadKnownServices, _loadServicesFromPath } from "../src/provision-services.js";
import { readManifestText } from "../src/service-provision.js";

describe("loadKnownServices — gerçek veri dosyası", () => {
  it("sevk edilen services.json yüklenir ve 5 servisi içerir", async () => {
    const services = await loadKnownServices();
    expect(services.map((s) => s.name).sort()).toEqual(
      ["Elasticsearch", "MongoDB", "MySQL", "PostgreSQL", "Redis"],
    );
    const mysql = services.find((s) => s.name === "MySQL")!;
    expect(mysql.port).toBe(3306);
    expect(mysql.deps.some((re) => re.test("mysql2"))).toBe(true);
    expect(mysql.deps.some((re) => re.test("pymysql"))).toBe(true); // çok ekosistemli imza
  });

  it("cache: ikinci çağrı aynı referans", async () => {
    expect(await loadKnownServices()).toBe(await loadKnownServices());
  });
});

describe("_loadServicesFromPath — doğrulama (KATI #4: bozuk veri görünür patlar)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "mycl-svc-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function fixture(content: unknown): Promise<string> {
    const p = join(tmp, "services.json");
    await fs.writeFile(p, JSON.stringify(content));
    return p;
  }

  it("dosya YOK → THROW (profillerden farklı: bu dosya uygulamayla gelir)", async () => {
    await expect(_loadServicesFromPath(join(tmp, "yok.json"))).rejects.toThrow(/bozuk kurulum/);
  });

  it("dizi değil → throw", async () => {
    await expect(_loadServicesFromPath(await fixture({ port: 1 }))).rejects.toThrow(/dizi olmalı/);
  });

  it("geçersiz port → throw (index'li)", async () => {
    await expect(
      _loadServicesFromPath(await fixture([{ port: 0, name: "X", hint: "h", dep_signatures: [] }])),
    ).rejects.toThrow(/services\[0\]\.port/);
    await expect(
      _loadServicesFromPath(await fixture([{ port: 70000, name: "X", hint: "h", dep_signatures: [] }])),
    ).rejects.toThrow(/services\[0\]\.port/);
  });

  it("boş name/hint → throw", async () => {
    await expect(
      _loadServicesFromPath(await fixture([{ port: 1234, name: "", hint: "h", dep_signatures: [] }])),
    ).rejects.toThrow(/name/);
    await expect(
      _loadServicesFromPath(await fixture([{ port: 1234, name: "X", hint: "", dep_signatures: [] }])),
    ).rejects.toThrow(/hint/);
  });

  it("geçersiz regex imzası → throw (index'li)", async () => {
    await expect(
      _loadServicesFromPath(await fixture([{ port: 1234, name: "X", hint: "h", dep_signatures: ["([kapanmadı"] }])),
    ).rejects.toThrow(/dep_signatures\[0\] geçersiz regex/);
  });

  it("geçerli tablo → derlenmiş regex'lerle döner", async () => {
    const services = await _loadServicesFromPath(
      await fixture([{ port: 4321, name: "FooDB", hint: "başlat", dep_signatures: ["\\bfoodb\\b"] }]),
    );
    expect(services).toHaveLength(1);
    expect(services[0].deps[0].test("uses foodb here")).toBe(true);
  });
});

describe("readManifestText — profil manifest_files birleşimi (stack-bağımsız imza kaynağı)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "mycl-manifest-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("python profili: requirements.txt okunur (eski davranış yalnız package.json'dı)", async () => {
    await fs.writeFile(join(tmp, "requirements.txt"), "flask==3.0\npsycopg2==2.9\n");
    const text = await readManifestText(tmp, ["requirements.txt", "pyproject.toml"]);
    expect(text).toContain("psycopg2");
  });

  it("birden çok manifest birleştirilir; olmayan dosya atlanır", async () => {
    await fs.writeFile(join(tmp, "composer.json"), '{"require":{"pdo_mysql":"*"}}');
    const text = await readManifestText(tmp, ["composer.json", "composer.lock"]);
    expect(text).toContain("pdo_mysql");
  });

  it("basit glob (*.csproj) kök dizinde genişletilir (dotnet)", async () => {
    await fs.writeFile(join(tmp, "App.csproj"), '<PackageReference Include="Npgsql" />');
    const text = await readManifestText(tmp, ["*.csproj", "*.sln"]);
    expect(text).toContain("Npgsql");
  });

  it("manifest listesi yok/boş → package.json fallback (eski davranış)", async () => {
    await fs.writeFile(join(tmp, "package.json"), '{"dependencies":{"mysql2":"^3"}}');
    expect(await readManifestText(tmp, undefined)).toContain("mysql2");
    expect(await readManifestText(tmp, [])).toContain("mysql2");
  });

  it("hiç manifest yok → boş string (imza eşleşmez, crash kanıtı yine çalışır)", async () => {
    expect(await readManifestText(tmp, ["requirements.txt"])).toBe("");
  });
});
