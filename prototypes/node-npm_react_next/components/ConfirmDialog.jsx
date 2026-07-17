'use client';

// Onay dialogu (örn. ürün silme) — Modal a11y kurallarını miras alır.
import { Modal } from '@/components/Modal';
import { useT } from '@/lib/i18n-context';

export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel, pending }) {
  const t = useT();
  return (
    <Modal onClose={onCancel} labelledBy="confirm-title">
      <h2 id="confirm-title">{title}</h2>
      <p>{message}</p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={pending}>
          {confirmLabel || t('common.delete')}
        </button>
      </div>
    </Modal>
  );
}
