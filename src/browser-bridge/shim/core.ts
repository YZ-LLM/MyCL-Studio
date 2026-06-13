// Shim: @tauri-apps/api/core (tarayıcı modu). Sadece `invoke` kullanılıyor.
import { bridgeInvoke } from "../client";

export function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return bridgeInvoke(cmd, args) as Promise<T>;
}
