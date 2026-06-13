// Shim: @tauri-apps/plugin-dialog (tarayıcı modu). Splash `open({directory})`
// ile proje klasörü seçer. Tarayıcı native picker GERÇEK dosya yolu döndüremez,
// o yüzden test enjeksiyonu:
//   1. window.__MYCL_PICK_PATH  (Playwright addInitScript ile set edilir)
//   2. ?project=<mutlak-yol>     (URL parametresi)
//   3. window.prompt(...)        (elle)

export interface OpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
}

export async function open(
  options?: OpenDialogOptions,
): Promise<string | string[] | null> {
  const w = window as unknown as { __MYCL_PICK_PATH?: string };
  if (typeof w.__MYCL_PICK_PATH === "string" && w.__MYCL_PICK_PATH) {
    return w.__MYCL_PICK_PATH;
  }
  try {
    const param = new URLSearchParams(window.location.search).get("project");
    if (param) return param;
  } catch {
    /* ignore */
  }
  const entered = window.prompt(options?.title ?? "Proje klasör yolu (mutlak):", "");
  return entered && entered.trim() ? entered.trim() : null;
}

export async function save(): Promise<string | null> {
  return null;
}
export async function message(): Promise<void> {
  /* no-op */
}
export async function ask(msg?: string): Promise<boolean> {
  return window.confirm(msg ?? "");
}
export async function confirm(msg?: string): Promise<boolean> {
  return window.confirm(msg ?? "");
}
