import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// TARAYICI MODU (MYCL_BROWSER=1, `npm run dev:browser`): Tauri IPC modüllerini
// browser-bridge shim'lerine alias'la → uygulama düz tarayıcıda (Playwright)
// çalışır. SADECE bu env set'liyken aktif; Tauri build'i ETKİLENMEZ (alias yok →
// gerçek @tauri-apps/* paketleri). Bileşen kodu hiç değişmez. macOS/Linux yol
// (pathname); kapsam mac+linux.
// @ts-expect-error process is a nodejs global
const BROWSER_MODE = process.env.MYCL_BROWSER === "1";
const shim = (f: string): string =>
  decodeURIComponent(new URL(`./src/browser-bridge/shim/${f}`, import.meta.url).pathname);
const browserAlias: Record<string, string> = BROWSER_MODE
  ? {
      "@tauri-apps/api/core": shim("core.ts"),
      "@tauri-apps/api/event": shim("event.ts"),
      "@tauri-apps/api/window": shim("window.ts"),
      "@tauri-apps/plugin-dialog": shim("plugin-dialog.ts"),
      "@tauri-apps/plugin-notification": shim("plugin-notification.ts"),
      "@tauri-apps/plugin-opener": shim("plugin-opener.ts"),
    }
  : {};

// Build zaman damgası — başlıkta gösterilir ki hangi build'in çalıştığı GÖRÜNSÜN
// (eski/yanlış build'i çalıştırmayı önler). vite.config build/dev başında bir kez
// değerlenir → her `vite build` (tauri build) ve `vite` (tauri dev) taze damga basar.
// Yerel saat, yıl-ay-gün saat:dakika:saniye.
const _bd = new Date();
const _pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const BUILD_TIME = `${_bd.getFullYear()}-${_pad(_bd.getMonth() + 1)}-${_pad(_bd.getDate())} ${_pad(_bd.getHours())}:${_pad(_bd.getMinutes())}:${_pad(_bd.getSeconds())}`;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Tarayıcı modunda Tauri IPC modüllerini shim'lere yönlendir (üstte koşullu).
  resolve: { alias: browserAlias },

  // Frontend'e build zamanını sabit olarak göm (AppHeader başlık damgası).
  define: {
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
