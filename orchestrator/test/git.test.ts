import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBlameForLines,
  getCommitStats,
  getRecentCommits,
  isGitRepo,
  parseBlamePorcelain,
  parseStatOutput,
} from "../src/git.js";

function gitInit(dir: string) {
  spawnSync("git", ["init", "--initial-branch=main"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
}

function gitCommit(dir: string, msg: string) {
  spawnSync("git", ["commit", "--allow-empty", "-m", msg], { cwd: dir, stdio: "ignore" });
}

describe("git · isGitRepo", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mycl-git-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("tmpdir without git init → false", async () => {
    expect(await isGitRepo(dir)).toBe(false);
  });

  it("tmpdir with git init → true", async () => {
    gitInit(dir);
    expect(await isGitRepo(dir)).toBe(true);
  });
});

describe("git · getRecentCommits", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mycl-git-"));
    gitInit(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns commits in newest-first order with sha + ts + subject", async () => {
    gitCommit(dir, "first commit");
    gitCommit(dir, "second commit");
    const commits = await getRecentCommits(dir, 10);
    expect(commits).toHaveLength(2);
    expect(commits[0].subject).toBe("second commit");
    expect(commits[1].subject).toBe("first commit");
    expect(commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(commits[0].ts).toBeGreaterThan(0);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) gitCommit(dir, `commit-${i}`);
    const commits = await getRecentCommits(dir, 2);
    expect(commits).toHaveLength(2);
  });

  it("invalid limit throws GitError", async () => {
    await expect(getRecentCommits(dir, 0)).rejects.toThrow("invalid limit");
    await expect(getRecentCommits(dir, -1)).rejects.toThrow("invalid limit");
  });
});

describe("git · getCommitStats + parseStatOutput", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mycl-git-"));
    gitInit(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("getCommitStats returns file changes + insertions + deletions for a real commit", async () => {
    await writeFile(join(dir, "a.txt"), "line1\nline2\nline3\n");
    spawnSync("git", ["add", "a.txt"], { cwd: dir, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "add a.txt"], { cwd: dir, stdio: "ignore" });
    const commits = await getRecentCommits(dir, 1);
    const stats = await getCommitStats(dir, commits[0].sha);
    expect(stats.files_changed).toBe(1);
    expect(stats.insertions).toBe(3);
    expect(stats.deletions).toBe(0);
    expect(stats.files).toContain("a.txt");
  });

  it("invalid sha throws GitError", async () => {
    await expect(getCommitStats(dir, "not-a-sha")).rejects.toThrow("invalid sha");
  });

  it("parseStatOutput handles summary line + file lines", () => {
    const stdout = ` src/foo.ts | 12 ++++++------\n src/bar.ts |  3 ++-\n 2 files changed, 11 insertions(+), 4 deletions(-)\n`;
    const stats = parseStatOutput(stdout);
    expect(stats.files_changed).toBe(2);
    expect(stats.insertions).toBe(11);
    expect(stats.deletions).toBe(4);
    expect(stats.files).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("parseStatOutput handles insert-only commits", () => {
    const stdout = ` a.txt | 3 +++\n 1 file changed, 3 insertions(+)\n`;
    const stats = parseStatOutput(stdout);
    expect(stats.files_changed).toBe(1);
    expect(stats.insertions).toBe(3);
    expect(stats.deletions).toBe(0);
  });

  it("parseStatOutput handles delete-only commits", () => {
    const stdout = ` a.txt | 2 --\n 1 file changed, 2 deletions(-)\n`;
    const stats = parseStatOutput(stdout);
    expect(stats.deletions).toBe(2);
    expect(stats.insertions).toBe(0);
  });

  it("parseStatOutput caps file list at 20", () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(` file-${i}.txt | 1 +`);
    lines.push(" 30 files changed, 30 insertions(+)");
    const stats = parseStatOutput(lines.join("\n") + "\n");
    expect(stats.files).toHaveLength(20);
    expect(stats.files[0]).toBe("file-0.txt");
  });
});

describe("git · parseBlamePorcelain", () => {
  it("parses --line-porcelain blocks into sha/author/ts/summary/line", () => {
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const stdout =
      `${sha} 1 1 1\n` +
      "author Alice\n" +
      "author-mail <alice@example.com>\n" +
      "author-time 1700000000\n" +
      "committer Alice\n" +
      "committer-time 1700000123\n" +
      "summary fix null guard\n" +
      "filename src/foo.ts\n" +
      "\tconst x = 1;\n";
    const rows = parseBlamePorcelain(stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].sha).toBe("a1b2c3d4e5"); // 10-char kısa sha
    expect(rows[0].author).toBe("Alice");
    expect(rows[0].summary).toBe("fix null guard");
    expect(rows[0].ts).toBe(1700000123 * 1000);
    expect(rows[0].line).toBe(1);
  });

  it("empty stdout → empty array", () => {
    expect(parseBlamePorcelain("")).toEqual([]);
  });
});

describe("git · getBlameForLines", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mycl-git-"));
    gitInit(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the commit that last changed a line", async () => {
    await writeFile(join(dir, "foo.ts"), "a\nb\nc\n");
    spawnSync("git", ["add", "foo.ts"], { cwd: dir, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "seed foo"], { cwd: dir, stdio: "ignore" });
    const blame = await getBlameForLines(dir, "foo.ts", 2, 2);
    expect(blame).toHaveLength(1);
    expect(blame[0].summary).toBe("seed foo");
    expect(blame[0].line).toBe(2);
  });

  it("untracked file → empty array (graceful, no throw)", async () => {
    await writeFile(join(dir, "new.ts"), "x\n");
    const blame = await getBlameForLines(dir, "new.ts", 1, 1);
    expect(blame).toEqual([]);
  });

  it("invalid file/range throws GitError", async () => {
    await expect(getBlameForLines(dir, "-evil", 1, 1)).rejects.toThrow("invalid blame file");
    await expect(getBlameForLines(dir, "foo.ts", 0, 1)).rejects.toThrow("invalid blame range");
    await expect(getBlameForLines(dir, "foo.ts", 5, 2)).rejects.toThrow("invalid blame range");
  });
});
