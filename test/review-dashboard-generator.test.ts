import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * CHUNK_8_REVIEWDASH — scripts/build-review-dashboard.mjs. No DB needed: the
 * generator is a pure function of its snapshot JSON argument. Covers: no external
 * host references, the `<`-escaped embedded DATA (so an injected `<script>` can
 * never break out of the artifact's own `<script>` tag), textContent-only
 * rendering (no `innerHTML`), and the BAD_SNAPSHOT failure path.
 */

const repoRoot = join(__dirname, '..');
const generator = join(repoRoot, 'scripts', 'build-review-dashboard.mjs');
const dir = mkdtempSync(join(tmpdir(), 'aphub-reviewdash-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSnapshot(name: string, data: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(data), 'utf8');
  return p;
}

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [generator, ...args], { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const baseSnapshot = {
  run: 'run-gen-test',
  tenant: 1,
  company: 'Test Co',
  generated: '2026-07-15T00:00:00.000Z',
  proposals: [
    {
      id: 1,
      vendor: '<script>alert(1)</script>',
      amount_cents: 12345,
      risk: 'high',
      issue: 'bank change warning',
      source: 'invoice.pdf',
      status: 'review',
      proof: { product: 'invoiceproof', verdict: 'critical' },
    },
    {
      id: 2,
      vendor: 'Acme Co',
      amount_cents: 500,
      risk: 'low',
      issue: 'ready',
      source: 'receipt.pdf',
      status: 'ready',
      proof: null,
    },
  ],
  vendorTotals: [
    { vendor: '<script>alert(1)</script>', count: 1, amount_cents: 12345 },
    { vendor: 'Acme Co', count: 1, amount_cents: 500 },
  ],
  summary: { count: 2, ready: 1, review: 1, exception: 0, amount_cents: 12845 },
};

describe('build-review-dashboard.mjs', () => {
  it('produces a self-contained HTML file with no http(s):// resource refs', () => {
    const inPath = writeSnapshot('snap1.json', baseSnapshot);
    const outPath = join(dir, 'out1.html');
    const res = run([inPath, outPath]);
    expect(res.status).toBe(0);
    const html = readFileSync(outPath, 'utf8');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('escapes an injected `<script>` in vendor/vendorTotals so it never becomes a live tag', () => {
    const inPath = writeSnapshot('snap2.json', baseSnapshot);
    const outPath = join(dir, 'out2.html');
    run([inPath, outPath]);
    const html = readFileSync(outPath, 'utf8');
    // The literal injected payload must never appear unescaped in the HTML source.
    expect(html).not.toContain('<script>alert(1)</script>');
    // The JS unicode-escape form must be present (proves every `<` was escaped, not dropped).
    expect(html).toMatch(/\\u003cscript>alert\(1\)\\u003c\/script>/);
    // Only the generator's own inline <script> tag(s) exist — no tag was injected.
    const scriptTagCount = (html.match(/<script(?:\s|>)/g) ?? []).length;
    expect(scriptTagCount).toBe(1);
  });

  it('renders all data via textContent, never innerHTML', () => {
    const inPath = writeSnapshot('snap3.json', baseSnapshot);
    const outPath = join(dir, 'out3.html');
    run([inPath, outPath]);
    const html = readFileSync(outPath, 'utf8');
    expect(html).not.toMatch(/innerHTML/);
    expect(html).toMatch(/textContent/);
  });

  it('includes the DRAFT stamp and localStorage under the aphub-review-<runId> key', () => {
    const inPath = writeSnapshot('snap4.json', baseSnapshot);
    const outPath = join(dir, 'out4.html');
    run([inPath, outPath]);
    const html = readFileSync(outPath, 'utf8');
    expect(html).toContain('DRAFT');
    expect(html).toContain('aphub-review-');
    expect(html).toMatch(/localStorage/);
  });

  it('HKO-audit MEDIUM fix: CSV export neutralizes leading formula-trigger characters (CWE-1236)', () => {
    const inPath = writeSnapshot('snap5.json', baseSnapshot);
    const outPath = join(dir, 'out5.html');
    run([inPath, outPath]);
    const html = readFileSync(outPath, 'utf8');
    // csvEscape must exist and guard against a field starting with =, +, -, or @
    // (a formula-injection payload that would execute when opened in Excel/Sheets).
    expect(html).toMatch(/function csvEscape/);
    expect(html).toMatch(/\^\[=\+@\\t\\r-\]/);
  });

  it('BAD_SNAPSHOT: malformed JSON exits non-zero and writes no HTML', () => {
    const inPath = join(dir, 'bad.json');
    writeFileSync(inPath, 'not json', 'utf8');
    const outPath = join(dir, 'out-bad.html');
    const res = run([inPath, outPath]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('BAD_SNAPSHOT');
    expect(() => readFileSync(outPath, 'utf8')).toThrow();
  });

  it('BAD_SNAPSHOT: missing "proposals" array exits non-zero and writes no HTML', () => {
    const inPath = writeSnapshot('shapeless.json', { foo: 'bar' });
    const outPath = join(dir, 'out-shapeless.html');
    const res = run([inPath, outPath]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('BAD_SNAPSHOT');
    expect(() => readFileSync(outPath, 'utf8')).toThrow();
  });
});
