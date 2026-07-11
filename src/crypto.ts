import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * AES-256-GCM encryption for OAuth tokens at rest (CHUNK_2). Key = ENCRYPTION_KEY,
 * a 32-byte hex string. Ciphertext is stored as iv:tag:data (base64 parts).
 */

function keyBuffer(hexKey: string): Buffer {
  const buf = Buffer.from(hexKey, 'hex');
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to 32 bytes (64 hex chars).');
  }
  return buf;
}

export function encrypt(plaintext: string, hexKey: string): string {
  const key = keyBuffer(hexKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(ciphertext: string, hexKey: string): string {
  const key = keyBuffer(hexKey);
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('malformed ciphertext');
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256')
    .update(typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf)
    .digest('hex');
}
