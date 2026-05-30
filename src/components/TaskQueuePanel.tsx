// TaskQueuePanel — sağdan açılır iş kuyruğu drawer.
//
// Kullanıcı talebi (v15.7, 2026-05-24): "iş kuyruğunu sağ tarafta bi panel
// ekleyip oraya panelin içine ekle. liste olarak görünsün işler. hangisine
// tıklarsam, eğer o anda faz 1 de isek o işin içeriğini mycl e prompt olarak
// girsin ve göndersin. iş kuyruğu paneli açılır kapanır olsun."

import type { ReactNode } from "react";
import type { TaskQueueItem } from "../types/events";

interface Props {
  open: boolean;
  items: TaskQueueItem[];
  /** Mevcut faz — sadece Faz 1'de "Uygula" tıklanabilir. */
  currentPhase: number;
  onClose: () => void;
  /** Item üzerine tıklama — App.tsx Faz 1 kontrolünü yapar. */
  onItemApply: (item: TaskQueueItem) => void;
  onItemDelete: (id: string) => void;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TaskQueuePanel({
  open,
  items,
  currentPhase,
  onClose,
  onItemApply,
  onItemDelete,
}: Props): ReactNode {
  if (!open) return null;
  // Reverse-chronological — en yeni üstte
  const sorted = [...items].sort((a, b) => b.ts - a.ts);
  const canApply = currentPhase === 1;

  return (
    <aside className="task-queue-drawer" aria-label="İş Kuyruğu">
      <header className="task-queue-header">
        <span className="task-queue-title">📋 İş Kuyruğu ({items.length})</span>
        <button
          type="button"
          className="task-queue-close"
          onClick={onClose}
          title="Kapat"
        >
          ×
        </button>
      </header>
      {!canApply && (
        <div className="task-queue-warning">
          Uygulama sadece Faz 1'de mümkün (şu an Faz {currentPhase}).
        </div>
      )}
      {sorted.length === 0 ? (
        <div className="task-queue-empty">Henüz iş eklenmedi.</div>
      ) : (
        <ul className="task-queue-list">
          {sorted.map((item) => (
            <li key={item.id} className="task-queue-item">
              <div className="task-queue-item-ts">{formatTs(item.ts)}</div>
              <div className="task-queue-item-text">{item.text}</div>
              <div className="task-queue-item-actions">
                <button
                  type="button"
                  className="task-queue-btn task-queue-btn-apply"
                  onClick={() => onItemApply(item)}
                  disabled={!canApply}
                  title={
                    canApply
                      ? "Composer'a yaz ve gönder"
                      : "Sadece Faz 1'de uygulanabilir"
                  }
                >
                  Uygula
                </button>
                <button
                  type="button"
                  className="task-queue-btn task-queue-btn-delete"
                  onClick={() => onItemDelete(item.id)}
                  title="Sil"
                >
                  Sil
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
