import type pg from 'pg';
import { scopedQuery } from '../../db/scoped.js';

/**
 * CHUNK_5_CONNECT — `aphub:connections:status`. A minimal, tenant-scoped list of the
 * `connections` rows CHUNK_5's connect flow (and the existing QBO web flow) write, so the
 * renderer can show "connected" without the fuller capability/write-gate assessment
 * `listProviderCapabilities` (`aphub:provider-capabilities:list`) already provides.
 */
export interface ConnectionStatus {
  id: number;
  provider: string;
  connectionClass: string;
  displayName: string | null;
  externalCompany: string | null;
  status: string;
  updatedAt: string;
}

interface ConnectionStatusRow extends pg.QueryResultRow {
  id: number;
  provider: string;
  connection_class: string;
  display_name: string | null;
  external_company: string | null;
  status: string;
  updated_at: Date;
}

export async function listConnectionStatuses(tenantId: number): Promise<ConnectionStatus[]> {
  const { rows } = await scopedQuery<ConnectionStatusRow>(
    tenantId,
    `SELECT id, provider, connection_class, display_name, external_company, status, updated_at
       FROM connections
      WHERE tenant_id = $1
      ORDER BY id`,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    provider: row.provider,
    connectionClass: row.connection_class,
    displayName: row.display_name,
    externalCompany: row.external_company,
    status: row.status,
    updatedAt: row.updated_at.toISOString(),
  }));
}
