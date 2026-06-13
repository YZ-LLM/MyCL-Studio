// Shim: @tauri-apps/plugin-opener (tarayıcı modu). ChatPanel link tıklamasında
// `openUrl` çağırır → tarayıcıda yeni sekmede aç.

export async function openUrl(url: string): Promise<void> {
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    /* ignore */
  }
}
export async function openPath(_path: string): Promise<void> {
  /* no-op */
}
export async function revealItemInDir(_path: string): Promise<void> {
  /* no-op */
}
