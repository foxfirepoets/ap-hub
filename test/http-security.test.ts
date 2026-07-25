import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createHttpServer, readBody } from '../src/http.js';

describe('bounded raw request bodies', () => {
  it('returns 413 semantics for a body over the byte ceiling', async () => {
    const stream = new PassThrough();
    const result = readBody(stream as unknown as IncomingMessage, 4, 1_000);
    stream.end(Buffer.from('12345'));
    await expect(result).rejects.toMatchObject({ status: 413 });
  });

  it('times out a slow/incomplete request', async () => {
    const stream = new PassThrough();
    await expect(readBody(stream as unknown as IncomingMessage, 100, 5)).rejects.toMatchObject({
      status: 408,
    });
    stream.destroy();
  });
});

describe('health disclosure boundary', () => {
  it('public health returns liveness only, without operational workload metrics', async () => {
    const server = createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing test address');
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ status: 'ok', db: true, queue: true });
      expect(body).not.toHaveProperty('operations');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
