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
import { startDatabase, describeDatabaseFailure, type StartedLocalDatabase } from './database.js';
import { registerProductHandlers } from './ipc/dispatcher.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let engineState: EngineState = 'starting';
/** Set on Quit so the window's close handler stops hiding and actually exits. */
let quitting = false;
/** The supervised private database. Null until it is up, and again after shutdown. */
let database: StartedLocalDatabase | null = null;
/** The last plain-language database problem, if any. Never a code or a stack trace. */
let databaseProblem: string | null = null;

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
  // `problem` travels with the state so the boot screen can name what went wrong instead of
  // showing "starting up" forever. It is always a plain-language sentence, never a code.
  mainWindow?.webContents.send('aphub:status:engine', {
    state,
    label: engineStateLabel(state),
    problem: databaseProblem,
  });
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

/**
 * Bring the private database up, then report the shell as running.
 *
 * Deliberately not fatal. A database that will not start is a state the user must be able to
 * SEE and act on — quitting silently would leave them with an app that "does nothing when I
 * click it". `unstable` already carries the reassurance that their information is safe.
 */
async function startDatabaseSupervised(): Promise<void> {
  try {
    database = await startDatabase();
    databaseProblem = null;
    setEngineState('running');
  } catch (err) {
    database = null;
    databaseProblem = describeDatabaseFailure(err).message;
    /**
     * Diagnostic goes to the main-process log, never to the renderer. The user sees
     * `databaseProblem`; an operator debugging a failed launch needs the cause, and without
     * it a startup failure is indistinguishable from a hang. CHUNK_8 routes this into the
     * rotating log file.
     */
    const detail = (err as { detail?: string }).detail;
    console.error(
      '[aphub] database did not start:',
      (err as Error)?.name ?? 'Error',
      (err as Error)?.message ?? '',
      detail ? `\n${detail}` : '',
    );
    setEngineState('unstable');
  }
}

/**
 * Stop the database child before the process goes away.
 *
 * `stop()` is a graceful `pg_ctl -m fast`, which checkpoints. Skipping it would leave the
 * cluster to crash-recover on next launch — survivable, but it turns a one-second start into
 * a visibly slow one, and it is exactly the shutdown path CHUNK_8's reboot drill exercises.
 */
async function stopDatabase(): Promise<void> {
  const running = database;
  database = null;
  if (running === null) return;
  try {
    /**
     * Bounded. `pg_ctl -m fast` normally returns in well under a second, but quit must not
     * be able to hang on it: a stuck shutdown would leave the single-instance lock held and
     * the app unable to start again. Crash recovery on the next launch is a far cheaper
     * failure than an app that will not reopen.
     */
    await Promise.race([
      running.postgres.stop(),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]);
  } catch {
    // Already gone, or refusing to stop. Nothing further is safe to do during teardown, and
    // the cluster recovers on next launch.
  }
}

/** Quit stops all children. CHUNK_8 adds the supervised engine teardown alongside this. */
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
  handle('aphub:shell:status', () => ({
    engine: engineState,
    label: engineStateLabel(engineState),
    // Words only. The port, the connection string and the password never cross the bridge —
    // `ready` is the entire truth the renderer is entitled to about the database.
    database: database === null ? 'unavailable' : 'ready',
    problem: databaseProblem,
  }));
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
    /*
     * CHUNK_3_IPC. `databaseState` is read per call rather than captured, so a database that
     * comes up mid-session starts serving without a restart. It reads the same two variables
     * `aphub:shell:status` reports from, so the renderer can never see the bridge and the
     * status line disagree.
     *
     * `contributions` is empty until B3 (read domains) and B4 (action domains) land, which
     * makes this call inert: it registers no channel and changes no behaviour. It is wired
     * now so the seam is proven under a real Electron process before 50 channels depend on it.
     */
    registerProductHandlers({
      ipcMain,
      databaseState: () =>
        database !== null ? 'ready' : databaseProblem === null ? 'starting' : 'failed',
      contributions: [],
    });
    mainWindow = createWindow();
    createTray();
    // Not awaited: the window and tray must appear immediately, showing DB_STARTING, rather
    // than the app looking dead for the ~13 s a first-launch `initdb` takes.
    void startDatabaseSupervised();
  });

  // Closing every window does NOT quit: the engine keeps processing from the tray.
  app.on('window-all-closed', () => {});

  app.on('activate', () => showWindow());

  /**
   * Hold the quit open until the database has checkpointed. `before-quit` is the last point
   * at which an async teardown can still run; `will-quit` fires too late for a child that
   * needs a graceful stop. The re-entry guard is what stops `app.quit()` here from looping.
   */
  let stopping = false;
  app.on('before-quit', (event) => {
    quitting = true;
    if (stopping || database === null) return;
    stopping = true;
    event.preventDefault();
    void stopDatabase().finally(() => app.quit());
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
