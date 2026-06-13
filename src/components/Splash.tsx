// Splash — proje seçim ekranı. Spec §4.7.
//
// - "Yeni Klasör Seç" → Tauri dialog open
// - Recent projects listesi (max 20, app data path'ten yüklenir)
// - Splash hata satırı

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

interface OpenProject {
  label: string;
  path: string;
}

interface Props {
  onProjectSelected: (path: string) => void;
}

export function Splash({ onProjectSelected }: Props) {
  const [recent, setRecent] = useState<string[]>([]);
  const [openProjects, setOpenProjects] = useState<OpenProject[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [paths, openList] = await Promise.all([
          invoke<string[]>("get_recent_projects"),
          invoke<OpenProject[]>("get_open_projects").catch(() => []),
        ]);
        setRecent(paths);
        setOpenProjects(openList);
      } catch (err) {
        console.error("recent projects load:", err);
      }
    })();
  }, []);

  // v15.7 (2026-05-24): set'e çevir — O(1) lookup
  const openPathsSet = new Set(openProjects.map((o) => o.path));

  const pickFolder = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "MyCL Studio — Proje Klasörü Seç",
      });
      if (!selected || typeof selected !== "string") {
        setBusy(false);
        return;
      }
      try {
        await invoke("add_recent_project", { path: selected });
      } catch {
        // recent kaydı opsiyonel
      }
      onProjectSelected(selected);
    } catch (err) {
      setError(`Klasör seçilemedi: ${err}`);
      setBusy(false);
    }
  }, [onProjectSelected]);

  return (
    <main className="splash" data-testid="splash">
      <div className="splash-box">
        <h1 className="splash-title">Proje Klasörü Seç</h1>
        <p className="splash-desc">
          MyCL Studio seçilen dizinde çalışır. Açıldıktan sonra{" "}
          <strong>değiştirilemez</strong> — farklı proje için uygulamayı yeniden
          başlatın.
        </p>
        <button
          type="button"
          className="primary splash-btn"
          data-testid="splash-pick-folder"
          onClick={pickFolder}
          disabled={busy}
        >
          {busy ? "Açılıyor..." : "📁 Yeni Klasör Seç"}
        </button>
        {recent.length > 0 && (
          <div className="splash-recent">
            <p className="splash-recent-title">Son projeler</p>
            <ul className="splash-recent-list">
              {recent.map((p) => {
                const isOpen = openPathsSet.has(p);
                return (
                  <li
                    key={p}
                    data-testid="splash-recent-item"
                    className={`splash-recent-item${isOpen ? " splash-recent-item-disabled" : ""}`}
                    title={
                      isOpen
                        ? `${p} — başka pencerede açık`
                        : p
                    }
                    onClick={() => {
                      if (isOpen) return; // başka pencerede açık — engelle
                      void invoke("add_recent_project", { path: p }).catch(
                        () => {},
                      );
                      onProjectSelected(p);
                    }}
                  >
                    <span>{p}</span>
                    {isOpen && (
                      <span className="splash-recent-badge">
                        başka pencerede açık
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {error && <p className="splash-error">{error}</p>}
      </div>
    </main>
  );
}
