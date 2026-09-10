// audit-anchor — denetim defterinin dış çapası.
//
// KÖK NEDEN (adli öz denetim, 2026-09-10): hüküm canlı ölçümlerden değil, diskten GERİ OKUNAN
// `.mycl/audit.log` satırlarından hesaplanıyor ve defter, kod yazan ajanların çalıştığı projenin
// içinde duruyor. Mahkeme geçici bir dizinde kanıtladı: yedi satır değiştirilince (`-fail` →
// `-complete`) hüküm KISMİ'den GEÇTİ'ye döndü; satır sayısı bile aynı kaldı.
//
// Testler GERÇEK ~/.mycl'e değil MYCL_HOME ile geçici eve yazar; kanıt havuzuna dokunulmaz.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { refreshAuditAnchor, verifyAuditAnchor } from "../src/audit-anchor.js";

let home = "";
let proot = "";
let prevHome: string | undefined;

const AUDIT = join(".mycl", "audit.log");
const SATIR = (event: string) =>
  JSON.stringify({ _schema_v: 1, ts: 1, phase: 13, event, caller: "mycl-orchestrator" }) + "\n";

async function yaz(rel: string, body: string): Promise<void> {
  const abs = join(proot, rel);
  await fs.mkdir(join(proot, ".mycl"), { recursive: true });
  await fs.writeFile(abs, body, "utf-8");
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mycl-anchor-home-"));
  proot = await mkdtemp(join(tmpdir(), "mycl-anchor-proj-"));
  prevHome = process.env.MYCL_HOME;
  process.env.MYCL_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.MYCL_HOME;
  else process.env.MYCL_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
  await rm(proot, { recursive: true, force: true });
});

describe("çapa yokken (geriye uyum)", () => {
  it("hiç çapa alınmamışsa 'no-anchor' — KURCALAMA DEĞİL", async () => {
    await yaz(AUDIT, SATIR("phase-13-complete"));
    expect((await verifyAuditAnchor(proot)).status).toBe("no-anchor");
  });

  it("dosya hiç yoksa da 'no-anchor' (çapalanacak bir şey yok)", async () => {
    await refreshAuditAnchor(proot);
    expect((await verifyAuditAnchor(proot)).status).toBe("no-anchor");
  });
});

describe("temiz akış", () => {
  it("çapa alındıktan sonra dokunulmamış defter doğrulanır", async () => {
    await yaz(AUDIT, SATIR("phase-13-complete"));
    await refreshAuditAnchor(proot);
    const v = await verifyAuditAnchor(proot);
    expect(v.status).toBe("ok");
  });

  it("SONRADAN EKLENEN satırlar çapayı bozmaz (append-only akış normal işler)", async () => {
    await yaz(AUDIT, SATIR("phase-13-complete"));
    await refreshAuditAnchor(proot);
    await fs.appendFile(join(proot, AUDIT), SATIR("phase-14-complete"), "utf-8");
    await fs.appendFile(join(proot, AUDIT), SATIR("phase-15-complete"), "utf-8");
    expect((await verifyAuditAnchor(proot)).status).toBe("ok");
  });
});

describe("kurcalama tespiti", () => {
  it("MAHKEME SENARYOSU: -fail → -complete çevrilirse yakalanır (satır sayısı aynı kalsa bile)", async () => {
    const once = SATIR("semgrep-fail") + SATIR("phase-13-complete");
    await yaz(AUDIT, once);
    await refreshAuditAnchor(proot);
    const sonra = once.replace("semgrep-fail", "semgrep-pass"); // aynı uzunluk
    expect(sonra.length).toBe(once.length);
    await fs.writeFile(join(proot, AUDIT), sonra, "utf-8");
    const v = await verifyAuditAnchor(proot);
    expect(v.status).toBe("tampered");
  });

  it("SATIR SİLİNİRSE yakalanır (dosya çapadan kısa)", async () => {
    await yaz(AUDIT, SATIR("semgrep-fail") + SATIR("phase-13-complete"));
    await refreshAuditAnchor(proot);
    await fs.writeFile(join(proot, AUDIT), SATIR("phase-13-complete"), "utf-8");
    const v = await verifyAuditAnchor(proot);
    expect(v.status).toBe("tampered");
    if (v.status === "tampered") expect(v.reason).toContain("KISA");
  });

  it("dosya sıfırdan uydurulursa yakalanır", async () => {
    await yaz(AUDIT, SATIR("semgrep-fail") + SATIR("phase-13-complete"));
    await refreshAuditAnchor(proot);
    await fs.writeFile(join(proot, AUDIT), SATIR("phase-17-complete").repeat(3), "utf-8");
    expect((await verifyAuditAnchor(proot)).status).toBe("tampered");
  });

  it("KALICI BASTIRMA dosyası da kapsanıyor (accepted-findings)", async () => {
    const rel = join(".mycl", "accepted-findings.jsonl");
    await yaz(AUDIT, SATIR("phase-13-complete"));
    await yaz(rel, JSON.stringify({ kind: "sql-injection", accepted: false }) + "\n");
    await refreshAuditAnchor(proot);
    await fs.writeFile(
      join(proot, rel),
      JSON.stringify({ kind: "sql-injection", accepted: true }) + "\n",
      "utf-8",
    );
    const v = await verifyAuditAnchor(proot);
    expect(v.status).toBe("tampered");
    if (v.status === "tampered") expect(v.file).toContain("accepted-findings");
  });
});

describe("çapa dosyasının kendisi", () => {
  it("proje kökünün DIŞINDA, ev dizininde tutulur (ajan oraya erişemez)", async () => {
    await yaz(AUDIT, SATIR("phase-13-complete"));
    await refreshAuditAnchor(proot);
    await expect(fs.access(join(home, "audit-anchors.json"))).resolves.toBeUndefined();
    // Proje içinde HİÇBİR çapa izi yok — olsaydı kaydı değiştiren çapayı da değiştirirdi.
    const icerik = await fs.readdir(join(proot, ".mycl"));
    expect(icerik).not.toContain("audit-anchors.json");
  });

  it("yalnız sahibi okuyabilir (0600)", async () => {
    await yaz(AUDIT, SATIR("phase-13-complete"));
    await refreshAuditAnchor(proot);
    const st = await fs.stat(join(home, "audit-anchors.json"));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("çapa tazelenince EN SON hâl geçerli olur (eski önek artık bağlayıcı değil)", async () => {
    await yaz(AUDIT, SATIR("a-complete"));
    await refreshAuditAnchor(proot);
    await fs.appendFile(join(proot, AUDIT), SATIR("b-complete"), "utf-8");
    await refreshAuditAnchor(proot);
    expect((await verifyAuditAnchor(proot)).status).toBe("ok");
    // Yeni çapadan sonra geçmişe dokunmak yine yakalanır.
    const body = await fs.readFile(join(proot, AUDIT), "utf-8");
    await fs.writeFile(join(proot, AUDIT), body.replace("a-complete", "a-xxxxxxx"), "utf-8");
    expect((await verifyAuditAnchor(proot)).status).toBe("tampered");
  });
});
