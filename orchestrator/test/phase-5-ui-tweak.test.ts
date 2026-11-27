// phase-5-ui-tweak — arayüz rötuş isteği TEK SEFERLİKTİR ve yalnız Faz 5'te anlam taşır.
//
// CANLI KANIT (ekransız deneme koşuları 6 ve 7, 2026-11-27): rötuş ajanı hiçbir şey yazmadan bitince
// Faz 5 `fail` döndü ve `pending_ui_tweak` silinmedi. Mahkeme "devam" deyince akış Faz 6'ya geçti, istek
// durumda kaldı; uygulama yeniden açılınca iş Faz 1'den başladı ve dört faz sonra gelen ilgisiz Faz 5
// koşusu aynı cümleyle ("Kaldığın yerden devam et.") yine rötuş kipine girdi.
//
// Kural: istek, akış Faz 5'ten ÇIKTIĞI anda düşer (Faz 6'ya giriş, yeni Faz 1 başlangıcı). Faz 5'in
// içinde (aynı rötuşun yeniden denenmesi, kesintiden dönüş) bilerek durur.
//
// Bu dosya iki saf işlevi kilitler. Kuralın index.ts içindeki üç çağrı noktası (Faz 6'ya giriş, Faz 1
// başlangıcı, arayüz onayı) burada KOŞTURULMAZ; o bağlantı kod okumasıyla incelendi.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedFilesVsSnapshot, copySourceTree } from "../src/fix-snapshot.js";
import {
  classifyEmptyTweak,
  countDeniedToolCalls,
  isUiTweakRun,
  isUserUiTweakRequest,
  uiTweakStaleOnEnter,
} from "../src/phase-5.js";
import type { AuditEvent, PhaseId, State } from "../src/types.js";

const AFTER_NO_WRITE_TWEAK = {
  current_phase: 5,
  pending_ui_tweak: "Kaldığın yerden devam et.",
} as unknown as State;

/** index.ts'in bayat isteği düşürürken duruma yaptığı tek değişiklik. */
function dropped(state: State): State {
  return { ...state, pending_ui_tweak: undefined };
}

describe("uiTweakStaleOnEnter + isUiTweakRun", () => {
  it("yazmasız biten rötuştan sonra akış Faz 6'ya geçerse istek düşer; sonraki Faz 5 koşusu rötuş kipine girmez", () => {
    expect(isUiTweakRun(AFTER_NO_WRITE_TWEAK)).toBe(true); // istek hâlâ durumda (koşu 6'daki an)
    expect(uiTweakStaleOnEnter(AFTER_NO_WRITE_TWEAK, 6)).toBe(true);
    expect(isUiTweakRun(dropped(AFTER_NO_WRITE_TWEAK))).toBe(false);
  });

  it("iş Faz 1'den yeniden başlarsa istek düşer; dört faz sonraki Faz 5 koşusu rötuş kipine girmez", () => {
    expect(uiTweakStaleOnEnter(AFTER_NO_WRITE_TWEAK, 1)).toBe(true);
    expect(isUiTweakRun(dropped(AFTER_NO_WRITE_TWEAK))).toBe(false);
  });

  it("Faz 5'e giriş isteği düşürmez: aynı rötuşun yeniden denenmesi ve kesintiden dönüş rötuş kipinde kalır", () => {
    expect(uiTweakStaleOnEnter(AFTER_NO_WRITE_TWEAK, 5)).toBe(false);
  });

  it("öteki fazlara giriş isteğe dokunmaz (kapı fazındaki düzeltme planı dahil)", () => {
    for (const phase of [2, 3, 4, 7, 8, 9, 10, 13, 16, 17]) {
      expect(uiTweakStaleOnEnter(AFTER_NO_WRITE_TWEAK, phase)).toBe(false);
    }
  });

  it("istek yoksa hiçbir fazda bayat sayılacak bir şey yoktur", () => {
    for (const tweak of [undefined, ""]) {
      const st = { pending_ui_tweak: tweak };
      expect(isUiTweakRun(st)).toBe(false);
      expect(uiTweakStaleOnEnter(st, 1)).toBe(false);
      expect(uiTweakStaleOnEnter(st, 6)).toBe(false);
    }
  });
});

// CANLI KANIT (ekransız deneme koşuları 9 ve 10, 2026-11-27): kullanıcının Faz 6'da yazdığı "Kaldığın yerden
// devam et." cümlesi rötuş isteği sayıldı; ajan hiçbir dosyayı değiştirmedi. Faz her seferinde `fail` döndü,
// mahkeme (yaklaşık 2 dk) ve hata analizi koştu. Bir önceki düzeltme (e15911f) "hiçbir şey değişmedi"yi
// ajanın KOMUTLARINI ayrıştırarak kanıtlamaya çalışıyordu ve pratikte hiç tutmadı: ajan her denemede
// `HOME=… git status …` ya da `npm run build` çalıştırıyordu. Hüküm artık dosya durumundan verilir.
//
// Dosya durumu GERÇEK geçici klasörlerde sınanır (hedef projeye dokunulmaz): denetleyicinin yaptığı gibi
// koşudan önce `copySourceTree` ile kaynak kopyası alınır, "ajan" dosya sistemine doğrudan yazarak taklit
// edilir, sonra `changedFilesVsSnapshot` ile karşılaştırılır. Denetleyicinin bu hükmü `no_change` dönüşüne
// ve index.ts'in onu Faz 6 beklemesine çevirmesi (durum yaması, denetim olayı, sohbet mesajı, failPhase
// çağrılmaması) burada KOŞTURULMAZ: o dal gerçek kod üretim ajanı ve çalışan ana döngü ister; bağlantı kod
// okumasıyla incelendi.
describe("sonuçsuz kullanıcı rötuşu — hüküm dosya durumundan", () => {
  const REQUEST = "Kaldığın yerden devam et.";
  const RUN_START = 5_000;
  const USER_AUDIT: AuditEvent[] = [
    { ts: 1_000, phase: 5 as PhaseId, event: "phase-5-complete", caller: "mycl-orchestrator" },
    { ts: 2_000, phase: 6 as PhaseId, event: "ui-tweak-request", caller: "user", detail: REQUEST },
  ];

  let work = "";
  let project = "";
  let probe = "";

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "mycl-tweak-probe-"));
    project = join(work, "proje");
    probe = join(work, "kopya");
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(join(project, "node_modules", "react"), { recursive: true });
    await writeFile(join(project, "package.json"), '{"name":"deneme"}');
    await writeFile(join(project, "index.html"), "<!doctype html><title>Deneme</title>");
    await writeFile(join(project, "src", "App.jsx"), "export default function App() { return null; }");
    await writeFile(join(project, "src", "App.css"), "h1 { color: red; }");
    await writeFile(join(project, "node_modules", "react", "index.js"), "module.exports = {};");
    // Denetleyici koşudan ÖNCE bu kopyayı alır.
    await copySourceTree(project, probe);
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  /** Denetleyicinin "hiç yazma kanıtı yok" dalında yaptığı hesabın aynısı. */
  async function verdict(o: { audit?: AuditEvent[]; tweak?: string; apiWriteErrors?: number; capped?: boolean; noProbe?: boolean } = {}) {
    const audit = o.audit ?? USER_AUDIT;
    const changedFiles = o.noProbe ? null : await changedFilesVsSnapshot({ method: "copy", dir: probe }, project);
    return {
      changedFiles,
      verdict: classifyEmptyTweak({
        userRequested: isUserUiTweakRequest(audit, o.tweak ?? REQUEST),
        blockedWriteAttempts: (o.apiWriteErrors ?? 0) + countDeniedToolCalls(audit, RUN_START),
        changedFiles,
        capped: o.capped ?? false,
      }),
    };
  }

  it("koşu 10: ajan `npm run build` ve `HOME=… git status` çalıştırdı ama hiçbir kaynak dosya değişmedi → no_change", async () => {
    // `npm run build` / `npx vite build` çıktısı ve araç önbellekleri: kaynak sayılmaz.
    await mkdir(join(project, "dist", "assets"), { recursive: true });
    await writeFile(join(project, "dist", "index.html"), "<!doctype html>");
    await writeFile(join(project, "dist", "assets", "index-abc.js"), "console.log(1)");
    await mkdir(join(project, "node_modules", ".vite"), { recursive: true });
    await writeFile(join(project, "node_modules", ".vite", "deps.json"), "{}");
    await mkdir(join(project, ".mycl"), { recursive: true });
    await writeFile(join(project, ".mycl", "audit.log"), "{}"); // MyCL'in kendi kaydı da kaynak değil
    // `git status` hiçbir dosya yazmaz; ajanın hangi komutu çalıştırdığı hükme GİRMEZ.
    const r = await verdict();
    expect(r.changedFiles).toEqual([]);
    expect(r.verdict).toBe("no_change"); // "fail" DEĞİL → failPhase (mahkeme, hata analizi) yolu yok
    // Denetleyicinin bu hükümde verdiği durum yaması: istek boşalır, Faz 6'ya girişte düşecek bayat istek kalmaz.
    const after: Pick<State, "pending_ui_tweak"> = { pending_ui_tweak: undefined };
    expect(isUiTweakRun(after)).toBe(false);
    expect(uiTweakStaleOnEnter(after, 6)).toBe(false);
  });

  it("kabuk komutuyla bir kaynak dosya değişti (`sed -i` taklidi) → no_change DEĞİL, eskisi gibi fail", async () => {
    await writeFile(join(project, "src", "App.css"), "h1 { color: blue; }"); // aynı boyut değil; içerik farkı
    const r = await verdict();
    expect(r.changedFiles).toEqual([join("src", "App.css")]);
    expect(r.verdict).toBe("fail");
  });

  it("aynı boyutta içerik değişikliği de yakalanır (red → tan)", async () => {
    await writeFile(join(project, "src", "App.css"), "h1 { color: tan; }");
    const r = await verdict();
    expect(r.changedFiles).toEqual([join("src", "App.css")]);
    expect(r.verdict).toBe("fail");
  });

  it("yeni kaynak dosya ya da silinen kaynak dosya → fail", async () => {
    await writeFile(join(project, "src", "Yeni.jsx"), "export const x = 1;");
    expect((await verdict()).verdict).toBe("fail");
    await rm(join(project, "src", "Yeni.jsx"));
    expect((await verdict()).verdict).toBe("no_change"); // eski hâline döndü
    await rm(join(project, "src", "App.jsx"));
    const r = await verdict();
    expect(r.changedFiles).toEqual([join("src", "App.jsx")]);
    expect(r.verdict).toBe("fail");
  });

  it("dosya değişmedi ama yazma denemesi ENGELLENDİ (CLI: denetim kaydında engel olayı) → eskisi gibi fail", async () => {
    const denied = (event: string): AuditEvent[] => [
      ...USER_AUDIT,
      { ts: 6_000, phase: 5 as PhaseId, event, caller: "mycl-orchestrator", detail: "Edit src/App.jsx" },
    ];
    expect((await verdict({ audit: denied("overlay_gate_triggered") })).verdict).toBe("fail");
    expect((await verdict({ audit: denied("tool-permission-denied") })).verdict).toBe("fail");
  });

  it("dosya değişmedi ama yazma aracı HATA verdi (API yolu) → eskisi gibi fail", async () => {
    expect((await verdict({ apiWriteErrors: 1 })).verdict).toBe("fail");
  });

  it("önceki koşudan kalan engel olayı bu koşuyu etkilemez", async () => {
    const audit: AuditEvent[] = [
      ...USER_AUDIT,
      { ts: 4_999, phase: 5 as PhaseId, event: "overlay_gate_triggered", caller: "mycl-orchestrator" },
    ];
    expect(countDeniedToolCalls(audit, RUN_START)).toBe(0);
    expect((await verdict({ audit })).verdict).toBe("no_change");
  });

  it("dosya değişmedi ama koşu süre ya da tur tavanına takıldı → eskisi gibi fail", async () => {
    expect((await verdict({ capped: true })).verdict).toBe("fail");
  });

  it("karşılaştırma yapılamadıysa (kopya yok) kanıt yoktur → fail", async () => {
    const r = await verdict({ noProbe: true });
    expect(r.changedFiles).toBeNull();
    expect(r.verdict).toBe("fail");
  });

  it("istek bir DÜZELTME ise (Faz 0 çözümü, Faz 9 riski) dosya değişmese de eskisi gibi fail", async () => {
    const fixPayload = "Fix request: repair the broken import in src/main.jsx";
    expect((await verdict({ audit: [], tweak: fixPayload })).verdict).toBe("fail"); // hiç kullanıcı isteği yok
    expect((await verdict({ tweak: fixPayload })).verdict).toBe("fail"); // alan sonradan düzeltme metniyle dolmuş
  });

  it("kaynak eşleşmesi SON isteğe bakar ve ilk 200 karakteri karşılaştırır", () => {
    const ev = (ts: number, detail: string): AuditEvent => ({
      ts,
      phase: 6 as PhaseId,
      event: "ui-tweak-request",
      caller: "user",
      detail,
    });
    const long = "a".repeat(450);
    expect(isUserUiTweakRequest([ev(1, long.slice(0, 200))], long)).toBe(true);
    const older = [ev(1, REQUEST), ev(2, "başlığı büyüt")];
    expect(isUserUiTweakRequest(older, REQUEST)).toBe(false); // son istek başka
    expect(isUserUiTweakRequest(older, "başlığı büyüt")).toBe(true);
  });
});
