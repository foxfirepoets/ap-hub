import type pg from 'pg';
import { scopedQuery } from '../../db/scoped.js';
import {
  assessProviderCapabilities,
  type CapabilityAssessment,
} from '../../accounting/capabilities.js';

interface ConnectionRow extends pg.QueryResultRow {
  id: number;
  provider: string;
  connection_class: string;
  display_name: string | null;
  external_company: string | null;
  status: string;
  metadata: Record<string, unknown>;
  updated_at: Date;
}

export interface ProviderCapabilityConnection extends CapabilityAssessment {
  id: number;
  provider: string;
  connectionClass: string;
  displayName: string | null;
  externalCompany: string | null;
  status: string;
  lastVerifiedAt: string | null;
}

function textMetadata(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** List only connections owned by the authenticated tenant. */
export async function listProviderCapabilities(
  tenantId: number,
): Promise<{ connections: ProviderCapabilityConnection[] }> {
  const { rows } = await scopedQuery<ConnectionRow>(
    tenantId,
    `SELECT id, provider, connection_class, display_name, external_company,
            status, metadata, updated_at
       FROM connections
      WHERE tenant_id = $1
      ORDER BY id`,
  );

  return {
    connections: rows.map((row) => {
      const assessment = assessProviderCapabilities({
        provider: row.provider,
        connectionClass: row.connection_class,
        edition: textMetadata(row.metadata, 'edition'),
        platform: textMetadata(row.metadata, 'platform'),
        status: row.status,
      });
      return {
        id: Number(row.id),
        provider: row.provider,
        connectionClass: row.connection_class,
        displayName: row.display_name,
        externalCompany: row.external_company,
        status: row.status,
        lastVerifiedAt: textMetadata(row.metadata, 'lastVerifiedAt'),
        ...assessment,
      };
    }),
  };
}

