// Shim: @tauri-apps/api/window (tarayıcı modu). `getCurrentWindow().label` +
// `.isFocused()` kullanılır. Tek-pencere modu → label "main" (legacy IPC yolu).
import { bridgeListen } from "../client";

export interface WebviewWindowLike {
  label: string;
  isFocused(): Promise<boolean>;
  listen(
    event: string,
    handler: (e: { event: string; payload: unknown }) => void,
  ): Promise<() => void>;
}

const current: WebviewWindowLike = {
  label: "main",
  isFocused(): Promise<boolean> {
    return Promise.resolve(typeof document === "undefined" ? true : document.hasFocus());
  },
  async listen(event, handler) {
    return bridgeListen(event, (payload) => handler({ event, payload }));
  },
};

export function getCurrentWindow(): WebviewWindowLike {
  return current;
}
