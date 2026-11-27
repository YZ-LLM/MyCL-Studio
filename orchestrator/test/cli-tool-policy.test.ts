// cli-tool-policy — `claude` başlatıcılarının (cli-run, cli-session) argv'sinde araç politikası.
//
// CANLI KANIT (ekransız deneme koşusu 6, 2026-11-27): ilgililik sınıflandırıcısı `disallowedTools`
// vermeden çağrılıyordu → `--permission-mode bypassPermissions` altında Write/Edit/Bash açık kaldı,
// model MyCL'in başlatıldığı klasöre 10 dosya yazdı. Bu dosya şunu kilitler: politika VERİLMEYEN
// çağrı tam yetkili argv üretmez (araçsız sayılır); politika VEREN çağrının argv'si değişmez.
//
// Gerçek `claude` süreci başlatılmaz: yalnız argv üreten saf işlevler çağrılır. Kum havuzu politikası
// "off" yapılır ki ayar üretimi ev dizinini listelemesin (argv'nin `--settings` kısmı bu testin konusu değil).

import { beforeAll, describe, expect, it } from "vitest";
import { setSandboxPolicy } from "../src/agent-sandbox.js";
import { buildCliRunArgs, type CliRunOpts } from "../src/cli-run.js";
import { buildCliSessionArgs, type CliSessionTurnOpts } from "../src/cli-session.js";
import {
  DANGEROUS_BASH_DENY,
  PURE_REASONING_DISALLOWED_TOOLS,
  READ_ONLY_DISALLOWED_TOOLS,
  ZERO_TOOLS_DISALLOWED,
  withDangerousBashDeny,
} from "../src/tool-policy.js";

/** argv içinde `--disallowedTools` bayrağından sonraki değerler (bir sonraki `--bayrak`a kadar). */
function denyList(args: string[]): string[] {
  const i = args.indexOf("--disallowedTools");
  expect(i).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (let j = i + 1; j < args.length && !args[j]!.startsWith("--"); j++) out.push(args[j]!);
  return out;
}

/** Yazma, kabuk, alt ajan, okuma ve ağ: hiçbiri açık kalmamalı. */
const TAM_YETKI_ARACLARI = ["Write", "Edit", "NotebookEdit", "Bash", "Agent", "Task", "Read", "Grep", "Glob", "WebFetch", "WebSearch"];

const runBase = {
  systemPrompt: "s",
  userMessage: "u",
  modelId: "m",
  cwd: "/tmp/mycl-arac-politikasi",
};

const sessionBase = {
  sessionId: "00000000-0000-4000-8000-000000000000",
  resume: false,
  userMessage: "u",
  systemPrompt: "s",
  modelId: "m",
  cwd: "/tmp/mycl-arac-politikasi",
};

beforeAll(() => {
  setSandboxPolicy("off");
});

describe("buildCliRunArgs — araç politikası", () => {
  it("politika VERİLMEYEN çağrı tam yetkili argv üretmez: araçsız sayılır", () => {
    // Tip alanı zorunlu kılar; burada tipin göremediği yol (cast) taklit edilir.
    const args = buildCliRunArgs(runBase as unknown as CliRunOpts, null);
    expect(args).toContain("bypassPermissions"); // izin kipi değişmedi: engel yalnız deny-list
    const deny = denyList(args);
    for (const tool of TAM_YETKI_ARACLARI) expect(deny).toContain(tool);
    for (const tool of ZERO_TOOLS_DISALLOWED) expect(deny).toContain(tool);
    for (const tool of DANGEROUS_BASH_DENY) expect(deny).toContain(tool);
  });

  it("regresyon kilidi: politika veren çağrının deny-list'i eskisiyle birebir aynı", () => {
    for (const policy of [READ_ONLY_DISALLOWED_TOOLS, PURE_REASONING_DISALLOWED_TOOLS, ZERO_TOOLS_DISALLOWED, ["Bash", "Agent", "Task"]]) {
      const deny = denyList(buildCliRunArgs({ ...runBase, disallowedTools: policy }, null));
      expect(deny).toEqual(withDangerousBashDeny(policy));
    }
  });

  it("salt okunur politika genişlemez: Bash ve okuma araçları açık kalır", () => {
    const deny = denyList(buildCliRunArgs({ ...runBase, disallowedTools: READ_ONLY_DISALLOWED_TOOLS }, null));
    expect(deny).not.toContain("Bash");
    expect(deny).not.toContain("Read");
    expect(deny).toContain("Write");
  });

  it("açıkça verilen boş liste çağıranın kararıdır: yalnız tehlikeli Bash tabanı", () => {
    const deny = denyList(buildCliRunArgs({ ...runBase, disallowedTools: [] }, null));
    expect(deny).toEqual(DANGEROUS_BASH_DENY);
  });
});

describe("buildCliSessionArgs — araç politikası", () => {
  it("politika VERİLMEYEN tur tam yetkili argv üretmez: araçsız sayılır", () => {
    const args = buildCliSessionArgs(sessionBase as unknown as CliSessionTurnOpts, null);
    expect(args).toContain("bypassPermissions");
    const deny = denyList(args);
    for (const tool of TAM_YETKI_ARACLARI) expect(deny).toContain(tool);
  });

  it("regresyon kilidi: politika veren turun deny-list'i eskisiyle birebir aynı", () => {
    for (const policy of [PURE_REASONING_DISALLOWED_TOOLS, ["Write", "Edit", "NotebookEdit"]]) {
      const deny = denyList(buildCliSessionArgs({ ...sessionBase, disallowedTools: policy }, null));
      expect(deny).toEqual(withDangerousBashDeny(policy));
    }
  });
});
