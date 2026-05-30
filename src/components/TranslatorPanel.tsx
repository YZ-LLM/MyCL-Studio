// TranslatorPanel — Sağ üst panel: TR↔EN çeviri log'u. Spec §4.3.

import { useEffect, useRef } from "react";
import { fmtTs } from "../utils/format";

export interface TranslationEntry {
  id: number;
  dir: "tr-to-en" | "en-to-tr";
  input: string;
  output: string;
  model: string;
  elapsed_ms: number;
  ok: boolean;
  /** Cross-panel focus için backend ts. */
  ts: number;
}

interface Props {
  entries: TranslationEntry[];
  modelLabel: string;
  /** Cross-panel focus penceresi: [from, to). null → highlight yok. */
  highlightWindow: { from: number; to: number } | null;
}

export function TranslatorPanel({ entries, modelLabel, highlightWindow }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Pencere içine düşen ilk entry'nin DOM ref'i — scrollIntoView için. */
  const firstAssocRef = useRef<HTMLDivElement | null>(null);
  /** Focus aktif edildikten sonra 2sn auto-scroll bottom pasif. */
  const lastFocusTs = useRef<number>(0);

  // Pencere değiştiğinde ilk associated entry'ye scroll + auto-scroll pause.
  useEffect(() => {
    if (highlightWindow === null) return;
    lastFocusTs.current = Date.now();
    firstAssocRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [highlightWindow]);

  // Auto-scroll bottom on new content (focus sırasında 2sn pas).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (Date.now() - lastFocusTs.current < 2000) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  // İlk mount: history async geldikten sonra scroll en altta olsun.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollBottom = (): void => {
      el.scrollTop = el.scrollHeight;
    };
    requestAnimationFrame(() =>
      requestAnimationFrame(() => requestAnimationFrame(scrollBottom)),
    );
    const t = setTimeout(scrollBottom, 250);
    return () => clearTimeout(t);
  }, []);

  let firstAssocSeen = false;

  return (
    <section className="panel-vsection">
      <div className="panel-label">Translator ({modelLabel})</div>
      <div className="translator-log" ref={scrollRef}>
        {entries.length === 0 ? (
          <div className="translator-placeholder">
            Çeviriler burada görünecek
          </div>
        ) : (
          entries.map((e) => {
            const dirTag = e.dir === "tr-to-en" ? "[TR>EN]" : "[EN>TR]";
            const markOpen = e.dir === "tr-to-en" ? "[[EN]]" : "[[TR]]";
            const markClose = e.dir === "tr-to-en" ? "[[/EN]]" : "[[/TR]]";
            const sec = (e.elapsed_ms / 1000).toFixed(1);
            const inWindow =
              highlightWindow !== null &&
              e.ts >= highlightWindow.from &&
              e.ts < highlightWindow.to;
            const refCb = inWindow && !firstAssocSeen
              ? (el: HTMLDivElement | null) => {
                  firstAssocRef.current = el;
                }
              : undefined;
            if (inWindow) firstAssocSeen = true;
            const tsLabel = fmtTs(e.ts);
            return (
              <div
                key={e.id}
                ref={refCb}
                className={`translator-entry${inWindow ? " associated" : ""}`}
              >
                {tsLabel && <span className="msg-ts">{tsLabel}</span>}
                <div className="translator-input-line">
                  &gt; {dirTag} {e.input}
                </div>
                <div className="translator-output-line">
                  ← {markOpen}
                  {e.output}
                  {markClose}
                </div>
                <div className={`translator-status ${e.ok ? "" : "fail"}`}>
                  {e.ok ? "*" : "✗"} {e.ok ? `Translated in ${sec}s` : `Failed (${sec}s)`}
                  {" · "}
                  {e.model}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
