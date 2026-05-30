// useOrchestrator — Tauri ↔ Node orchestrator IPC köprüsü hook'u.
//
// v15.2.2: Multi-window desteği eklendi. Her pencere kendi label'ını
// `getCurrentWindow().label` ile okur. Label "mycl-" prefix'li ise yeni
// pencere → window-scoped event listen + window-scoped subprocess spawn.
// Tek pencere (default Tauri label "main") → eski behavior (global event +
// global subprocess) — backward-compat.
//
// v15.2.3 QC borç C1: WINDOW_LABEL_PREFIX backend ile senkron tutulmalı
// (src-tauri/src/orchestrator.rs::WINDOW_LABEL_PREFIX). Format değişirse
// her iki dosyayı da güncelle.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  OrchestratorCommand,
  OrchestratorEvent,
} from "../types/events";

/**
 * Backend `src-tauri/src/orchestrator.rs::WINDOW_LABEL_PREFIX` ile senkron.
 * Multi-window penceresi `<PREFIX><uuid>` formatında label alır.
 */
export const WINDOW_LABEL_PREFIX = "mycl-";

export interface UseOrchestratorResult {
  ready: boolean;
  events: OrchestratorEvent[];
  lastError: string | null;
  send: (cmd: OrchestratorCommand) => Promise<void>;
  clearEvents: () => void;
  /** Her `ready` event'inde artar. Orchestrator restart (auto-update veya
   *  crash recovery) sonrası frontend'in `open_project`'i yeniden göndermesi
   *  için sinyal — App.tsx useEffect'inde deps olarak kullanılır. */
  bootSequence: number;
}

/**
 * Mevcut Tauri pencere label'ı. Multi-window mode'da "mycl-<uuid>", default
 * tek-pencere mode'da "main".
 */
function getWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

export function useOrchestrator(): UseOrchestratorResult {
  const [ready, setReady] = useState(false);
  const [events, setEvents] = useState<OrchestratorEvent[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [bootSequence, setBootSequence] = useState(0);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const spawnedRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    // v15.2.2: pencere label'ına göre event/subprocess routing. "main" =
    // default tek-pencere mode (legacy global), "mycl-*" = multi-window.
    const windowLabel = getWindowLabel();
    const isMultiWindow = windowLabel.startsWith(WINDOW_LABEL_PREFIX);
    const eventName = isMultiWindow
      ? `orchestrator-event:${windowLabel}`
      : "orchestrator-event";

    (async () => {
      try {
        unlistenRef.current = await listen<OrchestratorEvent>(eventName, (e) => {
          if (!mounted) return;
          const payload = e.payload;
          setEvents((prev) => [...prev, payload]);
          if (payload.kind === "ready") {
            setReady(true);
            // Her ready event = boot/restart. App.tsx bunu izleyip
            // projectPath varsa open_project'i yeniden göndererek
            // re-attach yapar (L1 — "no active project" fix).
            setBootSequence((n) => n + 1);
          }
          if (payload.kind === "error") {
            const detail = (payload.data as { reason?: string })?.reason;
            if (detail) setLastError(detail);
          }
        });
        if (!spawnedRef.current) {
          spawnedRef.current = true;
          if (isMultiWindow) {
            await invoke("spawn_orchestrator_for_window", {
              windowLabel,
            });
          } else {
            await invoke("spawn_orchestrator");
          }
        }
      } catch (err) {
        if (mounted) setLastError(`spawn failed: ${err}`);
      }
    })();

    return () => {
      mounted = false;
      unlistenRef.current?.();
      // Yumuşak kapatma — Tauri uygulaması kapanırken çağrılır.
      if (isMultiWindow) {
        invoke("kill_window", { windowLabel }).catch(() => {});
      } else {
        invoke("kill_orchestrator").catch(() => {});
      }
    };
  }, []);

  const send = useCallback(async (cmd: OrchestratorCommand) => {
    const windowLabel = getWindowLabel();
    const isMultiWindow = windowLabel.startsWith(WINDOW_LABEL_PREFIX);
    try {
      if (isMultiWindow) {
        await invoke("send_to_window", { windowLabel, message: cmd });
      } else {
        await invoke("send_to_orchestrator", { message: cmd });
      }
    } catch (err) {
      setLastError(`send failed: ${err}`);
      throw err;
    }
  }, []);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { ready, events, lastError, send, clearEvents, bootSequence };
}
