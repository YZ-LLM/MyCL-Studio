// audit-ledger — denetim defterinin SÜREÇ İÇİ tanığı.
//
// KÖK NEDEN (harness kaçış denetimi, 2026-11-26): disk çapası iterasyon başında alınıyor; hüküm ise
// yalnız BU iterasyonun satırlarından hesaplanıyor → o satırlar çapanın kapsamadığı kuyrukta. Ayrıca
// çapa dosyası, MyCL'in hapis dışında koşturduğu proje komutlarınca yazılabilir. Tanık bellekte durur.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptedFindingsPath,
  appendAcceptedFinding,
  appendAudit,
  auditLogPath,
  readAuditLog,
} from "../src/audit.js";
import { refreshAuditAnchor, verifyAuditAnchor } from "../src/audit-anchor.js";
import { ledgerAppend, resetAuditLedgersForTest, verifyLedger } from "../src/audit-ledger.js";

let proot = "";
let home = "";
let prevHome: string | undefined;

const olay = (event: string, ts = 1) => ({ ts, phase: 13 as const, event, caller: "mycl-orchestrator" as const });

beforeEach(async () => {
  proot = await mkdtemp(join(tmpdir(), "mycl-ledger-"));
  home = await mkdtemp(join(tmpdir(), "mycl-ledger-home-"));
  prevHome = process.env.MYCL_HOME;
  process.env.MYCL_HOME = home;
  resetAuditLedgersForTest();
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.MYCL_HOME;
  else process.env.MYCL_HOME = prevHome;
  await rm(proot, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("audit-ledger: audit.log (strict)", () => {
  it("bu süreç hiç yazmadıysa no-ledger — kurcalama DEĞİL (geriye uyum)", async () => {
    expect(await verifyLedger(auditLogPath(proot))).toEqual({ status: "no-ledger" });
  });

  it("dokunulmamış defter ok; satır sayısı yazılanla aynı", async () => {
    await appendAudit(proot, olay("phase-13-start"));
    await appendAudit(proot, olay("phase-13-fail"));
    expect(await verifyLedger(auditLogPath(proot))).toEqual({ status: "ok", lines: 2 });
  });

  it("ASIL AÇIK: çapadan SONRA yazılan satır değişince çapa görmez, tanık yakalar", async () => {
    await appendAudit(proot, olay("phase-12-complete"));
    await refreshAuditAnchor(proot); // iterasyon başı
    await appendAudit(proot, olay("phase-13-fail")); // bu iterasyonun hükmü buradan çıkar
    const p = auditLogPath(proot);
    const raw = await fs.readFile(p, "utf-8");
    await fs.writeFile(p, raw.replace("phase-13-fail", "phase-13-complete"), "utf-8");

    // Çapa yalnız öneki kapsar → sahtecilik ona görünmez (bu test açığın kendisini belgeler).
    expect((await verifyAuditAnchor(proot)).status).toBe("ok");
    const v = await verifyLedger(p);
    expect(v.status).toBe("tampered");
    expect(v.status === "tampered" && v.reason).toMatch(/yazdığı 1 satır yok/);
  });

  it("sahte kanıt satırı EKLENİRSE yakalanır", async () => {
    await appendAudit(proot, olay("phase-8-start"));
    const p = auditLogPath(proot);
    await fs.appendFile(p, JSON.stringify(olay("tdd-green")) + "\n", "utf-8");
    const v = await verifyLedger(p);
    expect(v.status).toBe("tampered");
    expect(v.status === "tampered" && v.reason).toMatch(/yazmadığı 1 satır var/);
  });

  it("satır SİLİNİRSE yakalanır", async () => {
    await appendAudit(proot, olay("phase-13-fail"));
    await appendAudit(proot, olay("phase-13-complete"));
    const p = auditLogPath(proot);
    const lines = (await fs.readFile(p, "utf-8")).split("\n").filter(Boolean);
    await fs.writeFile(p, lines.slice(1).join("\n") + "\n", "utf-8");
    expect((await verifyLedger(p)).status).toBe("tampered");
  });

  it("oturum ÖNCESİ geçmiş değişince yakalanır; kısalınca da", async () => {
    const p = auditLogPath(proot);
    await fs.mkdir(join(proot, ".mycl"), { recursive: true });
    await fs.writeFile(p, JSON.stringify(olay("eski-fail")) + "\n", "utf-8");
    await appendAudit(proot, olay("yeni"));
    const raw = await fs.readFile(p, "utf-8");
    await fs.writeFile(p, raw.replace("eski-fail", "eski-pass"), "utf-8");
    const v = await verifyLedger(p);
    expect(v.status === "tampered" && v.reason).toMatch(/oturum başından önceki/);

    await fs.writeFile(p, "", "utf-8");
    const v2 = await verifyLedger(p);
    expect(v2.status === "tampered" && v2.reason).toMatch(/KISA/);
  });

  it("beklemesiz eşzamanlı appendAudit çağrıları (sıra garantisi yok) yanlış alarm ÜRETMEZ", async () => {
    // Üretimde appendAudit dört yerde `void` ile çağrılıyor → diske düşme sırası belirsiz.
    const ops: Promise<void>[] = [];
    for (let i = 0; i < 40; i++) ops.push(appendAudit(proot, olay(`e-${i}`, i)));
    await Promise.all(ops);
    expect(await verifyLedger(auditLogPath(proot))).toEqual({ status: "ok", lines: 40 });
  });

  // MAHKEME Y1: önceki test tanık henüz doğmadan doğruluyordu (no-ledger) → bekleme yolu sınanmıyordu.
  // Burada yazım BİLEREK geciktirilir; doğrulama uçuştaki yazımı beklemeli.
  it("UÇUŞTAKİ yazım varken doğrulama onu bekler — 'eksik satır' demez", async () => {
    const p = join(proot, "u.log");
    await ledgerAppend(p, "bir\n", "strict", () => fs.appendFile(p, "bir\n", "utf-8"));
    let birak: () => void = () => undefined;
    const kapi = new Promise<void>((r) => (birak = r));
    const yavas = ledgerAppend(p, "iki\n", "strict", async () => {
      await kapi;
      await fs.appendFile(p, "iki\n", "utf-8");
    });
    const dogrulama = verifyLedger(p); // "iki" tanıkta ama diskte DEĞİL
    setTimeout(birak, 30);
    expect(await dogrulama).toEqual({ status: "ok", lines: 2 });
    await yavas;
  });

  it("doğrulama OKURKEN başlayan yazım sonucu bozmaz (kararlı an yeniden denenir)", async () => {
    const p = join(proot, "k.log");
    await ledgerAppend(p, "bir\n", "strict", () => fs.appendFile(p, "bir\n", "utf-8"));
    const dogrulama = verifyLedger(p);
    // Doğrulama başladıktan HEMEN sonra yeni yazım: tanığa girer, diske gecikmeli düşer.
    const gec = ledgerAppend(p, "iki\n", "strict", async () => {
      await new Promise((r) => setTimeout(r, 20));
      await fs.appendFile(p, "iki\n", "utf-8");
    });
    const v = await dogrulama;
    await gec;
    expect(v.status).toBe("ok");
    expect(await verifyLedger(p)).toEqual({ status: "ok", lines: 2 });
  });

  // MAHKEME Y2: write başarılı + fsync hatalı → satır diskte ama yazım "başarısız". Kurcalama DEĞİL.
  it("yarı başarısız yazım (satır diske düştü, sonra hata) 'yabancı satır' diye raporlanmaz", async () => {
    const p = join(proot, "y2.log");
    await ledgerAppend(p, "ilk\n", "strict", () => fs.appendFile(p, "ilk\n", "utf-8"));
    await expect(
      ledgerAppend(p, "yarim\n", "strict", async () => {
        await fs.appendFile(p, "yarim\n", "utf-8");
        throw new Error("EIO: fsync");
      }),
    ).rejects.toThrow("EIO");
    expect(await verifyLedger(p)).toEqual({ status: "ok", lines: 2 });
  });

  it("birebir aynı iki satır (çoklu küme) doğru sayılır", async () => {
    const p = join(proot, "x.log");
    const w = (l: string) => ledgerAppend(p, l, "strict", () => fs.appendFile(p, l, "utf-8"));
    await w("ayni\n");
    await w("ayni\n");
    expect(await verifyLedger(p)).toEqual({ status: "ok", lines: 2 });
    await fs.writeFile(p, "ayni\n", "utf-8"); // biri silindi
    expect((await verifyLedger(p)).status).toBe("tampered");
  });

  it("yazım başarısız olursa satır tanıktan geri alınır ve hata aynen fırlar", async () => {
    const p = join(proot, "y.log");
    await ledgerAppend(p, "ilk\n", "strict", () => fs.appendFile(p, "ilk\n", "utf-8"));
    await expect(
      ledgerAppend(p, "olmadi\n", "strict", async () => {
        throw new Error("disk dolu");
      }),
    ).rejects.toThrow("disk dolu");
    // Yazılamayan satır "eksik" sayılmamalı.
    expect(await verifyLedger(p)).toEqual({ status: "ok", lines: 1 });
  });

  it("appendAudit davranışı aynı: satırlar okunabilir, sıra ve içerik korunur", async () => {
    await appendAudit(proot, olay("a", 1));
    await appendAudit(proot, olay("b", 2));
    expect((await readAuditLog(proot)).map((e) => e.event)).toEqual(["a", "b"]);
  });
});

describe("audit-ledger: accepted-findings.jsonl (additions)", () => {
  const bulgu = (snippet: string) => ({
    ts: 1,
    scope: "tech-debt" as const,
    file: "src/a.ts",
    category: "todo_comment",
    snippet,
  });

  it("kullanıcı satır SİLEBİLİR (belgelenmiş 'bulguyu yeniden etkinleştir' akışı) — alarm yok", async () => {
    await appendAcceptedFinding(proot, bulgu("bir"));
    await appendAcceptedFinding(proot, bulgu("iki"));
    const p = acceptedFindingsPath(proot);
    const lines = (await fs.readFile(p, "utf-8")).split("\n").filter(Boolean);
    await fs.writeFile(p, lines[1] + "\n", "utf-8");
    expect((await verifyLedger(p)).status).toBe("ok");
  });

  it("oturumdan ÖNCE var olan satırlar yabancı sayılmaz", async () => {
    const p = acceptedFindingsPath(proot);
    await fs.mkdir(join(proot, ".mycl"), { recursive: true });
    await fs.writeFile(p, JSON.stringify(bulgu("eski")) + "\n", "utf-8");
    await appendAcceptedFinding(proot, bulgu("yeni"));
    expect(await verifyLedger(p)).toEqual({ status: "ok", lines: 2 });
  });

  it("CRLF / kenar boşluğu ile yeniden kaydedilen satır yabancı sayılmaz (editör kaydı)", async () => {
    await appendAcceptedFinding(proot, bulgu("bir"));
    const p = acceptedFindingsPath(proot);
    const raw = await fs.readFile(p, "utf-8");
    await fs.writeFile(p, raw.replace(/\n/g, "\r\n"), "utf-8");
    expect((await verifyLedger(p)).status).toBe("ok");
  });

  it("MyCL'in yazmadığı satır EKLENİRSE yakalanır (bulguyu kalıcı susturma girişimi)", async () => {
    await appendAcceptedFinding(proot, bulgu("gercek"));
    const p = acceptedFindingsPath(proot);
    await fs.appendFile(p, JSON.stringify(bulgu("sahte-parola-kabulu")) + "\n", "utf-8");
    const v = await verifyLedger(p);
    expect(v.status === "tampered" && v.reason).toMatch(/yazmadığı 1 satır/);
  });
});
