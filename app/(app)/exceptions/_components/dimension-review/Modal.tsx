import type { ReactNode } from 'react';

// Minimal centered-overlay shell shared by the three dimension-review action modals
// (select-alternate / correct / reject-hold). Click-outside and Escape both cancel.
export function Modal({
  title,
  children,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  onCancel: () => void;
}) {
  return (
    <div
      className="modal-overlay"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
      data-testid="modal-overlay"
    >
      <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
