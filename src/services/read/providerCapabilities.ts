import type pg from 'pg';
import { scopedQuery } from '../../db/scoped.js';
import {
  assessProviderCapabilities,
  type CapabilityAssessment,
} from '../../accounting/capabilities.js';
import { config } from '../../config.js';
import { ownerGateEnabled } from '../../accounting/write-gates.js';

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
  writeGateEnabled: boolean | null;
  expectedCompanyId: string | null;
  observedCompanyId: string | null;
  lastContactAt: string | null;
}

function textMetadata(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** List only connections owned by the authenticated tenant. */
export async function listProviderCapabilities(
  tenantId: number,
): Promise<{ connections: ProviderCapabilityConnection[] }> {
  const cfg = config();
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
        writeGateEnabled: row.provider === 'qbd'
          ? Boolean(
              cfg.QB_DESKTOP_ENABLED &&
              cfg.QB_DESKTOP_WRITE_ENABLED &&
              Number(cfg.QB_DESKTOP_TENANT_ID) === tenantId &&
              Number(cfg.QB_DESKTOP_CONNECTION_ID) === Number(row.id) &&
              ownerGateEnabled(row.metadata, textMetadata(row.metadata, 'expectedCompanyId') ?? row.external_company ?? ''),
            )
          : row.provider === 'qbo'
            ? Boolean(
                (cfg.QBO_ENV === 'sandbox' || cfg.QBO_PRODUCTION_WRITE_ENABLED) &&
                ownerGateEnabled(row.metadata, row.external_company ?? ''),
              )
            : null,
        expectedCompanyId: row.provider === 'qbd'
          ? textMetadata(row.metadata, 'expectedCompanyId') ?? row.external_company
          : row.provider === 'qbo'
            ? (cfg.QBO_ENV === 'production' ? cfg.QBO_PRODUCTION_REALM_ID : cfg.QBO_SANDBOX_REALM_ID) || null
            : null,
        observedCompanyId: row.provider === 'qbd'
          ? textMetadata(row.metadata, 'observedCompanyId')
          : null,
        lastContactAt: row.provider === 'qbd'
          ? textMetadata(row.metadata, 'lastContactAt')
          : null,
        ...assessment,
      };
    }),
  };
}
