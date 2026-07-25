/**
 * CHUNK_1_SHELL — the Electron main process.
 *
 * Owns the window, the tray, and (from CHUNK_2 onward) the lifecycle of every child process.
 * This is the only component that touches the credential store, and the only one that may
 * open a URL outside the app.
 *
 * Everything security-relevant is decided by the pure predicates in `./channels.js` and
 * `./security.js`, which the validation gate asserts directly. This file is wiring.
 */

import { app, BrowserWindow, Menu, Tray, ipcMain, shell, session, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedChannel, isAllowedExternalUrl, isAllowedNavigation } from './channels.js';
import { RENDERER_WEB_PREFERENCES, RENDERER_CSP } from './security.js';
import { engineStateLabel, type EngineState } from './status.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let engineState: EngineState = 'starting';
/** Set on Quit so the window's close handler stops hiding and actually exits. */
let quitting = false;

/**
 * The renderer entry. CHUNK_3 static-exports the React tree to `out/`; until then the shell
 * loads its own plain-language boot page, which is also the `DB_STARTING` surface the happy
 * path shows while the engine and database come up.
 */
function rendererEntry(): string {
  const exported = join(app.getAppPath(), 'out', 'index.html');
  if (existsSync(exported)) return exported;
  return join(HERE, 'boot.html');
}

/** Apply the CSP to every response in the app's session. No remote origin is named. */
function applyContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [RENDERER_CSP],
      },
    });
  });
}

/**
 * Refuse every permission request. The renderer has no legitimate need for camera,
 * microphone, geolocation, notifications or clipboard-read — notifications are raised by
 * the main process (CHUNK_8), not the page.
 */
function denyAllPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'AP-Hub',
    webPreferences: {
      ...RENDERER_WEB_PREFERENCES,
      preload: join(HERE, 'preload.cjs'),
    },
  });

  // Block in-window navigation to anything that is not the app's own files.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });

  // A target=_blank or window.open never opens an Electron window. Provider consent goes to
  // the system browser and only for an allowlisted host; everything else is simply denied.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // A webview tag is disabled in webPreferences; refuse to attach one even so.
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  win.once('ready-to-show', () => win.show());

  // Closing the window leaves the engine running in the tray. Quit stops everything.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  void win.loadFile(rendererEntry());
  return win;
}

function showWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function setEngineState(state: EngineState): void {
  engineState = state;
  refreshTrayMenu();
  mainWindow?.webContents.send('aphub:status:engine', { state, label: engineStateLabel(state) });
}

function refreshTrayMenu(): void {
  if (tray === null) return;
  const paused = engineState === 'paused';
  tray.setToolTip(`AP-Hub — ${engineStateLabel(engineState)}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: engineStateLabel(engineState), enabled: false },
      { type: 'separator' },
      { label: 'Open AP-Hub', click: () => showWindow() },
      {
        label: 'Pause processing',
        enabled: !paused,
        // CHUNK_8 wires this to the supervisor; the state it reflects already exists.
        click: () => setEngineState('paused'),
      },
      { label: 'Resume processing', enabled: paused, click: () => setEngineState('running') },
      { type: 'separator' },
      { label: 'Quit AP-Hub', click: () => quitApp() },
    ]),
  );
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(HERE, 'assets', 'tray.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.on('click', () => showWindow());
  refreshTrayMenu();
}

/** Quit stops all children. CHUNK_8 adds the supervised engine and database teardown here. */
function quitApp(): void {
  quitting = true;
  app.quit();
}

/**
 * Register the shell's own channels. Every handler returns the `{ ok, data }` /
 * `{ ok, code, message }` envelope; raw text never crosses the bridge. The allowlist is
 * re-checked here so a compromised preload cannot widen the surface.
 */
function registerShellHandlers(): void {
  const handle = (channel: string, fn: () => unknown): void => {
    if (!isAllowedChannel(channel)) throw new Error('UNREGISTERED_CHANNEL');
    ipcMain.handle(channel, () => ({ ok: true, data: fn() }));
  };

  handle('aphub:shell:version', () => ({ version: app.getVersion() }));
  handle('aphub:shell:status', () => ({ engine: engineState, label: engineStateLabel(engineState) }));
}

/**
 * A second launch focuses the existing window instead of starting a second AP-Hub. Without
 * the lock, two instances would supervise two PostgreSQL children over one data directory.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  void app.whenReady().then(() => {
    applyContentSecurityPolicy();
    denyAllPermissions();
    registerShellHandlers();
    mainWindow = createWindow();
    createTray();
  });

  // Closing every window does NOT quit: the engine keeps processing from the tray.
  app.on('window-all-closed', () => {});

  app.on('activate', () => showWindow());

  app.on('before-quit', () => {
    quitting = true;
  });

  /**
   * Belt-and-braces: refuse any attempt to attach a webview or navigate away, for every
   * WebContents the app ever creates, not just the main window.
   */
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}
