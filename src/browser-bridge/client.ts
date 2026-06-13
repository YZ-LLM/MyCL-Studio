// browser-bridge/client.ts — tarayıcı tarafı köprü istemcisi.
//
// SADECE tarayıcı modunda (MYCL_BROWSER=1 → vite alias) yüklenir. Tauri
// build'inde bu dosyalar ölü koddur (hiçbir şey path ile import etmez, alias
// yoktur → `@tauri-apps/*` gerçek paketlere çözülür, vite tree-shake eder).
//
// invoke  → POST  http://localhost:1799/__bridge/invoke
// listen  → GET   .../__bridge/events (tek paylaşımlı EventSource, isimle filtre)

const BRIDGE_URL: string =
  (typeof window !== "undefined" &&
    (window as unknown as { __MYCL_BRIDGE_URL?: string }).__MYCL_BRIDGE_URL) ||
  "http://localhost:1799";

type EventHandler = (payload: unknown) => void;

const listeners = new Map<string, Set<EventHandler>>();
let es: EventSource | null = null;

function ensureEventSource(): void {
  if (es || typeof window === "undefined") return;
  es = new EventSource(`${BRIDGE_URL}/__bridge/events`);
  es.onmessage = (ev: MessageEvent) => {
    let msg: { name: string; payload: unknown };
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const set = listeners.get(msg.name);
    if (!set) return;
    for (const h of set) {
      try {
        h(msg.payload);
      } catch (e) {
        console.error("[bridge] listener error", e);
      }
    }
  };
  es.onerror = () => {
    // EventSource kendi kendine yeniden bağlanır — sessiz bırak.
  };
}

/** Tauri `invoke` karşılığı. Köprü `{ ok }` döner; `{ error }` → throw. */
export async function bridgeInvoke(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${BRIDGE_URL}/__bridge/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd, args: args ?? {} }),
  });
  const data = (await res.json().catch(() => ({
    error: `köprü yanıtı okunamadı (${res.status})`,
  }))) as { ok?: unknown; error?: string };
  if (!res.ok || (data && typeof data === "object" && "error" in data && data.error)) {
    throw new Error(data.error ?? `köprü invoke başarısız: ${cmd} (${res.status})`);
  }
  return data.ok;
}

/** Tauri `listen` karşılığı. Aynı isimli olaylara abone olur; unlisten döner. */
export function bridgeListen(name: string, handler: EventHandler): () => void {
  ensureEventSource();
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  set.add(handler);
  return () => {
    set?.delete(handler);
  };
}
