import { runRead, listProviderJobs } from '../../../src/services/read/index.js';

export async function GET(request: Request): Promise<Response> {
  return runRead(request, (ctx) => listProviderJobs(ctx.tenantId), { role: ['owner_controller'] });
}
