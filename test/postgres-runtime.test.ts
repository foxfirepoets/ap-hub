import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PostgresRuntime,
  generateDatabasePassword,
  buildConnectionString,
  isInitialisedCluster,
  DataDirectoryNotOurs,
} from '../src/db/postgres-runtime.js';

/**
 * CHUNK_2_DATABASE — the bundled PostgreSQL must never expose its password to another process
 * and must never adopt a data directory it did not create. Both are asserted here without
 * launching a real server; `test/db-bootstrap.test.ts` covers port behaviour against real
 * sockets, and the migration suite covers the live database.
 */

/** The `execFile` callback shape, named so the tests need no `Function` type. */
type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'aphub-pg-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('generated database credentials', () => {
  it('produces a high-entropy, URL-safe password', () => {
    const p = generateDatabasePassword();
    expect(p.length).toBeGreaterThanOrEqual(43);       // 32 bytes base64url
    expect(p).toMatch(/^[A-Za-z0-9_-]+$/);             // survives a URL unescaped
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateDatabasePassword()));
    expect(seen.size).toBe(200);
  });

  it('builds a loopback connection string with no sslmode and an escaped password', () => {
    const cs = buildConnectionString({ user: 'aphub', password: 'a/b+c=d', port: 55433, database: 'aphub' });
    expect(cs).toContain('@127.0.0.1:55433/');
    expect(cs).not.toContain('sslmode');
    expect(cs).not.toContain('a/b+c=d');               // escaped, not raw
    // `URL.password` returns the still-encoded value; pg decodes it the same way on connect.
    expect(decodeURIComponent(new URL(cs).password)).toBe('a/b+c=d');
  });
});

describe('the password never reaches argv or the environment (spec §9)', () => {
  it('passes the password to initdb through a mode-0600 file and deletes it afterwards', async () => {
    const dataDir = join(tmp(), 'data');
    const password = generateDatabasePassword();
    let capturedArgs: string[] = [];
    let pwFileContentsAtCallTime: string | null = null;

    const rt = new PostgresRuntime({
      binDir: '/fake/bin',
      dataDir,
      port: 55999,
      execFileImpl: ((_cmd: string, args: string[], _o: unknown, cb: ExecCb) => {
        capturedArgs = args;
        const pwArg = args.find((a) => a.startsWith('--pwfile='));
        if (pwArg) pwFileContentsAtCallTime = readFileSync(pwArg.slice('--pwfile='.length), 'utf8');
        // Simulate a successful initdb by creating the marker it would create.
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(join(dataDir, 'PG_VERSION'), '16\n');
        cb(null, '', '');
        return {} as never;
      }) as never,
    });

    await rt.initialise(password);

    // The secret was delivered by file...
    expect(pwFileContentsAtCallTime).toBe(password);
    // ...and never as a command-line argument.
    expect(capturedArgs.some((a) => a.includes(password))).toBe(false);
    // ...and the file does not survive.
    expect(existsSync(join(dataDir, '.initpw'))).toBe(false);
  });

  it('deletes the password file even when initdb fails', async () => {
    const dataDir = join(tmp(), 'data');
    const rt = new PostgresRuntime({
      binDir: '/fake/bin',
      dataDir,
      port: 55999,
      execFileImpl: ((_c: string, _a: string[], _o: unknown, cb: ExecCb) => {
        cb(new Error('boom'), '', 'boom');
        return {} as never;
      }) as never,
    });
    await expect(rt.initialise(generateDatabasePassword())).rejects.toThrow();
    expect(existsSync(join(dataDir, '.initpw'))).toBe(false);
  });

  it('never puts raw OS error text into the thrown message', async () => {
    const dataDir = join(tmp(), 'data');
    const rt = new PostgresRuntime({
      binDir: '/fake/bin',
      dataDir,
      port: 55999,
      execFileImpl: ((_c: string, _a: string[], _o: unknown, cb: ExecCb) => {
        cb(new Error('ENOENT spawn C:\\secret\\path\\initdb.exe'), '', 'stack trace here');
        return {} as never;
      }) as never,
    });
    await expect(rt.initialise('pw')).rejects.toThrow(/PostgreSQL did not start/);
    await rt.initialise('pw').catch((e: Error) => {
      expect(e.message).not.toContain('ENOENT');
      expect(e.message).not.toContain('stack trace');
    });
  });
});

describe('the runtime never adopts a directory it did not create', () => {
  it('refuses to start against a directory with no PG_VERSION', async () => {
    const dataDir = tmp();
    writeFileSync(join(dataDir, 'someone-elses-file.txt'), 'important user data');
    const rt = new PostgresRuntime({ binDir: '/fake/bin', dataDir, port: 55999 });
    await expect(rt.start()).rejects.toBeInstanceOf(DataDirectoryNotOurs);
    // The foreign file is untouched.
    expect(existsSync(join(dataDir, 'someone-elses-file.txt'))).toBe(true);
  });

  it('is idempotent: an already-initialised cluster is left alone', async () => {
    const dataDir = tmp();
    writeFileSync(join(dataDir, 'PG_VERSION'), '16\n');
    writeFileSync(join(dataDir, 'postgresql.conf'), '# user tuning\nshared_buffers = 256MB\n');
    let called = false;
    const rt = new PostgresRuntime({
      binDir: '/fake/bin',
      dataDir,
      port: 55999,
      execFileImpl: ((_c: string, _a: string[], _o: unknown, cb: ExecCb) => {
        called = true;
        cb(null, '', '');
        return {} as never;
      }) as never,
    });
    await rt.initialise(generateDatabasePassword());
    expect(called).toBe(false);                                      // initdb never ran again
    expect(readFileSync(join(dataDir, 'postgresql.conf'), 'utf8')).toContain('shared_buffers');
  });

  it('recognises an initialised cluster by its PG_VERSION marker', () => {
    const d = tmp();
    expect(isInitialisedCluster(d)).toBe(false);
    writeFileSync(join(d, 'PG_VERSION'), '16\n');
    expect(isInitialisedCluster(d)).toBe(true);
  });
});

describe('the server binds loopback only', () => {
  it('passes listen_addresses=127.0.0.1 and the probed port to postgres', async () => {
    const dataDir = tmp();
    writeFileSync(join(dataDir, 'PG_VERSION'), '16\n');
    let spawnArgs: string[] = [];
    const rt = new PostgresRuntime({
      binDir: '/fake/bin',
      dataDir,
      port: 55987,
      spawnImpl: ((_c: string, args: string[]) => {
        spawnArgs = args;
        return { on: () => {}, pid: 4242 } as never;
      }) as never,
      execFileImpl: ((_c: string, _a: string[], _o: unknown, cb: ExecCb) => {
        cb(null, '', '');                                            // pg_isready succeeds
        return {} as never;
      }) as never,
    });
    await rt.start();
    expect(spawnArgs).toContain('listen_addresses=127.0.0.1');
    expect(spawnArgs).toContain('55987');
    // Never binds every interface.
    expect(spawnArgs.some((a) => a.includes('0.0.0.0') || a.includes('*'))).toBe(false);
  });
});
