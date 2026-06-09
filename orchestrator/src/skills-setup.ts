// skills-setup — agent-skills deposunu OTOMATİK kurar (Ümit 2026-06-09: "sadece önermesin, bağlasın projeye").
//
// Eski karar (auto-clone YOK — supply-chain riski) Ümit'in açık talimatıyla TERSİNE DÖNDÜ. Risk sınırlama:
// SABİT commit'e pinlenir (PINNED_SHA) — sürpriz upstream değişikliği çalışmaz, kurulum denetlenebilir/tekrarlanabilir.
// Kurulum sonrası cli-backend.resolveSkillsDir dizini görür → codegen ajanlarına `--plugin-dir` ile bağlanır
// (o bağlama zaten vardı; eksik olan kurulumdu). Fail-closed: kurulamazsa görünür uyarı + eski elle-kur ipucu kalır.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import { globalConfigDir } from "./paths.js";

const execFileAsync = promisify(execFile);

export const AGENT_SKILLS_REPO = "https://github.com/addyosmani/agent-skills";
/** Pinli commit (2026-06-09'da dondurulan HEAD). Güncellemek = yeni SHA'yı gözden geçirip burayı değiştirmek. */
export const AGENT_SKILLS_PINNED_SHA = "0427b5b1281b7e4350176d8019305c1ffcb3beba";

function skillsDir(): string {
  return join(globalConfigDir(), "agent-skills");
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, timeout: 120_000 });
}

/**
 * agent-skills yoksa pinli commit'ten kurar (idempotent; varsa no-op). Atomiklik: önce `.tmp` dizinine
 * fetch+checkout, sonra rename — yarım kurulum asla `agent-skills` adıyla görünmez. Non-blocking caller
 * (open_project arka planı); başarı/başarısızlık chat'te görünür.
 */
export async function ensureAgentSkills(): Promise<"present" | "installed" | "failed"> {
  const dir = skillsDir();
  if (existsSync(dir)) return "present"; // kurulu — resolveSkillsDir zaten bağlıyor
  const tmp = `${dir}.tmp-${process.pid}`;
  try {
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    await git(tmp, "init", "-q");
    await git(tmp, "remote", "add", "origin", AGENT_SKILLS_REPO);
    await git(tmp, "fetch", "-q", "--depth", "1", "origin", AGENT_SKILLS_PINNED_SHA);
    await git(tmp, "checkout", "-q", "FETCH_HEAD");
    if (existsSync(dir)) {
      // Yarış: başka süreç kurmuş — bizimkini at.
      await rm(tmp, { recursive: true, force: true });
      return "present";
    }
    await rename(tmp, dir);
    emitChatMessage(
      "system",
      `🔌 agent-skills kuruldu (pin: ${AGENT_SKILLS_PINNED_SHA.slice(0, 7)}) — codegen ajanlarına \`--plugin-dir\` ile bağlanıyor.`,
    );
    log.info("skills-setup", "agent-skills installed", { dir, sha: AGENT_SKILLS_PINNED_SHA });
    return "installed";
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    log.warn("skills-setup", "agent-skills kurulamadı (görünür uyarı)", e);
    emitChatMessage(
      "system",
      "⚠️ agent-skills otomatik kurulamadı (ağ/git sorunu olabilir). Elle kurmak için:\n" +
        `\`git clone ${AGENT_SKILLS_REPO} ~/.mycl/agent-skills\``,
    );
    return "failed";
  }
}
