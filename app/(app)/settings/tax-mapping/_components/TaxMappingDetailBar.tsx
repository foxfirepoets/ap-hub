import type { TaxMapping } from '../../../../lib/types';

// Pure button bar for the detail page's action row. `active` mappings can be edited,
// disabled, or replaced; a mapping in `needs_revalidation` can be revalidated. Replaced
// (superseded) or already-disabled rows only offer navigation (server refuses edit/disable
// on inactive rows — see src/services/taxMappings.ts editTaxMapping/disableTaxMapping).
export function TaxMappingDetailBar({
  mapping,
  busy,
  onEdit,
  onDisable,
  onReplace,
  onRevalidate,
}: {
  mapping: TaxMapping;
  busy: boolean;
  onEdit: () => void;
  onDisable: () => void;
  onReplace: () => void;
  onRevalidate: () => void;
}) {
  return (
    <div className="btn-row" data-testid="tax-mapping-detail-actions">
      {mapping.active ? (
        <>
          <button onClick={onEdit} disabled={busy} data-testid="tax-mapping-edit-btn">
            Edit
          </button>
          <button onClick={onReplace} disabled={busy} data-testid="tax-mapping-replace-btn">
            Replace
          </button>
          <button className="danger" onClick={onDisable} disabled={busy} data-testid="tax-mapping-disable-btn">
            Disable
          </button>
          <button onClick={onRevalidate} disabled={busy} data-testid="tax-mapping-revalidate-btn">
            Revalidate now
          </button>
        </>
      ) : (
        <span className="muted">This mapping is inactive; edit/disable/revalidate are unavailable. Use Replace history to find its successor.</span>
      )}
    </div>
  );
}
