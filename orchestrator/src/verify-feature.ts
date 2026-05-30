// verify-feature — Niyete bağlı gerçek E2E testi üret + çalıştır + dürüst rapor.
//
// v15.8 (2026-05-30): Kullanıcı "X özelliğini test et" dediğinde MyCL artık
// genel bir duman testi çalıştırıp "geçti" demek yerine, O ÖZELLİK için
// hedefli bir Playwright testi yazar (ana ajan), çalıştırır ve dürüstçe
// raporlar.
//
// Mimari kural: orkestratör (TR) bu handler'ı çağırır; özellik ifadesi
// translator ile EN'e çevrilir; ana/codegen ajan SADECE İngilizce çalışır.
//
// Dürüstlük ilkesi: yanlış yeşil ÜRETME. Ajan özelliği bulamazsa test
// dosyası yazmaz → handler bunu tespit edip "bulamadım" der. Trivial
// sayfa-yükleme testi prompt'ta yasak.

import { exec } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendAudit } from "./audit.js";
import { createCodegenBackend } from "./codegen/backend.js";
import type { ToolDef } from "./claude-api.js";
import type { MyclConfig } from "./config.js";
import { tryDevServerChain } from "./dev-server-launcher.js";
import { isProcessAliveSync } from "./process-utils.js";
import { clearHistory } from "./history.js";
import {
  commandsFor,
  detectStack,
  expectedPortsFor,
  readNodeScripts,
} from "./intent-router/handlers/command.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import { buildCodebaseSnapshot } from "./phase-1-codebase-probe.js";
import {
  assessPhase16Verification,
  ensureAuthTemplate,
  ensurePlaywrightInstalled,
  ensurePlaywrightScaffold,
} from "./playwright-setup.js";
import { loadProfile } from "./profile-loader.js";
import { TOOLS_CODEGEN, type ToolContext } from "./tool-handlers.js";
import { translate } from "./translator.js";
import type { State } from "./types.js";

const execAsync = promisify(exec);
const TEST_RUN_TIMEOUT_MS = 90_000;
const DEV_SERVER_TIMEOUT_MS = 20_000;
/** Codegen + run için ayrılan phase history slotu (16 = E2E). */
const VERIFY_PHASE_ID = 16 as const;

export interface VerifyFeatureResult {
  /** index.ts state'e merge edip persist eder (dev server başlatıldıysa pid). */
  statePatch?: Partial<State>;
  /**
   * v15.8 (2026-05-30): Gerçek test başarısızlığında dead-end yerine çözüm
   * devri. index.ts bunu görürse debug_triage'ı (Faz 0 D1) bugReport ile
   * başlatır — kök neden araştırması + fix. Kullanıcı kuralı: "çözümsüz
   * bırakmamalı."
   */
  followUp?: { kind: "debug_triage"; bugReport: string };
}

/**
 * Gerçek test başarısızlığını Faz 0 D1'in doğru araştıracağı bir bug raporuna
 * çevirir. Test mock kullanmadığı için fail = gerçek sinyal; D1 "özellik mi
 * bozuk, test mi hatalı" ayrımını yapsın diye yönergeli.
 */
export function buildFailureBugReport(
  featureTr: string,
  specRel: string,
  errorSnippet: string,
): string {
  return [
    `"${featureTr}" özelliği için otomatik üretilen E2E testi (${specRel}) BAŞARISIZ oldu.`,
    `Bu test MOCK KULLANMIYOR — gerçek uygulamayı/backend'i test ediyor, yani bu gerçek bir hata sinyali.`,
    ``,
    `Hata çıktısı:`,
    errorSnippet || "(çıktı yok)",
    ``,
    `CERRAHİ ol: Hatada adı geçen yolu/komponenti (örn. başarısız HTTP isteğinin route handler'ı veya ilgili component) DOĞRUDAN oku ve kök nedeni adlandır. Neden UYGULAMA KODUNDADIR — OS/process forensiği (lsof, ps, dosya handle) YAPMA. Özellik mi bozuk, test mi hatalı ayır; uygun düzeltmeyi öner. Birkaç dosya okuyunca yeterli bilgin olur — uzun keşfe dalma.`,
  ].join("\n");
}

/** "Anket Oluşturma Sayfası" → "anket-olusturma-sayfasi" güvenli dosya adı. */
export function slugifyFeature(text: string): string {
  const map: Record<string, string> = {
    ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u",
    Ç: "c", Ğ: "g", İ: "i", Ö: "o", Ş: "s", Ü: "u",
  };
  const ascii = text.replace(/[çğıöşüÇĞİÖŞÜ]/g, (m) => map[m] ?? m);
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return slug || "ozellik";
}

/**
 * Üretilen testte ağ-mock'lama (sahte cevap) var mı? Yanlış-yeşil önleme.
 * route.fulfill/abort = sahte response; page.route/context.route = intercept;
 * MSW/vi.mock/jest.mock = modül/sunucu mock. Herhangi biri → gerçek doğrulama
 * DEĞİL.
 */
export function containsMocking(content: string): boolean {
  return /page\.route\s*\(|context\.route\s*\(|\.fulfill\s*\(|\.abort\s*\(|routeFromHAR|setupServer|mockResponse|\bvi\.mock\b|\bjest\.mock\b/.test(
    content,
  );
}

/** Üretilen spec'ten `test('...')` / `test("...")` başlıklarını çıkar. */
export function extractTestTitles(content: string): string[] {
  const titles: string[] = [];
  const re = /\btest(?:\.\w+)?\s*\(\s*(['"`])([^'"`]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[2]) titles.push(m[2].trim());
    if (titles.length >= 10) break;
  }
  return titles;
}

/** Dosyayı oku; okunamazsa boş string (guard'lar boş içerikte false döner). */
async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

function buildSystemPrompt(
  featureEn: string,
  slug: string,
  snapshot: string,
  authConfigured: boolean,
): string {
  return `You are MyCL Studio's feature-verification agent. Write ONE Playwright E2E test that GENUINELY exercises a specific feature in the running app, then stop.

FEATURE TO TEST (English): ${featureEn}

HARD RULES:
- Write the test to EXACTLY this path: tests/${slug}.spec.ts
- The file's FIRST line must be exactly: // MyCL generated E2E
- Use Read / Grep / Glob to LOCATE the real page, route, and component for this feature in this project. Do NOT guess selectors blindly — ground every selector in what you actually find in the code.
- **NO MOCKING — ABSOLUTELY FORBIDDEN.** Do NOT intercept, stub, fake, or mock the application's own API. That means: NO \`page.route(...)\`, NO \`route.fulfill(...)\`, NO \`route.abort(...)\`, NO \`routeFromHAR\`, NO MSW / \`setupServer\` / \`mockResponse\`, NO \`vi.mock\` / \`jest.mock\`. The test MUST hit the REAL running backend. A test that fakes a 201 success and asserts the resulting toast is a LIE — it proves nothing about whether the feature works.
- **SUCCESS = PERSISTED END STATE, observed independently.** The test MUST do: (1) navigate to the feature's page, (2) perform the REAL user action (fill the form, click submit/create) — with a UNIQUE value (e.g. include Date.now() in the text), (3) then NAVIGATE to where the created item should appear (e.g. the list page) and ASSERT that the new item is actually there (e.g. the unique text appears in a list card/row). A success message / toast ALONE is NOT acceptable — the frontend can show it even when nothing was really saved.
- A trivial page-load or title-only test is FORBIDDEN.
- baseURL is set in playwright.config.ts — use relative navigation (page.goto('/...')).
${
  authConfigured
    ? `- This app requires login. Read .mycl/auth.json and replicate the login flow from tests/smoke.spec.ts (go to loginPath, fill username/password from auth.json, submit, wait for redirect) BEFORE testing the feature.`
    : `- No login credentials are configured (.mycl/auth.json has placeholders or is missing). If the feature is behind login, note that the test may stop at the login wall — still write the most meaningful test you can for the public part.`
}

IF YOU CANNOT FIND OR CANNOT REALLY TEST THE FEATURE:
- If you genuinely cannot locate this feature in the codebase (no matching page/route/component), OR you cannot verify it against the REAL backend without mocking, DO NOT fabricate a test and DO NOT write the file. Instead, end your turn with a short plain-text explanation. The absence of the file is the signal that the feature could not be verified. NEVER mock to make a green test — an honest "couldn't verify" is far better than a fake pass.

RATIONALIZATIONS → REBUTTALS (do NOT fall for these):
- "I'll mock the API so the test is reliable." → A mocked API tests your mock, not the feature. FORBIDDEN. Hit the real backend or write no file.
- "A success toast appeared, so it worked." → The frontend can show a toast even when nothing was saved. Navigate to the list and assert the unique value is actually there.
- "I can't find the exact selector, I'll guess one." → Guessed selectors create flaky fake-greens. Ground every selector in code you read; if you can't, explain instead of guessing.
- "A page-load/title check is good enough to pass." → It proves nothing about the feature. FORBIDDEN.

RED FLAGS — stop and reconsider if you are about to:
- type \`page.route\`, \`route.fulfill\`, \`vi.mock\`, \`jest.mock\`, or set up MSW;
- assert only on a toast/success message and not on persisted state;
- write the file despite not having located the real page/route/component.

VERIFICATION — "seems right" is never enough:
- The action uses a UNIQUE value (e.g. Date.now()) so the assertion cannot pass on stale data.
- Success is proven by re-navigating and finding that unique value persisted, observed independently of the submit response.
- Every selector traces to code you actually read in this project.

APP STRUCTURE (auto-generated snapshot):
${snapshot}

Work: explore with Read/Grep, then Write tests/${slug}.spec.ts (or explain why you can't). Use Bash only to inspect (e.g. ls); do NOT run the test yourself — MyCL runs it after you finish.`;
}

interface TestRunResult {
  ok: boolean;
  output: string;
}

async function runGeneratedTest(
  projectRoot: string,
  specRelPath: string,
): Promise<TestRunResult> {
  try {
    const { stdout, stderr } = await execAsync(
      `npx --no-install playwright test ${specRelPath} --reporter=line`,
      { cwd: projectRoot, timeout: TEST_RUN_TIMEOUT_MS, maxBuffer: 2_000_000 },
    );
    return { ok: true, output: (stdout || "") + (stderr ? `\n${stderr}` : "") };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output =
      (e.stdout || "") + (e.stderr ? `\n${e.stderr}` : "") + (e.message ? `\n${e.message}` : "");
    return { ok: false, output };
  }
}

/**
 * Dev server canlı değilse başlatmayı dene. Canlıysa no-op.
 * Döner: { alive, statePatch? } — yeni başlatıldıysa pid statePatch'te.
 */
async function ensureDevServerAlive(
  state: State,
): Promise<{ alive: boolean; statePatch?: Partial<State> }> {
  if (state.dev_server_pid && isProcessAliveSync(state.dev_server_pid)) {
    return { alive: true };
  }
  // Başlatmayı dene — Phase 5 ile aynı aday-komut zinciri.
  const stack = detectStack(state.project_root);
  const scripts = readNodeScripts(state.project_root);
  const cmds = commandsFor(stack, "run", scripts);
  if (cmds.length === 0) return { alive: false };
  const candidates = cmds.map((cmd) => ({
    cmd,
    ports: expectedPortsFor(cmd, scripts, state.project_root),
  }));
  emitChatMessage(
    "system",
    "Uygulama çalışmıyor — başlatmayı deniyorum…",
  );
  const chain = await tryDevServerChain(
    state.project_root,
    candidates,
    DEV_SERVER_TIMEOUT_MS,
  );
  if (chain.ok && chain.handle) {
    return {
      alive: true,
      statePatch: { dev_server_pid: chain.handle.pid },
    };
  }
  return { alive: false };
}

/**
 * Ana giriş — orkestratör `verify_feature` action'ında çağırır.
 * targetFeatureTr: kullanıcının dilindeki özellik ifadesi (Türkçe).
 */
export async function verifyFeatureHandler(
  targetFeatureTr: string,
  deps: { state: State; config: MyclConfig },
): Promise<VerifyFeatureResult> {
  const { state, config } = deps;
  emitChatMessage(
    "system",
    `🔬 "${targetFeatureTr}" özelliği için gerçek bir test yazıp çalıştıracağım…`,
  );

  // 1. TR → EN (ana ajan İngilizce çalışır)
  let featureEn: string;
  try {
    const tr = await translate(config, targetFeatureTr, "tr-to-en");
    featureEn = tr.text.trim() || targetFeatureTr;
  } catch (err) {
    log.warn("verify-feature", "translate failed; using TR text", err);
    featureEn = targetFeatureTr;
  }

  // 2. Dev server canlı mı / başlat
  const dev = await ensureDevServerAlive(state);
  if (!dev.alive) {
    emitChatMessage(
      "system",
      "❌ Uygulamayı çalıştıramadım. Önce üst menüden ▶ Çalıştır ile başlat, sonra tekrar dene.",
    );
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: VERIFY_PHASE_ID,
      event: "verify-feature-no-server",
      caller: "mycl-orchestrator",
      detail: targetFeatureTr.slice(0, 120),
    });
    return {};
  }

  // 3. Playwright + scaffold + auth (mevcut yardımcılar)
  if (state.stack?.startsWith("node-")) {
    await ensurePlaywrightInstalled(state.project_root, state.stack);
  }
  let defaultPort = 5173;
  try {
    const profile = state.stack ? await loadProfile(state.stack) : null;
    if (profile?.default_port) defaultPort = profile.default_port;
  } catch {
    /* default kalsın */
  }
  await ensurePlaywrightScaffold(state.project_root, defaultPort);
  await ensureAuthTemplate(state.project_root);
  const pre = await assessPhase16Verification(state.project_root);
  const authConfigured = pre.authStatus === "configured";
  if (pre.authStatus === "placeholder") {
    emitChatMessage(
      "system",
      "ℹ️ Not: Giriş bilgisi yer tutucu (`.mycl/auth.json`). Özellik girişin arkasındaysa test giriş duvarında durabilir; gerçek giriş için bilgileri doldur.",
    );
  }

  // 4. Kodbase bağlamı
  const snapshot = await buildCodebaseSnapshot(state.project_root);
  const slug = slugifyFeature(featureEn);
  const specRel = join("tests", `${slug}.spec.ts`);
  const specAbs = join(state.project_root, specRel);

  const toolCtx: ToolContext = { project_root: state.project_root };
  const modelId = config.selected_models.main;
  const apiKey = config.api_keys.main;

  // 5. Test üretimi (ilk deneme) — fresh history
  await clearHistory(state.project_root, VERIFY_PHASE_ID);
  await runCodegen(
    buildSystemPrompt(featureEn, slug, snapshot, authConfigured),
    `Write the Playwright E2E test for: ${featureEn}. Target file: ${specRel}.`,
    { state, config, modelId, apiKey, toolCtx },
  );

  // Ajan dosyayı yazmadıysa → özelliği bulamadı (dürüst).
  if (!(await fileExists(specAbs))) {
    emitChatMessage(
      "system",
      `ℹ️ "${targetFeatureTr}" özelliğini kodda bulamadım, anlamlı bir test yazamadım. (Sayfa/rota mevcut değil ya da farklı adlandırılmış olabilir.) Sahte bir "geçti" üretmek yerine dürüstçe söylüyorum.`,
    );
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: VERIFY_PHASE_ID,
      event: "verify-feature-not-found",
      caller: "mycl-orchestrator",
      detail: featureEn.slice(0, 120),
    });
    return { statePatch: dev.statePatch };
  }

  // 5b. MOCK-GUARD — yanlış-yeşil önleme. Ajan backend'i mock'ladıysa test
  // gerçek doğrulama değil; bir kez düzeltici üretim, hâlâ mock'luysa reddet.
  let specContent = await safeRead(specAbs);
  if (containsMocking(specContent)) {
    emitChatMessage(
      "system",
      "⚠ Üretilen test backend'i mock'lamış (sahte cevap) — gerçek doğrulama değil. Mock'suz, kalıcı durumu doğrulayan bir test için yeniden deniyorum…",
    );
    await clearHistory(state.project_root, VERIFY_PHASE_ID);
    await runCodegen(
      buildSystemPrompt(featureEn, slug, snapshot, authConfigured) +
        `\n\nYOUR PREVIOUS ATTEMPT USED MOCKING (page.route/route.fulfill/etc.) — THIS IS FORBIDDEN AND INVALID. Rewrite tests/${slug}.spec.ts with NO mocking at all: hit the real backend, and verify the PERSISTED result by navigating to the list/where the item appears and asserting the new item (unique text) is really there.`,
      `Rewrite ${specRel} for: ${featureEn}. NO mocking — real backend + persisted-state assertion.`,
      { state, config, modelId, apiKey, toolCtx },
    );
    specContent = await safeRead(specAbs);
    if (containsMocking(specContent)) {
      emitChatMessage(
        "system",
        `❌ "${targetFeatureTr}" için gerçek (mock'suz) bir test üretemedim — ajan ısrarla backend'i mock'ladı. Sahte bir "geçti" üretmektense dürüstçe söylüyorum: bu özelliği gerçekten doğrulayamadım.`,
      );
      await appendAudit(state.project_root, {
        ts: Date.now(),
        phase: VERIFY_PHASE_ID,
        event: "verify-feature-mock-rejected",
        caller: "mycl-orchestrator",
        detail: featureEn.slice(0, 120),
      });
      return { statePatch: dev.statePatch };
    }
  }

  // 6. Çalıştır
  emitChatMessage("system", `▶ Test çalıştırılıyor: \`${specRel}\`…`);
  let run = await runGeneratedTest(state.project_root, specRel);

  // 7. Fail → tek tamir denemesi (gerçek hata çıktısıyla)
  if (!run.ok) {
    emitChatMessage(
      "system",
      "Test başarısız oldu — bir kez düzeltmeyi deniyorum (selector/assertion gerçek uygulamaya göre)…",
    );
    await clearHistory(state.project_root, VERIFY_PHASE_ID);
    await runCodegen(
      buildSystemPrompt(featureEn, slug, snapshot, authConfigured) +
        `\n\nPREVIOUS ATTEMPT FAILED. The test at ${specRel} produced this output:\n<<<\n${run.output.slice(-1500)}\n>>>\nRead the existing file and the app, then fix the selectors/assertions so the test correctly exercises the feature. If the FEATURE itself looks broken (not the test), keep the test correct so it reports the real failure.`,
      `Fix the failing test at ${specRel} for: ${featureEn}.`,
      { state, config, modelId, apiKey, toolCtx },
    );
    run = await runGeneratedTest(state.project_root, specRel);
  }

  // 8. Dürüst rapor
  await appendAudit(state.project_root, {
    ts: Date.now(),
    phase: VERIFY_PHASE_ID,
    event: run.ok ? "verify-feature-pass" : "verify-feature-fail",
    caller: "mycl-orchestrator",
    detail: `feature="${featureEn.slice(0, 80)}" spec=${specRel}${run.ok ? "" : " → debug_triage"}`,
  });
  if (run.ok) {
    // v15.8: Hardcode abartı YOK. Testin gerçek başlıklarını listele —
    // kullanıcı NE doğrulandığını görsün (mock-guard geçtiği için anlamlı).
    const titles = extractTestTitles(specContent);
    const titlesBlock =
      titles.length > 0
        ? `\n\nDoğrulanan senaryolar:\n${titles.map((t) => `• ${t}`).join("\n")}`
        : "";
    emitChatMessage(
      "system",
      `✅ "${targetFeatureTr}" için mock'suz, gerçek backend'e giden bir test yazıp çalıştırdım — **GEÇTİ**.${titlesBlock}\n\nTesti \`${specRel}\` içinde inceleyebilirsin.`,
    );
  } else {
    // v15.8 (2026-05-30): Dead-end YOK. Gerçek (mock'suz) test fail etti =
    // gerçek hata sinyali → kök nedeni araştırmaya devret (kullanıcı kuralı:
    // "çözümsüz bırakmamalı"). index.ts followUp'ı görüp Faz 0 D1'i başlatır.
    const snippet = extractFailSnippet(run.output);
    emitChatMessage(
      "system",
      `❌ "${targetFeatureTr}" testi **BAŞARISIZ** — test gerçek bir hata yakaladı (mock yok).${snippet ? `\n\nHata özeti:\n${snippet}` : ""}\n\n🔎 Kök nedeni araştırıp çözüm öneriyorum…`,
    );
    return {
      statePatch: dev.statePatch,
      followUp: {
        kind: "debug_triage",
        bugReport: buildFailureBugReport(targetFeatureTr, specRel, snippet),
      },
    };
  }
  return { statePatch: dev.statePatch };
}

interface CodegenDeps {
  state: State;
  config: MyclConfig;
  modelId: string;
  apiKey: string;
  toolCtx: ToolContext;
}

async function runCodegen(
  systemPrompt: string,
  initialUserMessage: string,
  deps: CodegenDeps,
): Promise<void> {
  const controller = createCodegenBackend({
    tag: "verify-feature",
    phaseId: VERIFY_PHASE_ID,
    state: deps.state,
    config: deps.config,
    systemPrompt,
    modelId: deps.modelId,
    apiKey: deps.apiKey,
    initialUserMessage,
    tools: TOOLS_CODEGEN as unknown as ToolDef[],
    allowed_tool_names: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
    toolContext: deps.toolCtx,
    betas: deps.config.claude_code_flags.betas,
  });
  const outcome = await controller.run();
  log.info("verify-feature", "codegen outcome", { kind: outcome.kind });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Playwright çıktısından kullanıcıya gösterilecek kısa hata özeti. */
function extractFailSnippet(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  // "Error:", "expect(", "✘", "failed" geçen ilk birkaç satır.
  const interesting = lines.filter((l) =>
    /error|expect|✘|×|fail|timeout|not found/i.test(l),
  );
  return (interesting.length > 0 ? interesting : lines.slice(-6))
    .slice(0, 6)
    .join("\n")
    .slice(0, 500);
}
