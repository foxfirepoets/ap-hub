import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { query } from '../src/db/pool.js';
import { createSession } from '../src/auth/session.js';
import { closeAll, countRows, createTenant, createUser, insertAttachment, insertMessage, resetTables } from './helpers.js';
import { GET as listRoute } from '../app/api/statements/route.js';
import { GET as detailRoute } from '../app/api/statements/[id]/route.js';
import {
  runCorrectStatement,
  runExcludeStatementLine,
  runFileStatement,
  runMatchStatementLine,
} from '../src/statements/http.js';

async function token(tenantId: number, role = 'owner_controller'): Promise<string> {
  const userId = await createUser(tenantId, {
    role,
    email: `${role}-${performance.now()}@example.com`,
  });
  return (await createSession(userId)).token;
}

function request(
  bearer: string,
  body?: unknown,
  url = 'http://localhost/api/statements',
): Request {
  return new Request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function statementFixture(
  tenantId: number,
  opts: { status?: string; secondLine?: boolean } = {},
): Promise<{ statementId: number; documentId: number; lineIds: number[] }> {
  const messageId = await insertMessage(tenantId, { subject: 'June statement' });
  const attachmentId = await insertAttachment(tenantId, messageId, {
    filename: 'statement.pdf',
    sha256: `statement-api-${tenantId}-${performance.now()}`,
  });
  const document = await query<{ id: number }>(
    `INSERT INTO accounting_documents
       (tenant_id,message_id,attachment_id,kind,sha256,status,classification_confidence)
     VALUES ($1,$2,$3,'bank_statement',$4,'review',0.99) RETURNING id`,
    [tenantId, messageId, attachmentId, `doc-${tenantId}-${performance.now()}`],
  );
  const documentId = Number(document.rows[0]!.id);
  const statement = await query<{ id: number }>(
    `INSERT INTO bank_statements
       (tenant_id,document_id,institution_name,account_hint,currency,period_start,period_end,
        opening_balance,closing_balance,status)
     VALUES ($1,$2,'Test Bank','1234','USD','2026-06-01','2026-06-30',100,125,$3)
     RETURNING id`,
    [tenantId, documentId, opts.status ?? 'review'],
  );
  const statementId = Number(statement.rows[0]!.id);
  const lineIds: number[] = [];
  const amounts = opts.secondLine ? ['10.00', '15.00'] : ['25.00'];
  for (const [index, amount] of amounts.entries()) {
    const line = await query<{ id: number }>(
      `INSERT INTO bank_statement_lines
         (tenant_id,statement_id,line_no,posted_on,description,amount,fingerprint)
       VALUES ($1,$2,$3,'2026-06-15',$4,$5,$6) RETURNING id`,
      [tenantId, statementId, index + 1, `Line ${index + 1}`, amount,
        `line-${tenantId}-${statementId}-${index}`],
    );
    lineIds.push(Number(line.rows[0]!.id));
  }
  return { statementId, documentId, lineIds };
}

async function json(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>;
}

describe('CHUNK_3 statement review API', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('lists and returns tenant-scoped statement detail to owner, bookkeeper, and CPA', async () => {
    const tenantId = await createTenant();
    const fixture = await statementFixture(tenantId);
    for (const role of ['owner_controller', 'bookkeeper', 'cpa']) {
      const bearer = await token(tenantId, role);
      const list = await listRoute(request(bearer));
      expect(list.status).toBe(200);
      expect((await json(list)).data).toMatchObject([{
        id: fixture.statementId,
        lineCount: 1,
        unresolvedCount: 1,
      }]);
      const detail = await detailRoute(
        request(bearer, undefined, `http://localhost/api/statements/${fixture.statementId}`),
        { params: { id: String(fixture.statementId) } },
      );
      expect(detail.status).toBe(200);
      expect((await json(detail)).data.lines[0]).toMatchObject({
        description: 'Line 1',
        matchStatus: 'unmatched',
      });
    }
  });

  it('matches and excludes lines with reasons and writes identifiable audit rows', async () => {
    const tenantId = await createTenant();
    const fixture = await statementFixture(tenantId, { secondLine: true });
    const bearer = await token(tenantId, 'bookkeeper');

    expect((await runMatchStatementLine(
      request(bearer, { providerRef: { provider: 'qbo', type: 'Expense', id: '42' }, reason: 'Bank feed match' }),
      fixture.statementId,
      fixture.lineIds[0]!,
    )).status).toBe(200);
    expect((await runExcludeStatementLine(
      request(bearer, { reason: 'Internal transfer duplicate' }),
      fixture.statementId,
      fixture.lineIds[1]!,
    )).status).toBe(200);

    const lines = await query<{
      match_status: string; review_reason: string; matched_provider_ref: Record<string, unknown>;
    }>('SELECT match_status,review_reason,matched_provider_ref FROM bank_statement_lines ORDER BY line_no');
    expect(lines.rows).toMatchObject([
      { match_status: 'matched', review_reason: 'Bank feed match', matched_provider_ref: { id: '42' } },
      { match_status: 'excluded', review_reason: 'Internal transfer duplicate', matched_provider_ref: null },
    ]);
    expect(await countRows('audit_log', "tenant_id=$1 AND action LIKE 'statement.line_%'", [tenantId])).toBe(2);
  });

  it('corrects only allowlisted facts and records old/new/reason evidence', async () => {
    const tenantId = await createTenant();
    const fixture = await statementFixture(tenantId);
    const bearer = await token(tenantId);
    const response = await runCorrectStatement(
      request(bearer, { field: 'institutionName', value: 'Correct Bank', reason: 'Verified against PDF' }),
      fixture.statementId,
    );
    expect(response.status).toBe(200);
    expect((await query<{ institution_name: string }>(
      'SELECT institution_name FROM bank_statements WHERE id=$1',
      [fixture.statementId],
    )).rows[0]!.institution_name).toBe('Correct Bank');
    const audit = await query<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_log WHERE action='statement.fact_corrected'",
    );
    expect(audit.rows[0]!.detail).toMatchObject({
      field: 'institutionName',
      oldValue: 'Test Bank',
      newValue: 'Correct Bank',
      reason: 'Verified against PDF',
    });

    const rejected = await runCorrectStatement(
      request(bearer, { field: 'status', value: 'filed', reason: 'bypass' }),
      fixture.statementId,
    );
    expect(rejected.status).toBe(400);
  });

  it('files reviewed evidence without creating any accounting transaction or provider work', async () => {
    const tenantId = await createTenant();
    const fixture = await statementFixture(tenantId);
    const bearer = await token(tenantId, 'bookkeeper');
    await runExcludeStatementLine(
      request(bearer, { reason: 'Non-accounting informational line' }),
      fixture.statementId,
      fixture.lineIds[0]!,
    );
    const before = {
      proposals: await countRows('proposals'),
      jobs: await countRows('provider_jobs'),
      postings: await countRows('postings_ap'),
      reconciliation: await countRows('reconciliation'),
    };
    expect((await runFileStatement(request(bearer, {}), fixture.statementId)).status).toBe(200);
    expect((await query<{ status: string }>('SELECT status FROM bank_statements WHERE id=$1', [fixture.statementId]))
      .rows[0]!.status).toBe('filed');
    expect((await query<{ status: string }>('SELECT status FROM accounting_documents WHERE id=$1', [fixture.documentId]))
      .rows[0]!.status).toBe('filed');
    expect({
      proposals: await countRows('proposals'),
      jobs: await countRows('provider_jobs'),
      postings: await countRows('postings_ap'),
      reconciliation: await countRows('reconciliation'),
    }).toEqual(before);
    expect(await countRows('audit_log', "action='statement.filed'")).toBe(1);
  });

  it('fails closed on unresolved/held filing, missing reasons, malformed matches, and foreign ids', async () => {
    const tenantA = await createTenant('A');
    const tenantB = await createTenant('B');
    const a = await statementFixture(tenantA);
    const held = await statementFixture(tenantA, { status: 'unbalanced' });
    const bearerA = await token(tenantA);
    const bearerB = await token(tenantB);

    expect((await runFileStatement(request(bearerA, {}), a.statementId)).status).toBe(400);
    expect((await runFileStatement(request(bearerA, {}), held.statementId)).status).toBe(400);
    expect((await runExcludeStatementLine(request(bearerA, { reason: ' ' }), a.statementId, a.lineIds[0]!)).status)
      .toBe(400);
    expect((await runMatchStatementLine(
      request(bearerA, { providerRef: {}, reason: 'guess' }),
      a.statementId,
      a.lineIds[0]!,
    )).status).toBe(400);
    expect((await runExcludeStatementLine(
      request(bearerB, { reason: 'foreign mutation' }),
      a.statementId,
      a.lineIds[0]!,
    )).status).toBe(404);
    const foreignRead = await detailRoute(
      request(bearerB, undefined, `http://localhost/api/statements/${a.statementId}`),
      { params: { id: String(a.statementId) } },
    );
    expect(foreignRead.status).toBe(404);
    expect(await countRows('audit_log', "action LIKE 'statement.%'")).toBe(0);
  });

  it('keeps CPA mutation paths read-only while unauthenticated callers are rejected', async () => {
    const tenantId = await createTenant();
    const fixture = await statementFixture(tenantId);
    const cpa = await token(tenantId, 'cpa');
    expect((await runExcludeStatementLine(
      request(cpa, { reason: 'not allowed' }),
      fixture.statementId,
      fixture.lineIds[0]!,
    )).status).toBe(403);
    expect((await runFileStatement(request(cpa, {}), fixture.statementId)).status).toBe(403);
    expect((await listRoute(new Request('http://localhost/api/statements'))).status).toBe(401);
    expect(await countRows('audit_log', "action LIKE 'statement.%'")).toBe(0);
  });

  it('structurally isolates evidence filing from provider writers and accounting transactions', () => {
    const sourcePath = fileURLToPath(new URL('../src/statements/review.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    const importLines = source.split(/\r?\n/).filter((line) => /^\s*import\b/.test(line)).join('\n');
    expect(importLines).not.toMatch(
      /connectors|qbdesktop|qbo|pipeline\/posting|services\/approve|providerJobs/i,
    );
    const normalizedSql = source.replace(/\s+/g, ' ');
    expect(normalizedSql).not.toMatch(
      /\bINSERT\s+INTO\s+(proposals|provider_jobs|postings(?:_ap)?|reconciliation)\b/i,
    );
  });
});
