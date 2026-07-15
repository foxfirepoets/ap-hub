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
  const { learnCorrection } = await import('./services/mappings.js');
  await learnCorrection(
    { userId: 0, tenantId: Number(o.tenant), role: 'owner_controller', actor: 'cli' },
    { proposalId: Number(o.proposal), field: o.field, newValue: o.value, remember: false },
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
    // Delegates to the shared service layer — the same single send path the API uses.
    const { sendReply } = await import('./services/reply.js');
    const tenantId = Number(o.tenant);
    try {
      const res = await sendReply(
        { userId: 0, tenantId, role: 'owner_controller', actor: 'cli' },
        Number(o.id),
      );
      console.log(`released forward ${res.forwardId} → ${res.to}`);
    } catch (err) {
      console.error(String((err as Error).message));
    }
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
  .command('bootstrap-tenant')
  .description('create a new tenant and its first invited owner_controller (out-of-band; SSO login never self-provisions)')
  .requiredOption('--name <name>', 'tenant name')
  .requiredOption('--owner-email <email>', 'first owner\'s email (invited; activates on first Google login)')
  .option('--owner-name <name>', 'first owner\'s display name')
  .action(async (o) => {
    const { bootstrapTenant } = await import('./services/provisioning.js');
    try {
      const res = await bootstrapTenant({ tenantName: o.name, ownerEmail: o.ownerEmail, ownerName: o.ownerName });
      console.log(`tenant ${res.tenantId} created; owner ${res.ownerEmail} invited as user ${res.userId}`);
    } catch (err) {
      console.error(String((err as Error).message));
      process.exitCode = 1;
    }
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

program.parseAsync(process.argv).catch((err) => {
  logger.error({ err: String(err) }, 'cli error');
  process.exit(1);
});
