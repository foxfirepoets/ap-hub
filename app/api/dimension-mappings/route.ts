import { runListDimensionMappings } from '../../../src/services/action/index.js';

// GET /api/dimension-mappings?connectionId=&dimensionType=&reviewStatus=&resolutionState=&provider=
// — the unmapped/exception review queue (owner_controller only).
export async function GET(request: Request): Promise<Response> {
  return runListDimensionMappings(request);
}
