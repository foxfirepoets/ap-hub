import type { ProviderCapability } from './contracts.js';

export const PROVIDER_OPERATIONS = [
  'verify_company',
  'query',
  'post_bill',
  'read_back',
  'attach',
] as const;

export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number];

export interface ConnectionCapabilityInput {
  provider: string;
  connectionClass: string;
  edition?: string | null;
  platform?: string | null;
  status?: string;
}

export interface CapabilityAssessment {
  edition: string;
  supported: boolean;
  capabilities: ProviderCapability[];
  gaps: string[];
}

const QBO_EDITIONS = new Set([
  'simple_start',
  'essentials',
  'plus',
  'advanced',
  'accountant',
  'online',
]);
const QBD_EDITIONS = new Set(['pro', 'premier', 'enterprise']);
const QBO_UNSUPPORTED_FIELDS = ['desktop_inventory_site', 'desktop_sales_order'];
const QBD_UNSUPPORTED_FIELDS = ['multi_entity', 'online_custom_field_definition'];

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function unsupported(
  provider: string,
  edition: string,
  reason: string,
  unsupportedFields: string[] = [],
): CapabilityAssessment {
  return {
    edition,
    supported: false,
    capabilities: PROVIDER_OPERATIONS.map((operation) => ({
      provider,
      edition,
      operation,
      supported: false,
      reason,
      unsupportedFields,
    })),
    gaps: [reason],
  };
}

function supported(
  provider: 'qbo' | 'qbd',
  edition: string,
  unsupportedFields: string[],
  unsupportedOperations: Partial<Record<ProviderOperation, string>> = {},
): CapabilityAssessment {
  const capabilities = PROVIDER_OPERATIONS.map((operation): ProviderCapability => {
    const reason = unsupportedOperations[operation] ?? null;
    return {
      provider,
      edition,
      operation,
      supported: reason === null,
      reason,
      unsupportedFields,
    };
  });
  return {
    edition,
    supported: capabilities.some((capability) => capability.supported),
    capabilities,
    gaps: capabilities.flatMap((capability) => capability.reason ? [capability.reason] : []),
  };
}

/**
 * Executable product truth for the QuickBooks surfaces AP Hub can actually use.
 * Unknown products fail closed and always include an operator-facing remediation.
 */
export function assessProviderCapabilities(input: ConnectionCapabilityInput): CapabilityAssessment {
  const provider = normalized(input.provider);
  const edition = normalized(input.edition) || (provider === 'qbo' ? 'online' : 'unknown');
  const platform = normalized(input.platform);

  if (input.status && input.status !== 'active') {
    return unsupported(
      provider || 'unknown',
      edition,
      `Connection is ${input.status}; reconnect or reactivate it before using accounting operations.`,
    );
  }

  if (provider === 'qbo') {
    if (input.connectionClass !== 'cloud') {
      return unsupported(
        provider,
        edition,
        'QuickBooks Online requires a cloud connection; reconnect this company through QuickBooks Online OAuth.',
      );
    }
    if (!QBO_EDITIONS.has(edition)) {
      return unsupported(
        provider,
        edition,
        `QuickBooks Online edition "${edition}" is not certified for this integration; connect a supported QuickBooks Online Accounting API company.`,
      );
    }
    return supported('qbo', edition, QBO_UNSUPPORTED_FIELDS);
  }

  if (provider === 'qbd') {
    if (input.connectionClass !== 'local_desktop' || platform !== 'windows') {
      return unsupported(
        provider,
        edition,
        'QuickBooks Desktop integration requires a supported Windows company and QuickBooks Web Connector.',
      );
    }
    if (!QBD_EDITIONS.has(edition)) {
      return unsupported(
        provider,
        edition,
        `QuickBooks Desktop edition "${edition}" is unsupported; use a supported Windows Pro, Premier, or Enterprise edition with Web Connector.`,
      );
    }
    return supported('qbd', edition, QBD_UNSUPPORTED_FIELDS, {
      attach: 'QuickBooks Desktop bill attachment is not certified; retain the source evidence in AP Hub.',
    });
  }

  const product = provider || 'unknown';
  return unsupported(
    product,
    edition,
    `Provider "${product}" is unsupported; connect QuickBooks Online or a supported Windows QuickBooks Desktop Pro, Premier, or Enterprise company.`,
  );
}
