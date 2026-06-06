import { describe, expect, it } from "vitest";
import { interpretUpdateOutput } from "../src/claude-updater.js";

describe("claude-updater · interpretUpdateOutput (SAF)", () => {
  it("exit != 0 → failed", () => {
    expect(interpretUpdateOutput(1, "anything")).toBe("failed");
    expect(interpretUpdateOutput(null, "Successfully updated")).toBe("failed");
  });
  it("'up to date' / 'already' → current", () => {
    expect(interpretUpdateOutput(0, "Claude Code is up to date (2.1.165)")).toBe("current");
    expect(interpretUpdateOutput(0, "Already on latest")).toBe("current");
    expect(interpretUpdateOutput(0, "Zaten güncel")).toBe("current");
  });
  it("'updated' / 'success' → updated", () => {
    expect(interpretUpdateOutput(0, "Successfully updated from 2.1.158 to version 2.1.165")).toBe("updated");
    expect(interpretUpdateOutput(0, "Update success")).toBe("updated");
  });
  it("exit 0 ama belirsiz çıktı → current (yanlış 'güncellendi' mesajı verme)", () => {
    expect(interpretUpdateOutput(0, "")).toBe("current");
    expect(interpretUpdateOutput(0, "some unrelated output")).toBe("current");
  });
});
