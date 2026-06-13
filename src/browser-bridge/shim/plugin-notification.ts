// Shim: @tauri-apps/plugin-notification (tarayıcı modu). App.tsx askq geldiğinde
// OS bildirimi gönderir; tarayıcıda web Notification API'sine düşer (izin yoksa
// sessiz no-op — App zaten try/catch ile sarıyor).

export async function isPermissionGranted(): Promise<boolean> {
  try {
    return typeof Notification !== "undefined" && Notification.permission === "granted";
  } catch {
    return false;
  }
}

export async function requestPermission(): Promise<"granted" | "denied" | "default"> {
  try {
    if (typeof Notification === "undefined") return "denied";
    return (await Notification.requestPermission()) as "granted" | "denied" | "default";
  } catch {
    return "denied";
  }
}

export function sendNotification(
  options: { title: string; body?: string } | string,
): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      return;
    }
    const o = typeof options === "string" ? { title: options } : options;
    new Notification(o.title, { body: o.body });
  } catch {
    /* ignore */
  }
}
