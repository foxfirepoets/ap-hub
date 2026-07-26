import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CHUNK_2_DATABASE — regressions for two packaging defects that both produced a shell which
 * launched cleanly and then failed at runtime. Neither was caught by typecheck, lint or any
 * unit test, and both cost a full debugging cycle, so each gets a test that recreates the
 * CONDITION rather than the symptom.
 *
 * 1. Bundling CommonJS `pg` into the ESM main process. esbuild rewrites its `require()` calls
 *    into a shim that throws `Dynamic require of "events" is not supported` the moment the
 *    module is used — so the app started, showed a window, and died on its first database call.
 *
 * 2. Deriving the development resource root from `app.getAppPath()`. Electron sets that to the
 *    directory containing the entry script, so it resolved to `<root>/dist-desktop` and the
 *    bundled PostgreSQL was looked for at `dist-desktop/pgsql/bin`, which never exists.
 */

const ROOT = join(__dirname, '..');
const BUILD_SCRIPT = join(ROOT, 'scripts', 'build-desktop.mjs');
const DATABASE_TS = join(ROOT, 'desktop', 'database.ts');
const MAIN_BUNDLE = join(ROOT, 'dist-desktop', 'main.mjs');

describe('Electron main process is ESM with external packages', () => {
  const script = readFileSync(BUILD_SCRIPT, 'utf8');

  it("builds main with packages: 'external' so no CommonJS dependency is inlined", () => {
    // The main build block, up to the preload build that follows it.
    const mainBlock = script.slice(script.indexOf("'main.ts'"), script.indexOf("'preload.ts'"));
    expect(mainBlock).toMatch(/packages:\s*'external'/);
    expect(mainBlock).toMatch(/format:\s*'esm'/);
  });

  it('keeps the preload BUNDLED, because a sandboxed preload cannot resolve modules', () => {
    const preloadBlock = script.slice(script.indexOf("'preload.ts'"));
    expect(preloadBlock).not.toMatch(/packages:\s*'external'/);
    expect(preloadBlock).toMatch(/format:\s*'cjs'/);
  });

  it('fails the build when a package is embedded in the ESM bundle', () => {
    // The guard itself must exist — without it the defect returns silently.
    expect(script).toMatch(/Dynamic require of/);
    expect(script).toMatch(/node_modules\/pg\/lib\/client\.js/);
    expect(script).toMatch(/process\.exit\(1\)/);
  });

  it('leaves pg out of the built main bundle', () => {
    // Only meaningful once the shell has been built; `npm run test:ui-contract` builds first.
    if (!existsSync(MAIN_BUNDLE)) return;
    const bundle = readFileSync(MAIN_BUNDLE, 'utf8');
    expect(bundle).not.toMatch(/Dynamic require of/);
    expect(bundle).not.toContain('node_modules/pg/lib/client.js');
    // It must still REACH pg — as an import Node resolves, not as inlined source.
    expect(bundle).toMatch(/from\s*["']pg["']/);
  });
});

describe('bundled runtime path resolution', () => {
  const source = readFileSync(DATABASE_TS, 'utf8');

  it('does not derive the development resource root from app.getAppPath()', () => {
    const resourceRoot = source.slice(
      source.indexOf('export function resourceRoot'),
      source.indexOf('export function migrationsDir'),
    );
    expect(resourceRoot).not.toContain('getAppPath');
    // Derived from this module's own location instead: `<root>/dist-desktop` → `<root>`.
    expect(resourceRoot).toContain('dirname(HERE)');
  });

  it('uses resourcesPath only when packaged', () => {
    expect(source).toMatch(/app\.isPackaged\s*\?\s*process\.resourcesPath/);
  });

  it('checks the bundled executable exists before trying to run it', () => {
    // A missing executable surfaces from execFile as a failed spawn with EMPTY stderr, which
    // reads in a log exactly like "initdb ran and failed" — the wrong diagnosis.
    expect(source).toMatch(/existsSync\(initdb\)/);
    expect(source).toMatch(/bundled runtime is missing/);
  });
});

describe('packaging config ships what the external bundle needs', () => {
  const builder = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('keeps pg a production dependency, because the main bundle imports it at runtime', () => {
    expect(pkg.dependencies?.pg).toBeTruthy();
    expect(pkg.devDependencies?.pg).toBeUndefined();
  });

  it('includes node_modules in the packaged app', () => {
    expect(builder).toMatch(/node_modules\/\*\*\/\*/);
  });

  it('ships the PostgreSQL binaries and migrations OUTSIDE the asar', () => {
    // Windows cannot execute a file that exists only inside an asar archive, and the
    // migration runner reads real files.
    const extra = builder.slice(builder.indexOf('extraResources:'), builder.indexOf('asar:'));
    expect(extra).toMatch(/from:\s*vendor\/pgsql/);
    expect(extra).toMatch(/to:\s*pgsql/);
    expect(extra).toMatch(/from:\s*migrations/);
  });
});
