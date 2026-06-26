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

/**
 * Recent listesi görüntü-etiketi. Okunamayan-proje KOPYAları "MyCL Projeler" altında çirkin
 * `<isim>-<sha1[0:8]>` yoluyla durur (ör. cave5-e50a21b9) — dostça göster: hash son-ekini at +
 * entegre-kopyası işareti. SADECE görüntü; gerçek yol (reopen + tooltip) korunur. Yanlış-strip zararsız.
 */
export function recentDisplayLabel(path: string): {
  label: string;
  isIntegrateCopy: boolean;
} {
  if (!path.includes("/MyCL Projeler/")) return { label: path, isIntegrateCopy: false };
  const base = path.split("/").filter(Boolean).pop() ?? path;
  const friendly = base.replace(/-[0-9a-f]{8}$/, "");
  return { label: friendly || base, isIntegrateCopy: true };
}

interface Props {
  /** opts.integrate=true → "Proje Aç" (mevcut/yabancı projeyi MyCL'e entegre et — onboarding). */
  onProjectSelected: (path: string, opts?: { integrate?: boolean }) => void;
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

  const pickFolder = useCallback(
    async (integrate: boolean) => {
      setError(null);
      setBusy(true);
      try {
        const selected = await openDialog({
          directory: true,
          multiple: false,
          title: integrate
            ? "MyCL Studio — Entegre Edilecek Mevcut Projeyi Seç"
            : "MyCL Studio — Proje Klasörü Seç",
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
        onProjectSelected(selected, { integrate });
      } catch (err) {
        setError(`Klasör seçilemedi: ${err}`);
        setBusy(false);
      }
    },
    [onProjectSelected],
  );

  return (
    <main className="splash" data-testid="splash">
      <div className="splash-box">
        <img src="/mycl-studio.png" className="splash-logo" alt="MyCL Studio" />
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
          onClick={() => pickFolder(false)}
          disabled={busy}
        >
          {busy ? "Açılıyor..." : "📁 Yeni Klasör Seç"}
        </button>
        <button
          type="button"
          className="splash-btn splash-btn-integrate"
          data-testid="splash-integrate-existing"
          onClick={() => pickFolder(true)}
          disabled={busy}
          title="Var olan (yabancı) bir projeyi MyCL'e entegre et — MyCL kodu derinlemesine anlar, .mycl dosyalarını kurar, eksikleri rapor eder. Mevcut KAYNAĞINA DOKUNMAZ."
        >
          {busy ? "Açılıyor..." : "📂 Proje Aç (Mevcut Projeyi Entegre Et)"}
        </button>
        <p className="splash-desc splash-desc-sub">
          Yeni/boş proje için <strong>Yeni Klasör Seç</strong>; var olan bir projeyi MyCL'e taşımak için{" "}
          <strong>Proje Aç</strong> — MyCL anlar ve eksikleri raporlar, kaynağını bozmaz.
        </p>
        {recent.length > 0 && (
          <div className="splash-recent">
            <p className="splash-recent-title">Son projeler</p>
            <ul className="splash-recent-list">
              {recent.map((p) => {
                const isOpen = openPathsSet.has(p);
                const { label, isIntegrateCopy } = recentDisplayLabel(p);
                return (
                  <li
                    key={p}
                    data-testid="splash-recent-item"
                    className={`splash-recent-item${isOpen ? " splash-recent-item-disabled" : ""}`}
                    title={isOpen ? `${p} — başka pencerede açık` : p}
                    onClick={() => {
                      if (isOpen) return; // başka pencerede açık — engelle
                      void invoke("add_recent_project", { path: p }).catch(
                        () => {},
                      );
                      onProjectSelected(p);
                    }}
                  >
                    <span>{label}</span>
                    {isIntegrateCopy && !isOpen && (
                      <span className="splash-recent-badge splash-recent-badge-integrate">
                        entegre kopyası
                      </span>
                    )}
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
