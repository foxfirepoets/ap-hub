/**
 * CHUNK_1_SHELL — renderer hardening, expressed as data so the gate can assert it.
 *
 * Spec §9: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity`
 * on, and a CSP with no remote origins. Electron's defaults already point this way on 33.x,
 * but "the default is currently safe" is not a control — these are set explicitly and
 * asserted by `test/desktop-shell.test.ts` so a future Electron default flip cannot silently
 * hand the renderer more power.
 */

/** Exactly the webPreferences the app window is constructed with. */
export const RENDERER_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
});

/**
 * Content-Security-Policy for the renderer. No remote origin appears in any directive.
 * `'unsafe-inline'` is permitted for styles only: the statically exported Next build emits
 * inline <style> blocks, and styles cannot exfiltrate over IPC. Scripts get no such latitude.
 */
export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Directives that must never name a remote origin. Asserted by the gate. */
const REMOTE_ORIGIN_PATTERN = /(https?:)?\/\//;

/**
 * True when the policy contains no remote origin in any directive. Used by the gate rather
 * than eyeballing the string, so an added CDN cannot slip in with a passing test.
 */
export function cspHasNoRemoteOrigin(csp: string): boolean {
  return !REMOTE_ORIGIN_PATTERN.test(csp);
}

/**
 * `connect-src 'none'` is the load-bearing directive for acceptance criterion "the renderer
 * performs zero HTTP requests to an BookScout OS origin". With it, renderer `fetch`/XHR/WebSocket
 * cannot reach anything at all — product operations travel over IPC or not at all.
 */
export function cspForbidsNetwork(csp: string): boolean {
  return /(^|;)\s*connect-src\s+'none'\s*(;|$)/.test(csp);
}
