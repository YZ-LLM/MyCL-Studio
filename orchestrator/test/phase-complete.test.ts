// phase-complete — `phase-N-complete` damgasının tek kapısı.
//
// NEDEN (2026-09-17): damga 34 ayrı noktada yazılıyordu ve hiçbirinde "faz gerçekten bir çıktı
// üretti mi?" diye bakılmıyordu. İki somut bedeli vardı: (1) "tamamlandı" demek işin yapıldığı
// anlamına gelmiyordu — kullanıcı ekranda "tüm gate'ler yeşil" okudu, oysa Faz 2-17 hiç koşmamıştı;
// (2) atlama yollarında `skipped` ve `complete` iki ayrı çağrıydı, ayrışmaları serbestti — Faz 16'nın
// atlanması hükme tam bu yüzden hiç yansımıyordu.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  completionDetail,
  stampPhaseCompletion,
  SOFT_COMPLETE_DETAIL,
} from "../src/phase-complete.js";
import { declaredArtifact } from "../src/phase-artifacts.js";
import { PHASE_SPECS } from "../src/phase-registry.js";

const TS = 1789492860037;
let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mycl-stamp-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const state = () => ({ project_root: root, iteration_started_at: TS });
const audit = async (): Promise<string> =>
  fs.readFile(join(root, ".mycl", "audit.log"), "utf-8").catch(() => "");

/** Faz 4 artefaktını çözücünün söylediği yere yaz (klasör adı yerel saatten üretilir). */
async function yazSpec(icerik = "# spec\n"): Promise<void> {
  const d = declaredArtifact(PHASE_SPECS[4]!, state())!;
  const p = join(root, d.rel);
  await fs.mkdir(dirname(p), { recursive: true });
  await fs.writeFile(p, icerik);
}

describe("completionDetail — kilitli string'ler", () => {
  it("KİLİTLİ STRING: soft_fail detayı birebir 'soft_complete_after_fail'", () => {
    // Hüküm hesabı ve iş-tamamlanma kararı bu EŞİTLİĞE bakar. Değiştirmek prototip kaydını ve
    // modül stoklamasını sessizce bozar — bu regresyon daha önce yaşandı.
    expect(completionDetail({ kind: "soft_fail" })).toBe("soft_complete_after_fail");
    expect(SOFT_COMPLETE_DETAIL).toBe("soft_complete_after_fail");
  });

  it("atlama detayı gerekçeyi TAŞIR (hüküm bunu sınıflandırabilsin)", () => {
    expect(completionDetail({ kind: "skipped", reason: "playwright_disabled" })).toBe(
      "via=skipped reason=playwright_disabled",
    );
  });

  it("kullanıcı kabulü kendi detayını korur", () => {
    expect(completionDetail({ kind: "user", detail: "security_accepted_by_user" })).toBe(
      "security_accepted_by_user",
    );
    expect(completionDetail({ kind: "user" })).toBe("user_accepted");
  });

  it("ran: ek detay verilmezse boş (bugünkü davranış)", () => {
    expect(completionDetail({ kind: "ran" })).toBe("");
    expect(completionDetail({ kind: "ran" }, "external dev server detected")).toBe(
      "external dev server detected",
    );
  });
});

describe("stampPhaseCompletion — kanıt kuralı", () => {
  it("ran + çıktı VAR → normal damga (bugünkü davranış)", async () => {
    await yazSpec();
    await stampPhaseCompletion(state(), 4, { kind: "ran" });
    const a = await audit();
    expect(a).toContain("phase-4-complete");
    expect(a).not.toContain("output-missing");
    expect(a).not.toContain(SOFT_COMPLETE_DETAIL);
  });

  it("CANLI DESEN: ran + çıktı YOK → 'doğrulandı' sayılmaz, damga soft olur", async () => {
    await stampPhaseCompletion(state(), 4, { kind: "ran" });
    const a = await audit();
    expect(a).toContain("phase-4-output-missing");
    expect(a).toContain(SOFT_COMPLETE_DETAIL); // hüküm KISMİ'ye düşer
  });

  it("YANLIŞ ALARM YOK: çıktı bildirmeyen faz kanıtsız diye cezalandırılmaz", async () => {
    await stampPhaseCompletion(state(), 5, { kind: "ran" }); // Faz 5 codegen, çıktı bildirmez
    const a = await audit();
    expect(a).toContain("phase-5-complete");
    expect(a).not.toContain("output-missing");
    expect(a).not.toContain(SOFT_COMPLETE_DETAIL);
  });

  it("atlanan faz için kanıt ARANMAZ — atlama çıktı üretmez", async () => {
    await stampPhaseCompletion(state(), 4, { kind: "skipped", reason: "out_of_scope" });
    const a = await audit();
    expect(a).not.toContain("output-missing");
    expect(a).toContain("via=skipped reason=out_of_scope");
  });

  it("atlama: skipped VE complete AYNI çağrıdan yazılır (ayrışamazlar)", async () => {
    await stampPhaseCompletion(state(), 16, { kind: "skipped", reason: "playwright_disabled" });
    const a = await audit();
    expect(a).toContain("phase-16-skipped");
    expect(a).toContain("phase-16-complete");
    expect(a).toContain("playwright_disabled");
  });

  it("REGRESYON KİLİDİ: kullanıcı kabulü damgası detayını kaybetmez", async () => {
    await stampPhaseCompletion(state(), 13, { kind: "user", detail: "security_accepted_by_user" });
    expect(await audit()).toContain("security_accepted_by_user");
  });

  it("REGRESYON KİLİDİ: soft_fail damgası kanıt kontrolünden GEÇMEZ (zaten soft)", async () => {
    await stampPhaseCompletion(state(), 4, { kind: "soft_fail" });
    const a = await audit();
    expect(a).toContain(SOFT_COMPLETE_DETAIL);
    expect(a).not.toContain("output-missing");
  });
});
