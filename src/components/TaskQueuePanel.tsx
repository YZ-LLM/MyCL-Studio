// TaskQueuePanel — sağdan açılır iş kuyruğu drawer.
//
// Kullanıcı talebi (v15.7, 2026-05-24): "iş kuyruğunu sağ tarafta bi panel
// ekleyip oraya panelin içine ekle. liste olarak görünsün işler. hangisine
// tıklarsam, eğer o anda faz 1 de isek o işin içeriğini mycl e prompt olarak
// girsin ve göndersin. iş kuyruğu paneli açılır kapanır olsun."
//
// YZLLM 2026-06-14: önceliklendirilmiş yaşam-döngüsü. Çok-problem otomatik
// bölünüp önceliklendirilir + sırayla işlenir. Durum rozeti (▶️ işleniyor /
// ✅ tamam / ⏳ bekliyor / ⏹️ düştü), öncelik ve tamamlanma-zamanı gösterilir.
// "Tamamlanınca zamanını yaz ve UYGULANAMASIN" → done işler KİLİTLİ (Uygula yok).

import type { ReactNode } from "react";
import type { TaskQueueItem, TaskStatus } from "../types/events";

interface Props {
  open: boolean;
  items: TaskQueueItem[];
  /** Mevcut faz — sadece Faz 1'de manuel "Uygula" tıklanabilir. */
  currentPhase: number;
  onClose: () => void;
  /** Item üzerine tıklama — App.tsx Faz 1 kontrolünü yapar. */
  onItemApply: (item: TaskQueueItem) => void;
  /** Düşen işi YENİDEN gönder (faz-bağımsız; App.tsx sendUserMessage'a köprüler). FROZEN-GOAL #17. */
  onItemReadd: (item: TaskQueueItem) => void;
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

/** İşin GERÇEK süresi (running→done). "kaç dakika sürdü" görünürlüğü (YZLLM 2026-07-13). ~saniyelik süre =
 *  gerçek iş yapılmadı işareti (sahte-tamamlanmayı gözle yakalamaya yardım eder). started_at yoksa null. */
function formatDuration(startedAt: number | undefined, completedAt: number): string | null {
  if (!startedAt || completedAt <= startedAt) return null;
  const s = Math.round((completedAt - startedAt) / 1000);
  if (s < 60) return `${s}sn`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m}dk` : `${m}dk ${s % 60}sn`;
}

function statusOf(item: TaskQueueItem): TaskStatus {
  return item.status ?? "pending";
}

const STATUS_BADGE: Record<TaskStatus, string> = {
  running: "▶️ İşleniyor",
  done: "✅ Tamamlandı",
  pending: "⏳ Bekliyor",
  dropped: "⏹️ Düştü",
};

// Sıralama: işleniyor → bekleyen (öncelik) → tamamlanan (en son üstte) → düşen.
const STATUS_ORDER: Record<TaskStatus, number> = {
  running: 0,
  pending: 1,
  done: 2,
  dropped: 3,
};

function compareTasks(a: TaskQueueItem, b: TaskQueueItem): number {
  const sa = STATUS_ORDER[statusOf(a)];
  const sb = STATUS_ORDER[statusOf(b)];
  if (sa !== sb) return sa - sb;
  const st = statusOf(a);
  if (st === "pending") {
    // Bekleyenler önceliğe göre (1=en yüksek; yoksa sona), eşitlikte FIFO.
    const pa = a.priority ?? Number.POSITIVE_INFINITY;
    const pb = b.priority ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    return a.ts - b.ts;
  }
  if (st === "done") {
    // Tamamlananlar en son biten üstte.
    return (b.completed_at ?? b.ts) - (a.completed_at ?? a.ts);
  }
  return b.ts - a.ts;
}

export function TaskQueuePanel({
  open,
  items,
  onClose,
  onItemReadd,
  onItemDelete,
}: Props): ReactNode {
  if (!open) return null;
  const sorted = [...items].sort(compareTasks);
  const activeCount = items.filter((i) => statusOf(i) !== "done" && statusOf(i) !== "dropped").length;

  return (
    <aside className="task-queue-drawer" aria-label="İş Kuyruğu">
      <header className="task-queue-header">
        <span className="task-queue-title">
          📋 İş Kuyruğu ({activeCount} aktif / {items.length})
        </span>
        <button
          type="button"
          className="task-queue-close"
          onClick={onClose}
          title="Kapat"
        >
          ×
        </button>
      </header>
      <div className="task-queue-warning">
        İş-listesindeki işler öncelik sırasıyla TEK TEK pipeline'dan (Faz 1→17) otomatik geçer.
      </div>
      {sorted.length === 0 ? (
        <div className="task-queue-empty">Henüz iş eklenmedi.</div>
      ) : (
        <ul className="task-queue-list">
          {sorted.map((item) => {
            const st = statusOf(item);
            const isDone = st === "done";
            const isRunning = st === "running";
            return (
              <li
                key={item.id}
                className={`task-queue-item task-queue-item-${st}`}
                data-status={st}
              >
                <div className="task-queue-item-meta">
                  <span className={`task-queue-status task-queue-status-${st}`}>
                    {STATUS_BADGE[st]}
                  </span>
                  {item.priority !== undefined && !isDone && (
                    <span className="task-queue-priority" title="Öncelik (1=en yüksek)">
                      ⚑ {item.priority}
                    </span>
                  )}
                  <span className="task-queue-item-ts">
                    {isDone && item.completed_at
                      ? `✓ ${formatTs(item.completed_at)}${
                          formatDuration(item.started_at, item.completed_at)
                            ? ` · ${formatDuration(item.started_at, item.completed_at)}`
                            : ""
                        }`
                      : formatTs(item.ts)}
                  </span>
                </div>
                <div className="task-queue-item-text">{item.text}</div>
                <div className="task-queue-item-actions">
                  {/* YZLLM 2026-06-15: iş-listesindeki HER iş (manuel/auto) sırayla
                      otomatik işlenir → "Uygula" yok (eskiden manuel-tetik + duplicate
                      riskiydi); bekleyen işler "⏳ Sırada" gösterir, "Sil" ile çıkarılır. */}
                  {st === "pending" && (
                    <span className="task-queue-auto-hint" title="Sırayla otomatik pipeline'dan geçecek">
                      ⏳ Sırada
                    </span>
                  )}
                  {isDone && (
                    <span className="task-queue-locked" title="Tamamlandı — tekrar uygulanamaz">
                      🔒 Kilitli
                    </span>
                  )}
                  {st === "dropped" && (
                    <button
                      type="button"
                      className="task-queue-btn task-queue-btn-readd"
                      onClick={() => onItemReadd(item)}
                      title="Düşen işi yeniden gönder (yeni mesaj olarak)"
                    >
                      Yeniden Ekle
                    </button>
                  )}
                  {!isRunning && (
                    <button
                      type="button"
                      className="task-queue-btn task-queue-btn-delete"
                      onClick={() => onItemDelete(item.id)}
                      title="Sil"
                    >
                      Sil
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
