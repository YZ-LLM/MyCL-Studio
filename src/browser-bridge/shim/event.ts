// Shim: @tauri-apps/api/event (tarayıcı modu). useOrchestrator `listen` +
// `UnlistenFn` kullanır; `once`/`emit` tamlık için.
import { bridgeListen } from "../client";

export type UnlistenFn = () => void;

export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}
export type EventCallback<T> = (event: Event<T>) => void;

let _seq = 0;

export async function listen<T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  return bridgeListen(event, (payload) => {
    handler({ event, id: _seq++, payload: payload as T });
  });
}

export async function once<T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  let unlisten: UnlistenFn = () => {};
  unlisten = bridgeListen(event, (payload) => {
    unlisten();
    handler({ event, id: _seq++, payload: payload as T });
  });
  return unlisten;
}

export async function emit(_event: string, _payload?: unknown): Promise<void> {
  // MyCL frontend→backend emit kullanmıyor; tarayıcıda no-op.
}
