import { describe, it, expect } from 'vitest';
import {
  IPC_CHANNELS,
  SHELL_CHANNELS,
  CHANNEL_PATTERN,
  PROVIDER_HOSTS,
  isAllowedChannel,
  isAllowedExternalUrl,
  isAllowedNavigation,
} from '../desktop/channels.js';
import { READ_CHANNELS } from '../desktop/ipc/read/channels.js';
import { ACTION_CHANNELS } from '../desktop/ipc/action/channels.js';
import {
  RENDERER_WEB_PREFERENCES,
  RENDERER_CSP,
  cspHasNoRemoteOrigin,
  cspForbidsNetwork,
} from '../desktop/security.js';
import { ENGINE_STATES, engineStateLabel } from '../desktop/status.js';

/**
 * CHUNK_1_SHELL guarantees. These assert the renderer's power envelope directly, rather than
 * trusting Electron's defaults or the wiring in desktop/main.ts. A future Electron release
 * that flips a default, or a well-meaning change that adds a CDN to the CSP, fails here.
 */

describe('renderer_hardening (spec §9)', () => {
  it('constructs the window with context isolation, sandbox, and no Node integration', () => {
    expect(RENDERER_WEB_PREFERENCES.contextIsolation).toBe(true);
    expect(RENDERER_WEB_PREFERENCES.sandbox).toBe(true);
    expect(RENDERER_WEB_PREFERENCES.nodeIntegration).toBe(false);
    expect(RENDERER_WEB_PREFERENCES.nodeIntegrationInWorker).toBe(false);
    expect(RENDERER_WEB_PREFERENCES.nodeIntegrationInSubFrames).toBe(false);
    expect(RENDERER_WEB_PREFERENCES.webSecurity).toBe(true);
    expect(RENDERER_WEB_PREFERENCES.allowRunningInsecureContent).toBe(false);
    expect(RENDERER_WEB_PREFERENCES.webviewTag).toBe(false);
  });

  it('freezes the preferences so nothing can widen them at runtime', () => {
    expect(Object.isFrozen(RENDERER_WEB_PREFERENCES)).toBe(true);
  });

  it('applies a CSP that names no remote origin', () => {
    expect(cspHasNoRemoteOrigin(RENDERER_CSP)).toBe(true);
    expect(RENDERER_CSP).toContain("default-src 'self'");
    expect(RENDERER_CSP).toContain("object-src 'none'");
    expect(RENDERER_CSP).toContain("frame-ancestors 'none'");
  });

  it("forbids renderer network access outright via connect-src 'none'", () => {
    expect(cspForbidsNetwork(RENDERER_CSP)).toBe(true);
  });

  it('detects a remote origin if one is ever added to the policy', () => {
    expect(cspHasNoRemoteOrigin("default-src 'self'; script-src https://cdn.example.com")).toBe(false);
    expect(cspForbidsNetwork("connect-src 'self'")).toBe(false);
  });
});

describe('ipc_surface_enumerated (spec §9)', () => {
  it('admits exactly the registered channels', () => {
    for (const channel of IPC_CHANNELS) expect(isAllowedChannel(channel)).toBe(true);
    /*
     * CHUNK_1 pinned this to `[...SHELL_CHANNELS]`. CHUNK_3 adds the 50 migrated product
     * operations, which `desktop/channels.ts` anticipates by name, so the expected set grows —
     * but the assertion keeps the SAME strength: an exact `toEqual` against the union of the
     * enumerated lists, with no `toContain`, no length check and no wildcard. An unenumerated
     * channel still fails, which is the security property spec §9 is protecting.
     *
     * Deliberately brittle: CHUNK_5 (connect) and CHUNK_7 (backup) will each break this line,
     * and that is the point — widening the renderer's reachable surface should require an
     * explicit, reviewed edit here rather than passing silently.
     */
    expect(IPC_CHANNELS).toEqual([...SHELL_CHANNELS, ...READ_CHANNELS, ...ACTION_CHANNELS]);
  });

  it('every registered channel is named aphub:<domain>:<action>', () => {
    for (const channel of IPC_CHANNELS) expect(channel).toMatch(CHANNEL_PATTERN);
  });

  it('refuses a well-formed name that nobody registered', () => {
    // The pattern is a shape check, never an admission rule.
    expect('aphub:secrets:read').toMatch(CHANNEL_PATTERN);
    expect(isAllowedChannel('aphub:secrets:read')).toBe(false);
  });

  it('refuses malformed, non-string and prototype-shaped channel names', () => {
    for (const bad of [
      '',
      'aphub:shell',
      'APHUB:SHELL:VERSION',
      'aphub:shell:version ',
      '../aphub:shell:version',
      'constructor',
      '__proto__',
      'toString',
      null,
      undefined,
      42,
      {},
      ['aphub:shell:version'],
    ]) {
      expect(isAllowedChannel(bad)).toBe(false);
    }
  });

  it('freezes the channel list', () => {
    expect(Object.isFrozen(IPC_CHANNELS)).toBe(true);
  });
});

describe('external_navigation_allowlist (spec §9)', () => {
  it('permits https provider consent hosts only', () => {
    for (const host of PROVIDER_HOSTS) {
      expect(isAllowedExternalUrl(`https://${host}/o/oauth2/v2/auth?client_id=x`)).toBe(true);
    }
  });

  it('refuses a lookalike host that would pass a suffix check', () => {
    expect(isAllowedExternalUrl('https://accounts.google.com.evil.test/consent')).toBe(false);
    expect(isAllowedExternalUrl('https://evil.test/accounts.google.com')).toBe(false);
    // Subdomains are not implied by the allowlist entry.
    expect(isAllowedExternalUrl('https://evil.accounts.google.com/')).toBe(false);
  });

  it('refuses non-https schemes and embedded credentials', () => {
    for (const bad of [
      'http://accounts.google.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'https://user:pass@accounts.google.com/',
      'not-a-url',
      '',
      null,
      undefined,
      7,
    ]) {
      expect(isAllowedExternalUrl(bad)).toBe(false);
    }
  });

  it('blocks in-window navigation to anything but the app’s own files', () => {
    expect(isAllowedNavigation('file:///C:/app/out/index.html')).toBe(true);
    for (const bad of [
      'https://accounts.google.com/',   // consent goes to the system browser, not this window
      'http://127.0.0.1:3000/today',
      'about:blank',
      'javascript:alert(1)',
      '',
      null,
      undefined,
    ]) {
      expect(isAllowedNavigation(bad)).toBe(false);
    }
  });
});

describe('tray_speaks_plain_language (spec §16, CLAUDE.md)', () => {
  /** The vocabulary the user must never be shown. */
  const FORBIDDEN = [
    'api', 'key', 'token', 'port', 'environment variable', 'migration',
    'worker', 'model', 'json', 'stack trace', 'sql', 'oauth', 'localhost', '127.0.0.1',
  ];

  it('maps every engine state to a sentence, never a code', () => {
    for (const state of ENGINE_STATES) {
      const label = engineStateLabel(state);
      expect(label.length).toBeGreaterThan(0);
      // A label must not simply echo the machine state back at the user.
      expect(label.toLowerCase()).not.toBe(state);
      expect(label).toMatch(/^AP-Hub /);
    }
  });

  it('uses no technical vocabulary in any state label', () => {
    for (const state of ENGINE_STATES) {
      const label = engineStateLabel(state).toLowerCase();
      for (const word of FORBIDDEN) expect(label).not.toContain(word);
    }
  });

  it('reassures the user in the state where they would fear data loss', () => {
    expect(engineStateLabel('unstable')).toContain('Your information is safe.');
  });
});
