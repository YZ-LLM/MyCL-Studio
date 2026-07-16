// dev-server-command — dev-server aday-komut zinciri, TEK KAYNAK PROFİL (KATI #1).
//
// Tarihçe: 2026-07-14 güvenilirlik denetimi commandsFor hardcode switch'inin profillerden
// saptığını bulmuş, profil `dev`'i zincirin başına eklemişti (hibrit). 2026-07-16'da switch
// tümüyle silindi → non-Node zincir DOĞRUDAN profilden gelir: `dev` (web dev-server) önce,
// `run` (generic çalıştır) fallback. Bugünkü zincirle birebir (ör. python-pip: uvicorn →
// python main.py) ama sıfır hardcode. Node DOKUNULMAZ — commandsFor'un zengin script-tespiti
// (dev/dev:frontend/vite chain) profil jenerik `npm run dev`'ten iyidir (2026-07-14 dersi).

import { commandsFor, NODE_STACKS, type StackId } from "./intent-router/handlers/command.js";
import { loadProfile, resolveCommand } from "./profile-loader.js";

/**
 * Dev-server için denenecek aday komutlar. Node: commandsFor aynen (script-tespiti).
 * Non-Node: profil `dev` → `run` sırasıyla (dedup'lu). Profil yoksa boş liste — caller
 * görünür hata verir (KATI #4: uydurma komut yok). TÜM dev-server çağıranları (phase-5
 * launch, smoke-test/verify-feature re-launch, dast port türetme) bunu kullanmalı →
 * tek kaynak, profil drift'i imkansız.
 */
export async function devServerCandidates(
  stack: StackId,
  scripts: Record<string, string>,
): Promise<string[]> {
  if (NODE_STACKS.has(stack)) return commandsFor(stack, "run", scripts);
  const profile = await loadProfile(stack);
  const chain = [resolveCommand(profile, "dev"), resolveCommand(profile, "run")]
    .filter((c): c is string => Boolean(c));
  return [...new Set(chain)];
}
