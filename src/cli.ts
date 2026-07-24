import { Command } from 'commander';
import { config } from './config.js';
import { query, closePool } from './db/pool.js';
import { logger } from './logger.js';
import { signConnectState } from './auth/connect-state.js';
import { buildGmailAuthorizeUrl, buildQboAuthorizeUrl } from './auth/connect-urls.js';

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
    .command('set-automation')
    .description('set onboarding_state.automation_level (off|assisted|auto) — the operator-only way to unlock posting once DRY_RUN_LOCKED')
    .requiredOption('--level <level>', 'off | assisted | auto'),
).action(async (o) => {
  const { advanceOnboardingStep } = await import('./services/onboarding.js');
  try {
    const row = await advanceOnboardingStep(
      { userId: 0, tenantId: Number(o.tenant), role: 'owner_controller', actor: 'cli:set-automation' },
      { automationLevel: o.level },
    );
    console.log(`tenant ${o.tenant} automation_level=${row.automationLevel}`);
  } catch (err) {
    console.error(String((err as Error).message));
    process.exitCode = 1;
  }
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

tenantOpt(
  program
    .command('review-snapshot')
    .description('write a read-only, tenant-scoped review snapshot JSON (CHUNK_8_REVIEWDASH)')
    .requiredOption('--out <path>', 'output JSON path'),
).action(async (o) => {
  const { buildReviewSnapshot } = await import('./services/review/snapshot.js');
  const { writeFile } = await import('node:fs/promises');
  try {
    const snapshot = await buildReviewSnapshot(Number(o.tenant));
    await writeFile(o.out, JSON.stringify(snapshot, null, 2), 'utf8');
    console.log(`wrote ${snapshot.proposals.length} proposal(s) to ${o.out}`);
  } catch (err) {
    console.error(String((err as Error).message));
    process.exitCode = 1;
  }
  await closePool();
});

tenantOpt(
  program
    .command('apply-review-decisions')
    .description('replay exported reviewer decisions through the guarded approve/reject services (CHUNK_8_REVIEWDASH)')
    .argument('<file>', 'decisions.json path'),
).action(async (file, o) => {
  const { readFile } = await import('node:fs/promises');
  const { applyDecisions } = await import('./services/review/apply-decisions.js');
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const ctx = { userId: 0, tenantId: Number(o.tenant), role: 'owner_controller', actor: 'cli:apply-review-decisions' };
    const result = await applyDecisions(ctx, raw);
    console.log(JSON.stringify(result));
    if (result.errors.length > 0) {
      for (const e of result.errors) console.error(`NOT posted safely — proposal ${e.id}: ${e.reason}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(String((err as Error).message));
    process.exitCode = 1;
  }
  await closePool();
});

tenantOpt(
  program
    .command('connect')
    .description('print the OAuth authorization URL for gmail|qbo')
    .argument('<provider>', 'gmail | qbo')
    .option('--env <env>', 'sandbox', 'sandbox'),
).action((provider, o) => {
  const cfg = config();
  const state = signConnectState(Number(o.tenant));
  if (provider === 'gmail') {
    console.log(buildGmailAuthorizeUrl(cfg, state));
  } else if (provider === 'qbo') {
    console.log(buildQboAuthorizeUrl(cfg, state));
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

program.parseAsync(process.argv).catch((err) => {
  logger.error({ err: String(err) }, 'cli error');
  process.exit(1);
});
