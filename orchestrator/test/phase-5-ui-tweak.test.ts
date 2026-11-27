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

import { describe, expect, it } from "vitest";
import {
  classifyEmptyTweak,
  countDeniedToolCalls,
  isProvablyReadOnlyShell,
  isProvablyReadOnlyToolUse,
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

// CANLI KANIT (ekransız deneme koşusu 9, 2026-11-27): kullanıcının Faz 6'da yazdığı "Kaldığın yerden devam
// et." cümlesi rötuş isteği sayıldı. Ajan yalnız `git status`, `git log`, `find`, `cat` çağırdı; yazmayı
// hiç denemedi. Faz iki kez `fail` döndü, her seferinde mahkeme (yaklaşık 2 dk) ve hata analizi koştu.
//
// Hüküm saf işlevlerden çıkar. Denetleyicinin bu hükmü `no_change` dönüşüne ve index.ts'in onu Faz 6
// beklemesine çevirmesi (durum yaması, denetim olayı, sohbet mesajı, failPhase çağrılmaması) burada
// KOŞTURULMAZ: o dal gerçek kod üretim ajanı ve çalışan ana döngü ister; bağlantı kod okumasıyla incelendi.
describe("sonuçsuz kullanıcı rötuşu — başarısızlık değil", () => {
  const REQUEST = "Kaldığın yerden devam et.";
  const RUN_START = 5_000;

  function ev(event: string, ts: number, detail?: string, phase = 5): AuditEvent {
    return { ts, phase: phase as PhaseId, event, caller: "mycl-orchestrator", detail };
  }

  type Call = { name: string; input: Record<string, unknown> };
  const bash = (command: string): Call => ({ name: "Bash", input: { command } });
  /** Koşu 9'da ajanın yaptığı türden çağrılar: yalnız okuma. */
  const RUN9_CALLS: Call[] = [
    bash("git status"),
    bash("git log --oneline -5"),
    bash("find . -name '*.jsx' -not -path './node_modules/*'"),
    bash("cat src/App.jsx"),
  ];

  /** Denetleyicinin "hiç yazma kanıtı yok" dalında yaptığı hesabın aynısı. */
  function verdict(
    audit: AuditEvent[],
    tweak: string,
    o: { apiWriteErrors?: number; calls?: Call[]; capped?: boolean } = {},
  ): "no_change" | "fail" {
    return classifyEmptyTweak({
      userRequested: isUserUiTweakRequest(audit, tweak),
      blockedWriteAttempts: (o.apiWriteErrors ?? 0) + countDeniedToolCalls(audit, RUN_START),
      unprovenToolCalls: (o.calls ?? RUN9_CALLS).filter((c) => !isProvablyReadOnlyToolUse(c)).length,
      capped: o.capped ?? false,
    });
  }

  it("koşu 9: kullanıcı isteği + yazma denemesi yok → no_change; istek tüketilince rötuş kipi biter", () => {
    const audit = [ev("phase-5-complete", 1_000), ev("ui-tweak-request", 2_000, REQUEST, 6)];
    expect(verdict(audit, REQUEST)).toBe("no_change"); // "fail" DEĞİL → failPhase (mahkeme, hata analizi) yolu yok
    // Denetleyicinin bu hükümde verdiği durum yaması: istek boşalır.
    const before: Pick<State, "pending_ui_tweak"> = { pending_ui_tweak: REQUEST };
    const after: Pick<State, "pending_ui_tweak"> = { ...before, pending_ui_tweak: undefined };
    expect(isUiTweakRun(after)).toBe(false);
    // Akış Faz 6'ya geçerken düşürülecek bayat istek de kalmamıştır (çift mesaj yok).
    expect(uiTweakStaleOnEnter(after, 6)).toBe(false);
  });

  it("yazma denemesi ENGELLENDİ (CLI yolu: denetim kaydında engel olayı) → eskisi gibi fail", () => {
    const base = [ev("ui-tweak-request", 2_000, REQUEST, 6)];
    expect(verdict([...base, ev("overlay_gate_triggered", 6_000, "Edit src/App.jsx")], REQUEST)).toBe("fail");
    expect(verdict([...base, ev("tool-permission-denied", 6_000, "Bash")], REQUEST)).toBe("fail");
  });

  it("yazma denemesi HATA verdi (API yolu: gözlemcinin saydığı hatalı yazma çağrısı) → eskisi gibi fail", () => {
    expect(verdict([ev("ui-tweak-request", 2_000, REQUEST, 6)], REQUEST, { apiWriteErrors: 1 })).toBe("fail");
  });

  it("kabuk komutuyla yazma (kanıt bırakmaz) 'dokunulmadı' sayılmaz → eskisi gibi fail", () => {
    const audit = [ev("ui-tweak-request", 2_000, REQUEST, 6)];
    expect(verdict(audit, REQUEST, { calls: [...RUN9_CALLS, bash("sed -i 's/red/blue/' src/App.css")] })).toBe("fail");
    expect(verdict(audit, REQUEST, { calls: [bash("echo x > src/App.css")] })).toBe("fail");
    expect(verdict(audit, REQUEST, { calls: [bash("npm run build")] })).toBe("fail");
    // Çıkış kodu sıfırdan farklı olsa da (derleme kırıldı) dosya değişmiş olabilir: sayım hata sonucundan bağımsız.
    expect(verdict(audit, REQUEST, { calls: [bash("sed -i 's/red/blue/' src/App.css && npm run build")] })).toBe("fail");
    expect(verdict(audit, REQUEST, { calls: [bash("git diff --output=src/App.css")] })).toBe("fail");
    // Tanınmayan araç (ör. MCP) salt okunur olduğu kanıtlanamaz.
    expect(verdict(audit, REQUEST, { calls: [{ name: "mcp__fs__write_file", input: {} }] })).toBe("fail");
  });

  it("süre ya da tur tavanına takılan koşu 'değişiklik çıkmadı' sayılmaz → eskisi gibi fail", () => {
    expect(verdict([ev("ui-tweak-request", 2_000, REQUEST, 6)], REQUEST, { capped: true })).toBe("fail");
  });

  it("hiç araç çağırmadan biten kullanıcı isteği → no_change", () => {
    expect(verdict([ev("ui-tweak-request", 2_000, REQUEST, 6)], REQUEST, { calls: [] })).toBe("no_change");
  });

  it("önceki koşudan kalan engel olayı bu koşuyu etkilemez", () => {
    const audit = [ev("ui-tweak-request", 2_000, REQUEST, 6), ev("overlay_gate_triggered", 4_999, "Edit x")];
    expect(countDeniedToolCalls(audit, RUN_START)).toBe(0);
    expect(verdict(audit, REQUEST)).toBe("no_change");
  });

  it("istek bir DÜZELTME ise (Faz 0 çözümü, Faz 9 riski) yazma yokluğu eskisi gibi fail", () => {
    const fixPayload = "Fix the broken import in src/main.jsx";
    // Hiç kullanıcı isteği yok.
    expect(verdict([], fixPayload)).toBe("fail");
    // Daha önce kullanıcı başka bir şey istemiş; alan sonradan düzeltme metniyle doldurulmuş.
    expect(verdict([ev("ui-tweak-request", 2_000, REQUEST, 6)], fixPayload)).toBe("fail");
  });

  it("kaynak eşleşmesi SON isteğe bakar ve ilk 200 karakteri karşılaştırır", () => {
    const long = "a".repeat(450);
    expect(isUserUiTweakRequest([ev("ui-tweak-request", 1, long.slice(0, 200), 6)], long)).toBe(true);
    const older = [ev("ui-tweak-request", 1, REQUEST, 6), ev("ui-tweak-request", 2, "başlığı büyüt", 6)];
    expect(isUserUiTweakRequest(older, REQUEST)).toBe(false); // son istek başka
    expect(isUserUiTweakRequest(older, "başlığı büyüt")).toBe(true);
  });
});

describe("isProvablyReadOnlyShell / isProvablyReadOnlyToolUse", () => {
  it("okuma komutları ve bunların boru / && zinciri salt okunurdur", () => {
    for (const cmd of [
      "git status",
      "git log --oneline -5",
      "git diff HEAD~1",
      "ls -la src",
      "cat src/App.jsx",
      "find . -name '*.css' -not -path './node_modules/*'",
      "cat src/App.jsx 2>/dev/null | head -50",
      "ls src 2>&1 | wc -l",
      "pwd && ls",
    ]) {
      expect(isProvablyReadOnlyShell(cmd), cmd).toBe(true);
    }
  });

  it("yazabilen, komut çalıştıran ya da tanınmayan her şey kuşkuda false", () => {
    for (const cmd of [
      "",
      "sed -i 's/a/b/' src/App.css",
      "echo x > src/App.css",
      "cat a >> b",
      "npm run build",
      "node scripts/gen.js",
      "rm -rf dist",
      "cat x | tee y",
      "ls && touch y",
      "find . -name '*.tmp' -delete",
      "find . -name '*.js' -exec sed -i s/a/b/ {} +",
      "git checkout -- .",
      "git stash",
      "cat $(ls)",
      "grep -r foo src",
      "cd src",
      // Mahkeme bulguları (2026-11-27): tabandaki güvenli komut denetiminden geçen ama yazan komutlar.
      "git diff --output=src/App.css",
      "git log --output=src/App.css",
      "cat src/App.jsx\nsed -i 's/red/blue/' src/App.css",
      "cat src/App.jsx & sed -i 's/red/blue/' src/App.css",
      "find src -name '*.css' '-delete'",
      "find src -name '*.css' '-exec' sed -i s/red/blue/ '{}' +",
      "git config user.name x",
      "git branch -D main",
      "git remote remove origin",
      "git -c core.pager=less log",
      "cat x 2>/dev/nullX",
    ]) {
      expect(isProvablyReadOnlyShell(cmd), cmd).toBe(false);
    }
  });

  it("araç adına göre: okuma araçları true; yazma, alt ajan ve tanınmayan araç false", () => {
    for (const name of ["Read", "Grep", "Glob", "LS", "TodoWrite"]) {
      expect(isProvablyReadOnlyToolUse({ name, input: {} }), name).toBe(true);
    }
    for (const name of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task", "WebFetch", "mcp__x__y"]) {
      expect(isProvablyReadOnlyToolUse({ name, input: {} }), name).toBe(false);
    }
    expect(isProvablyReadOnlyToolUse({ name: "Bash", input: {} })).toBe(false); // komut yok → kanıt yok
    expect(isProvablyReadOnlyToolUse({ name: "Bash", input: { command: "git status" } })).toBe(true);
  });
});
