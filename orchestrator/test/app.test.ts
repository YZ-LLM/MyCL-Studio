import { describe, expect, it, vi } from "vitest";
import { App, type AppDeps } from "../src/app.js";

describe("App composition root (v15.1)", () => {
  it("calls loadI18n, startRuntimeHttpServer, emitConfigStatus on start", async () => {
    // stdin/exit/signal side-effect'leri test çevresinde tehlikeli — start()'ı
    // ASYNC olarak başlat, kısa bekle (stdin loop oturmadan deps callable'lara
    // bakacağız), readline asla "line" emit etmeyecek (test stdin sessiz).
    const deps: AppDeps = {
      loadI18n: vi.fn().mockResolvedValue(undefined),
      startRuntimeHttpServer: vi.fn(),
      emitConfigStatus: vi.fn().mockResolvedValue(true),
      dispatch: vi.fn().mockResolvedValue(undefined),
    };
    const app = new App(deps);
    // start() readline.on("close") ile process.exit(0) çağıracağı için
    // void promise — beklemiyoruz. setImmediate ile event loop bir tur dön
    // ki init bloku tamamlansın.
    void app.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deps.loadI18n).toHaveBeenCalledTimes(1);
    expect(deps.startRuntimeHttpServer).toHaveBeenCalledTimes(1);
    expect(deps.emitConfigStatus).toHaveBeenCalledTimes(1);
  });

  it("continues boot when loadI18n throws (emits config_status fail-soft)", async () => {
    // i18n load fail → start() throw etmemeli, sadece error event emit etmeli.
    // Runtime HTTP ve dispatch hâlâ ulaşılabilir.
    const deps: AppDeps = {
      loadI18n: vi.fn().mockRejectedValue(new Error("bundle missing")),
      startRuntimeHttpServer: vi.fn(),
      emitConfigStatus: vi.fn().mockResolvedValue(false),
      dispatch: vi.fn(),
    };
    const app = new App(deps);
    void app.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deps.loadI18n).toHaveBeenCalled();
    // i18n fail olsa bile startRuntimeHttpServer çağrılır (boot devam eder)
    expect(deps.startRuntimeHttpServer).toHaveBeenCalled();
  });
});
