import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';

/**
 * CHUNK_1_SHELL — renderer hardening proved against a REAL running Electron process.
 *
 * test/desktop-shell.test.ts asserts the configuration; this asserts the consequence. Both
 * are needed: the unit test would still pass if desktop/main.ts forgot to apply the settings
 * it imports, and this test would still pass if it were the only one but somebody replaced
 * the assertions with a screenshot.
 */

const MAIN = join(process.cwd(), 'dist-desktop', 'main.mjs');

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: [MAIN] });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

test('renderer has no Node primitives (contextIsolation + sandbox hold)', async () => {
  const probe = await win.evaluate(() => ({
    require: typeof (window as any).require,
    process: typeof (window as any).process,
    module: typeof (window as any).module,
    global: typeof (window as any).global,
    Buffer: typeof (window as any).Buffer,
    electron: typeof (window as any).electron,
  }));
  expect(probe).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    global: 'undefined',
    Buffer: 'undefined',
    electron: 'undefined',
  });
});

test('the preload bridge is present, frozen, and enumerates its channels', async () => {
  const bridge = await win.evaluate(() => {
    const api = (window as any).aphub;
    return {
      present: typeof api === 'object' && api !== null,
      frozen: Object.isFrozen(api),
      hasInvoke: typeof api?.invoke === 'function',
      channels: api?.channels ?? null,
      platform: api?.platform ?? null,
    };
  });
  expect(bridge.present).toBe(true);
  expect(bridge.frozen).toBe(true);
  expect(bridge.hasInvoke).toBe(true);
  expect(Array.isArray(bridge.channels)).toBe(true);
  expect(bridge.channels).toContain('aphub:shell:version');
  expect(['win32', 'darwin']).toContain(bridge.platform);
});

test('a registered channel answers with the ok envelope', async () => {
  const res = await win.evaluate(() => (window as any).aphub.invoke('aphub:shell:version'));
  expect(res.ok).toBe(true);
  expect(typeof res.data.version).toBe('string');
});

test('an unregistered channel is refused without leaking the channel name', async () => {
  const res = await win.evaluate(() =>
    (window as any).aphub.invoke('aphub:secrets:read', { target: 'APHub/x/y' }),
  );
  expect(res.ok).toBe(false);
  expect(res.message).not.toContain('aphub:secrets:read');
  // Plain language, no code echoed to the user.
  expect(res.message).toBe('BookScout OS could not complete that action.');
});

test('the renderer cannot widen the bridge by mutating it', async () => {
  const escaped = await win.evaluate(() => {
    try {
      (window as any).aphub.invoke = () => Promise.resolve({ ok: true, data: 'pwned' });
    } catch {
      /* frozen object in strict mode throws — also a pass */
    }
    return (window as any).aphub.invoke('aphub:secrets:read');
  });
  expect(escaped.ok).toBe(false);
});

test('the renderer issues no network requests', async () => {
  const requests: string[] = [];
  win.on('request', (r) => {
    const url = r.url();
    if (url.startsWith('http://') || url.startsWith('https://')) requests.push(url);
  });
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  expect(requests).toEqual([]);
});

test('a Content-Security-Policy with no remote origin is applied to the document', async () => {
  const csp = await win.evaluate(async () => {
    // The policy is delivered as a response header; confirm it is enforced by observing
    // that a remote connection is refused rather than merely reading the header back.
    try {
      await fetch('https://example.com/');
      return 'ALLOWED';
    } catch {
      return 'BLOCKED';
    }
  });
  expect(csp).toBe('BLOCKED');
});
