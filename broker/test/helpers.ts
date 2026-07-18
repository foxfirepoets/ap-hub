import { randomBytes } from 'node:crypto';
import { query } from '../src/db.js';
import { generateToken, hashToken } from '../src/tokens.js';

/** Insert an install with a fresh token; returns the plaintext token + label + id. */
export async function seedInstall(opts: { revoked?: boolean } = {}): Promise<{
  token: string;
  label: string;
  id: string;
}> {
  const token = generateToken();
  const label = `tester-${randomBytes(4).toString('hex')}`;
  const { rows } = await query<{ id: string }>(
    'INSERT INTO installs (label, token_sha256, revoked_at) VALUES ($1, $2, $3) RETURNING id',
    [label, hashToken(token), opts.revoked ? new Date().toISOString() : null],
  );
  return { token, label, id: rows[0]!.id };
}

/** Collect the status + body from a handleRequest call. */
export function captureRespond() {
  const calls: Array<{ status: number; body: unknown }> = [];
  const respond = (status: number, body: unknown) => {
    calls.push({ status, body });
  };
  return { calls, respond, last: () => calls[calls.length - 1]! };
}
