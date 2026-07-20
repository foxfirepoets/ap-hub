import { runListTaxMappings, runCreateTaxMapping } from '../../../src/services/action/index.js';

// GET  /api/tax-mappings?connectionId=&filter=active|exception|all — list (owner_controller).
// POST /api/tax-mappings — create a new tax mapping (owner_controller; reason optional).
export async function GET(request: Request): Promise<Response> {
  return runListTaxMappings(request);
}

export async function POST(request: Request): Promise<Response> {
  return runCreateTaxMapping(request);
}
