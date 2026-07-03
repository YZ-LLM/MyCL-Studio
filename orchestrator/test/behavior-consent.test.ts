import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { specToMarkdown } from "../src/phase-4.js";
import {
  parseAcRecords,
  normalizeText,
  normalizeBehaviorSig,
  jaccard,
  diffBehaviors,
  computeBehaviorChangeSet,
  findPriorSpecPath,
  appendBehaviorConsent,
  readBehaviorConsent,
  latestConsentFor,
  writePendingBehaviorChanges,
  readPendingBehaviorChanges,
  type AcRecord,
  type BehaviorConsentRecord,
} from "../src/behavior-consent.js";

// specToMarkdown SpecData girdisini üretmek için minimal kurucu.
function specMd(acs: AcRecord[]): string {
  return specToMarkdown({
    title: "Test Spec",
    scope: "in and out",
    acceptance_criteria: acs.map((a) => ({
      id: a.id,
      statement: a.statement,
      given: a.given,
      when: a.when,
      then: a.then,
    })),
    out_of_scope: ["nothing"],
    risks: [{ title: "R1", detail: "some risk" }],
  });
}

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "bconsent-"));
}

describe("parseAcRecords — specToMarkdown render sözleşmesiyle yuvarlar", () => {
  it("statement + given/when/then'i geri çıkarır", () => {
    const acs: AcRecord[] = [
      { id: "AC1", statement: "User can log in", given: "on login page", when: "submits valid creds", then: "redirected to dashboard" },
      { id: "AC2", statement: "gitignore excludes error_folder" },
    ];
    const recs = parseAcRecords(specMd(acs));
    expect(recs).toHaveLength(2);
    expect(recs[0]).toEqual({
      id: "AC1",
      statement: "User can log in",
      given: "on login page",
      when: "submits valid creds",
      then: "redirected to dashboard",
    });
    expect(recs[1]).toEqual({ id: "AC2", statement: "gitignore excludes error_folder" });
  });

  it("başka bölümlerdeki bullet'lar (Out of Scope/Risks) AC sayılmaz", () => {
    const recs = parseAcRecords(specMd([{ id: "AC1", statement: "only one" }]));
    expect(recs.map((r) => r.id)).toEqual(["AC1"]);
  });
});

describe("normalizeText / normalizeBehaviorSig — kozmetiği toplar", () => {
  it("büyük-küçük, noktalama, boşluk farkını siler", () => {
    expect(normalizeText("User  LOGS-in!!")).toBe("user logs in");
  });
  it("aynı davranış farklı kozmetikte aynı imza", () => {
    const a: AcRecord = { id: "AC1", statement: "Returns 200, OK.", then: "status is 200" };
    const b: AcRecord = { id: "AC1", statement: "returns 200 ok", then: "status  is 200" };
    expect(normalizeBehaviorSig(a)).toBe(normalizeBehaviorSig(b));
  });
});

describe("jaccard", () => {
  it("iki boş küme → 1, biri boş → 0", () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
    expect(jaccard(new Set(["a"]), new Set())).toBe(0);
  });
  it("kısmi örtüşme", () => {
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBeCloseTo(0.5, 5);
  });
});

describe("diffBehaviors — sınıflandırma", () => {
  const base: AcRecord[] = [
    { id: "AC1", statement: "User can log in", then: "session cookie set" },
    { id: "AC2", statement: "User can list surveys", then: "returns array of surveys" },
  ];

  it("aynı spec → boş (değişiklik yok)", () => {
    expect(diffBehaviors(base, base)).toEqual([]);
  });

  it("kozmetik değişiklik (noktalama/büyük harf) → boş (yanlış-soru yok)", () => {
    const cur: AcRecord[] = [
      { id: "AC1", statement: "User can LOG IN.", then: "session cookie set" },
      { id: "AC2", statement: "User can list surveys", then: "returns array of surveys" },
    ];
    expect(diffBehaviors(base, cur)).toEqual([]);
  });

  it("saf ekleme (yeni AC) → boş (NEW asla sorulmaz)", () => {
    const cur: AcRecord[] = [
      ...base,
      { id: "AC3", statement: "User can delete a survey", then: "survey removed" },
    ];
    expect(diffBehaviors(base, cur)).toEqual([]);
  });

  it("then değişti (aynı davranış, farklı gözlemlenebilir sonuç) → 1 changed", () => {
    const cur: AcRecord[] = [
      { id: "AC1", statement: "User can log in", then: "JWT token returned" }, // then değişti
      { id: "AC2", statement: "User can list surveys", then: "returns array of surveys" },
    ];
    const ch = diffBehaviors(base, cur);
    expect(ch).toHaveLength(1);
    expect(ch[0].kind).toBe("changed");
    expect(ch[0].currentAcId).toBe("AC1");
  });

  it("kelime kayması ama then aynı → then ağıyla eşleşir, changed (NEW sanılıp KAÇMAZ)", () => {
    const prior: AcRecord[] = [
      { id: "AC1", statement: "User logs in with email", then: "session cookie is set" },
    ];
    const cur: AcRecord[] = [
      { id: "AC1", statement: "Member authenticates via credentials portal", then: "session cookie is set with sliding expiry" },
    ];
    const ch = diffBehaviors(prior, cur);
    expect(ch).toHaveLength(1);
    expect(ch[0].kind).toBe("changed");
  });

  it("kaldırılan AC (benzeri güncelde yok) → 1 removed", () => {
    const cur: AcRecord[] = [{ id: "AC1", statement: "User can log in", then: "session cookie set" }];
    const ch = diffBehaviors(base, cur);
    expect(ch).toHaveLength(1);
    expect(ch[0].kind).toBe("removed");
  });

  it("CARDINAL SIN (mahkeme #3): yüksek-then YENİ AC, değişen AC'den ÖNCE gelse bile prior'ı çalmaz", () => {
    // prior: user auth / then x. current: [admin auth / then x (YENİ, thenSim=1), user auth / then y (DEĞİŞEN)].
    // Greedy-per-current admin'i önce işleyip prior'ı then=x ile çalar → user değişikliği NEW sanılıp SESSİZ kaçardı.
    // Global en-iyi-önce (ctx birincil): user (ctxSim=1) prior'ı kapar → CHANGED; admin → NEW (sorulmaz).
    const prior: AcRecord[] = [{ id: "AC1", statement: "user authenticates via SSO portal", then: "x" }];
    const current: AcRecord[] = [
      { id: "AC2", statement: "admin authenticates via SSO portal", then: "x" }, // YENİ, önce
      { id: "AC1", statement: "user authenticates via SSO portal", then: "y" }, // DEĞİŞEN (then x→y)
    ];
    const ch = diffBehaviors(prior, current);
    expect(ch).toHaveLength(1);
    expect(ch[0].kind).toBe("changed");
    expect(ch[0].currentAcId).toBe("AC1"); // admin (AC2) DEĞİL — gerçek değişen yakalandı
  });

  it("yeniden-ifade (senaryo eşleşir, then değişir) → changed olarak tüketilir, removed sayılmaz", () => {
    const prior: AcRecord[] = [{ id: "AC1", statement: "User can list all surveys", then: "returns array" }];
    // Güncelde benzer ama then değişmiş → changed olarak eşleşir, removed olarak DEĞİL.
    const cur: AcRecord[] = [{ id: "AC1", statement: "User can list all surveys", then: "returns paginated array" }];
    const ch = diffBehaviors(prior, cur);
    expect(ch).toHaveLength(1);
    expect(ch[0].kind).toBe("changed");
  });
});

describe("computeBehaviorChangeSet — iterasyon 1 / önceki yok → sıfır soru", () => {
  it("iteration<=1 → boş küme, disk'e dokunmaz", async () => {
    const set = await computeBehaviorChangeSet({
      projectRoot: "/nonexistent-should-not-be-read",
      iteration: 1,
      iterationTs: Date.now(),
      currentSpecMd: specMd([{ id: "AC1", statement: "x", then: "y" }]),
    });
    expect(set.changes).toEqual([]);
    expect(set.origin).toBe("mycl");
  });

  it("önceki iter-spec yoksa → boş küme", async () => {
    const root = await mkTmp();
    const set = await computeBehaviorChangeSet({
      projectRoot: root,
      iteration: 2,
      iterationTs: Date.now(),
      currentSpecMd: specMd([{ id: "AC1", statement: "x", then: "y" }]),
    });
    expect(set.changes).toEqual([]);
  });
});

describe("findPriorSpecPath — devs/ ağacında en yeni eski iter-spec", () => {
  it("_pending ve taşınmış (pages/) klasörlerden en yeni eskiyi seçer", async () => {
    const root = await mkTmp();
    // iterasyon 1 spec'i çözülüp devs/pages/home/<t1>/ altına taşınmış (gerçekçi).
    const t1 = "2026-07-01-10-00-00";
    const t2 = "2026-07-02-10-00-00";
    const p1 = join(root, "devs", "pages", "home", t1);
    const p2 = join(root, "devs", "_pending", t2);
    await fs.mkdir(p1, { recursive: true });
    await fs.mkdir(p2, { recursive: true });
    await fs.writeFile(join(p1, "iter-spec.md"), "# old", "utf-8");
    await fs.writeFile(join(p2, "iter-spec.md"), "# newer-but-still-prior", "utf-8");
    // güncel iterasyon t3 (t2'den yeni) → prior = t2 seçilmeli.
    const t3 = new Date("2026-07-03T10:00:00").getTime();
    const prior = await findPriorSpecPath(root, t3);
    expect(prior).toBe(join(p2, "iter-spec.md"));
  });

  it("hiç eski yoksa null", async () => {
    const root = await mkTmp();
    const prior = await findPriorSpecPath(root, Date.now());
    expect(prior).toBeNull();
  });
});

describe("behavior-consent.jsonl store — append/read/latest", () => {
  it("append-only, son satır kazanır", async () => {
    const root = await mkTmp();
    const rec = (decision: "yes" | "no"): BehaviorConsentRecord => ({
      ts: Date.now(),
      iteration: 2,
      sig: "sig-a",
      decision,
      scope: "behavior-consent",
      priorStatement: "prior",
      featureFiles: [],
      testFiles: [],
    });
    await appendBehaviorConsent(root, rec("no"));
    await appendBehaviorConsent(root, rec("yes"));
    const all = await readBehaviorConsent(root);
    expect(all).toHaveLength(2);
    expect(latestConsentFor(all, "sig-a")?.decision).toBe("yes");
    expect(latestConsentFor(all, "missing")).toBeNull();
  });

  it("dosya yoksa [] (çökme yok)", async () => {
    const root = await mkTmp();
    expect(await readBehaviorConsent(root)).toEqual([]);
  });
});

describe("pending-behavior-changes.json — write/read", () => {
  it("yuvarlar; yoksa null", async () => {
    const root = await mkTmp();
    expect(await readPendingBehaviorChanges(root)).toBeNull();
    await writePendingBehaviorChanges(root, {
      iteration: 2,
      ts: 123,
      origin: "mycl",
      changes: [{ sig: "s", kind: "changed", currentAcId: "AC1", priorStatement: "p", newStatement: "n", featureFiles: [], testFiles: [] }],
    });
    const got = await readPendingBehaviorChanges(root);
    expect(got?.changes[0].currentAcId).toBe("AC1");
  });
});
