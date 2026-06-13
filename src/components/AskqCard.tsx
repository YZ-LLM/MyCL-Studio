// AskqCard — AskUserQuestion render kartı. Spec §4.2.
// Multi-select varyant: multiSelect=true ise checkbox + "Seçilenleri uygula"
// CTA. Default tek-seçim radio benzeri davranış değişmez.

import { useState } from "react";

export type AskqOption = string | { label: string; value: string };

interface Props {
  question: string;
  options: AskqOption[];
  allowOther?: boolean;
  multiSelect?: boolean;
  /** v15.7 (2026-05-26): Ana ajan önerisi — bu seçenek vurgulanır. */
  suggestedOption?: string;
  onAnswer: (selected: string | string[]) => void;
}

function optLabel(o: AskqOption): string {
  return typeof o === "string" ? o : o.label;
}
function optValue(o: AskqOption): string {
  return typeof o === "string" ? o : o.value;
}

export function AskqCard({
  question,
  options,
  allowOther,
  multiSelect,
  suggestedOption,
  onAnswer,
}: Props) {
  const [otherText, setOtherText] = useState("");
  const [otherMode, setOtherMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  if (multiSelect) {
    const toggle = (value: string): void => {
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
    };
    return (
      <div className="askq-card msg" data-testid="askq-card">
        <div className="askq-question">{question}</div>
        <div className="askq-options askq-multi">
          {options.map((o) => {
            const value = optValue(o);
            const label = optLabel(o);
            const checked = picked.has(value);
            return (
              <label key={value} className="askq-checkbox-row">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(value)}
                />
                <span>{label}</span>
              </label>
            );
          })}
        </div>
        <div className="askq-multi-actions">
          <button
            type="button"
            className="askq-option askq-apply"
            data-testid="askq-apply"
            disabled={picked.size === 0}
            onClick={() => onAnswer(Array.from(picked))}
          >
            Seçilenleri uygula ({picked.size})
          </button>
          <button
            type="button"
            className="askq-option askq-cancel"
            onClick={() => onAnswer([])}
          >
            Vazgeç
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="askq-card msg" data-testid="askq-card">
      <div className="askq-question">{question}</div>
      {suggestedOption && (
        <div className="askq-suggestion" title="Orkestra ajanının önerisi">
          <span className="askq-suggestion-icon" aria-hidden>🤖</span>
          <span>Orkestra Ajan Cevabı: <strong>{suggestedOption}</strong></span>
        </div>
      )}
      <div className="askq-options">
        {options.map((o) => {
          const value = optValue(o);
          const label = optLabel(o);
          const isSuggested = suggestedOption !== undefined && label === suggestedOption;
          return (
            <button
              key={value}
              type="button"
              data-testid="askq-option"
              className={`askq-option${isSuggested ? " askq-option-suggested" : ""}`}
              onClick={() => onAnswer(value)}
            >
              {label}
            </button>
          );
        })}
        {allowOther && !otherMode && (
          <button
            type="button"
            className="askq-option"
            onClick={() => setOtherMode(true)}
          >
            Cevap yaz…
          </button>
        )}
        {allowOther && otherMode && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (otherText.trim()) onAnswer(otherText.trim());
            }}
          >
            <input
              type="text"
              className="askq-other-input"
              data-testid="askq-other-input"
              autoFocus
              placeholder="Cevabınızı yazın…"
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
            />
          </form>
        )}
      </div>
    </div>
  );
}
