import { DurableProviderJobs } from '../../qbdesktop/durable-jobs.js';

export async function listProviderJobs(tenantId: number) {
  return { jobs: await new DurableProviderJobs().list(tenantId) };
}
