import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launch, stub, stubMe, OWNER } from './support/stub';

/**
 * CHUNK_3_IPC migration of `e2e/app.spec.ts` — multi-edition provider health on Settings
 * (1 of the 24 browser-era journeys).
 */

const PROVIDER_CONNECTIONS = {
  connections: [
    {
      id: 10,
      provider: 'qbo',
      connectionClass: 'cloud',
      displayName: 'Main operating company',
      externalCompany: 'realm-10',
      status: 'active',
      lastVerifiedAt: new Date().toISOString(),
      edition: 'plus',
      supported: true,
      gaps: [],
      capabilities: ['verify_company', 'query', 'post_bill', 'read_back', 'attach'].map((operation) => ({
        provider: 'qbo',
        edition: 'plus',
        operation,
        supported: true,
        reason: null,
        unsupportedFields: [],
      })),
    },
    {
      id: 11,
      provider: 'qbd',
      connectionClass: 'local_desktop',
      displayName: 'Desktop books',
      externalCompany: 'desktop-11',
      status: 'inactive',
      lastVerifiedAt: null,
      edition: 'premier',
      supported: false,
      gaps: ['Connection is inactive; reconnect or reactivate it before using accounting operations.'],
      capabilities: ['verify_company', 'query', 'post_bill', 'read_back', 'attach'].map((operation) => ({
        provider: 'qbd',
        edition: 'premier',
        operation,
        supported: false,
        reason: 'Connection is inactive; reconnect or reactivate it before using accounting operations.',
        unsupportedFields: [],
      })),
    },
    {
      id: 12,
      provider: 'qbo',
      connectionClass: 'cloud',
      displayName: 'Unsupported product',
      externalCompany: 'realm-12',
      status: 'active',
      lastVerifiedAt: null,
      edition: 'self_employed',
      supported: false,
      gaps: ['QuickBooks Online Self-Employed is not supported; connect an Accounting API company.'],
      capabilities: ['verify_company', 'query', 'post_bill', 'read_back', 'attach'].map((operation) => ({
        provider: 'qbo',
        edition: 'self_employed',
        operation,
        supported: false,
        reason: 'QuickBooks Online Self-Employed is not supported; connect an Accounting API company.',
        unsupportedFields: [],
      })),
    },
  ],
};

let app: ElectronApplication;
let win: Page;

test.describe('Settings — provider health', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    ({ app, win } = await launch());
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('settings presents QBO capability truth and actionable offline QBD health', async () => {
    await stubMe(app, OWNER);
    await stub(app, 'aphub:provider-capabilities:list', { ok: true, status: 200, data: PROVIDER_CONNECTIONS });
    await stub(app, 'aphub:provider-jobs:list', {
      ok: true,
      status: 200,
      data: {
        jobs: [
          {
            id: 1,
            connectionId: 11,
            operation: 'post_bill',
            status: 'held',
            attempts: 1,
            errorCode: 'UNCERTAIN_OUTCOME',
            errorDetail: 'provider result unknown',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    });
    await stub(app, 'aphub:onboarding:get', { ok: true, status: 200, data: { automationLevel: 'assisted' } });

    await win.goto('file:///settings');
    await expect(win.getByTestId('provider-10')).toContainText('Healthy');
    await expect(win.getByTestId('provider-10')).toContainText('post bill: Supported');
    await expect(win.getByTestId('provider-11')).toContainText('Offline');
    await expect(win.getByTestId('provider-11')).toContainText('reconnect or reactivate');
    await expect(win.getByTestId('provider-11')).toContainText('1 held');
    await expect(win.getByTestId('provider-12')).toContainText('Unsupported');
    await expect(win.getByTestId('provider-12')).toContainText('Self-Employed is not supported');
  });
});
