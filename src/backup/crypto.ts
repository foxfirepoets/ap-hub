import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

/**
 * CHUNK_7_BACKUP — file-level AES-256-GCM encryption for backup archives.
 *
 * The key is 32 raw bytes held only in the OS credential store (see `key.ts`); this module
 * never sees where it came from. GCM gives us authenticated encryption for free — a single
 * flipped byte or a truncated file makes `decryptFile` throw rather than silently returning
 * corrupted plaintext, which is exactly the property `verify.ts` depends on to detect a
 * corrupted or tampered backup instead of shipping a false "verified" flag.
 *
 * On-disk format: `MAGIC(5) | IV(12) | TAG(16) | ciphertext...`. The tag has to be written
 * before the ciphertext so a streaming reader can set it before consuming any data, but GCM
 * only produces the tag after all plaintext is encrypted — so encryption writes ciphertext to
 * a sibling temp file first, then assembles header + ciphertext into the real output file and
 * removes the temp file. Dumps are moved through disk, never buffered whole in memory.
 */

const MAGIC = Buffer.from('APBK1', 'ascii');
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + IV_LEN + TAG_LEN;
const KEY_LEN = 32;

/** Raised whenever the encrypted file cannot be authenticated back to real plaintext. */
export class BackupCorrupted extends Error {
  readonly code = 'BACKUP_FAILED';
  constructor(reason: string) {
    super(`Backup file failed verification: ${reason}`);
    this.name = 'BackupCorrupted';
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_LEN) {
    throw new Error(`backup encryption key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
}

/** Encrypt `plainPath` into `outPath` under AES-256-GCM. `key` must be 32 raw bytes. */
export async function encryptFile(plainPath: string, outPath: string, key: Buffer): Promise<void> {
  assertKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const cipherTmpPath = `${outPath}.ciphertmp`;
  try {
    await pipeline(createReadStream(plainPath), cipher, createWriteStream(cipherTmpPath));
    const tag = cipher.getAuthTag();
    await writeFile(outPath, Buffer.concat([MAGIC, iv, tag]));
    await pipeline(createReadStream(cipherTmpPath), createWriteStream(outPath, { flags: 'a' }));
  } finally {
    await rm(cipherTmpPath, { force: true });
  }
}

/**
 * Decrypt `encPath` into `outPath`. Throws `BackupCorrupted` when the header is missing/bad
 * or the GCM tag does not authenticate — the only two ways a corrupted or tampered file can
 * fail here, and both are exactly what a re-read verification is supposed to catch.
 */
export async function decryptFile(encPath: string, outPath: string, key: Buffer): Promise<void> {
  assertKey(key);
  const fh = await open(encPath, 'r');
  let header: Buffer;
  try {
    const headerBuf = Buffer.alloc(HEADER_LEN);
    const { bytesRead } = await fh.read(headerBuf, 0, HEADER_LEN, 0);
    if (bytesRead < HEADER_LEN) throw new BackupCorrupted('file is shorter than the encryption header');
    header = headerBuf;
  } finally {
    await fh.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupCorrupted('bad magic header — not an AP-Hub backup file, or it is truncated');
  }
  const iv = header.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = header.subarray(MAGIC.length + IV_LEN, HEADER_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(encPath, { start: HEADER_LEN }), decipher, createWriteStream(outPath));
  } catch (err) {
    // GCM tag mismatch (tampering) or a truncated ciphertext both throw out of `final()`
    // inside the pipeline — surface both the same way, as a detected corruption.
    throw new BackupCorrupted(err instanceof Error ? err.message : String(err));
  }
}
