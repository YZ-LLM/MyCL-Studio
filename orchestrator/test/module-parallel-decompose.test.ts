import { describe, expect, it } from "vitest";
import { parseModulesResponse } from "../src/module-parallel/decompose.js";

describe("parseModulesResponse (saf)", () => {
  it("geçerli 2-modül JSON → 2 ModuleWork", () => {
    const text =
      'Here is the split:\n{"kind":"modules","modules":[' +
      '{"id":"auth","scope_paths":["src/auth/"],"brief":"login akışı"},' +
      '{"id":"ui","scope_paths":["src/ui/"],"brief":"ayarlar sayfası"}]}\nDone.';
    const out = parseModulesResponse(text);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: "auth", scope_paths: ["src/auth/"], brief: "login akışı" });
    expect(out[1].id).toBe("ui");
  });

  it("eksik/bozuk alanlı modül atlanır", () => {
    const text =
      '{"kind":"modules","modules":[' +
      '{"id":"ok","scope_paths":["src/a/"],"brief":"iyi"},' +
      '{"id":"bad","scope_paths":"src/b/"},' + // scope_paths string (dizi değil) → atla
      '{"scope_paths":["src/c/"],"brief":"id yok"}]}'; // id yok → atla
    const out = parseModulesResponse(text);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("ok");
  });

  it("modules bloğu yok → []", () => {
    expect(parseModulesResponse("hiç JSON yok burada")).toEqual([]);
    expect(parseModulesResponse('{"kind":"other","x":1}')).toEqual([]);
  });
});
