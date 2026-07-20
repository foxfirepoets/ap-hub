import { runDiscoverTaxCodes } from '../../../../src/services/action/index.js';

// GET /api/tax-mappings/discover?code=TAX8 — owner_controller only, READ-ONLY QBO tax-code
// discovery/validation (via src/qbo/client.ts's read-only queryEntity; no write call added).
export async function GET(request: Request): Promise<Response> {
  return runDiscoverTaxCodes(request);
}
