import { Command } from 'commander';
import { query, closePool } from './db.js';
import { generateToken, hashToken } from './tokens.js';

/**
 * Broker operator CLI (SPEC §12). No web UI — tokens are issued by hand for the
 * 3–5 named pilot testers.
 *
 *   issue-token --install <label> [--cap-usd 5.00]   → prints the token ONCE
 *   revoke      --install <label> | --all            → sets revoked_at
 *   list-installs                                    → label, last_seen_at, WTD spend, revoked
 */

const program = new Command();
program.name('broker').description('AP-Hub key-broker operator CLI');

program
  .command('issue-token')
  .description('issue a new install token (printed ONCE; only its SHA-256 is stored)')
  .requiredOption('--install <label>', 'install label, e.g. tester-jane')
  .option('--cap-usd <usd>', 'weekly spend cap in USD', '5.00')
  .action(async (o: { install: string; capUsd: string }) => {
    const token = generateToken();
    const sha = hashToken(token);
    const cap = Number(o.capUsd);
    if (!Number.isFinite(cap) || cap < 0) {
      console.error(`Invalid --cap-usd: ${o.capUsd}`);
      process.exitCode = 1;
      await closePool();
      return;
    }
    try {
      await query(
        'INSERT INTO installs (label, token_sha256, weekly_cap_usd) VALUES ($1, $2, $3)',
        [o.install, sha, cap.toFixed(2)],
      );
    } catch (err) {
      console.error(`Failed to issue token for "${o.install}": ${(err as Error).message}`);
      process.exitCode = 1;
      await closePool();
      return;
    }
    console.log(`Install "${o.install}" created (weekly cap $${cap.toFixed(2)}).`);
    console.log('Token (shown ONCE — store it now; it is not recoverable):');
    console.log(`  ${token}`);
    await closePool();
  });

program
  .command('revoke')
  .description('revoke one install by label, or --all (kill switch)')
  .option('--install <label>', 'install label to revoke')
  .option('--all', 'revoke every install')
  .action(async (o: { install?: string; all?: boolean }) => {
    if (!o.all && !o.install) {
      console.error('Specify --install <label> or --all.');
      process.exitCode = 1;
      await closePool();
      return;
    }
    if (o.all) {
      const { rowCount } = await query('UPDATE installs SET revoked_at = now() WHERE revoked_at IS NULL');
      console.log(`Revoked ${rowCount ?? 0} active install(s).`);
    } else {
      const { rowCount } = await query(
        'UPDATE installs SET revoked_at = now() WHERE label = $1 AND revoked_at IS NULL',
        [o.install],
      );
      console.log(rowCount ? `Revoked "${o.install}".` : `No active install named "${o.install}".`);
    }
    await closePool();
  });

program
  .command('list-installs')
  .description('list installs: label, last_seen_at, week-to-date spend, revoked')
  .action(async () => {
    const { rows } = await query<{
      label: string;
      last_seen_at: string | null;
      revoked_at: string | null;
      wtd_spend: string | null;
    }>(
      `SELECT i.label,
              i.last_seen_at,
              i.revoked_at,
              COALESCE(s.wtd, 0)::text AS wtd_spend
         FROM installs i
         LEFT JOIN (
           SELECT install_id, SUM(est_usd) AS wtd
             FROM spend_ledger
            WHERE occurred_at >= date_trunc('week', now())
            GROUP BY install_id
         ) s ON s.install_id = i.id
        ORDER BY i.label`,
    );
    if (rows.length === 0) {
      console.log('No installs.');
    } else {
      console.log('label\tlast_seen_at\twtd_spend_usd\trevoked');
      for (const r of rows) {
        console.log(
          `${r.label}\t${r.last_seen_at ?? '-'}\t${Number(r.wtd_spend ?? 0).toFixed(4)}\t${r.revoked_at ? 'yes' : 'no'}`,
        );
      }
    }
    await closePool();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
