// ipc-router — IPC mesaj dispatch ayrımı (v15.1.4 borç).
//
// Eskiden `index.ts` içindeki ~85 satırlık switch case'i dispatch fonksiyonu
// `IpcRouter` sınıfı içine taşındı. Handler'lar `index.ts`'de tanımlı kalır
// (runtime closure erişimi sebebiyle), ancak register pattern ile tip-güvenli
// dispatch sağlanır.
//
// Kullanım:
//   const router = new IpcRouter();
//   router.register("open_project", (data) => handleOpenProject(...));
//   ...
//   App'e `router.dispatch.bind(router)` inject edilir.

import { emitError } from "./ipc.js";
import type { IncomingCommand } from "./app.js";

/** Handler fonksiyon imzası. Sync veya async olabilir. */
export type IpcHandler = (data: unknown) => Promise<void> | void;

export class IpcRouter {
  private handlers = new Map<string, IpcHandler>();

  /**
   * `kind` için handler register eder. Aynı `kind` ikinci kez register edilirse
   * üzerine yazılır (override) — geliştirme sırasında reload pattern'ı için.
   */
  register(kind: string, handler: IpcHandler): void {
    this.handlers.set(kind, handler);
  }

  /**
   * IPC mesajı dispatch eder. Bilinmeyen kind için emitError, hata fırlatmaz.
   * Handler'ın throw ettiği hatalar dış catch'e propagate olur (App.start
   * loop'unda yakalanır).
   */
  async dispatch(msg: IncomingCommand): Promise<void> {
    const handler = this.handlers.get(msg.kind);
    if (!handler) {
      emitError(`Bilinmeyen komut: ${msg.kind}`, null);
      return;
    }
    await handler(msg.data);
  }
}
