// dev-server-command — dev-server aday-komut zinciri, PROFİL `dev` öncelikli (KATI #1 tek-kaynak).
//
// Neden (YZLLM 2026-07-14, güvenilirlik denetimi): `commandsFor(stack,"run",scripts)` (intent-router hardcode
// switch) non-Node stack'lerde stack profillerinden SAPMIŞTI — profil `dev` anahtarı (18 profilde tanımlı, ör.
// python-pip `python -m uvicorn main:app --reload`, ruby `bundle exec rackup`, elixir `mix phx.server`) HİÇ
// okunmuyordu (`resolveCommand(profile,"dev")` hiçbir yerde çağrılmıyordu). commandsFor'un `run` dalı bunun yerine
// `python main.py` / `bundle exec ruby main.rb` / `mix run --no-halt` gibi web-server BAŞLATMAYAN komutlar veriyordu
// → waitForDevServer timeout → Faz 6 incelemede uygulama açılamaz (KATI #8/#9 ihlali). Node etkilenmez (her iki yol
// da package.json script'lerine yakınsıyor).
//
// FIX: non-Node stack'te profil `dev` komutunu aday zincirinin BAŞINA koy (doğru web-server ilk denenir); commandsFor
// adayları fallback kalır. Node DOKUNULMAZ — commandsFor'un zengin script-tespiti (dev/dev:frontend/vite chain) profil
// jenerik `npm run dev`'ten iyidir. expectedPortFor zaten uvicorn=8000/rails=3000/phoenix=4000'i biliyor → prepend'lenen
// profil komutunun portu doğru yoklanır. Fail-soft: profil yok/hata → commandsFor (mevcut davranış korunur).

import { commandsFor, NODE_STACKS, type StackId } from "./intent-router/handlers/command.js";
import { loadProfile, resolveCommand } from "./profile-loader.js";

/**
 * Dev-server için denenecek aday komutlar. Node: commandsFor aynen (script-tespiti). Non-Node: profil `dev` (varsa)
 * zincirin başında + commandsFor fallback. TÜM dev-server çağıranları (phase-5 launch, smoke-test/verify-feature
 * re-launch, dast port türetme) bunu kullanmalı → tek-kaynak, profil-drift yok.
 */
export async function devServerCandidates(
  stack: StackId,
  scripts: Record<string, string>,
): Promise<string[]> {
  const cmds = commandsFor(stack, "run", scripts);
  if (NODE_STACKS.has(stack)) return cmds; // Node: script-tespiti profil jenerik dev'inden zengin — dokunma
  try {
    const devCmd = resolveCommand(await loadProfile(stack), "dev");
    if (devCmd && !cmds.includes(devCmd)) return [devCmd, ...cmds];
  } catch {
    /* profil yok / okunamadı → commandsFor fallback (mevcut davranış) */
  }
  return cmds;
}
