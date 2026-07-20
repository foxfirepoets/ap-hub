// Owner/admin-only gate: every /api/tax-mappings/** route requires owner_controller (see
// src/services/action/taxMappings.ts's readContext(request, 'owner_controller')), so any
// other role gets a real 403 from the API even before a mutation is attempted. This renders
// a clear, non-crashing "not authorized" state instead of a blank page or a thrown error —
// used both pre-emptively (role known client-side) and reactively (an unexpected 403 body).
export function NotAuthorized({ detail }: { detail?: string }) {
  return (
    <div className="notice bad" data-testid="tax-mapping-not-authorized">
      Not authorized. Tax-code mapping is available to the account owner only.
      {detail ? ` (${detail})` : ''}
    </div>
  );
}
