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

import { app, BrowserWindow, Menu, Tray, ipcMain, protocol, shell, session, nativeImage } from 'electron';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAllowedChannel, isAllowedExternalUrl, isAllowedNavigation } from './channels.js';
import { RENDERER_WEB_PREFERENCES, RENDERER_CSP } from './security.js';
import { contentTypeFor, resolveRendererRequest } from './renderer.js';
import { engineStateLabel, type EngineState } from './status.js';
import { startDatabase, describeDatabaseFailure, type StartedLocalDatabase } from './database.js';
import { establishLocalIdentity } from './local-signin.js';
import { closePool } from '../src/db/pool.js';
import { hasSession } from './ipc/context.js';
import { registerProductHandlers } from './ipc/dispatcher.js';
import { READ_CHANNELS } from './ipc/read/channels.js';
import { READ_ENTRIES } from './ipc/read/index.js';
import { ACTION_CHANNELS } from './ipc/action/channels.js';
import { ACTION_ENTRIES } from './ipc/action/index.js';

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

/** True only for a real file. Injected into the pure resolver so it stays testable. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Root of the statically exported React tree, or null when it has not been built.
 *
 * Development deliberately does NOT use `app.getAppPath()` — Electron sets that to the directory
 * containing the entry script, so launching `electron dist-desktop/main.mjs` makes it
 * `<root>/dist-desktop` and `out/` would be looked for one level too deep. This mirrors
 * `resourceRoot()` in ./database.ts, which was corrected for exactly the same reason.
 */
function exportedRendererRoot(): string | null {
  const root = join(app.isPackaged ? app.getAppPath() : dirname(HERE), 'out');
  return isFile(join(root, 'index.html')) ? root : null;
}

/** The shell's own startup screen, addressed by its literal path on disk. */
function startupScreen(): string {
  return pathToFileURL(join(HERE, 'boot.html')).toString();
}

/**
 * The app itself — an address inside the exported tree, not a disk path.
 *
 * The ROOT-relative form is not a stylistic choice. The exported pages name their own scripts and
 * styles root-relatively, so the whole document tree has to share one root, and that root is the
 * exported renderer. Opening a page by its literal disk path instead leaves every one of those
 * references pointing at the root of the drive, where nothing lives.
 *
 * Which address: the screen the person will actually be looking at. The exported root
 * (`out/index.html`) is only a forwarding stub — it holds no screen of its own and sends the window
 * on to Today, which sends it on again to sign-in when nobody is signed in. Opening straight at the
 * destination costs two fewer full page loads, and it keeps the hand-over a SINGLE navigation. The
 * stub still works and is still proved to (`e2e-desktop/renderer.spec.ts`); it is simply not where
 * the window is pointed.
 */
function appEntry(): string {
  return hasSession() ? 'file:///today' : 'file:///login';
}

/**
 * The two states in which the startup screen — not the app — is the right thing to be looking at.
 *
 * `unstable` is the load-bearing one. It is the state CHUNK_2's boot screen was built for: the
 * database did not come up, and the person needs the sentence saying so and what to do next. Show
 * them the app instead and they get a working-looking product with no information in it and no
 * explanation — the dead end the guardrails forbid, and the exact defect that fix removed.
 */
function isStartupSurfaceState(state: EngineState): boolean {
  return state === 'starting' || state === 'unstable';
}

/**
 * What a newly created window opens.
 *
 * A window created during startup gets the startup screen; one reopened from the tray after the
 * database is already up goes straight to the app, because the startup screen has no job left.
 * Without an export at all — a checkout where `npm run web:build` has not run — the startup screen
 * is all there is.
 */
function rendererEntry(): string {
  if (exportedRendererRoot() === null) return startupScreen();
  return isStartupSurfaceState(engineState) ? startupScreen() : appEntry();
}

/**
 * How long "AP-Hub is ready." stays on screen before the window hands over to the app.
 *
 * A beat, not a delay. This is the one moment AP-Hub tells the person their private database came
 * up and their information is safe, and a message shown for zero frames has not been shown. It also
 * makes the hand-over an observable step rather than a flicker, which is what lets
 * `e2e-desktop/database.spec.ts` — CHUNK_2's proof, and not editable — still see the startup screen
 * reach its ready state. That test polls the shell once a second, so the beat has to outlast a poll
 * interval by a clear margin; three seconds gives it two.
 */
const READY_BEAT_MS = 3000;

let handOverTimer: ReturnType<typeof setTimeout> | null = null;

/** True while the window is still showing the shell's own startup screen. */
function isShowingStartupScreen(win: BrowserWindow): boolean {
  return win.webContents.getURL().startsWith(startupScreen());
}

/**
 * Replace the startup screen with the app, once.
 *
 * Every condition is re-checked at the moment of the swap rather than when it was scheduled: the
 * window may have gone, the engine may have fallen back to a state that needs the startup screen,
 * or the window may already have been navigated somewhere. In each case the right move is to leave
 * it alone.
 */
function handOverToApp(): void {
  handOverTimer = null;
  const win = mainWindow;
  if (win === null || win.isDestroyed()) return;
  if (exportedRendererRoot() === null) return;
  if (isStartupSurfaceState(engineState)) return;
  if (!isShowingStartupScreen(win)) return;
  void win.loadURL(appEntry());
}

function scheduleHandOverToApp(): void {
  if (handOverTimer !== null) return;
  handOverTimer = setTimeout(handOverToApp, READY_BEAT_MS);
}

function cancelHandOverToApp(): void {
  if (handOverTimer === null) return;
  clearTimeout(handOverTimer);
  handOverTimer = null;
}

/**
 * Serve the exported renderer over the built-in `file:` scheme.
 *
 * No new scheme is registered and no security setting is relaxed: `isAllowedNavigation` still
 * accepts `file:` and nothing else, and the window keeps context isolation, the sandbox and the
 * no-remote-origin policy. All this changes is WHICH file answers a given address — see
 * ./renderer.ts for the rules, which are asserted directly by the gate.
 */
function serveExportedRenderer(): void {
  const outDir = exportedRendererRoot();
  protocol.handle('file', async (request) => {
    const resolution = resolveRendererRequest(new URL(request.url).pathname, outDir, isFile);
    if (resolution.kind === 'missing') {
      // Answered as missing rather than substituted with a page: the renderer's own router
      // depends on a missing data address failing so it falls back to a full page load.
      return new Response(null, { status: 404 });
    }
    let body: Buffer;
    try {
      body = await readFile(resolution.path);
    } catch {
      // Unreadable between the existence check and the read. Answered as missing rather than left
      // to reject: an unhandled rejection here would fail the request with nothing in the log.
      return new Response(null, { status: 404 });
    }
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': contentTypeFor(resolution.path),
        // Also applied to every response by `applyContentSecurityPolicy`. Repeated here so a
        // response this handler produces carries the policy on its own account.
        'Content-Security-Policy': RENDERER_CSP,
      },
    });
  });
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

  void win.loadURL(rendererEntry());
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
  // The database is up: let the ready message be read, then show the app. A failed start
  // deliberately schedules nothing — the startup screen stays, carrying the explanation.
  if (state === 'running') scheduleHandOverToApp();
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
    // The one place `src/services/**` learns where the private database lives — `getPool()`
    // (`src/db/pool.ts`) reads this lazily on first query. Nothing else may set it: the
    // connection string never crosses the bridge, never reaches a log, and is not the
    // renderer's to know.
    process.env.DATABASE_URL = database.connectionString;
    // CHUNK_4_IDENTITY: the OS account that opened AP-Hub becomes its owner, with no password
    // and no browser tab. `database.install.osAccountId` is already verified against the
    // running account (`OsAccountMismatch` would have thrown inside `startDatabase()`).
    await establishLocalIdentity(database.install.osAccountId);
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
     * Close this process's own query pool first. CHUNK_4_IDENTITY's local sign-in is the
     * first thing in the main process to ever open one (`src/db/pool.ts`'s `getPool()`
     * singleton) — an unclosed `pg.Pool` holds a live socket that keeps Node's event loop,
     * and therefore the whole app, from exiting even after the window is gone. Bounded for
     * the same reason the stop below is: quit must not be able to hang on it.
     */
    await Promise.race([closePool(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
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
  cancelHandOverToApp();
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
    serveExportedRenderer();
    registerShellHandlers();
    /*
     * CHUNK_3_IPC. `databaseState` is read per call rather than captured, so a database that
     * comes up mid-session starts serving without a restart. It reads the same two variables
     * `aphub:shell:status` reports from, so the renderer can never see the bridge and the
     * status line disagree.
     *
     * B3's 21 read channels are live. B4's action channels are appended here when they merge;
     * the dispatcher asserts registry/allowlist symmetry in both directions, so a channel that
     * exists in only one of the two places fails at startup rather than at a user's keystroke.
     */
    registerProductHandlers({
      ipcMain,
      databaseState: () =>
        database !== null ? 'ready' : databaseProblem === null ? 'starting' : 'failed',
      contributions: [
        { channels: READ_CHANNELS, entries: READ_ENTRIES },
        { channels: ACTION_CHANNELS, entries: ACTION_ENTRIES },
      ],
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
    cancelHandOverToApp();
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
