import { Command } from 'commander';
import { config } from './config.js';
import { query, closePool } from './db/pool.js';
import { logger } from './logger.js';

/**
 * ap-hub CLI (CHUNK_3/5/6/7/8). Operator surface: no web UI. Commands cover the
 * pipeline, review, posting, reversal, gatekeeper, and connection flows.
 */
const program = new Command();
program.name('ap-hub').description('AI Accountant Hub operator CLI');

function tenantOpt(cmd: Command): Command {
  return cmd.option('--tenant <id>', 'tenant id', '1');
}

program
  .command('env')
  .description('print the active QBO realm/environment (guardrail command)')
  .action(() => {
    const cfg = config();
    console.log(`QBO_ENV=${cfg.QBO_ENV} (sandbox-only; production is refused)`);
    console.log(`SWARMSYNC_API_BASE=${cfg.SWARMSYNC_API_BASE}`);
    console.log(`GATEKEEPER_ENABLED=${cfg.GATEKEEPER_ENABLED}`);
  });

tenantOpt(program.command('pause').description('pause a tenant (drain poller)')).action(async (o) => {
  await query('UPDATE tenants SET paused=true WHERE id=$1', [Number(o.tenant)]);
  console.log(`tenant ${o.tenant} paused`);
  await closePool();
});

tenantOpt(program.command('resume').description('resume a tenant')).action(async (o) => {
  await query('UPDATE tenants SET paused=false WHERE id=$1', [Number(o.tenant)]);
  console.log(`tenant ${o.tenant} resumed`);
  await closePool();
});

tenantOpt(
  program
    .command('proposals')
    .description('list/export proposals')
    .option('--status <status>', 'filter by status')
    .option('--csv', 'CSV output'),
).action(async (o) => {
  const where = ['tenant_id=$1'];
  const params: unknown[] = [Number(o.tenant)];
  if (o.status) {
    where.push(`status=$${params.length + 1}`);
    params.push(o.status);
  }
  const { rows } = await query(
    `SELECT proposal_id, status, confidence, flags, source_filename, email_subject FROM v_proposal_review WHERE ${where.join(' AND ')} ORDER BY proposal_id`,
    params,
  );
  if (o.csv) {
    console.log('proposal_id,status,confidence,flags,source,subject');
    for (const r of rows as any[])
      console.log(`${r.proposal_id},${r.status},${r.confidence},"${(r.flags ?? []).join('|')}","${r.source_filename ?? ''}","${r.email_subject ?? ''}"`);
  } else {
    console.table(rows);
  }
  await closePool();
});

tenantOpt(
  program.command('postings').description('list postings').option('--status <status>'),
).action(async (o) => {
  const where = ['tenant_id=$1'];
  const params: unknown[] = [Number(o.tenant)];
  if (o.status) {
    where.push(`status=$${params.length + 1}`);
    params.push(o.status);
  }
  const { rows } = await query(
    `SELECT id, qbo_type, qbo_id, status, realm, posted_at FROM postings WHERE ${where.join(' AND ')} ORDER BY id`,
    params,
  );
  console.table(rows);
  await closePool();
});

tenantOpt(
  program
    .command('correct')
    .description('record a correction (no external write)')
    .requiredOption('--proposal <id>')
    .requiredOption('--field <field>')
    .requiredOption('--value <value>'),
).action(async (o) => {
  await query(
    `INSERT INTO corrections (tenant_id, proposal_id, field, new_value) VALUES ($1,$2,$3,$4)`,
    [Number(o.tenant), Number(o.proposal), o.field, o.value],
  );
  console.log('correction recorded');
  await closePool();
});

tenantOpt(
  program.command('reconcile').description('show proposal-vs-posting diffs').option('--proposals-vs-postings'),
).action(async (o) => {
  const { rows } = await query(
    `SELECT kind, left_ref, right_ref, match_status FROM reconciliation WHERE tenant_id=$1 ORDER BY id DESC LIMIT 100`,
    [Number(o.tenant)],
  );
  console.table(rows);
  await closePool();
});

// --- Gatekeeper ---
const gk = program.command('gatekeeper').description('proof-gated forwarding relay controls');

tenantOpt(gk.command('held').description('list held/failed forwards').option('--csv')).action(async (o) => {
  const { listHeld } = await import('./gatekeeper/repo.js');
  const rows = await listHeld(Number(o.tenant));
  if (o.csv) {
    console.log('id,status,hold_reason,subject_tag');
    for (const r of rows) console.log(`${r.id},${r.status},${r.hold_reason ?? ''},${r.subject_tag}`);
  } else {
    console.table(rows.map((r) => ({ id: r.id, status: r.status, reason: r.hold_reason, tag: r.subject_tag })));
  }
  await closePool();
});

tenantOpt(gk.command('release').description('release a held forward (audited)').requiredOption('--id <id>')).action(
  async (o) => {
    const cfg = config();
    const { getForward, setForwardStatus } = await import('./gatekeeper/repo.js');
    const { createLockedForwarder } = await import('./gatekeeper/forwarder.js');
    const { getGmailClient } = await import('./gmail/adapter.js');
    const { writeAudit } = await import('./audit.js');
    const tenantId = Number(o.tenant);
    const fwd = await getForward(tenantId, Number(o.id));
    if (!fwd) {
      console.error('forward not found');
      await closePool();
      return;
    }
    const msg = (await query<{ gmail_message_id: string }>('SELECT gmail_message_id FROM messages WHERE id=$1', [fwd.message_id])).rows[0];
    const forwarder = createLockedForwarder(cfg.QBO_FORWARDING_ADDRESS, await getGmailClient(tenantId));
    const sent = await forwarder.forward(msg!.gmail_message_id);
    await setForwardStatus(fwd.id, 'forwarded', { gmailSendId: sent.sendId, releasedBy: 'cli' });
    await writeAudit({ tenantId, action: 'gatekeep.release', entity: `forward:${fwd.id}`, detail: { by: 'cli' } });
    console.log(`released forward ${fwd.id} → ${sent.to}`);
    await closePool();
  },
);

gk.command('test-alert').description('send a test Telegram alert').action(async () => {
  const cfg = config();
  const { createTelegramSender } = await import('./gatekeeper/telegram.js');
  const tg = createTelegramSender({ botToken: cfg.TELEGRAM_BOT_TOKEN, chatId: cfg.TELEGRAM_CHAT_ID });
  await tg.send('✅ ap-hub gatekeeper test alert');
  console.log('test alert sent');
});

// --- Pipeline ops ---
tenantOpt(program.command('poll').description('run one poll cycle').option('--once')).action(async (o) => {
  const { runPollCycle } = await import('./ingest/poll-cycle.js');
  const { startQueue } = await import('./queue.js');
  await startQueue(config().DATABASE_URL);
  const r = await runPollCycle(Number(o.tenant));
  console.log(JSON.stringify(r));
  const { stopQueue } = await import('./queue.js');
  await stopQueue();
  await closePool();
});

program
  .command('connect')
  .description('print the OAuth authorization URL for gmail|qbo')
  .argument('<provider>', 'gmail | qbo')
  .option('--env <env>', 'sandbox', 'sandbox')
  .action((provider) => {
    const cfg = config();
    if (provider === 'gmail') {
      const scope = 'https://www.googleapis.com/auth/gmail.readonly';
      console.log(
        `https://accounts.google.com/o/oauth2/v2/auth?client_id=${cfg.GMAIL_CLIENT_ID}&redirect_uri=${encodeURIComponent(cfg.GMAIL_REDIRECT_URI)}&response_type=code&access_type=offline&prompt=consent&scope=${encodeURIComponent(scope)}`,
      );
    } else if (provider === 'qbo') {
      console.log(
        `https://appcenter.intuit.com/connect/oauth2?client_id=${cfg.QBO_SANDBOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(cfg.QBO_SANDBOX_REDIRECT_URI)}&response_type=code&scope=com.intuit.quickbooks.accounting&state=1`,
      );
    } else {
      console.error('provider must be gmail or qbo');
    }
  });

// --- QuickBooks Desktop (Web Connector) ---
const qbd = program.command('qbdesktop').description('QuickBooks Desktop via the Web Connector (opt-in; read-only by default)');

qbd
  .command('qwc')
  .description('write the .QWC config to import into the QuickBooks Web Connector')
  .option('--out <path>', 'output path', 'ap-hub.qwc')
  .option('--minutes <n>', 'auto-run every N minutes (0 = manual only)', '0')
  .action(async (o) => {
    const cfg = config();
    if (!cfg.QB_DESKTOP_ENABLED) {
      console.error('QB_DESKTOP_ENABLED is false. Set it to true (and QBWC_PASSWORD) in .env first.');
      process.exit(1);
    }
    const { buildQwcFromConfig } = await import('./qbdesktop/index.js');
    const { writeFileSync } = await import('node:fs');
    const qwc = await buildQwcFromConfig(cfg, Number(o.minutes) || 0);
    writeFileSync(o.out, qwc, 'utf8');
    console.log(`Wrote ${o.out} (mode=${cfg.QB_DESKTOP_MODE}, user=${cfg.QBWC_USERNAME}).`);
    console.log('Open the QuickBooks Web Connector, "Add an Application", pick this file, and enter the QBWC password from .env.');
  });

async function qbdControl(action: string, extra: Record<string, unknown> = {}): Promise<void> {
  const cfg = config();
  const res = await fetch(`http://localhost:${cfg.PORT}/qbwc/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-qbwc-key': cfg.QBWC_PASSWORD },
    body: JSON.stringify({ action, ...extra }),
  });
  const text = await res.text();
  console.log(`${res.status}: ${text}`);
  if (!res.ok) process.exit(1);
}

qbd.command('verify').description('enqueue read-only company/vendor/account queries (safe)').action(() => qbdControl('verify'));
qbd.command('status').description('show queued/processed Web Connector work').action(() => qbdControl('status'));
qbd
  .command('bill')
  .description('enqueue a real vendor bill (WRITE MODE ONLY — mutates your real company file)')
  .requiredOption('--vendor <name>')
  .requiredOption('--account <fullName>')
  .requiredOption('--amount <dollars>')
  .option('--ref <refNumber>')
  .option('--date <YYYY-MM-DD>')
  .option('--memo <memo>')
  .action((o) =>
    qbdControl('bill', {
      bill: {
        vendorName: o.vendor,
        refNumber: o.ref,
        txnDate: o.date,
        memo: o.memo,
        lines: [{ accountFullName: o.account, amount: Number(o.amount) }],
      },
    }),
  );

program.parseAsync(process.argv).catch((err) => {
  logger.error({ err: String(err) }, 'cli error');
  process.exit(1);
});
