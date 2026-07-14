import { runRemap } from '../../../../src/services/action/index.js';

// POST /api/mappings/remap — owner_controller | bookkeeper: upsert a reusable mapping rule.
export async function POST(request: Request): Promise<Response> {
  return runRemap(request);
}
