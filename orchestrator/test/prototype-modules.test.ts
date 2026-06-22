// deriveModules — prototip dosyalarından sayfa/route/API manifest'i (SAF). Next.js app+pages router.
import { describe, expect, it } from "vitest";
import { deriveModules } from "../src/prototype-cache.js";

describe("deriveModules (prototip modül manifest'i)", () => {
  it("app router sayfaları (route-group atlanır) + ana sayfa + API", () => {
    const mods = deriveModules([
      "app/login/page.js",
      "app/(app)/urunler/page.tsx",
      "app/page.js",
      "app/api/auth/login/route.js",
      "lib/db.js", // modül değil
      "components/Nav.jsx", // modül değil
    ]);
    const byName = (n: string) => mods.find((m) => m.name === n);
    expect(byName("login sayfası")?.kind).toBe("page");
    expect(byName("urunler sayfası")?.kind).toBe("page"); // (app) route-group atlandı
    expect(byName("ana sayfa")?.kind).toBe("page");
    expect(byName("auth/login API")?.kind).toBe("api");
    expect(byName("auth/login API")?.path).toBe("app/api/auth/login/route.js");
    expect(mods.length).toBe(4); // lib/components dahil değil
  });

  it("pages router sayfa + API; _app/_document hariç", () => {
    const mods = deriveModules(["pages/about.jsx", "pages/api/users.js", "pages/_app.js", "pages/_document.tsx"]);
    expect(mods.find((m) => m.name === "about sayfası")?.kind).toBe("page");
    expect(mods.find((m) => m.name === "users API")?.kind).toBe("api");
    expect(mods.length).toBe(2); // _app/_document atlandı
  });

  it("src/ önekli + dedup", () => {
    const mods = deriveModules(["src/app/login/page.tsx", "app/login/page.js"]);
    expect(mods.filter((m) => m.name === "login sayfası").length).toBe(1); // dedup
  });

  it("eşleşme yoksa boş (best-effort, stack-tolerant)", () => {
    expect(deriveModules(["main.py", "Cargo.toml", "src/lib.rs"]).length).toBe(0);
  });
});
