// UpdateButton — sağ üst köşede "↻" ikonu. Backend `check_update_status` 60sn
// poll'lar; mode "orchestrur" veya "full" dönerse görünür olur.
//
// orchestrator mode: doğrudan invoke (5-10 sn, app açık kalır).
// full mode: confirm dialog (manuel tıkta) → invoke → app 2sn içinde kapanır,
// helper script rebuild + relaunch yapar (~2 dk).
//
// Boot auto-apply (Ümit 2026-05-23): "açılışta güncelleme varsa otomatik yap".
// İlk mount'ta check sonucu mode != "none" ise 1.5sn gecikme + sessiz apply
// (confirmation YOK). Manuel tıklama yine confirm gösterir — yanlışlıkla full
// rebuild tetiklenmesin.
//
// State machine: idle (hidden) | available | building | relaunching | failed

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type UpdateMode = "none" | "orchestrator" | "full";

interface UpdateStatus {
  mode: UpdateMode;
  reason: string;
  busy: boolean;
}

type UiState =
  | { kind: "idle" }
  | { kind: "available"; mode: Exclude<UpdateMode, "none">; reason: string }
  | { kind: "building"; mode: Exclude<UpdateMode, "none"> }
  | { kind: "relaunching" }
  | { kind: "failed"; error: string };

const POLL_MS = 60_000;

/**
 * localStorage flag — "Boot'ta otomatik güncelle". Default true; Settings'te
 * toggle ile kullanıcı kapatabilir (L8 — Ümit 2026-05-24 talebi).
 */
export function isAutoUpdateOnBootEnabled(): boolean {
  try {
    const v = localStorage.getItem("mycl.auto_update_on_boot");
    return v !== "false"; // null veya "true" → true (default)
  } catch {
    return true;
  }
}

export function UpdateButton() {
  const [state, setState] = useState<UiState>({ kind: "idle" });
  const pollRef = useRef<number | null>(null);
  const autoAppliedRef = useRef(false);

  const applyUpdate = useCallback(
    async (mode: Exclude<UpdateMode, "none">) => {
      if (mode === "full") {
        setState({ kind: "relaunching" });
        try {
          await invoke("apply_update", { mode: "full" });
          // Backend 2sn sonra app.exit(0) çağırır; bu satıra gelinmez.
        } catch (e) {
          setState({ kind: "failed", error: String(e) });
        }
        return;
      }
      // orchestrator mode
      setState({ kind: "building", mode: "orchestrator" });
      try {
        await invoke("apply_update", { mode: "orchestrator" });
        setState({ kind: "idle" });
      } catch (e) {
        setState({ kind: "failed", error: String(e) });
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const status = await invoke<UpdateStatus>("check_update_status");
      setState((prev) => {
        // Building/relaunching durumunda poll bizi geri değiştirmesin.
        if (prev.kind === "building" || prev.kind === "relaunching") return prev;
        if (status.busy) return prev; // backend update sürüyor
        if (status.mode === "none") return { kind: "idle" };
        return {
          kind: "available",
          mode: status.mode,
          reason: status.reason,
        };
      });
      // İlk mount'ta güncelleme varsa otomatik uygula (Ümit 2026-05-23 talebi).
      // Confirmation YOK; full mode'da bile sessizce relaunch tetikler.
      // L8 (2026-05-24): kullanıcı Settings'te `mycl.auto_update_on_boot=false`
      // ile kapatabilir — opt-out kontrolü.
      if (
        !autoAppliedRef.current &&
        !status.busy &&
        status.mode !== "none" &&
        isAutoUpdateOnBootEnabled()
      ) {
        autoAppliedRef.current = true;
        // 1.5sn gecikme: kullanıcı app açılışını görsün; sonra build/relaunch.
        window.setTimeout(() => {
          void applyUpdate(status.mode as Exclude<UpdateMode, "none">);
        }, 1500);
      } else if (!autoAppliedRef.current) {
        autoAppliedRef.current = true; // ilk check tamamlandı; sonraki poll'lar manuel akış
      }
    } catch (e) {
      // sessizce yut — büyük olasılıkla binary mtime alınamadı (dev mode)
      console.debug("[update] check failed:", e);
      autoAppliedRef.current = true; // hata sonrası tekrar otomatik denemeye çalışma
    }
  }, [applyUpdate]);

  useEffect(() => {
    void refresh();
    pollRef.current = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [refresh]);

  const onClick = useCallback(async () => {
    if (state.kind !== "available") return;
    if (state.mode === "full") {
      const ok = window.confirm(
        "Tam güncelleme: uygulama yeniden derlenip 1-2 dakika içinde otomatik açılacak. Devam?",
      );
      if (!ok) return;
    }
    await applyUpdate(state.mode);
    if (state.mode === "orchestrator") {
      // Anında re-check — yeni mtime baseline'ı kur
      void refresh();
    }
  }, [state, applyUpdate, refresh]);

  if (state.kind === "idle") return null;

  if (state.kind === "failed") {
    return (
      <button
        type="button"
        className="header-update-btn failed"
        onClick={() => setState({ kind: "idle" })}
        title={`Güncelleme başarısız: ${state.error}\n(tıkla kapat)`}
        aria-label="Güncelleme hatası"
      >
        ⚠
      </button>
    );
  }

  if (state.kind === "building") {
    return (
      <button
        type="button"
        className="header-update-btn building"
        disabled
        title="Orchestrator yenileniyor…"
        aria-label="Yenileniyor"
      >
        ⟳
      </button>
    );
  }

  if (state.kind === "relaunching") {
    return (
      <button
        type="button"
        className="header-update-btn relaunching"
        disabled
        title="Uygulama yeniden derlenip açılacak…"
        aria-label="Yeniden başlatılıyor"
      >
        ⟳
      </button>
    );
  }

  // available
  const label = state.mode === "full" ? "Tam güncelleme" : "Orchestrator güncelle";
  return (
    <button
      type="button"
      className={`header-update-btn available ${state.mode}`}
      onClick={() => void onClick()}
      title={`${label} — ${state.reason}`}
      aria-label={label}
    >
      ↻
    </button>
  );
}
