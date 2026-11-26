// home-guard — ev dizini muhafızının sözleşme testleri (gerçek süreç, tmpdir; LLM yok).
//
// Sözleşme (Claude Code PreToolUse): exit 0 = izin, exit 2 = engel. Yüklem: hedef ev dizininin içinde VE
// projenin dışındaysa engel. Sahte "ev" tmpdir altında kurulur — gerçek ev dizinine dokunulmaz.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const GUARD = resolve(dirname(fileURLToPath(import.meta.url)), "..", "home-guard.mjs");

let base = "";
let home = "";
let proj = "";
let outside = "";

beforeEach(async () => {
  base = realpathSync(await mkdtemp(join(tmpdir(), "mycl-home-guard-")));
  home = join(base, "ev");
  proj = join(home, "proj", "app");
  outside = join(base, "dis");
  await fs.mkdir(join(proj, "src"), { recursive: true });
  await fs.mkdir(join(home, "proj", "kardes"), { recursive: true });
  await fs.mkdir(join(home, ".ssh"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(join(proj, "src", "a.ts"), "export const a = 1;\n");
  await fs.writeFile(join(home, "proj", "kardes", "sir.txt"), "SIR\n");
  await fs.writeFile(join(home, ".ssh", "id"), "ANAHTAR\n");
  await fs.writeFile(join(outside, "x.txt"), "dis\n");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function b64(rules: unknown): string {
  return Buffer.from(JSON.stringify(rules), "utf-8").toString("base64");
}

function run(
  toolInput: Record<string, unknown>,
  opts?: { rules?: string; cwd?: string; rawInput?: string; tool?: string },
): { status: number | null; stderr: string } {
  const res = spawnSync("node", [GUARD, "--rules", opts?.rules ?? b64({ home, project_root: proj })], {
    input: opts?.rawInput ?? JSON.stringify({ tool_name: opts?.tool ?? "Read", cwd: opts?.cwd ?? proj, tool_input: toolInput }),
    encoding: "utf-8",
  });
  return { status: res.status, stderr: res.stderr };
}

describe("proje içi — serbest", () => {
  it("var olan proje dosyası, yeni proje dosyası ve göreli yol İZİNLİ", () => {
    expect(run({ file_path: join(proj, "src", "a.ts") }).status).toBe(0);
    expect(run({ file_path: join(proj, "src", "yeni", "b.ts") }).status).toBe(0);
    expect(run({ file_path: "src/a.ts" }).status).toBe(0);
  });

  it("yol vermeyen arama (Glob/Grep) proje cwd'sinde İZİNLİ; göreli desen İZİNLİ", () => {
    expect(run({ pattern: "**/*.ts" }).status).toBe(0);
    expect(run({ pattern: "TODO", path: "src" }).status).toBe(0);
  });
});

describe("ev dizininde ama proje dışında — ENGEL", () => {
  it("var olan gizli dosya ve kardeş proje", () => {
    const r = run({ file_path: join(home, ".ssh", "id") });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("outside the project");
    expect(run({ file_path: join(home, "proj", "kardes", "sir.txt") }).status).toBe(2);
  });

  // Mahkeme bulgusu: kardeş listesi spawn anında alınır → VAR OLMAYAN adlar izin kurallarıyla kapanmaz.
  it("henüz VAR OLMAYAN adlar: ~/.zshenv, üst dizin CLAUDE.md, yeni dizin altı", () => {
    expect(run({ file_path: join(home, ".zshenv") }).status).toBe(2);
    expect(run({ file_path: join(home, "proj", "CLAUDE.md") }).status).toBe(2);
    expect(run({ file_path: join(home, "yeni-dizin", "alt", "x.txt") }).status).toBe(2);
    expect(run({ file_path: join(home, ".claude", "settings.json") }).status).toBe(2);
  });

  it("proje içinden göreli kaçış (../kardes) ve ev dizininin kendisi", () => {
    expect(run({ file_path: "../kardes/sir.txt" }).status).toBe(2);
    expect(run({ path: home, pattern: "*" }).status).toBe(2);
    expect(run({ notebook_path: join(home, "defter.ipynb") }).status).toBe(2);
  });

  it("proje İÇİNDEKİ sembolik bağlantı ev dizinine çıkıyorsa ENGEL (dosya kimliği, metin değil)", async () => {
    await fs.symlink(join(home, ".ssh"), join(proj, "kisayol"));
    expect(run({ file_path: join(proj, "kisayol", "id") }).status).toBe(2);
    expect(run({ file_path: join(proj, "kisayol", "yeni-anahtar") }).status).toBe(2);
  });

  it("mutlak Glob deseni ev dizinini hedefliyorsa ENGEL; ev dizininin ATASI üzerinde arama da ENGEL", () => {
    expect(run({ pattern: join(home, "**", "*.pem") }).status).toBe(2);
    expect(run({ pattern: "TODO", path: dirname(home) }).status).toBe(2);
    expect(run({ pattern: "x", path: "/" }).status).toBe(2);
  });

  it("ön eki aynı olan kardeş (app2) proje sayılmaz", async () => {
    await fs.mkdir(join(home, "proj", "app2"), { recursive: true });
    expect(run({ file_path: join(home, "proj", "app2", "x.ts") }).status).toBe(2);
  });
});

// Mahkeme ikinci tur bulguları — betik üzerinde kanıtlanmış kaçışlar.
describe("göreli desen ve boşta bağlantı kaçışları — ENGEL", () => {
  it("göreli Glob deseni `..` ile ev dizinine çıkıyorsa ENGEL", () => {
    expect(run({ pattern: "../../**/*.txt" }).status).toBe(2);
    expect(run({ pattern: "../../.zs*", path: proj }).status).toBe(2);
    expect(run({ pattern: "./../../*" }).status).toBe(2);
    expect(run({ pattern: "../kardes/*" }).status).toBe(2);
  });

  it("joker karakterden SONRA `..` içeren desen ENGEL (önekten anlaşılamaz)", () => {
    expect(run({ pattern: "src/*/../../../*" }).status).toBe(2);
    expect(run({ pattern: "{../..,src}/*.txt" }).status).toBe(2);
  });

  it("proje içinde kalan göreli desenler hâlâ İZİNLİ (yanlış engel yok)", () => {
    expect(run({ pattern: "src/**/*.ts" }).status).toBe(0);
    expect(run({ pattern: "./src/*.ts" }).status).toBe(0);
    expect(run({ pattern: "src/../src/*.ts" }).status).toBe(0);
    // Grep düzenli ifadesi yol değildir.
    expect(run({ pattern: "a\\.\\.b|TODO", path: "src" }).status).toBe(0);
  });

  it("BOŞTA sembolik bağlantı (hedefi henüz yok) ev dizinine çıkıyorsa ENGEL; proje içine çıkıyorsa İZİNLİ", async () => {
    await fs.symlink(join(home, "olmayan-dosya"), join(proj, "bosta"));
    expect(run({ file_path: join(proj, "bosta") }).status).toBe(2);
    expect(run({ file_path: "bosta" }).status).toBe(2);
    await fs.symlink(join(proj, "src", "henuz-yok.ts"), join(proj, "ic-bosta"));
    expect(run({ file_path: "ic-bosta" }).status).toBe(0);
    // Göreli hedefli boşta bağlantı.
    await fs.symlink("../../yok.txt", join(proj, "goreli-bosta"));
    expect(run({ file_path: "goreli-bosta" }).status).toBe(2);
  });

  it("bağlantı döngüsü: hata = ENGEL", async () => {
    await fs.symlink(join(proj, "b"), join(proj, "a"));
    await fs.symlink(join(proj, "a"), join(proj, "b"));
    expect(run({ file_path: "a" }).status).not.toBe(0);
  });
});

// Mahkeme üçüncü tur bulguları.
describe("Grep düzenli ifadesi yol DEĞİLDİR — gündelik aramalar engellenmez", () => {
  const grep = (pattern: string, extra: Record<string, unknown> = {}) =>
    run({ pattern, ...extra }, { tool: "Grep" }).status;

  it("içinde `/` ya da `..` geçen arama ifadeleri İZİNLİ (cwd proje)", () => {
    for (const p of [
      "../components", "../", "../../lib/", "/\\*\\*", "//.*eslint-disable", "{...props} />",
      "<Foo {...rest}/>", "/Users/", "https?://", "^/api/", "import .* from \"\\.\\./",
    ]) {
      expect(grep(p), p).toBe(0);
    }
  });

  it("Grep'in ARAMA YERİ (`path`) yine denetlenir: ev dizini ENGEL, proje alt dizini İZİNLİ", () => {
    expect(grep("TODO", { path: home })).toBe(2);
    expect(grep("TODO", { path: "../kardes" })).toBe(2);
    expect(grep("../components", { path: "src" })).toBe(0);
  });

  it("araç adı bilinmiyorsa güvenli taraf: desen yol gibi denetlenir", () => {
    expect(run({ pattern: "../../**/*.txt" }, { tool: "" }).status).toBe(2);
    expect(run({ pattern: "../../**/*.txt" }, { tool: "Glob" }).status).toBe(2);
  });
});

describe("bağlantıdan sonra gelen `..` FİZİKSEL çözülür (metin sadeleştirmesi yanıltır)", () => {
  it("proje/baglanti/../x: bağlantı kardeş dizinin İÇİNE gidiyorsa `..` kardeşe çıkar → ENGEL", async () => {
    await fs.mkdir(join(home, "proj", "kardes", "derin"), { recursive: true });
    await fs.symlink("../kardes/derin", join(proj, "derinbag"));
    // Metin olarak proj/app/a.txt görünür; gerçekte ~/proj/kardes/a.txt.
    // DİKKAT: join() metni sadeleştirir (testin kendisi açığı gizlerdi) → yol elle birleştirilir.
    expect(run({ file_path: `${proj}/derinbag/../a.txt` }).status).toBe(2);
    expect(run({ file_path: "derinbag/../a.txt" }).status).toBe(2);
    expect(run({ pattern: "*", path: `${proj}/derinbag/..` }, { tool: "Glob" }).status).toBe(2);
    expect(run({ pattern: "derinbag/../*" }, { tool: "Glob" }).status).toBe(2);
  });

  it("proje içinde kalan bağlantı + `..` İZİNLİ (yanlış engel yok)", async () => {
    await fs.mkdir(join(proj, "src", "alt"), { recursive: true });
    await fs.symlink("src/alt", join(proj, "icbag"));
    expect(run({ file_path: "icbag/../a.ts" }).status).toBe(0); // = proj/src/a.ts
    expect(run({ file_path: "src/alt/../../README.md" }).status).toBe(0);
  });

  it("var olmayan dizinlerden `..` ile ev dizinine çıkış ENGEL; proje içinde kalış İZİNLİ", () => {
    expect(run({ file_path: "yok1/yok2/../../../kardes/x.txt" }).status).toBe(2);
    expect(run({ file_path: "yok1/yok2/../../src/yeni.ts" }).status).toBe(0);
  });

  it("desen sözdizimiyle gizlenmiş `..` ENGEL; `*.{ts,tsx}` ve `.*` İZİNLİ", () => {
    for (const p of [".{.,}/*", "[.][.]/x", "{.,..}/.."]) {
      expect(run({ pattern: p }, { tool: "Glob" }).status, p).toBe(2);
    }
    for (const p of ["**/*.{ts,tsx}", "src/**/[a-z]*.ts", "*.md", ".*", ".github/**/*.yml"]) {
      expect(run({ pattern: p }, { tool: "Glob" }).status, p).toBe(0);
    }
  });
});

// Mahkeme dördüncü tur bulguları.
describe.runIf(process.platform === "darwin")("macOS takma yolları — aynı dosyaya başka metinle varış ENGEL", () => {
  // /private (ve /Users) birer firmlink'tir: /System/Volumes/Data<yol> aynı dizinin kendisidir, sembolik bağlantı değil.
  const alias = (p: string) => `/System/Volumes/Data${p}`;

  it("veri birimi takma yolu: ev dizini içi okuma, yeni dosya yazma, Glob ve Grep ENGEL", () => {
    expect(run({ file_path: alias(join(home, ".ssh", "id")) }).status).toBe(2);
    expect(run({ file_path: alias(join(home, ".zshenv")) }, { tool: "Write" }).status).toBe(2);
    expect(run({ pattern: `${alias(home)}/**/*` }, { tool: "Glob" }).status).toBe(2);
    expect(run({ pattern: "x", path: alias(home) }, { tool: "Grep" }).status).toBe(2);
  });

  it("takma yolun ATASI üzerinde arama da ENGEL (ev dizinini tarar)", () => {
    expect(run({ pattern: "x", path: "/System/Volumes/Data" }, { tool: "Grep" }).status).toBe(2);
    expect(run({ pattern: "/System/Volumes/Data/**/*.pem" }, { tool: "Glob" }).status).toBe(2);
  });

  it("takma yolla PROJE içi hedef İZİNLİ (yanlış engel yok)", () => {
    expect(run({ file_path: alias(join(proj, "src", "a.ts")) }).status).toBe(0);
    expect(run({ file_path: alias(join(proj, "src", "yeni.ts")) }, { tool: "Write" }).status).toBe(0);
  });

  it("çekirdeğin sihirli önekleri (/.vol, /.nofollow, /.resolve) her durumda ENGEL", () => {
    expect(run({ file_path: `/.nofollow${join(home, ".ssh", "id")}` }).status).toBe(2);
    expect(run({ file_path: `/.resolve/1${join(home, ".ssh", "id")}` }).status).toBe(2);
    expect(run({ file_path: "/.vol/16777231/2" }).status).toBe(2);
    expect(run({ file_path: `/.NOFOLLOW${join(proj, "src", "a.ts")}` }).status).toBe(2);
  });
});

describe("dördüncü tur — haksız engeller", () => {
  it("çift uzantı ve noktalı dosya desenleri İZİNLİ; gizlenmiş `..` hâlâ ENGEL", () => {
    for (const p of ["**/*.*.*", "src/**/*.*.*", "**/.*.*", "**/*.?.*", "**/.env.*"]) {
      expect(run({ pattern: p }, { tool: "Glob" }).status, p).toBe(0);
    }
    for (const p of [".{.,}/*", "[.][.]/x", "{.,..}/.."]) {
      expect(run({ pattern: p }, { tool: "Glob" }).status, p).toBe(2);
    }
  });

  it("proje yolunda köşeli/süslü parantez varken mutlak desen İZİNLİ (kaçışlı ve kaçışsız)", async () => {
    const odd = join(home, "My Projects (2026)", "app [v2]");
    await fs.mkdir(join(odd, "src"), { recursive: true });
    const rules = b64({ home, project_root: odd });
    const glob = (pattern: string) => run({ pattern }, { rules, cwd: odd, tool: "Glob" }).status;
    // KAÇIŞLI mutlak desen ve göreli desen İZİNLİ.
    expect(glob(`${join(home, "My Projects (2026)")}/app \\[v2\\]/src/*.ts`)).toBe(0);
    expect(glob("src/*.ts")).toBe(0);
    // 5. tur: KAÇIŞSIZ hâlde "[v2]" karakter sınıfıdır ve kardeş "app 2" dizinini de eşler → ENGEL (ileti göreli
    // deseni önerir). Gerçek claude'da bu biçim zaten projeyi eşlemiyor ("No files found").
    await fs.mkdir(join(home, "My Projects (2026)", "app 2"), { recursive: true });
    const raw = run({ pattern: `${odd}/*` }, { rules, cwd: odd, tool: "Glob" });
    expect(raw.status).toBe(2);
    expect(raw.stderr).toContain("relative pattern");
    // Aynı desenle proje DIŞINA çıkış hâlâ engel.
    expect(glob(`${odd}/../*`)).toBe(2);
    expect(glob(`${join(home, "My Projects (2026)")}/*`)).toBe(2);
  });
});

// Beşinci tur bulguları.
describe("beşinci tur — süslü parantez açılımı ve tümünü yakala klasörleri", () => {
  const glob = (pattern: string, extra: Record<string, unknown> = {}) =>
    run({ pattern, ...extra }, { tool: "Glob" }).status;

  it("süslü parantez seçeneği mutlak ev dizini yoluysa ENGEL (eskiden hiç denetlenmiyordu)", () => {
    expect(glob(`{${join(home, ".ssh")},x}/*`)).toBe(2);
    expect(glob(`{${join(home, ".ssh")},x}/*`, { path: proj })).toBe(2);
    expect(glob(`{x,${join(home, "proj", "kardes")}}/*`)).toBe(2);
    expect(glob("{~/.ssh,src}/*")).toBe(2);
    expect(glob(`src/{a,{b,${join(home, ".ssh")}}}/*`)).toBe(0); // iç seçenek "src/" altında kalır
    expect(glob(`{src,{lib,${join(home, ".ssh")}}}/*`)).toBe(2); // iç içe seçenek mutlak ev dizini yolu
  });

  it("proje içinde kalan süslü parantezler İZİNLİ", () => {
    for (const p of ["**/*.{ts,tsx}", "{src,test}/**/*.ts", "src/{.,alt}/*.ts", "src/{.,..}/*", "{a}/x", "**/{a,b}{c,d}.ts"]) {
      expect(glob(p), p).toBe(0);
    }
  });

  it("çok fazla açılım: HATA = ENGEL", () => {
    expect(glob("{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}/*")).toBe(2); // 128 açılım
  });

  it("Next.js / SvelteKit tümünü yakala klasörleri İZİNLİ (içlerindeki `...` tırmanış değildir)", () => {
    for (const p of [
      "app/**/[...slug]/*.tsx", "**/[[...slug]]/page.tsx", "app/\\[...slug\\]/page.tsx",
      "src/routes/[...rest]/+page.svelte", "pages/[...all].vue", "**/*...*", "docs/a..b/*.md",
    ]) {
      expect(glob(p), p).toBe(0);
    }
  });

  it("gerçek tırmanışlar hâlâ ENGEL", () => {
    for (const p of ["src/*/../../../*", "**/..", "[.][.]/x", "*/[.][.]/[.][.]/*", "**/\\.\\./\\.\\./*", "src/*/[.].*"]) {
      const expected = p === "src/*/[.].*" ? 0 : 2; // "[.].*" içinde joker var → ".." olamaz
      expect(glob(p), p).toBe(expected);
    }
  });
});

describe("yetki alanı dışı ve sınır durumları", () => {
  it("ev dizini DIŞINDAKİ yol bu muhafızın konusu değil → İZİNLİ", () => {
    expect(run({ file_path: join(outside, "x.txt") }).status).toBe(0);
  });

  it("proje ev dizininin KENDİSİ ise ev dizini içi her yol proje içidir → İZİNLİ", () => {
    const rules = b64({ home, project_root: home });
    expect(run({ file_path: join(home, ".ssh", "id") }, { rules, cwd: home }).status).toBe(0);
  });

  it.runIf(process.platform === "darwin")(
    "macOS: farklı büyük küçük harfle yazılmış proje yolu yine proje sayılır (yanlış engel yok)",
    () => {
      expect(run({ file_path: join(home, "PROJ", "APP", "src", "a.ts") }).status).toBe(0);
    },
  );
});

describe("hata = ENGEL (fail-closed)", () => {
  it("kural yok / bozuk / eksik alan", () => {
    expect(spawnSync("node", [GUARD], { input: "{}", encoding: "utf-8" }).status).toBe(2);
    expect(run({ file_path: "src/a.ts" }, { rules: "%%%" }).status).toBe(2);
    expect(run({ file_path: "src/a.ts" }, { rules: b64({ home }) }).status).toBe(2);
    expect(run({ file_path: "src/a.ts" }, { rules: b64({ home: "ev", project_root: proj }) }).status).toBe(2);
  });

  it("araç yükü okunamıyorsa ENGEL", () => {
    expect(run({}, { rawInput: "bu json degil" }).status).toBe(2);
    expect(run({}, { rawInput: "null" }).status).toBe(2);
  });
});
