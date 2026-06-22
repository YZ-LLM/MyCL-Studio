'use client';

// Ortak ürün formu (oluştur + düzenle) — FIELD_DEFS'ten üretilir. Server Action
// prop olarak gelir (RBAC server'da). Alan hataları + sunucu hatası toast'ı.
import { useEffect } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { useT, useLang } from '@/lib/i18n-context';
import { useToast } from '@/components/ToastProvider';
import { FIELD_DEFS } from '@/lib/field-defs';
import { validationMessage } from '@/lib/validation';

function SubmitButton({ label, pendingLabel }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}

export function ProductForm({ action, initial, submitLabel }) {
  const t = useT();
  const lang = useLang();
  const toast = useToast();
  const [state, formAction] = useFormState(action, {});

  useEffect(() => {
    if (state?.error === 'FORBIDDEN') toast.show(t('products.noPermission'), 'error');
    else if (state?.error) toast.show(t('common.serverError'), 'error');
  }, [state, toast, t]);

  const fieldErrors = state?.fieldErrors || {};

  function errText(def) {
    const code = fieldErrors[def.name];
    if (!code) return null;
    if (code === 'conflict') return t('products.conflictCode');
    return validationMessage(lang, def, code);
  }

  return (
    <form action={formAction} className="stack" noValidate>
      {initial?.id ? <input type="hidden" name="id" defaultValue={initial.id} /> : null}
      <div className="form-grid">
        {FIELD_DEFS.map((def) => {
          const err = errText(def);
          const describedBy = err ? `${def.name}-error` : undefined;
          const isTextarea = def.type === 'textarea';
          return (
            <div className={isTextarea ? 'field span-2' : 'field'} key={def.name}>
              <label htmlFor={def.name}>
                {t(def.labelKey)}
                {def.required ? ' *' : ''}
              </label>
              {isTextarea ? (
                <textarea
                  id={def.name}
                  name={def.name}
                  defaultValue={initial ? (initial[def.name] ?? '') : ''}
                  maxLength={def.max}
                  aria-invalid={err ? 'true' : undefined}
                  aria-describedby={describedBy}
                />
              ) : (
                <input
                  id={def.name}
                  name={def.name}
                  type={def.type === 'number' ? 'number' : 'text'}
                  step={def.step}
                  min={def.type === 'number' ? def.minValue : undefined}
                  defaultValue={initial ? (initial[def.name] ?? '') : ''}
                  aria-invalid={err ? 'true' : undefined}
                  aria-describedby={describedBy}
                />
              )}
              {err ? (
                <p id={`${def.name}-error`} className="field-error" role="alert">
                  {err}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="form-actions">
        <SubmitButton label={submitLabel} pendingLabel={t('common.loading')} />
        <a className="btn" href="/urunler">
          {t('common.cancel')}
        </a>
      </div>
    </form>
  );
}
